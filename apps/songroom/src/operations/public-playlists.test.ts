import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 } from "uuid";
import { afterEach, expect, it, vi } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { commandReceipt, neteaseAuthorization, operation, publicPlaylistBinding, publicPlaylistCleanup, publicPlaylistCreation, room, roomMembership, user } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { PublicPlaylists } from "./public-playlists.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { EventStreamService } from "../events/event-stream.js";

class Adapter implements NeteaseAdapter {
  inputs: AdapterInput[] = [];
  identity: (input: Extract<AdapterInput, { operation: "identity" }>) => Promise<AdapterResult<"identity">> = async () => ({ ok: true, data: { accountId: "cloud-owner", name: "房主" } });
  create: (input: Extract<AdapterInput, { operation: "playlistCreate" }>) => Promise<AdapterResult<"playlistCreate">> = async () => ({ ok: true, data: { playlistId: "cloud-playlist" } });
  userPlaylists: (input: Extract<AdapterInput, { operation: "userPlaylists" }>) => Promise<AdapterResult<"userPlaylists">> = async () => ({ ok: true, data: { playlists: [], more: false } });
  delete: (input: Extract<AdapterInput, { operation: "playlistDelete" }>) => Promise<AdapterResult<"playlistDelete">> = async () => ({ ok: true, data: { acknowledged: true } });
  detail: (input: Extract<AdapterInput, { operation: "playlistDetail" }>) => Promise<AdapterResult<"playlistDetail">> = async input => ({
    ok: true,
    data: {
      playlist: { id: input.playlistId, name: "默认歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
      songIds: [],
      songs: []
    }
  });
  async assertVendorIntegrity() {}
  async dispose() {}
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);
    if (input.operation === "identity") return await this.identity(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistCreate") return await this.create(input) as AdapterResult<I["operation"]>;
    if (input.operation === "userPlaylists") return await this.userPlaylists(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistDelete") return await this.delete(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistDetail") return await this.detail(input) as AdapterResult<I["operation"]>;
    throw new Error("unexpected adapter call");
  }
}
const fixtures: Array<{ root: string; database: AppDatabase; modules: PublicPlaylists[] }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const module of fixture.modules) { module.stop(); await module.settle(); }
    fixture.database.$client.close(); fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-public-playlists-"));
  const dbPath = path.join(root, "app.sqlite"); initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "key"); fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);
  for (const id of ["owner", "member", "outsider"]) database.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
  const roomId = v7();
  database.insert(room).values({ id: roomId, name: "宿舍", ownerUserId: "owner" }).run();
  for (const id of ["owner", "member"]) database.insert(roomMembership).values({ id: v7(), roomId, userId: id, nickname: id }).run();
  const authorizationId = v7();
  const scope = { authorizationId, accountId: "cloud-owner", generation: 1 };
  database.insert(neteaseAuthorization).values({ id: authorizationId, userId: "owner", accountId: scope.accountId, generation: 1, nickname: "房主", status: "active", credentials: vault.encrypt("MUSIC_U=owner", scope) }).run();
  const adapter = new Adapter();
  const eventStream = new EventStreamService();
  const modules: PublicPlaylists[] = [];
  fixtures.push({ root, database, modules });
  const clockStartedAt = Date.now();
  function module(now?: () => number) {
    const clock = now ? () => now() + Date.now() - clockStartedAt : undefined;
    const scheduler = new UpstreamScheduler(database, clock);
    const result = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, clock); modules.push(result); return result;
  }
  return { database, adapter, roomId, module, authorizationId, vault, dbPath, keyPath };
}

it("每请求公平让出、真实账号串行间隔 1 秒且全站最多两个在途请求", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module();
  const rooms: Array<{ userId: string; roomId: string }> = [];
  for (const userId of ["owner", "member", "outsider"]) {
    if (userId !== "owner") {
      const authorizationId = v7(); const scope = { authorizationId, accountId: `cloud-${userId}`, generation: 1 };
      f.database.insert(neteaseAuthorization).values({ id: authorizationId, userId, accountId: scope.accountId, nickname: userId, generation: 1, status: "active", credentials: f.vault.encrypt(`cookie-${userId}`, scope) }).run();
    }
    for (let index = 0; index < 2; index++) {
      const roomId = v7();
      f.database.insert(room).values({ id: roomId, ownerUserId: userId, name: `${userId}-${index}` }).run();
      f.database.insert(roomMembership).values({ id: v7(), roomId, userId, nickname: userId }).run();
      rooms.push({ userId, roomId });
      service.create(userId, roomId, { idempotencyKey: v7() });
    }
  }
  const starts: Array<{ time: number; account: string; request: string }> = [];
  const held = gate<void>(); let active = 0; let maximum = 0;
  f.adapter.identity = async input => {
    starts.push({ time: Date.now(), account: input.expectedAccountId!, request: "identity" });
    maximum = Math.max(maximum, ++active);
    await held.promise; active--;
    return { ok: true, data: { accountId: input.expectedAccountId!, name: "房主" } };
  };
  f.adapter.create = async input => {
    const account = input.cookie.includes("owner") ? "cloud-owner" : input.cookie.includes("member") ? "cloud-member" : "cloud-outsider";
    starts.push({ time: Date.now(), account, request: "create" });
    maximum = Math.max(maximum, ++active); active--;
    return { ok: true, data: { playlistId: input.name } };
  };
  service.start(); await vi.advanceTimersByTimeAsync(0);
  expect(starts.map(start => start.account)).toEqual(["cloud-owner", "cloud-member"]);
  expect(rooms.filter(item => service.read(item.userId, item.roomId).operation?.status === "processing")).toHaveLength(2);
  held.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(starts.map(start => start.account)).toEqual(["cloud-owner", "cloud-member", "cloud-outsider"]);
  await vi.advanceTimersByTimeAsync(999); expect(starts).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(starts.slice(3).map(start => start.request)).toEqual(["identity", "identity", "identity"]);
  await vi.runAllTimersAsync(); await service.settle();
  expect(maximum).toBe(2);
  for (const account of ["cloud-owner", "cloud-member", "cloud-outsider"]) {
    const calls = starts.filter(start => start.account === account);
    expect(calls.map(call => call.request)).toEqual(["identity", "identity", "create", "create"]);
    for (let index = 1; index < calls.length; index++) expect(calls[index].time - calls[index - 1].time).toBeGreaterThanOrEqual(1000);
  }
  for (const item of rooms) expect(service.read(item.userId, item.roomId).operation?.status).toBe("succeeded");
});

it("同账号请求超过间隔仍独占执行权，其他目标不能并发进入", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module(); const second = extraRoom(f);
  const held = gate<AdapterResult<"identity">>();
  f.adapter.identity = () => held.promise;
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.create("owner", second, { idempotencyKey: v7() });
  service.start(); await vi.advanceTimersByTimeAsync(3000);
  expect(f.adapter.inputs).toHaveLength(1);
  expect(service.read("owner", f.roomId).operation?.status).toBe("processing");
  expect(service.read("owner", second).operation?.status).toBe("queued");
  service.stop(); held.resolve({ ok: true, data: { accountId: "cloud-owner", name: "房主" } }); await service.settle();
});

it("重开 SQLite 后仍等待持久的下一次启动时间，不突发请求", async () => {
  vi.useFakeTimers();
  const f = fixture(); const first = f.module();
  first.create("owner", f.roomId, { idempotencyKey: v7() });
  first.start(); await vi.advanceTimersByTimeAsync(0);
  expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity", "userPlaylists"]);
  first.stop(); await first.settle();
  const reopened = openDatabase(f.dbPath);
  const restartedScheduler = new UpstreamScheduler(reopened);
  const restarted = new PublicPlaylists(reopened, f.adapter, f.vault, restartedScheduler, new EventStreamService());
  try {
    restarted.start(); await vi.advanceTimersByTimeAsync(999);
    expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity", "userPlaylists"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity", "userPlaylists", "identity", "userPlaylists"]);
    await vi.advanceTimersByTimeAsync(1000); await restarted.settle();
    expect(restarted.read("owner", f.roomId).operation?.status).toBe("succeeded");
  } finally { restarted.stop(); await restarted.settle(); reopened.$client.close(); }
});

function extraRoom(f: ReturnType<typeof fixture>, name = "其他目标") {
  const roomId = v7();
  f.database.insert(room).values({ id: roomId, ownerUserId: "owner", name }).run();
  f.database.insert(roomMembership).values({ id: v7(), roomId, userId: "owner", nickname: "owner" }).run();
  return roomId;
}

it("风控暂停同一真实账号的全部目标，重启不能恢复且新受理明确拒绝", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module(); const second = extraRoom(f); const third = extraRoom(f);
  f.adapter.identity = async () => ({ ok: false, error: { code: "RATE_LIMITED", outcome: "failed" } });
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.create("owner", second, { idempotencyKey: v7() });
  service.start(); await vi.runAllTimersAsync(); await service.settle();
  expect(service.read("owner", f.roomId).operation).toMatchObject({ status: "needsAdministrator", errorCode: "RATE_LIMITED" });
  expect(service.read("owner", second).operation).toMatchObject({ status: "needsAdministrator", errorCode: "ACCOUNT_PAUSED" });
  expect(service.read("owner", third).disabledReason).toBe("ACCOUNT_PAUSED");
  expect(() => service.create("owner", third, { idempotencyKey: v7() })).toThrowError("ACCOUNT_PAUSED");
  service.stop(); const restarted = f.module(); restarted.start(); await vi.runAllTimersAsync(); await restarted.settle();
  expect(f.adapter.inputs).toHaveLength(1);
  expect(restarted.read("owner", second).operation?.errorCode).toBe("ACCOUNT_PAUSED");
});

it("目标权限只阻塞当前房间，待确认创建不阻挡其他目标且不重发", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module(); const second = extraRoom(f); const third = extraRoom(f);
  f.adapter.create = async input => input.name.includes("宿舍")
    ? { ok: false, error: { code: "TARGET_PERMISSION", outcome: "failed" } }
    : { ok: false, error: { code: "NETWORK_ERROR", outcome: "unknown" } };
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.create("owner", second, { idempotencyKey: v7() });
  service.start(); await vi.runAllTimersAsync(); await service.settle();
  expect(service.read("owner", f.roomId)).toMatchObject({ disabledReason: "TARGET_BLOCKED", operation: { status: "needsAdministrator", errorCode: "TARGET_PERMISSION" } });
  expect(service.read("owner", second).operation).toMatchObject({ status: "needsAdministrator", errorCode: "NETWORK_ERROR" });
  f.database.update(room).set({ name: "成功目标" }).where(eq(room.id, third)).run();
  f.adapter.create = async () => ({ ok: true, data: { playlistId: "success" } });
  service.create("owner", third, { idempotencyKey: v7() }); await vi.runAllTimersAsync(); await service.settle();
  expect(service.read("owner", third).operation?.status).toBe("succeeded");
  expect(service.create("owner", second, { idempotencyKey: v7() }).replay).toBe(true);
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(3);
});

it("两个创建返回同一规范化账号歌单 ID 时不覆盖绑定，冲突证据保留且不重发", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module(); const second = extraRoom(f);
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.create("owner", second, { idempotencyKey: v7() });
  service.start(); await vi.runAllTimersAsync(); await service.settle();
  expect(service.read("owner", f.roomId)).toMatchObject({ playlist: { id: "cloud-playlist" }, operation: { status: "succeeded" } });
  expect(service.read("owner", second)).toMatchObject({ playlist: null, operation: { status: "needsAdministrator" } });
  service.stop(); const restarted = f.module(); restarted.start(); await vi.runAllTimersAsync(); await restarted.settle();
  expect(restarted.read("owner", f.roomId).playlist?.id).toBe("cloud-playlist");
  expect(restarted.read("owner", second).operation?.status).toBe("needsAdministrator");
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(2);
});

it("发送后风控保留待确认事实并暂停整个账号，未知步骤不重新发送", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module(); const second = extraRoom(f);
  f.adapter.create = async () => ({ ok: false, error: { code: "RATE_LIMITED", outcome: "unknown" } });
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.create("owner", second, { idempotencyKey: v7() });
  service.start(); await vi.runAllTimersAsync(); await service.settle();
  expect(service.read("owner", f.roomId).operation).toMatchObject({ status: "needsAdministrator", errorCode: "RATE_LIMITED" });
  expect(service.read("owner", second).operation).toMatchObject({ status: "needsAdministrator", errorCode: "ACCOUNT_PAUSED" });
  service.stop(); const restarted = f.module(); restarted.start(); await vi.runAllTimersAsync(); await restarted.settle();
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
  expect(restarted.read("owner", f.roomId).operation?.errorCode).toBe("RATE_LIMITED");
});

it("新到达操作不能饿死已核查的旧操作，同一房间所有幂等键保持同一个冲突意图", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module();
  const first = service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.start(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  const second = extraRoom(f);
  service.create("owner", second, { idempotencyKey: v7() });
  expect(service.create("owner", f.roomId, { idempotencyKey: v7() }).view.operation?.id).toBe(first.view.operation!.id);
  await vi.advanceTimersByTimeAsync(500);
  expect(service.read("owner", f.roomId).operation?.status).toBe("succeeded");
  expect(service.read("owner", second).operation?.status).toBe("queued");
  f.adapter.create = async () => ({ ok: true, data: { playlistId: "second" } });
  await vi.runAllTimersAsync(); await service.settle();
  expect(service.read("owner", second).operation?.status).toBe("succeeded");
  expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity", "userPlaylists", "playlistCreate", "identity", "userPlaylists", "playlistCreate"]);
});

it("执行中和已核查的多请求操作只占一项，等待授权后释放队列容量并保留任务", async () => {
  vi.useFakeTimers();
  const f = fixture(); const service = f.module();
  const rooms = Array.from({ length: 21 }, () => extraRoom(f));
  for (const id of rooms.slice(0, 20)) service.create("owner", id, { idempotencyKey: v7() });
  service.start(); await vi.advanceTimersByTimeAsync(0);
  expect(service.read("owner", rooms[0]).operation?.status).toBe("queued");
  expect(() => service.create("owner", rooms[20], { idempotencyKey: v7() })).toThrowError("UPSTREAM_QUEUE_FULL");
  f.adapter.identity = async () => ({ ok: false, error: { code: "ACCOUNT_EMPTY", outcome: "failed" } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(service.read("owner", rooms[1]).operation).toMatchObject({ status: "waitingAuthorization", errorCode: "ACCOUNT_EMPTY" });
  expect(service.create("owner", rooms[20], { idempotencyKey: v7() }).replay).toBe(false);
  service.stop(); await service.settle();
  expect(service.read("owner", rooms[1]).operation?.status).toBe("waitingAuthorization");
});

it("真实账号最多受理 20 项业务操作，多请求不会重复占位，重放仍可读取", () => {
  const f = fixture(); const service = f.module();
  const rooms = Array.from({ length: 21 }, (_, index) => {
    const id = v7();
    f.database.insert(room).values({ id, ownerUserId: "owner", name: `房间${index}` }).run();
    f.database.insert(roomMembership).values({ id: v7(), roomId: id, userId: "owner", nickname: "owner" }).run();
    return id;
  });
  const key = v7();
  const first = service.create("owner", rooms[0], { idempotencyKey: key });
  for (const id of rooms.slice(1, 20)) expect(service.create("owner", id, { idempotencyKey: v7() }).view.operation?.status).toBe("queued");
  expect(() => service.create("owner", rooms[20], { idempotencyKey: v7() })).toThrowError("UPSTREAM_QUEUE_FULL");
  expect(service.create("owner", rooms[0], { idempotencyKey: key }).view.operation).toEqual(first.view.operation);
  expect(service.read("owner", rooms[20]).disabledReason).toBe("UPSTREAM_QUEUE_FULL");
});

it("事务受理、成员权限、不同键合并和原键重放，监听前不派发", async () => {
  const f = fixture(); const service = f.module();
  expect(service.read("owner", f.roomId).allowedActions).toEqual(["createPublicPlaylist"]);
  expect(service.read("member", f.roomId).disabledReason).toBe("OWNER_ONLY");
  expect(() => service.read("outsider", f.roomId)).toThrow();
  expect(() => service.create("member", f.roomId, { idempotencyKey: v7() })).toThrow();
  const key = v7(); const accepted = service.create("owner", f.roomId, { idempotencyKey: key });
  expect(accepted.replay).toBe(false); expect(accepted.view.operation?.status).toBe("queued");
  const otherKey = v7();
  expect(service.create("owner", f.roomId, { idempotencyKey: otherKey })).toMatchObject({ replay: true, view: { operation: accepted.view.operation } });
  expect(f.adapter.inputs).toEqual([]);
  service.start(); await service.settle();
  expect(service.read("owner", f.roomId)).toMatchObject({ playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共" }, operation: { id: accepted.view.operation!.id, status: "succeeded" }, disabledReason: "PUBLIC_PLAYLIST_EXISTS" });
  expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity", "userPlaylists", "playlistCreate"]);
  expect(service.create("owner", f.roomId, { idempotencyKey: otherKey }).view.operation?.id).toBe(accepted.view.operation!.id);
  expect(() => service.create("owner", f.roomId, { idempotencyKey: v7() })).toThrowError("PUBLIC_PLAYLIST_EXISTS");
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("普通身份读取失败不发送写入，旧键仍返回原失败操作而非后来新操作", async () => {
  const f = fixture(); const service = f.module();
  f.adapter.identity = async () => ({ ok: false, error: { code: "NETWORK_ERROR", outcome: "failed" } });
  const key = v7(); const first = service.create("owner", f.roomId, { idempotencyKey: key });
  service.start(); await service.settle();
  expect(service.read("owner", f.roomId).operation?.status).toBe("failed");
  expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity"]);
  const second = service.create("owner", f.roomId, { idempotencyKey: v7() });
  expect(second.view.operation?.id).not.toBe(first.view.operation?.id);
  expect(service.create("owner", f.roomId, { idempotencyKey: key })).toMatchObject({ replay: true, view: { operation: { id: first.view.operation!.id, status: "failed" } } });
  await service.settle();
});

it.each(["AUTH_UNAVAILABLE", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH"] as const)("身份明确授权问题 %s 等待授权且不发送", async code => {
  const f = fixture(); const service = f.module();
  f.adapter.identity = async () => ({ ok: false, error: { code, outcome: "failed" } });
  service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await service.settle();
  expect(service.read("owner", f.roomId)).toMatchObject({ operation: { status: "waitingAuthorization", errorCode: code }, disabledReason: "OPERATION_PENDING", allowedActions: [] });
  expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity"]);
});

it("凭据解密失败后等待授权，重启不会恢复上游调用", async () => {
  const f = fixture(); const service = f.module();
  f.database.update(neteaseAuthorization).set({ credentials: "invalid" }).run();
  service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await service.settle();
  expect(service.read("owner", f.roomId).operation?.status).toBe("waitingAuthorization");
  expect(f.adapter.inputs).toEqual([]);
  service.stop();
  f.database.update(neteaseAuthorization).set({ credentials: f.vault.encrypt("cookie", { authorizationId: f.authorizationId, accountId: "cloud-owner", generation: 1 }) }).run();
  f.adapter.identity = async () => ({ ok: true, data: { accountId: "different", name: "other" } });
  const restarted = f.module(); restarted.start(); await restarted.settle();
  expect(restarted.read("owner", f.roomId).operation?.status).toBe("waitingAuthorization");
  expect(f.adapter.inputs).toEqual([]);
});

it("身份不一致后保持等待授权，重启不自动核验或创建", async () => {
  const f = fixture(); const service = f.module();
  f.adapter.identity = async () => ({ ok: true, data: { accountId: "different", name: "other" } });
  service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await service.settle(); service.stop();
  expect(service.read("owner", f.roomId).operation?.status).toBe("waitingAuthorization");
  f.adapter.identity = async () => ({ ok: true, data: { accountId: "cloud-owner", name: "owner" } });
  const restarted = f.module(); restarted.start(); await restarted.settle();
  expect(restarted.read("owner", f.roomId).operation?.status).toBe("waitingAuthorization");
  expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity"]);
});

it.each(["failed", "unknown"] as const)("发送后 adapter outcome=%s 也需管理员处理，重启与新键不重发", async outcome => {
  const f = fixture(); const service = f.module();
  f.adapter.create = async () => ({ ok: false, error: { code: "MODULE_ERROR", outcome } });
  const first = service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await service.settle(); service.stop();
  const restarted = f.module(); restarted.start(); await restarted.settle();
  expect(restarted.create("owner", f.roomId, { idempotencyKey: v7() })).toMatchObject({ replay: true, view: { operation: { id: first.view.operation!.id, status: "needsAdministrator" } } });
  await restarted.settle();
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
});

it("发送调用抛异常仍需管理员处理", async () => {
  const f = fixture(); const service = f.module();
  f.adapter.create = async () => { throw new Error("interrupted"); };
  service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await service.settle();
  expect(service.read("owner", f.roomId).operation?.status).toBe("needsAdministrator");
});

it("持久未发送操作重启恢复，stop 不启动后续写且 settle 等待在途读取", async () => {
  const f = fixture(); const service = f.module();
  const entered = gate<void>(); const identity = gate<AdapterResult<"identity">>();
  f.adapter.identity = async () => { entered.resolve(); return identity.promise; };
  const accepted = service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await entered.promise; service.stop();
  let settled = false; const settle = service.settle().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  identity.resolve({ ok: true, data: { accountId: "cloud-owner", name: "owner" } }); await settle;
  expect(service.read("owner", f.roomId).operation?.status).toBe("queued");
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(0);
  f.adapter.identity = async () => ({ ok: true, data: { accountId: "cloud-owner", name: "owner" } });
  const restarted = f.module(); restarted.start(); await restarted.settle();
  expect(restarted.read("owner", f.roomId).operation).toEqual({ id: accepted.view.operation!.id, status: "succeeded", errorCode: null, version: expect.any(Number) });
});

it("身份读取期间授权代次变化，不发创建", async () => {
  const f = fixture(); const service = f.module();
  const entered = gate<void>(); const identity = gate<AdapterResult<"identity">>();
  f.adapter.identity = async () => { entered.resolve(); return identity.promise; };
  service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await entered.promise;
  f.database.update(neteaseAuthorization).set({ generation: 2 }).run();
  identity.resolve({ ok: true, data: { accountId: "cloud-owner", name: "owner" } }); await service.settle();
  expect(service.read("owner", f.roomId).operation?.status).toBe("waitingAuthorization");
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(0);
});

it.each(["generation", "account", "room", "membership"] as const)("发送中 %s 变化：返回 ID 持久保留但不绑定", async change => {
  const f = fixture(); const service = f.module();
  const entered = gate<void>(); const created = gate<AdapterResult<"playlistCreate">>();
  f.adapter.create = async () => { entered.resolve(); return created.promise; };
  const accepted = service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await entered.promise;
  if (change === "generation") f.database.update(neteaseAuthorization).set({ generation: 2 }).run();
  if (change === "account") f.database.update(neteaseAuthorization).set({ accountId: "new-account" }).run();
  if (change === "room") f.database.delete(room).where(eq(room.id, f.roomId)).run();
  if (change === "membership") f.database.delete(roomMembership).where(eq(roomMembership.userId, "owner")).run();
  created.resolve({ ok: true, data: { playlistId: "known-late-id" } }); await service.settle();
  const saved = f.database.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, accepted.view.operation!.id)).get();
  expect(saved).toMatchObject({ playlistId: "known-late-id", step: "confirming" });
  if (change === "generation" || change === "account") expect(service.read("owner", f.roomId)).toMatchObject({ playlist: null, operation: { status: "waitingAuthorization" } });
  else expect(() => service.read("owner", f.roomId)).toThrow();
  service.stop(); const restarted = f.module(); restarted.start(); await restarted.settle();
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
  expect(f.database.select().from(publicPlaylistCreation).get()?.playlistId).toBe("known-late-id");
});

it("关联事务失败不丢 ID；重启只完成关联而不再创建", async () => {
  const f = fixture(); const service = f.module();
  f.database.$client.exec("CREATE TRIGGER test_binding_fault BEFORE INSERT ON public_playlist_binding BEGIN SELECT RAISE(ABORT, 'test fault'); END");
  service.create("owner", f.roomId, { idempotencyKey: v7() }); service.start(); await service.settle();
  expect(service.read("owner", f.roomId)).toMatchObject({ playlist: null, operation: { status: "needsAdministrator" } });
  expect(f.database.select().from(publicPlaylistCreation).get()).toMatchObject({ playlistId: "cloud-playlist", step: "confirming" });
  service.stop(); f.database.$client.exec("DROP TRIGGER test_binding_fault");
  const restarted = f.module(); restarted.start(); await restarted.settle();
  expect(restarted.read("owner", f.roomId)).toMatchObject({ playlist: { id: "cloud-playlist" }, operation: { status: "succeeded" } });
  expect(f.adapter.inputs.map(input => input.operation)).toEqual(["identity", "userPlaylists", "playlistCreate"]);
});

it("受理事务任何一步失败均回滚操作与 receipt", () => {
  const f = fixture(); const service = f.module(); const key = v7();
  f.database.$client.exec("CREATE TRIGGER test_intent_fault BEFORE INSERT ON public_playlist_creation BEGIN SELECT RAISE(ABORT, 'test fault'); END");
  expect(() => service.create("owner", f.roomId, { idempotencyKey: key })).toThrow();
  expect(f.database.select().from(operation).all()).toEqual([]);
  expect(f.database.select().from(commandReceipt).all()).toEqual([]);
  expect(service.read("owner", f.roomId).version).toBe(1);
  f.database.$client.exec("DROP TRIGGER test_intent_fault");
  expect(service.create("owner", f.roomId, { idempotencyKey: key }).replay).toBe(false);
});

it("幂等键不同房间冲突、过期及未来拒绝，纯本地 read 不请求上游", () => {
  const f = fixture(); const now = Date.now(); const service = f.module(() => now); const key = v7({ msecs: now });
  service.create("owner", f.roomId, { idempotencyKey: key });
  const secondRoomId = v7(); f.database.insert(room).values({ id: secondRoomId, ownerUserId: "owner", name: "另一个" }).run();
  f.database.insert(roomMembership).values({ id: v7(), roomId: secondRoomId, userId: "owner", nickname: "owner" }).run();
  expect(() => service.create("owner", secondRoomId, { idempotencyKey: key })).toThrowError("IDEMPOTENCY_CONFLICT");
  for (const msecs of [now - 86_400_000, now + 61_000]) expect(() => service.create("owner", f.roomId, { idempotencyKey: v7({ msecs }) })).toThrowError("IDEMPOTENCY_KEY_EXPIRED");
  service.read("owner", f.roomId); service.read("member", f.roomId);
  expect(f.adapter.inputs).toEqual([]);
});

it("真正杀死发送进程后重启，只保留待确认且不再次创建", async () => {
  const f = fixture(); const service = f.module();
  const accepted = service.create("owner", f.roomId, { idempotencyKey: v7() });
  const modulePath = fileURLToPath(new URL("./public-playlists.ts", import.meta.url));
  const schedPath = fileURLToPath(new URL("./upstream-scheduling.ts", import.meta.url));
  const databasePath = fileURLToPath(new URL("../db/database.ts", import.meta.url));
  const vaultPath = fileURLToPath(new URL("../netease/credentials.ts", import.meta.url));
  const eventStreamPath = fileURLToPath(new URL("../events/event-stream.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { PublicPlaylists } from ${JSON.stringify(modulePath)};
    import { UpstreamScheduler } from ${JSON.stringify(schedPath)};
    import { openDatabase } from ${JSON.stringify(databasePath)};
    import { CredentialVault } from ${JSON.stringify(vaultPath)};
    import { EventStreamService } from ${JSON.stringify(eventStreamPath)};
    const adapter = {
      async call(input) {
        if (input.operation === 'identity') return { ok: true, data: { accountId: 'cloud-owner', name: 'owner' } };
        if (input.operation === 'userPlaylists') return { ok: true, data: { playlists: [], more: false } };
        process.send('sending');
        return new Promise(() => {});
      }, async assertVendorIntegrity() {}, async dispose() {}
    };
    const db = openDatabase(${JSON.stringify(f.dbPath)});
    const scheduler = new UpstreamScheduler(db);
    new PublicPlaylists(db, adapter, new CredentialVault(${JSON.stringify(f.keyPath)}), scheduler, new EventStreamService()).start();
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve()); child.once("error", reject);
      child.once("exit", code => reject(new Error(`child exited before sending: ${code} ${stderr}`)));
    });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
    const restarted = f.module(); restarted.start(); await restarted.settle();
    expect(restarted.read("owner", f.roomId).operation).toMatchObject({ id: accepted.view.operation!.id, status: "needsAdministrator", errorCode: null });
    expect(f.adapter.inputs).toEqual([]);
    expect(restarted.create("owner", f.roomId, { idempotencyKey: v7() }).view.operation?.id).toBe(accepted.view.operation!.id);
    await restarted.settle(); expect(f.adapter.inputs).toEqual([]);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

it("空泵正在退出时接受的新命令仍会推进", async () => {
  const f = fixture(); const service = f.module(); service.start();
  await Promise.resolve();
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  await service.settle();
  expect(service.read("owner", f.roomId).operation?.status).toBe("succeeded");
});

it("两个真实 SQLite 连接同时受理同房间，仅一份操作且所有键指向该操作", async () => {
  const f = fixture(); const first = f.module(); const anotherDatabase = openDatabase(f.dbPath);
  const secondScheduler = new UpstreamScheduler(anotherDatabase);
  const second = new PublicPlaylists(anotherDatabase, f.adapter, f.vault, secondScheduler, new EventStreamService());
  try {
    const keys = Array.from({ length: 12 }, () => v7());
    const accepted = await Promise.all(keys.map(async (idempotencyKey, index) => (index % 2 ? first : second).create("owner", f.roomId, { idempotencyKey })));
    expect(new Set(accepted.map(result => result.view.operation!.id)).size).toBe(1);
    expect(accepted.filter(result => !result.replay)).toHaveLength(1);
    expect(f.database.select().from(operation).all()).toHaveLength(1);
    first.start(); await first.settle();
    for (const idempotencyKey of keys) expect(second.create("owner", f.roomId, { idempotencyKey }).view.operation?.id).toBe(accepted[0].view.operation!.id);
    expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
  } finally { second.stop(); await second.settle(); anotherDatabase.$client.close(); }
});

it("创建意图固定受理时房间名，后续改名不改云端名称；无授权不可创建", async () => {
  const f = fixture(); const service = f.module();
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  f.database.update(room).set({ name: "新名字" }).where(eq(room.id, f.roomId)).run();
  service.start(); await service.settle();
  expect(service.read("owner", f.roomId).playlist?.name).toBe("songroom-宿舍-公共");
  expect(f.adapter.inputs.find(input => input.operation === "playlistCreate")).toMatchObject({ name: "songroom-宿舍-公共" });
  const noAuth = fixture(); noAuth.database.delete(neteaseAuthorization).run(); const blocked = noAuth.module();
  expect(blocked.read("owner", noAuth.roomId)).toMatchObject({ disabledReason: "NETEASE_AUTH_REQUIRED", allowedActions: [] });
  expect(() => blocked.create("owner", noAuth.roomId, { idempotencyKey: v7() })).toThrowError("NETEASE_AUTH_REQUIRED");
});

it("终态立即清除恢复数据，24 小时后不可见；清理信封仍保留专用创建来源", async () => {
  const f = fixture(); let now = Date.now(); const service = f.module(() => now);
  const key = v7({ msecs: now }); const accepted = service.create("owner", f.roomId, { idempotencyKey: key });
  service.start(); await service.settle();
  expect(f.database.select().from(publicPlaylistCreation).all()).toEqual([]);
  expect(f.database.select().from(operation).get()).toMatchObject({ status: "succeeded", accountId: null, authorizationId: null, generation: null });
  now += 86_400_000;
  expect(service.read("owner", f.roomId)).toMatchObject({ operation: null, playlist: { id: "cloud-playlist" }, disabledReason: "PUBLIC_PLAYLIST_EXISTS" });
  expect(() => service.create("owner", f.roomId, { idempotencyKey: key })).toThrowError("IDEMPOTENCY_KEY_EXPIRED");
  service.stop(); const restarted = f.module(() => now); restarted.start(); await restarted.settle();
  expect(f.database.select().from(operation).all()).toEqual([]);
  expect(f.database.select().from(commandReceipt).all()).toEqual([]);
  expect(f.database.select().from(publicPlaylistBinding).get()).toMatchObject({ creationOperationId: accepted.view.operation!.id, playlistId: "cloud-playlist", accountId: "cloud-owner" });
  expect(restarted.read("owner", f.roomId).playlist?.id).toBe("cloud-playlist");
});

it("失败终态到期后新命令清理旧信封，旧键不能再次执行", async () => {
  const f = fixture(); let now = Date.now(); const service = f.module(() => now);
  f.adapter.identity = async () => ({ ok: false, error: { code: "NETWORK_ERROR", outcome: "failed" } });
  const key = v7({ msecs: now }); const old = service.create("owner", f.roomId, { idempotencyKey: key }); service.start(); await service.settle();
  expect(f.database.select().from(publicPlaylistCreation).all()).toEqual([]);
  now += 86_400_000;
  expect(service.read("owner", f.roomId)).toMatchObject({ operation: null, allowedActions: ["createPublicPlaylist"] });
  const fresh = service.create("owner", f.roomId, { idempotencyKey: v7({ msecs: now }) });
  expect(fresh.view.operation?.id).not.toBe(old.view.operation!.id);
  expect(f.database.select().from(operation).all()).toHaveLength(1);
  expect(() => service.create("owner", f.roomId, { idempotencyKey: key })).toThrowError("IDEMPOTENCY_KEY_EXPIRED");
  await service.settle();
});

it("未知创建超过 24 小时仍保存全部最小恢复证据、不允许旧键重放或新键重发", async () => {
  const f = fixture(); let now = Date.now(); const service = f.module(() => now);
  f.adapter.create = async () => ({ ok: false, error: { code: "DEADLINE", outcome: "unknown" } });
  const key = v7({ msecs: now }); const accepted = service.create("owner", f.roomId, { idempotencyKey: key }); service.start(); await service.settle(); service.stop();
  now += 2 * 86_400_000;
  const restarted = f.module(() => now); restarted.start(); await restarted.settle();
  expect(restarted.read("owner", f.roomId)).toMatchObject({ operation: { id: accepted.view.operation!.id, status: "needsAdministrator" }, disabledReason: "OPERATION_PENDING" });
  expect(f.database.select().from(operation).get()).toMatchObject({ accountId: "cloud-owner", authorizationId: f.authorizationId, generation: 1 });
  expect(f.database.select().from(publicPlaylistCreation).get()).toMatchObject({ step: "unknown", name: "songroom-宿舍-公共" });
  expect(() => restarted.create("owner", f.roomId, { idempotencyKey: key })).toThrowError("IDEMPOTENCY_KEY_EXPIRED");
  expect(restarted.create("owner", f.roomId, { idempotencyKey: v7({ msecs: now }) })).toMatchObject({ replay: true, view: { operation: { id: accepted.view.operation!.id, status: "needsAdministrator" } } });
  await restarted.settle();
  expect(f.adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
});

it("崩溃矩阵 1: 发送前崩溃（step=ready/verified），重启恢复为 ready，不重复发送，最终成功绑定且 playlistCreate 仅调用 1 次", async () => {
  const f = fixture();
  let resolvePlaylists: () => void = () => {};
  const playlistCompleted = new Promise<void>(resolve => { resolvePlaylists = resolve; });
  const origPlaylists = f.adapter.userPlaylists;
  f.adapter.userPlaylists = async input => {
    const res = await origPlaylists(input);
    resolvePlaylists();
    return res;
  };

  const service = f.module();
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.start();
  await playlistCompleted;
  service.stop();
  await service.settle();

  expect(f.database.select().from(publicPlaylistCreation).get()?.step).toBe("verified");
  expect(f.adapter.inputs.filter(i => i.operation === "playlistCreate")).toHaveLength(0);

  const restarted = f.module();
  restarted.start();
  await restarted.settle();

  expect(restarted.read("owner", f.roomId)).toMatchObject({
    playlist: { id: "cloud-playlist" },
    operation: { status: "succeeded" }
  });
  expect(f.adapter.inputs.filter(i => i.operation === "playlistCreate")).toHaveLength(1);
});

it("崩溃矩阵 2: step=sending 提交后但在调用创建前崩溃，重启恢复为 needsAdministrator (step=unknown)，绝不调用 playlistCreate", async () => {
  const f = fixture();
  const service = f.module();
  const op = service.create("owner", f.roomId, { idempotencyKey: v7() });
  f.database.update(publicPlaylistCreation).set({
    step: "sending",
    sentAt: Date.now(),
    beforePlaylists: JSON.stringify([{ id: "p1", name: "原歌单" }])
  }).where(eq(publicPlaylistCreation.operationId, op.view.operation!.id)).run();
  f.database.update(operation).set({ status: "processing" }).where(eq(operation.id, op.view.operation!.id)).run();

  const restarted = f.module();
  restarted.start();
  await restarted.settle();

  const view = restarted.read("owner", f.roomId);
  expect(view).toMatchObject({
    operation: { status: "needsAdministrator", step: "unknown" },
    disabledReason: "OPERATION_PENDING"
  });
  expect(f.adapter.inputs.filter(i => i.operation === "playlistCreate")).toHaveLength(0);
});

it("崩溃矩阵 3: playlistCreate 调用期间中断/超时，进入 needsAdministrator 并保存完整清单证据与时间，脱敏无敏感信息且重启不重发", async () => {
  const f = fixture();
  f.adapter.userPlaylists = async () => {
    const currentCreation = f.database.select().from(publicPlaylistCreation).get();
    if (!currentCreation || currentCreation.step === "ready") {
      return { ok: true, data: { playlists: [{ id: "before-1", name: "旧歌单", creatorId: "cloud-owner", subscribed: false, status: 0 }], more: false } };
    }
    return { ok: true, data: { playlists: [{ id: "before-1", name: "旧歌单", creatorId: "cloud-owner", subscribed: false, status: 0 }, { id: "after-maybe", name: "疑似新歌单", creatorId: "cloud-owner", subscribed: false, status: 0 }], more: false } };
  };
  f.adapter.create = async () => {
    throw new Error("上游网络连接超时断开");
  };

  const service = f.module();
  const key = v7();
  const created = service.create("owner", f.roomId, { idempotencyKey: key });
  service.start();
  await service.settle();

  const view = service.read("owner", f.roomId);
  expect(view).toMatchObject({
    operation: { id: created.view.operation!.id, status: "needsAdministrator", step: "unknown", errorCode: "MODULE_ERROR" },
    disabledReason: "OPERATION_PENDING",
    allowedActions: []
  });

  const creationRow = f.database.select().from(publicPlaylistCreation).get()!;
  expect(creationRow.step).toBe("unknown");
  expect(creationRow.playlistId).toBeNull();
  expect(creationRow.name).toBe("songroom-宿舍-公共");
  expect(creationRow.sentAt).toBeGreaterThan(0);
  expect(JSON.parse(creationRow.beforePlaylists!)).toEqual([{ id: "before-1", name: "旧歌单" }]);
  expect(JSON.parse(creationRow.afterPlaylists!)).toEqual([{ id: "before-1", name: "旧歌单" }, { id: "after-maybe", name: "疑似新歌单" }]);

  const dumped = JSON.stringify({ creation: creationRow, op: f.database.select().from(operation).get() });
  expect(dumped).not.toMatch(/MUSIC_U|cookie|token|secret|password|credentials/i);

  service.stop();
  const restarted = f.module();
  restarted.start();
  await restarted.settle();

  expect(restarted.read("owner", f.roomId).operation?.status).toBe("needsAdministrator");
  expect(f.adapter.inputs.filter(i => i.operation === "playlistCreate")).toHaveLength(1);
});

it("崩溃矩阵 4: playlistCreate 成功取得具体 ID 后、绑定事务前崩溃，重启恢复并完成原具体目标关联，无重复创建", async () => {
  const f = fixture();
  const service = f.module();
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  f.database.$client.exec("CREATE TRIGGER test_bind_crash BEFORE INSERT ON public_playlist_binding BEGIN SELECT RAISE(ABORT, 'crash before bind'); END");
  service.start();
  await service.settle();

  const creationBefore = f.database.select().from(publicPlaylistCreation).get()!;
  expect(creationBefore.step).toBe("confirming");
  expect(creationBefore.playlistId).toBe("cloud-playlist");

  service.stop();
  f.database.$client.exec("DROP TRIGGER test_bind_crash");

  vi.useFakeTimers();
  const restarted = f.module();
  restarted.start();
  const viewOnRestart = restarted.read("owner", f.roomId);
  expect(viewOnRestart.operation).toMatchObject({
    step: "confirming",
    recovered: true,
    playlistId: "cloud-playlist"
  });

  await vi.runAllTimersAsync();
  await restarted.settle();

  expect(restarted.read("owner", f.roomId)).toMatchObject({
    playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共" },
    operation: { status: "succeeded" }
  });
  expect(f.adapter.inputs.filter(i => i.operation === "playlistCreate")).toHaveLength(1);
  expect(f.database.select().from(publicPlaylistBinding).get()?.playlistId).toBe("cloud-playlist");
});

it("ID 关联核验与隔离: 已获 ID 待关联时，若房主授权代次改变，暂停等待原代次授权，绝不错误关联", async () => {
  const f = fixture();
  const service = f.module();
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  f.database.$client.exec("CREATE TRIGGER test_bind_hold BEFORE INSERT ON public_playlist_binding BEGIN SELECT RAISE(ABORT, 'hold'); END");
  service.start();
  await service.settle();
  service.stop();
  f.database.$client.exec("DROP TRIGGER test_bind_hold");

  f.database.update(neteaseAuthorization).set({ generation: 2 }).where(eq(neteaseAuthorization.userId, "owner")).run();

  const restarted = f.module();
  restarted.start();
  await restarted.settle();

  expect(f.database.select().from(publicPlaylistBinding).all()).toHaveLength(0);
  expect(restarted.read("owner", f.roomId)).toMatchObject({
    playlist: null,
    operation: { status: "waitingAuthorization" }
  });
});

it("ID 关联核验与隔离: 已获 ID 待关联时，若房主已非成员或房间已有绑定，转为 needsAdministrator，绝不覆盖或改认", async () => {
  const f = fixture();
  const service = f.module();
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  f.database.$client.exec("CREATE TRIGGER test_bind_hold2 BEFORE INSERT ON public_playlist_binding BEGIN SELECT RAISE(ABORT, 'hold'); END");
  service.start();
  await service.settle();
  service.stop();
  f.database.$client.exec("DROP TRIGGER test_bind_hold2");

  f.database.delete(roomMembership).where(eq(roomMembership.userId, "owner")).run();

  const restarted = f.module();
  restarted.start();
  await restarted.settle();

  expect(f.database.select().from(publicPlaylistBinding).all()).toHaveLength(0);
  const row = f.database.select().from(operation).get()!;
  expect(row.status).toBe("needsAdministrator");
  expect(f.database.select().from(publicPlaylistCreation).get()?.playlistId).toBe("cloud-playlist");
});

it("同账号其他目标不受阻塞且未知创建不占执行槽", async () => {
  const f = fixture();
  const service = f.module();
  const second = extraRoom(f, "第二房间");

  f.adapter.create = async input => {
    if (input.name.includes("宿舍")) {
      return { ok: false, error: { code: "DEADLINE", outcome: "unknown" } };
    }
    return { ok: true, data: { playlistId: "cloud-playlist-second" } };
  };

  service.create("owner", f.roomId, { idempotencyKey: v7() });
  service.start();
  await service.settle();

  expect(service.read("owner", f.roomId).operation?.status).toBe("needsAdministrator");

  service.create("owner", second, { idempotencyKey: v7() });
  await service.settle();

  expect(service.read("owner", second)).toMatchObject({
    playlist: { id: "cloud-playlist-second" },
    operation: { status: "succeeded" }
  });
});

it("删房事务收敛在途操作、生成最小清理任务并在调度器中执行一次公共歌单删除", async () => {
  const f = fixture();
  const service = f.module();
  service.start();

  // 1. 先成功创建并绑定公共歌单
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  await service.settle();

  const binding = f.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, f.roomId)).get();
  expect(binding).toBeDefined();

  // 2. 模拟删房事务
  let cleanupId: string | null = null;
  f.database.transaction(tx => {
    const outcome = service.terminateRoomInTx(tx, f.roomId, "owner");
    cleanupId = outcome.cleanupId;
  });

  expect(cleanupId).toBeDefined();
  const cleanupRow = f.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId!)).get()!;
  expect(cleanupRow.status).toBe("ready");
  expect(cleanupRow.playlistId).toBe("cloud-playlist");
  expect(cleanupRow.accountId).toBe("cloud-owner");

  // 3. 调度清理执行一次删除
  service.dispatchCleanup(cleanupId!);
  await service.settle();

  const updatedCleanup = f.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId!)).get()!;
  expect(updatedCleanup.status).toBe("succeeded");
  expect(f.adapter.inputs.some(i => i.operation === "playlistDelete")).toBe(true);
});

it("无公共歌单删房时不产生虚假清理任务", async () => {
  const f = fixture();
  const service = f.module();

  let cleanupId: string | null = null;
  f.database.transaction(tx => {
    const outcome = service.terminateRoomInTx(tx, f.roomId, "owner");
    cleanupId = outcome.cleanupId;
  });

  expect(cleanupId).toBeNull();
  expect(f.database.select().from(publicPlaylistCleanup).all()).toHaveLength(0);
});

it("在途公共歌单创建已取得具体 ID 时删房转为清理任务，ID 未知时保留管理员证据不建虚假任务", async () => {
  const f = fixture();
  const service = f.module();

  // 1. 模拟一个已取得 ID 的在途创建（confirming 阶段）
  const opId1 = v7();
  f.database.insert(operation).values({
    id: opId1,
    kind: "createPublicPlaylist",
    userId: "owner",
    roomId: f.roomId,
    accountId: "cloud-owner",
    authorizationId: f.authorizationId,
    generation: 1,
    status: "processing",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();
  f.database.insert(publicPlaylistCreation).values({
    operationId: opId1,
    name: "songroom-宿舍-公共",
    step: "confirming",
    playlistId: "cloud-created-in-flight"
  }).run();

  let cleanupId1: string | null = null;
  f.database.transaction(tx => {
    const outcome = service.terminateRoomInTx(tx, f.roomId, "owner");
    cleanupId1 = outcome.cleanupId;
  });

  expect(cleanupId1).toBeDefined();
  const cleanup1 = f.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId1!)).get()!;
  expect(cleanup1.playlistId).toBe("cloud-created-in-flight");
  expect(f.database.select().from(operation).where(eq(operation.id, opId1)).get()?.status).toBe("stopped");

  // 2. 模拟 ID 未知但在途的创建（sending / unknown 阶段）
  const secondRoom = v7();
  f.database.insert(room).values({ id: secondRoom, name: "第二间", ownerUserId: "owner" }).run();
  const opId2 = v7();
  f.database.insert(operation).values({
    id: opId2,
    kind: "createPublicPlaylist",
    userId: "owner",
    roomId: secondRoom,
    accountId: "cloud-owner",
    authorizationId: f.authorizationId,
    generation: 1,
    status: "processing",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();
  f.database.insert(publicPlaylistCreation).values({
    operationId: opId2,
    name: "songroom-第二间-公共",
    step: "unknown",
    playlistId: null
  }).run();

  let cleanupId2: string | null = null;
  f.database.transaction(tx => {
    const outcome = service.terminateRoomInTx(tx, secondRoom, "owner");
    cleanupId2 = outcome.cleanupId;
  });

  expect(cleanupId2).toBeNull();
  expect(f.database.select().from(operation).where(eq(operation.id, opId2)).get()?.status).toBe("needsAdministrator");
});

it("清理任务在授权不可用时保持 waitingAuthorization，遇到未知错误保留 awaitingConfirmation 不自动重发", { timeout: 15000 }, async () => {
  const f = fixture();
  const service = f.module();
  service.start();

  // 1. 创建歌单
  service.create("owner", f.roomId, { idempotencyKey: v7() });
  await service.settle();

  // 2. 移除授权
  f.database.update(neteaseAuthorization).set({ status: "waitingAuthorization", credentials: null }).run();

  let cleanupId: string | null = null;
  f.database.transaction(tx => {
    const outcome = service.terminateRoomInTx(tx, f.roomId, "owner");
    cleanupId = outcome.cleanupId;
  });

  expect(cleanupId).toBeDefined();
  const cleanupRow = f.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId!)).get()!;
  expect(cleanupRow.status).toBe("waitingAuthorization");

  // dispatch 不会调用上游
  f.adapter.inputs = [];
  service.dispatchCleanup(cleanupId!);
  await service.settle();
  expect(f.adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);

  // 3. 恢复授权但适配器返回 unknown 错误
  f.database.update(neteaseAuthorization).set({
    status: "active",
    credentials: f.vault.encrypt("MUSIC_U=owner", { authorizationId: f.authorizationId, accountId: "cloud-owner", generation: 1 })
  }).run();
  f.database.update(publicPlaylistCleanup).set({ status: "ready" }).where(eq(publicPlaylistCleanup.id, cleanupId!)).run();

  f.adapter.delete = async () => ({ ok: false, error: { code: "NETWORK_ERROR", outcome: "unknown" } });
  service.dispatchCleanup(cleanupId!);
  await service.settle();

  const unknownCleanup = f.database.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId!)).get()!;
  expect(unknownCleanup.status).toBe("awaitingConfirmation");
  expect(["NETWORK_ERROR", "TARGET_STILL_ACTIVE"]).toContain(unknownCleanup.lastErrorCode);
});


