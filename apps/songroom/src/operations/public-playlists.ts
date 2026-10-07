import { v7 } from "uuid";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt, neteaseAuthorization, operation, playlistSnapshot, playlistTrack, publicPlaylistBinding, publicPlaylistCreation, publicSongRequest, requesterTag, room, roomMembership } from "../db/schema.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterErrorCode, NeteaseAdapter } from "../netease/protocol.js";
import { BusinessError } from "../shared/errors.js";
import { publicPlaylistCreateCommand, type PublicPlaylistCreateCommand, type PublicPlaylistView, publicSongRequestCommand, type PublicSongRequestCommand, type SongRequestOperationView } from "../shared/public-playlist-contracts.js";
import { EventStreamService } from "../events/event-stream.js";

type Operation = typeof operation.$inferSelect;
type Status = Operation["status"];
const TERMINAL_RETENTION_MS = 86_400_000;
const terminal = (status: Status) => ["succeeded", "failed", "stopped"].includes(status);
const authorizationErrors = new Set(["AUTH_UNAVAILABLE", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH"]);

/** 只接受公共歌单创建与点歌意图。start 必须在 HTTP 成功监听后调用；事务始终同步。 */
export class PublicPlaylists {
  readonly #inFlightRefreshes = new Map<string, Promise<void>>();

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
      } else {
        disabledReason = "PUBLIC_PLAYLIST_EXISTS";
      }
    } else if (pending) {
      disabledReason = currentOperation?.errorCode === "TARGET_PERMISSION" ? "TARGET_BLOCKED" : "OPERATION_PENDING";
    } else if (!this.#authorization(userId)) {
      disabledReason = "NETEASE_AUTH_REQUIRED";
    } else {
      disabledReason = this.scheduler.admissionCode(this.#authorization(userId)!.accountId);
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
        allowedActions.push("requestSong");
      }
    }

    return {
      playlist: binding ? { id: binding.playlistId, name: binding.name } : null,
      snapshot,
      lastRefreshError,
      operation: currentOperation ? { id: currentOperation.id, status: currentOperation.status, errorCode: currentOperation.errorCode } : null,
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
    this.database.transaction(tx => {
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
      for (const b of bindings) {
        this.#bump(b.roomId);
      }
    });
  }

  async #executeRefresh(ownerUserId: string, accountId: string, playlistId: string, generation: number): Promise<void> {
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, ownerUserId)).get();
    if (!auth || auth.accountId !== accountId || auth.generation !== generation) {
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
      this.#recordRefreshError(accountId, playlistId, result.error.code);
      return;
    }

    const data = result.data as { playlist: { id: string; name: string; status: number }; songIds: string[]; songs: Array<{ id: string; name: string; artists: string[]; album: string }> };
    this.#commitSnapshot(accountId, playlistId, generation, data, readStartedAt);
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

    const affectedRoomIds = this.database.transaction(tx => {
      const currentBindings = tx.select().from(publicPlaylistBinding)
        .where(and(eq(publicPlaylistBinding.accountId, accountId), eq(publicPlaylistBinding.playlistId, playlistId))).all();
      if (!currentBindings.length) return [];
      const hasMatchingGen = currentBindings.some(b => b.generation === generation);
      if (!hasMatchingGen) return [];

      const currentSnapshot = tx.select().from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).get();

      if (currentSnapshot?.syncedAt && currentSnapshot.syncedAt > readStartedAt) {
        // 较新的读取已提交，不被旧读取覆盖
        return [];
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
      return currentBindings.map(b => b.roomId);
    });

    for (const rid of affectedRoomIds) {
      this.eventStream.notifyRoom(this.database, rid, { type: "publicPlaylist", roomId: rid });
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
      if (!auth) throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请先完成网易云授权");
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
    return accepted;
  }

  #bump(roomId: string): void {
    this.database.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
  }

  #status(id: string, status: Status, errorCode: Operation["errorCode"] = null): void {
    this.database.transaction(tx => {
      const row = tx.select().from(operation).where(eq(operation.id, id)).get();
      if (!row || (row.status === status && row.errorCode === errorCode)) return;
      tx.update(operation).set({ status, errorCode, updatedAt: this.now(), ...(terminal(status) ? { accountId: null, authorizationId: null, generation: null } : {}) }).where(eq(operation.id, id)).run();
      if (terminal(status)) tx.delete(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, id)).run();
      else if (status === "awaitingConfirmation") tx.update(publicPlaylistCreation).set({ step: "unknown" }).where(eq(publicPlaylistCreation.operationId, id)).run();
      this.#bump(row.roomId);
    });
  }

  #prune(): void {
    this.database.delete(operation).where(sql`${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${this.now() - TERMINAL_RETENTION_MS}`).run();
    this.database.delete(commandReceipt).where(sql`${commandReceipt.expiresAt} <= ${this.now()}`).run();
  }

  start(): void { this.scheduler.start(); }
  stop(): void { this.scheduler.stop(); }
  settle(): Promise<void> { return this.scheduler.settle(); }

  #recover(): void {
    this.#prune();
    for (const row of this.database.select().from(operation).where(eq(operation.kind, "createPublicPlaylist")).all()) {
      if (terminal(row.status)) continue;
      const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
      if (!detail) { this.#status(row.id, "needsAdministrator"); continue; }
      if (["sending", "unknown"].includes(detail.step)) this.#status(row.id, "awaitingConfirmation", row.errorCode);
      else if (row.status !== "waitingAuthorization" && (detail.step === "confirming" || row.status === "processing")) this.#status(row.id, "queued", row.errorCode);
      if (detail.step === "verified") this.database.update(publicPlaylistCreation).set({ step: "ready" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
    }
  }

  #claim(row: Operation): boolean {
    const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
    if (!detail) { this.#status(row.id, "needsAdministrator"); return false; }
    if (detail.step === "confirming") {
      try { this.#bind(row); } catch { this.#status(row.id, "needsAdministrator"); }
      return false;
    }
    if (["sending", "unknown"].includes(detail.step)) { this.#status(row.id, "awaitingConfirmation", row.errorCode); return false; }
    const condition = this.#conditions(row);
    if (condition !== "valid") { this.#conditionStatus(row, condition); return false; }
    const auth = this.#authorization(row.userId)!;
    try {
      this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return false;
    }
    if (detail.step === "verified") {
      this.database.update(publicPlaylistCreation).set({ step: "sending" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
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
    if (!auth || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation) return "waitingAuthorization";
    return "valid";
  }

  #bind(row: Operation): void {
    // 创建 ID 已在独立提交中保存；关联失败不会抹掉上游资源证据。
    this.database.transaction(tx => {
      const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get()!;
      const condition = this.#conditions(row);
      if (condition !== "valid") {
        this.#conditionStatus(row, condition, true);
        return;
      }
      tx.insert(publicPlaylistBinding).values({ roomId: row.roomId, accountId: row.accountId!, playlistId: detail.playlistId!, name: detail.name, creationOperationId: row.id }).run();
      tx.insert(playlistSnapshot).values({
        accountId: row.accountId!,
        playlistId: detail.playlistId!,
        snapshotVersion: 0,
        syncedAt: null,
        lastErrorCode: null,
        createdAt: this.now(),
        updatedAt: this.now()
      }).onConflictDoNothing().run();
      this.#status(row.id, "succeeded");
    });
  }

  #readFailure(row: Operation, code: AdapterErrorCode): void {
    if (code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
    this.#status(row.id, authorizationErrors.has(code) ? "waitingAuthorization" : ["RATE_LIMITED", "TARGET_PERMISSION"].includes(code) ? "needsAdministrator" : "failed", code);
  }

  async #execute(row: Operation): Promise<void> {
    const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get()!;
    const auth = this.#authorization(row.userId)!;
    const cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    try {
      if (detail.step === "ready") {
        const identity = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId! });
        this.database.transaction(tx => {
          if (!identity.ok) { this.#readFailure(row, identity.error.code); return; }
          if (identity.data.accountId !== row.accountId) { this.#status(row.id, "waitingAuthorization", "ACCOUNT_MISMATCH"); return; }
          const condition = this.#conditions(row);
          if (condition !== "valid") { this.#conditionStatus(row, condition); return; }
          tx.update(publicPlaylistCreation).set({ step: "verified" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "queued");
        });
        return;
      }
      const result = await this.adapter.call({ operation: "playlistCreate", cookie, name: detail.name });
      this.database.transaction(tx => {
        if (!result.ok) {
          if (result.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
          this.#status(row.id, "awaitingConfirmation", result.error.code);
          return;
        }
        tx.update(publicPlaylistCreation).set({ step: "confirming", playlistId: result.data.playlistId }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
        this.#bump(row.roomId);
      });
      if (result.ok) this.#bind(row);
    } catch {
      const saved = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
      this.#status(row.id, saved?.step === "confirming" ? "needsAdministrator" : saved?.step === "sending" ? "awaitingConfirmation" : "failed", "MODULE_ERROR");
    }
  }

  readOperation(userId: string, roomId: string, operationId: string): SongRequestOperationView {
    this.#member(userId, roomId);
    const row = this.database.select().from(operation)
      .where(and(eq(operation.id, operationId), eq(operation.roomId, roomId), eq(operation.kind, "requestPublicSong"))).get();
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
      step: detail.step
    };
  }

  requestSong(userId: string, roomId: string, input: PublicSongRequestCommand): { replay: boolean; operation: SongRequestOperationView } {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const command = publicSongRequestCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "requestPublicSong", { roomId, songId: command.songId }, this.now());

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
          tagConfirmed: true
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
        generation: binding.generation,
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
        tagConfirmed: false
      }).run();

      recordCommandResource(tx, prepared, id, this.now());
      this.#bump(roomId);
      return { replay: false, opId: id, existing: false };
    });

    if (!accepted.replay && !accepted.existing) {
      this.scheduler.kick();
    }
    this.eventStream.notifyRoom(this.database, roomId, { type: "publicPlaylist", roomId });

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
    if (!auth) {
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

  #commitTagOnly(row: Operation, detail: typeof publicSongRequest.$inferSelect): void {
    this.database.transaction(tx => {
      const member = tx.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
      const binding = tx.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get();
      if (!member || !binding) {
        tx.update(operation).set({ status: "stopped", updatedAt: this.now() }).where(eq(operation.id, row.id)).run();
        this.#bump(row.roomId);
        return;
      }
      tx.insert(requesterTag).values({
        roomId: row.roomId,
        bindingGeneration: binding.generation,
        songId: detail.songId,
        memberId: member.id,
        createdAt: this.now()
      }).onConflictDoNothing().run();

      tx.update(publicSongRequest).set({ step: "succeeded", tagConfirmed: true }).where(eq(publicSongRequest.operationId, row.id)).run();
      tx.update(operation).set({ status: "succeeded", errorCode: null, updatedAt: this.now(), accountId: null, authorizationId: null, generation: null }).where(eq(operation.id, row.id)).run();
      this.#bump(row.roomId);
    });
    this.eventStream.notifyRoom(this.database, row.roomId, { type: "publicPlaylist", roomId: row.roomId });
  }

  #conditionsForSongRequest(row: Operation): "valid" | "stopped" | "waitingAuthorization" {
    const current = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get();
    if (!current || !member || !binding) return "stopped";
    const auth = this.#authorization(current.ownerUserId);
    if (!auth || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation) return "waitingAuthorization";
    return "valid";
  }

  #recoverSongRequests(): void {
    for (const row of this.database.select().from(operation).where(eq(operation.kind, "requestPublicSong")).all()) {
      if (terminal(row.status)) continue;
      const detail = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get();
      if (!detail) { this.#status(row.id, "needsAdministrator"); continue; }
      if (detail.songConfirmed && !detail.tagConfirmed) {
        this.#commitTagOnly(row, detail);
        continue;
      }
      if (["sending", "unknown"].includes(detail.step)) {
        this.#status(row.id, "awaitingConfirmation", row.errorCode);
      } else if (row.status !== "waitingAuthorization" && (detail.step === "confirming" || row.status === "processing")) {
        this.#status(row.id, "queued", row.errorCode);
      }
      if (detail.step === "verified") {
        this.database.update(publicSongRequest).set({ step: "ready" }).where(eq(publicSongRequest.operationId, row.id)).run();
      }
    }
  }

  async #executeSongRequest(row: Operation): Promise<void> {
    const detail = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get()!;
    const currentRoom = this.database.select().from(room).where(eq(room.id, row.roomId)).get()!;
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get()!;
    const auth = this.#authorization(currentRoom.ownerUserId)!;
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
        const addResult = await this.adapter.call({ operation: "trackAdd", cookie, playlistId: binding.playlistId, songId: detail.songId });
        if (!addResult.ok) {
          if (addResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
          this.database.transaction(tx => {
            if (addResult.error.outcome === "unknown") {
              tx.update(publicSongRequest).set({ step: "unknown" }).where(eq(publicSongRequest.operationId, row.id)).run();
              this.#status(row.id, "awaitingConfirmation", addResult.error.code);
            } else {
              tx.update(publicSongRequest).set({ step: "rejected" }).where(eq(publicSongRequest.operationId, row.id)).run();
              this.#readFailure(row, addResult.error.code);
            }
          });
          return;
        }

        this.database.transaction(tx => {
          tx.update(publicSongRequest).set({ step: "confirming" }).where(eq(publicSongRequest.operationId, row.id)).run();
          this.#status(row.id, "queued");
        });
        return;
      }

      if (detail.step === "confirming") {
        const readStartedAt = this.now();
        const detailResult = await this.adapter.call({ operation: "playlistDetail", cookie, playlistId: binding.playlistId });
        if (!detailResult.ok) {
          if (detailResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
          this.#recordRefreshError(binding.accountId, binding.playlistId, detailResult.error.code);
          this.#status(row.id, "awaitingConfirmation", detailResult.error.code);
          return;
        }

        const data = detailResult.data;
        // 严格遵循 CONSTRAINTS #274：专用歌单删除实验中 status=10 且带旧歌曲，正常歌单 status=0
        if (data.playlist.status !== 0 || data.songIds.length !== data.songs.length) {
          this.#recordRefreshError(binding.accountId, binding.playlistId, "PARSE_ERROR");
          this.#status(row.id, "awaitingConfirmation", "PARSE_ERROR");
          return;
        }

        // 调用统一的快照提交，严格以事务递增单调版本并清理已移除歌曲标签
        this.#commitSnapshot(binding.accountId, binding.playlistId, binding.generation, data, readStartedAt);

        const existsInSnapshot = data.songIds.includes(detail.songId);
        if (existsInSnapshot) {
          const now = this.now();
          this.database.transaction(tx => {
            tx.update(publicSongRequest).set({ songConfirmed: true, step: "tagging" }).where(eq(publicSongRequest.operationId, row.id)).run();

            const member = tx.select().from(roomMembership).where(and(eq(roomMembership.roomId, row.roomId), eq(roomMembership.userId, row.userId))).get();
            if (member) {
              tx.insert(requesterTag).values({
                roomId: row.roomId,
                bindingGeneration: binding.generation,
                songId: detail.songId,
                memberId: member.id,
                createdAt: now
              }).onConflictDoNothing().run();
            }
            tx.update(publicSongRequest).set({ tagConfirmed: true, step: "succeeded" }).where(eq(publicSongRequest.operationId, row.id)).run();
            this.#status(row.id, "succeeded");
            this.#bump(row.roomId);
          });
        } else {
          this.database.transaction(tx => {
            tx.update(publicSongRequest).set({ step: "unknown" }).where(eq(publicSongRequest.operationId, row.id)).run();
            this.#status(row.id, "awaitingConfirmation");
            this.#bump(row.roomId);
          });
        }

        this.eventStream.notifyRoom(this.database, row.roomId, { type: "publicPlaylist", roomId: row.roomId });
      }
    } catch {
      const saved = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, row.id)).get();
      this.#status(row.id, saved?.step === "confirming" ? "awaitingConfirmation" : saved?.step === "sending" ? "awaitingConfirmation" : "failed", "MODULE_ERROR");
    }
  }
}
