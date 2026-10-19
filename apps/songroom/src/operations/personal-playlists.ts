import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import {
  commandReceipt,
  neteaseAuthorization,
  operation,
  personalPlaylistBinding,
  personalPlaylistCreation,
  publicSongRequest,
  personalSongMutation,
  playlistSnapshot,
  playlistTrack,
  publicPlaylistBinding,
  room,
  roomMembership
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterErrorCode, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { UpstreamScheduler, type Operation } from "./upstream-scheduling.js";
import type { PublicPlaylists } from "./public-playlists.js";
import { hasPersonalSongWrite, redactPlaylistEvidence } from "./personal-playlist-lifecycle.js";
import { EventStreamService } from "../events/event-stream.js";
import { BusinessError } from "../shared/errors.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import {
  type PersonalPlaylistCreateCommand,
  type PersonalPlaylistView,
  personalSongAddCommand,
  personalSongRemoveCommand,
  type PersonalSongRemoveCommand,
  type PersonalSongAddCommand,
  type PersonalSongOperationView
} from "../shared/personal-playlist-contracts.js";

type DatabaseTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export class PersonalPlaylists {
  readonly #inFlightRefreshes = new Map<string, Promise<void>>();
  readonly #checkTimers = new Map<string, NodeJS.Timeout>();
  #readCounter = 0;

  constructor(
    private readonly database: AppDatabase,
    private readonly vault: CredentialVault,
    private readonly adapter: NeteaseAdapter,
    private readonly scheduler: UpstreamScheduler,
    private readonly eventStream: EventStreamService,
    private readonly publicPlaylists: PublicPlaylists,
    private readonly now: () => number = () => Date.now()
  ) {
    this.scheduler.register("createPersonalPlaylist", {
      claim: row => this.#claimCreate(row),
      execute: row => this.#executeCreate(row),
      recover: () => this.#recoverCreate()
    });
    // 增删共用明细表；恢复扫描两种 kind，仅由成对注册中的 add handler 执行一次。
    for (const kind of ["addPersonalSong", "removePersonalSong"] as const) this.scheduler.register(kind, {
      claim: row => this.#claimSongMutation(row),
      execute: row => this.#executeSongMutation(row),
      recover: kind === "addPersonalSong" ? () => this.#recoverSongMutations() : undefined
    });
  }

  #beginRead(): number {
    const persisted = this.database.select({ value: sql<number>`coalesce(max(${playlistSnapshot.lastReadStartedAt}), 0)` }).from(playlistSnapshot).get()!.value;
    this.#readCounter = Math.max(this.now(), this.#readCounter + 1, persisted + 1);
    return this.#readCounter;
  }

  create(userId: string, roomId: string, command: PersonalPlaylistCreateCommand): { accepted: boolean; view: PersonalPlaylistView } {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const member = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);
    const prepared = prepareCommand(
      userId,
      command.idempotencyKey,
      "createPersonalPlaylist",
      { roomId },
      this.now()
    );

    const now = this.now();
    const id = v7();
    const name = `songroom-${roomRow.name}-${member.nickname}`;

    const outcome = this.database.transaction(tx => {
      this.#prune();

      const original = readCommandResource(tx, prepared, now);
      if (original) {
        return { replay: true };
      }

      const existingBinding = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, member.id))).get();
      if (existingBinding) {
        throw new BusinessError(409, "PERSONAL_PLAYLIST_EXISTS", "该成员已配置个人歌单");
      }

      const pendingOp = tx.select().from(operation)
        .where(and(eq(operation.roomId, roomId), eq(operation.userId, userId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
      if (pendingOp) {
        throw new BusinessError(409, "OPERATION_PENDING", "当前有正在处理的操作");
      }

      const auth = tx.select().from(neteaseAuthorization)
        .where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
      if (!auth || auth.status !== "active" || !auth.credentials) {
        throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "房主网易云授权不可用");
      }
      if (this.scheduler.paused(auth.accountId)) {
        throw new BusinessError(423, "ACCOUNT_PAUSED", "房主网易云账号已暂停");
      }
      const admissionCode = this.scheduler.admissionCode(auth.accountId);
      if (admissionCode) {
        throw new BusinessError(409, admissionCode, admissionCode === "ACCOUNT_PAUSED" ? "房主网易云账号已暂停" : "网易云账号操作队列已满");
      }

      recordCommandResource(tx, prepared, id, now);
      tx.insert(operation).values({
        id,
        kind: "createPersonalPlaylist",
        userId,
        roomId,
        accountId: auth.accountId,
        authorizationId: auth.id,
        generation: auth.generation,
        status: "queued",
        errorCode: null,
        lastGranted: now,
        version: 1,
        createdAt: now,
        updatedAt: now
      }).run();
      tx.insert(personalPlaylistCreation).values({
        operationId: id,
        ownerUserId: roomRow.ownerUserId,
        memberId: member.id,
        name,
        step: "ready",
        recovered: false
      }).run();
      this.#bumpRoom(tx, roomId);
      return { replay: false, accountId: auth.accountId };
    });

    if (outcome.replay) {
      return { accepted: false, view: this.read(userId, roomId) };
    }

    this.scheduler.kick();
    const updatedRoom = this.database.select({ version: room.version }).from(room).where(eq(room.id, roomId)).get()!;
    this.eventStream.notifyRoom(this.database, roomId, { type: "room", resourceId: roomId, version: updatedRoom.version });

    return { accepted: true, view: this.read(userId, roomId) };
  }

  addSong(userId: string, roomId: string, input: PersonalSongAddCommand) {
    return this.#mutateSong(userId, roomId, personalSongAddCommand.parse(input), "add");
  }

  removeSong(userId: string, roomId: string, input: PersonalSongRemoveCommand) {
    return this.#mutateSong(userId, roomId, personalSongRemoveCommand.parse(input), "remove");
  }

  #mutateSong(userId: string, roomId: string, command: PersonalSongAddCommand | PersonalSongRemoveCommand, action: "add" | "remove"): { replay: boolean; operation: PersonalSongOperationView } {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const kind = action === "add" ? "addPersonalSong" : "removePersonalSong";
    const prepared = prepareCommand(userId, command.idempotencyKey, kind,
      action === "remove" ? { roomId, songId: command.songId } : { roomId, songId: command.songId, name: (command as PersonalSongAddCommand).name, artists: (command as PersonalSongAddCommand).artists, album: (command as PersonalSongAddCommand).album }, this.now());

    const outcome = this.database.transaction(tx => {
      this.#prune();
      const member = this.#getMember(userId, roomId);
      const roomRow = this.#getRoom(roomId);

      const original = readCommandResource(tx, prepared, this.now());
      if (original) {
        return { replay: true, opId: original };
      }

      const binding = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, member.id))).get();
      if (!binding) {
        throw new BusinessError(409, "PERSONAL_PLAYLIST_NOT_FOUND", "尚未配置个人歌单，无法添加歌曲");
      }

      const auth = tx.select().from(neteaseAuthorization)
        .where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
      if (!auth || auth.status !== "active" || !auth.credentials || auth.accountId !== binding.accountId) {
        throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请房主先完成网易云授权");
      }
      if (this.scheduler.paused(auth.accountId)) {
        throw new BusinessError(423, "ACCOUNT_PAUSED", "房主网易云账号已暂停");
      }
      const admissionCode = this.scheduler.admissionCode(auth.accountId);
      if (admissionCode) {
        throw new BusinessError(409, admissionCode, admissionCode === "ACCOUNT_PAUSED" ? "房主网易云账号已暂停" : "网易云账号操作队列已满");
      }

      const pending = tx.select().from(operation).where(and(
        eq(operation.roomId, roomId),
        eq(operation.userId, userId),
        sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
      )).get();
      if (pending) {
        throw new BusinessError(409, "CONCURRENT_OPERATION_LIMIT_EXCEEDED", "你在该房间已有未完成的写操作，请等待处理");
      }

      if (this.#hasTargetConflict(binding.accountId, binding.playlistId)) {
        throw new BusinessError(409, "TARGET_BLOCKED", "个人歌单当前有待确认的写入操作，请稍后刷新查看");
      }

      const existingTrack = tx.select().from(playlistTrack).where(and(
        eq(playlistTrack.accountId, binding.accountId),
        eq(playlistTrack.playlistId, binding.playlistId),
        eq(playlistTrack.songId, command.songId)
      )).get();

      const metadata = action === "remove" ? {
        name: existingTrack?.name || command.songId,
        artists: existingTrack ? JSON.parse(existingTrack.artists) as string[] : [],
        album: existingTrack?.album ?? ""
      } : command as PersonalSongAddCommand;

      if (action === "add" && existingTrack) {
        const id = v7();
        const now = this.now();
        tx.insert(operation).values({
          id,
          kind,
          userId,
          roomId,
          accountId: null,
          authorizationId: null,
          generation: null,
          lastGranted: now,
          status: "succeeded",
          errorCode: null,
          version: 1,
          createdAt: now,
          updatedAt: now
        }).run();

        tx.insert(personalSongMutation).values({
          operationId: id,
          memberId: member.id,
          playlistId: binding.playlistId,
          bindingGeneration: binding.generation,
          songId: command.songId,
          name: metadata.name,
          artists: JSON.stringify(metadata.artists),
          album: metadata.album,
          step: "succeeded",
          checkRound: 0,
          nextCheckAt: null
        }).run();

        recordCommandResource(tx, prepared, id, now);
        this.#bumpRoom(tx, roomId);
        return { replay: false, opId: id };
      }

      const id = v7();
      const now = this.now();
      tx.insert(operation).values({
        id,
        kind,
        userId,
        roomId,
        accountId: auth.accountId,
        authorizationId: auth.id,
        generation: auth.generation,
        lastGranted: now,
        status: "queued",
        errorCode: null,
        version: 1,
        createdAt: now,
        updatedAt: now
      }).run();

      tx.insert(personalSongMutation).values({
        operationId: id,
        memberId: member.id,
        playlistId: binding.playlistId,
        bindingGeneration: binding.generation,
        songId: command.songId,
        name: metadata.name,
        artists: JSON.stringify(metadata.artists),
        album: metadata.album,
        step: "ready",
        checkRound: 0,
        nextCheckAt: null
      }).run();

      recordCommandResource(tx, prepared, id, now);
      this.#bumpRoom(tx, roomId);
      return { replay: false, opId: id };
    });

    const opView = this.readSongOperation(userId, roomId, outcome.opId);
    if (!outcome.replay && opView.status !== "succeeded") {
      this.scheduler.kick();
    }
    const currentRoom = this.database.select({ version: room.version }).from(room).where(eq(room.id, roomId)).get();
    this.eventStream.notifyUser(userId, { type: "operation", resourceId: outcome.opId, version: 1 });
    if (currentRoom) {
      this.eventStream.notifyRoom(this.database, roomId, { type: "room", resourceId: roomId, version: currentRoom.version });
    }

    return {
      replay: outcome.replay,
      operation: opView
    };
  }

  readSongOperation(userId: string, roomId: string, operationId: string): PersonalSongOperationView {
    this.#getMember(userId, roomId);
    const row = this.database.select().from(operation)
      .where(and(eq(operation.id, operationId), eq(operation.roomId, roomId), inArray(operation.kind, ["addPersonalSong", "removePersonalSong"]))).get();
    if (!row || row.userId !== userId) {
      throw new BusinessError(404, "OPERATION_NOT_FOUND", "操作不存在或你无权查看");
    }
    const detail = this.database.select().from(personalSongMutation)
      .where(eq(personalSongMutation.operationId, operationId)).get();
    if (!detail) {
      throw new BusinessError(404, "OPERATION_NOT_FOUND", "操作详情不存在");
    }
    return {
      id: row.id,
      action: row.kind === "removePersonalSong" ? "remove" : "add",
      roomId: row.roomId,
      songId: detail.songId,
      name: detail.name,
      artists: JSON.parse(detail.artists) as string[],
      album: detail.album,
      status: row.status as any,
      songConfirmed: detail.step === "succeeded",
      errorCode: row.errorCode as any,
      step: detail.step as any,
      version: row.version
    };
  }

  stop(): void {
    for (const timer of this.#checkTimers.values()) {
      clearTimeout(timer);
    }
    this.#checkTimers.clear();
  }

  settle(): Promise<void> {
    return this.scheduler.settle();
  }

  triggerDueChecks(): void {
    const rows = this.database.select().from(personalSongMutation)
      .where(and(
        eq(personalSongMutation.step, "unknown"),
        sql`${personalSongMutation.nextCheckAt} IS NOT NULL AND ${personalSongMutation.nextCheckAt} <= ${this.now()}`
      )).all();
    for (const row of rows) {
      void this.#runSongMutationConfirmationCheck(row.operationId);
    }
  }

  #hasTargetConflict(accountId: string, playlistId: string, exceptOperationId?: string): boolean {
    const snap = this.database.select({ code: playlistSnapshot.lastErrorCode })
      .from(playlistSnapshot)
      .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId)))
      .get();
    if (snap?.code === "TARGET_PERMISSION") return true;

    const sourceConflict = this.database.select({ id: operation.id }).from(operation)
      .innerJoin(publicSongRequest, eq(publicSongRequest.operationId, operation.id))
      .where(and(eq(operation.accountId, accountId), eq(publicSongRequest.sourcePlaylistId, playlistId),
        sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
    return hasPersonalSongWrite(this.database, accountId, playlistId, exceptOperationId) || Boolean(sourceConflict);
  }

  read(userId: string, roomId: string, memberId?: string): PersonalPlaylistView {
    const callerMember = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);

    let targetMember = callerMember;
    let isSelf = true;
    if (memberId && memberId !== callerMember.id) {
      const found = this.database.select().from(roomMembership)
        .where(and(eq(roomMembership.id, memberId), eq(roomMembership.roomId, roomId))).get();
      if (!found) {
        throw new BusinessError(404, "ROOM_UNAVAILABLE", "未找到指定成员");
      }
      targetMember = found;
      isSelf = false;
    }

    const binding = this.database.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, targetMember.id))).get();

    const songRow = isSelf ? this.database.select({ id: operation.id }).from(operation)
      .innerJoin(personalSongMutation, eq(personalSongMutation.operationId, operation.id))
      .where(and(eq(operation.roomId, roomId), eq(operation.userId, userId), eq(personalSongMutation.memberId, callerMember.id),
        sql`(${operation.status} NOT IN ('succeeded', 'failed', 'stopped') OR ${operation.updatedAt} > ${this.now() - 86_400_000})`))
      .orderBy(sql`CASE WHEN ${operation.status} NOT IN ('succeeded', 'failed', 'stopped') THEN 0 ELSE 1 END`, desc(operation.createdAt), desc(operation.id)).get() : null;
    const songOperation = songRow ? this.readSongOperation(userId, roomId, songRow.id) : null;

    let opView: PersonalPlaylistView["operation"] = null;
    const currentOperation = this.database.select().from(operation)
      .where(and(eq(operation.roomId, roomId), eq(operation.userId, targetMember.userId), eq(operation.kind, "createPersonalPlaylist")))
      .orderBy(desc(operation.createdAt), desc(operation.id))
      .get();
    if (currentOperation) {
      const creationDetail = this.database.select().from(personalPlaylistCreation)
        .where(eq(personalPlaylistCreation.operationId, currentOperation.id)).get();
      if (creationDetail?.memberId === targetMember.id) opView = {
        id: currentOperation.id,
        status: currentOperation.status as any,
        errorCode: currentOperation.errorCode as any,
        step: creationDetail?.step as any,
        playlistId: creationDetail?.playlistId,
        recovered: creationDetail ? Boolean(creationDetail.recovered) : false,
        version: currentOperation.version
      };
    }

    if (!binding) {
      let allowedActions: PersonalPlaylistView["allowedActions"] = [];
      let disabledReason: PersonalPlaylistView["disabledReason"] = null;

      if (isSelf) {
        const ownerAuth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
        if (opView && !["succeeded", "failed", "stopped"].includes(opView.status)) {
          disabledReason = "OPERATION_PENDING";
        } else if (!ownerAuth || ownerAuth.status !== "active" || !ownerAuth.credentials) {
          disabledReason = "NETEASE_AUTH_REQUIRED";
        } else if (this.scheduler.paused(ownerAuth.accountId)) {
          disabledReason = "ACCOUNT_PAUSED";
        } else {
          allowedActions = ["createPersonalPlaylist"];
        }
      }

      return {
        playlist: null,
        ...(isSelf ? { songOperation } : {}),
        operation: opView,
        snapshot: null,
        lastRefreshError: null,
        allowedActions,
        disabledReason,
        version: roomRow.version
      };
    }

    const snap = this.database.select().from(playlistSnapshot)
      .where(and(eq(playlistSnapshot.accountId, binding.accountId), eq(playlistSnapshot.playlistId, binding.playlistId))).get();

    const trackRows = this.database.select().from(playlistTrack)
      .where(and(eq(playlistTrack.accountId, binding.accountId), eq(playlistTrack.playlistId, binding.playlistId)))
      .orderBy(playlistTrack.position).all();

    const tracks = trackRows.map(t => ({
      position: t.position,
      songId: t.songId,
      name: t.name,
      artists: JSON.parse(t.artists) as string[],
      album: t.album
    }));

    const snapshot = snap ? {
      version: snap.snapshotVersion,
      syncedAt: snap.syncedAt,
      trackCount: tracks.length,
      tracks
    } : null;

    const allowedActions: PersonalPlaylistView["allowedActions"] = isSelf ? ["refreshPersonalPlaylist"] : [];
    let disabledReason: PersonalPlaylistView["disabledReason"] = null;
    if (isSelf) {
      const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
      const pending = this.database.select({ id: operation.id }).from(operation).where(and(eq(operation.roomId, roomId), eq(operation.userId, userId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
      if (!auth || auth.status !== "active" || !auth.credentials || auth.accountId !== binding.accountId) disabledReason = "NETEASE_AUTH_REQUIRED";
      else if (this.scheduler.paused(auth.accountId)) disabledReason = "ACCOUNT_PAUSED";
      else if (pending) disabledReason = "OPERATION_PENDING";
      else if (this.#hasTargetConflict(binding.accountId, binding.playlistId)) disabledReason = "TARGET_BLOCKED";
      else allowedActions.push("removePersonalSong");
    }

    return {
      playlist: {
        id: binding.playlistId,
        name: binding.name
      },
      operation: opView,
      ...(isSelf ? { songOperation } : {}),
      snapshot,
      lastRefreshError: (snap?.lastErrorCode as any) ?? null,
      allowedActions,
      disabledReason,
      version: roomRow.version
    };
  }

  async refresh(userId: string, roomId: string, memberId?: string): Promise<PersonalPlaylistView> {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const callerMember = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);

    let targetMember = callerMember;
    if (memberId && memberId !== callerMember.id) {
      const found = this.database.select().from(roomMembership)
        .where(and(eq(roomMembership.id, memberId), eq(roomMembership.roomId, roomId))).get();
      if (!found) {
        throw new BusinessError(404, "ROOM_UNAVAILABLE", "未找到指定成员");
      }
      targetMember = found;
    }

    const binding = this.database.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, targetMember.id))).get();

    if (!binding) {
      throw new BusinessError(404, "PERSONAL_PLAYLIST_NOT_FOUND", "未绑定个人歌单");
    }

    const refreshKey = `${binding.accountId}:${binding.playlistId}:${binding.generation}`;
    let task = this.#inFlightRefreshes.get(refreshKey);
    if (!task) {
      task = this.#executeRefresh(roomRow.ownerUserId, binding.accountId, binding.playlistId, binding.generation)
        .finally(() => {
          this.#inFlightRefreshes.delete(refreshKey);
        });
      this.#inFlightRefreshes.set(refreshKey, task);
    }
    await task;

    return this.read(userId, roomId, memberId);
  }

  async #executeRefresh(ownerUserId: string, accountId: string, playlistId: string, bindingGeneration: number): Promise<void> {
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, ownerUserId)).get();
    if (!auth || auth.accountId !== accountId || auth.status !== "active" || !auth.credentials) {
      this.#recordRefreshError(accountId, playlistId, "AUTH_UNAVAILABLE");
      return;
    }

    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, {
        authorizationId: auth.id,
        accountId: auth.accountId,
        generation: auth.generation
      });
    } catch {
      this.#recordRefreshError(accountId, playlistId, "AUTH_UNAVAILABLE");
      return;
    }

    const readStartedAt = this.#beginRead();
    let result: Awaited<ReturnType<NeteaseAdapter["call"]>>;
    try {
      result = await this.scheduler.executeMemoryTask(accountId, async () => {
        return this.adapter.call({ operation: "playlistDetail", cookie, playlistId });
      });
    } catch (err) {
      if (err instanceof BusinessError && err.code === "ACCOUNT_PAUSED") {
        this.#recordRefreshError(accountId, playlistId, "ACCOUNT_PAUSED", readStartedAt);
        return;
      }
      this.#recordRefreshError(accountId, playlistId, "MODULE_ERROR", readStartedAt);
      return;
    }

    if (!result.ok) {
      if (result.error.code === "RATE_LIMITED") {
        this.scheduler.pause(accountId);
      }
      this.#recordRefreshError(accountId, playlistId, result.error.code, readStartedAt);
      return;
    }

    const data = result.data as {
      playlist: { id: string; name: string; creatorId: string; subscribed: boolean; status: number };
      songIds: string[];
      songs: Array<{ id: string; name: string; artists: string[]; album: string }>;
    };

    if (data.playlist.id !== playlistId || data.playlist.status !== 0) {
      this.#recordRefreshError(accountId, playlistId, "TARGET_PERMISSION", readStartedAt);
      return;
    }

    if (data.songIds.length !== data.songs.length) {
      this.#recordRefreshError(accountId, playlistId, "PARSE_ERROR", readStartedAt);
      return;
    }

    for (let i = 0; i < data.songIds.length; i++) {
      const song = data.songs[i];
      if (!song || song.id !== data.songIds[i] || !song.name || song.name.length === 0 || typeof song.album !== "string") {
        this.#recordRefreshError(accountId, playlistId, "PARSE_ERROR", readStartedAt);
        return;
      }
    }

    this.#commitSnapshot(accountId, playlistId, bindingGeneration, data, readStartedAt);
  }

  #commitSnapshot(
    accountId: string,
    playlistId: string,
    generation: number,
    data: {
      playlist: { id: string; name: string; creatorId: string; subscribed: boolean; status: number };
      songIds: string[];
      songs: Array<{ id: string; name: string; artists: string[]; album: string }>;
    },
    readStartedAt: number
  ): void {
    const affected = this.database.transaction(tx => {
      const currentBindings = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.accountId, accountId), eq(personalPlaylistBinding.playlistId, playlistId))).all();
      if (!currentBindings.length) return { results: [], confirmedOps: [] };

      const hasMatchingGen = currentBindings.some(b => b.generation === generation);
      if (!hasMatchingGen) return { results: [], confirmedOps: [] };

      if (data.playlist.creatorId !== accountId) return null;

      const currentSnapshot = tx.select().from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).get();

      if (currentSnapshot && currentSnapshot.lastReadStartedAt > readStartedAt) {
        return { results: [], confirmedOps: [] };
      }

      const nextVersion = (currentSnapshot?.snapshotVersion ?? 0) + 1;
      const now = this.now();

      tx.insert(playlistSnapshot).values({
        accountId,
        playlistId,
        snapshotVersion: nextVersion,
        lastReadStartedAt: readStartedAt,
        syncedAt: now,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [playlistSnapshot.accountId, playlistSnapshot.playlistId],
        set: {
          snapshotVersion: nextVersion,
          lastReadStartedAt: readStartedAt,
          syncedAt: now,
          lastErrorCode: null,
          updatedAt: now
        }
      }).run();

      for (const binding of currentBindings) {
        tx.update(personalPlaylistBinding).set({ name: data.playlist.name })
          .where(eq(personalPlaylistBinding.id, binding.id)).run();
      }

      tx.delete(playlistTrack).where(and(eq(playlistTrack.accountId, accountId), eq(playlistTrack.playlistId, playlistId))).run();

      const insertTrack = this.database.$client.prepare(
        "INSERT INTO playlist_track (account_id, playlist_id, position, song_id, name, artists, album) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (let i = 0; i < data.songs.length; i++) {
        const song = data.songs[i];
        insertTrack.run(accountId, playlistId, i, song.id, song.name, JSON.stringify(song.artists), song.album);
      }

      const results: Array<{ roomId: string; version: number }> = [];
      const distinctRooms = new Set(currentBindings.map(b => b.roomId));
      for (const rid of distinctRooms) {
        this.#bumpRoom(tx, rid);
        const updated = tx.select({ version: room.version }).from(room).where(eq(room.id, rid)).get();
        if (updated) results.push({ roomId: rid, version: updated.version });
      }

      const upstreamIds = new Set(data.songIds);
      const unconfirmed = tx.select().from(personalSongMutation)
        .innerJoin(operation, eq(personalSongMutation.operationId, operation.id))
        .where(and(
          eq(personalSongMutation.playlistId, playlistId),
          eq(operation.accountId, accountId),
          eq(operation.status, "awaitingConfirmation")
        )).all();

      const confirmedOps: Operation[] = [];
      for (const item of unconfirmed) {
        if (upstreamIds.has(item.personal_song_mutation.songId) === (item.operation.kind === "addPersonalSong")) {
          confirmedOps.push(item.operation);
        }
      }

      return { results, confirmedOps };
    });

    if (affected === null) {
      // 专用歌单的创建者不再匹配原账号
      this.#recordRefreshError(accountId, playlistId, "TARGET_PERMISSION", readStartedAt);
      return;
    }

    for (const op of affected.confirmedOps) {
      this.#finishSongMutationSuccess(op);
    }

    for (const item of affected.results) {
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "room", resourceId: item.roomId, version: item.version });
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "snapshot", resourceId: item.roomId, version: item.version });
    }
  }

  #recordRefreshError(accountId: string, playlistId: string, errorCode: AdapterErrorCode | "ACCOUNT_PAUSED", readStartedAt?: number): void {
    const affected = this.database.transaction(tx => {
      const bindings = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.accountId, accountId), eq(personalPlaylistBinding.playlistId, playlistId))).all();
      if (!bindings.length) return [];
      const now = this.now();
      const existing = tx.select({ lastReadStartedAt: playlistSnapshot.lastReadStartedAt }).from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).get();
      if (readStartedAt !== undefined && existing && existing.lastReadStartedAt > readStartedAt) return [];

      tx.insert(playlistSnapshot).values({
        accountId,
        playlistId,
        snapshotVersion: 0,
        syncedAt: null,
        lastErrorCode: errorCode,
        createdAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [playlistSnapshot.accountId, playlistSnapshot.playlistId],
        set: {
          lastErrorCode: errorCode,
          updatedAt: now
        }
      }).run();

      const results: Array<{ roomId: string; version: number }> = [];
      const distinctRooms = new Set(bindings.map(b => b.roomId));
      for (const rid of distinctRooms) {
        this.#bumpRoom(tx, rid);
        const updated = tx.select({ version: room.version }).from(room).where(eq(room.id, rid)).get();
        if (updated) results.push({ roomId: rid, version: updated.version });
      }
      return results;
    });

    for (const item of affected) {
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "room", resourceId: item.roomId, version: item.version });
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "snapshot", resourceId: item.roomId, version: item.version });
    }
  }

  async #fetchAccountPlaylists(
    cookie: string,
    accountId: string,
    callStrategy: (fn: () => Promise<AdapterResult<"userPlaylists">>) => Promise<AdapterResult<"userPlaylists">> = fn => fn()
  ): Promise<Array<{ id: string; name: string; creatorId: string; subscribed: boolean; status: number }> | null> {
    const list: Array<{ id: string; name: string; creatorId: string; subscribed: boolean; status: number }> = [];
    let offset = 0;
    const limit = 1000;
    let pages = 0;
    while (true) {
      if (++pages > 50) return null;
      let res: AdapterResult<"userPlaylists">;
      try {
        res = await callStrategy(() => this.adapter.call({ operation: "userPlaylists", cookie, accountId, offset, limit }));
      } catch {
        return null;
      }
      if (!res.ok) return null;
      for (const p of res.data.playlists) {
        list.push({
          id: p.id,
          name: p.name,
          creatorId: p.creatorId,
          subscribed: p.subscribed,
          status: p.status
        });
      }
      if (!res.data.more) break;
      if (res.data.playlists.length === 0) return null;
      offset += res.data.playlists.length;
    }
    return list;
  }

  #getMember(userId: string, roomId: string) {
    const member = this.database.select().from(roomMembership)
      .where(and(eq(roomMembership.userId, userId), eq(roomMembership.roomId, roomId))).get();
    if (!member) {
      throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    }
    return member;
  }

  #getRoom(roomId: string) {
    const r = this.database.select().from(room).where(eq(room.id, roomId)).get();
    if (!r) {
      throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    }
    return r;
  }

  onReauthorized(userId: string, authId: string, accountId: string, generation: number): void {
    const notifyRooms: Array<{ roomId: string; version: number }> = [];

    this.database.transaction(tx => {
      const ownedRooms = tx.select({ id: room.id }).from(room).where(eq(room.ownerUserId, userId)).all();
      for (const r of ownedRooms) {
        let roomChanged = false;
        const personalOps = tx.select().from(operation).where(and(
          eq(operation.roomId, r.id),
          eq(operation.kind, "createPersonalPlaylist"),
          sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
        )).all();

        for (const op of personalOps) {
          const detail = tx.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, op.id)).get();
          if (!detail) continue;

          if (op.status === "needsAdministrator" || op.accountId !== accountId) continue;

          if (["ready", "verified", "confirming"].includes(detail.step)) {
            const condition = this.#conditions({ ...op, accountId, authorizationId: authId, generation });
            if (condition === "valid") {
              tx.update(personalPlaylistCreation).set({ step: detail.step === "confirming" ? "confirming" : "ready" })
                .where(eq(personalPlaylistCreation.operationId, op.id)).run();
              tx.update(operation).set({
                accountId,
                authorizationId: authId,
                generation,
                status: "queued",
                errorCode: null,
                version: sql`${operation.version} + 1`,
                updatedAt: this.now()
              }).where(eq(operation.id, op.id)).run();
              this.#bumpRoom(tx, r.id);
              roomChanged = true;
            }
          }
        }

        const mutationOps = tx.select().from(operation).where(and(
          eq(operation.roomId, r.id),
          inArray(operation.kind, ["addPersonalSong", "removePersonalSong"]),
          sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
        )).all();

        for (const op of mutationOps) {
          const detail = tx.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, op.id)).get();
          if (!detail) continue;

          if (op.status === "needsAdministrator" || op.accountId !== accountId) continue;

          const condition = this.#conditionsForSongMutation({ ...op, accountId, authorizationId: authId, generation });
          if (condition === "valid") {
            const nextStatus = (detail.step === "unknown" || op.status === "awaitingConfirmation") ? "awaitingConfirmation" : "queued";
            if (op.kind === "removePersonalSong" && ["ready", "verified", "prepared"].includes(detail.step)) {
              tx.update(personalSongMutation).set({ step: "ready" }).where(eq(personalSongMutation.operationId, op.id)).run();
            }
            tx.update(operation).set({
              accountId,
              authorizationId: authId,
              generation,
              status: nextStatus,
              errorCode: null,
              version: sql`${operation.version} + 1`,
              updatedAt: this.now()
            }).where(eq(operation.id, op.id)).run();
            this.#bumpRoom(tx, r.id);
            roomChanged = true;
            if (nextStatus === "awaitingConfirmation" && detail.checkRound < 3) {
              this.#scheduleSongMutationConfirmationCheck(op.id, 5000);
            }
          }
        }

        if (roomChanged) {
          const updated = tx.select({ version: room.version }).from(room).where(eq(room.id, r.id)).get();
          if (updated) notifyRooms.push({ roomId: r.id, version: updated.version });
        }
      }
    });

    for (const r of notifyRooms) {
      this.eventStream.notifyRoom(this.database, r.roomId, { type: "room", resourceId: r.roomId, version: r.version });
    }
    this.scheduler.kick();
  }

  #bumpRoom(tx: AppDatabase | DatabaseTransaction, roomId: string): void {
    tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
  }

  #claimCreate(row: Operation): boolean {
    const detail = this.database.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).get();
    if (!detail) {
      this.#status(row.id, "needsAdministrator");
      return false;
    }
    if (detail.step === "confirming") {
      try {
        this.#bindDedicated(row);
      } catch {
        this.#status(row.id, "needsAdministrator");
      }
      return false;
    }
    if (["sending", "unknown"].includes(detail.step)) {
      this.#status(row.id, "needsAdministrator", row.errorCode);
      return false;
    }
    const condition = this.#conditions(row);
    if (condition !== "valid") {
      this.#conditionStatus(row, condition);
      return false;
    }
    const roomRow = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    if (!roomRow) return false;
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
    if (!auth || !auth.credentials) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return false;
    }
    try {
      this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return false;
    }
    if (detail.step === "verified") {
      this.database.update(personalPlaylistCreation).set({ step: "sending", sentAt: this.now() }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
    }
    this.#bumpRoom(this.database, row.roomId);
    return true;
  }

  async #executeCreate(row: Operation): Promise<void> {
    const detail = this.database.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).get()!;
    const roomRow = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    if (!roomRow) {
      this.#status(row.id, "stopped");
      return;
    }
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
    if (!auth || !auth.credentials) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return;
    }
    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return;
    }

    try {
      if (detail.step === "ready") {
        const identity = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId! });
        if (!identity.ok) {
          this.#readFailure(row, identity.error.code);
          return;
        }
        if (identity.data.accountId !== row.accountId) {
          this.#status(row.id, "waitingAuthorization", "ACCOUNT_MISMATCH");
          return;
        }
        const condition = this.#conditions(row);
        if (condition !== "valid") {
          this.#conditionStatus(row, condition);
          return;
        }

        const beforeList = await this.#fetchAccountPlaylists(cookie, row.accountId!);
        if (!beforeList) {
          this.#readFailure(row, "NETWORK_ERROR");
          return;
        }

        this.database.transaction(tx => {
          tx.update(personalPlaylistCreation).set({
            step: "verified",
            beforePlaylists: JSON.stringify(beforeList)
          }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "queued");
        });
        return;
      }

      const createResult = await (async () => {
        try {
          return await this.adapter.call({ operation: "playlistCreate", cookie, name: detail.name });
        } catch {
          return null;
        }
      })();

      if (!createResult) {
        await this.#transitionToUnknownCreation(row, "MODULE_ERROR", cookie);
        return;
      }

      if (!createResult.ok) {
        if (createResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
        if (createResult.error.outcome === "failed") {
          this.#status(row.id, "failed", createResult.error.code);
          return;
        }
        await this.#transitionToUnknownCreation(row, createResult.error.code, cookie);
        return;
      }

      this.database.transaction(tx => {
        tx.update(personalPlaylistCreation).set({ step: "confirming", playlistId: createResult.data.playlistId }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
        this.#bumpRoom(tx, row.roomId);
      });
      this.#bindDedicated(row);
    } catch {
      const saved = this.database.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).get();
      if (saved?.step === "confirming") {
        this.#status(row.id, "needsAdministrator", "MODULE_ERROR");
      } else if (saved?.step === "sending" || saved?.step === "unknown") {
        await this.#transitionToUnknownCreation(row, "MODULE_ERROR", cookie);
      } else {
        this.#status(row.id, "failed", "MODULE_ERROR");
      }
    }
  }

  #recoverCreate(): void {
    this.#prune();
    for (const row of this.database.select().from(operation).where(eq(operation.kind, "createPersonalPlaylist")).all()) {
      if (["succeeded", "failed", "stopped"].includes(row.status) || row.status === "waitingAuthorization") continue;
      const detail = this.database.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).get();
      if (!detail) {
        this.#status(row.id, "needsAdministrator");
        continue;
      }
      if (["sending", "unknown"].includes(detail.step)) {
        this.database.transaction(tx => {
          tx.update(personalPlaylistCreation).set({ step: "unknown" }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "needsAdministrator", row.errorCode);
        });
      } else if (detail.step === "confirming") {
        this.database.transaction(tx => {
          tx.update(personalPlaylistCreation).set({ recovered: true }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "queued", row.errorCode);
        });
      } else if (detail.step === "verified") {
        this.database.update(personalPlaylistCreation).set({ step: "ready" }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
        this.#status(row.id, "queued");
      } else if (row.status === "processing") {
        this.#status(row.id, "queued");
      }
    }
  }

  async #transitionToUnknownCreation(row: Operation, errorCode: Operation["errorCode"], cookie: string): Promise<void> {
    let afterList: Array<{ id: string; name: string }> | null = null;
    try {
      afterList = await this.#fetchAccountPlaylists(cookie, row.accountId!);
    } catch {
      // 忽略只读补查失败，不影响记录 unknown 证据
    }

    const notifyInfo = this.database.transaction(tx => {
      const detail = tx.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).get();
      if (!detail) return null;
      const originalRoom = tx.select().from(room).where(eq(room.id, row.roomId)).get();
      const originalMember = tx.select().from(roomMembership).where(and(
        eq(roomMembership.id, detail.memberId), eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId)
      )).get();
      const businessActive = originalRoom?.ownerUserId === detail.ownerUserId && Boolean(originalMember);
      tx.update(personalPlaylistCreation).set({
        step: "unknown",
        afterPlaylists: businessActive ? (afterList ? JSON.stringify(afterList) : null)
          : redactPlaylistEvidence(afterList ? JSON.stringify(afterList) : null),
        ...(!businessActive ? {
          name: "songroom-cleanup",
          beforePlaylists: redactPlaylistEvidence(detail.beforePlaylists)
        } : {})
      }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
      tx.update(operation).set({
        status: "needsAdministrator",
        errorCode,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(eq(operation.id, row.id)).run();
      this.#bumpRoom(tx, row.roomId);
      const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get();
      const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (!updatedOp) return null;
      return { roomId: row.roomId, opVersion: updatedOp.version, roomVersion: updatedRoom?.version ?? 0 };
    });

    if (notifyInfo) {
      this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "room", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
    }
  }

  #bindDedicated(row: Operation): void {
    let boundPlaylistId: string | null = null;
    let cleanupId: string | null = null;
    const now = this.now();

    this.database.transaction(tx => {
      const detail = tx.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).get()!;
      if (detail.playlistId && this.#targetInUse(tx, row.accountId!, detail.playlistId)) {
        this.#status(row.id, "needsAdministrator", "TARGET_PERMISSION");
        return;
      }
      const condition = this.#conditions(row);
      if (condition !== "valid") {
        const roomExists = tx.select({ id: room.id }).from(room).where(eq(room.id, row.roomId)).get();
        const memberExists = tx.select({ id: roomMembership.id }).from(roomMembership).where(eq(roomMembership.id, detail.memberId)).get();
        if ((!roomExists || !memberExists) && detail.playlistId) {
          cleanupId = this.publicPlaylists.ensureCleanupInTx(tx, detail.ownerUserId, row.accountId!, detail.playlistId, row.id);
          tx.delete(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "stopped");
          return;
        }
        this.#conditionStatus(row, condition, true);
        return;
      }

      const targetPlaylistId = detail.playlistId!;

      const bindingId = v7();
      tx.insert(personalPlaylistBinding).values({
        id: bindingId,
        roomId: row.roomId,
        memberId: detail.memberId,
        accountId: row.accountId!,
        playlistId: targetPlaylistId,
        name: detail.name,
        generation: 1,
        creationOperationId: row.id,
        createdAt: now,
        updatedAt: now
      }).run();

      tx.update(personalPlaylistCreation).set({ step: "succeeded" }).where(eq(personalPlaylistCreation.operationId, row.id)).run();
      this.#status(row.id, "succeeded");
      this.#bumpRoom(tx, row.roomId);
      boundPlaylistId = targetPlaylistId;
    });

    if (cleanupId) this.publicPlaylists.dispatchCleanup(cleanupId);
    if (boundPlaylistId) {
      const updatedRoom = this.database.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (updatedRoom) {
        this.eventStream.notifyRoom(this.database, row.roomId, { type: "room", resourceId: row.roomId, version: updatedRoom.version });
        this.eventStream.notifyRoom(this.database, row.roomId, { type: "snapshot", resourceId: row.roomId, version: updatedRoom.version });
      }
      const roomRow = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
      if (roomRow) {
        void this.#executeRefresh(roomRow.ownerUserId, row.accountId!, boundPlaylistId, 1);
      }
    }
  }

  #targetInUse(tx: DatabaseTransaction, accountId: string, playlistId: string): boolean {
    return Boolean(
      tx.select({ id: personalPlaylistBinding.id }).from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.accountId, accountId), eq(personalPlaylistBinding.playlistId, playlistId))).get() ||
      tx.select({ id: publicPlaylistBinding.roomId }).from(publicPlaylistBinding)
        .where(and(eq(publicPlaylistBinding.accountId, accountId), eq(publicPlaylistBinding.playlistId, playlistId))).get()
    );
  }

  restoreCreatedBindingInTx(tx: DatabaseTransaction, roomId: string, memberId: string, accountId: string, playlistId: string, name: string, operationId: string): void {
    if (this.#targetInUse(tx, accountId, playlistId)) {
      throw new BusinessError(409, "TARGET_PERMISSION", "该歌单已用于公共歌单或其他成员的个人歌单");
    }
    const now = this.now();
    tx.insert(personalPlaylistBinding)
      .values({
        id: v7(),
        roomId,
        memberId,
        accountId,
        playlistId,
        name,
        generation: 1,
        creationOperationId: operationId,
        createdAt: now,
        updatedAt: now
      })
      .run();

    tx.insert(playlistSnapshot)
      .values({
        accountId,
        playlistId,
        snapshotVersion: 0,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoNothing()
      .run();

    tx.update(personalPlaylistCreation)
      .set({
        playlistId,
        step: "succeeded",
        recovered: true
      })
      .where(eq(personalPlaylistCreation.operationId, operationId))
      .run();

    tx.update(operation)
      .set({
        status: "succeeded",
        errorCode: null,
        accountId: null,
        authorizationId: null,
        generation: null,
        version: sql`${operation.version} + 1`,
        updatedAt: now
      })
      .where(eq(operation.id, operationId))
      .run();

    this.#bumpRoom(tx, roomId);
  }

  #status(operationId: string, status: Operation["status"], errorCode?: Operation["errorCode"]): void {
    this.database.transaction(tx => {
      const isTerminal = ["succeeded", "failed", "stopped"].includes(status);
      tx.update(operation).set({
        status,
        errorCode: errorCode ?? null,
        ...(isTerminal ? { accountId: null, authorizationId: null, generation: null } : {}),
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(eq(operation.id, operationId)).run();
      const op = tx.select().from(operation).where(eq(operation.id, operationId)).get();
      if (op) {
        this.#bumpRoom(tx, op.roomId);
      }
    });
  }

  #readFailure(row: Operation, code: AdapterErrorCode): void {
    if (code === "RATE_LIMITED") {
      this.scheduler.pause(row.accountId!);
      this.#status(row.id, "queued");
      return;
    }
    if (["AUTH_UNAVAILABLE", "ACCOUNT_MISMATCH"].includes(code)) {
      this.#status(row.id, "waitingAuthorization", code as any);
      return;
    }
    this.#status(row.id, "queued", code);
  }

  #conditions(row: Operation): "valid" | "stopped" | "waitingAuthorization" {
    const currentOperation = this.database.select().from(operation).where(eq(operation.id, row.id)).get();
    if (!currentOperation || ["succeeded", "failed", "stopped"].includes(currentOperation.status)) return "stopped";
    const current = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
    const detail = this.database.select().from(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, row.id)).get();
    if (!current || !member || !detail || member.id !== detail.memberId || current.ownerUserId !== detail.ownerUserId) return "stopped";

    const binding = this.database.select().from(personalPlaylistBinding).where(and(eq(personalPlaylistBinding.roomId, row.roomId), eq(personalPlaylistBinding.memberId, member.id))).get();
    if (binding && binding.creationOperationId !== row.id) return "stopped";

    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.ownerUserId)).get();
    if (!auth || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation || auth.status !== "active" || !auth.credentials) {
      return "waitingAuthorization";
    }
    return "valid";
  }

  #conditionStatus(row: Operation, condition: "stopped" | "waitingAuthorization", created = false): void {
    this.#status(
      row.id,
      condition === "stopped" && created ? "needsAdministrator" : condition,
      condition === "waitingAuthorization" ? "AUTH_UNAVAILABLE" : null
    );
  }

  #claimSongMutation(row: Operation): boolean {
    if (row.status === "needsAdministrator") return false;
    const detail = this.database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, row.id)).get();
    if (!detail) {
      this.#status(row.id, "stopped");
      return false;
    }
    if (this.#hasTargetConflict(row.accountId!, detail.playlistId, row.id)) {
      this.#status(row.id, "queued", "PLAYLIST_CONFLICT");
      return false;
    }
    const condition = this.#conditionsForSongMutation(row);
    if (condition !== "valid") {
      this.#conditionStatusForSongMutation(row, condition);
      return false;
    }
    const roomRow = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    if (!roomRow) return false;
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
    if (!auth || !auth.credentials) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return false;
    }
    try {
      this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return false;
    }

    if (["sending", "unknown"].includes(detail.step)) {
      this.database.update(personalSongMutation).set({ step: "confirming" }).where(eq(personalSongMutation.operationId, row.id)).run();
    }
    this.#bumpRoom(this.database, row.roomId);
    return true;
  }

  #queueSongMutation(row: Operation, step: typeof personalSongMutation.$inferSelect["step"], errorCode: AdapterErrorCode | null = null): void {
    this.database.transaction(tx => {
      tx.update(personalSongMutation).set({ step }).where(eq(personalSongMutation.operationId, row.id)).run();
      this.#status(row.id, "queued", errorCode);
    });
  }

  async #executeSongMutation(row: Operation): Promise<void> {
    const detail = this.database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, row.id)).get();
    const condition = this.#conditionsForSongMutation(row);
    if (!detail || condition !== "valid") { this.#conditionStatusForSongMutation(row, condition === "valid" ? "stopped" : condition); return; }
    const roomRow = this.database.select().from(room).where(eq(room.id, row.roomId)).get()!;
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get()!;
    let cookie: string;
    try { cookie = this.vault.decrypt(auth.credentials!, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation }); }
    catch { this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE"); return; }

    // Every durable step consumes exactly one upstream grant, then yields to the scheduler.
    if (row.kind === "removePersonalSong" && detail.step === "ready") {
      let result: AdapterResult<"identity"> | null = null;
      try { result = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId! }); } catch { /* no write sent */ }
      const after = this.#conditionsForSongMutation(row);
      if (after !== "valid") { this.#conditionStatusForSongMutation(row, after); return; }
      if (!result || !result.ok || result.data.accountId !== row.accountId) {
        const code = !result ? "MODULE_ERROR" : !result.ok ? result.error.code : "ACCOUNT_MISMATCH";
        this.#rejectUnsentSongMutation(row, code);
        return;
      }
      this.#queueSongMutation(row, "verified");
      return;
    }

    if ((row.kind === "addPersonalSong" && ["ready", "verified"].includes(detail.step)) || detail.step === "prepared") {
      this.database.update(personalSongMutation).set({ step: "sending" }).where(eq(personalSongMutation.operationId, row.id)).run();
      let result: AdapterResult<"trackAdd" | "trackRemove"> | null = null;
      try {
        result = await this.adapter.call({ operation: row.kind === "removePersonalSong" ? "trackRemove" : "trackAdd", cookie,
          playlistId: detail.playlistId, songId: detail.songId });
      } catch { /* May have sent: the next grant can only confirm. */ }
      const after = this.#conditionsForSongMutation(row);
      if (after !== "valid") { this.#conditionStatusForSongMutation(row, after); return; }
      if (result && !result.ok && result.error.outcome === "failed") {
        if (result.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
        this.database.update(personalSongMutation).set({ step: "rejected" }).where(eq(personalSongMutation.operationId, row.id)).run();
        this.#status(row.id, "failed", result.error.code);
        return;
      }
      if (result && !result.ok && result.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
      this.#queueSongMutation(row, "confirming", result?.ok ? null : result?.error.code ?? "MODULE_ERROR");
      return;
    }

    const preflight = row.kind === "removePersonalSong" && detail.step === "verified";
    const readStartedAt = this.#beginRead();
    let result: AdapterResult<"playlistDetail"> | null = null;
    try { result = await this.adapter.call({ operation: "playlistDetail", cookie, playlistId: detail.playlistId }); } catch { /* read failure */ }
    const after = this.#conditionsForSongMutation(row);
    if (after !== "valid") { this.#conditionStatusForSongMutation(row, after); return; }
    if (!result || !result.ok || !this.#validatePlaylistDetail(result.data, detail.playlistId, row.accountId!)) {
      const code = !result ? "MODULE_ERROR" : !result.ok ? result.error.code :
        (result.data.playlist.id !== detail.playlistId || result.data.playlist.status !== 0 || result.data.playlist.creatorId !== row.accountId) ? "TARGET_PERMISSION" : "PARSE_ERROR";
      if (code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
      this.#recordRefreshError(row.accountId!, detail.playlistId, code, readStartedAt);
      if (preflight) this.#rejectUnsentSongMutation(row, code);
      else this.#transitionToAwaitingConfirmationForSongMutation(row, code);
      return;
    }
    this.#commitSnapshot(row.accountId!, detail.playlistId, detail.bindingGeneration, result.data, readStartedAt);
    if (result.data.songIds.includes(detail.songId) === (row.kind === "addPersonalSong")) {
      this.#finishSongMutationSuccess(row);
    } else if (preflight) {
      this.#queueSongMutation(row, "prepared");
    } else {
      this.#transitionToAwaitingConfirmationForSongMutation(row, "NETWORK_ERROR");
    }
  }

  #rejectUnsentSongMutation(row: Operation, code: AdapterErrorCode): void {
    if (code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
    if (code === "AUTH_UNAVAILABLE" || code === "ACCOUNT_MISMATCH") {
      this.#status(row.id, "waitingAuthorization", code);
    } else {
      this.database.update(personalSongMutation).set({ step: "rejected" }).where(eq(personalSongMutation.operationId, row.id)).run();
      this.#status(row.id, "failed", code);
    }
  }

  #finishSongMutationSuccess(row: Operation): void {
    const condition = this.#conditionsForSongMutation(row);
    if (condition !== "valid") {
      this.#conditionStatusForSongMutation(row, condition);
      return;
    }
    const timer = this.#checkTimers.get(row.id);
    if (timer) {
      clearTimeout(timer);
      this.#checkTimers.delete(row.id);
    }
    this.database.transaction(tx => {
      tx.update(personalSongMutation).set({ step: "succeeded", nextCheckAt: null }).where(eq(personalSongMutation.operationId, row.id)).run();
      tx.update(operation).set({
        status: "succeeded",
        errorCode: null,
        accountId: null,
        authorizationId: null,
        generation: null,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(eq(operation.id, row.id)).run();
      this.#bumpRoom(tx, row.roomId);
    });
    const currentRoom = this.database.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
    this.eventStream.notifyUser(row.userId, { type: "operation", resourceId: row.id, version: row.version + 1 });
    if (currentRoom) {
      this.eventStream.notifyRoom(this.database, row.roomId, { type: "room", resourceId: row.roomId, version: currentRoom.version });
    }
  }

  #transitionToAwaitingConfirmationForSongMutation(row: Operation, errorCode: AdapterErrorCode): void {
    const condition = this.#conditionsForSongMutation(row);
    if (condition !== "valid") { this.#conditionStatusForSongMutation(row, condition); return; }
    const nextCheckAt = this.now() + 5000;
    this.database.transaction(tx => {
      tx.update(personalSongMutation).set({
        step: "unknown",
        checkRound: 0,
        nextCheckAt
      }).where(eq(personalSongMutation.operationId, row.id)).run();
      tx.update(operation).set({
        status: "awaitingConfirmation",
        errorCode,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(eq(operation.id, row.id)).run();
      this.#bumpRoom(tx, row.roomId);
    });
    this.eventStream.notifyUser(row.userId, { type: "operation", resourceId: row.id, version: row.version + 1 });
    this.#scheduleSongMutationConfirmationCheck(row.id, 5000);
  }

  #scheduleSongMutationConfirmationCheck(operationId: string, delayMs: number): void {
    const existing = this.#checkTimers.get(operationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#checkTimers.delete(operationId);
      void this.#runSongMutationConfirmationCheck(operationId);
    }, Math.max(0, delayMs));
    this.#checkTimers.set(operationId, timer);
  }

  async #runSongMutationConfirmationCheck(operationId: string): Promise<void> {
    const claimed = this.database.transaction(tx => {
      const row = tx.select().from(operation).where(eq(operation.id, operationId)).get();
      if (!row || row.status !== "awaitingConfirmation") return null;
      const detail = tx.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, operationId)).get();
      if (!detail || detail.step !== "unknown") return null;
      tx.update(personalSongMutation).set({ nextCheckAt: null }).where(eq(personalSongMutation.operationId, operationId)).run();
      return { row, detail };
    });
    if (!claimed) return;

    const { row, detail } = claimed;
    const condition = this.#conditionsForSongMutation(row);
    if (condition !== "valid") {
      const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
      if (!member) {
        this.database.transaction(tx => {
          tx.delete(personalSongMutation).where(eq(personalSongMutation.operationId, row.id)).run();
          tx.delete(operation).where(eq(operation.id, row.id)).run();
        });
        return;
      }
      this.database.update(personalSongMutation).set({ ...(condition === "stopped" ? { step: "stopped" as const } : {}), nextCheckAt: null }).where(eq(personalSongMutation.operationId, row.id)).run();
      this.#conditionStatusForSongMutation(row, condition);
      return;
    }

    const roomRow = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    if (!roomRow) return;
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
    if (!auth || !auth.credentials) {
      this.#conditionStatusForSongMutation(row, "waitingAuthorization");
      return;
    }
    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      this.#conditionStatusForSongMutation(row, "waitingAuthorization");
      return;
    }

    let readStartedAt = 0;
    let admitted = false;
    let detailResult: AdapterResult<"playlistDetail"> | null = null;
    try {
      detailResult = await this.scheduler.executeMemoryTask(row.accountId!, async () => {
        const grantedCondition = this.#conditionsForSongMutation(row);
        if (grantedCondition !== "valid") {
          this.#conditionStatusForSongMutation(row, grantedCondition);
          return null;
        }
        readStartedAt = this.#beginRead();
        admitted = true;
        return this.adapter.call({
          operation: "playlistDetail",
          cookie,
          playlistId: detail.playlistId
        });
      });
    } catch {
      detailResult = null;
    }

    if (!admitted) return;
    const afterCondition = this.#conditionsForSongMutation(row);
    if (afterCondition !== "valid") { this.#conditionStatusForSongMutation(row, afterCondition); return; }
    if (detailResult && detailResult.ok) {
      const data = detailResult.data;
      if (this.#validatePlaylistDetail(data, detail.playlistId, row.accountId!)) {
        this.#commitSnapshot(row.accountId!, detail.playlistId, detail.bindingGeneration, data, readStartedAt);
        if (data.songIds.includes(detail.songId) === (row.kind === "addPersonalSong")) {
          this.#finishSongMutationSuccess(row);
          return;
        }
      } else {
        const errCode = (data?.playlist?.id !== detail.playlistId || data?.playlist?.status !== 0 || data?.playlist?.creatorId !== row.accountId)
          ? "TARGET_PERMISSION"
          : "PARSE_ERROR";
        this.#recordRefreshError(row.accountId!, detail.playlistId, errCode, readStartedAt);
      }
    } else if (detailResult && !detailResult.ok) {
      if (detailResult.error.code === "RATE_LIMITED") {
        this.scheduler.pause(row.accountId!);
      }
      this.#recordRefreshError(row.accountId!, detail.playlistId, detailResult.error.code, readStartedAt);
    } else {
      this.#recordRefreshError(row.accountId!, detail.playlistId, "MODULE_ERROR", readStartedAt);
    }

    this.#advanceSongMutationCheckRound(row, detail);
  }

  #advanceSongMutationCheckRound(row: Operation, detail: typeof personalSongMutation.$inferSelect): void {
    const DELAYS = [5_000, 30_000, 120_000];
    const nextRound = detail.checkRound + 1;
    if (nextRound < 3) {
      const delay = DELAYS[nextRound];
      const nextCheckAt = this.now() + delay;
      this.database.transaction(tx => {
        tx.update(personalSongMutation).set({
          checkRound: nextRound,
          nextCheckAt
        }).where(eq(personalSongMutation.operationId, row.id)).run();
        this.#bumpRoom(tx, row.roomId);
      });
      this.#scheduleSongMutationConfirmationCheck(row.id, delay);
    } else {
      this.database.transaction(tx => {
        tx.update(personalSongMutation).set({
          checkRound: 3,
          nextCheckAt: null
        }).where(eq(personalSongMutation.operationId, row.id)).run();
        this.#bumpRoom(tx, row.roomId);
      });
    }
  }

  #recoverSongMutations(): void {
    const rows = this.database.select().from(operation)
      .innerJoin(personalSongMutation, eq(operation.id, personalSongMutation.operationId))
      .where(and(
        inArray(operation.kind, ["addPersonalSong", "removePersonalSong"]),
        sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
      )).all();

    for (const { operation: op, personal_song_mutation: detail } of rows) {
      if (op.status === "waitingAuthorization" || op.status === "needsAdministrator") continue;

      if (["sending", "confirming", "unknown"].includes(detail.step)) {
        const nextCheckAt = detail.nextCheckAt !== null && detail.nextCheckAt > this.now()
          ? detail.nextCheckAt
          : this.now() + 5000;
        this.database.transaction(tx => {
          tx.update(personalSongMutation).set({ step: "unknown", checkRound: detail.checkRound, nextCheckAt }).where(eq(personalSongMutation.operationId, op.id)).run();
          tx.update(operation).set({ status: "awaitingConfirmation", updatedAt: this.now() }).where(eq(operation.id, op.id)).run();
        });

        if (detail.checkRound < 3) {
          this.#scheduleSongMutationConfirmationCheck(op.id, Math.max(0, nextCheckAt - this.now()));
        }
      } else {
        if (op.kind === "removePersonalSong" && ["verified", "prepared"].includes(detail.step)) {
          this.database.update(personalSongMutation).set({ step: "ready" }).where(eq(personalSongMutation.operationId, op.id)).run();
        }
        if (op.status === "processing") this.#status(op.id, "queued");
      }
    }
  }

  #validatePlaylistDetail(data: any, expectedPlaylistId: string, expectedCreatorId: string): boolean {
    if (!data || !data.playlist || data.playlist.id !== expectedPlaylistId || data.playlist.status !== 0 || data.playlist.creatorId !== expectedCreatorId) {
      return false;
    }
    if (!Array.isArray(data.songIds) || !Array.isArray(data.songs) || data.songIds.length !== data.songs.length || new Set(data.songIds).size !== data.songIds.length) {
      return false;
    }
    for (let i = 0; i < data.songIds.length; i++) {
      const song = data.songs[i];
      if (!song || song.id !== data.songIds[i] || typeof song.name !== "string" || song.name.length === 0 || typeof song.album !== "string" || !Array.isArray(song.artists) || !song.artists.every((artist: unknown) => typeof artist === "string")) {
        return false;
      }
    }
    return true;
  }

  #conditionsForSongMutation(row: Operation): "valid" | "stopped" | "waitingAuthorization" {
    const currentOperation = this.database.select().from(operation).where(eq(operation.id, row.id)).get();
    if (!currentOperation || ["succeeded", "failed", "stopped"].includes(currentOperation.status)) return "stopped";
    const current = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
    const detail = this.database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, row.id)).get();
    if (!current || !member || !detail || member.id !== detail.memberId) return "stopped";

    const binding = this.database.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.roomId, row.roomId), eq(personalPlaylistBinding.memberId, member.id))).get();
    if (!binding || binding.accountId !== row.accountId || binding.playlistId !== detail.playlistId || binding.generation !== detail.bindingGeneration) return "stopped";

    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.ownerUserId)).get();
    if (!auth || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation || auth.status !== "active" || !auth.credentials) {
      return "waitingAuthorization";
    }
    return "valid";
  }

  #conditionStatusForSongMutation(row: Operation, condition: "stopped" | "waitingAuthorization"): void {
    const current = this.database.select().from(operation).where(eq(operation.id, row.id)).get();
    if (!current || ["succeeded", "failed", "stopped"].includes(current.status)) return;
    this.#status(
      row.id,
      condition,
      condition === "waitingAuthorization" ? "AUTH_UNAVAILABLE" : null
    );
  }

  #prune(): void {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    this.database.delete(operation).where(
      sql`${operation.kind} IN ('createPersonalPlaylist', 'addPersonalSong', 'removePersonalSong') AND ${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${cutoff}`
    ).run();
    this.database.delete(commandReceipt).where(sql`${commandReceipt.expiresAt} <= ${this.now()}`).run();
  }
}
