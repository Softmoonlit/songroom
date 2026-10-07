import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { eq } from "drizzle-orm";
import { room, roomMembership, neteaseAuthorization, publicPlaylistBinding, roomInvite, operation, publicSongRequest, playlistSnapshot, requesterTag } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-room-deletion-test-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
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
  const config = {
    nodeEnv: "test" as const,
    host: "127.0.0.1" as const,
    port,
    baseUrl,
    dbPath,
    staticRoot,
    credentialKeyPath,
    authSecret: "test-secret-with-at-least-32-characters"
  };
  const app = await createApp(config, { neteaseAdapter: adapter });
  origins.set(app, baseUrl);
  cleanups.push(() => app.close());
  await app.listen();

  const owner = await signup(app, "owner@example.com");
  const roommate = await signup(app, "roommate@example.com");
  const outsider = await signup(app, "outsider@example.com");

  const roomId = v7();
  const authorizationId = v7();
  app.database.insert(room).values({ id: roomId, ownerUserId: owner.userId, name: "测试宿舍", version: 1 }).run();
  const ownerMemberId = v7();
  const rmMemberId = v7();
  app.database.insert(roomMembership).values([
    { id: ownerMemberId, roomId, userId: owner.userId, nickname: "房主" },
    { id: rmMemberId, roomId, userId: roommate.userId, nickname: "室友" }
  ]).run();
  app.database.insert(roomInvite).values({ roomId, code: "inv-code01", generation: 1 }).run();

  const credentials = new CredentialVault(credentialKeyPath).encrypt("MUSIC_U=test", { authorizationId, accountId: "acc-owner", generation: 1 });
  app.database.insert(neteaseAuthorization).values({
    id: authorizationId,
    userId: owner.userId,
    accountId: "acc-owner",
    nickname: "网易房主",
    generation: 1,
    status: "active",
    credentials
  }).run();

  return { app, owner, roommate, outsider, roomId, authorizationId, adapter, config };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: origins.get(app)! },
    payload: { name: "用户", email, password: "Password123!" }
  });
  expect(response.statusCode).toBe(200);
  return {
    userId: response.json().user.id as string,
    cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ")
  };
}

function request(app: SongRoomApp, url: string, cookie?: string, body?: unknown, method = "POST") {
  return app.fastify.inject({
    method: method as any,
    url,
    headers: { origin: origins.get(app)!, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
}

it("权限控制：仅房主可查看影响范围并提交删房，室友/非成员拒绝，房主不可退出替代删房", async () => {
  const { app, owner, roommate, outsider, roomId } = await fixture();

  // 1. 室友查询影响范围 -> 404 ROOM_OWNER_REQUIRED
  const rmViewRes = await request(app, `/api/rooms/${roomId}/deletion`, roommate.cookie, undefined, "GET");
  expect(rmViewRes.statusCode).toBe(404);
  expect(rmViewRes.json().error.code).toBe("ROOM_OWNER_REQUIRED");

  // 2. 室友提交删房 -> 404 ROOM_OWNER_REQUIRED
  const rmDelRes = await request(app, `/api/rooms/${roomId}/delete`, roommate.cookie, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(rmDelRes.statusCode).toBe(404);
  expect(rmDelRes.json().error.code).toBe("ROOM_OWNER_REQUIRED");

  // 3. 非成员查询影响范围 -> 404 ROOM_UNAVAILABLE
  const outsiderViewRes = await request(app, `/api/rooms/${roomId}/deletion`, outsider.cookie, undefined, "GET");
  expect(outsiderViewRes.statusCode).toBe(404);
  expect(outsiderViewRes.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 4. 房主试图以 leave 替代删房 -> 403 OWNER_CANNOT_LEAVE
  const leaveRes = await request(app, `/api/rooms/${roomId}/leave`, owner.cookie, {
    idempotencyKey: v7()
  });
  expect(leaveRes.statusCode).toBe(403);
  expect(leaveRes.json().error.code).toBe("OWNER_CANNOT_LEAVE");

  // 5. 房主查询影响范围 -> 200 成功
  const ownerViewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner.cookie, undefined, "GET");
  expect(ownerViewRes.statusCode).toBe(200);
  const deletionView = ownerViewRes.json();
  expect(deletionView.room.name).toBe("测试宿舍");
  expect(deletionView.memberCount).toBe(2);
  expect(deletionView.pendingApplicationCount).toBe(0);
  expect(deletionView.allowedActions).toContain("deleteRoom");
});

it("确认版本冲突：状态变化后拒绝旧版本确认并要求重新查看", async () => {
  const { app, owner, roommate, roomId } = await fixture();

  // 1. 获取影响范围（当前 version = 1）
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner.cookie, undefined, "GET");
  const view = viewRes.json();
  expect(view.version).toBe(1);

  // 2. 室友修改昵称，触发房间版本递增
  const renameRes = await request(app, `/api/rooms/${roomId}/nickname`, roommate.cookie, {
    idempotencyKey: v7(),
    nickname: "新昵称"
  });
  expect(renameRes.statusCode).toBe(200);

  // 3. 房主使用旧版本提交删除 -> 409 ROOM_VERSION_CONFLICT
  const conflictRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(conflictRes.statusCode).toBe(409);
  expect(conflictRes.json().error.code).toBe("ROOM_VERSION_CONFLICT");

  // 4. 重新获取最新影响范围（version = 2）并提交 -> 成功
  const newViewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner.cookie, undefined, "GET");
  const newView = newViewRes.json();
  expect(newView.version).toBe(2);

  const successRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey: v7(),
    version: 2
  });
  expect(successRes.statusCode).toBe(200);
});

it("无公共歌单删房：本地事务立即删除，不产生虚假清理任务", async () => {
  const { app, owner, roomId } = await fixture();

  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner.cookie, undefined, "GET");
  expect(viewRes.json().publicPlaylist).toBeNull();

  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(delRes.statusCode).toBe(200);
  const result = delRes.json();
  expect(result.ok).toBe(true);
  expect(result.cleanup).toBeNull();

  // 房间已彻底不可见
  const checkRes = await request(app, `/api/rooms/${roomId}`, owner.cookie, undefined, "GET");
  expect(checkRes.statusCode).toBe(404);

  // 清理列表为空
  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner.cookie, undefined, "GET");
  expect(cleanupsRes.statusCode).toBe(200);
  expect(cleanupsRes.json().cleanups).toHaveLength(0);
});

it("正常删除：绑定专用公共歌单，本地立即清除且调度执行一次云端删除，幂等重放返回原结果", async () => {
  const { app, owner, roomId, adapter } = await fixture();

  // 插入已绑定的公共歌单
  const creationOpId = v7();
  app.database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "acc-owner",
    playlistId: "cloud-pl-to-delete",
    name: "songroom-测试宿舍-公共",
    creationOperationId: creationOpId,
    generation: 1
  }).run();

  // 查询影响范围：显示公共歌单与 willCleanUp: true
  const viewRes = await request(app, `/api/rooms/${roomId}/deletion`, owner.cookie, undefined, "GET");
  const view = viewRes.json();
  expect(view.publicPlaylist).toEqual({
    id: "cloud-pl-to-delete",
    name: "songroom-测试宿舍-公共",
    willCleanUp: true
  });

  const idempotencyKey = v7();
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey,
    version: 1
  });
  expect(delRes.statusCode).toBe(200);
  const delResult = delRes.json();
  expect(delResult.ok).toBe(true);
  expect(delResult.cleanup?.id).toBeDefined();

  // 幂等重放
  const replayRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey,
    version: 1
  });
  expect(replayRes.statusCode).toBe(200);
  const replayResult = replayRes.json();
  expect(replayResult.ok).toBe(true);
  expect(replayResult.roomId).toBe(roomId);
  expect(replayResult.cleanup?.id).toBe(delResult.cleanup?.id);

  // 房间本地数据已彻底清除
  expect(app.database.select().from(room).where(eq(room.id, roomId)).all()).toHaveLength(0);
  expect(app.database.select().from(roomMembership).where(eq(roomMembership.roomId, roomId)).all()).toHaveLength(0);
  expect(app.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).all()).toHaveLength(0);

  // 调度器异步执行云端删除
  await app.playlists.settle();

  // 证明调用了 adapter 的 playlistDelete 且目标歌单 ID 精确匹配
  const deleteCalls = adapter.inputs.filter(i => i.operation === "playlistDelete");
  expect(deleteCalls).toHaveLength(1);
  expect((deleteCalls[0] as any).playlistId).toBe("cloud-pl-to-delete");

  // 查看公开清理状态
  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner.cookie, undefined, "GET");
  expect(cleanupsRes.statusCode).toBe(200);
  const cleanups = cleanupsRes.json().cleanups;
  expect(cleanups).toHaveLength(1);
  expect(cleanups[0].playlistId).toBe("cloud-pl-to-delete");
  expect(cleanups[0].status).toBe("succeeded");
});

it("无授权删房：本地事务完成并保留待清理状态，不调用上游删除", async () => {
  const { app, owner, roomId, adapter } = await fixture();

  app.database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "acc-owner",
    playlistId: "cloud-pl-no-auth",
    name: "songroom-测试宿舍-公共",
    creationOperationId: v7(),
    generation: 1
  }).run();

  // 房主网易云授权退出
  app.database.update(neteaseAuthorization).set({ status: "waitingAuthorization", credentials: null }).run();

  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(delRes.statusCode).toBe(200);

  // 本地已删除
  expect(app.database.select().from(room).where(eq(room.id, roomId)).all()).toHaveLength(0);

  await app.playlists.settle();
  expect(adapter.inputs.filter(i => i.operation === "playlistDelete")).toHaveLength(0);

  const cleanupsRes = await request(app, `/api/cleanups/public-playlists`, owner.cookie, undefined, "GET");
  const cleanups = cleanupsRes.json().cleanups;
  expect(cleanups).toHaveLength(1);
  expect(cleanups[0].status).toBe("waitingAuthorization");
});

it("在途点歌写晚到：仅更新快照，不恢复房间、成员、绑定或标签", async () => {
  const { app, owner, roomId, adapter } = await fixture();

  app.database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "acc-owner",
    playlistId: "cloud-pl-inflight",
    name: "songroom-测试宿舍-公共",
    creationOperationId: v7(),
    generation: 1
  }).run();
  app.database.insert(playlistSnapshot).values({
    accountId: "acc-owner",
    playlistId: "cloud-pl-inflight",
    snapshotVersion: 1,
    syncedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();

  // 插入一个在途点歌请求（sending 阶段）
  const songOpId = v7();
  app.database.insert(operation).values({
    id: songOpId,
    kind: "requestPublicSong",
    userId: owner.userId,
    roomId,
    accountId: "acc-owner",
    authorizationId: v7(),
    generation: 1,
    status: "processing",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();
  app.database.insert(publicSongRequest).values({
    operationId: songOpId,
    songId: "s-late-1",
    name: "晚到歌曲",
    artists: JSON.stringify(["歌手"]),
    album: "专辑",
    step: "confirming",
    playlistId: "cloud-pl-inflight",
    bindingGeneration: 1
  }).run();

  // 删房
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(delRes.statusCode).toBe(200);

  // 房间、标签均为空
  expect(app.database.select().from(room).where(eq(room.id, roomId)).all()).toHaveLength(0);
  expect(app.database.select().from(requesterTag).all()).toHaveLength(0);

  // 模拟在途请求晚到完成
  adapter.playlistDetail = () => ({
    ok: true,
    data: {
      playlist: { id: "cloud-pl-inflight", name: "songroom-测试宿舍-公共", creatorId: "acc-owner", subscribed: false, status: 0 },
      songIds: ["s-late-1"],
      songs: [{ id: "s-late-1", name: "晚到歌曲", artists: ["歌手"], album: "专辑" }]
    }
  });

  await app.playlists.settle();

  // 检查：房间未被恢复，标签未被写入
  expect(app.database.select().from(room).where(eq(room.id, roomId)).all()).toHaveLength(0);
  expect(app.database.select().from(roomMembership).all()).toHaveLength(0);
  expect(app.database.select().from(requesterTag).all()).toHaveLength(0);
});

it("多端 SSE 失效：删房后房主端与室友端均收到失效事件，房间列表不再包含已删除房间", async () => {
  const { app, owner, roommate, roomId, config } = await fixture();

  // 房主连接 SSE
  const ownerSseRes = await fetch(`${config.baseUrl}/api/events`, {
    headers: { cookie: owner.cookie, accept: "text/event-stream" }
  });
  const ownerReader = ownerSseRes.body!.getReader();
  const ownerDecoder = new TextDecoder();
  let ownerBuffer = "";

  async function nextOwnerMsg(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const parts = ownerBuffer.split("\n\n");
      if (parts.length > 1) {
        const raw = parts.shift()!;
        ownerBuffer = parts.join("\n\n");
        let event = "message"; let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        return { event, data };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SSE 超时");
      const readPromise = ownerReader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>(res => setTimeout(() => res({ done: true, value: undefined }), remaining));
      const r = await Promise.race([readPromise, timeoutPromise]);
      if (r.done && !r.value) throw new Error("SSE 超时");
      if (r.value) ownerBuffer += ownerDecoder.decode(r.value, { stream: true });
    }
  }

  // 室友连接 SSE
  const rmSseRes = await fetch(`${config.baseUrl}/api/events`, {
    headers: { cookie: roommate.cookie, accept: "text/event-stream" }
  });
  const rmReader = rmSseRes.body!.getReader();
  const rmDecoder = new TextDecoder();
  let rmBuffer = "";

  async function nextRmMsg(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const parts = rmBuffer.split("\n\n");
      if (parts.length > 1) {
        const raw = parts.shift()!;
        rmBuffer = parts.join("\n\n");
        let event = "message"; let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        return { event, data };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SSE 超时");
      const readPromise = rmReader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>(res => setTimeout(() => res({ done: true, value: undefined }), remaining));
      const r = await Promise.race([readPromise, timeoutPromise]);
      if (r.done && !r.value) throw new Error("SSE 超时");
      if (r.value) rmBuffer += rmDecoder.decode(r.value, { stream: true });
    }
  }

  expect((await nextOwnerMsg()).event).toBe("connected");
  expect((await nextRmMsg()).event).toBe("connected");

  // 房主删房
  const delRes = await request(app, `/api/rooms/${roomId}/delete`, owner.cookie, {
    idempotencyKey: v7(),
    version: 1
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

  // 两端的房间列表都不再包含该房间
  const ownerRooms = await request(app, "/api/rooms", owner.cookie, undefined, "GET");
  expect(ownerRooms.json().rooms.some((r: any) => r.id === roomId)).toBe(false);

  const rmRooms = await request(app, "/api/rooms", roommate.cookie, undefined, "GET");
  expect(rmRooms.json().rooms.some((r: any) => r.id === roomId)).toBe(false);
});

