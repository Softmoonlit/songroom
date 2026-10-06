import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { operation, room, upstreamAccount } from "../db/schema.js";

export type Operation = typeof operation.$inferSelect;

export type OperationHandler = {
  claim: (row: Operation) => boolean;
  execute: (row: Operation) => Promise<void>;
  recover?: () => void;
};

/**
 * 单进程统一上游调度器。
 * 全站最多 2 个请求并行、每个真实账号严格串行且启动间隔至少 1 秒；
 * 候选按最久未获得执行机会者 (lastGranted, createdAt, id) 轮转，每次上游请求后让出。
 * 无 Redis、无内存队列真相、无通用工作流引擎，纯 SQLite 短事务认领。
 */
export class UpstreamScheduler {
  #started = false;
  #stopped = false;
  #pump: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #handlers = new Map<Operation["kind"], OperationHandler>();

  constructor(readonly database: AppDatabase, readonly now: () => number = () => Date.now()) {}

  get isStopped(): boolean { return this.#stopped; }
  get isStarted(): boolean { return this.#started; }

  register(kind: Operation["kind"], handler: OperationHandler): void {
    this.#handlers.set(kind, handler);
  }

  admissionCode(accountId: string): "UPSTREAM_QUEUE_FULL" | "ACCOUNT_PAUSED" | null {
    if (this.paused(accountId)) return "ACCOUNT_PAUSED";
    const count = this.database.select({ count: sql<number>`count(*)` }).from(operation)
      .where(and(eq(operation.accountId, accountId), sql`${operation.status} IN ('queued', 'processing')`)).get()!.count;
    return count >= 20 ? "UPSTREAM_QUEUE_FULL" : null;
  }

  paused(accountId: string): boolean {
    return this.database.select().from(upstreamAccount).where(eq(upstreamAccount.accountId, accountId)).get()?.paused ?? false;
  }

  pause(accountId: string): void {
    this.database.transaction(tx => {
      tx.insert(upstreamAccount).values({ accountId, paused: true })
        .onConflictDoUpdate({ target: upstreamAccount.accountId, set: { paused: true } }).run();
      const affected = tx.select({ roomId: operation.roomId }).from(operation)
        .where(and(eq(operation.accountId, accountId), eq(operation.status, "queued"))).all();
      tx.update(operation).set({ status: "needsAdministrator", errorCode: "ACCOUNT_PAUSED", updatedAt: this.now() })
        .where(and(eq(operation.accountId, accountId), eq(operation.status, "queued"))).run();
      for (const item of affected) {
        tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, item.roomId)).run();
      }
    });
  }

  start(): void {
    if (this.#started && !this.#stopped) return;
    if (this.#pump) throw new Error("重新启动前必须等待 settle 完成，不能撤销在途执行权");
    this.#started = true;
    this.#stopped = false;
    this.database.transaction(tx => {
      // 单实例启动恢复：执行句柄已消失，启动预算与账号暂停仍保留。
      tx.update(upstreamAccount).set({ runningOperationId: null }).run();
      for (const handler of this.#handlers.values()) {
        handler.recover?.();
      }
    });
    this.kick();
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }

  async settle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  kick(): void {
    if (!this.#started || this.#stopped) return;
    if (this.#pump) { this.#wake?.(); return; }
    // 计时器只唤醒已提交的账号启动预算；发送资格与唯一执行权始终由短事务判定。
    this.#pump = Promise.resolve().then(async () => {
      while (!this.#stopped) {
        const claimed = this.#claimNext();
        if (claimed) {
          const task = claimed.handler.execute(claimed.row).finally(() => {
            this.#release(claimed.row);
            this.#inFlight.delete(task);
            this.#wake?.();
          });
          this.#inFlight.add(task);
          continue;
        }
        const queued = this.database.select().from(operation).where(eq(operation.status, "queued")).all();
        if (!queued.length && !this.#inFlight.size) break;
        const nextStartAt = this.nextStartAt();
        await new Promise<void>(resolve => {
          const wake = () => { if (timer) clearTimeout(timer); this.#wake = undefined; resolve(); };
          const timer = nextStartAt !== undefined ? setTimeout(wake, Math.max(1, nextStartAt - this.now())) : undefined;
          this.#wake = wake;
        });
      }
      await Promise.all(this.#inFlight);
    }).finally(() => {
      this.#pump = undefined;
      if (!this.#stopped && this.database.select({ id: operation.id }).from(operation).where(eq(operation.status, "queued")).get()) {
        this.kick();
      }
    });
  }

  #canStart(accountId: string): boolean {
    const accounts = this.database.select().from(upstreamAccount).all();
    const account = accounts.find(row => row.accountId === accountId);
    return accounts.filter(row => row.runningOperationId).length < 2
      && !account?.paused && !account?.runningOperationId && (!account || account.nextStartAt <= this.now());
  }

  #claimNext(): { row: Operation; handler: OperationHandler } | undefined {
    return this.database.transaction(tx => {
      for (const row of tx.select().from(operation).where(eq(operation.status, "queued")).orderBy(operation.lastGranted, operation.createdAt, operation.id).all()) {
        const handler = this.#handlers.get(row.kind);
        if (!handler) continue;
        if (this.paused(row.accountId!)) {
          tx.update(operation).set({ status: "needsAdministrator", errorCode: "ACCOUNT_PAUSED", updatedAt: this.now() }).where(eq(operation.id, row.id)).run();
          tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, row.roomId)).run();
          continue;
        }
        if (!this.#canStart(row.accountId!)) continue;
        const ready = handler.claim(row);
        if (!ready) continue;
        const lastGranted = Math.max(this.now(), tx.select({ value: sql<number>`coalesce(max(${operation.lastGranted}), 0) + 1` }).from(operation).get()!.value);
        const claimed = tx.update(operation).set({ status: "processing", errorCode: null, lastGranted, updatedAt: this.now() })
          .where(and(eq(operation.id, row.id), eq(operation.status, "queued"))).run();
        if (!claimed.changes) continue;
        tx.insert(upstreamAccount).values({ accountId: row.accountId!, nextStartAt: this.now() + 1000, runningOperationId: row.id })
          .onConflictDoUpdate({ target: upstreamAccount.accountId, set: { nextStartAt: this.now() + 1000, runningOperationId: row.id } }).run();
        return { row, handler };
      }
      return undefined;
    });
  }

  #release(row: Operation): void {
    this.database.update(upstreamAccount).set({ runningOperationId: null })
      .where(and(eq(upstreamAccount.accountId, row.accountId!), eq(upstreamAccount.runningOperationId, row.id))).run();
  }

  nextStartAt(): number | undefined {
    const accounts = this.database.select().from(upstreamAccount).all();
    if (accounts.filter(account => account.runningOperationId).length >= 2) return undefined;
    const deadlines = this.database.select().from(operation).where(eq(operation.status, "queued")).all().flatMap(row => {
      const account = accounts.find(account => account.accountId === row.accountId);
      return account && !account.paused && !account.runningOperationId ? [account.nextStartAt] : [];
    });
    return deadlines.length ? Math.min(...deadlines) : undefined;
  }
}
