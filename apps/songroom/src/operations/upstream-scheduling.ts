import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { operation, upstreamAccount } from "../db/schema.js";

type Operation = typeof operation.$inferSelect;

/** 单进程持久请求预算；认领由业务发送意图事务调用，不保存内存队列。 */
export class UpstreamScheduling {
  constructor(readonly database: AppDatabase, readonly now: () => number) {}

  admissionCode(accountId: string): "UPSTREAM_QUEUE_FULL" | "ACCOUNT_PAUSED" | null {
    if (this.paused(accountId)) return "ACCOUNT_PAUSED";
    const count = this.database.select({ count: sql<number>`count(*)` }).from(operation)
      .where(and(eq(operation.accountId, accountId), sql`${operation.status} IN ('queued', 'processing')`)).get()!.count;
    return count >= 20 ? "UPSTREAM_QUEUE_FULL" : null;
  }

  paused(accountId: string): boolean {
    return this.database.select().from(upstreamAccount).where(eq(upstreamAccount.accountId, accountId)).get()?.paused ?? false;
  }

  // 仅在单实例冷启动时释放已消失的执行权，不改变间隔和风控记录。
  recover(): void {
    this.database.update(upstreamAccount).set({ runningOperationId: null }).run();
  }

  canStart(accountId: string): boolean {
    const accounts = this.database.select().from(upstreamAccount).all();
    const account = accounts.find(row => row.accountId === accountId);
    return accounts.filter(row => row.runningOperationId).length < 2
      && !account?.paused && !account?.runningOperationId && (!account || account.nextStartAt <= this.now());
  }

  /** 与业务 sending 意图处于同一短事务；条件更新只允许一个执行权。 */
  claim(row: Operation): boolean {
    if (!this.canStart(row.accountId!)) return false;
    const lastGranted = Math.max(this.now(), this.database.select({ value: sql<number>`coalesce(max(${operation.lastGranted}), 0) + 1` }).from(operation).get()!.value);
    const claimed = this.database.update(operation).set({ status: "processing", errorCode: null, lastGranted, updatedAt: this.now() })
      .where(and(eq(operation.id, row.id), eq(operation.status, "queued"))).run();
    if (!claimed.changes) return false;
    this.database.insert(upstreamAccount).values({ accountId: row.accountId!, nextStartAt: this.now() + 1000, runningOperationId: row.id })
      .onConflictDoUpdate({ target: upstreamAccount.accountId, set: { nextStartAt: this.now() + 1000, runningOperationId: row.id } }).run();
    return true;
  }

  release(row: Operation): void {
    this.database.update(upstreamAccount).set({ runningOperationId: null })
      .where(and(eq(upstreamAccount.accountId, row.accountId!), eq(upstreamAccount.runningOperationId, row.id))).run();
  }

  pause(accountId: string): void {
    this.database.insert(upstreamAccount).values({ accountId, paused: true }).onConflictDoUpdate({ target: upstreamAccount.accountId, set: { paused: true } }).run();
  }

  /** 已提交预算的下一次唤醒时间；在途完成与新受理另行唤醒。 */
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
