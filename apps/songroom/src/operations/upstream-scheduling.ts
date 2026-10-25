import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { operation, room, upstreamAccount } from "../db/schema.js";
import type { EventStreamService } from "../events/event-stream.js";
import { BusinessError } from "../shared/errors.js";
import { v7 } from "uuid";

export type Operation = typeof operation.$inferSelect;

export type OperationHandler = {
  claim: (row: Operation) => boolean;
  execute: (row: Operation) => Promise<void>;
  recover?: () => void;
};

export type MemoryTaskKind = "serial" | "read";

type MemoryTask<T = any> = {
  id: string;
  accountId: string;
  kind: MemoryTaskKind;
  createdAt: number;
  lastGranted: number;
  allowPaused?: boolean;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
};

type ClaimedTask =
  | { type: "operation"; row: Operation; handler: OperationHandler }
  | { type: "memory"; task: MemoryTask };

const MAX_RUNNING_ACCOUNTS = 2;
const MAX_READ_TASKS = 4;

/**
 * 单进程统一上游调度器。
 * 写入与默认内存任务按真实账号严格串行；明确标记的只读任务可在同账号读槽内并行。
 * 持久操作全站最多 2 个真实账号并行，候选按最久未获得执行机会者轮转。
 * 无 Redis、无内存队列真相、无通用工作流引擎，纯 SQLite 短事务认领。
 */
export class UpstreamScheduler {
  #started = false;
  #stopped = false;
  #pump: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #handlers = new Map<Operation["kind"], OperationHandler>();
  readonly #memoryQueue: MemoryTask[] = [];
  readonly #runningReadAccounts = new Map<string, number>();
  readonly eventStream?: EventStreamService;
  readonly now: () => number;

  constructor(
    readonly database: AppDatabase,
    eventStreamOrNow?: EventStreamService | (() => number),
    now: () => number = () => Date.now()
  ) {
    if (typeof eventStreamOrNow === "function") {
      this.now = eventStreamOrNow;
      this.eventStream = undefined;
    } else {
      this.eventStream = eventStreamOrNow;
      this.now = now;
    }
  }

  get isStopped(): boolean { return this.#stopped; }
  get isStarted(): boolean { return this.#started; }

  register(kind: Operation["kind"], handler: OperationHandler): void {
    this.#handlers.set(kind, handler);
  }

  executeMemoryTask<T>(accountId: string, run: () => Promise<T>, options?: { allowPaused?: boolean; kind?: MemoryTaskKind }): Promise<T> {
    if (this.#stopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const allowPaused = options?.allowPaused ?? false;
    const kind = options?.kind ?? "serial";
    if (!allowPaused && this.paused(accountId)) throw new BusinessError(409, "ACCOUNT_PAUSED", "网易云账号已暂停，请联系管理员");
    if (!allowPaused) {
      const code = this.admissionCode(accountId);
      if (code) throw new BusinessError(409, code, code === "ACCOUNT_PAUSED" ? "网易云账号已暂停，请联系管理员" : "网易云账号操作队列已满");
    }
    const id = `mem-${v7()}`;
    const now = this.now();
    return new Promise<T>((resolve, reject) => {
      this.#memoryQueue.push({
        id,
        accountId,
        kind,
        createdAt: now,
        lastGranted: now,
        allowPaused,
        run,
        resolve,
        reject
      });
      this.kick();
    });
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

  pause(accountId: string, reason?: string): void {
    for (let i = this.#memoryQueue.length - 1; i >= 0; i--) {
      if (this.#memoryQueue[i].accountId === accountId) {
        const [cancelled] = this.#memoryQueue.splice(i, 1);
        cancelled.reject(new BusinessError(409, "ACCOUNT_PAUSED", "网易云账号已暂停，请联系管理员"));
      }
    }
    let notifyList: Array<{ roomId: string; opId: string; opVersion: number; roomVersion: number }> = [];
    this.database.transaction(tx => {
      tx.insert(upstreamAccount).values({ accountId, paused: true, pauseReason: reason ?? "RATE_LIMITED" })
        .onConflictDoUpdate({ target: upstreamAccount.accountId, set: { paused: true, pauseReason: reason ?? "RATE_LIMITED" } }).run();
      const affected = tx.select({ id: operation.id, roomId: operation.roomId }).from(operation)
        .where(and(eq(operation.accountId, accountId), eq(operation.status, "queued"))).all();
      tx.update(operation).set({
        status: "needsAdministrator",
        errorCode: "ACCOUNT_PAUSED",
        version: sql`${operation.version} + 1`,
        updatedAt: this.now()
      }).where(and(eq(operation.accountId, accountId), eq(operation.status, "queued"))).run();
      for (const item of affected) {
        tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, item.roomId)).run();
        const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, item.id)).get();
        const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, item.roomId)).get();
        if (updatedOp && updatedRoom) {
          notifyList.push({ roomId: item.roomId, opId: item.id, opVersion: updatedOp.version, roomVersion: updatedRoom.version });
        }
      }
    });
    for (const item of notifyList) {
      this.eventStream?.notifyRoom(this.database, item.roomId, { type: "operation", resourceId: item.opId, version: item.opVersion });
      this.eventStream?.notifyRoom(this.database, item.roomId, { type: "room", resourceId: item.roomId, version: item.roomVersion });
    }
  }

  resume(accountId: string): void {
    this.database.transaction(tx => {
      tx.update(upstreamAccount)
        .set({ paused: false, pauseReason: null })
        .where(eq(upstreamAccount.accountId, accountId))
        .run();
    });
    this.kick();
  }

  start(): void {
    if (this.#started && !this.#stopped) return;
    if (this.#pump) throw new Error("重新启动前必须等待 settle 完成，不能撤销在途执行权");
    this.#started = true;
    this.#stopped = false;
    this.database.transaction(tx => {
      // 单实例启动恢复：执行句柄已消失，账号暂停仍保留。
      tx.update(upstreamAccount).set({ runningOperationId: null }).run();
      for (const handler of this.#handlers.values()) {
        handler.recover?.();
      }
    });
    this.kick();
  }

  stop(): void {
    this.#stopped = true;
    for (const task of this.#memoryQueue.splice(0)) {
      task.reject(new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试"));
    }
    this.#wake?.();
  }

  async settle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  kick(): void {
    if (!this.#started || this.#stopped) return;
    if (this.#pump) { this.#wake?.(); return; }
    // 完成或新任务唤醒调度；发送资格与唯一执行权始终由短事务判定。
    this.#pump = Promise.resolve().then(async () => {
      while (!this.#stopped) {
        const queuedBefore = this.database.select({ id: operation.id }).from(operation)
          .where(eq(operation.status, "queued")).orderBy(operation.id).all();
        const memoryBefore = this.#memoryQueue.length;
        const claimed = this.#claimNext();
        if (claimed) {
          let task: Promise<void>;
          if (claimed.type === "operation") {
            task = claimed.handler.execute(claimed.row).finally(() => {
              this.#release(
                claimed.row.accountId!,
                claimed.row.id,
                "serial"
              );
              this.#inFlight.delete(task);
              this.#wake?.();
            });
          } else {
            task = Promise.resolve()
              .then(() => claimed.task.run())
              .then(claimed.task.resolve, claimed.task.reject)
              .finally(() => {
                this.#release(claimed.task.accountId, claimed.task.id, claimed.task.kind);
                this.#inFlight.delete(task);
                this.#wake?.();
              });
          }
          this.#inFlight.add(task);
          continue;
        }
        const queued = this.database.select({ id: operation.id }).from(operation)
          .where(eq(operation.status, "queued")).orderBy(operation.id).all();
        // 同步恢复可能增删候选；只在候选集合变化时重扫，相同值 UPDATE 不算进展。
        if (queued.length !== queuedBefore.length
          || queued.some((row, index) => row.id !== queuedBefore[index]?.id)
          || this.#memoryQueue.length !== memoryBefore) continue;
        if (!queued.length && !this.#memoryQueue.length && !this.#inFlight.size) break;
        await new Promise<void>(resolve => {
          this.#wake = () => { this.#wake = undefined; resolve(); };
        });
      }
      await Promise.all(this.#inFlight);
    }).finally(() => {
      this.#pump = undefined;
      if (!this.#stopped && (this.database.select({ id: operation.id }).from(operation).where(eq(operation.status, "queued")).get() || this.#memoryQueue.length)) {
        this.kick();
      }
    });
  }

  #canStart(accountId: string, allowPaused = false, kind: MemoryTaskKind = "serial"): boolean {
    const accounts = this.database.select().from(upstreamAccount).all();
    const account = accounts.find(row => row.accountId === accountId);
    if (allowPaused ? false : account?.paused) return false;
    if (account?.runningOperationId) return false;

    if (kind === "read") {
      const readCount = [...this.#runningReadAccounts.values()].reduce((sum, count) => sum + count, 0);
      const accountReadCount = this.#runningReadAccounts.get(accountId) ?? 0;
      const activeAccounts = new Set(
        accounts.filter(row => row.runningOperationId).map(row => row.accountId)
      );
      for (const activeAccountId of this.#runningReadAccounts.keys()) activeAccounts.add(activeAccountId);
      return readCount < MAX_READ_TASKS
        && accountReadCount < MAX_READ_TASKS
        && (activeAccounts.has(accountId) || activeAccounts.size < MAX_RUNNING_ACCOUNTS);
    }

    return accounts.filter(row => row.runningOperationId).length < MAX_RUNNING_ACCOUNTS
      && !this.#runningReadAccounts.has(accountId);
  }

  #claimNext(): ClaimedTask | undefined {
    const claimed = this.database.transaction(tx => {
      let memoryCandidateIndex = -1;
      for (let i = 0; i < this.#memoryQueue.length; i++) {
        const task = this.#memoryQueue[i];
        if (!task.allowPaused && this.paused(task.accountId)) continue;
        if (this.#canStart(task.accountId, task.allowPaused, task.kind)) {
          memoryCandidateIndex = i;
          break;
        }
      }
      const memoryCandidate = memoryCandidateIndex !== -1 ? this.#memoryQueue[memoryCandidateIndex] : undefined;

      const rows = tx.select().from(operation).where(eq(operation.status, "queued"))
        .orderBy(operation.lastGranted, operation.createdAt, operation.id).all();

      for (const row of rows) {
        const handler = this.#handlers.get(row.kind);
        if (!handler) continue;
        if (this.paused(row.accountId!)) {
          tx.update(operation).set({
            status: "needsAdministrator",
            errorCode: "ACCOUNT_PAUSED",
            version: sql`${operation.version} + 1`,
            updatedAt: this.now()
          }).where(eq(operation.id, row.id)).run();
          tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, row.roomId)).run();
          const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get();
          const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, row.roomId)).get();
          if (updatedOp && updatedRoom) {
            this.eventStream?.notifyRoom(this.database, row.roomId, { type: "operation", resourceId: row.id, version: updatedOp.version });
            this.eventStream?.notifyRoom(this.database, row.roomId, { type: "room", resourceId: row.roomId, version: updatedRoom.version });
          }
          continue;
        }
        if (!this.#canStart(row.accountId!)) continue;

        if (memoryCandidate && memoryCandidate.lastGranted < row.lastGranted) {
          this.#memoryQueue.splice(memoryCandidateIndex, 1);
          if (memoryCandidate.kind !== "read") {
            tx.insert(upstreamAccount).values({ accountId: memoryCandidate.accountId, runningOperationId: memoryCandidate.id })
              .onConflictDoUpdate({ target: upstreamAccount.accountId, set: { runningOperationId: memoryCandidate.id } }).run();
          }
          return { type: "memory", task: memoryCandidate };
        }

        const ready = handler.claim(row);
        if (!ready) continue;

        const lastGranted = Math.max(this.now(), tx.select({ value: sql<number>`coalesce(max(${operation.lastGranted}), 0) + 1` }).from(operation).get()!.value);
        const claimed = tx.update(operation).set({
          status: "processing",
          errorCode: null,
          version: sql`${operation.version} + 1`,
          lastGranted,
          updatedAt: this.now()
        }).where(and(eq(operation.id, row.id), eq(operation.status, "queued"))).run();
        if (!claimed.changes) continue;
        tx.insert(upstreamAccount).values({ accountId: row.accountId!, runningOperationId: row.id })
          .onConflictDoUpdate({ target: upstreamAccount.accountId, set: { runningOperationId: row.id } }).run();
        const updatedOp = tx.select({ version: operation.version }).from(operation).where(eq(operation.id, row.id)).get();
        if (updatedOp) {
          this.eventStream?.notifyRoom(this.database, row.roomId, { type: "operation", resourceId: row.id, version: updatedOp.version });
        }
        return { type: "operation", row, handler };
      }

      if (memoryCandidate) {
        this.#memoryQueue.splice(memoryCandidateIndex, 1);
        if (memoryCandidate.kind !== "read") {
          tx.insert(upstreamAccount).values({ accountId: memoryCandidate.accountId, runningOperationId: memoryCandidate.id })
            .onConflictDoUpdate({ target: upstreamAccount.accountId, set: { runningOperationId: memoryCandidate.id } }).run();
        }
        return { type: "memory", task: memoryCandidate };
      }

      return undefined;
    }) as ClaimedTask | undefined;
    if (claimed?.type === "memory" && claimed.task.kind === "read") {
      this.#runningReadAccounts.set(
        claimed.task.accountId,
        (this.#runningReadAccounts.get(claimed.task.accountId) ?? 0) + 1
      );
    }
    return claimed;
  }

  #release(accountId: string, operationId: string, kind: MemoryTaskKind): void {
    if (kind === "read") {
      const count = this.#runningReadAccounts.get(accountId) ?? 0;
      if (count <= 1) this.#runningReadAccounts.delete(accountId);
      else this.#runningReadAccounts.set(accountId, count - 1);
      return;
    }
    this.database.update(upstreamAccount).set({ runningOperationId: null })
      .where(and(eq(upstreamAccount.accountId, accountId), eq(upstreamAccount.runningOperationId, operationId))).run();
  }
}
