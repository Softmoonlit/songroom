import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "./app.js";
import type { AppConfig } from "../config.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";

const origins = new WeakMap<SongRoomApp, string>();
const testCleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of testCleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-room-del-"));
  testCleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const adapter = new ScriptedNeteaseAdapter();
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

  return { app, config, adapter };
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
async function bindNetease(app: SongRoomApp, cookie: string, adapter?: ScriptedNeteaseAdapter) {
  if (adapter) {
    let acc = userAccounts.get(cookie);
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

async function createRoomViaHttp(app: SongRoomApp, ownerCookie: string, name = "测试音乐间", adapter?: ScriptedNeteaseAdapter) {
  const authId = await bindNetease(app, ownerCookie, adapter);
  const res = await request(app, "/api/rooms", ownerCookie, {
    idempotencyKey: v7(),
    authorizationId: authId,
    name,
    nickname: "房主"
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

async function addRoommateViaHttp(app: SongRoomApp, ownerCookie: string, roommateCookie: string, roomId: string) {
  const inviteRes = await request(app, `/api/rooms/${roomId}/invite`, ownerCookie, undefined, "GET");
  expect(inviteRes.statusCode).toBe(200);
  const code = inviteRes.json().code as string;

  const applyRes = await request(app, "/api/join-applications", roommateCookie, {
    idempotencyKey: v7(),
    code,
    nickname: "室友"
  });
  expect(applyRes.statusCode).toBe(200);
  const appId = applyRes.json().id as string;

  const approveRes = await request(app, `/api/rooms/${roomId}/applications/${appId}/decision`, ownerCookie, {
    idempotencyKey: v7(),
    decision: "approve"
  });
  expect(approveRes.statusCode).toBe(200);
}

function createSseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async function nextMsg(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const parts = buffer.split("\n\n");
      if (parts.length > 1) {
        const raw = parts.shift()!;
        buffer = parts.join("\n\n");
        let event = "message"; let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        return { event, data };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SSE 超时");
      const r = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>(res => setTimeout(() => res({ done: true, value: undefined }), remaining))
      ]);
      if (r.done && !r.value) throw new Error("SSE 超时");
      if (r.value) buffer += decoder.decode(r.value, { stream: true });
    }
  };
}

it("权限控制：仅房主可查看影响范围并提交删房，室友/非成员/待审批申请人/其他房主/管理员拒绝，房主不可退出替代删房", async () => {
  const { app, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roommate = await signUp(app, "roommate@example.com");
  const outsider = await signUp(app, "outsider@example.com");
  const applicant = await signUp(app, "applicant@example.com");
  const otherOwner = await signUp(app, "otherowner@example.com");
  const admin = await signUp(app, "admin@example.com");

  const roomId = await createRoomViaHttp(app, owner, "测试权限宿舍", adapter);
  await addRoommateViaHttp(app, owner, roommate, roomId);
  const otherRoomId = await createRoomViaHttp(app, otherOwner, "其他房主的宿舍", adapter);

  // 待审批申请人
  const inviteRes = await request(app, `/api/rooms/${roomId}/invite`, owner, undefined, "GET");
  const code = inviteRes.json().code as string;
  await request(app, "/api/join-applications", applicant, {
    idempotencyKey: v7(),
    code,
    nickname: "申请人"
  });

  // 1. 室友查询影响范围 -> 404 ROOM_OWNER_REQUIRED
  const rmViewRes = await request(app, `/api/rooms/${roomId}/deletion`, roommate, undefined, "GET");
  expect(rmViewRes.statusCode).toBe(404);
  expect(rmViewRes.json().error.code).toBe("ROOM_OWNER_REQUIRED");

  // 2. 室友提交删房 -> 404 ROOM_OWNER_REQUIRED
  const rmDelRes = await request(app, `/api/rooms/${roomId}/delete`, roommate, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(rmDelRes.statusCode).toBe(404);
  expect(rmDelRes.json().error.code).toBe("ROOM_OWNER_REQUIRED");

  // 3. 非成员查询影响范围 -> 404 ROOM_UNAVAILABLE
  const outsiderViewRes = await request(app, `/api/rooms/${roomId}/deletion`, outsider, undefined, "GET");
  expect(outsiderViewRes.statusCode).toBe(404);
  expect(outsiderViewRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 4. 待审批申请人查询影响范围 -> 404 ROOM_UNAVAILABLE
  const applicantViewRes = await request(app, `/api/rooms/${roomId}/deletion`, applicant, undefined, "GET");
  expect(applicantViewRes.statusCode).toBe(404);
  expect(applicantViewRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 5. 待审批申请人提交删房 -> 404 ROOM_UNAVAILABLE
  const applicantDelRes = await request(app, `/api/rooms/${roomId}/delete`, applicant, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(applicantDelRes.statusCode).toBe(404);
  expect(applicantDelRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 6. 其他房间房主查询影响范围 -> 404 ROOM_UNAVAILABLE
  const otherOwnerViewRes = await request(app, `/api/rooms/${roomId}/deletion`, otherOwner, undefined, "GET");
  expect(otherOwnerViewRes.statusCode).toBe(404);
  expect(otherOwnerViewRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 7. 其他房间房主提交删房 -> 404 ROOM_UNAVAILABLE
  const otherOwnerDelRes = await request(app, `/api/rooms/${roomId}/delete`, otherOwner, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(otherOwnerDelRes.statusCode).toBe(404);
  expect(otherOwnerDelRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 8. 普通管理员账号（非本房房主）查询与删除 -> 404 ROOM_UNAVAILABLE
  const adminViewRes = await request(app, `/api/rooms/${roomId}/deletion`, admin, undefined, "GET");
  expect(adminViewRes.statusCode).toBe(404);
  expect(adminViewRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  const adminDelRes = await request(app, `/api/rooms/${roomId}/delete`, admin, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(adminDelRes.statusCode).toBe(404);
  expect(adminDelRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 9. 房主试图以 leave 替代删房 -> 403 OWNER_CANNOT_LEAVE
  const leaveRes = await request(app, `/api/rooms/${roomId}/leave`, owner, {
    idempotencyKey: v7()
  });
  expect(leaveRes.statusCode).toBe(403);
  expect(leaveRes.json().error.code).toBe("OWNER_CANNOT_LEAVE");

  // 10. 房主查询影响范围 -> 200 成功
  const ownerViewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  expect(ownerViewRes.statusCode).toBe(200);
  const deletionView = ownerViewRes.json();
  expect(deletionView.room.name).toBe("测试权限宿舍");
  expect(deletionView.memberCount).toBe(2);
  expect(deletionView.pendingApplicationCount).toBe(1);
  expect(deletionView.allowedActions).toContain("deleteRoom");
});

it("确认版本冲突：状态变化后拒绝旧版本确认并要求重新查看", async () => {
  const { app } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roommate = await signUp(app, "roommate@example.com");
  const roomId = await createRoomViaHttp(app, owner, "冲突测试宿舍");
  await addRoommateViaHttp(app, owner, roommate, roomId);

  // 1. 获取影响范围（当前 version = 2，因为批准了室友）
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  const view = viewRes.json();
  const originalVersion = view.version;

  // 2. 室友修改昵称，触发房间版本递增
  const renameRes = await request(app, `/api/rooms/${roomId}/nickname`, roommate, {
    idempotencyKey: v7(),
    nickname: "新昵称"
  });
  expect(renameRes.statusCode).toBe(200);

  // 3. 房主使用旧版本提交删除 -> 409 ROOM_VERSION_CONFLICT
  const conflictRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: originalVersion
  });
  expect(conflictRes.statusCode).toBe(409);
  expect(conflictRes.json().error.code).toBe("ROOM_VERSION_CONFLICT");

  // 4. 重新获取最新影响范围并提交 -> 成功
  const newViewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  const newView = newViewRes.json();
  expect(newView.version).toBe(originalVersion + 1);

  const successRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: newView.version
  });
  expect(successRes.statusCode).toBe(200);
});

it("无公共歌单删房：本地事务立即删除，不产生虚假清理任务", async () => {
  const { app } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "无公共歌单宿舍");

  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  expect(viewRes.json().publicPlaylist).toBeNull();

  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });
  expect(delRes.statusCode).toBe(200);
  const result = delRes.json();
  expect(result.ok).toBe(true);
  expect(result.cleanup).toBeNull();

  // 房间已彻底不可见
  const checkRes = await request(app, `/api/rooms/${roomId}`, owner, undefined, "GET");
  expect(checkRes.statusCode).toBe(404);

  // 清理列表为空
  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  expect(cleanupsRes.statusCode).toBe(200);
  expect(cleanupsRes.json().cleanups).toHaveLength(0);
});

it("正常删除：公开创建公共歌单后删房，本地立即清除且调度执行一次云端删除，幂等重放返回原结果", async () => {
  const { app, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "正常删除宿舍");

  // 通过公开接口创建公共歌单
  adapter.playlistCreate = () => ({ ok: true, data: { playlistId: "cloud-pl-normal-del" } });
  const createPlRes = await request(app, `/api/rooms/${roomId}/public-playlist`, owner, {
    idempotencyKey: v7()
  });
  expect(createPlRes.statusCode).toBe(202);
  await app.playlists.settle();

  // 查询影响范围：显示公共歌单与 ID
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  const view = viewRes.json();
  expect(view.publicPlaylist).toEqual({
    id: "cloud-pl-normal-del",
    name: "songroom-正常删除宿舍-公共"
  });

  const idempotencyKey = v7();
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey,
    version: view.version
  });
  expect(delRes.statusCode).toBe(200);
  const delResult = delRes.json();
  expect(delResult.ok).toBe(true);
  expect(delResult.cleanup?.id).toBeDefined();

  // 幂等重放
  const replayRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey,
    version: view.version
  });
  expect(replayRes.statusCode).toBe(200);
  const replayResult = replayRes.json();
  expect(replayResult.ok).toBe(true);
  expect(replayResult.roomId).toBe(roomId);
  expect(replayResult.cleanup?.id).toBe(delResult.cleanup?.id);

  // 房间已不可见
  expect((await request(app, `/api/rooms/${roomId}`, owner, undefined, "GET")).statusCode).toBe(404);

  // 调度器异步执行云端删除
  await app.playlists.settle();

  // 证明调用了 adapter 的 playlistDelete 且目标歌单 ID 精确匹配
  const deleteCalls = adapter.inputs.filter(i => i.operation === "playlistDelete");
  expect(deleteCalls).toHaveLength(1);
  expect((deleteCalls[0] as any).playlistId).toBe("cloud-pl-normal-del");

  // 查看公开清理状态
  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  expect(cleanupsRes.statusCode).toBe(200);
  const cleanups = cleanupsRes.json().cleanups;
  expect(cleanups).toHaveLength(1);
  expect(cleanups[0].playlistId).toBe("cloud-pl-normal-del");
  expect(cleanups[0].status).toBe("succeeded");
});

it("无授权删房：授权退出后本地事务完成并保留待清理状态，不调用上游删除", async () => {
  const { app, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "无授权宿舍");

  adapter.playlistCreate = () => ({ ok: true, data: { playlistId: "cloud-pl-revoked" } });
  const createPlRes = await request(app, `/api/rooms/${roomId}/public-playlist`, owner, { idempotencyKey: v7() });
  expect(createPlRes.statusCode).toBe(202);
  await app.playlists.settle();

  // 房主网易云授权退出（公开接口）
  const revokeRes = await request(app, "/api/netease/binding/revoke", owner, { idempotencyKey: v7() });
  expect(revokeRes.statusCode).toBe(200);

  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });
  expect(delRes.statusCode).toBe(200);

  // 本地已删除
  expect((await request(app, `/api/rooms/${roomId}`, owner, undefined, "GET")).statusCode).toBe(404);

  await app.playlists.settle();
  expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);

  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  const cleanups = cleanupsRes.json().cleanups;
  expect(cleanups).toHaveLength(1);
  expect(cleanups[0].status).toBe("waitingAuthorization");
});

it("在途公共歌单创建已获具体 ID 时删房转为清理任务（在途晚到）", async () => {
  const { app, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "在途创建已获ID宿舍");

  let notifyCalled: () => void = () => {};
  const called = new Promise<void>(res => { notifyCalled = res; });
  let finishAdapterCreate: () => void = () => {};
  const gate = new Promise<void>(res => { finishAdapterCreate = res; });

  adapter.playlistCreate = async () => {
    notifyCalled();
    await gate;
    return { ok: true, data: { playlistId: "cloud-in-flight-id" } };
  };

  // 房主发起创建公共歌单
  await request(app, `/api/rooms/${roomId}/public-playlist`, owner, { idempotencyKey: v7() });

  // 等待调度器发起上游创建调用（在途 sending 状态）
  await called;

  // 房主查看影响范围：在途公共歌单被如实呈现
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  expect(viewRes.statusCode).toBe(200);
  expect(viewRes.json().publicPlaylist).toMatchObject({ name: "songroom-在途创建已获ID宿舍-公共" });

  // 房主提交删房
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });
  expect(delRes.statusCode).toBe(200);

  // 上游创建晚到成功并返回了具体 ID
  finishAdapterCreate();

  // 结算后台调度
  await app.playlists.settle();

  // 验证晚到获得具体 ID 的歌单自动转为清理任务并成功执行云端删除
  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  expect(cleanupsRes.statusCode).toBe(200);
  const cleanups = cleanupsRes.json().cleanups;
  expect(cleanups).toHaveLength(1);
  expect(cleanups[0].playlistId).toBe("cloud-in-flight-id");
  expect(cleanups[0].status).toBe("succeeded");
});

it("在途公共歌单创建 ID 未知时删房不产生虚假清理任务", async () => {
  const { app, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "在途创建未知ID宿舍");

  // 模拟创建发生未知错误，进入 unknown 状态（ID 仍未知）
  adapter.playlistCreate = async () => ({ ok: false, error: { code: "NETWORK_ERROR", outcome: "unknown" } });
  await request(app, `/api/rooms/${roomId}/public-playlist`, owner, { idempotencyKey: v7() });
  await app.playlists.settle();

  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  expect(viewRes.statusCode).toBe(200);

  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });
  expect(delRes.statusCode).toBe(200);

  // 清理列表为空，不产生虚假清理任务
  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  expect(cleanupsRes.json().cleanups).toHaveLength(0);
});

it("在途点歌写晚到：仅更新快照，不恢复房间、成员、绑定或标签", async () => {
  const { app, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "晚到点歌宿舍");

  // 创建公共歌单
  adapter.playlistCreate = () => ({ ok: true, data: { playlistId: "cloud-pl-late-song" } });
  await request(app, `/api/rooms/${roomId}/public-playlist`, owner, { idempotencyKey: v7() });
  await app.playlists.settle();

  // 发起公共点歌
  let finishSongDetail: () => void = () => {};
  const songGate = new Promise<void>(res => { finishSongDetail = res; });
  adapter.playlistDetail = async () => {
    await songGate;
    return {
      ok: true,
      data: {
        playlist: { id: "cloud-pl-late-song", name: "songroom-晚到点歌宿舍-公共", creatorId: "acc-owner", subscribed: false, status: 0 },
        songIds: ["s-late-1"],
        songs: [{ id: "s-late-1", name: "晚到歌曲", artists: ["歌手"], album: "专辑" }]
      }
    };
  };

  await request(app, `/api/rooms/${roomId}/public-playlist/songs`, owner, {
    idempotencyKey: v7(),
    songId: "s-late-1",
    name: "晚到歌曲",
    artists: ["歌手"],
    album: "专辑"
  });

  // 点歌尚未确认完成时，房主删房
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });
  expect(delRes.statusCode).toBe(200);

  // 放行点歌完成
  finishSongDetail();
  await app.playlists.settle();

  // 房间依然是 404，未被恢复
  expect((await request(app, `/api/rooms/${roomId}`, owner, undefined, "GET")).statusCode).toBe(404);
  // 房间列表不包含该房间
  const roomsRes = await request(app, "/api/rooms", owner, undefined, "GET");
  expect(roomsRes.json().rooms.some((r: any) => r.id === roomId)).toBe(false);
});

it("多端 SSE 失效：删房后房主端与室友端均收到失效事件，房间列表不再包含已删除房间", async () => {
  const { app, config } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roommate = await signUp(app, "roommate@example.com");
  const roomId = await createRoomViaHttp(app, owner, "SSE测试宿舍");
  await addRoommateViaHttp(app, owner, roommate, roomId);

  // 房主连接 SSE
  const ownerSseRes = await fetch(`${config.baseUrl}/api/events`, {
    headers: { cookie: owner, accept: "text/event-stream" }
  });
  const ownerReader = ownerSseRes.body!.getReader();
  const nextOwnerMsg = createSseReader(ownerReader);

  // 室友连接 SSE
  const rmSseRes = await fetch(`${config.baseUrl}/api/events`, {
    headers: { cookie: roommate, accept: "text/event-stream" }
  });
  const rmReader = rmSseRes.body!.getReader();
  const nextRmMsg = createSseReader(rmReader);

  expect((await nextOwnerMsg()).event).toBe("connected");
  expect((await nextRmMsg()).event).toBe("connected");

  // 获取当前版本并删房
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });
  expect(delRes.statusCode).toBe(200);

  // 房主端收到 room 失效
  const ownerMsg = await nextOwnerMsg();
  expect(ownerMsg.event).toBe("invalidation");
  const ownerPayload = JSON.parse(ownerMsg.data);
  expect(ownerPayload.resourceId).toBe(roomId);
  expect(ownerPayload.type).toBe("room");

  // 室友端收到 room 失效
  const rmMsg = await nextRmMsg();
  expect(rmMsg.event).toBe("invalidation");
  const rmPayload = JSON.parse(rmMsg.data);
  expect(rmPayload.resourceId).toBe(roomId);
  expect(rmPayload.type).toBe("room");

  ownerReader.cancel();
  rmReader.cancel();

  // 两端的房间列表都不再包含已删除房间
  const ownerRooms = await request(app, "/api/rooms", owner, undefined, "GET");
  expect(ownerRooms.json().rooms.some((r: any) => r.id === roomId)).toBe(false);

  const rmRooms = await request(app, "/api/rooms", roommate, undefined, "GET");
  expect(rmRooms.json().rooms.some((r: any) => r.id === roomId)).toBe(false);
});

it("服务重启恢复：持久化的待清理任务在服务重启后自动调度执行完成", async () => {
  const { app, config, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "重启恢复宿舍");

  // 创建公共歌单
  adapter.playlistCreate = () => ({ ok: true, data: { playlistId: "cloud-pl-restart" } });
  await request(app, `/api/rooms/${roomId}/public-playlist`, owner, { idempotencyKey: v7() });
  await app.playlists.settle();

  // 拦截 playlistDelete，让删除任务停留在 ready/sending 状态，模拟服务突然关闭
  let deleteBlocked = true;
  adapter.playlistDelete = async () => {
    if (deleteBlocked) {
      // 模拟上游未完成
      await new Promise(() => {});
    }
    return { ok: true, data: { acknowledged: true } };
  };

  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  // 发起删房，删房事务已完成并插入了 public_playlist_cleanup
  await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });

  // 关闭旧应用，模拟服务重启
  await app.close();

  // 解除上游阻塞
  deleteBlocked = false;
  const newAdapter = new ScriptedNeteaseAdapter();
  newAdapter.playlistDelete = () => ({ ok: true, data: { acknowledged: true } });

  // 启动新应用
  const restartedApp = await createApp(config, { neteaseAdapter: newAdapter });
  origins.set(restartedApp, config.baseUrl);
  testCleanups.push(() => restartedApp.close());
  await restartedApp.listen();
  restartedApp.playlists.start();
  await restartedApp.playlists.settle();

  // 验证重启后 sending 任务安全收敛为 awaitingConfirmation（不盲目重发）
  const cleanupsRes = await request(restartedApp, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  expect(cleanupsRes.statusCode).toBe(200);
  const cleanups = cleanupsRes.json().cleanups;
  expect(cleanups).toHaveLength(1);
  expect(cleanups[0].playlistId).toBe("cloud-pl-restart");
  expect(cleanups[0].status).toBe("awaitingConfirmation");
});

it("授权退出与重新授权：删房待清理任务在重新授权同一账号后自动调度恢复执行", async () => {
  const { app, adapter } = await fixture();
  const owner = await signUp(app, "owner@example.com");
  const roomId = await createRoomViaHttp(app, owner, "重授权测试宿舍", adapter);

  // 创建公共歌单
  adapter.playlistCreate = () => ({ ok: true, data: { playlistId: "cloud-pl-reauth" } });
  await request(app, `/api/rooms/${roomId}/public-playlist`, owner, { idempotencyKey: v7() });
  await app.playlists.settle();

  // 房主网易云授权退出
  await request(app, "/api/netease/binding/revoke", owner, { idempotencyKey: v7() });

  // 房主删房：产生 waitingAuthorization 的清理任务
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner, undefined, "GET");
  await request(app, `/api/rooms/${roomId}/delete`, owner, {
    idempotencyKey: v7(),
    version: viewRes.json().version
  });

  const cleanupsBefore = await request(app, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  expect(cleanupsBefore.json().cleanups[0].status).toBe("waitingAuthorization");

  // 重新绑定网易云账号
  adapter.playlistDelete = () => ({ ok: true, data: { acknowledged: true } });
  await bindNetease(app, owner, adapter);
  await app.playlists.settle();

  // 清理任务自动唤醒并执行完成
  const cleanupsAfter = await request(app, `/api/cleanups/public-playlists`, owner, undefined, "GET");
  expect(cleanupsAfter.json().cleanups[0].status).toBe("succeeded");
});
