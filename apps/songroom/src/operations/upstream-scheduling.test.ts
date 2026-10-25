import { afterEach, expect, it, vi } from "vitest";
import { v7 } from "uuid";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { operation, room, roomMembership, upstreamAccount, user } from "../db/schema.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()!();
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "sr-sched-test-"));
  const dbPath = path.join(dir, "test.sqlite");
  initializeDatabase(dbPath);
  const db = openDatabase(dbPath);
  cleanups.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, dir };
}

function insertRoom(db: AppDatabase, roomId: string, userId: string) {
  db.insert(user).values({ id: userId, name: userId, email: `${userId}@example.com`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing().run();
  db.insert(room).values({ id: roomId, ownerUserId: userId, name: `房间-${roomId}` }).run();
  db.insert(roomMembership).values({ id: v7(), roomId, userId, nickname: userId }).run();
}

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

it("单调度器跨账号与房间公平轮转、全站并发限制为 2 且释放后自动唤醒", async () => {
  vi.useFakeTimers();
  const { db } = fixture();
  const now = () => Date.now();
  const scheduler = new UpstreamScheduler(db, now);

  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const firstGate = gate<void>();
  const secondGate = gate<void>();
  scheduler.register("createPublicPlaylist", {
    claim: () => true,
    execute: async row => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      order.push(row.id);
      if (row.id === opA1) await firstGate.promise;
      if (row.id === opB1) await secondGate.promise;
      inFlight--;
      db.update(operation).set({ status: "succeeded", accountId: null, authorizationId: null, generation: null }).where(eq(operation.id, row.id)).run();
    }
  });

  // 插入三个不同账号的排队操作：A1 (account-1), B1 (account-2), B2 (account-3)
  insertRoom(db, "r1", "u1");
  insertRoom(db, "r2", "u2");
  insertRoom(db, "r3", "u3");

  const opA1 = v7();
  db.insert(operation).values({ id: opA1, kind: "createPublicPlaylist", userId: "u1", roomId: "r1", accountId: "acc-1", authorizationId: v7(), generation: 1, lastGranted: 100, createdAt: 100, updatedAt: 100, status: "queued" }).run();

  const opB1 = v7();
  db.insert(operation).values({ id: opB1, kind: "createPublicPlaylist", userId: "u2", roomId: "r2", accountId: "acc-2", authorizationId: v7(), generation: 1, lastGranted: 200, createdAt: 200, updatedAt: 200, status: "queued" }).run();

  const opB2 = v7();
  db.insert(operation).values({ id: opB2, kind: "createPublicPlaylist", userId: "u3", roomId: "r3", accountId: "acc-3", authorizationId: v7(), generation: 1, lastGranted: 300, createdAt: 300, updatedAt: 300, status: "queued" }).run();

  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);

  // 全站上限为 2：opA1 和 opB1 优先执行，opB2 等待槽位
  expect(order).toEqual([opA1, opB1]);
  expect(maxInFlight).toBe(2);

  // 当 opA1 完成并释放时，调度器自动唤醒，opB2 得到机会推进
  firstGate.resolve();
  await vi.advanceTimersByTimeAsync(0);

  expect(order).toEqual([opA1, opB1, opB2]);
  expect(maxInFlight).toBe(2);

  secondGate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await scheduler.settle();

  scheduler.stop();
  await scheduler.settle();
});

it("账号暂停同时隔离属于该账号的所有注册业务类型", async () => {
  vi.useFakeTimers();
  const { db } = fixture();
  const scheduler = new UpstreamScheduler(db, () => Date.now());

  scheduler.register("createPublicPlaylist", { claim: () => true, execute: async () => {} });

  insertRoom(db, "r1", "u1");
  insertRoom(db, "r2", "u1");
  const opA = v7();
  const opB = v7();
  db.insert(operation).values({ id: opA, kind: "createPublicPlaylist", userId: "u1", roomId: "r1", accountId: "bad-acc", authorizationId: v7(), generation: 1, lastGranted: 100, createdAt: 100, updatedAt: 100, status: "queued" }).run();
  db.insert(operation).values({ id: opB, kind: "createPublicPlaylist", userId: "u1", roomId: "r2", accountId: "bad-acc", authorizationId: v7(), generation: 1, lastGranted: 200, createdAt: 200, updatedAt: 200, status: "queued" }).run();

  scheduler.pause("bad-acc");

  expect(scheduler.paused("bad-acc")).toBe(true);
  expect(scheduler.admissionCode("bad-acc")).toBe("ACCOUNT_PAUSED");

  const rows = db.select().from(operation).all();
  expect(rows.find(r => r.id === opA)?.status).toBe("needsAdministrator");
  expect(rows.find(r => r.id === opA)?.errorCode).toBe("ACCOUNT_PAUSED");
  expect(rows.find(r => r.id === opB)?.status).toBe("needsAdministrator");
  expect(rows.find(r => r.id === opB)?.errorCode).toBe("ACCOUNT_PAUSED");
});

it("同账号请求严格串行，快速完成后立即推进内存任务，保留风控暂停与公平轮转", async () => {
  vi.useFakeTimers();
  const time = 1_000;
  const { db } = fixture();
  const scheduler = new UpstreamScheduler(db, () => time);

  insertRoom(db, "r1", "u1");
  const executed: string[] = [];
  const firstRequest = gate();

  const op1 = v7();
  db.insert(operation).values({
    id: op1,
    kind: "createPublicPlaylist",
    userId: "u1",
    roomId: "r1",
    accountId: "acc-mem",
    authorizationId: v7(),
    generation: 1,
    lastGranted: 100,
    createdAt: 100,
    updatedAt: 100,
    status: "queued"
  }).run();

  scheduler.register("createPublicPlaylist", {
    claim: () => true,
    execute: async row => {
      executed.push(row.id);
      await firstRequest.promise;
      db.update(operation).set({ status: "succeeded", accountId: null, authorizationId: null, generation: null }).where(eq(operation.id, row.id)).run();
    }
  });

  scheduler.start();

  // 添加同账号内存任务
  const memPromise = scheduler.executeMemoryTask("acc-mem", async () => {
    executed.push("mem-task");
    return "result";
  });

  // 第一次 tick：op1 先被认领执行（createdAt 较早）
  await vi.advanceTimersByTimeAsync(0);
  expect(executed).toEqual([op1]);

  // 上游仍在途时同账号不得重叠；完成后无需推进时钟即可发送下一项。
  await vi.advanceTimersByTimeAsync(0);
  expect(executed).toEqual([op1]);
  firstRequest.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(executed).toEqual([op1, "mem-task"]);
  expect(vi.getTimerCount()).toBe(0);
  expect(await memPromise).toBe("result");

  // 账号暂停后拒绝新内存任务
  scheduler.pause("acc-mem");
  expect(() => scheduler.executeMemoryTask("acc-mem", async () => {})).toThrowError("ACCOUNT_PAUSED");

  scheduler.stop();
  await scheduler.settle();
});

it("明确标记的同账号只读任务并行，且不会与写入任务重叠", async () => {
  vi.useFakeTimers();
  const { db } = fixture();
  const scheduler = new UpstreamScheduler(db, () => Date.now());
  scheduler.start();

  const firstGate = gate<void>();
  const secondGate = gate<void>();
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runRead = (id: string, waitFor: Promise<void>) => scheduler.executeMemoryTask("shared-read", async () => {
    started.push(id);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await waitFor;
    inFlight--;
    return id;
  }, { kind: "read" });

  const first = runRead("first", firstGate.promise);
  const second = runRead("second", secondGate.promise);
  await vi.advanceTimersByTimeAsync(0);

  expect(started).toEqual(["first", "second"]);
  expect(maxInFlight).toBe(2);

  firstGate.resolve();
  secondGate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  expect(inFlight).toBe(0);

  scheduler.stop();
  await scheduler.settle();
});

it("同账号持久请求每次完成后立即让出并按最久未执行顺序公平轮转", async () => {
  vi.useFakeTimers();
  const { db } = fixture();
  const scheduler = new UpstreamScheduler(db, () => 1_000);
  const order: string[] = [];
  insertRoom(db, "r1", "u1");
  insertRoom(db, "r2", "u2");
  for (const [id, roomId, userId, lastGranted] of [["first", "r1", "u1", 100], ["second", "r2", "u2", 200]] as const) {
    db.insert(operation).values({ id, kind: "createPublicPlaylist", userId, roomId, accountId: "shared", authorizationId: v7(), generation: 1, lastGranted, createdAt: lastGranted, updatedAt: lastGranted, status: "queued" }).run();
  }
  scheduler.register("createPublicPlaylist", {
    claim: () => true,
    execute: async row => {
      order.push(row.id);
      const finished = order.filter(id => id === row.id).length === 2;
      db.update(operation).set(finished
        ? { status: "succeeded", accountId: null, authorizationId: null, generation: null }
        : { status: "queued" }).where(eq(operation.id, row.id)).run();
    }
  });

  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(["first", "second", "first", "second"]);
  expect(vi.getTimerCount()).toBe(0);
  scheduler.stop();
  await scheduler.settle();
});

it("队满仍拒绝新请求，达到二十项前允许入队", () => {
  const { db } = fixture();
  const scheduler = new UpstreamScheduler(db);
  for (let i = 0; i < 20; i++) {
    expect(scheduler.admissionCode("shared")).toBeNull();
    insertRoom(db, `r-${i}`, "owner");
    db.insert(operation).values({ id: v7(), kind: "createPublicPlaylist", userId: "owner", roomId: `r-${i}`, accountId: "shared", authorizationId: v7(), generation: 1, status: "queued", createdAt: 1, updatedAt: 1 }).run();
  }
  expect(scheduler.admissionCode("shared")).toBe("UPSTREAM_QUEUE_FULL");
  expect(() => scheduler.executeMemoryTask("shared", async () => {})).toThrowError("UPSTREAM_QUEUE_FULL");
});

it("重启清除已消失的执行权，保留持久暂停且立即允许未暂停账号请求", async () => {
  vi.useFakeTimers();
  const { db, dir } = fixture();
  db.insert(upstreamAccount).values({ accountId: "available", runningOperationId: "lost-handle" }).run();
  const previous = new UpstreamScheduler(db);
  previous.pause("paused", "RATE_LIMITED");
  // 使用重新打开的数据库连接，验证重启后的持久事实。
  const reopened = openDatabase(path.join(dir, "test.sqlite"));
  cleanups.push(() => reopened.$client.close());
  const scheduler = new UpstreamScheduler(reopened, () => 1_000);
  expect(scheduler.paused("paused")).toBe(true);
  scheduler.start();
  expect(() => scheduler.executeMemoryTask("paused", async () => {})).toThrowError("ACCOUNT_PAUSED");
  const result = scheduler.executeMemoryTask("available", async () => "completed");
  await vi.advanceTimersByTimeAsync(0);
  expect(await result).toBe("completed");
  scheduler.resume("paused");
  const resumed = scheduler.executeMemoryTask("paused", async () => "resumed");
  await vi.advanceTimersByTimeAsync(0);
  expect(await resumed).toBe("resumed");
  expect(vi.getTimerCount()).toBe(0);
  scheduler.stop();
  await scheduler.settle();
});

it("认领恢复操作时新增的同账号清理任务立即执行，不丢失唤醒", async () => {
  vi.useFakeTimers();
  const { db } = fixture();
  const scheduler = new UpstreamScheduler(db);
  insertRoom(db, "recover-room", "owner");
  db.insert(operation).values({ id: "recover-op", kind: "createPublicPlaylist", userId: "owner", roomId: "recover-room", accountId: "shared", authorizationId: v7(), generation: 1, status: "queued", createdAt: 1, updatedAt: 1 }).run();
  const completed: string[] = [];
  scheduler.register("createPublicPlaylist", {
    claim: row => {
      void scheduler.executeMemoryTask("shared", async () => { completed.push("cleanup"); }).catch(() => {});
      db.update(operation).set({ status: "needsAdministrator" }).where(eq(operation.id, row.id)).run();
      return false;
    },
    execute: async () => { throw new Error("恢复操作不得重新发送"); }
  });
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  try { expect(completed).toEqual(["cleanup"]); }
  finally { scheduler.stop(); await scheduler.settle(); }
});

it("queued操作同值更新后无法认领时等待外部唤醒，不忙循环", async () => {
  vi.useFakeTimers();
  const { db } = fixture();
  const scheduler = new UpstreamScheduler(db);
  insertRoom(db, "blocked-room", "owner");
  db.insert(operation).values({ id: "blocked-op", kind: "createPublicPlaylist", userId: "owner", roomId: "blocked-room", accountId: "shared", authorizationId: v7(), generation: 1, status: "queued", createdAt: 1, updatedAt: 1 }).run();
  let claims = 0;
  scheduler.register("createPublicPlaylist", {
    claim: row => {
      if (++claims > 1) {
        scheduler.stop();
        throw new Error("无进展却重复认领");
      }
      db.update(operation).set({ status: "queued" }).where(eq(operation.id, row.id)).run();
      return false;
    },
    execute: async () => { throw new Error("阻塞操作不得发送"); }
  });
  scheduler.start();
  const drained = scheduler.settle().then(() => null, error => error);
  await vi.advanceTimersByTimeAsync(0);
  scheduler.stop();
  expect(await drained).toBeNull();
  expect(claims).toBe(1);
});
