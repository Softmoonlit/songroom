import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type SongRoomApp } from "./app.js";
import { initializeDatabase } from "../db/database.js";
import type { AppConfig } from "../config.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { eq, sql } from "drizzle-orm";
import { publicPlaylistCleanup, neteaseAuthorization, room } from "../db/schema.js";

const origins = new WeakMap<SongRoomApp, string>();
const testCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of testCleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture(existingAdapter?: ScriptedNeteaseAdapter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-cleanup-rec-"));
  testCleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const adapter = existingAdapter ?? new ScriptedNeteaseAdapter();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port,
    baseUrl,
    dbPath,
    staticRoot,
    credentialKeyPath,
    authSecret: "test-secret-with-at-least-32-characters"
  };
  const app = await createApp(config, { neteaseAdapter: adapter });
  origins.set(app, baseUrl);
  testCleanups.push(() => app.close());
  await app.listen();

  return { app, config, adapter, dbPath, credentialKeyPath, staticRoot };
}

async function restartApp(config: AppConfig, adapter: ScriptedNeteaseAdapter) {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const newConfig = { ...config, port, baseUrl: `http://127.0.0.1:${port}` };
  const newApp = await createApp(newConfig, { neteaseAdapter: adapter });
  origins.set(newApp, newConfig.baseUrl);
  testCleanups.push(() => newApp.close());
  await newApp.listen();
  return newApp;
}

function request(app: SongRoomApp, url: string, cookie?: string, body?: unknown, method = "POST") {
  return app.fastify.inject({
    method: method as any,
    url,
    headers: { origin: origins.get(app)!, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
}

async function signUp(app: SongRoomApp, email: string) {
  const response = await request(app, "/api/auth/sign-up/email", undefined, {
    name: "测试账号",
    email,
    password: "Password123!"
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

const userAccounts = new Map<string, string>();
async function bindNetease(app: SongRoomApp, cookie: string, adapter?: ScriptedNeteaseAdapter, customAccountId?: string) {
  if (adapter) {
    let acc = customAccountId ?? userAccounts.get(cookie);
    if (!acc) {
      acc = `acc-${v7()}`;
      userAccounts.set(cookie, acc);
    }
    adapter.identityAccount = acc;
  }
  const started = await request(app, "/api/netease/qr-flows", cookie, { idempotencyKey: v7() });
  expect(started.statusCode).toBe(200);
  const flowId = started.json().id as string;
  expect((await request(app, `/api/netease/qr-flows/${flowId}/check`, cookie, {})).statusCode).toBe(200);
  const result = await request(app, `/api/netease/qr-flows/${flowId}/confirm`, cookie, { idempotencyKey: v7() });
  expect(result.statusCode).toBe(200);
  return result.json().binding.id as string;
}

async function createRoomWithPublicPlaylist(app: SongRoomApp, ownerCookie: string, adapter: ScriptedNeteaseAdapter) {
  const authId = await bindNetease(app, ownerCookie, adapter);
  const roomRes = await request(app, "/api/rooms", ownerCookie, {
    idempotencyKey: v7(),
    authorizationId: authId,
    name: "自建房间",
    nickname: "房主"
  });
  expect(roomRes.statusCode).toBe(200);
  const roomId = roomRes.json().id as string;

  const createPlRes = await request(app, `/api/rooms/${roomId}/public-playlist`, ownerCookie, {
    idempotencyKey: v7()
  });
  expect(createPlRes.statusCode).toBe(202);
  await app.playlists.settle();

  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, ownerCookie, undefined, "GET");
  expect(viewRes.statusCode).toBe(200);
  const { version, publicPlaylist } = viewRes.json();
  expect(publicPlaylist).not.toBeNull();

  return { roomId, publicPlaylistId: publicPlaylist.id, version };
}

describe("恢复结果未知的公共歌单清理 (ticket 18)", { timeout: 20000 }, () => {
  it("明确业务成功时直接完成清理，不强制等待详情接口变为 404", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-succeed@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 设置 adapter：playlistDelete 明确返回 200 / acknowledged
    adapter.inputs = [];
    adapter.playlistDelete = async () => ({ ok: true, data: { acknowledged: true } });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    const delResult = delRes.json();
    expect(delResult.ok).toBe(true);
    expect(delResult.cleanup).not.toBeNull();

    await app.playlists.settle();

    // 验证清理状态为 succeeded
    const cleanupsRes = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanups = cleanupsRes.json().cleanups;
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0].status).toBe("succeeded");
    expect(cleanups[0].playlistId).toBe(publicPlaylistId);

    // 验证 adapter：只有 1 次 playlistDelete 调用，没有调用详情接口或核查
    const deleteCalls = adapter.inputs.filter(i => i.operation === "playlistDelete");
    expect(deleteCalls).toHaveLength(1);
    const detailCalls = adapter.inputs.filter(i => i.operation === "playlistDetail");
    expect(detailCalls).toHaveLength(0);
  });

  it("超时或未知错误进入 awaitingConfirmation，记录 has_sent，恢复后只读核查绝不再次调用删除接口", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-timeout@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 模拟删除调用超时 (DEADLINE, outcome: unknown)
    adapter.inputs = [];
    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "DEADLINE", outcome: "unknown" }
    });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);

    await app.playlists.settle();

    // 验证任务进入 awaitingConfirmation
    const cleanupsRes1 = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes1.statusCode).toBe(200);
    const cleanups1 = cleanupsRes1.json().cleanups;
    expect(cleanups1).toHaveLength(1);
    expect(cleanups1[0].status).toBe("awaitingConfirmation");

    // 验证只调用了 1 次 playlistDelete
    expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(1);

    // 模拟同账号重新扫码恢复授权
    adapter.inputs = [];
    // 模拟只读核查：userPlaylists 中已无该 ID，详情返回 status 10
    adapter.userPlaylists = async () => ({ ok: true, data: { playlists: [], more: false } });
    adapter.playlistDetail = async () => ({
      ok: true,
      data: {
        playlist: { id: publicPlaylistId, name: "已删歌单", creatorId: "test", subscribed: false, status: 10 },
        songIds: [],
        songs: []
      }
    });

    // 模拟房主网易云授权退出（以便重新扫码授权）
    await request(app, "/api/netease/binding/revoke", owner, { idempotencyKey: v7() });

    // 重新绑定相同账号
    const authId = await bindNetease(app, owner, adapter);
    expect(authId).toBeDefined();
    await app.playlists.settle();

    // 验证状态在核查后成功收敛为 succeeded
    const cleanupsRes2 = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes2.statusCode).toBe(200);
    const cleanups2 = cleanupsRes2.json().cleanups;
    expect(cleanups2[0].status).toBe("succeeded");

    // 核心红线验证：绝不自动再次调用删除接口！
    expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);
    // 验证执行的是只读核查 (identity, userPlaylists, playlistDetail)
    expect(adapter.inputs.filter(i => i.operation === "userPlaylists")).toHaveLength(1);
    expect(adapter.inputs.filter(i => i.operation === "playlistDetail")).toHaveLength(1);
  });

  it("服务重启发现处于 sending 时收敛为 awaitingConfirmation，调度只读核查且绝不重发删除", async () => {
    const { app, config, adapter } = await fixture();
    const owner = await signUp(app, "owner-crash@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 将 adapter 的 delete 拦截，在执行前模拟服务崩溃
    let deleteStarted = false;
    adapter.playlistDelete = async () => {
      deleteStarted = true;
      // 模拟进程直接挂掉，未返回响应
      throw new Error("Crash during sending");
    };

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    await app.playlists.settle();

    // 在数据库中模拟系统崩溃中断前处于 sending
    const cleanupRow = app.database.select().from(publicPlaylistCleanup).get()!;
    app.database.update(publicPlaylistCleanup).set({
      status: "sending",
      hasSent: true
    }).where(eq(publicPlaylistCleanup.id, cleanupRow.id)).run();

    // 模拟旧进程崩溃终止
    await app.close();

    // 重启服务
    adapter.inputs = [];
    adapter.userPlaylists = async () => ({ ok: true, data: { playlists: [], more: false } });
    adapter.playlistDetail = async () => ({
      ok: false,
      error: { code: "MODULE_ERROR", outcome: "failed", httpStatus: 404, businessCode: 404 }
    });

    const newApp = await restartApp(config, adapter);
    await newApp.playlists.settle();

    // 验证重启后只读核查确认已删除，收敛为 succeeded
    const cleanupsRes = await request(newApp, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanups = cleanupsRes.json().cleanups;
    expect(cleanups[0].status).toBe("succeeded");

    // 核心红线验证：重启后绝没有调用 playlistDelete
    expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);
  });

  it("核查时详情返回删除墓碑(status 10)但清单仍存为矛盾证据，任务保持 awaitingConfirmation 且停止自动试探", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-conflict@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 删除时模拟网络超时
    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "NETWORK_ERROR", outcome: "unknown" }
    });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    await app.playlists.settle();

    // 重新核查：详情返回墓碑 status 10，但 userPlaylists 依然包含该 ID（矛盾证据）
    adapter.inputs = [];
    adapter.userPlaylists = async () => ({
      ok: true,
      data: {
        playlists: [{ id: publicPlaylistId, name: "公共歌单", creatorId: "test", subscribed: false, status: 0 }],
        more: false
      }
    });
    adapter.playlistDetail = async () => ({
      ok: true,
      data: {
        playlist: { id: publicPlaylistId, name: "公共歌单", creatorId: "test", subscribed: false, status: 10 },
        songIds: ["song-1"],
        songs: [{ id: "song-1", name: "歌曲", artists: ["歌手"], album: "专辑" }]
      }
    });

    // 触发只读核查
    app.playlists.checkCleanupStatus(delRes.json().cleanup!.id);
    await app.playlists.settle();

    // 矛盾证据不能证明删除成功，保持 awaitingConfirmation 并停止自动试探
    const cleanupsRes = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanup = cleanupsRes.json().cleanups[0];
    expect(cleanup.status).toBe("awaitingConfirmation");

    // 绝没有再次调用删除
    expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);
  });

  it("核查时遇到 502 / 读取失败，证据不足保持 awaitingConfirmation 且停止自动试探", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-502@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "DEADLINE", outcome: "unknown" }
    });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    await app.playlists.settle();

    // 核查时 userPlaylists 抛出 502
    adapter.inputs = [];
    adapter.userPlaylists = async () => ({
      ok: false,
      error: { code: "MODULE_ERROR", outcome: "failed", httpStatus: 502 }
    });

    app.playlists.checkCleanupStatus(delRes.json().cleanup!.id);
    await app.playlists.settle();

    const cleanupsRes = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanup = cleanupsRes.json().cleanups[0];
    expect(cleanup.status).toBe("awaitingConfirmation");
    expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);
  });

  it("上游明确拒绝删除时，任务保持 needsAdministrator，房主看到需官方客户端处理，普通用户无核验或重试入口", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-reject@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 上游明确拒绝删除 TARGET_PERMISSION
    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "TARGET_PERMISSION", outcome: "failed" }
    });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    await app.playlists.settle();

    const cleanupsRes = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanup = cleanupsRes.json().cleanups[0];
    expect(cleanup.status).toBe("needsAdministrator");
    expect(cleanup.lastErrorCode).toBe("TARGET_PERMISSION");

    // 验证普通用户没有核验入口
    const retryRes = await request(app, `/api/cleanups/public-playlists/${cleanup.id}/retry`, owner, {});
    expect(retryRes.statusCode).toBe(404);
    const checkRes = await request(app, `/api/cleanups/public-playlists/${cleanup.id}/check`, owner, {});
    expect(checkRes.statusCode).toBe(404);
  });

  it("不同网易云账号授权永远不能处理旧清理任务，非房主无法查看清理记录", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-isolate@example.com");
    const otherUser = await signUp(app, "other@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 房主退出网易云授权
    await request(app, "/api/netease/binding/revoke", owner, { idempotencyKey: v7() });

    // 重新获取最新影响范围（因授权退出会导致聚合版本递增）
    const latestViewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
    expect(latestViewRes.statusCode).toBe(200);
    const newVersion = latestViewRes.json().version;

    // 删房产生 waitingAuthorization 任务
    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version: newVersion
    });
    expect(delRes.statusCode).toBe(200);
    const cleanupId = delRes.json().cleanup!.id;

    // 非房主查询清理列表为空
    const otherCleanups = await request(app, "/api/cleanups/public-playlists", otherUser, undefined, "GET");
    expect(otherCleanups.statusCode).toBe(200);
    expect(otherCleanups.json().cleanups).toHaveLength(0);

    // 第一期不允许绑定新账号：房主扫码不同网易云账号被拒绝 (ACCOUNT_MISMATCH)
    adapter.inputs = [];
    adapter.identityAccount = "different-account-id";
    const flowStarted = await request(app, "/api/netease/qr-flows", owner, { idempotencyKey: v7() });
    expect(flowStarted.statusCode).toBe(200);
    const flowCheck = await request(app, `/api/netease/qr-flows/${flowStarted.json().id}/check`, owner, {});
    expect(flowCheck.statusCode).toBe(409);
    expect(flowCheck.json().error.code).toBe("ACCOUNT_MISMATCH");

    // 其他用户绑定他自己的网易云账号，完全不影响房主的清理任务
    await bindNetease(app, otherUser, adapter, "other-user-cloud-acc");
    await app.playlists.settle();

    // 房主的旧任务仍然是 waitingAuthorization，没有被其他用户的授权处理或触发删除
    const ownerCleanups = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(ownerCleanups.statusCode).toBe(200);
    const targetCleanup = ownerCleanups.json().cleanups.find((c: any) => c.id === cleanupId);
    expect(targetCleanup.status).toBe("waitingAuthorization");
    expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);
  });

  it("旧删除响应与新房间目标隔离：旧删除绝不触及同名或新创建的公共歌单", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-target-isolate@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 删房
    adapter.playlistDelete = async () => ({ ok: true, data: { acknowledged: true } });
    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    await app.playlists.settle();

    // 房主再建一个新房间并创建新公共歌单
    const bindingRes1 = await request(app, "/api/netease/binding", owner, undefined, "GET");
    expect(bindingRes1.statusCode).toBe(200);
    const authId = bindingRes1.json().binding.id;
    const room2Res = await request(app, "/api/rooms", owner, {
      idempotencyKey: v7(),
      authorizationId: authId,
      name: "新房间",
      nickname: "房主"
    });
    expect(room2Res.statusCode).toBe(200);
    const room2Id = room2Res.json().id as string;

    adapter.playlistCreate = async () => ({ ok: true, data: { playlistId: "cloud-new-playlist" } });
    const createPlRes = await request(app, `/api/rooms/${room2Id}/public-playlist`, owner, {
      idempotencyKey: v7()
    });
    expect(createPlRes.statusCode).toBe(202);
    await app.playlists.settle();

    // 验证新房间正常绑定新歌单，未受旧清理任何影响
    const bindingRes = await request(app, `/api/rooms/${room2Id}/public-playlist`, owner, undefined, "GET");
    expect(bindingRes.statusCode).toBe(200);
    expect(bindingRes.json().playlist.id).toBe("cloud-new-playlist");
  });

  it("核查时清单分页不完整(more=true但空页)不得判定为删除成功，保持 awaitingConfirmation", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-incomplete@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "DEADLINE", outcome: "unknown" }
    });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    await app.playlists.settle();

    // 模拟核查时返回 more=true 但 playlists 为空（不完整清单）
    adapter.inputs = [];
    adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: true }
    });
    // 即使详情返回 404
    adapter.playlistDetail = async () => ({
      ok: false,
      error: { code: "MODULE_ERROR", outcome: "failed", httpStatus: 404, businessCode: 404 }
    });

    app.playlists.checkCleanupStatus(delRes.json().cleanup!.id);
    await app.playlists.settle();

    // 验证不完整清单不能证明删除成功，必须保持 awaitingConfirmation
    const cleanupsRes = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanup = cleanupsRes.json().cleanups[0];
    expect(cleanup.status).toBe("awaitingConfirmation");
  });

  it("删除或核查遇到 RATE_LIMITED 时暂停整个账号，任务进入 needsAdministrator", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-ratelimit@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    // 模拟删除遇到上游风控 RATE_LIMITED
    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "RATE_LIMITED", outcome: "failed" }
    });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
      idempotencyKey: v7(),
      version
    });
    expect(delRes.statusCode).toBe(200);
    await app.playlists.settle();

    const cleanupsRes = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanup = cleanupsRes.json().cleanups[0];
    expect(cleanup.status).toBe("needsAdministrator");
    expect(cleanup.lastErrorCode).toBe("ACCOUNT_PAUSED");

    // 验证账号已被暂停，后续上游任务被拒绝
    const bindingData = (await request(app, "/api/netease/binding", owner, undefined, "GET")).json();
    expect(app.scheduler.paused(bindingData.binding.identity.accountId)).toBe(true);
  });

  it("公开清理查询严格隐藏 internal creationOperationId 字段", async () => {
    const { app, adapter } = await fixture();
    const owner = await signUp(app, "owner-priv@example.com");

    const { roomId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "DEADLINE", outcome: "unknown" }
    });

    await request(app, `/api/rooms/${roomId}/delete`, owner, { idempotencyKey: v7(), version });
    await app.playlists.settle();

    const cleanupsRes = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes.statusCode).toBe(200);
    const cleanup = cleanupsRes.json().cleanups[0];
    expect("creationOperationId" in cleanup).toBe(false);
  });

  it("一次不确定核查后(checkRound > 0)再次重启绝不重复自动试探", async () => {
    const { app, config, adapter } = await fixture();
    const owner = await signUp(app, "owner-no-repeat@example.com");

    const { roomId, publicPlaylistId, version } = await createRoomWithPublicPlaylist(app, owner, adapter);

    adapter.playlistDelete = async () => ({
      ok: false,
      error: { code: "DEADLINE", outcome: "unknown" }
    });

    const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, { idempotencyKey: v7(), version });
    await app.playlists.settle();

    // 第一次核查：502 读取失败，checkRound 变为 1，保持 awaitingConfirmation
    adapter.userPlaylists = async () => ({
      ok: false,
      error: { code: "MODULE_ERROR", outcome: "failed", httpStatus: 502 }
    });
    app.playlists.checkCleanupStatus(delRes.json().cleanup!.id);
    await app.playlists.settle();

    const cleanupsRes1 = await request(app, "/api/cleanups/public-playlists", owner, undefined, "GET");
    expect(cleanupsRes1.json().cleanups[0].status).toBe("awaitingConfirmation");

    // 重启应用
    await app.close();
    adapter.inputs = [];
    const newApp = await restartApp(config, adapter);
    await newApp.playlists.settle();

    // 验证重启后没有自动再次发起上游核查调用（停止自动试探）
    const userPlCalls = adapter.inputs.filter(i => i.operation === "userPlaylists");
    expect(userPlCalls).toHaveLength(0);
  });
});
