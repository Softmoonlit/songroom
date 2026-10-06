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

it("多业务操作注册共享同一调度器：按最久未获得机会轮转、全站并发限制为 2 且释放后自动唤醒", async () => {
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
