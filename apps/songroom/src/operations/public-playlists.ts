import { v7 } from "uuid";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt, neteaseAuthorization, operation, playlistSnapshot, playlistTrack, publicPlaylistBinding, publicPlaylistCleanup, publicPlaylistCreation, publicSongRequest, requesterTag, retiredPublicPlaylistBinding, room, roomMembership } from "../db/schema.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterErrorCode, AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { BusinessError } from "../shared/errors.js";
import { publicPlaylistCreateCommand, type PublicPlaylistCreateCommand, type PublicPlaylistView, publicSongRequestCommand, type PublicSongRequestCommand, type SongRequestOperationView } from "../shared/public-playlist-contracts.js";
import type { PublicPlaylistCleanupList } from "../shared/room-contracts.js";
import { EventStreamService } from "../events/event-stream.js";

type Operation = typeof operation.$inferSelect;
type Status = Operation["status"];
const TERMINAL_RETENTION_MS = 86_400_000;
const terminal = (status: Status) => ["succeeded", "failed", "stopped"].includes(status);
const authorizationErrors = new Set(["AUTH_UNAVAILABLE", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH"]);

/** 只接受公共歌单创建与点歌意图。start 必须在 HTTP 成功监听后调用；事务始终同步。 */
export class PublicPlaylists {
  readonly #inFlightRefreshes = new Map<string, Promise<void>>();
  readonly #checkTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly database: AppDatabase,
    readonly adapter: NeteaseAdapter,
    readonly vault: CredentialVault,
    readonly scheduler: UpstreamScheduler,
    readonly eventStream: EventStreamService,
    readonly now: () => number = () => Date.now()
  ) {
    this.scheduler.register("createPublicPlaylist", {
      claim: row => this.#claim(row),
      execute: row => this.#execute(row),
      recover: () => this.#recover()
    });
    this.scheduler.register("requestPublicSong", {
      claim: row => this.#claimSongRequest(row),
      execute: row => this.#executeSongRequest(row),
      recover: () => this.#recoverSongRequests()
    });
  }

  #member(userId: string, roomId: string) {
    const current = this.database.select().from(room).where(eq(room.id, roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();
    if (!current || !member) throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    return current;
  }

  #authorization(userId: string) {
    return this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, userId)).get();
  }

  #view(userId: string, roomId: string, operationId?: string): PublicPlaylistView {
    const current = this.#member(userId, roomId);
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    const latestRetired = this.database.select().from(retiredPublicPlaylistBinding)
      .where(eq(retiredPublicPlaylistBinding.roomId, roomId))
      .orderBy(desc(retiredPublicPlaylistBinding.generation))
      .get();
    const invalidatedTarget = (!binding && latestRetired) ? {
      playlistId: latestRetired.playlistId,
      name: latestRetired.name,
      checkedAt: latestRetired.invalidatedAt,
      status: "confirmedDeleted" as const
    } : null;
    const currentOperation = operationId
      ? this.database.select().from(operation).where(and(eq(operation.id, operationId), eq(operation.roomId, roomId), eq(operation.userId, userId))).get()
      : this.database.select().from(operation).where(and(eq(operation.roomId, roomId), sql`(${operation.status} NOT IN ('succeeded', 'failed', 'stopped') OR ${operation.updatedAt} > ${this.now() - TERMINAL_RETENTION_MS})`)).orderBy(desc(operation.createdAt), desc(operation.id)).get();
    const pending = this.database.select({ id: operation.id }).from(operation).where(and(eq(operation.roomId, roomId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();

    let disabledReason: PublicPlaylistView["disabledReason"] = null;
    if (current.ownerUserId !== userId && !binding) {
      disabledReason = "OWNER_ONLY";
    } else if (binding) {
      const code = this.scheduler.admissionCode(binding.accountId);
      if (code) {
        disabledReason = code;
      } else if (this.#hasTargetConflict(binding.accountId, binding.playlistId)) {
        disabledReason = "TARGET_BLOCKED";
      } else {
        disabledReason = "PUBLIC_PLAYLIST_EXISTS";
      }
    } else if (pending) {
      disabledReason = currentOperation?.errorCode === "TARGET_PERMISSION" ? "TARGET_BLOCKED" : "OPERATION_PENDING";
    } else {
      const auth = this.#authorization(userId);
      if (!auth || auth.status !== "active") {
        disabledReason = "NETEASE_AUTH_REQUIRED";
      } else {
        disabledReason = this.scheduler.admissionCode(auth.accountId);
      }
    }

    let snapshot: PublicPlaylistView["snapshot"] = null;
    let lastRefreshError: PublicPlaylistView["lastRefreshError"] = null;

    if (binding) {
      const snapRow = this.database.select().from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, binding.accountId), eq(playlistSnapshot.playlistId, binding.playlistId))).get();
      if (snapRow) {
        lastRefreshError = (snapRow.lastErrorCode as any) ?? null;
        if (snapRow.syncedAt !== null) {
          const tracks = this.database.select().from(playlistTrack)
            .where(and(eq(playlistTrack.accountId, binding.accountId), eq(playlistTrack.playlistId, binding.playlistId)))
            .orderBy(playlistTrack.position).all();

          const tags = this.database.select({
            songId: requesterTag.songId,
            nickname: roomMembership.nickname
          }).from(requesterTag)
            .innerJoin(roomMembership, eq(requesterTag.memberId, roomMembership.id))
            .where(and(eq(requesterTag.roomId, roomId), eq(requesterTag.bindingGeneration, binding.generation)))
            .all();
          const tagsBySong = new Map<string, string[]>();
          for (const tag of tags) {
            const list = tagsBySong.get(tag.songId) ?? [];
            if (!list.includes(tag.nickname)) list.push(tag.nickname);
            tagsBySong.set(tag.songId, list);
          }
          for (const list of tagsBySong.values()) {
            list.sort((a, b) => a.localeCompare(b, "zh-CN"));
          }

          snapshot = {
            version: snapRow.snapshotVersion,
            syncedAt: snapRow.syncedAt,
            trackCount: tracks.length,
            tracks: tracks.map(t => ({
              position: t.position,
              songId: t.songId,
              name: t.name,
              artists: JSON.parse(t.artists) as string[],
              album: t.album,
              requesters: tagsBySong.get(t.songId) ?? []
            }))
          };
        } else {
          snapshot = {
            version: snapRow.snapshotVersion,
            syncedAt: null,
            trackCount: 0,
            tracks: []
          };
        }
      } else {
        snapshot = {
          version: 0,
          syncedAt: null,
          trackCount: 0,
          tracks: []
        };
      }
    }

    const allowedActions: PublicPlaylistView["allowedActions"] = [];
    if (!binding) {
      if (!disabledReason) allowedActions.push("createPublicPlaylist");
    } else {
      if (disabledReason !== "ACCOUNT_PAUSED" && disabledReason !== "UPSTREAM_QUEUE_FULL") {
        allowedActions.push("refreshPublicPlaylist");
      }
      if (disabledReason !== "ACCOUNT_PAUSED" && disabledReason !== "UPSTREAM_QUEUE_FULL" && disabledReason !== "TARGET_BLOCKED") {
        allowedActions.push("requestSong");
      }
    }

    let opView: PublicPlaylistView["operation"] = null;
    if (currentOperation) {
      const creationDetail = currentOperation.kind === "createPublicPlaylist"
        ? this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, currentOperation.id)).get()
        : null;
      opView = {
        id: currentOperation.id,
        status: currentOperation.status,
        errorCode: currentOperation.errorCode,
        version: currentOperation.version,
        ...(creationDetail ? {
          step: creationDetail.step,
          playlistId: creationDetail.playlistId ?? null,
          recovered: Boolean(creationDetail.recovered)
        } : {})
      };
    }

    return {
      playlist: binding ? { id: binding.playlistId, name: binding.name } : null,
      invalidatedTarget,
      snapshot,
      lastRefreshError,
      operation: opView,
      allowedActions,
      disabledReason,
      version: current.version
    };
  }

  read(userId: string, roomId: string): PublicPlaylistView { return this.#view(userId, roomId); }

  async refresh(userId: string, roomId: string): Promise<PublicPlaylistView> {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const current = this.#member(userId, roomId);
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (!binding) throw new BusinessError(409, "PUBLIC_PLAYLIST_NOT_FOUND", "房间尚未绑定公共歌单");

    const key = `${binding.accountId}:${binding.playlistId}`;
    let task = this.#inFlightRefreshes.get(key);
    if (!task) {
      task = this.#executeRefresh(current.ownerUserId, binding.accountId, binding.playlistId, binding.generation)
        .finally(() => {
          this.#inFlightRefreshes.delete(key);
        });
      this.#inFlightRefreshes.set(key, task);
    }
    await task;
    return this.#view(userId, roomId);
  }

  #recordRefreshError(accountId: string, playlistId: string, errorCode: AdapterErrorCode | "ACCOUNT_PAUSED"): void {
    const affected = this.database.transaction(tx => {
      const now = this.now();
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

      const bindings = tx.select().from(publicPlaylistBinding)
        .where(and(eq(publicPlaylistBinding.accountId, accountId), eq(publicPlaylistBinding.playlistId, playlistId))).all();
      const results: Array<{ roomId: string; version: number }> = [];
      for (const b of bindings) {
        this.#bump(b.roomId);
        const updated = tx.select({ version: room.version }).from(room).where(eq(room.id, b.roomId)).get();
        if (updated) results.push({ roomId: b.roomId, version: updated.version });
      }
      return results;
    });

    for (const item of affected) {
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "room", resourceId: item.roomId, version: item.version });
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "snapshot", resourceId: item.roomId, version: item.version });
    }
  }

  async #executeRefresh(ownerUserId: string, accountId: string, playlistId: string, bindingGeneration: number): Promise<void> {
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, ownerUserId)).get();
    if (!auth || auth.accountId !== accountId || auth.status !== "active" || !auth.credentials) {
      this.#recordRefreshError(accountId, playlistId, "AUTH_UNAVAILABLE");
      return;
    }
    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      this.#recordRefreshError(accountId, playlistId, "AUTH_UNAVAILABLE");
      return;
    }

    const readStartedAt = this.now();
    let result: Awaited<ReturnType<NeteaseAdapter["call"]>>;
    try {
      result = await this.scheduler.executeMemoryTask(accountId, async () => {
        return this.adapter.call({ operation: "playlistDetail", cookie, playlistId });
      });
    } catch (err) {
      if (err instanceof BusinessError && err.code === "ACCOUNT_PAUSED") {
        this.#recordRefreshError(accountId, playlistId, "ACCOUNT_PAUSED");
        return;
      }
      this.#recordRefreshError(accountId, playlistId, "MODULE_ERROR");
      return;
    }

    if (!result.ok) {
      if (result.error.code === "RATE_LIMITED") {
        this.scheduler.pause(accountId);
      }
      if (result.error.code === "TARGET_PERMISSION") {
        const deleted = await this.#verifyTargetDeleted(cookie, accountId, playlistId);
        if (deleted) {
          this.#invalidateBinding(accountId, playlistId, bindingGeneration);
          return;
        }
      }
      this.#recordRefreshError(accountId, playlistId, result.error.code);
      return;
    }

    const data = result.data as { playlist: { id: string; name: string; status: number }; songIds: string[]; songs: Array<{ id: string; name: string; artists: string[]; album: string }> };
    if (data.playlist.status !== 0) {
      const deleted = await this.#verifyTargetDeleted(cookie, accountId, playlistId);
      if (deleted) {
        this.#invalidateBinding(accountId, playlistId, bindingGeneration);
        return;
      }
      this.#recordRefreshError(accountId, playlistId, "TARGET_PERMISSION");
      return;
    }
    this.#commitSnapshot(accountId, playlistId, bindingGeneration, data, readStartedAt);
  }

  async #verifyTargetDeleted(cookie: string, accountId: string, playlistId: string): Promise<boolean> {
    let identityResult: AdapterResult<"identity">;
    try {
      identityResult = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: accountId });
    } catch {
      return false;
    }
    if (!identityResult.ok) {
      if (identityResult.error.code === "RATE_LIMITED") this.scheduler.pause(accountId);
      return false;
    }
    if (identityResult.data.accountId !== accountId) {
      return false;
    }

    const accountPlaylists = await this.#fetchAccountPlaylists(cookie, accountId);
    if (!accountPlaylists) {
      return false;
    }

    const exists = accountPlaylists.some(p => p.id === playlistId);
    return !exists;
  }

  #invalidateBinding(accountId: string, playlistId: string, generation: number): void {
    const now = this.now();
    this.database.transaction(tx => {
      const bindings = tx.select().from(publicPlaylistBinding)
        .where(and(eq(publicPlaylistBinding.accountId, accountId), eq(publicPlaylistBinding.playlistId, playlistId))).all();
      if (!bindings.length) return;

      for (const b of bindings) {
        if (b.generation !== generation) continue;

        tx.insert(retiredPublicPlaylistBinding).values({
          id: v7(),
          roomId: b.roomId,
          accountId: b.accountId,
          playlistId: b.playlistId,
          name: b.name,
          generation: b.generation,
          invalidatedAt: now
        }).run();

        tx.delete(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, b.roomId)).run();

        tx.delete(requesterTag).where(and(
          eq(requesterTag.roomId, b.roomId),
          eq(requesterTag.bindingGeneration, b.generation)
        )).run();

        const songOps = tx.select().from(operation).where(and(
          eq(operation.roomId, b.roomId),
          eq(operation.kind, "requestPublicSong"),
          sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
        )).all();

        for (const op of songOps) {
          tx.update(operation).set({
            status: "stopped",
            errorCode: null,
            version: sql`${operation.version} + 1`,
            accountId: null,
            authorizationId: null,
            generation: null,
            updatedAt: now
          }).where(eq(operation.id, op.id)).run();
          tx.update(publicSongRequest).set({
            step: "stopped",
            nextCheckAt: null
          }).where(eq(publicSongRequest.operationId, op.id)).run();

          const timer = this.#checkTimers.get(op.id);
          if (timer) {
            clearTimeout(timer);
            this.#checkTimers.delete(op.id);
          }
        }

        this.#bump(b.roomId);
        const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, b.roomId)).get();
        if (updatedRoom) {
          this.eventStream.notifyRoom(this.database, b.roomId, { type: "snapshot", resourceId: b.roomId, version: updatedRoom.version });
          this.eventStream.notifyRoom(this.database, b.roomId, { type: "room", resourceId: b.roomId, version: updatedRoom.version });
        }
        for (const op of songOps) {
          const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, op.id)).get();
          if (updatedOp) {
            this.eventStream.notifyRoom(this.database, b.roomId, { type: "operation", resourceId: op.id, version: updatedOp.version });
          }
        }
      }

      const remainingBindings = tx.select().from(publicPlaylistBinding)
        .where(and(eq(publicPlaylistBinding.accountId, accountId), eq(publicPlaylistBinding.playlistId, playlistId))).all();
      if (!remainingBindings.length) {
        tx.delete(playlistTrack).where(and(eq(playlistTrack.accountId, accountId), eq(playlistTrack.playlistId, playlistId))).run();
        tx.delete(playlistSnapshot).where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).run();
      }
    });
  }

  #commitSnapshot(
    accountId: string,
    playlistId: string,
    generation: number,
    data: { playlist: { id: string; name: string; status: number }; songIds: string[]; songs: Array<{ id: string; name: string; artists: string[]; album: string }> },
    readStartedAt: number
  ): boolean {
    if (data.playlist.status !== 0) {
      this.#recordRefreshError(accountId, playlistId, "TARGET_PERMISSION");
      return false;
    }
    if (data.songIds.length !== data.songs.length) {
      this.#recordRefreshError(accountId, playlistId, "PARSE_ERROR");
      return false;
    }
    for (let i = 0; i < data.songIds.length; i++) {
      const song = data.songs[i];
      if (!song || song.id !== data.songIds[i] || !song.name || song.name.length === 0 || !song.album || song.album.length === 0) {
        this.#recordRefreshError(accountId, playlistId, "PARSE_ERROR");
        return false;
      }
    }

    const affected = this.database.transaction(tx => {
      const currentBindings = tx.select().from(publicPlaylistBinding)
        .where(and(eq(publicPlaylistBinding.accountId, accountId), eq(publicPlaylistBinding.playlistId, playlistId))).all();
      if (!currentBindings.length) return { roomsInfo: [], confirmedOps: [] };
      const hasMatchingGen = currentBindings.some(b => b.generation === generation);
      if (!hasMatchingGen) return { roomsInfo: [], confirmedOps: [] };

      // 确保护照依然有效，防止已退出授权的晚到读回覆盖快照
      const activeBindings = currentBindings.filter(b => {
        const r = tx.select().from(room).where(eq(room.id, b.roomId)).get();
        if (!r) return false;
        const auth = tx.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, r.ownerUserId)).get();
        return auth && auth.status === "active" && auth.generation === generation;
      });
      if (!activeBindings.length) return { roomsInfo: [], confirmedOps: [] };

      const currentSnapshot = tx.select().from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).get();

      if (currentSnapshot?.syncedAt && currentSnapshot.syncedAt > readStartedAt) {
        // 较新的读取已提交，不被旧读取覆盖
        return { roomsInfo: [], confirmedOps: [] };
      }

      const nextVersion = (currentSnapshot?.snapshotVersion ?? 0) + 1;
      const now = this.now();

      tx.insert(playlistSnapshot).values({
        accountId,
        playlistId,
        snapshotVersion: nextVersion,
        syncedAt: now,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [playlistSnapshot.accountId, playlistSnapshot.playlistId],
        set: {
          snapshotVersion: nextVersion,
          syncedAt: now,
          lastErrorCode: null,
          updatedAt: now
        }
      }).run();

      tx.delete(playlistTrack).where(and(eq(playlistTrack.accountId, accountId), eq(playlistTrack.playlistId, playlistId))).run();

      const insertTrack = this.database.$client.prepare(
        "INSERT INTO playlist_track (account_id, playlist_id, position, song_id, name, artists, album) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (let i = 0; i < data.songs.length; i++) {
        const s = data.songs[i];
        insertTrack.run(accountId, playlistId, i, s.id, s.name, JSON.stringify(s.artists), s.album);
      }

      // 权威快照确认歌曲移除时，在同一事务清除该歌曲的全部点歌人标签
      const upstreamIds = new Set(data.songs.map(s => s.id));
      for (const b of currentBindings) {
        const roomTags = tx.select().from(requesterTag)
          .where(and(eq(requesterTag.roomId, b.roomId), eq(requesterTag.bindingGeneration, b.generation))).all();
        for (const t of roomTags) {
          if (!upstreamIds.has(t.songId)) {
            tx.delete(requesterTag).where(and(
              eq(requesterTag.roomId, b.roomId),
              eq(requesterTag.bindingGeneration, b.generation),
              eq(requesterTag.songId, t.songId)
            )).run();
          }
        }
        this.#bump(b.roomId);
      }

      // 检查该规范化歌单是否有处于 awaitingConfirmation 的点歌操作已被本次快照证实
      const unconfirmed = tx.select().from(publicSongRequest)
        .innerJoin(operation, eq(publicSongRequest.operationId, operation.id))
        .where(and(
          eq(publicSongRequest.playlistId, playlistId),
          eq(operation.accountId, accountId),
          eq(operation.status, "awaitingConfirmation")
        )).all();

      const confirmedOps: Array<{ row: Operation; detail: typeof publicSongRequest.$inferSelect }> = [];
      for (const item of unconfirmed) {
        if (upstreamIds.has(item.public_song_request.songId)) {
          confirmedOps.push({ row: item.operation, detail: item.public_song_request });
        }
      }
      for (const b of currentBindings) {
        this.#bump(b.roomId);
      }
      const roomsInfo = currentBindings.map(b => {
        const r = tx.select({ version: room.version }).from(room).where(eq(room.id, b.roomId)).get();
        return { roomId: b.roomId, version: r?.version ?? 1 };
      });
      return { roomsInfo, confirmedOps };
    });

    for (const { row, detail } of affected.confirmedOps) {
      this.#confirmSongAndCommitTag(row, detail);
    }

    for (const r of affected.roomsInfo) {
      this.eventStream.notifyRoom(this.database, r.roomId, { type: "snapshot", resourceId: r.roomId, version: r.version });
      this.eventStream.notifyRoom(this.database, r.roomId, { type: "room", resourceId: r.roomId, version: r.version });
    }
    return true;
  }

  create(userId: string, roomId: string, input: PublicPlaylistCreateCommand): { replay: boolean; view: PublicPlaylistView } {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const command = publicPlaylistCreateCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "createPublicPlaylist", { roomId }, this.now());
    const accepted = this.database.transaction(tx => {
      this.#prune();
      const current = this.#member(userId, roomId);
      if (current.ownerUserId !== userId) throw new BusinessError(404, "ROOM_OWNER_REQUIRED", "只有房主可创建公共歌单");
      const original = readCommandResource(tx, prepared, this.now());
      if (original) return { replay: true, view: this.#view(userId, roomId, original) };
      if (tx.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()) {
        throw new BusinessError(409, "PUBLIC_PLAYLIST_EXISTS", "房间已有公共歌单");
      }
      const pending = tx.select().from(operation).where(and(eq(operation.roomId, roomId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
      if (pending) {
        recordCommandResource(tx, prepared, pending.id, this.now());
        return { replay: true, view: this.#view(userId, roomId, pending.id) };
      }
      const auth = this.#authorization(userId);
      if (!auth || auth.status !== "active") throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请先完成网易云授权");
      const admissionCode = this.scheduler.admissionCode(auth.accountId);
      if (admissionCode) throw new BusinessError(409, admissionCode, admissionCode === "ACCOUNT_PAUSED" ? "网易云账号已暂停，请联系管理员" : "网易云账号操作队列已满");
      const id = v7();
      tx.insert(operation).values({ id, kind: "createPublicPlaylist", userId, roomId, accountId: auth.accountId,
        authorizationId: auth.id, generation: auth.generation, lastGranted: this.now(), status: "queued", createdAt: this.now(), updatedAt: this.now() }).run();
      tx.insert(publicPlaylistCreation).values({ operationId: id, name: `songroom-${current.name}-公共`, step: "ready" }).run();
      recordCommandResource(tx, prepared, id, this.now());
      this.#bump(roomId);
      return { replay: false, view: this.#view(userId, roomId, id) };
    });
    this.scheduler.kick();
    if (!accepted.replay && accepted.view.operation) {
      this.eventStream.notifyRoom(this.database, roomId, {
        type: "operation",
        resourceId: accepted.view.operation.id,
        version: accepted.view.operation.version
      });
      this.eventStream.notifyRoom(this.database, roomId, {
        type: "room",
        resourceId: roomId,
        version: accepted.view.version
      });
    }
    return accepted;
  }

  onOwnerRevoked(userId: string): void {
    const notifyRooms: Array<{ roomId: string; version: number }> = [];
    const notifyOps: Array<{ roomId: string; opId: string; version: number }> = [];

    this.database.transaction(tx => {
      const ownedRooms = tx.select({ id: room.id }).from(room).where(eq(room.ownerUserId, userId)).all();
      for (const r of ownedRooms) {
        const ops = tx.select().from(operation).where(and(
          eq(operation.roomId, r.id),
          sql`${operation.status} IN ('queued', 'processing')`
        )).all();

        for (const op of ops) {
          tx.update(operation).set({
            status: "waitingAuthorization",
            errorCode: "AUTH_UNAVAILABLE",
            version: sql`${operation.version} + 1`,
            updatedAt: this.now()
          }).where(eq(operation.id, op.id)).run();

          const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, op.id)).get()!;
          notifyOps.push({ roomId: r.id, opId: op.id, version: updatedOp.version });
        }

        this.#bump(r.id);
        const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, r.id)).get()!;
        notifyRooms.push({ roomId: r.id, version: updatedRoom.version });
      }

      const cleanups = tx.select().from(publicPlaylistCleanup)
        .where(and(eq(publicPlaylistCleanup.userId, userId), sql`${publicPlaylistCleanup.status} IN ('ready', 'sending', 'awaitingConfirmation')`)).all();
      for (const c of cleanups) {
        tx.update(publicPlaylistCleanup).set({
          status: "waitingAuthorization",
          lastErrorCode: "AUTH_UNAVAILABLE",
          version: sql`${publicPlaylistCleanup.version} + 1`,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, c.id)).run();
        const updatedCleanup = tx.select({ version: publicPlaylistCleanup.version }).from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, c.id)).get()!;
        this.eventStream.notifyUser(userId, { type: "cleanup", resourceId: c.id, version: updatedCleanup.version });
      }
    });

    for (const op of notifyOps) {
      this.eventStream.notifyRoom(this.database, op.roomId, { type: "operation", resourceId: op.opId, version: op.version });
    }
    for (const r of notifyRooms) {
      this.eventStream.notifyRoom(this.database, r.roomId, { type: "room", resourceId: r.roomId, version: r.version });
    }
  }

  onReauthorized(userId: string, authId: string, accountId: string, generation: number): void {
    const notifyRooms: Array<{ roomId: string; version: number }> = [];
    const notifyOps: Array<{ roomId: string; opId: string; version: number }> = [];
    const checksToSchedule: Array<{ opId: string; delayMs: number }> = [];
    const cleanupsToDispatch: string[] = [];
    const cleanupsToCheck: string[] = [];

    this.database.transaction(tx => {
      const ownedRooms = tx.select({ id: room.id }).from(room).where(eq(room.ownerUserId, userId)).all();
      for (const r of ownedRooms) {
        let roomChanged = false;

        const createOps = tx.select().from(operation).where(and(
          eq(operation.roomId, r.id),
          eq(operation.kind, "createPublicPlaylist"),
          sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
        )).all();

        for (const op of createOps) {
          const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, op.id)).get();
          if (!detail) continue;

          if (op.status === "needsAdministrator" && detail.step === "unknown") {
            // 创建未知只刷新证据而不猜测关联，保持 needsAdministrator
            tx.update(operation).set({
              accountId,
              authorizationId: authId,
              generation,
              updatedAt: this.now()
            }).where(eq(operation.id, op.id)).run();
            void this.#refreshUnknownCreationEvidence(op.id, accountId, authId, generation);
            continue;
          }

          if (op.status === "needsAdministrator") continue;

          if (["ready", "verified"].includes(detail.step)) {
            const condition = this.#conditions({ ...op, accountId, authorizationId: authId, generation });
            if (condition === "valid") {
              tx.update(publicPlaylistCreation).set({ step: "ready" }).where(eq(publicPlaylistCreation.operationId, op.id)).run();
              tx.update(operation).set({
                accountId,
                authorizationId: authId,
                generation,
                status: "queued",
                errorCode: null,
                version: sql`${operation.version} + 1`,
                updatedAt: this.now()
              }).where(eq(operation.id, op.id)).run();
              roomChanged = true;
            } else if (condition === "stopped") {
              tx.update(operation).set({
                accountId: null,
                authorizationId: null,
                generation: null,
                status: "stopped",
                version: sql`${operation.version} + 1`,
                updatedAt: this.now()
              }).where(eq(operation.id, op.id)).run();
              tx.delete(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, op.id)).run();
              roomChanged = true;
            }
          } else if (detail.step === "confirming") {
            const condition = this.#conditions({ ...op, accountId, authorizationId: authId, generation });
            if (condition === "valid") {
              tx.update(operation).set({
                accountId,
                authorizationId: authId,
                generation,
                status: "queued",
                version: sql`${operation.version} + 1`,
                updatedAt: this.now()
              }).where(eq(operation.id, op.id)).run();
              roomChanged = true;
            }
          }
          const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, op.id)).get();
          if (updatedOp) notifyOps.push({ roomId: r.id, opId: op.id, version: updatedOp.version });
        }

        const songOps = tx.select().from(operation).where(and(
          eq(operation.roomId, r.id),
          eq(operation.kind, "requestPublicSong"),
          sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
        )).all();

        for (const op of songOps) {
          if (op.status === "needsAdministrator") continue;
          if (op.errorCode === "ACCOUNT_PAUSED" || op.errorCode === "TARGET_PERMISSION") continue;

          const detail = tx.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, op.id)).get();
          if (!detail) continue;

          if (detail.songConfirmed && !detail.tagConfirmed) {
            continue;
          }

          if (["ready", "verified"].includes(detail.step) && op.status === "waitingAuthorization") {
            const condition = this.#conditionsForSongRequest({ ...op, accountId, authorizationId: authId, generation });
            if (condition === "valid") {
              tx.update(publicSongRequest).set({ step: "ready" }).where(eq(publicSongRequest.operationId, op.id)).run();
              tx.update(operation).set({
                accountId,
                authorizationId: authId,
                generation,
                status: "queued",
                errorCode: null,
                version: sql`${operation.version} + 1`,
                updatedAt: this.now()
              }).where(eq(operation.id, op.id)).run();
              roomChanged = true;
            } else if (condition === "stopped") {
              tx.update(publicSongRequest).set({ step: "stopped" }).where(eq(publicSongRequest.operationId, op.id)).run();
              tx.update(operation).set({
                accountId: null,
                authorizationId: null,
                generation: null,
                status: "stopped",
                version: sql`${operation.version} + 1`,
                updatedAt: this.now()
              }).where(eq(operation.id, op.id)).run();
              roomChanged = true;
            }
          } else if (["sending", "confirming", "unknown"].includes(detail.step) || op.status === "awaitingConfirmation") {
            tx.update(publicSongRequest).set({
              step: "unknown",
              checkRound: 0,
              nextCheckAt: this.now() + 5000
            }).where(eq(publicSongRequest.operationId, op.id)).run();
            tx.update(operation).set({
              accountId,
              authorizationId: authId,
              generation,
              status: "awaitingConfirmation",
              version: sql`${operation.version} + 1`,
              updatedAt: this.now()
            }).where(eq(operation.id, op.id)).run();
            roomChanged = true;
            checksToSchedule.push({ opId: op.id, delayMs: 5000 });
          }
          const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, op.id)).get();
          if (updatedOp) notifyOps.push({ roomId: r.id, opId: op.id, version: updatedOp.version });
        }

        if (roomChanged) {
          this.#bump(r.id);
          const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, r.id)).get()!;
          notifyRooms.push({ roomId: r.id, version: updatedRoom.version });
        }
      }

      const waitingCleanups = tx.select().from(publicPlaylistCleanup)
        .where(and(eq(publicPlaylistCleanup.userId, userId), eq(publicPlaylistCleanup.accountId, accountId), eq(publicPlaylistCleanup.status, "waitingAuthorization"))).all();
      for (const c of waitingCleanups) {
        if (!c.hasSent) {
          tx.update(publicPlaylistCleanup).set({
            status: "ready",
            lastErrorCode: null,
            version: sql`${publicPlaylistCleanup.version} + 1`,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, c.id)).run();
          const updatedCleanup = tx.select({ version: publicPlaylistCleanup.version }).from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, c.id)).get()!;
          this.eventStream.notifyUser(userId, { type: "cleanup", resourceId: c.id, version: updatedCleanup.version });
          cleanupsToDispatch.push(c.id);
        } else {
          tx.update(publicPlaylistCleanup).set({
            status: "awaitingConfirmation",
            lastErrorCode: null,
            version: sql`${publicPlaylistCleanup.version} + 1`,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, c.id)).run();
          const updatedCleanup = tx.select({ version: publicPlaylistCleanup.version }).from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, c.id)).get()!;
          this.eventStream.notifyUser(userId, { type: "cleanup", resourceId: c.id, version: updatedCleanup.version });
          if (c.checkRound === 0 || c.lastErrorCode === "AUTH_UNAVAILABLE") {
            cleanupsToCheck.push(c.id);
          }
        }
      }
    });

    for (const cId of cleanupsToDispatch) {
      this.dispatchCleanup(cId);
    }
    for (const cId of cleanupsToCheck) {
      this.checkCleanupStatus(cId);
    }

    for (const check of checksToSchedule) {
      this.#scheduleConfirmationCheck(check.opId, check.delayMs);
    }
    for (const op of notifyOps) {
      this.eventStream.notifyRoom(this.database, op.roomId, { type: "operation", resourceId: op.opId, version: op.version });
    }
    for (const r of notifyRooms) {
      this.eventStream.notifyRoom(this.database, r.roomId, { type: "room", resourceId: r.roomId, version: r.version });
      this.eventStream.notifyRoom(this.database, r.roomId, { type: "snapshot", resourceId: r.roomId, version: r.version });
    }
    this.scheduler.kick();
  }

  #bump(roomId: string): void {
    this.database.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
  }

  #status(id: string, status: Status, errorCode: Operation["errorCode"] = null): void {
    const notifyInfo = this.database.transaction(tx => {
      const row = tx.select().from(operation).where(eq(operation.id, id)).get();
      if (!row || (row.status === status && row.errorCode === errorCode)) return null;
      // 处于 waitingAuthorization 时，旧凭据晚到响应不能覆盖为 processing 或 failed
      if (row.status === "waitingAuthorization" && status !== "waitingAuthorization" && status !== "stopped" && status !== "queued") {
        return null;
      }
      tx.update(operation).set({
        status,
        errorCode,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now(),
        ...(terminal(status) ? { accountId: null, authorizationId: null, generation: null } : {})
      }).where(eq(operation.id, id)).run();
      if (terminal(status)) {
        tx.delete(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, id)).run();
      } else if (status === "awaitingConfirmation") {
        tx.update(publicPlaylistCreation).set({ step: "unknown" }).where(eq(publicPlaylistCreation.operationId, id)).run();
      } else if (status === "needsAdministrator") {
        const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, id)).get();
        if (detail && detail.step !== "confirming") {
          tx.update(publicPlaylistCreation).set({ step: "unknown" }).where(eq(publicPlaylistCreation.operationId, id)).run();
        }
      }
      this.#bump(row.roomId);
      const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, id)).get();
      const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (!updatedOp) return null;
      return { roomId: row.roomId, opVersion: updatedOp.version, roomVersion: updatedRoom?.version ?? 0 };
    });
    if (notifyInfo) {
      this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "operation", resourceId: id, version: notifyInfo.opVersion });
      if (notifyInfo.roomVersion > 0) {
        this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "room", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
      }
    }
  }

  #prune(): void {
    this.database.delete(operation).where(sql`${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${this.now() - TERMINAL_RETENTION_MS}`).run();
    this.database.delete(commandReceipt).where(sql`${commandReceipt.expiresAt} <= ${this.now()}`).run();
  }

  start(): void {
    this.#recoverCleanups();
    this.scheduler.start();
  }

  #recoverCleanups(): void {
    const cleanups = this.database.select().from(publicPlaylistCleanup).all();
    for (const c of cleanups) {
      if (c.status === "sending") {
        this.database.update(publicPlaylistCleanup).set({
          status: "awaitingConfirmation",
          checkFact: "interrupted_sending",
          version: sql`${publicPlaylistCleanup.version} + 1`,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, c.id)).run();
        this.checkCleanupStatus(c.id);
      } else if (c.status === "ready" && !c.hasSent) {
        this.dispatchCleanup(c.id);
      } else if (c.status === "awaitingConfirmation" && c.checkRound === 0) {
        this.checkCleanupStatus(c.id);
      }
    }
  }
  stop(): void {
    for (const timer of this.#checkTimers.values()) clearTimeout(timer);
    this.#checkTimers.clear();
    this.scheduler.stop();
  }
  settle(): Promise<void> { return this.scheduler.settle(); }

  triggerDueChecks(): void {
    const rows = this.database.select().from(publicSongRequest)
      .where(and(
        eq(publicSongRequest.step, "unknown"),
        sql`${publicSongRequest.nextCheckAt} IS NOT NULL AND ${publicSongRequest.nextCheckAt} <= ${this.now()}`
      )).all();
    for (const row of rows) {
      void this.#runConfirmationCheck(row.operationId);
    }
  }

  #recover(): void {
    this.#prune();
    for (const row of this.database.select().from(operation).where(eq(operation.kind, "createPublicPlaylist")).all()) {
      if (terminal(row.status) || row.status === "waitingAuthorization") continue;
      const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
      if (!detail) { this.#status(row.id, "needsAdministrator"); continue; }
      if (["sending", "unknown"].includes(detail.step)) {
        this.database.transaction(tx => {
          tx.update(publicPlaylistCreation).set({ step: "unknown" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "needsAdministrator", row.errorCode);
        });
      } else if (detail.step === "confirming") {
        this.database.transaction(tx => {
          tx.update(publicPlaylistCreation).set({ recovered: true }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "queued", row.errorCode);
        });
      } else if (detail.step === "verified") {
        this.database.update(publicPlaylistCreation).set({ step: "ready" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
        this.#status(row.id, "queued");
      } else if (row.status === "processing") {
        this.#status(row.id, "queued");
      }
    }
  }

  #claim(row: Operation): boolean {
    const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
    if (!detail) { this.#status(row.id, "needsAdministrator"); return false; }
    if (detail.step === "confirming") {
      try { this.#bind(row); } catch { this.#status(row.id, "needsAdministrator"); }
      return false;
    }
    if (["sending", "unknown"].includes(detail.step)) {
      this.#status(row.id, "needsAdministrator", row.errorCode);
      return false;
    }
    const condition = this.#conditions(row);
    if (condition !== "valid") { this.#conditionStatus(row, condition); return false; }
    const auth = this.#authorization(row.userId)!;
    if (!auth.credentials) {
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
      this.database.update(publicPlaylistCreation).set({ step: "sending", sentAt: this.now() }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
    }
    this.#bump(row.roomId);
    return true;
  }

  #authorizationError(row: Operation): "ACCOUNT_MISMATCH" | "AUTH_UNAVAILABLE" {
    const auth = this.#authorization(row.userId);
    return auth && auth.accountId !== row.accountId ? "ACCOUNT_MISMATCH" : "AUTH_UNAVAILABLE";
  }

  #conditionStatus(row: Operation, condition: "stopped" | "waitingAuthorization", created = false): void {
    this.#status(row.id, condition === "stopped" && created ? "needsAdministrator" : condition,
      condition === "waitingAuthorization" ? this.#authorizationError(row) : null);
  }

  #conditions(row: Operation): "valid" | "stopped" | "waitingAuthorization" {
    const current = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get();
    if (!current || !member || current.ownerUserId !== row.userId || binding) return "stopped";
    const auth = this.#authorization(row.userId);
    if (!auth || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation || auth.status !== "active" || !auth.credentials) return "waitingAuthorization";
    return "valid";
  }

  #bind(row: Operation): void {
    // 创建 ID 已在独立提交中保存；关联失败不会抹掉上游资源证据。
    let boundPlaylistId: string | null = null;
    let lateCleanupId: string | null = null;
    this.database.transaction(tx => {
      const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get()!;
      const condition = this.#conditions(row);
      if (condition !== "valid") {
        const roomExists = tx.select({ id: room.id }).from(room).where(eq(room.id, row.roomId)).get();
        if (!roomExists && detail.playlistId) {
          lateCleanupId = this.#ensureCleanupInTx(tx, row.userId, row.accountId!, detail.playlistId, row.id);
        }
        this.#conditionStatus(row, condition, true);
        return;
      }
      const targetPlaylistId = detail.playlistId!;

      // 检查不能复用已失效的旧云端 ID
      const retired = tx.select({ id: retiredPublicPlaylistBinding.id }).from(retiredPublicPlaylistBinding)
        .where(eq(retiredPublicPlaylistBinding.playlistId, targetPlaylistId)).get();
      if (retired) {
        this.#status(row.id, "needsAdministrator", "TARGET_PERMISSION");
        return;
      }

      // 检查不能跨房间共用其他房间的活跃公共歌单
      const sharedOtherRoom = tx.select({ roomId: publicPlaylistBinding.roomId }).from(publicPlaylistBinding)
        .where(and(
          eq(publicPlaylistBinding.playlistId, targetPlaylistId),
          ne(publicPlaylistBinding.roomId, row.roomId)
        )).get();
      if (sharedOtherRoom) {
        this.#status(row.id, "needsAdministrator", "TARGET_PERMISSION");
        return;
      }

      const maxRetired = tx.select({ gen: retiredPublicPlaylistBinding.generation })
        .from(retiredPublicPlaylistBinding)
        .where(eq(retiredPublicPlaylistBinding.roomId, row.roomId))
        .orderBy(desc(retiredPublicPlaylistBinding.generation))
        .get();
      const nextGeneration = (maxRetired?.gen ?? 0) + 1;

      tx.insert(publicPlaylistBinding).values({
        roomId: row.roomId,
        accountId: row.accountId!,
        playlistId: targetPlaylistId,
        name: detail.name,
        creationOperationId: row.id,
        generation: nextGeneration
      }).run();
      tx.insert(playlistSnapshot).values({
        accountId: row.accountId!,
        playlistId: targetPlaylistId,
        snapshotVersion: 0,
        syncedAt: null,
        lastErrorCode: null,
        createdAt: this.now(),
        updatedAt: this.now()
      }).onConflictDoNothing().run();
      this.#status(row.id, "succeeded");
      boundPlaylistId = targetPlaylistId;
    });
    if (lateCleanupId) {
      this.dispatchCleanup(lateCleanupId);
    }
    if (boundPlaylistId) {
      const currentRoom = this.database.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (currentRoom) {
        this.eventStream.notifyRoom(this.database, row.roomId, {
          type: "snapshot",
          resourceId: row.roomId,
          version: currentRoom.version
        });
        this.eventStream.notifyRoom(this.database, row.roomId, {
          type: "room",
          resourceId: row.roomId,
          version: currentRoom.version
        });
      }
    }
  }

  #readFailure(row: Operation, code: AdapterErrorCode): void {
    if (code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
    this.#status(row.id, authorizationErrors.has(code) ? "waitingAuthorization" : ["RATE_LIMITED", "TARGET_PERMISSION"].includes(code) ? "needsAdministrator" : "failed", code);
  }

  async #fetchAccountPlaylists(cookie: string, accountId: string): Promise<Array<{ id: string; name: string }> | null> {
    const list: Array<{ id: string; name: string }> = [];
    let offset = 0;
    const limit = 1000;
    let pages = 0;
    while (true) {
      if (++pages > 50) return null;
      const res = await this.adapter.call({ operation: "userPlaylists", cookie, accountId, offset, limit });
      if (!res.ok) return null;
      for (const p of res.data.playlists) list.push({ id: p.id, name: p.name });
      if (!res.data.more) break;
      if (res.data.playlists.length === 0) return null;
      offset += res.data.playlists.length;
    }
    return list;
  }

  async #refreshUnknownCreationEvidence(opId: string, accountId: string, authId: string, generation: number): Promise<void> {
    try {
      const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.id, authId)).get();
      if (!auth || auth.status !== "active" || !auth.credentials) return;
      const cookie = this.vault.decrypt(auth.credentials, { authorizationId: authId, accountId, generation });
      const afterList = await this.#fetchAccountPlaylists(cookie, accountId);
      if (!afterList) return;
      this.database.transaction(tx => {
        const op = tx.select().from(operation).where(eq(operation.id, opId)).get();
        if (!op || op.status !== "needsAdministrator" || op.generation !== generation) return;
        tx.update(publicPlaylistCreation).set({
          afterPlaylists: JSON.stringify(afterList)
        }).where(eq(publicPlaylistCreation.operationId, opId)).run();
        this.#bump(op.roomId);
      });
    } catch {
      // 忽略只读补查失败，不影响记录
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
      tx.update(publicPlaylistCreation).set({
        step: "unknown",
        afterPlaylists: afterList ? JSON.stringify(afterList) : null
      }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
      tx.update(operation).set({
        status: "needsAdministrator",
        errorCode,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(eq(operation.id, row.id)).run();
      this.#bump(row.roomId);
      const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get();
      const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (!updatedOp) return null;
      return { roomId: row.roomId, opVersion: updatedOp.version, roomVersion: updatedRoom?.version ?? 0 };
    });
    if (notifyInfo) {
      this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "operation", resourceId: row.id, version: notifyInfo.opVersion });
      if (notifyInfo.roomVersion > 0) {
        this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "room", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
      }
    }
  }

  async #execute(row: Operation): Promise<void> {
    const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get()!;
    const auth = this.#authorization(row.userId)!;
    if (!auth.credentials) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return;
    }
    const cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
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
          tx.update(publicPlaylistCreation).set({
            step: "verified",
            beforePlaylists: JSON.stringify(beforeList)
          }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
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
        await this.#transitionToUnknownCreation(row, createResult.error.code, cookie);
        return;
      }

      this.database.transaction(tx => {
        tx.update(publicPlaylistCreation).set({ step: "confirming", playlistId: createResult.data.playlistId }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
        this.#bump(row.roomId);
      });
      this.#bind(row);
    } catch {
      const saved = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
      if (saved?.step === "confirming") {
        this.#status(row.id, "needsAdministrator", "MODULE_ERROR");
      } else if (saved?.step === "sending" || saved?.step === "unknown") {
        await this.#transitionToUnknownCreation(row, "MODULE_ERROR", cookie);
      } else {
        this.#status(row.id, "failed", "MODULE_ERROR");
      }
    }
  }

  readOperation(userId: string, roomId: string, operationId: string): SongRequestOperationView {
    this.#member(userId, roomId);
    const row = this.database.select().from(operation)
      .where(and(eq(operation.id, operationId), eq(operation.roomId, roomId), eq(operation.userId, userId), eq(operation.kind, "requestPublicSong"))).get();
    if (!row) throw new BusinessError(404, "OPERATION_NOT_FOUND", "操作不存在");
    const detail = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, operationId)).get();
    if (!detail) throw new BusinessError(404, "OPERATION_NOT_FOUND", "操作详情不存在");
    return {
      id: row.id,
      roomId: row.roomId,
      songId: detail.songId,
      name: detail.name,
      artists: JSON.parse(detail.artists) as string[],
      album: detail.album,
      status: row.status,
      songConfirmed: detail.songConfirmed,
      tagConfirmed: detail.tagConfirmed,
      errorCode: row.errorCode as any,
      step: detail.step,
      version: row.version
    };
  }

  requestSong(userId: string, roomId: string, input: PublicSongRequestCommand): { replay: boolean; operation: SongRequestOperationView } {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const command = publicSongRequestCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "requestPublicSong", {
      roomId,
      songId: command.songId,
      name: command.name,
      artists: command.artists,
      album: command.album
    }, this.now());

    const accepted = this.database.transaction(tx => {
      this.#prune();
      const current = this.#member(userId, roomId);
      const member = tx.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get()!;
      const original = readCommandResource(tx, prepared, this.now());
      if (original) {
        return { replay: true, opId: original, existing: false };
      }

      const binding = tx.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
      if (!binding) throw new BusinessError(409, "PUBLIC_PLAYLIST_NOT_FOUND", "房间尚未绑定公共歌单");

      const auth = tx.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.ownerUserId)).get();
      if (!auth || auth.status !== "active") throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请房主先完成网易云授权");

      const admissionCode = this.scheduler.admissionCode(auth.accountId);
      if (admissionCode) {
        throw new BusinessError(409, admissionCode, admissionCode === "ACCOUNT_PAUSED" ? "网易云账号已暂停，请联系管理员" : "网易云账号操作队列已满");
      }

      // 待确认只阻塞同一规范化公共歌单的冲突写入，其他目标继续推进
      if (this.#hasTargetConflict(binding.accountId, binding.playlistId)) {
        throw new BusinessError(409, "TARGET_BLOCKED", "公共歌单当前有待确认的写入操作，请稍后刷新查看");
      }

      // 同一成员在同一房间已有未完成写操作时拒绝第二项不同写入
      const pending = tx.select().from(operation).where(and(
        eq(operation.roomId, roomId),
        eq(operation.userId, userId),
        sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
      )).get();
      if (pending) {
        throw new BusinessError(409, "CONCURRENT_OPERATION_LIMIT_EXCEEDED", "你在该房间已有未完成的写操作，请等待处理");
      }

      // 检查当前快照中是否已有该歌曲
      const existingTrack = tx.select().from(playlistTrack).where(and(
        eq(playlistTrack.accountId, binding.accountId),
        eq(playlistTrack.playlistId, binding.playlistId),
        eq(playlistTrack.songId, command.songId)
      )).get();

      if (existingTrack) {
        // 公共目标已有该歌曲时不调用增加接口、不移动或重排歌曲，只写入该成员的去重标签
        tx.insert(requesterTag).values({
          roomId,
          bindingGeneration: binding.generation,
          songId: command.songId,
          memberId: member.id,
          createdAt: this.now()
        }).onConflictDoNothing().run();

        const id = v7();
        tx.insert(operation).values({
          id,
          kind: "requestPublicSong",
          userId,
          roomId,
          accountId: null,
          authorizationId: null,
          generation: null,
          lastGranted: this.now(),
          status: "succeeded",
          createdAt: this.now(),
          updatedAt: this.now()
        }).run();

        tx.insert(publicSongRequest).values({
          operationId: id,
          songId: command.songId,
          name: command.name,
          artists: JSON.stringify(command.artists),
          album: command.album,
          step: "succeeded",
          songConfirmed: true,
          tagConfirmed: true,
          playlistId: binding.playlistId,
          bindingGeneration: binding.generation,
          checkRound: 0,
          nextCheckAt: null
        }).run();

        recordCommandResource(tx, prepared, id, this.now());
        this.#bump(roomId);
        return { replay: false, opId: id, existing: true };
      }

      // 目标尚无歌曲，入队排队
      const id = v7();
      tx.insert(operation).values({
        id,
        kind: "requestPublicSong",
        userId,
        roomId,
        accountId: binding.accountId,
        authorizationId: auth.id,
        generation: auth.generation,
        lastGranted: this.now(),
        status: "queued",
        createdAt: this.now(),
        updatedAt: this.now()
      }).run();

      tx.insert(publicSongRequest).values({
        operationId: id,
        songId: command.songId,
        name: command.name,
        artists: JSON.stringify(command.artists),
        album: command.album,
        step: "ready",
        songConfirmed: false,
        tagConfirmed: false,
        playlistId: binding.playlistId,
        bindingGeneration: binding.generation,
        checkRound: 0,
        nextCheckAt: null
      }).run();

      recordCommandResource(tx, prepared, id, this.now());
      this.#bump(roomId);
      return { replay: false, opId: id, existing: false };
    });

    if (!accepted.replay && !accepted.existing) {
      this.scheduler.kick();
    }
    const currentRoom = this.database.select({ version: room.version }).from(room).where(eq(room.id, roomId)).get();
    this.eventStream.notifyRoom(this.database, roomId, { type: "operation", resourceId: accepted.opId, version: 1 });
    if (currentRoom) {
      this.eventStream.notifyRoom(this.database, roomId, { type: "room", resourceId: roomId, version: currentRoom.version });
    }

    return {
      replay: accepted.replay,
      operation: this.readOperation(userId, roomId, accepted.opId)
    };
  }

  #claimSongRequest(row: Operation): boolean {
    const detail = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get();
    if (!detail) {
      this.#status(row.id, "needsAdministrator");
      return false;
    }

    if (detail.songConfirmed && !detail.tagConfirmed) {
      this.#commitTagOnly(row, detail);
      return false;
    }

    if (detail.step === "confirming") {
      return true;
    }
    if (["sending", "unknown"].includes(detail.step)) {
      this.#status(row.id, "awaitingConfirmation", row.errorCode);
      return false;
    }

    const condition = this.#conditionsForSongRequest(row);
    if (condition !== "valid") {
      this.#conditionStatus(row, condition);
      return false;
    }

    const currentRoom = this.database.select().from(room).where(eq(room.id, row.roomId)).get()!;
    const auth = this.#authorization(currentRoom.ownerUserId);
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
      this.database.update(publicSongRequest).set({ step: "sending" }).where(eq(publicSongRequest.operationId, row.id)).run();
    }
    this.#bump(row.roomId);
    return true;
  }

  #hasTargetConflict(accountId: string, playlistId: string): boolean {
    const snap = this.database.select({ code: playlistSnapshot.lastErrorCode })
      .from(playlistSnapshot)
      .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId)))
      .get();
    if (snap?.code === "TARGET_PERMISSION") return true;

    const conflict = this.database.select({ id: operation.id })
      .from(operation)
      .innerJoin(publicSongRequest, eq(operation.id, publicSongRequest.operationId))
      .where(and(
        eq(operation.accountId, accountId),
        eq(publicSongRequest.playlistId, playlistId),
        eq(operation.status, "awaitingConfirmation")
      ))
      .get();
    return Boolean(conflict);
  }

  #transitionToAwaitingConfirmation(row: Operation, errorCode: Operation["errorCode"] = null): void {
    const notifyInfo = this.database.transaction(tx => {
      tx.update(publicSongRequest).set({
        step: "unknown",
        checkRound: 0,
        nextCheckAt: this.now() + 5000
      }).where(eq(publicSongRequest.operationId, row.id)).run();
      tx.update(operation).set({
        status: "awaitingConfirmation",
        errorCode,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(eq(operation.id, row.id)).run();
      this.#bump(row.roomId);
      const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get();
      const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (!updatedOp) return null;
      return { roomId: row.roomId, opVersion: updatedOp.version, roomVersion: updatedRoom?.version ?? 0 };
    });
    this.#scheduleConfirmationCheck(row.id, 5000);
    if (notifyInfo) {
      this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "operation", resourceId: row.id, version: notifyInfo.opVersion });
      if (notifyInfo.roomVersion > 0) {
        this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "room", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
      }
    }
  }

  #commitTagOnly(row: Operation, detail: typeof publicSongRequest.$inferSelect): void {
    const timer = this.#checkTimers.get(row.id);
    if (timer) {
      clearTimeout(timer);
      this.#checkTimers.delete(row.id);
    }
    const condition = this.#conditionsForSongRequest(row);
    if (condition !== "valid") {
      this.database.update(publicSongRequest).set({ step: "stopped", nextCheckAt: null }).where(eq(publicSongRequest.operationId, row.id)).run();
      this.#conditionStatus(row, condition);
      return;
    }
    const notifyInfo = this.database.transaction(tx => {
      const member = tx.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get()!;
      tx.insert(requesterTag).values({
        roomId: row.roomId,
        bindingGeneration: detail.bindingGeneration,
        songId: detail.songId,
        memberId: member.id,
        createdAt: this.now()
      }).onConflictDoNothing().run();

      tx.update(publicSongRequest).set({ step: "succeeded", tagConfirmed: true, nextCheckAt: null }).where(eq(publicSongRequest.operationId, row.id)).run();
      tx.update(operation).set({
        status: "succeeded",
        errorCode: null,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now(),
        accountId: null,
        authorizationId: null,
        generation: null
      }).where(eq(operation.id, row.id)).run();
      this.#bump(row.roomId);
      const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get();
      const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (!updatedOp) return null;
      return { roomId: row.roomId, opVersion: updatedOp.version, roomVersion: updatedRoom?.version ?? 0 };
    });
    if (notifyInfo) {
      this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "operation", resourceId: row.id, version: notifyInfo.opVersion });
      if (notifyInfo.roomVersion > 0) {
        this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "room", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
        this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "snapshot", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
      }
    }
  }

  #conditionsForSongRequest(row: Operation): "valid" | "stopped" | "waitingAuthorization" {
    const current = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get();
    if (!current || !member || !binding) return "stopped";
    const detail = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get();
    if (detail && (binding.playlistId !== detail.playlistId || binding.generation !== detail.bindingGeneration)) return "stopped";
    const auth = this.#authorization(current.ownerUserId);
    if (!auth || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation) return "waitingAuthorization";
    return "valid";
  }

  #scheduleConfirmationCheck(operationId: string, delayMs: number): void {
    const existing = this.#checkTimers.get(operationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#checkTimers.delete(operationId);
      void this.#runConfirmationCheck(operationId);
    }, Math.max(1, delayMs));
    this.#checkTimers.set(operationId, timer);
  }

  #advanceCheckRound(row: Operation, detail: typeof publicSongRequest.$inferSelect, currentRound: number): void {
    const nextRound = currentRound + 1;
    const DELAYS = [5_000, 30_000, 120_000];
    const nextDelay = nextRound < DELAYS.length ? DELAYS[nextRound] : null;

    const notifyInfo = this.database.transaction(tx => {
      tx.update(publicSongRequest).set({
        checkRound: Math.min(nextRound, 3),
        nextCheckAt: nextDelay ? this.now() + nextDelay : null
      }).where(eq(publicSongRequest.operationId, row.id)).run();
      tx.update(operation).set({
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(eq(operation.id, row.id)).run();
      const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get()!;
      return { roomId: row.roomId, opVersion: updatedOp.version };
    });

    if (nextDelay !== null) {
      this.#scheduleConfirmationCheck(row.id, nextDelay);
    }
    if (notifyInfo) {
      this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "operation", resourceId: row.id, version: notifyInfo.opVersion });
    }
  }

  #confirmSongAndCommitTag(row: Operation, detail: typeof publicSongRequest.$inferSelect): void {
    const timer = this.#checkTimers.get(row.id);
    if (timer) {
      clearTimeout(timer);
      this.#checkTimers.delete(row.id);
    }

    const condition = this.#conditionsForSongRequest(row);
    if (condition !== "valid") {
      const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
      if (!member) {
        // 离开者已无成员关系：终结后彻底清除其操作数据
        this.database.transaction(tx => {
          tx.delete(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).run();
          tx.delete(operation).where(eq(operation.id, row.id)).run();
        });
        return;
      }
      this.database.update(publicSongRequest).set({ songConfirmed: true, step: "stopped", nextCheckAt: null }).where(eq(publicSongRequest.operationId, row.id)).run();
      this.#conditionStatus(row, condition);
      return;
    }

    // 两阶段状态持久化接缝：先确认云端歌曲进入 tagging，再持久化本地标签终结为 succeeded
    this.database.update(publicSongRequest).set({
      songConfirmed: true,
      step: "tagging",
      nextCheckAt: null
    }).where(eq(publicSongRequest.operationId, row.id)).run();

    const notifyInfo = this.database.transaction(tx => {
      const member = tx.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get()!;
      tx.insert(requesterTag).values({
        roomId: row.roomId,
        bindingGeneration: detail.bindingGeneration,
        songId: detail.songId,
        memberId: member.id,
        createdAt: this.now()
      }).onConflictDoNothing().run();

      tx.update(publicSongRequest).set({
        tagConfirmed: true,
        step: "succeeded"
      }).where(eq(publicSongRequest.operationId, row.id)).run();

      tx.update(operation).set({
        status: "succeeded",
        errorCode: null,
        version: sql`${operation.version} + 1`,
        updatedAt: this.now(),
        accountId: null,
        authorizationId: null,
        generation: null
      }).where(eq(operation.id, row.id)).run();

      this.#bump(row.roomId);
      const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get();
      const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
      if (!updatedOp) return null;
      return { roomId: row.roomId, opVersion: updatedOp.version, roomVersion: updatedRoom?.version ?? 0 };
    });

    if (notifyInfo) {
      this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "operation", resourceId: row.id, version: notifyInfo.opVersion });
      if (notifyInfo.roomVersion > 0) {
        this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "room", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
        this.eventStream.notifyRoom(this.database, notifyInfo.roomId, { type: "snapshot", resourceId: notifyInfo.roomId, version: notifyInfo.roomVersion });
      }
    }
  }

  async #runConfirmationCheck(operationId: string): Promise<void> {
    const claimed = this.database.transaction(tx => {
      const row = tx.select().from(operation).where(eq(operation.id, operationId)).get();
      if (!row || row.status !== "awaitingConfirmation") return null;
      const detail = tx.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, operationId)).get();
      if (!detail || detail.step !== "unknown") return null;

      tx.update(publicSongRequest).set({ nextCheckAt: null }).where(eq(publicSongRequest.operationId, operationId)).run();
      return { row, detail };
    });

    if (!claimed) return;
    const { row, detail } = claimed;

    const currentRoom = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get();
    if (!currentRoom || !binding || binding.playlistId !== detail.playlistId || binding.generation !== detail.bindingGeneration) {
      this.#status(row.id, "stopped");
      return;
    }

    const auth = this.#authorization(currentRoom.ownerUserId);
    if (!auth || !auth.credentials) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return;
    }
    if (auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation) {
      this.#status(row.id, "waitingAuthorization");
      return;
    }
    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return;
    }

    const currentRound = detail.checkRound;
    try {
      const readStartedAt = this.now();
      const detailResult = await this.scheduler.executeMemoryTask(row.accountId!, async () => {
        return this.adapter.call({ operation: "playlistDetail", cookie, playlistId: detail.playlistId });
      });

      if (!detailResult.ok) {
        if (detailResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
        this.#recordRefreshError(row.accountId!, detail.playlistId, detailResult.error.code);
        this.#advanceCheckRound(row, detail, currentRound);
        return;
      }

      const data = detailResult.data;
      if (data.playlist.status !== 0 || data.songIds.length !== data.songs.length) {
        this.#recordRefreshError(row.accountId!, detail.playlistId, "PARSE_ERROR");
        this.#advanceCheckRound(row, detail, currentRound);
        return;
      }

      const committed = this.#commitSnapshot(row.accountId!, detail.playlistId, detail.bindingGeneration, data, readStartedAt);
      if (!committed) {
        this.#advanceCheckRound(row, detail, currentRound);
        return;
      }

      const existsInSnapshot = data.songIds.includes(detail.songId);
      if (existsInSnapshot) {
        this.#confirmSongAndCommitTag(row, detail);
      } else {
        this.#advanceCheckRound(row, detail, currentRound);
      }
    } catch {
      this.#advanceCheckRound(row, detail, currentRound);
    }
  }

  #recoverSongRequests(): void {
    for (const row of this.database.select().from(operation).where(eq(operation.kind, "requestPublicSong")).all()) {
      if (terminal(row.status) || row.status === "waitingAuthorization") continue;
      const detail = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get();
      if (!detail) { this.#status(row.id, "needsAdministrator"); continue; }
      if (detail.songConfirmed && !detail.tagConfirmed) {
        this.#commitTagOnly(row, detail);
        continue;
      }
      if (["sending", "confirming", "unknown"].includes(detail.step)) {
        // 进入 sending 后的任何中断都恢复为只能确认的步骤，绝不能重新排为写入
        const nextCheckAt = detail.nextCheckAt !== null && detail.nextCheckAt > this.now()
          ? detail.nextCheckAt
          : this.now() + 5000;
        this.database.transaction(tx => {
          tx.update(publicSongRequest).set({ step: "unknown", checkRound: detail.checkRound, nextCheckAt }).where(eq(publicSongRequest.operationId, row.id)).run();
          tx.update(operation).set({ status: "awaitingConfirmation", updatedAt: this.now() }).where(eq(operation.id, row.id)).run();
        });

        if (detail.checkRound < 3) {
          this.#scheduleConfirmationCheck(row.id, nextCheckAt - this.now());
        }
      } else if (detail.step === "verified") {
        this.database.update(publicSongRequest).set({ step: "ready" }).where(eq(publicSongRequest.operationId, row.id)).run();
        this.#status(row.id, "queued");
      } else if (row.status === "processing") {
        this.#status(row.id, "queued");
      }
    }
  }

  async #executeSongRequest(row: Operation): Promise<void> {
    const detail = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get()!;
    const currentRoom = this.database.select().from(room).where(eq(room.id, row.roomId)).get()!;
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get()!;
    const auth = this.#authorization(currentRoom.ownerUserId)!;
    if (!auth || !auth.credentials) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return;
    }
    const cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });

    try {
      if (detail.step === "ready") {
        const snap = this.database.select().from(playlistTrack).where(and(
          eq(playlistTrack.accountId, binding.accountId),
          eq(playlistTrack.playlistId, binding.playlistId),
          eq(playlistTrack.songId, detail.songId)
        )).get();
        if (snap) {
          this.database.update(publicSongRequest).set({ step: "confirming" }).where(eq(publicSongRequest.operationId, row.id)).run();
          this.#status(row.id, "queued");
          return;
        }

        const identity = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId! });
        this.database.transaction(tx => {
          if (!identity.ok) { this.#readFailure(row, identity.error.code); return; }
          if (identity.data.accountId !== row.accountId) { this.#status(row.id, "waitingAuthorization", "ACCOUNT_MISMATCH"); return; }
          tx.update(publicSongRequest).set({ step: "verified" }).where(eq(publicSongRequest.operationId, row.id)).run();
          this.#status(row.id, "queued");
        });
        return;
      }

      if (detail.step === "sending") {
        const addResult = await this.adapter.call({ operation: "trackAdd", cookie, playlistId: detail.playlistId, songId: detail.songId });
        if (!addResult.ok) {
          if (addResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
          if (addResult.error.outcome === "failed") {
            // 明确业务拒绝：直接终结为失败（或 waitingAuthorization / needsAdministrator）
            this.database.transaction(tx => {
              tx.update(publicSongRequest).set({ step: "rejected" }).where(eq(publicSongRequest.operationId, row.id)).run();
              this.#readFailure(row, addResult.error.code);
            });
            return;
          }

          // outcome 为 unknown（普通错误、超时、子进程被杀、无消息退出、解析失败、网络错误）：
          // 绝不重发！进入 awaitingConfirmation 并安排首轮只读补查
          this.#transitionToAwaitingConfirmation(row, addResult.error.code);
          return;
        }

        // trackAdd 成功，更新 step 为 confirming 并继续执行写后读回
        this.database.update(publicSongRequest).set({ step: "confirming" }).where(eq(publicSongRequest.operationId, row.id)).run();
      }

      if (detail.step === "confirming" || this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get()?.step === "confirming") {
        const readStartedAt = this.now();
        const detailResult = await this.adapter.call({ operation: "playlistDetail", cookie, playlistId: detail.playlistId });
        if (!detailResult.ok) {
          if (detailResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
          this.#recordRefreshError(binding.accountId, binding.playlistId, detailResult.error.code);
          this.#transitionToAwaitingConfirmation(row, detailResult.error.code);
          return;
        }

        const data = detailResult.data;
        // 严格遵循 CONSTRAINTS #274：专用歌单删除实验中 status=10 且带旧歌曲，正常歌单 status=0
        if (data.playlist.status !== 0 || data.songIds.length !== data.songs.length) {
          this.#recordRefreshError(binding.accountId, binding.playlistId, "PARSE_ERROR");
          this.#transitionToAwaitingConfirmation(row, "PARSE_ERROR");
          return;
        }

        // 调用统一的快照提交，严格以事务递增单调版本并清理已移除歌曲标签
        const committed = this.#commitSnapshot(binding.accountId, binding.playlistId, binding.generation, data, readStartedAt);
        if (!committed) {
          this.#transitionToAwaitingConfirmation(row, "PARSE_ERROR");
          return;
        }

        const existsInSnapshot = data.songIds.includes(detail.songId);
        if (existsInSnapshot) {
          this.#confirmSongAndCommitTag(row, detail);
        } else {
          // 读回矛盾：写后读回未发现该歌曲，安排只读补查
          this.#transitionToAwaitingConfirmation(row);
        }
      }
    } catch {
      const saved = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get();
      if (saved && ["sending", "confirming", "unknown"].includes(saved.step)) {
        this.#transitionToAwaitingConfirmation(row, "MODULE_ERROR");
      } else {
        this.#status(row.id, "failed", "MODULE_ERROR");
      }
    }
  }

  terminateMemberInTx(tx: any, roomId: string, userId: string): void {
    const ops = tx.select().from(operation)
      .where(and(eq(operation.roomId, roomId), eq(operation.userId, userId))).all();

    for (const op of ops) {
      tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, userId), eq(commandReceipt.resourceId, op.id))).run();

      if (["succeeded", "failed", "stopped"].includes(op.status)) {
        tx.delete(operation).where(eq(operation.id, op.id)).run();
      } else {
        const detail = tx.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, op.id)).get();
        if (detail && ["ready", "verified"].includes(detail.step)) {
          tx.delete(operation).where(eq(operation.id, op.id)).run();
        } else {
          // 已可能发出的写入（sending, confirming, unknown）：
          // 脱离原账号归属，分配独立匿名 ID，只保留收敛云端歌单所需的最小事实（songId、playlistId、generation）
          const anonymousId = v7();
          tx.update(operation).set({
            userId: anonymousId,
            updatedAt: this.now()
          }).where(eq(operation.id, op.id)).run();
        }
      }
    }
  }

  readPublicPlaylistTarget(roomId: string): { id: string | null; name: string } | null {
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (binding) {
      return { id: binding.playlistId, name: binding.name };
    }
    const op = this.database.select().from(operation)
      .where(and(eq(operation.roomId, roomId), eq(operation.kind, "createPublicPlaylist"))).get();
    if (op && ["queued", "processing"].includes(op.status)) {
      const creation = this.database.select().from(publicPlaylistCreation)
        .where(eq(publicPlaylistCreation.operationId, op.id)).get();
      if (creation) {
        return { id: creation.playlistId, name: creation.name };
      }
    }
    return null;
  }

  readPublicPlaylistBinding(roomId: string) {
    return this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
  }

  readCleanups(userId: string): PublicPlaylistCleanupList {
    const rows = this.database.select().from(publicPlaylistCleanup)
      .where(eq(publicPlaylistCleanup.userId, userId))
      .orderBy(desc(publicPlaylistCleanup.createdAt))
      .all();
    return {
      cleanups: rows.map(r => ({
        id: r.id,
        accountId: r.accountId,
        playlistId: r.playlistId,
        status: r.status,
        lastErrorCode: r.lastErrorCode,
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }))
    };
  }

  #ensureCleanupInTx(tx: any, userId: string, accountId: string, playlistId: string, creationOperationId?: string | null): string {
    const existing = tx.select().from(publicPlaylistCleanup)
      .where(and(eq(publicPlaylistCleanup.accountId, accountId), eq(publicPlaylistCleanup.playlistId, playlistId)))
      .get();
    if (existing) return existing.id;

    const auth = tx.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, userId)).get();
    const isAuthActive = auth && auth.status === "active" && auth.accountId === accountId;
    const isPaused = isAuthActive ? this.scheduler.paused(accountId) : false;

    let status: typeof publicPlaylistCleanup.$inferSelect["status"] = "waitingAuthorization";
    let lastErrorCode: string | null = null;
    if (!isAuthActive) {
      status = "waitingAuthorization";
      lastErrorCode = "AUTH_UNAVAILABLE";
    } else if (isPaused) {
      status = "needsAdministrator";
      lastErrorCode = "ACCOUNT_PAUSED";
    } else {
      status = "ready";
    }

    const id = v7();
    tx.insert(publicPlaylistCleanup).values({
      id,
      userId,
      accountId,
      playlistId,
      creationOperationId: creationOperationId ?? null,
      hasSent: false,
      checkFact: null,
      checkRound: 0,
      status,
      lastErrorCode,
      version: 1,
      createdAt: this.now(),
      updatedAt: this.now()
    }).run();
    return id;
  }

  terminateRoomInTx(tx: any, roomId: string, ownerUserId: string): { cleanupId: string | null } {
    let target: { accountId: string; playlistId: string; creationOperationId: string } | null = null;
    const binding = tx.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (binding) {
      target = {
        accountId: binding.accountId,
        playlistId: binding.playlistId,
        creationOperationId: binding.creationOperationId
      };
    }

    const ops = tx.select().from(operation).where(eq(operation.roomId, roomId)).all();
    for (const op of ops) {
      tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, op.userId), eq(commandReceipt.resourceId, op.id))).run();

      if (["succeeded", "failed", "stopped"].includes(op.status)) {
        if (op.kind === "createPublicPlaylist") {
          tx.delete(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, op.id)).run();
        } else if (op.kind === "requestPublicSong") {
          tx.delete(publicSongRequest).where(eq(publicSongRequest.operationId, op.id)).run();
        }
        tx.delete(operation).where(eq(operation.id, op.id)).run();
      } else if (op.kind === "createPublicPlaylist") {
        const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, op.id)).get();
        if (!detail || ["ready", "verified"].includes(detail.step)) {
          if (detail) tx.delete(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, op.id)).run();
          tx.delete(operation).where(eq(operation.id, op.id)).run();
        } else if (detail.playlistId) {
          if (!target) {
            target = {
              accountId: op.accountId!,
              playlistId: detail.playlistId,
              creationOperationId: op.id
            };
          }
          tx.update(operation).set({
            status: "stopped",
            accountId: null,
            authorizationId: null,
            generation: null,
            updatedAt: this.now()
          }).where(eq(operation.id, op.id)).run();
        } else {
          tx.update(operation).set({ status: "needsAdministrator", updatedAt: this.now() }).where(eq(operation.id, op.id)).run();
        }
      } else if (op.kind === "requestPublicSong") {
        const detail = tx.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, op.id)).get();
        if (!detail || ["ready", "verified"].includes(detail.step)) {
          if (detail) tx.delete(publicSongRequest).where(eq(publicSongRequest.operationId, op.id)).run();
          tx.delete(operation).where(eq(operation.id, op.id)).run();
        } else {
          const anonymousId = v7();
          tx.update(operation).set({
            userId: anonymousId,
            updatedAt: this.now()
          }).where(eq(operation.id, op.id)).run();
        }
      }
    }

    let cleanupId: string | null = null;
    if (target) {
      cleanupId = this.#ensureCleanupInTx(tx, ownerUserId, target.accountId, target.playlistId, target.creationOperationId);

      const otherRoomUsingPlaylist = tx.select({ roomId: publicPlaylistBinding.roomId }).from(publicPlaylistBinding)
        .where(and(eq(publicPlaylistBinding.playlistId, target.playlistId), ne(publicPlaylistBinding.roomId, roomId))).get();
      if (!otherRoomUsingPlaylist) {
        tx.delete(playlistTrack).where(eq(playlistTrack.playlistId, target.playlistId)).run();
        tx.delete(playlistSnapshot).where(eq(playlistSnapshot.playlistId, target.playlistId)).run();
      }
    }

    tx.delete(requesterTag).where(eq(requesterTag.roomId, roomId)).run();
    tx.delete(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).run();
    tx.delete(retiredPublicPlaylistBinding).where(eq(retiredPublicPlaylistBinding.roomId, roomId)).run();

    return { cleanupId };
  }

  #handleCleanupTaskError(cleanupId: string, row: typeof publicPlaylistCleanup.$inferSelect, err: unknown): void {
    const code = err instanceof BusinessError ? err.code : "MODULE_ERROR";
    const status = code === "ACCOUNT_PAUSED" ? "needsAdministrator" : row.status;
    const finalVersion = row.version + 1;
    this.database.update(publicPlaylistCleanup).set({
      status,
      lastErrorCode: code,
      version: finalVersion,
      updatedAt: this.now()
    }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
    this.eventStream.notifyUser(row.userId, { type: "cleanup", resourceId: cleanupId, version: finalVersion });
  }

  async #callNeteaseInScheduler<T extends AdapterInput>(
    accountId: string,
    input: T
  ): Promise<AdapterResult<T["operation"]>> {
    return await this.scheduler.executeMemoryTask(accountId, async (): Promise<AdapterResult<T["operation"]>> => {
      return await this.adapter.call(input);
    });
  }

  dispatchCleanup(cleanupId: string): void {
    const row = this.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get();
    if (!row || row.status !== "ready" || row.hasSent) return;

    try {
      void this.scheduler.executeMemoryTask(row.accountId, async () => {
        // 调度唤醒时重新核验，防止并发重复
        const current = this.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get();
        if (!current || current.status !== "ready" || current.hasSent) return;

        // 调度唤醒时重新核验授权有效性
        const currentAuth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.userId)).get();
        if (!currentAuth || currentAuth.status !== "active" || !currentAuth.credentials || currentAuth.accountId !== current.accountId) {
          const v = current.version + 1;
          this.database.update(publicPlaylistCleanup).set({
            status: "waitingAuthorization",
            lastErrorCode: "AUTH_UNAVAILABLE",
            version: v,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
          this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
          return;
        }

        let cookie: string;
        try {
          cookie = this.vault.decrypt(currentAuth.credentials, {
            authorizationId: currentAuth.id,
            accountId: currentAuth.accountId,
            generation: currentAuth.generation
          });
        } catch {
          const v = current.version + 1;
          this.database.update(publicPlaylistCleanup).set({
            status: "waitingAuthorization",
            lastErrorCode: "AUTH_UNAVAILABLE",
            version: v,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
          this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
          return;
        }

        // 请求发出前持久记录发送意图，进入发送中后视为可能已发
        const sendingVersion = current.version + 1;
        this.database.update(publicPlaylistCleanup).set({
          status: "sending",
          hasSent: true,
          version: sendingVersion,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: sendingVersion });

        let shouldCheck = false;
        try {
          const res = await this.adapter.call({
            operation: "playlistDelete",
            cookie,
            playlistId: current.playlistId
          });

          const finalVersion = sendingVersion + 1;
          if (res.ok) {
            // 明确业务成功，直接完成清理，不强制等待详情变为 404
            this.database.update(publicPlaylistCleanup).set({
              status: "succeeded",
              lastErrorCode: null,
              checkFact: "deleted_confirmed",
              version: finalVersion,
              updatedAt: this.now()
            }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
            this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: finalVersion });
          } else {
            if (res.error.code === "RATE_LIMITED") {
              this.scheduler.pause(current.accountId);
              this.database.update(publicPlaylistCleanup).set({
                status: "needsAdministrator",
                lastErrorCode: "ACCOUNT_PAUSED",
                checkFact: "rate_limited",
                version: finalVersion,
                updatedAt: this.now()
              }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
              this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: finalVersion });
            } else if (res.error.code === "TARGET_PERMISSION") {
              // 上游明确拒绝：保持 needsAdministrator，房主看到官方客户端处理指引，普通用户无核验入口
              this.database.update(publicPlaylistCleanup).set({
                status: "needsAdministrator",
                lastErrorCode: "TARGET_PERMISSION",
                checkFact: "upstream_rejected",
                version: finalVersion,
                updatedAt: this.now()
              }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
              this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: finalVersion });
            } else if (authorizationErrors.has(res.error.code)) {
              this.database.update(publicPlaylistCleanup).set({
                status: "waitingAuthorization",
                lastErrorCode: res.error.code,
                version: finalVersion,
                updatedAt: this.now()
              }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
              this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: finalVersion });
            } else {
              // 未知结果（超时、进程退出、网络错误、502 等）：进入 awaitingConfirmation
              this.database.update(publicPlaylistCleanup).set({
                status: "awaitingConfirmation",
                lastErrorCode: res.error.code,
                checkFact: "unknown_delete_result",
                version: finalVersion,
                updatedAt: this.now()
              }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
              this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: finalVersion });
              shouldCheck = true;
            }
          }
        } catch {
          const finalVersion = sendingVersion + 1;
          this.database.update(publicPlaylistCleanup).set({
            status: "awaitingConfirmation",
            lastErrorCode: "MODULE_ERROR",
            checkFact: "unknown_delete_result",
            version: finalVersion,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
          this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: finalVersion });
          shouldCheck = true;
        }

        if (shouldCheck) {
          this.checkCleanupStatus(cleanupId);
        }
      }).catch(err => {
        this.#handleCleanupTaskError(cleanupId, row, err);
      });
    } catch (err) {
      this.#handleCleanupTaskError(cleanupId, row, err);
    }
  }

  checkCleanupStatus(cleanupId: string): void {
    const row = this.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get();
    if (!row || row.status !== "awaitingConfirmation") return;

    void (async () => {
      const current = this.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get();
      if (!current || current.status !== "awaitingConfirmation") return;

      const currentAuth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.userId)).get();
      if (!currentAuth || currentAuth.status !== "active" || !currentAuth.credentials || currentAuth.accountId !== current.accountId) {
        const v = current.version + 1;
        this.database.update(publicPlaylistCleanup).set({
          status: "waitingAuthorization",
          lastErrorCode: "AUTH_UNAVAILABLE",
          version: v,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      let cookie: string;
      try {
        cookie = this.vault.decrypt(currentAuth.credentials, {
          authorizationId: currentAuth.id,
          accountId: currentAuth.accountId,
          generation: currentAuth.generation
        });
      } catch {
        const v = current.version + 1;
        this.database.update(publicPlaylistCleanup).set({
          status: "waitingAuthorization",
          lastErrorCode: "AUTH_UNAVAILABLE",
          version: v,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      const nextRound = current.checkRound + 1;

      // 1. 真实账号身份核验（独立调度上游，服从 1 秒间隔）
      let idRes: AdapterResult<"identity">;
      try {
        idRes = await this.#callNeteaseInScheduler(current.accountId, { operation: "identity", cookie });
      } catch (err) {
        this.#handleCleanupTaskError(cleanupId, current, err);
        return;
      }

      if (!idRes.ok) {
        const v = current.version + 1;
        if (idRes.error.code === "RATE_LIMITED") {
          this.scheduler.pause(current.accountId);
          this.database.update(publicPlaylistCleanup).set({
            status: "needsAdministrator",
            lastErrorCode: "ACCOUNT_PAUSED",
            checkFact: "rate_limited",
            version: v,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        } else if (authorizationErrors.has(idRes.error.code)) {
          this.database.update(publicPlaylistCleanup).set({
            status: "waitingAuthorization",
            lastErrorCode: idRes.error.code,
            version: v,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        } else {
          this.database.update(publicPlaylistCleanup).set({
            checkRound: nextRound,
            checkFact: "identity_check_failed",
            lastErrorCode: idRes.error.code,
            version: v,
            updatedAt: this.now()
          }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        }
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      if (idRes.data.accountId !== current.accountId) {
        const v = current.version + 1;
        this.database.update(publicPlaylistCleanup).set({
          status: "waitingAuthorization",
          lastErrorCode: "ACCOUNT_MISMATCH",
          checkFact: "account_mismatch",
          version: v,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      // 2. 完整歌单清单核查（每页独立调度上游，服从 1 秒间隔）
      const allPlaylists: Array<{ id: string; name: string; status?: number }> = [];
      let offset = 0;
      let playlistsOk = false;
      let playlistsErrorCode: string | null = null;
      let pages = 0;
      while (true) {
        if (++pages > 50) {
          playlistsErrorCode = "INCOMPLETE_PLAYLISTS";
          break;
        }
        let plRes: AdapterResult<"userPlaylists">;
        try {
          plRes = await this.#callNeteaseInScheduler(current.accountId, {
            operation: "userPlaylists",
            cookie,
            accountId: current.accountId,
            offset,
            limit: 100
          });
        } catch (err) {
          this.#handleCleanupTaskError(cleanupId, current, err);
          return;
        }

        if (!plRes.ok) {
          if (plRes.error.code === "RATE_LIMITED") {
            this.scheduler.pause(current.accountId);
            const v = current.version + 1;
            this.database.update(publicPlaylistCleanup).set({
              status: "needsAdministrator",
              lastErrorCode: "ACCOUNT_PAUSED",
              checkFact: "rate_limited",
              version: v,
              updatedAt: this.now()
            }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
            this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
            return;
          }
          playlistsErrorCode = plRes.error.code;
          break;
        }

        for (const p of plRes.data.playlists) {
          allPlaylists.push(p);
        }

        if (!plRes.data.more) {
          playlistsOk = true;
          break;
        }
        if (plRes.data.playlists.length === 0) {
          playlistsErrorCode = "INCOMPLETE_PLAYLISTS";
          break;
        }
        offset += plRes.data.playlists.length;
      }

      if (!playlistsOk) {
        const v = current.version + 1;
        this.database.update(publicPlaylistCleanup).set({
          checkRound: nextRound,
          checkFact: "playlists_fetch_failed",
          lastErrorCode: playlistsErrorCode ?? "MODULE_ERROR",
          version: v,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      const inPlaylists = allPlaylists.some(p => p.id === current.playlistId);

      // 3. 目标详情核查（独立调度上游，服从 1 秒间隔）
      let detailRes: AdapterResult<"playlistDetail">;
      try {
        detailRes = await this.#callNeteaseInScheduler(current.accountId, {
          operation: "playlistDetail",
          cookie,
          playlistId: current.playlistId
        });
      } catch (err) {
        this.#handleCleanupTaskError(cleanupId, current, err);
        return;
      }

      const v = current.version + 1;

      if (!detailRes.ok && detailRes.error.code === "RATE_LIMITED") {
        this.scheduler.pause(current.accountId);
        this.database.update(publicPlaylistCleanup).set({
          status: "needsAdministrator",
          lastErrorCode: "ACCOUNT_PAUSED",
          checkFact: "rate_limited",
          version: v,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      // 判定已删除：清单无此目标，且详情返回 404 或返回墓碑状态 status=10（CONSTRAINTS #274）
      const is404 = !detailRes.ok && (detailRes.error.businessCode === 404 || detailRes.error.httpStatus === 404);
      const isTombstone = detailRes.ok && detailRes.data.playlist.status === 10;

      if (!inPlaylists && (is404 || isTombstone)) {
        this.database.update(publicPlaylistCleanup).set({
          status: "succeeded",
          lastErrorCode: null,
          checkFact: is404 ? "not_found_confirmed" : "tombstone_confirmed_deleted",
          checkRound: nextRound,
          version: v,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      // 判定目标仍存活：清单中仍有该歌单，或者详情为正常有效歌单 status=0
      const isNormalLiving = detailRes.ok && detailRes.data.playlist.status === 0;
      if (inPlaylists || isNormalLiving) {
        this.database.update(publicPlaylistCleanup).set({
          checkFact: "target_still_active",
          lastErrorCode: "TARGET_STILL_ACTIVE",
          checkRound: nextRound,
          version: v,
          updatedAt: this.now()
        }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
        this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
        return;
      }

      // 其余情况（如详情 502 读取失败、清单有但详情返回墓碑等矛盾证据）：证据不足，停止自动试探
      this.database.update(publicPlaylistCleanup).set({
        checkFact: "insufficient_evidence",
        lastErrorCode: detailRes.ok ? "CONFLICTING_EVIDENCE" : detailRes.error.code,
        checkRound: nextRound,
        version: v,
        updatedAt: this.now()
      }).where(eq(publicPlaylistCleanup.id, cleanupId)).run();
      this.eventStream.notifyUser(current.userId, { type: "cleanup", resourceId: cleanupId, version: v });
    })().catch(err => {
      this.#handleCleanupTaskError(cleanupId, row, err);
    });
  }
}
