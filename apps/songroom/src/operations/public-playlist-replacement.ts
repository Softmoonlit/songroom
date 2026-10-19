import { v7 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import {
  commandReceipt,
  neteaseAuthorization,
  operation,
  personalPlaylistBinding,
  playlistSnapshot,
  playlistTrack,
  publicPlayNext,
  publicPlaylistBinding,
  publicPlaylistReplacement,
  publicSongRequest,
  requesterTag,
  room,
  roomMembership
} from "../db/schema.js";
import type { CredentialVault } from "../netease/credentials.js";
import type { AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import { BusinessError } from "../shared/errors.js";
import {
  randomReplacementConfirmCommand,
  type RandomReplacementConfirmCommand,
  type RandomReplacementOperationView,
  type RandomReplacementResponse
} from "../shared/public-playlist-contracts.js";
import type { EventStreamService } from "../events/event-stream.js";
import type { UpstreamScheduler, Operation } from "./upstream-scheduling.js";
import type { PublicRandomPreview, SourceBasis } from "./public-random-preview.js";
import type { SelectedTrack } from "./random-selector.js";
import type { PublicPlayNext } from "./public-play-next.js";

type ReplacementDetail = typeof publicPlaylistReplacement.$inferSelect;
type Authorization = typeof neteaseAuthorization.$inferSelect;
type SnapshotData = Extract<AdapterResult<"playlistDetail">, { ok: true }>["data"];

const isTerminalOperation = (row: Operation) => ["succeeded", "failed", "stopped"].includes(row.status);
const hasPassedWriteBoundary = (detail: ReplacementDetail) => {
  const added = JSON.parse(detail.addedSongIds) as string[];
  const removed = JSON.parse(detail.removedSongIds) as string[];
  return added.length > 0 || removed.length > 0 || ["sending", "confirming", "unknown"].includes(detail.step);
};
const CONFIRMATION_DELAYS_MS = [5_000, 30_000, 120_000];

export class PublicPlaylistReplacement {
  readonly #timers = new Map<string, NodeJS.Timeout>();
  playNextService?: PublicPlayNext;

  constructor(
    readonly database: AppDatabase,
    readonly adapter: NeteaseAdapter,
    readonly vault: CredentialVault,
    readonly scheduler: UpstreamScheduler,
    readonly events: EventStreamService,
    readonly randomPreview: PublicRandomPreview,
    readonly now: () => number,
    readonly beginRead: () => number,
    readonly commitSnapshot: (accountId: string, playlistId: string, generation: number, data: SnapshotData, readStartedAt: number, authScope: { id: string; generation: number }) => boolean
  ) {
    scheduler.register("replacePublicPlaylist", {
      claim: (row) => this.#claim(row),
      execute: (row) => this.#execute(row),
      recover: () => this.#recover()
    });
  }

  setPlayNextService(service: PublicPlayNext): void {
    this.playNextService = service;
  }

  #member(userId: string, roomId: string) {
    const currentRoom = this.database.select().from(room).where(eq(room.id, roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();
    if (!currentRoom || !member) throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    return { currentRoom, member };
  }

  hasTargetLock(accountId: string, playlistId: string): boolean {
    return !!this.database.select({ id: operation.id }).from(operation)
      .innerJoin(publicPlaylistReplacement, eq(publicPlaylistReplacement.operationId, operation.id))
      .where(and(
        eq(operation.accountId, accountId),
        eq(publicPlaylistReplacement.playlistId, playlistId),
        sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
      )).get();
  }

  read(userId: string, roomId: string, id: string): RandomReplacementOperationView {
    this.#member(userId, roomId);
    const row = this.database.select().from(operation)
      .where(and(eq(operation.id, id), eq(operation.roomId, roomId), eq(operation.userId, userId), eq(operation.kind, "replacePublicPlaylist"))).get();
    const detail = this.database.select().from(publicPlaylistReplacement).where(eq(publicPlaylistReplacement.operationId, id)).get();
    if (!row || !detail || (isTerminalOperation(row) && row.updatedAt <= this.now() - 86_400_000)) {
      throw new BusinessError(404, "OPERATION_UNAVAILABLE", "操作不存在或已过期");
    }

    const targetTracks = detail.targetTracks ? JSON.parse(detail.targetTracks) as SelectedTrack[] : [];
    return {
      id,
      roomId,
      status: row.status,
      step: detail.step,
      targetCount: detail.targetCount,
      targetSongIds: targetTracks.map(t => t.songId),
      addedSongIds: JSON.parse(detail.addedSongIds),
      removedSongIds: JSON.parse(detail.removedSongIds),
      tagConfirmed: Boolean(detail.tagConfirmed),
      currentAction: detail.currentAction as "add" | "remove" | null,
      currentSongId: detail.currentSongId,
      errorCode: row.errorCode as any,
      version: row.version
    };
  }

  accept(userId: string, roomId: string, input: RandomReplacementConfirmCommand): RandomReplacementResponse {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const command = randomReplacementConfirmCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "replacePublicPlaylist", { roomId, previewId: command.previewId }, this.now());

    const accepted = this.database.transaction(tx => {
      const { currentRoom } = this.#member(userId, roomId);
      if (currentRoom.ownerUserId !== userId) {
        throw new BusinessError(403, "OWNER_ONLY", "只有房主可以确认随机换歌");
      }

      const original = readCommandResource(tx, prepared, this.now());
      if (original) return { replay: true, id: original };

      tx.delete(operation).where(sql`${operation.kind} = 'replacePublicPlaylist' AND ${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${this.now() - 86_400_000}`).run();

      const preview = this.randomPreview.validate(userId, roomId, command.previewId);

      const binding = tx.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
      if (!binding) throw new BusinessError(409, "PUBLIC_PLAYLIST_NOT_FOUND", "房间尚未绑定公共歌单");
      if (binding.playlistId !== preview.publicPlaylistId || binding.generation !== preview.publicBindingGeneration) {
        throw new BusinessError(409, "PREVIEW_INVALIDATED", "公共歌单配置已变更，请重新预览");
      }

      const auth = tx.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, currentRoom.ownerUserId)).get();
      if (!auth || auth.status !== "active" || !auth.credentials || auth.accountId !== binding.accountId) {
        throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请房主先完成网易云授权");
      }

      const admission = this.scheduler.admissionCode(auth.accountId);
      if (admission) throw new BusinessError(409, admission, "网易云账号暂时不可执行操作");

      const pendingMember = tx.select().from(operation).where(and(
        eq(operation.roomId, roomId),
        eq(operation.userId, userId),
        sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
      )).get();
      if (pendingMember) throw new BusinessError(409, "CONCURRENT_OPERATION_LIMIT_EXCEEDED", "你在该房间已有未完成的写操作");

      const pendingSongs = tx.select({ id: operation.id }).from(operation)
        .innerJoin(publicSongRequest, eq(publicSongRequest.operationId, operation.id))
        .where(and(
          eq(operation.accountId, binding.accountId),
          eq(publicSongRequest.playlistId, binding.playlistId),
          sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`
        )).get();

      const pendingPlayNext = this.playNextService?.hasTargetLock(binding.accountId, binding.playlistId);
      const pendingReplacement = this.hasTargetLock(binding.accountId, binding.playlistId);

      const snapshot = tx.select().from(playlistSnapshot).where(and(
        eq(playlistSnapshot.accountId, binding.accountId),
        eq(playlistSnapshot.playlistId, binding.playlistId)
      )).get();

      if (pendingSongs || pendingPlayNext || pendingReplacement || snapshot?.lastErrorCode === "TARGET_PERMISSION") {
        throw new BusinessError(409, "TARGET_BLOCKED", "公共歌单有冲突操作待处理");
      }

      if (!snapshot?.syncedAt || snapshot.snapshotVersion !== preview.publicSnapshotVersion) {
        throw new BusinessError(409, "PLAYLIST_CONFLICT", "歌单已变化，请重新预览");
      }

      const currentTracks = tx.select().from(playlistTrack).where(and(
        eq(playlistTrack.accountId, binding.accountId),
        eq(playlistTrack.playlistId, binding.playlistId)
      )).orderBy(playlistTrack.position).all();
      const currentSongIds = currentTracks.map(t => t.songId);

      if (currentSongIds.length !== preview.publicSongIds.length || !currentSongIds.every((id, idx) => id === preview.publicSongIds[idx])) {
        throw new BusinessError(409, "PLAYLIST_CONFLICT", "公共歌单歌曲已变更，请重新预览");
      }

      const id = v7();
      tx.insert(operation).values({
        id,
        kind: "replacePublicPlaylist",
        userId,
        roomId,
        accountId: auth.accountId,
        authorizationId: auth.id,
        generation: auth.generation,
        status: "queued",
        lastGranted: this.now(),
        createdAt: this.now(),
        updatedAt: this.now()
      }).run();

      tx.insert(publicPlaylistReplacement).values({
        operationId: id,
        playlistId: binding.playlistId,
        bindingGeneration: binding.generation,
        targetCount: preview.tracks.length,
        targetTracks: JSON.stringify(preview.tracks),
        originalSongIds: JSON.stringify(preview.publicSongIds),
        sources: JSON.stringify(preview.sources),
        addedSongIds: "[]",
        removedSongIds: "[]",
        currentAction: null,
        currentSongId: null,
        step: "ready",
        tagConfirmed: false,
        checkRound: 0,
        nextCheckAt: null
      }).run();

      recordCommandResource(tx, prepared, id, this.now());
      return { replay: false, id };
    });

    if (!accepted.replay) {
      this.#notify(accepted.id);
      this.scheduler.kick();
    }
    return { replay: accepted.replay, operation: this.read(userId, roomId, accepted.id) };
  }

  #load(id: string) {
    const row = this.database.select().from(operation).where(eq(operation.id, id)).get();
    const detail = this.database.select().from(publicPlaylistReplacement).where(eq(publicPlaylistReplacement.operationId, id)).get();
    return row && detail ? { row, detail } : null;
  }

  #context(row: Operation, detail: ReplacementDetail): { auth: Authorization; cookie: string } | null {
    const current = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, row.roomId)).get();
    if (!current || !binding || binding.accountId !== row.accountId || binding.playlistId !== detail.playlistId || binding.generation !== detail.bindingGeneration) {
      this.#finish(row.id, "stopped");
      return null;
    }
    if (current.ownerUserId !== row.userId) {
      if (!hasPassedWriteBoundary(detail)) {
        this.#finish(row.id, "stopped");
        return null;
      }
    }
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.ownerUserId)).get();
    if (!auth || auth.status !== "active" || !auth.credentials || auth.accountId !== row.accountId || auth.id !== row.authorizationId || auth.generation !== row.generation) {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return null;
    }
    if (this.scheduler.paused(auth.accountId)) {
      this.#status(row.id, "needsAdministrator", "ACCOUNT_PAUSED");
      return null;
    }
    try {
      return {
        auth,
        cookie: this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation })
      };
    } catch {
      this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE");
      return null;
    }
  }

  #stillCurrent(row: Operation, detail: ReplacementDetail): boolean {
    const latest = this.#load(row.id);
    return !!latest && !isTerminalOperation(latest.row) && latest.row.status === "processing" && latest.row.authorizationId === row.authorizationId && latest.row.generation === row.generation && latest.detail.step === detail.step && !!this.#context(latest.row, latest.detail);
  }

  #claim(row: Operation): boolean {
    const loaded = this.#load(row.id);
    if (!loaded || !this.#context(loaded.row, loaded.detail)) return false;
    if (loaded.detail.step === "unknown") {
      if (loaded.detail.checkRound >= 3) {
        this.#status(row.id, "awaitingConfirmation", row.errorCode);
        return false;
      }
      this.database.update(publicPlaylistReplacement).set({
        step: "confirming",
        nextCheckAt: null
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
    }
    return true;
  }

  async #execute(claimed: Operation): Promise<void> {
    const loaded = this.#load(claimed.id);
    if (!loaded) return;
    const { row, detail } = loaded;
    const context = this.#context(row, detail);
    if (!context) return;
    const { auth, cookie } = context;

    try {
      if (detail.step === "ready" || detail.step === "verified") {
        await this.#executeNextReplacementAction(row, detail, auth, cookie);
      } else if (detail.step === "sending") {
        // Crash occurred after sending: never resend, transition to awaitingConfirmation
        this.#awaitConfirmation(row, detail, row.errorCode);
      } else if (detail.step === "confirming") {
        await this.#executeConfirming(row, detail, auth, cookie);
      }
    } catch {
      const latest = this.#load(row.id);
      if (!latest || latest.row.status !== "processing" || latest.row.generation !== row.generation) return;
      this.#failure(latest.row, latest.detail, "MODULE_ERROR");
    }
  }

  async #executeNextReplacementAction(
    row: Operation,
    detail: ReplacementDetail,
    auth: Authorization,
    cookie: string
  ): Promise<void> {
    const originalSongIds = JSON.parse(detail.originalSongIds) as string[];
    const removedSongIds = JSON.parse(detail.removedSongIds) as string[];
    const addedSongIds = JSON.parse(detail.addedSongIds) as string[];
    const targetTracks = JSON.parse(detail.targetTracks) as SelectedTrack[];
    const targetSongIds = targetTracks.map(t => t.songId);

    // 阶段 1：批量清空当前公共歌单歌曲（若歌单非空且尚未清空）
    if (originalSongIds.length > 0 && removedSongIds.length === 0) {
      this.database.update(publicPlaylistReplacement).set({
        step: "sending",
        currentAction: "remove",
        currentSongId: null
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

      const sendingDetail: ReplacementDetail = {
        ...detail,
        step: "sending",
        currentAction: "remove",
        currentSongId: null
      };

      const removeResult = await this.adapter.call({
        operation: "trackRemove",
        cookie,
        playlistId: detail.playlistId,
        songIds: originalSongIds
      });

      if (!this.#stillCurrent(row, sendingDetail)) return;

      if (!removeResult.ok) {
        if (removeResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
        if (removeResult.error.outcome === "failed") {
          this.#failure(row, sendingDetail, removeResult.error.code, true);
          return;
        }
        this.#awaitConfirmation(row, sendingDetail, removeResult.error.code);
        return;
      }

      this.database.update(publicPlaylistReplacement).set({
        step: "confirming"
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

      const confirmingDetail: ReplacementDetail = {
        ...sendingDetail,
        step: "confirming"
      };

      await this.#executeConfirming(row, confirmingDetail, auth, cookie);
      return;
    }

    // 阶段 2：批量添加目标歌曲（若尚未添加）
    if (addedSongIds.length === 0 && targetSongIds.length > 0) {
      // 发送前核验来源依据有效性（成员仍在、绑定未变、歌曲仍在来源歌单中）
      const sources = JSON.parse(detail.sources) as SourceBasis[];
      for (const track of targetTracks) {
        const source = sources.find(s => s.memberId === track.sourceMemberId);
        if (source) {
          const member = this.database.select().from(roomMembership).where(and(
            eq(roomMembership.id, source.memberId),
            eq(roomMembership.roomId, row.roomId)
          )).get();
          const currentBinding = this.database.select().from(personalPlaylistBinding).where(and(
            eq(personalPlaylistBinding.id, source.bindingId),
            eq(personalPlaylistBinding.generation, source.bindingGeneration)
          )).get();
          const inSource = currentBinding ? this.database.select().from(playlistTrack).where(and(
            eq(playlistTrack.accountId, currentBinding.accountId),
            eq(playlistTrack.playlistId, currentBinding.playlistId),
            eq(playlistTrack.songId, track.songId)
          )).get() : null;

          if (!member || !currentBinding || !inSource) {
            this.#finish(row.id, "stopped", "PLAYLIST_CONFLICT");
            return;
          }
        }
      }

      this.database.update(publicPlaylistReplacement).set({
        step: "sending",
        currentAction: "add",
        currentSongId: null
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

      const sendingDetail: ReplacementDetail = {
        ...detail,
        step: "sending",
        currentAction: "add",
        currentSongId: null
      };

      const addResult = await this.adapter.call({
        operation: "trackAdd",
        cookie,
        playlistId: detail.playlistId,
        songIds: targetSongIds
      });

      if (!this.#stillCurrent(row, sendingDetail)) return;

      if (!addResult.ok) {
        if (addResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
        if (addResult.error.outcome === "failed") {
          this.#failure(row, sendingDetail, addResult.error.code, true);
          return;
        }
        this.#awaitConfirmation(row, sendingDetail, addResult.error.code);
        return;
      }

      this.database.update(publicPlaylistReplacement).set({
        step: "confirming"
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

      const confirmingDetail: ReplacementDetail = {
        ...sendingDetail,
        step: "confirming"
      };

      await this.#executeConfirming(row, confirmingDetail, auth, cookie);
      return;
    }

    // 阶段 3：如果目标歌曲已经确认，执行打标并终结
    if (addedSongIds.length > 0 || targetSongIds.length === 0) {
      await this.#executeTagging(row, detail);
    }
  }

  async #executeConfirming(
    row: Operation,
    detail: ReplacementDetail,
    auth: Authorization,
    cookie: string
  ): Promise<void> {
    const readStartedAt = this.beginRead();
    const detailResult = await this.adapter.call({
      operation: "playlistDetail",
      cookie,
      playlistId: detail.playlistId
    });

    if (!this.#stillCurrent(row, detail)) return;

    if (!detailResult.ok) {
      if (detailResult.error.code === "RATE_LIMITED") this.scheduler.pause(row.accountId!);
      this.#awaitConfirmation(row, detail, detailResult.error.code);
      return;
    }

    const data = detailResult.data;
    if (data.playlist.id !== detail.playlistId || data.playlist.status !== 0 || data.songIds.length !== data.songs.length) {
      this.#awaitConfirmation(row, detail, "PARSE_ERROR");
      return;
    }

    const committed = this.commitSnapshot(row.accountId!, detail.playlistId, detail.bindingGeneration, data, readStartedAt, {
      id: auth.id,
      generation: auth.generation
    });
    if (!committed) {
      this.#awaitConfirmation(row, detail, "PARSE_ERROR");
      return;
    }

    const targetTracks = JSON.parse(detail.targetTracks) as SelectedTrack[];
    const targetSongIds = targetTracks.map(t => t.songId);
    const originalSongIds = JSON.parse(detail.originalSongIds) as string[];

    if (detail.currentAction === "remove") {
      // 确认批量清空结果
      const remainingOldSongs = originalSongIds.filter(id => data.songIds.includes(id));
      const unexpectedSongs = data.songIds.filter(id => !originalSongIds.includes(id));

      if (unexpectedSongs.length > 0) {
        // 规格："外部并发导致集合变化时据实反馈，不通过清理意外歌曲掩盖冲突。"
        this.database.update(publicPlaylistReplacement).set({
          step: "stopped"
        }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
        this.#finish(row.id, "stopped", "PLAYLIST_CONFLICT");
        return;
      }

      if (remainingOldSongs.length === 0) {
        // 清空已完整确认！
        // 规格："清空确认移除后结束旧标签生命周期；重新加入歌曲仅按本轮最终来源成员记录标签"
        this.database.transaction(tx => {
          tx.delete(requesterTag).where(and(
            eq(requesterTag.roomId, row.roomId),
            eq(requesterTag.bindingGeneration, detail.bindingGeneration)
          )).run();

          tx.update(publicPlaylistReplacement).set({
            removedSongIds: JSON.stringify(originalSongIds),
            currentAction: null,
            currentSongId: null,
            checkRound: 0,
            nextCheckAt: null,
            step: "verified"
          }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
        });

        this.#queue(row.id, "verified");
      } else {
        // 旧歌尚未全清（可能写入未抵达）
        this.#awaitConfirmation(row, detail, null);
      }
    } else if (detail.currentAction === "add") {
      // 确认批量添加结果
      const unexpectedSongs = data.songIds.filter(id => !targetSongIds.includes(id));
      if (unexpectedSongs.length > 0) {
        // 外部并发修改
        this.database.update(publicPlaylistReplacement).set({
          step: "stopped"
        }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
        this.#finish(row.id, "stopped", "PLAYLIST_CONFLICT");
        return;
      }

      const presentTargetSongs = targetSongIds.filter(id => data.songIds.includes(id));
      const missingTargetSongs = targetSongIds.filter(id => !data.songIds.includes(id));

      if (missingTargetSongs.length === 0) {
        // 全部目标歌曲已读回确认！
        this.database.update(publicPlaylistReplacement).set({
          addedSongIds: JSON.stringify(targetSongIds),
          currentAction: null,
          currentSongId: null,
          checkRound: 0,
          nextCheckAt: null,
          step: "verified"
        }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

        const updatedDetail = {
          ...detail,
          addedSongIds: JSON.stringify(targetSongIds),
          currentAction: null,
          currentSongId: null,
          step: "verified" as const
        };
        await this.#executeTagging(row, updatedDetail);
      } else {
        // 存在缺失歌曲
        if (detail.checkRound < 3) {
          this.#awaitConfirmation(row, detail, null);
        } else {
          // 3 轮补查结束，仍不完整
          if (presentTargetSongs.length > 0) {
            // 规格："批量部分成功据实展示，停止后续写入，不自动重放缺失歌曲。"
            await this.#executePartialSuccess(row, detail, presentTargetSongs);
          } else {
            this.#status(row.id, "awaitingConfirmation", null);
          }
        }
      }
    } else {
      // 无正在确认的动作，重入 verified
      this.database.update(publicPlaylistReplacement).set({
        checkRound: 0,
        nextCheckAt: null,
        step: "verified"
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
      this.#queue(row.id, "verified");
    }
  }

  async #executePartialSuccess(
    row: Operation,
    detail: ReplacementDetail,
    presentSongIds: string[]
  ): Promise<void> {
    const targetTracks = JSON.parse(detail.targetTracks) as SelectedTrack[];
    const sources = JSON.parse(detail.sources) as SourceBasis[];

    this.database.transaction(tx => {
      for (const songId of presentSongIds) {
        const track = targetTracks.find(t => t.songId === songId);
        if (!track) continue;
        const source = sources.find(s => s.memberId === track.sourceMemberId);
        if (!source) continue;
        const member = tx.select().from(roomMembership).where(and(
          eq(roomMembership.id, track.sourceMemberId),
          eq(roomMembership.roomId, row.roomId)
        )).get();
        if (!member) continue;
        const binding = tx.select().from(personalPlaylistBinding).where(and(
          eq(personalPlaylistBinding.id, source.bindingId),
          eq(personalPlaylistBinding.generation, source.bindingGeneration),
          eq(personalPlaylistBinding.roomId, row.roomId)
        )).get();
        if (!binding) continue;

        tx.insert(requesterTag).values({
          roomId: row.roomId,
          bindingGeneration: detail.bindingGeneration,
          songId: track.songId,
          memberId: track.sourceMemberId,
          createdAt: this.now()
        }).onConflictDoNothing().run();
      }

      tx.update(publicPlaylistReplacement).set({
        addedSongIds: JSON.stringify(presentSongIds),
        currentAction: null,
        currentSongId: null,
        step: "rejected",
        targetTracks: "[]",
        originalSongIds: "[]",
        sources: "[]"
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

      tx.update(operation).set({
        status: "failed",
        errorCode: "MODULE_ERROR",
        accountId: null,
        authorizationId: null,
        generation: null,
        updatedAt: this.now(),
        version: sql`${operation.version} + 1`
      }).where(eq(operation.id, row.id)).run();

      tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, row.roomId)).run();
    });

    this.#notify(row.id);
  }

  async #executeTagging(row: Operation, detail: ReplacementDetail): Promise<void> {
    const targetTracks = JSON.parse(detail.targetTracks) as SelectedTrack[];
    const targetSongIds = targetTracks.map(t => t.songId);
    const originalSongIds = JSON.parse(detail.originalSongIds) as string[];

    const currentTracks = this.database.select().from(playlistTrack).where(and(
      eq(playlistTrack.accountId, row.accountId!),
      eq(playlistTrack.playlistId, detail.playlistId)
    )).orderBy(playlistTrack.position).all();
    const currentSongIds = currentTracks.map(t => t.songId);

    // 严格核对最终云端集合：必须全量包含目标且不包含未在目标中的原歌或意外新增歌曲
    const hasAllTarget = targetSongIds.every(id => currentSongIds.includes(id));
    const hasNoOldRemaining = originalSongIds.filter(id => !targetSongIds.includes(id)).every(id => !currentSongIds.includes(id));
    const hasNoUnexpected = currentSongIds.every(id => targetSongIds.includes(id));

    if (!hasAllTarget || !hasNoOldRemaining || !hasNoUnexpected) {
      this.#finish(row.id, "stopped", "PLAYLIST_CONFLICT");
      return;
    }

    this.database.update(publicPlaylistReplacement).set({
      step: "tagging"
    }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

    const sources = JSON.parse(detail.sources) as SourceBasis[];

    this.database.transaction(tx => {
      const snapTracks = tx.select().from(playlistTrack).where(and(
        eq(playlistTrack.accountId, row.accountId!),
        eq(playlistTrack.playlistId, detail.playlistId)
      )).all();
      const snapSongIds = new Set(snapTracks.map(t => t.songId));

      for (const track of targetTracks) {
        if (!snapSongIds.has(track.songId)) continue;

        const source = sources.find(s => s.memberId === track.sourceMemberId);
        if (!source) continue;

        const member = tx.select().from(roomMembership).where(and(
          eq(roomMembership.id, track.sourceMemberId),
          eq(roomMembership.roomId, row.roomId)
        )).get();
        if (!member) continue;

        const binding = tx.select().from(personalPlaylistBinding).where(and(
          eq(personalPlaylistBinding.id, source.bindingId),
          eq(personalPlaylistBinding.generation, source.bindingGeneration),
          eq(personalPlaylistBinding.roomId, row.roomId)
        )).get();
        if (!binding) continue;

        tx.insert(requesterTag).values({
          roomId: row.roomId,
          bindingGeneration: detail.bindingGeneration,
          songId: track.songId,
          memberId: track.sourceMemberId,
          createdAt: this.now()
        }).onConflictDoNothing().run();
      }

      tx.update(publicPlaylistReplacement).set({
        tagConfirmed: true,
        step: "succeeded",
        targetTracks: "[]",
        originalSongIds: "[]",
        sources: "[]"
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();

      tx.update(operation).set({
        status: "succeeded",
        errorCode: null,
        accountId: null,
        authorizationId: null,
        generation: null,
        updatedAt: this.now(),
        version: sql`${operation.version} + 1`
      }).where(eq(operation.id, row.id)).run();

      tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, row.roomId)).run();
    });

    this.#notify(row.id);
  }

  #failure(row: Operation, detail: ReplacementDetail, code: Operation["errorCode"], rejected = false): void {
    if (code === "RATE_LIMITED" || code === "ACCOUNT_PAUSED") {
      this.scheduler.pause(row.accountId!);
      this.#status(row.id, "needsAdministrator", "ACCOUNT_PAUSED");
      return;
    }
    if (["AUTH_UNAVAILABLE", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH"].includes(code ?? "")) {
      this.#status(row.id, "waitingAuthorization", code);
      return;
    }
    if (hasPassedWriteBoundary(detail) && !rejected) {
      this.#awaitConfirmation(row, detail, code);
    } else {
      this.#finish(row.id, "failed", code);
    }
  }

  #queue(id: string, step: ReplacementDetail["step"]): void {
    this.database.transaction(tx => {
      tx.update(publicPlaylistReplacement).set({ step }).where(eq(publicPlaylistReplacement.operationId, id)).run();
      this.#status(id, "queued");
    });
    this.scheduler.kick();
  }

  #awaitConfirmation(row: Operation, detail: ReplacementDetail, code: Operation["errorCode"]): void {
    const nextRound = Math.min(3, detail.checkRound + 1);
    const nextCheckAt = detail.checkRound < CONFIRMATION_DELAYS_MS.length ? this.now() + CONFIRMATION_DELAYS_MS[detail.checkRound] : null;
    this.database.transaction(tx => {
      tx.update(publicPlaylistReplacement).set({
        step: "unknown",
        checkRound: nextRound,
        nextCheckAt
      }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
      this.#status(row.id, "awaitingConfirmation", code);
    });
    if (nextCheckAt !== null) this.#schedule(row.id, nextCheckAt);
  }

  #schedule(id: string, dueAt: number): void {
    this.#clearTimer(id);
    const delay = Math.max(0, dueAt - this.now());
    const timer = setTimeout(() => this.#due(id), delay);
    this.#timers.set(id, timer);
  }

  #clearTimer(id: string): void {
    const existing = this.#timers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.#timers.delete(id);
    }
  }

  #due(id: string): void {
    const loaded = this.#load(id);
    if (!loaded || loaded.row.status !== "awaitingConfirmation" || loaded.detail.checkRound > 3) return;
    this.database.update(publicPlaylistReplacement).set({
      step: "confirming",
      nextCheckAt: null
    }).where(eq(publicPlaylistReplacement.operationId, id)).run();
    this.database.update(operation).set({
      status: "queued",
      lastGranted: this.now(),
      version: sql`${operation.version} + 1`,
      updatedAt: this.now()
    }).where(eq(operation.id, id)).run();
    this.#notify(id);
    this.scheduler.kick();
  }

  #notify(id: string): void {
    const row = this.database.select().from(operation).where(eq(operation.id, id)).get();
    if (!row) return;
    this.database.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, row.roomId)).run();
    const currentRoom = this.database.select().from(room).where(eq(room.id, row.roomId)).get();
    this.events.notifyRoom(this.database, row.roomId, { type: "operation", resourceId: id, version: row.version });
    if (currentRoom) {
      this.events.notifyRoom(this.database, row.roomId, { type: "room", resourceId: row.roomId, version: currentRoom.version });
      this.events.notifyRoom(this.database, row.roomId, { type: "snapshot", resourceId: row.roomId, version: currentRoom.version });
    }
  }

  #status(id: string, status: Operation["status"], errorCode: Operation["errorCode"] = null): void {
    this.database.update(operation).set({
      status,
      errorCode,
      updatedAt: this.now(),
      version: sql`${operation.version} + 1`
    }).where(eq(operation.id, id)).run();
    this.#notify(id);
  }

  #finish(id: string, status: "succeeded" | "failed" | "stopped", errorCode: Operation["errorCode"] = null): void {
    this.#clearTimer(id);
    const loaded = this.#load(id);
    if (!loaded) return;
    this.database.transaction(tx => {
      tx.update(publicPlaylistReplacement).set({
        step: status === "succeeded" ? "succeeded" : loaded.detail.step === "stopped" ? "stopped" : "rejected",
        targetTracks: "[]",
        originalSongIds: "[]",
        sources: "[]"
      }).where(eq(publicPlaylistReplacement.operationId, id)).run();
      tx.update(operation).set({
        status,
        errorCode,
        accountId: null,
        authorizationId: null,
        generation: null,
        updatedAt: this.now(),
        version: sql`${operation.version} + 1`
      }).where(eq(operation.id, id)).run();
    });
    this.#notify(id);
  }

  triggerDueChecks(): void {
    for (const detail of this.database.select().from(publicPlaylistReplacement).where(sql`${publicPlaylistReplacement.nextCheckAt} <= ${this.now()}`).all()) {
      this.#due(detail.operationId);
    }
  }

  #recover(): void {
    this.database.delete(operation).where(sql`${operation.kind} = 'replacePublicPlaylist' AND ${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${this.now() - 86_400_000}`).run();
    for (const row of this.database.select().from(operation).where(eq(operation.kind, "replacePublicPlaylist")).all()) {
      if (isTerminalOperation(row) || row.status === "waitingAuthorization" || row.status === "needsAdministrator") continue;
      const loaded = this.#load(row.id);
      if (!loaded) continue;
      if (hasPassedWriteBoundary(loaded.detail)) {
        const dueAt = loaded.detail.checkRound < 3 ? loaded.detail.nextCheckAt ?? this.now() + 5_000 : null;
        this.database.update(publicPlaylistReplacement).set({
          step: "unknown",
          nextCheckAt: dueAt
        }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
        this.#status(row.id, "awaitingConfirmation", row.errorCode);
        if (dueAt !== null) this.#schedule(row.id, dueAt);
      } else {
        this.#queue(row.id, "ready");
      }
    }
  }

  onOwnerRevoked(userId: string): void {
    for (const currentRoom of this.database.select().from(room).where(eq(room.ownerUserId, userId)).all()) {
      for (const row of this.database.select().from(operation).where(and(eq(operation.roomId, currentRoom.id), eq(operation.kind, "replacePublicPlaylist"))).all()) {
        if (isTerminalOperation(row) || row.status === "needsAdministrator") continue;
        this.#clearTimer(row.id);
        this.database.update(operation).set({
          status: "waitingAuthorization",
          errorCode: "AUTH_UNAVAILABLE",
          version: sql`${operation.version} + 1`,
          updatedAt: this.now()
        }).where(eq(operation.id, row.id)).run();
        this.#notify(row.id);
      }
    }
  }

  onReauthorized(userId: string, authorizationId: string, accountId: string, generation: number): void {
    const owned = this.database.select().from(room).where(eq(room.ownerUserId, userId)).all();
    for (const currentRoom of owned) {
      for (const row of this.database.select().from(operation).where(and(eq(operation.roomId, currentRoom.id), eq(operation.kind, "replacePublicPlaylist"))).all()) {
        if (isTerminalOperation(row) || row.status === "needsAdministrator" || row.accountId !== accountId) continue;
        const loaded = this.#load(row.id);
        if (!loaded) continue;
        this.#clearTimer(row.id);
        this.database.update(operation).set({ authorizationId, generation }).where(eq(operation.id, row.id)).run();
        if (hasPassedWriteBoundary(loaded.detail)) {
          this.database.update(publicPlaylistReplacement).set({
            step: "unknown",
            checkRound: 0,
            nextCheckAt: this.now() + 5_000
          }).where(eq(publicPlaylistReplacement.operationId, row.id)).run();
          this.#status(row.id, "awaitingConfirmation");
          this.#schedule(row.id, this.now() + 5_000);
        } else {
          this.#queue(row.id, "ready");
        }
      }
    }
    this.scheduler.kick();
  }

  terminateMemberInTx(tx: any, roomId: string, userId: string): void {
    for (const row of tx.select().from(operation).where(and(eq(operation.roomId, roomId), eq(operation.userId, userId), eq(operation.kind, "replacePublicPlaylist"))).all()) {
      this.#clearTimer(row.id);
      tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, userId), eq(commandReceipt.resourceId, row.id))).run();
      const detail = tx.select().from(publicPlaylistReplacement).where(eq(publicPlaylistReplacement.operationId, row.id)).get();
      if (isTerminalOperation(row) || !detail || !hasPassedWriteBoundary(detail)) {
        tx.delete(operation).where(eq(operation.id, row.id)).run();
      } else {
        tx.update(operation).set({ userId: v7() }).where(eq(operation.id, row.id)).run();
        if (detail.nextCheckAt !== null) this.#schedule(row.id, detail.nextCheckAt);
      }
    }
  }

  terminateRoomInTx(tx: any, roomId: string): void {
    for (const row of tx.select().from(operation).where(and(eq(operation.roomId, roomId), eq(operation.kind, "replacePublicPlaylist"))).all()) {
      this.#clearTimer(row.id);
      tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, row.userId), eq(commandReceipt.resourceId, row.id))).run();
      tx.delete(operation).where(eq(operation.id, row.id)).run();
    }
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
