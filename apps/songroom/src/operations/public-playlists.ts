import { v7 } from "uuid";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt, neteaseAuthorization, operation, publicPlaylistBinding, publicPlaylistCreation, room, roomMembership, upstreamAccount } from "../db/schema.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterErrorCode, NeteaseAdapter } from "../netease/protocol.js";
import { BusinessError } from "../shared/errors.js";
import { publicPlaylistCreateCommand, type PublicPlaylistCreateCommand, type PublicPlaylistView } from "../shared/public-playlist-contracts.js";

type Operation = typeof operation.$inferSelect;
type ClaimedRequest = { row: Operation; detail: typeof publicPlaylistCreation.$inferSelect; cookie: string };
type Status = Operation["status"];
const TERMINAL_RETENTION_MS = 86_400_000;
const terminal = (status: Status) => ["succeeded", "failed", "stopped"].includes(status);
const authorizationErrors = new Set(["AUTH_UNAVAILABLE", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH"]);

/** 只接受公共歌单创建意图。start 必须在 HTTP 成功监听后调用；事务始终同步。 */
export class PublicPlaylists {
  #started = false;
  #stopped = false;
  #pump: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  readonly #inFlight = new Set<Promise<void>>();

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
      : pending ? currentOperation?.errorCode === "TARGET_PERMISSION" ? "TARGET_BLOCKED" : "OPERATION_PENDING" : !this.#authorization(userId) ? "NETEASE_AUTH_REQUIRED" : this.#admissionCode(this.#authorization(userId)!.accountId);
    return { playlist: binding ? { id: binding.playlistId, name: binding.name } : null,
      operation: currentOperation ? { id: currentOperation.id, status: currentOperation.status, errorCode: currentOperation.errorCode } : null,
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
      const admissionCode = this.#admissionCode(auth.accountId);
      if (admissionCode) throw new BusinessError(409, admissionCode, admissionCode === "ACCOUNT_PAUSED" ? "网易云账号已暂停，请联系管理员" : "网易云账号操作队列已满");
      tx.insert(upstreamAccount).values({ accountId: auth.accountId }).onConflictDoNothing().run();
      const id = v7();
      tx.insert(operation).values({ id, kind: "createPublicPlaylist", userId, roomId, accountId: auth.accountId,
        authorizationId: auth.id, generation: auth.generation, lastGranted: this.now(), status: "queued", createdAt: this.now(), updatedAt: this.now() }).run();
      tx.insert(publicPlaylistCreation).values({ operationId: id, name: `songroom-${current.name}-公共`, step: "ready" }).run();
      recordCommandResource(tx, prepared, id, this.now());
      this.#bump(roomId);
      return { replay: false, view: this.#view(userId, roomId, id) };
    });
    this.#kick();
    return accepted;
  }

  #admissionCode(accountId: string): "UPSTREAM_QUEUE_FULL" | "ACCOUNT_PAUSED" | null {
    if (this.database.select().from(upstreamAccount).where(eq(upstreamAccount.accountId, accountId)).get()?.paused) return "ACCOUNT_PAUSED";
    const count = this.database.select({ count: sql<number>`count(*)` }).from(operation).where(and(eq(operation.accountId, accountId), sql`${operation.status} IN ('queued', 'processing')`)).get()!.count;
    return count >= 20 ? "UPSTREAM_QUEUE_FULL" : null;
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

  start(): void {
    if (this.#started && !this.#stopped) return;
    if (this.#pump) throw new Error("重新启动前必须等待 settle 完成，不能撤销在途执行权");
    this.#started = true; this.#stopped = false;
    this.database.transaction(tx => {
      this.#prune();
      // 单实例启动恢复：执行句柄已消失，启动预算与账号暂停仍保留。
      tx.update(upstreamAccount).set({ runningOperationId: null }).run();
      for (const row of tx.select().from(operation).all()) {
        if (terminal(row.status)) continue;
        const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
        if (!detail) { this.#status(row.id, "needsAdministrator"); continue; }
        if (["sending", "unknown"].includes(detail.step)) this.#status(row.id, "awaitingConfirmation", row.errorCode);
        else if (row.status !== "waitingAuthorization" && (detail.step === "confirming" || row.status === "processing")) this.#status(row.id, "queued", row.errorCode);
        if (detail.step === "verified") tx.update(publicPlaylistCreation).set({ step: "ready" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
      }
    });
    this.#kick();
  }

  stop(): void { this.#stopped = true; this.#wake?.(); }

  async settle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  #kick(): void {
    if (!this.#started || this.#stopped) return;
    if (this.#pump) { this.#wake?.(); return; }
    // 计时器只唤醒已提交的账号启动预算；发送资格与唯一执行权始终由事务判定。
    this.#pump = Promise.resolve().then(async () => {
      while (!this.#stopped) {
        const claimed = this.#claim();
        if (claimed) {
          const task = this.#execute(claimed).finally(() => {
            this.#inFlight.delete(task);
            this.#wake?.();
          });
          this.#inFlight.add(task);
          continue;
        }
        const accounts = this.database.select().from(upstreamAccount).all();
        const queued = this.database.select().from(operation).where(eq(operation.status, "queued")).all();
        if (!queued.length && !this.#inFlight.size) break;
        const deadlines = accounts.filter(account => account.runningOperationId).length >= 2 ? [] : queued.flatMap(row => {
          const account = accounts.find(account => account.accountId === row.accountId);
          return account && !account.paused && !account.runningOperationId ? [account.nextStartAt] : [];
        });
        await new Promise<void>(resolve => {
          const wake = () => { if (timer) clearTimeout(timer); this.#wake = undefined; resolve(); };
          const timer = deadlines.length ? setTimeout(wake, Math.max(1, Math.min(...deadlines) - this.now())) : undefined;
          this.#wake = wake;
        });
      }
      await Promise.all(this.#inFlight);
    }).finally(() => {
      this.#pump = undefined;
      if (!this.#stopped && this.database.select({ id: operation.id }).from(operation).where(eq(operation.status, "queued")).get()) this.#kick();
    });
  }

  #claim() {
    return this.database.transaction(tx => {
      const accounts = tx.select().from(upstreamAccount).all();
      const running = accounts.filter(account => account.runningOperationId).length;
      for (const row of tx.select().from(operation).where(eq(operation.status, "queued")).orderBy(operation.lastGranted, operation.createdAt, operation.id).all()) {
        const detail = tx.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, row.id)).get();
        if (!detail) { this.#status(row.id, "needsAdministrator"); continue; }
        if (detail.step === "confirming") {
          try { this.#bind(row); } catch { this.#status(row.id, "needsAdministrator"); }
          continue;
        }
        if (["sending", "unknown"].includes(detail.step)) { this.#status(row.id, "awaitingConfirmation", row.errorCode); continue; }
        const account = accounts.find(account => account.accountId === row.accountId);
        if (account?.paused) { this.#status(row.id, "needsAdministrator", "ACCOUNT_PAUSED"); continue; }
        const condition = this.#conditions(row);
        if (condition !== "valid") { this.#status(row.id, condition, condition === "waitingAuthorization" ? this.#authorizationError(row) : null); continue; }
        if (running >= 2 || account?.runningOperationId || (account && account.nextStartAt > this.now())) continue;
        const auth = this.#authorization(row.userId)!;
        let cookie: string;
        try { cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation }); }
        catch { this.#status(row.id, "waitingAuthorization", "AUTH_UNAVAILABLE"); continue; }
        const lastGranted = Math.max(this.now(), tx.select({ value: sql<number>`coalesce(max(${operation.lastGranted}), 0) + 1` }).from(operation).get()!.value);
        const claimed = tx.update(operation).set({ status: "processing", errorCode: null, lastGranted, updatedAt: this.now() }).where(and(eq(operation.id, row.id), eq(operation.status, "queued"))).run();
        if (!claimed.changes) continue;
        tx.insert(upstreamAccount).values({ accountId: row.accountId!, nextStartAt: this.now() + 1000, runningOperationId: row.id }).onConflictDoUpdate({ target: upstreamAccount.accountId, set: { nextStartAt: this.now() + 1000, runningOperationId: row.id } }).run();
        if (detail.step === "verified") tx.update(publicPlaylistCreation).set({ step: "sending" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
        this.#bump(row.roomId);
        return { row, detail, cookie };
      }
      return undefined;
    });
  }

  #authorizationError(row: Operation): "ACCOUNT_MISMATCH" | "AUTH_UNAVAILABLE" {
    const auth = this.#authorization(row.userId);
    return auth && auth.accountId !== row.accountId ? "ACCOUNT_MISMATCH" : "AUTH_UNAVAILABLE";
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
        this.#status(row.id, condition === "stopped" ? "needsAdministrator" : condition, condition === "waitingAuthorization" ? this.#authorizationError(row) : null);
        return;
      }
      tx.insert(publicPlaylistBinding).values({ roomId: row.roomId, accountId: row.accountId!, playlistId: detail.playlistId!, name: detail.name, creationOperationId: row.id }).run();
      this.#status(row.id, "succeeded");
    });
  }

  #pauseAccount(accountId: string): void {
    this.database.update(upstreamAccount).set({ paused: true }).where(eq(upstreamAccount.accountId, accountId)).run();
    for (const pending of this.database.select().from(operation).where(and(eq(operation.accountId, accountId), eq(operation.status, "queued"))).all()) {
      this.#status(pending.id, "needsAdministrator", "ACCOUNT_PAUSED");
    }
  }

  #readFailure(row: Operation, code: AdapterErrorCode): void {
    if (code === "RATE_LIMITED") this.#pauseAccount(row.accountId!);
    this.#status(row.id, authorizationErrors.has(code) ? "waitingAuthorization" : ["RATE_LIMITED", "TARGET_PERMISSION"].includes(code) ? "needsAdministrator" : "failed", code);
  }

  async #execute(claimed: ClaimedRequest): Promise<void> {
    const { row, detail, cookie } = claimed;
    try {
      if (detail.step === "ready") {
        const identity = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId! });
        this.database.transaction(tx => {
          if (!identity.ok) { this.#readFailure(row, identity.error.code); return; }
          if (identity.data.accountId !== row.accountId) { this.#status(row.id, "waitingAuthorization", "ACCOUNT_MISMATCH"); return; }
          const condition = this.#conditions(row);
          if (condition !== "valid") { this.#status(row.id, condition, condition === "waitingAuthorization" ? this.#authorizationError(row) : null); return; }
          tx.update(publicPlaylistCreation).set({ step: "verified" }).where(eq(publicPlaylistCreation.operationId, row.id)).run();
          this.#status(row.id, "queued");
        });
        return;
      }
      const result = await this.adapter.call({ operation: "playlistCreate", cookie, name: detail.name });
      this.database.transaction(tx => {
        if (!result.ok) {
          if (result.error.code === "RATE_LIMITED") this.#pauseAccount(row.accountId!);
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
    } finally {
      this.database.update(upstreamAccount).set({ runningOperationId: null }).where(and(eq(upstreamAccount.accountId, row.accountId!), eq(upstreamAccount.runningOperationId, row.id))).run();
    }
  }
}
