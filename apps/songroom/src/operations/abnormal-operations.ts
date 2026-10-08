import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import {
  adminAuditLog,
  neteaseAuthorization,
  operation,
  publicPlaylistBinding,
  publicPlaylistCleanup,
  publicPlaylistCreation,
  publicSongRequest,
  room,
  upstreamAccount
} from "../db/schema.js";
import { BusinessError } from "../shared/errors.js";
import type { CredentialVault } from "../netease/credentials.js";
import type { NeteaseAdapter } from "../netease/protocol.js";
import type { EventStreamService } from "../events/event-stream.js";
import type {
  AbnormalActionResult,
  AbnormalOperationDetail,
  AbnormalOperationSummary
} from "../shared/admin-contracts.js";
import type { PublicPlaylists } from "./public-playlists.js";
import type { UpstreamScheduler } from "./upstream-scheduling.js";

export function validateAdminReason(raw: string): string {
  const trimmed = raw.trim().normalize("NFC");
  if (/\p{Cc}/u.test(trimmed)) {
    throw new BusinessError(400, "INVALID_REASON", "处置原因不能包含控制字符");
  }
  const length = [...trimmed].length;
  if (length < 1 || length > 500) {
    throw new BusinessError(400, "INVALID_REASON", "处置原因长度必须在 1 到 500 个字符之间");
  }
  return trimmed;
}

export class AbnormalOperationsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly playlists: PublicPlaylists,
    private readonly scheduler: UpstreamScheduler,
    private readonly adapter: NeteaseAdapter,
    private readonly vault: CredentialVault,
    private readonly eventStream: EventStreamService,
    private readonly now: () => number = () => Date.now()
  ) {}

  listAbnormalOperations(): AbnormalOperationSummary[] {
    const list: AbnormalOperationSummary[] = [];

    // 1. 普通未知歌曲写入 (必须是三轮补查结束后的长期未知待确认)
    const songOps = this.database
      .select({
        id: operation.id,
        accountId: operation.accountId,
        status: operation.status,
        version: operation.version,
        updatedAt: operation.updatedAt,
        playlistId: publicSongRequest.playlistId,
        checkRound: publicSongRequest.checkRound
      })
      .from(operation)
      .innerJoin(publicSongRequest, eq(publicSongRequest.operationId, operation.id))
      .where(
        and(
          eq(operation.kind, "requestPublicSong"),
          eq(operation.status, "awaitingConfirmation"),
          sql`${publicSongRequest.checkRound} >= 3`,
          isNull(publicSongRequest.nextCheckAt)
        )
      )
      .orderBy(desc(operation.updatedAt))
      .all();

    for (const op of songOps) {
      list.push({
        id: op.id,
        type: "unknown_song_write",
        accountId: op.accountId ?? "unknown",
        targetId: op.playlistId,
        status: op.status,
        version: op.version,
        summary: `长期未知写入已停止自动补查 (第 ${op.checkRound}/3 轮已结束，目标歌单: ${op.playlistId})`,
        updatedAt: op.updatedAt
      });
    }

    // 2. 公共歌单未知创建 (需管理员处理)
    const createOps = this.database
      .select({
        id: operation.id,
        accountId: operation.accountId,
        roomId: operation.roomId,
        status: operation.status,
        version: operation.version,
        updatedAt: operation.updatedAt,
        name: publicPlaylistCreation.name
      })
      .from(operation)
      .innerJoin(publicPlaylistCreation, eq(publicPlaylistCreation.operationId, operation.id))
      .where(and(eq(operation.kind, "createPublicPlaylist"), eq(operation.status, "needsAdministrator")))
      .orderBy(desc(operation.updatedAt))
      .all();

    for (const op of createOps) {
      list.push({
        id: op.id,
        type: "unknown_playlist_create",
        accountId: op.accountId ?? "unknown",
        targetId: op.roomId,
        status: op.status,
        version: op.version,
        summary: `公共歌单创建结果未知 (歌单名称: ${op.name}, 等待具权核查)`,
        updatedAt: op.updatedAt
      });
    }

    // 3. 公共歌单清理异常 (待确认或需管理员处理)
    const cleanups = this.database
      .select()
      .from(publicPlaylistCleanup)
      .where(inArray(publicPlaylistCleanup.status, ["needsAdministrator", "awaitingConfirmation"]))
      .orderBy(desc(publicPlaylistCleanup.updatedAt))
      .all();

    for (const c of cleanups) {
      list.push({
        id: c.id,
        type: "unknown_cleanup",
        accountId: c.accountId,
        targetId: c.playlistId,
        status: c.status,
        version: c.version,
        summary: `公共歌单清理待处置 (状态: ${c.status}, 事实: ${c.checkFact ?? "none"}, 授权重试: ${c.retryAuthorized ? "是" : "否"})`,
        updatedAt: c.updatedAt
      });
    }

    // 4. 风控暂停账号
    const pausedAccounts = this.database
      .select()
      .from(upstreamAccount)
      .where(eq(upstreamAccount.paused, true))
      .all();

    for (const acc of pausedAccounts) {
      list.push({
        id: acc.accountId,
        type: "risk_control_pause",
        accountId: acc.accountId,
        targetId: acc.accountId,
        status: "paused",
        version: null,
        summary: `网易云账号已风控暂停 (原因: ${acc.pauseReason ?? "RATE_LIMITED"})`,
        updatedAt: acc.nextStartAt
      });
    }

    return list;
  }

  getAbnormalOperation(id: string): AbnormalOperationDetail {
    // 1. 尝试查询 operation (歌曲写入或歌单创建)
    const op = this.database.select().from(operation).where(eq(operation.id, id)).get();
    if (op) {
      if (op.kind === "requestPublicSong") {
        const req = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, op.id)).get();
        if (req) {
          return {
            id: op.id,
            type: "unknown_song_write",
            accountId: op.accountId ?? "",
            targetId: req.playlistId,
            status: op.status,
            version: op.version,
            roomId: op.roomId,
            playlistId: req.playlistId,
            checkRound: req.checkRound,
            lastErrorCode: op.errorCode,
            impactDescription: "终结后解除该公共歌单的目标写入阻塞，不宣称失败、不回滚、不补写；后续业务必须先刷新并使用新幂等键",
            updatedAt: op.updatedAt
          };
        }
      } else if (op.kind === "createPublicPlaylist") {
        const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, op.id)).get();
        if (detail) {
          const beforeList: Array<{ id: string; name: string }> = detail.beforePlaylists ? JSON.parse(detail.beforePlaylists) : [];
          const afterList: Array<{ id: string; name: string }> = detail.afterPlaylists ? JSON.parse(detail.afterPlaylists) : [];
          const beforeIds = new Set(beforeList.map(p => p.id));
          const added = afterList.filter(p => !beforeIds.has(p.id));

          return {
            id: op.id,
            type: "unknown_playlist_create",
            accountId: op.accountId ?? "",
            targetId: op.roomId,
            status: op.status,
            version: op.version,
            roomId: op.roomId,
            candidatePlaylistsCount: added.length,
            candidatePlaylistId: added.length === 1 ? added[0].id : null,
            candidatePlaylistName: added.length === 1 ? added[0].name : null,
            lastErrorCode: op.errorCode,
            impactDescription:
              added.length === 1
                ? "具体 ID 证据唯一：若原房间与房主仍有效则恢复绑定；若原业务已结束转公共歌单清理"
                : "证据歧义：新增歌单数量不等于 1，将继续保持暂停，不得按名称猜测或再次创建",
            updatedAt: op.updatedAt
          };
        }
      }
    }

    // 2. 尝试查询公共歌单清理任务
    const cleanup = this.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, id)).get();
    if (cleanup) {
      return {
        id: cleanup.id,
        type: "unknown_cleanup",
        accountId: cleanup.accountId,
        targetId: cleanup.playlistId,
        status: cleanup.status,
        version: cleanup.version,
        playlistId: cleanup.playlistId,
        checkRound: cleanup.checkRound,
        checkFact: cleanup.checkFact,
        lastErrorCode: cleanup.lastErrorCode,
        impactDescription: "核实原具体目标仍存活且仍应清理后可明确授权一次单次重试删除；若房主在官方客户端手工处理可触发服务端只读核验",
        updatedAt: cleanup.updatedAt
      };
    }

    // 3. 尝试查询风控暂停账号
    const acc = this.database.select().from(upstreamAccount).where(and(eq(upstreamAccount.accountId, id), eq(upstreamAccount.paused, true))).get();
    if (acc) {
      return {
        id: acc.accountId,
        type: "risk_control_pause",
        accountId: acc.accountId,
        targetId: acc.accountId,
        status: "paused",
        version: null,
        pauseReason: acc.pauseReason ?? "RATE_LIMITED",
        impactDescription: "风控暂停恢复：重新核实当前真实账号与有效授权，解除该账号的上游调度阻塞",
        updatedAt: acc.nextStartAt
      };
    }

    throw new BusinessError(404, "NOT_FOUND", "未找到指定的异常操作记录");
  }

  resolveSongWrite(
    adminUserId: string,
    operationId: string,
    input: { reason: string; expectedVersion: number }
  ): AbnormalActionResult {
    const validatedReason = validateAdminReason(input.reason);

    const op = this.database.select().from(operation).where(eq(operation.id, operationId)).get();
    if (!op || op.kind !== "requestPublicSong") {
      throw new BusinessError(404, "NOT_FOUND", "未找到对应的未知点歌写入操作");
    }
    if (op.status !== "awaitingConfirmation") {
      throw new BusinessError(409, "INVALID_STATUS", `当前操作状态为 ${op.status}，非待确认状态无法由管理员终结`);
    }
    if (op.version !== input.expectedVersion) {
      throw new BusinessError(409, "OPERATION_STATE_CHANGED", "操作状态或版本已发生变化，旧确认已失效，请重新核实");
    }

    const req = this.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, operationId)).get();
    if (!req) {
      throw new BusinessError(404, "NOT_FOUND", "未找到对应的点歌请求详情");
    }
    // 只有在自动补查 3 轮均已结束且不再调度时，才属于规范定义的“长期未知”
    if (req.checkRound < 3 || req.nextCheckAt !== null) {
      throw new BusinessError(409, "CHECK_IN_PROGRESS", "自动补查尚未结束，非长期未知状态禁止提前终结");
    }

    const nextVersion = op.version + 1;
    this.database.transaction(tx => {
      tx.update(operation)
        .set({
          status: "stopped",
          accountId: null,
          authorizationId: null,
          generation: null,
          version: nextVersion,
          updatedAt: this.now()
        })
        .where(eq(operation.id, operationId))
        .run();

      tx.update(publicSongRequest)
        .set({
          step: "stopped",
          nextCheckAt: null
        })
        .where(eq(publicSongRequest.operationId, operationId))
        .run();

      // 严格脱敏：绝不记录昵称、歌曲、凭据、Cookie 或完整错误响应
      tx.insert(adminAuditLog)
        .values({
          id: v7(),
          adminUserId,
          targetType: "operation",
          targetId: operationId,
          action: "resolve_song_write",
          reason: validatedReason,
          previousStatus: "awaitingConfirmation",
          nextStatus: "stopped",
          result: "succeeded",
          details: JSON.stringify({ playlistId: req.playlistId, operationKind: "requestPublicSong" }),
          createdAt: new Date(this.now())
        })
        .run();
    });

    this.eventStream.notifyRoom(this.database, op.roomId, {
      type: "operation",
      resourceId: operationId,
      version: nextVersion
    });

    return {
      ok: true,
      action: "resolve_song_write",
      targetId: operationId,
      previousStatus: "awaitingConfirmation",
      nextStatus: "stopped",
      conclusion: "unconfirmed_terminal",
      message: "长期未知写入已终结为结果未能确认，公共歌单阻塞已解除"
    };
  }

  resolvePlaylistCreate(
    adminUserId: string,
    operationId: string,
    input: { reason: string; expectedVersion: number }
  ): AbnormalActionResult {
    const validatedReason = validateAdminReason(input.reason);

    const op = this.database.select().from(operation).where(eq(operation.id, operationId)).get();
    if (!op || op.kind !== "createPublicPlaylist") {
      throw new BusinessError(404, "NOT_FOUND", "未找到对应的公共歌单创建操作");
    }
    if (op.status !== "needsAdministrator") {
      throw new BusinessError(409, "INVALID_STATUS", `当前操作状态为 ${op.status}，非需管理员处理状态`);
    }
    if (op.version !== input.expectedVersion) {
      throw new BusinessError(409, "OPERATION_STATE_CHANGED", "操作状态或版本已发生变化，旧确认已失效，请重新核实");
    }

    const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, operationId)).get();
    if (!detail) {
      throw new BusinessError(404, "NOT_FOUND", "未找到对应的歌单创建详情");
    }

    const beforeList: Array<{ id: string; name: string }> = detail.beforePlaylists ? JSON.parse(detail.beforePlaylists) : [];
    const afterList: Array<{ id: string; name: string }> = detail.afterPlaylists ? JSON.parse(detail.afterPlaylists) : [];
    const beforeIds = new Set(beforeList.map(p => p.id));
    const added = afterList.filter(p => !beforeIds.has(p.id));

    // 分支 1：证据歧义 (新增歌单数量不等于 1)
    if (added.length !== 1) {
      const nextVersion = op.version + 1;
      this.database.transaction(tx => {
        tx.update(operation)
          .set({
            version: nextVersion,
            updatedAt: this.now()
          })
          .where(eq(operation.id, operationId))
          .run();

        tx.insert(adminAuditLog)
          .values({
            id: v7(),
            adminUserId,
            targetType: "operation",
            targetId: operationId,
            action: "resolve_playlist_create",
            reason: validatedReason,
            previousStatus: "needsAdministrator",
            nextStatus: "needsAdministrator",
            result: "ambiguous",
            details: JSON.stringify({ candidateCount: added.length }),
            createdAt: new Date(this.now())
          })
          .run();
      });

      return {
        ok: true,
        action: "resolve_playlist_create",
        targetId: operationId,
        previousStatus: "needsAdministrator",
        nextStatus: "needsAdministrator",
        conclusion: "ambiguous_continued_pause",
        message: "创建证据存在歧义，不猜测目标，保持暂停等待进一步核查"
      };
    }

    // 分支 2：证据唯一
    const candidate = added[0]!;
    const roomRow = this.database.select().from(room).where(eq(room.id, op.roomId)).get();
    const existingBinding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, op.roomId)).get();
    const currentAuth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, op.userId)).get();

    const isBusinessValid = Boolean(
      roomRow &&
      roomRow.ownerUserId === op.userId &&
      !existingBinding &&
      currentAuth &&
      currentAuth.status === "active" &&
      currentAuth.accountId === op.accountId
    );

    const nextVersion = op.version + 1;

    if (isBusinessValid) {
      // 业务仍有效：恢复绑定 (下沉至领域对象 PublicPlaylists 处理，维护单一职责)
      this.database.transaction(tx => {
        this.playlists.restoreCreatedBindingInTx(tx, op.roomId, op.accountId!, candidate.id, candidate.name, op.id);

        tx.insert(adminAuditLog)
          .values({
            id: v7(),
            adminUserId,
            targetType: "operation",
            targetId: operationId,
            action: "resolve_playlist_create",
            reason: validatedReason,
            previousStatus: "needsAdministrator",
            nextStatus: "succeeded",
            result: "succeeded",
            details: JSON.stringify({ outcome: "binding_restored", playlistId: candidate.id }),
            createdAt: new Date(this.now())
          })
          .run();
      });

      const updatedRoom = this.database.select({ version: room.version }).from(room).where(eq(room.id, op.roomId)).get();
      this.eventStream.notifyRoom(this.database, op.roomId, {
        type: "operation",
        resourceId: operationId,
        version: nextVersion
      });
      if (updatedRoom) {
        this.eventStream.notifyRoom(this.database, op.roomId, {
          type: "room",
          resourceId: op.roomId,
          version: updatedRoom.version
        });
      }

      return {
        ok: true,
        action: "resolve_playlist_create",
        targetId: operationId,
        previousStatus: "needsAdministrator",
        nextStatus: "succeeded",
        conclusion: "binding_restored",
        message: `创建证据唯一，已成功为房间恢复公共歌单绑定 (${candidate.id})`
      };
    }

    // 业务已结束：转公共歌单清理任务
    let cleanupId: string;
    this.database.transaction(tx => {
      cleanupId = this.playlists.ensureCleanupInTx(tx, op.userId, op.accountId!, candidate.id, op.id);

      tx.update(publicPlaylistCreation)
        .set({
          playlistId: null,
          step: "stopped",
          recovered: true
        })
        .where(eq(publicPlaylistCreation.operationId, operationId))
        .run();

      tx.update(operation)
        .set({
          status: "stopped",
          accountId: null,
          authorizationId: null,
          generation: null,
          version: nextVersion,
          updatedAt: this.now()
        })
        .where(eq(operation.id, operationId))
        .run();

      tx.insert(adminAuditLog)
        .values({
          id: v7(),
          adminUserId,
          targetType: "operation",
          targetId: operationId,
          action: "resolve_playlist_create",
          reason: validatedReason,
          previousStatus: "needsAdministrator",
          nextStatus: "stopped",
          result: "succeeded",
          details: JSON.stringify({ outcome: "transferred_to_cleanup", playlistId: candidate.id, cleanupId }),
          createdAt: new Date(this.now())
        })
        .run();
    });

    this.playlists.dispatchCleanup(cleanupId!);
    this.eventStream.notifyUser(op.userId, {
      type: "cleanup",
      resourceId: cleanupId!,
      version: 1
    });

    return {
      ok: true,
      action: "resolve_playlist_create",
      targetId: operationId,
      previousStatus: "needsAdministrator",
      nextStatus: "stopped",
      conclusion: "transferred_to_cleanup",
      message: `原业务已结束，唯一新增歌单 (${candidate.id}) 已安全转入公共歌单清理任务`
    };
  }

  authorizeCleanupRetry(
    adminUserId: string,
    cleanupId: string,
    input: { reason: string; expectedVersion: number }
  ): AbnormalActionResult {
    const validatedReason = validateAdminReason(input.reason);

    const cleanup = this.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get();
    if (!cleanup) {
      throw new BusinessError(404, "NOT_FOUND", "未找到对应的公共歌单清理任务");
    }
    if (cleanup.status === "succeeded") {
      throw new BusinessError(409, "INVALID_STATUS", "该清理任务已经完成，无需授权重试");
    }
    if (cleanup.version !== input.expectedVersion) {
      throw new BusinessError(409, "OPERATION_STATE_CHANGED", "操作状态或版本已发生变化，旧确认已失效，请重新核实");
    }

    // 只有在核实原具体目标仍存活（checkFact === target_still_active）且仍应清理后，才允许管理员明确授权单次重试删除
    if (cleanup.checkFact !== "target_still_active") {
      throw new BusinessError(409, "TARGET_NOT_ACTIVE", "未核实原目标仍存活且仍应清理，禁止授权重试删除");
    }

    const nextVersion = cleanup.version + 1;
    this.database.transaction(tx => {
      tx.update(publicPlaylistCleanup)
        .set({
          status: "ready",
          hasSent: false,
          retryAuthorized: true,
          version: nextVersion,
          updatedAt: this.now()
        })
        .where(eq(publicPlaylistCleanup.id, cleanupId))
        .run();

      tx.insert(adminAuditLog)
        .values({
          id: v7(),
          adminUserId,
          targetType: "cleanup",
          targetId: cleanupId,
          action: "authorize_cleanup_retry",
          reason: validatedReason,
          previousStatus: cleanup.status,
          nextStatus: "ready",
          result: "succeeded",
          details: JSON.stringify({ playlistId: cleanup.playlistId }),
          createdAt: new Date(this.now())
        })
        .run();
    });

    this.playlists.dispatchCleanup(cleanupId);

    return {
      ok: true,
      action: "authorize_cleanup_retry",
      targetId: cleanupId,
      previousStatus: cleanup.status,
      nextStatus: "ready",
      conclusion: "retry_authorized",
      message: "已明确授权一次单次删除尝试并加入调度队列"
    };
  }

  verifyManualCleanup(
    adminUserId: string,
    cleanupId: string,
    input: { reason: string; expectedVersion: number }
  ): AbnormalActionResult {
    const validatedReason = validateAdminReason(input.reason);

    const cleanup = this.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get();
    if (!cleanup) {
      throw new BusinessError(404, "NOT_FOUND", "未找到对应的公共歌单清理任务");
    }
    if (cleanup.status === "succeeded") {
      throw new BusinessError(409, "INVALID_STATUS", "该清理任务已经完成，无需手工核验");
    }
    if (cleanup.version !== input.expectedVersion) {
      throw new BusinessError(409, "OPERATION_STATE_CHANGED", "操作状态或版本已发生变化，旧确认已失效，请重新核实");
    }

    // 只有在上游明确拒绝后（needsAdministrator 且 TARGET_PERMISSION / upstream_rejected），才允许记录手工处理
    const isExplicitlyRejected =
      cleanup.status === "needsAdministrator" &&
      (cleanup.lastErrorCode === "TARGET_PERMISSION" || cleanup.checkFact === "upstream_rejected");
    if (!isExplicitlyRejected) {
      throw new BusinessError(409, "INVALID_STATE", "仅在上游明确拒绝删除后，才可记录手工处理并触发只读核验");
    }

    const nextVersion = cleanup.version + 1;
    this.database.transaction(tx => {
      tx.update(publicPlaylistCleanup)
        .set({
          status: "awaitingConfirmation",
          checkFact: "manual_cleanup_pending_verification",
          version: nextVersion,
          updatedAt: this.now()
        })
        .where(eq(publicPlaylistCleanup.id, cleanupId))
        .run();

      tx.insert(adminAuditLog)
        .values({
          id: v7(),
          adminUserId,
          targetType: "cleanup",
          targetId: cleanupId,
          action: "verify_manual_cleanup",
          reason: validatedReason,
          previousStatus: cleanup.status,
          nextStatus: "awaitingConfirmation",
          result: "succeeded",
          details: JSON.stringify({ playlistId: cleanup.playlistId }),
          createdAt: new Date(this.now())
        })
        .run();
    });

    this.playlists.checkCleanupStatus(cleanupId);

    return {
      ok: true,
      action: "verify_manual_cleanup",
      targetId: cleanupId,
      previousStatus: cleanup.status,
      nextStatus: "awaitingConfirmation",
      conclusion: "manual_verification_triggered",
      message: "已记录房主官方客户端手工处理，已触发服务端只读核验"
    };
  }

  async resumeRiskPause(
    adminUserId: string,
    accountId: string,
    input: { reason: string }
  ): Promise<AbnormalActionResult> {
    const validatedReason = validateAdminReason(input.reason);

    const acc = this.database.select().from(upstreamAccount).where(eq(upstreamAccount.accountId, accountId)).get();
    if (!acc || !acc.paused) {
      throw new BusinessError(409, "ACCOUNT_NOT_PAUSED", "该网易云账号当前并未处于风控暂停状态");
    }

    const auth = this.database
      .select()
      .from(neteaseAuthorization)
      .where(and(eq(neteaseAuthorization.accountId, accountId), eq(neteaseAuthorization.status, "active")))
      .get();
    if (!auth || !auth.credentials) {
      throw new BusinessError(409, "AUTH_UNAVAILABLE", "该账号在系统中无有效活跃授权，无法恢复风控暂停");
    }

    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, {
        authorizationId: auth.id,
        accountId: auth.accountId,
        generation: auth.generation
      });
    } catch {
      throw new BusinessError(409, "AUTH_UNAVAILABLE", "该账号授权凭据无法解密核验，无法恢复风控暂停");
    }

    // 重新核实当前真实账号：调度执行一次只读 identity 调用，核实网易云服务端当前识别的账号
    try {
      const verifyResult = await this.scheduler.executeMemoryTask(
        accountId,
        async () => {
          return this.adapter.call({ operation: "identity", cookie });
        },
        { allowPaused: true }
      );
      if (!verifyResult.ok || verifyResult.data.accountId !== accountId) {
        throw new BusinessError(409, "AUTH_UNAVAILABLE", "上游真实账号核验未通过，无法恢复风控暂停");
      }
    } catch (err) {
      if (err instanceof BusinessError) throw err;
      throw new BusinessError(409, "AUTH_UNAVAILABLE", "上游真实账号核验通信失败，无法恢复风控暂停");
    }

    this.database.transaction(tx => {
      tx.insert(adminAuditLog)
        .values({
          id: v7(),
          adminUserId,
          targetType: "account",
          targetId: accountId,
          action: "resume_risk_pause",
          reason: validatedReason,
          previousStatus: "paused",
          nextStatus: "active",
          result: "succeeded",
          details: JSON.stringify({ accountId, pauseReason: acc.pauseReason ?? "RATE_LIMITED" }),
          createdAt: new Date(this.now())
        })
        .run();
    });

    this.scheduler.resume(accountId);

    return {
      ok: true,
      action: "resume_risk_pause",
      targetId: accountId,
      previousStatus: "paused",
      nextStatus: "active",
      conclusion: "risk_pause_resumed",
      message: "风控暂停已明确恢复，已重新核实有效授权与账号状态"
    };
  }
}
