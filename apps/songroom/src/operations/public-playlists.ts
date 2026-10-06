import { v7 } from "uuid";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt, neteaseAuthorization, operation, publicPlaylistBinding, publicPlaylistCreation, room, roomMembership } from "../db/schema.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import { CredentialVault } from "../netease/credentials.js";
import type { NeteaseAdapter } from "../netease/protocol.js";
import { BusinessError } from "../shared/errors.js";
import { publicPlaylistCreateCommand, type PublicPlaylistCreateCommand, type PublicPlaylistView } from "../shared/public-playlist-contracts.js";

type Operation = typeof operation.$inferSelect;
type Status = Operation["status"];
const TERMINAL_RETENTION_MS = 86_400_000;
const terminal = (status: Status) => ["succeeded", "failed", "stopped"].includes(status);
const authorizationErrors = new Set(["AUTH_UNAVAILABLE", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH"]);

/** 只接受公共歌单创建意图。start 必须在 HTTP 成功监听后调用；事务始终同步。 */
export class PublicPlaylists {
  #started = false;
  #stopped = false;
  #pump: Promise<void> | undefined;

  constructor(readonly database: AppDatabase, readonly adapter: NeteaseAdapter, readonly vault: CredentialVault, readonly now = () => Date.now()) {}

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
    const disabledReason = current.ownerUserId !== userId ? "OWNER_ONLY" : binding ? "PUBLIC_PLAYLIST_EXISTS"
      : pending ? "OPERATION_PENDING" : !this.#authorization(userId) ? "NETEASE_AUTH_REQUIRED" : null;
    return { playlist: binding ? { id: binding.playlistId, name: binding.name } : null,
      operation: currentOperation ? { id: currentOperation.id, status: currentOperation.status } : null,
      allowedActions: disabledReason ? [] : ["createPublicPlaylist"], disabledReason, version: current.version };
  }

  read(userId: string, roomId: string): PublicPlaylistView { return this.#view(userId, roomId); }

  create(userId: string, roomId: string, input: PublicPlaylistCreateCommand): { replay: boolean; view: PublicPlaylistView } {
    if (this.#stopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
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
      const id = v7();
      tx.insert(operation).values({ id, kind: "createPublicPlaylist", userId, roomId, accountId: auth.accountId,
        authorizationId: auth.id, generation: auth.generation, status: "queued", createdAt: this.now(), updatedAt: this.now() }).run();
      tx.insert(publicPlaylistCreation).values({ operationId: id, name: `songroom-${current.name}-公共`, step: "ready" }).run();
      recordCommandResource(tx, prepared, id, this.now());
      this.#bump(roomId);
      return { replay: false, view: this.#view(userId, roomId, id) };
    });
    this.#kick();
    return accepted;
  }

  #bump(roomId: string): void {
    this.database.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
  }

  #status(id: string, status: Status): void {
    this.database.transaction(tx => {
      const row = tx.select().from(operation).where(eq(operation.id, id)).get();
      if (!row || row.status === status) return;
      tx.update(operation).set({ status, updatedAt: this.now(), ...(terminal(status) ? { accountId: null, authorizationId: null, generation: null } : {}) }).where(eq(operation.id, id)).run();
      if (terminal(status)) tx.delete(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, id)).run();
      else if (status === "awaitingConfirmation") tx.update(publicPlaylistCreation).set({ step: "unknown" }).where(eq(publicPlaylistCreation.operationId, id)).run();
      this.#bump(row.roomId);
    });
  }

  #prune(): void {
    this.database.delete(operation).where(sql`${operation.status} IN ('succeeded', 'failed', 'stopped') AND ${operation.updatedAt} <= ${this.now() - TERMINAL_RETENTION_MS}`).run();
    this.database.delete(commandReceipt).where(sql`${commandReceipt.expiresAt} <= ${this.now()}`).run();
  }

  start(): void {
    if (this.#started && !this.#stopped) return;
    this.#started = true; this.#stopped = false;
    this.database.transaction(tx => {
      this.#prune();
      for (const row of tx.select().from(operation).all()) {
        if (terminal(row.status)) continue;
        const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
        if (!detail) { this.#status(row.id, "needsAdministrator"); continue; }
        if (["sending", "unknown"].includes(detail.step)) this.#status(row.id, "awaitingConfirmation");
        else if (detail.step === "confirming" || row.status === "processing" || row.status === "waitingAuthorization") this.#status(row.id, "queued");
      }
    });
    this.#kick();
  }

  stop(): void { this.#stopped = true; }

  async settle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  #kick(): void {
    if (!this.#started || this.#stopped || this.#pump) return;
    // Promise 微任务只保证受理先返回，不通过计时器规避在途请求或事务竞态。
    this.#pump = Promise.resolve().then(async () => {
      while (!this.#stopped) {
        const next = this.database.select().from(operation).where(eq(operation.status, "queued")).orderBy(operation.createdAt, operation.id).get();
        if (!next) break;
        await this.#execute(next);
      }
    }).finally(() => {
      this.#pump = undefined;
      // 命令可能在空泵退出与 finally 清除执行句柄之间受理；再次检查持久队列。
      if (!this.#stopped && this.database.select({ id: operation.id }).from(operation).where(eq(operation.status, "queued")).get()) this.#kick();
    });
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
        this.#status(row.id, condition === "stopped" ? "needsAdministrator" : condition);
        return;
      }
      tx.insert(publicPlaylistBinding).values({ roomId: row.roomId, accountId: row.accountId!, playlistId: detail.playlistId!, name: detail.name, creationOperationId: row.id }).run();
      this.#status(row.id, "succeeded");
    });
  }

  async #execute(row: Operation): Promise<void> {
    const detail = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
    if (!detail) { this.#status(row.id, "needsAdministrator"); return; }
    if (["sending", "unknown"].includes(detail.step)) { this.#status(row.id, "awaitingConfirmation"); return; }
    this.#status(row.id, "processing");
    try {
      if (detail.step === "confirming") { this.#bind(row); return; }
      const condition = this.#conditions(row);
      if (condition !== "valid") { this.#status(row.id, condition); return; }
      const auth = this.#authorization(row.userId)!;
      let cookie: string;
      try { cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation }); }
      catch { this.#status(row.id, "waitingAuthorization"); return; }
      const identity = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId! });
      if (!identity.ok) {
        this.#status(row.id, authorizationErrors.has(identity.error.code) ? "waitingAuthorization" : identity.error.code === "RATE_LIMITED" ? "needsAdministrator" : "failed");
        return;
      }
      if (identity.data.accountId !== row.accountId) { this.#status(row.id, "waitingAuthorization"); return; }
      const ready = this.database.transaction(tx => {
        const condition = this.#conditions(row);
        if (condition !== "valid") { this.#status(row.id, condition); return false; }
        if (this.#stopped) { this.#status(row.id, "queued"); return false; }
        tx.update(publicPlaylistCreation).set({ step: "sending" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
        return true;
      });
      if (!ready) return;
      const result = await this.adapter.call({ operation: "playlistCreate", cookie, name: detail.name });
      if (!result.ok) { this.#status(row.id, "awaitingConfirmation"); return; }
      this.database.transaction(tx => {
        tx.update(publicPlaylistCreation).set({ step: "confirming", playlistId: result.data.playlistId }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
        this.#bump(row.roomId);
      });
      this.#bind(row);
    } catch {
      const saved = this.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
      this.#status(row.id, saved?.step === "confirming" ? "needsAdministrator" : saved?.step === "sending" ? "awaitingConfirmation" : "failed");
    }
  }
}
