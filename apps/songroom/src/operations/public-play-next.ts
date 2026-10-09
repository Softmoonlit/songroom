import { v7 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt, neteaseAuthorization, operation, playlistSnapshot, playlistTrack, publicPlayNext, publicPlaylistBinding, publicSongRequest, room, roomMembership } from "../db/schema.js";
import type { CredentialVault } from "../netease/credentials.js";
import type { AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import { BusinessError } from "../shared/errors.js";
import { playNextCommand, type PlayNextCommand, type PlayNextOperationView, type PlayNextResponse } from "../shared/public-playlist-contracts.js";
import type { EventStreamService } from "../events/event-stream.js";
import type { UpstreamScheduler, Operation } from "./upstream-scheduling.js";

type Detail = typeof publicPlayNext.$inferSelect;
type Authorization = typeof neteaseAuthorization.$inferSelect;
type SnapshotData = Extract<AdapterResult<"playlistDetail">, { ok: true }>["data"];
const isTerminalOperation = (row: Operation) => ["succeeded", "failed", "stopped"].includes(row.status);
const hasPassedWriteBoundary = (detail: Detail) => ["sending", "confirming", "unknown"].includes(detail.step);
const sameTrackOrder = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index]);
const CONFIRMATION_DELAYS_MS = [5_000, 30_000, 120_000];

/** A closed move-after-anchor intent. Each claimed step performs at most one upstream request. */
export class PublicPlayNext {
  readonly #timers = new Map<string, NodeJS.Timeout>();
  constructor(
    readonly database: AppDatabase,
    readonly adapter: NeteaseAdapter,
    readonly vault: CredentialVault,
    readonly scheduler: UpstreamScheduler,
    readonly events: EventStreamService,
    readonly now: () => number,
    readonly beginRead: () => number,
    readonly commitSnapshot: (row: Operation, detail: Detail, data: SnapshotData, readStartedAt: number) => boolean
  ) {
    scheduler.register("playNext", {
      claim: row => this.#claim(row),
      execute: row => this.#execute(row),
      recover: () => this.#recover()
    });
  }

  #member(userId: string, roomId: string) {
    const currentRoom = this.database.select().from(room).where(eq(room.id, roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();
    if (!currentRoom || !member) throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    return { currentRoom, member };
  }

  read(userId: string, roomId: string, id: string): PlayNextOperationView {
    this.#member(userId, roomId);
    const row = this.database.select().from(operation).where(and(eq(operation.id, id), eq(operation.roomId, roomId), eq(operation.userId, userId), eq(operation.kind, "playNext"))).get();
    const detail = this.database.select().from(publicPlayNext).where(eq(publicPlayNext.operationId, id)).get();
    if (!row || !detail || (isTerminalOperation(row) && row.updatedAt <= this.now() - 86_400_000)) throw new BusinessError(404, "OPERATION_UNAVAILABLE", "操作不存在或已过期");
    return { id, roomId, songId: detail.songId, anchorSongId: detail.anchorSongId, status: row.status, step: detail.step, errorCode: row.errorCode, version: row.version };
  }

  hasTargetLock(accountId: string, playlistId: string): boolean {
    return !!this.database.select({ id: operation.id }).from(operation).innerJoin(publicPlayNext, eq(publicPlayNext.operationId, operation.id)).where(and(
      eq(operation.accountId, accountId), eq(publicPlayNext.playlistId, playlistId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
    )).get();
  }

  accept(userId: string, roomId: string, input: PlayNextCommand): PlayNextResponse {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const command = playNextCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "playNext", { roomId, songId: command.songId, anchorSongId: command.anchorSongId, snapshotVersion: command.snapshotVersion }, this.now());
    const accepted = this.database.transaction(tx => {
      const { currentRoom, member } = this.#member(userId, roomId);
      const original = readCommandResource(tx, prepared, this.now());
      if (original) return { replay: true, id: original };
      tx.delete(operation).where(sql`${operation.kind} = 'playNext' AND ${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${this.now() - 86_400_000}`).run();
      const binding = tx.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
      if (!binding) throw new BusinessError(409, "PUBLIC_PLAYLIST_NOT_FOUND", "房间尚未绑定公共歌单");
      const auth = tx.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, currentRoom.ownerUserId)).get();
      if (!auth || auth.status !== "active" || !auth.credentials || auth.accountId !== binding.accountId) throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请房主先完成网易云授权");
      const admission = this.scheduler.admissionCode(auth.accountId);
      if (admission) throw new BusinessError(409, admission, "网易云账号暂时不可执行操作");
      const pendingMember = tx.select().from(operation).where(and(eq(operation.roomId, roomId), eq(operation.userId, userId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
      if (pendingMember) throw new BusinessError(409, "CONCURRENT_OPERATION_LIMIT_EXCEEDED", "你在该房间已有未完成的写操作");
      const pendingSongs = tx.select({ id: operation.id }).from(operation).innerJoin(publicSongRequest, eq(publicSongRequest.operationId, operation.id)).where(and(eq(operation.accountId, binding.accountId), eq(publicSongRequest.playlistId, binding.playlistId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
      const snapshot = tx.select().from(playlistSnapshot).where(and(eq(playlistSnapshot.accountId, binding.accountId), eq(playlistSnapshot.playlistId, binding.playlistId))).get();
      if (pendingSongs || this.hasTargetLock(binding.accountId, binding.playlistId) || snapshot?.lastErrorCode === "TARGET_PERMISSION") throw new BusinessError(409, "TARGET_BLOCKED", "公共歌单有冲突操作待处理");
      if (!snapshot?.syncedAt || snapshot.snapshotVersion !== command.snapshotVersion) throw new BusinessError(409, "PLAYLIST_CONFLICT", "歌单已变化，请同步后重新操作");
      const ids = tx.select().from(playlistTrack).where(and(eq(playlistTrack.accountId, binding.accountId), eq(playlistTrack.playlistId, binding.playlistId))).orderBy(playlistTrack.position).all().map(track => track.songId);
      if (!ids.includes(command.anchorSongId) || !ids.includes(command.songId)) throw new BusinessError(409, "PLAYLIST_CONFLICT", "歌曲或播放锚点已不在歌单中");
      if (command.songId === command.anchorSongId || ids[ids.indexOf(command.anchorSongId) + 1] === command.songId) throw new BusinessError(409, "PLAY_NEXT_NOOP", "当前歌曲或已有下一首无需移动");
      const remaining = ids.filter(id => id !== command.songId);
      remaining.splice(remaining.indexOf(command.anchorSongId) + 1, 0, command.songId);
      const id = v7();
      tx.insert(operation).values({ id, kind: "playNext", userId, roomId, accountId: auth.accountId, authorizationId: auth.id, generation: auth.generation, status: "queued", lastGranted: this.now(), createdAt: this.now(), updatedAt: this.now() }).run();
      tx.insert(publicPlayNext).values({ operationId: id, songId: command.songId, anchorSongId: command.anchorSongId, playlistId: binding.playlistId, bindingGeneration: binding.generation, memberId: member.id, originalSongIds: JSON.stringify(ids), targetSongIds: JSON.stringify(remaining) }).run();
      recordCommandResource(tx, prepared, id, this.now());
      return { replay: false, id };
    });
    if (!accepted.replay) { this.#notify(accepted.id); this.scheduler.kick(); }
    return { replay: accepted.replay, operation: this.read(userId, roomId, accepted.id) };
  }

  #load(id: string) {
    const row = this.database.select().from(operation).where(eq(operation.id, id)).get();
    const detail = this.database.select().from(publicPlayNext).where(eq(publicPlayNext.operationId, id)).get();
    return row && detail ? { row, detail } : null;
  }

  #context(row: Operation, detail: Detail): { auth: Authorization; cookie: string } | null {
    const current = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get();
    if (!current || !binding || binding.accountId !== row.accountId || binding.playlistId !== detail.playlistId || binding.generation !== detail.bindingGeneration) {
      this.#finish(row.id, "stopped"); return null;
    }
    // Detached sent operations may only reconcile the original target, never write again.
    if (detail.memberId && !this.database.select().from(roomMembership).where(and(eq(roomMembership.id, detail.memberId), eq(roomMembership.userId, row.userId), eq(roomMembership.roomId, row.roomId))).get()) {
      if (!hasPassedWriteBoundary(detail)) { this.#finish(row.id, "stopped"); return null; }
      this.database.update(publicPlayNext).set({ memberId: null }).where(eq(publicPlayNext.operationId, row.id)).run();
    }
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.ownerUserId)).get();
    if (!auth || auth.status !== "active" || !auth.credentials || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE"); return null;
    }
    if (this.scheduler.paused(auth.accountId)) { this.#status(row.id, "needsAdministrator", "ACCOUNT_PAUSED"); return null; }
    try {
      return { auth, cookie: this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation }) };
    } catch { this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE"); return null; }
  }

  #stillCurrent(row: Operation, detail: Detail): boolean {
    const latest = this.#load(row.id);
    return !!latest && !isTerminalOperation(latest.row) && latest.row.status === "processing" && latest.row.authorizationId === row.authorizationId && latest.row.generation === row.generation && latest.detail.step === detail.step && !!this.#context(latest.row, latest.detail);
  }

  #claim(row: Operation): boolean {
    const loaded = this.#load(row.id);
    if (!loaded || !this.#context(loaded.row, loaded.detail)) return false;
    if (loaded.detail.step === "unknown") {
      if (loaded.detail.checkRound >= 3) { this.#status(row.id, "awaitingConfirmation", row.errorCode); return false; }
      this.database.update(publicPlayNext).set({ step: "confirming", nextCheckAt: null }).where(eq(publicPlayNext.operationId, row.id)).run();
    }
    return true;
  }

  async #execute(claimed: Operation): Promise<void> {
    const loaded = this.#load(claimed.id);
    if (!loaded) return;
    const { row, detail } = loaded;
    const context = this.#context(row, detail);
    if (!context) return;
    const { cookie } = context;
    try {
      if (detail.step === "ready") {
        const result = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId! });
        if (!this.#stillCurrent(row, detail)) return;
        if (!result.ok) { this.#failure(row, detail, result.error.code); return; }
        if (result.data.accountId !== row.accountId) { this.#status(row.id, "waitingAuthorization", "ACCOUNT_MISMATCH"); return; }
        this.#queue(row.id, "identityVerified");
      } else if (detail.step === "identityVerified") {
        const result = await this.adapter.call({ operation: "recentSong", cookie });
        if (!this.#stillCurrent(row, detail)) return;
        if (!result.ok) { this.#failure(row, detail, result.error.code); return; }
        if (result.data.songId !== detail.anchorSongId) { this.#finish(row.id, "failed", "PLAYBACK_CONFLICT"); return; }
        this.#queue(row.id, "playbackVerified");
      } else if (detail.step === "playbackVerified" || detail.step === "confirming") {
        const readStartedAt = this.beginRead();
        const result = await this.adapter.call({ operation: "playlistDetail", cookie, playlistId: detail.playlistId });
        if (!this.#stillCurrent(row, detail)) return;
        if (!result.ok) { this.#failure(row, detail, result.error.code); return; }
        const data = result.data;
        if (data.playlist.id !== detail.playlistId || data.playlist.status !== 0 || data.songIds.length !== data.songs.length || new Set(data.songIds).size !== data.songIds.length || !this.commitSnapshot(row, detail, data, readStartedAt)) {
          this.#failure(row, detail, "PARSE_ERROR"); return;
        }
        if (detail.step === "playbackVerified") {
          if (!sameTrackOrder(data.songIds, JSON.parse(detail.originalSongIds!))) { this.#finish(row.id, "failed", "PLAYLIST_CONFLICT"); return; }
          this.#queue(row.id, "verified");
        } else {
          if (sameTrackOrder(data.songIds, JSON.parse(detail.targetSongIds!))) this.#finish(row.id, "succeeded");
          else this.#awaitConfirmation(row, detail, null);
        }
      } else if (detail.step === "verified") {
        // The send boundary is persisted immediately before the sole write, never reclaimed for resend.
        this.database.update(publicPlayNext).set({ step: "sending" }).where(eq(publicPlayNext.operationId, row.id)).run();
        const sendingDetail = { ...detail, step: "sending" as const };
        const result = await this.adapter.call({ operation: "trackOrder", cookie, playlistId: detail.playlistId, songIds: JSON.parse(detail.targetSongIds!) as string[] });
        if (!this.#stillCurrent(row, sendingDetail)) return;
        if (!result.ok) {
          if (result.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
          if (result.error.outcome === "failed") { this.#failure(row, sendingDetail, result.error.code, true); return; }
          this.#awaitConfirmation(row, sendingDetail, result.error.code); return;
        }
        this.#queue(row.id, "confirming");
      } else if (detail.step === "sending") {
        this.#awaitConfirmation(row, detail, row.errorCode);
      }
    } catch {
      const latest = this.#load(row.id);
      if (!latest || latest.row.status !== "processing" || latest.row.generation !== row.generation) return;
      this.#failure(latest.row, latest.detail, "MODULE_ERROR");
    }
  }

  #failure(row: Operation, detail: Detail, code: Operation["errorCode"], rejected = false): void {
    if (code === "RATE_LIMITED" || code === "ACCOUNT_PAUSED") {
      this.scheduler.pause(row.accountId!);
      this.#status(row.id, "needsAdministrator", "ACCOUNT_PAUSED"); return;
    }
    if (["AUTH_UNAVAILABLE", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH"].includes(code ?? "")) {
      this.#status(row.id, "waitingAuthorization", code); return;
    }
    if (hasPassedWriteBoundary(detail) && !rejected) this.#awaitConfirmation(row, detail, code);
    else this.#finish(row.id, "failed", code);
  }

  #queue(id: string, step: Detail["step"]): void {
    this.database.transaction(tx => {
      tx.update(publicPlayNext).set({ step }).where(eq(publicPlayNext.operationId, id)).run();
      this.#status(id, "queued");
    });
  }

  #awaitConfirmation(row: Operation, detail: Detail, code: Operation["errorCode"]): void {
    // Initial readback is immediate; only subsequent reads consume the bounded recovery rounds.
    const round = detail.checkRound;
    const nextCheckAt = round < CONFIRMATION_DELAYS_MS.length ? this.now() + CONFIRMATION_DELAYS_MS[round] : null;
    this.database.transaction(tx => {
      tx.update(publicPlayNext).set({ step: "unknown", nextCheckAt }).where(eq(publicPlayNext.operationId, row.id)).run();
      this.#status(row.id, "awaitingConfirmation", code);
    });
    if (nextCheckAt !== null) this.#schedule(row.id, nextCheckAt);
  }

  #notify(id: string): void {
    const row = this.database.select().from(operation).where(eq(operation.id, id)).get();
    if (!row) return;
    this.database.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, row.roomId)).run();
    const currentRoom = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    this.events.notifyRoom(this.database, row.roomId, { type: "operation", resourceId: id, version: row.version });
    if (currentRoom) this.events.notifyRoom(this.database, row.roomId, { type: "room", resourceId: row.roomId, version: currentRoom.version });
  }

  #status(id: string, status: Operation["status"], errorCode: Operation["errorCode"] = null): void {
    this.database.update(operation).set({ status, errorCode, updatedAt: this.now(), version: sql`${operation.version} + 1` }).where(eq(operation.id, id)).run();
    this.#notify(id);
  }

  #finish(id: string, status: "succeeded" | "failed" | "stopped", errorCode: Operation["errorCode"] = null): void {
    this.#clearTimer(id);
    const loaded = this.#load(id);
    if (!loaded) return;
    if (!loaded.detail.memberId) {
      this.database.delete(operation).where(eq(operation.id, id)).run(); return;
    }
    this.database.transaction(tx => {
      tx.update(publicPlayNext).set({ step: status === "failed" ? "rejected" : status, nextCheckAt: null, originalSongIds: null, targetSongIds: null, memberId: null }).where(eq(publicPlayNext.operationId, id)).run();
      tx.update(operation).set({ status, errorCode, accountId: null, authorizationId: null, generation: null, updatedAt: this.now(), version: sql`${operation.version} + 1` }).where(eq(operation.id, id)).run();
    });
    this.#notify(id);
  }

  #clearTimer(id: string): void {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
  }

  #schedule(id: string, dueAt: number): void {
    this.#clearTimer(id);
    const timer = setTimeout(() => { this.#timers.delete(id); this.#due(id); }, Math.max(1, dueAt - this.now()));
    timer.unref();
    this.#timers.set(id, timer);
  }

  #due(id: string): void {
    const loaded = this.#load(id);
    if (!loaded || loaded.row.status !== "awaitingConfirmation" || loaded.detail.checkRound >= 3 || loaded.detail.nextCheckAt === null || loaded.detail.nextCheckAt > this.now()) return;
    this.database.transaction(tx => {
      tx.update(publicPlayNext).set({ nextCheckAt: null, checkRound: loaded.detail.checkRound + 1 }).where(eq(publicPlayNext.operationId, id)).run();
      this.#status(id, "queued", loaded.row.errorCode);
    });
    this.scheduler.kick();
  }

  triggerDueChecks(): void {
    for (const detail of this.database.select().from(publicPlayNext).where(sql`${publicPlayNext.nextCheckAt} <= ${this.now()}`).all()) this.#due(detail.operationId);
  }

  #recover(): void {
    this.database.delete(operation).where(sql`${operation.kind} = 'playNext' AND ${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${this.now() - 86_400_000}`).run();
    for (const row of this.database.select().from(operation).where(eq(operation.kind, "playNext")).all()) {
      if (isTerminalOperation(row) || row.status === "waitingAuthorization" || row.status === "needsAdministrator") continue;
      const loaded = this.#load(row.id);
      if (!loaded) continue;
      if (hasPassedWriteBoundary(loaded.detail)) {
        // Never reset the recovery budget at restart.
        const dueAt = loaded.detail.checkRound < 3 ? loaded.detail.nextCheckAt ?? this.now() + 5_000 : null;
        this.database.update(publicPlayNext).set({ step: "unknown", nextCheckAt: dueAt }).where(eq(publicPlayNext.operationId, row.id)).run();
        this.#status(row.id, "awaitingConfirmation", row.errorCode);
        if (dueAt !== null) this.#schedule(row.id, dueAt);
      } else this.#queue(row.id, "ready");
    }
  }

  onOwnerRevoked(userId: string): void {
    for (const currentRoom of this.database.select().from(room).where(eq(room.ownerUserId, userId)).all()) {
      for (const row of this.database.select().from(operation).where(and(eq(operation.roomId, currentRoom.id), eq(operation.kind, "playNext"))).all()) {
        if (isTerminalOperation(row) || row.status === "needsAdministrator") continue;
        this.#clearTimer(row.id);
        this.database.update(operation).set({ status: "waitingAuthorization", errorCode: "AUTH_UNAVAILABLE", version: sql`${operation.version} + 1`, updatedAt: this.now() }).where(eq(operation.id, row.id)).run();
        this.#notify(row.id);
      }
    }
  }

  onReauthorized(userId: string, authorizationId: string, accountId: string, generation: number): void {
    const owned = this.database.select().from(room).where(eq(room.ownerUserId, userId)).all();
    for (const currentRoom of owned) {
      for (const row of this.database.select().from(operation).where(and(eq(operation.roomId, currentRoom.id), eq(operation.kind, "playNext"))).all()) {
        if (isTerminalOperation(row) || row.status === "needsAdministrator" || row.accountId !== accountId) continue;
        const loaded = this.#load(row.id);
        if (!loaded) continue;
        this.#clearTimer(row.id);
        this.database.update(operation).set({ authorizationId, generation }).where(eq(operation.id, row.id)).run();
        if (hasPassedWriteBoundary(loaded.detail)) {
          // Reauthorization permits fresh confirmation, never another send.
          this.database.update(publicPlayNext).set({ step: "unknown", checkRound: 0, nextCheckAt: this.now() + 5_000 }).where(eq(publicPlayNext.operationId, row.id)).run();
          this.#status(row.id, "awaitingConfirmation");
          this.#schedule(row.id, this.now() + 5_000);
        } else this.#queue(row.id, "ready");
      }
    }
    this.scheduler.kick();
  }

  terminateMemberInTx(tx: AppDatabase, roomId: string, userId: string): void {
    for (const row of tx.select().from(operation).where(and(eq(operation.roomId, roomId), eq(operation.userId, userId), eq(operation.kind, "playNext"))).all()) {
      this.#clearTimer(row.id);
      tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, userId), eq(commandReceipt.resourceId, row.id))).run();
      const detail = tx.select().from(publicPlayNext).where(eq(publicPlayNext.operationId, row.id)).get();
      if (isTerminalOperation(row) || !detail || !hasPassedWriteBoundary(detail)) tx.delete(operation).where(eq(operation.id, row.id)).run();
      else {
        tx.update(publicPlayNext).set({ memberId: null }).where(eq(publicPlayNext.operationId, row.id)).run();
        tx.update(operation).set({ userId: v7() }).where(eq(operation.id, row.id)).run();
        if (detail.nextCheckAt !== null) this.#schedule(row.id, detail.nextCheckAt);
      }
    }
  }

  terminateRoomInTx(tx: AppDatabase, roomId: string): void {
    // The existing dedicated-playlist deletion task supersedes order reconciliation.
    for (const row of tx.select().from(operation).where(and(eq(operation.roomId, roomId), eq(operation.kind, "playNext"))).all()) {
      this.#clearTimer(row.id);
      tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, row.userId), eq(commandReceipt.resourceId, row.id))).run();
      tx.delete(operation).where(eq(operation.id, row.id)).run();
    }
  }

  stop(): void { for (const id of this.#timers.keys()) this.#clearTimer(id); }
}
