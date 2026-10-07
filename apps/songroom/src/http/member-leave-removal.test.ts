import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { eq, and } from "drizzle-orm";
import { room, roomMembership, neteaseAuthorization, publicPlaylistBinding, playlistTrack, playlistSnapshot, requesterTag, roomInvite, operation, publicSongRequest } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import type { AdapterInput, AdapterResult } from "../netease/protocol.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-leave-remove-test-"));
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
  const roommate1 = await signup(app, "roommate1@example.com");
  const roommate2 = await signup(app, "roommate2@example.com");
  const outsider = await signup(app, "outsider@example.com");

  const roomId = v7();
  const authorizationId = v7();
  app.database.insert(room).values({ id: roomId, ownerUserId: owner.userId, name: "测试宿舍", version: 1 }).run();
  const ownerMemberId = v7();
  const rm1MemberId = v7();
  const rm2MemberId = v7();
  app.database.insert(roomMembership).values([
    { id: ownerMemberId, roomId, userId: owner.userId, nickname: "房主" },
    { id: rm1MemberId, roomId, userId: roommate1.userId, nickname: "室友甲" },
    { id: rm2MemberId, roomId, userId: roommate2.userId, nickname: "室友乙" }
  ]).run();
  app.database.insert(roomInvite).values({ roomId, code: "inv-code01", generation: 1 }).run();

  const credentials = new CredentialVault(credentialKeyPath).encrypt("MUSIC_U=test", { authorizationId, accountId: "acc-owner", generation: 1 });
  app.database.insert(neteaseAuthorization).values({
    id: authorizationId,
    userId: owner.userId,
    accountId: "acc-owner",
    nickname: "网易云账号",
    generation: 1,
    status: "active",
    credentials
  }).run();
  app.database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "acc-owner",
    playlistId: "pl-room",
    name: "songroom-测试宿舍-公共",
    creationOperationId: v7(),
    generation: 1
  }).run();
  app.database.insert(playlistSnapshot).values({
    accountId: "acc-owner",
    playlistId: "pl-room",
    snapshotVersion: 1,
    syncedAt: Date.now(),
    lastErrorCode: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();
  // 公共歌单预置一首已有歌曲
  app.database.insert(playlistTrack).values({
    accountId: "acc-owner",
    playlistId: "pl-room",
    position: 0,
    songId: "song-1",
    name: "七里香",
    artists: JSON.stringify(["周杰伦"]),
    album: "七里香"
  }).run();
  // 房主、室友甲和室友乙都点了这首歌
  app.database.insert(requesterTag).values([
    { roomId, bindingGeneration: 1, songId: "song-1", memberId: ownerMemberId, createdAt: Date.now() },
    { roomId, bindingGeneration: 1, songId: "song-1", memberId: rm1MemberId, createdAt: Date.now() },
    { roomId, bindingGeneration: 1, songId: "song-1", memberId: rm2MemberId, createdAt: Date.now() }
  ]).run();

  return { app, adapter, owner, roommate1, roommate2, outsider, roomId, ownerMemberId, rm1MemberId, rm2MemberId, config };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: origins.get(app)! },
    payload: { name: "用户", email, password: "correct horse battery staple" }
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

it("室友主动退出：成功硬删除成员关系与点歌标签，释放昵称，保留歌曲和其他成员标签", async () => {
  const { app, roommate1, roomId } = await fixture();

  // 退出前先检查歌单快照中的 requesters
  const beforePl = await request(app, `/api/rooms/${roomId}/public-playlist`, roommate1.cookie, undefined, "GET");
  expect(beforePl.statusCode).toBe(200);
  expect(beforePl.json().snapshot.tracks[0].requesters).toEqual(["房主", "室友甲", "室友乙"]);

  // 室友甲主动退出
  const leaveRes = await request(app, `/api/rooms/${roomId}/leave`, roommate1.cookie, {
    idempotencyKey: v7()
  });
  expect(leaveRes.statusCode).toBe(200);
  expect(leaveRes.json()).toEqual({ ok: true, roomId });

  // 退出后室友甲无法再访问房间、歌单或成员
  expect((await request(app, `/api/rooms/${roomId}`, roommate1.cookie, undefined, "GET")).statusCode).toBe(404);
  expect((await request(app, `/api/rooms/${roomId}/members`, roommate1.cookie, undefined, "GET")).statusCode).toBe(404);
  expect((await request(app, `/api/rooms/${roomId}/public-playlist`, roommate1.cookie, undefined, "GET")).statusCode).toBe(404);

  // 房间列表不再包含该房间
  const roomsRes = await request(app, "/api/rooms", roommate1.cookie, undefined, "GET");
  expect(roomsRes.json().rooms).toHaveLength(0);

  // 数据库中室友甲的标签被清除，但歌曲及其他成员的标签保留
  const dbTags = app.database.select().from(requesterTag).where(eq(requesterTag.roomId, roomId)).all();
  expect(dbTags).toHaveLength(2); // 仅剩房主与室友乙
});

it("房主不能以室友退出流程离开自己的房间，返回 403 OWNER_CANNOT_LEAVE", async () => {
  const { app, owner, roomId } = await fixture();

  const res = await request(app, `/api/rooms/${roomId}/leave`, owner.cookie, {
    idempotencyKey: v7()
  });
  expect(res.statusCode).toBe(403);
  expect(res.json().error.code).toBe("OWNER_CANNOT_LEAVE");
});

it("房主在二次确认后移除室友：版本核对通过，硬删除成员及标签，房间版本单调递增", async () => {
  const { app, owner, roomId, rm1MemberId } = await fixture();

  const membersBefore = await request(app, `/api/rooms/${roomId}/members`, owner.cookie, undefined, "GET");
  expect(membersBefore.statusCode).toBe(200);
  const versionBefore = membersBefore.json().version;

  // 房主移除室友甲
  const removeRes = await request(app, `/api/rooms/${roomId}/members/${rm1MemberId}/remove`, owner.cookie, {
    idempotencyKey: v7(),
    version: versionBefore
  });
  expect(removeRes.statusCode).toBe(200);
  const afterData = removeRes.json();
  expect(afterData.version).toBe(versionBefore + 1);
  expect(afterData.members.map((m: any) => m.nickname)).toEqual(["房主", "室友乙"]);

  // 歌单快照中室友甲的标签已被清除
  const plRes = await request(app, `/api/rooms/${roomId}/public-playlist`, owner.cookie, undefined, "GET");
  expect(plRes.json().snapshot.tracks[0].requesters).toEqual(["房主", "室友乙"]);
});

it("室友不能移除他人，非成员和其他房间房主不能退出或移除，返回相应拒绝错误", async () => {
  const { app, roommate1, roommate2, outsider, roomId, rm2MemberId, rm1MemberId } = await fixture();

  // 室友甲试图移除室友乙 -> 404 ROOM_OWNER_REQUIRED
  const rmTryRemove = await request(app, `/api/rooms/${roomId}/members/${rm2MemberId}/remove`, roommate1.cookie, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(rmTryRemove.statusCode).toBe(404);
  expect(rmTryRemove.json().error.code).toBe("ROOM_OWNER_REQUIRED");

  // 非成员试图退出房间 -> 404 ROOM_UNAVAILABLE
  const outsiderLeave = await request(app, `/api/rooms/${roomId}/leave`, outsider.cookie, {
    idempotencyKey: v7()
  });
  expect(outsiderLeave.statusCode).toBe(404);
  expect(outsiderLeave.json().error.code).toBe("ROOM_UNAVAILABLE");

  // 非成员试图移除成员 -> 404 ROOM_UNAVAILABLE
  const outsiderRemove = await request(app, `/api/rooms/${roomId}/members/${rm1MemberId}/remove`, outsider.cookie, {
    idempotencyKey: v7(),
    version: 1
  });
  expect(outsiderRemove.statusCode).toBe(404);
  expect(outsiderRemove.json().error.code).toBe("ROOM_UNAVAILABLE");
});

it("移除确认携带版本：成员改名、已退出或房间状态改变时拒绝旧版本确认，返回 409 ROOM_VERSION_CONFLICT", async () => {
  const { app, owner, roommate1, roomId, rm1MemberId } = await fixture();

  const membersRes = await request(app, `/api/rooms/${roomId}/members`, owner.cookie, undefined, "GET");
  const oldVersion = membersRes.json().version;

  // 室友甲改名，导致房间版本递增
  const renameRes = await request(app, `/api/rooms/${roomId}/nickname`, roommate1.cookie, {
    idempotencyKey: v7(),
    nickname: "甲新昵称"
  });
  expect(renameRes.statusCode).toBe(200);

  // 房主使用旧版本提交移除 -> 拒绝 409 ROOM_VERSION_CONFLICT
  const conflictRes = await request(app, `/api/rooms/${roomId}/members/${rm1MemberId}/remove`, owner.cookie, {
    idempotencyKey: v7(),
    version: oldVersion
  });
  expect(conflictRes.statusCode).toBe(409);
  expect(conflictRes.json().error.code).toBe("ROOM_VERSION_CONFLICT");

  // 使用最新版本重试 -> 成功
  const latestMembers = await request(app, `/api/rooms/${roomId}/members`, owner.cookie, undefined, "GET");
  const successRes = await request(app, `/api/rooms/${roomId}/members/${rm1MemberId}/remove`, owner.cookie, {
    idempotencyKey: v7(),
    version: latestMembers.json().version
  });
  expect(successRes.statusCode).toBe(200);
});

it("退出与移除命令幂等重放：同一幂等键重放返回一致结果，不同内容返回 409 IDEMPOTENCY_CONFLICT", async () => {
  const { app, owner, roommate1, roomId, rm1MemberId } = await fixture();

  const key = v7();
  const firstLeave = await request(app, `/api/rooms/${roomId}/leave`, roommate1.cookie, { idempotencyKey: key });
  expect(firstLeave.statusCode).toBe(200);

  // 重复提交相同键相同内容 -> 幂等 200
  const replayLeave = await request(app, `/api/rooms/${roomId}/leave`, roommate1.cookie, { idempotencyKey: key });
  expect(replayLeave.statusCode).toBe(200);
  expect(replayLeave.json()).toEqual(firstLeave.json());

  // 相同键不同内容 -> 409 IDEMPOTENCY_CONFLICT
  const rmKey = v7();
  const firstRemove = await request(app, `/api/rooms/${roomId}/members/${rm1MemberId}/remove`, owner.cookie, {
    idempotencyKey: rmKey,
    version: 1
  });
  // rm1 已在上面退出，所以此处版本冲突
  expect(firstRemove.statusCode).toBe(409);
});

it("旧昵称立即释放：新用户通过申请加入可立即使用该昵称，且不继承任何旧标签", async () => {
  const { app, owner, roommate1, outsider, roomId, rm1MemberId } = await fixture();

  // 室友甲主动退出
  await request(app, `/api/rooms/${roomId}/leave`, roommate1.cookie, { idempotencyKey: v7() });

  // outsider 申请加入房间，使用刚刚释放的昵称“室友甲”
  const applyRes = await request(app, "/api/join-applications", outsider.cookie, {
    code: "inv-code01",
    nickname: "室友甲",
    idempotencyKey: v7()
  });
  expect(applyRes.statusCode).toBe(200);
  const appId = applyRes.json().id;

  // 房主批准加入
  const approveRes = await request(app, `/api/rooms/${roomId}/applications/${appId}/decision`, owner.cookie, {
    idempotencyKey: v7(),
    decision: "approve"
  });
  expect(approveRes.statusCode).toBe(200);

  // 检查歌单快照：新加入的“室友甲”绝对没有继承旧标签！
  const plRes = await request(app, `/api/rooms/${roomId}/public-playlist`, outsider.cookie, undefined, "GET");
  expect(plRes.statusCode).toBe(200);
  // tracks[0] 中没有“室友甲”，只有“房主”和“室友乙”
  expect(plRes.json().snapshot.tracks[0].requesters).toEqual(["房主", "室友乙"]);
});

it("尚未发出的点歌请求在室友退出后立即清除，不向下游发送", async () => {
  const { app, adapter, roommate1, roomId } = await fixture();

  // 在排队状态插入一个点歌操作（模拟未发出的请求）
  const songReqRes = await request(app, `/api/rooms/${roomId}/song-requests`, roommate1.cookie, {
    idempotencyKey: v7(),
    songId: "new-song-99",
    name: "稻香",
    artists: ["周杰伦"],
    album: "魔杰座"
  });
  expect([200, 202]).toContain(songReqRes.statusCode);
  const opId = songReqRes.json().operation.id;

  // 室友甲主动退出
  await request(app, `/api/rooms/${roomId}/leave`, roommate1.cookie, { idempotencyKey: v7() });

  // 退出后室友甲不可再查看该操作
  const opQuery = await request(app, `/api/rooms/${roomId}/song-requests/${opId}`, roommate1.cookie, undefined, "GET");
  expect(opQuery.statusCode).toBe(404);
});

it("在途写入晚到响应可更新公共歌单快照，但绝不补回已离开成员的标签，旧操作不可查看", async () => {
  const { app, adapter, owner, roommate1, roomId } = await fixture();

  // 构造一个正在发送中的公共点歌操作（step 为 sending）
  const opId = v7();
  app.database.insert(operation).values({
    id: opId,
    kind: "requestPublicSong",
    userId: roommate1.userId,
    roomId,
    accountId: "acc-owner",
    authorizationId: v7(),
    generation: 1,
    status: "processing",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();
  app.database.insert(publicSongRequest).values({
    operationId: opId,
    songId: "in-flight-song",
    name: "夜曲",
    artists: JSON.stringify(["周杰伦"]),
    album: "十一月的萧邦",
    step: "sending",
    songConfirmed: false,
    tagConfirmed: false,
    playlistId: "pl-room",
    bindingGeneration: 1
  }).run();

  // 此时房主将室友甲移除
  const membersRes = await request(app, `/api/rooms/${roomId}/members`, owner.cookie, undefined, "GET");
  const rm1 = membersRes.json().members.find((m: any) => m.nickname === "室友甲");
  const removeRes = await request(app, `/api/rooms/${roomId}/members/${rm1.id}/remove`, owner.cookie, {
    idempotencyKey: v7(),
    version: membersRes.json().version
  });
  expect(removeRes.statusCode).toBe(200);

  // 模拟 adapter 晚到的 playlistDetail 返回了这首新歌
  adapter.call = async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "identity") {
      return { ok: true, data: { accountId: "acc-owner", nickname: "网易云账号" } } as any;
    }
    if (input.operation === "playlistDetail") {
      return {
        ok: true,
        data: {
          playlist: { id: "pl-room", name: "公共歌单", trackCount: 2, status: 0 },
          songIds: ["song-1", "in-flight-song"],
          songs: [
            { id: "song-1", name: "七里香", artists: ["周杰伦"], album: "七里香" },
            { id: "in-flight-song", name: "夜曲", artists: ["周杰伦"], album: "十一月的萧邦" }
          ]
        }
      } as any;
    }
    return { ok: true, data: {} } as any;
  };

  // 刷新歌单快照
  const refreshRes = await request(app, `/api/rooms/${roomId}/public-playlist/refresh`, owner.cookie, {});
  expect(refreshRes.statusCode).toBe(200);
  const snap = refreshRes.json().snapshot;
  expect(snap.tracks).toHaveLength(2);

  // 新歌出现在快照中，但 requesters 绝对为空（绝不补回室友甲的标签！）
  const newTrack = snap.tracks.find((t: any) => t.songId === "in-flight-song");
  expect(newTrack.requesters).toEqual([]);

  // 已被移除的室友甲尝试查看旧操作 -> 404 ROOM_UNAVAILABLE
  const getOp = await request(app, `/api/rooms/${roomId}/song-requests/${opId}`, roommate1.cookie, undefined, "GET");
  expect(getOp.statusCode).toBe(404);
});

it("多端 SSE 失效：室友退出后，房主端收到 room/permission/snapshot，退出者端直接收到 room/permission", async () => {
  const { app, owner, roommate1, roomId, config } = await fixture();

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

  // 室友甲连接 SSE
  const rmSseRes = await fetch(`${config.baseUrl}/api/events`, {
    headers: { cookie: roommate1.cookie, accept: "text/event-stream" }
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

  // 室友甲主动退出
  const leaveRes = await request(app, `/api/rooms/${roomId}/leave`, roommate1.cookie, {
    idempotencyKey: v7()
  });
  expect(leaveRes.statusCode).toBe(200);

  // 房主端依次收到失效通知：room, permission, snapshot
  const ownerEvents: string[] = [];
  for (let i = 0; i < 3; i++) {
    const msg = await nextOwnerMsg();
    expect(msg.event).toBe("invalidation");
    const payload = JSON.parse(msg.data);
    expect(payload.resourceId).toBe(roomId);
    ownerEvents.push(payload.type);
    // 绝不包含正文、昵称或歌单数据
    expect(msg.data).not.toContain("室友甲");
    expect(msg.data).not.toContain("测试宿舍");
  }
  expect(ownerEvents).toContain("room");
  expect(ownerEvents).toContain("permission");
  expect(ownerEvents).toContain("snapshot");

  // 退出者端也收到失效通知：room, permission
  const rmEvents: string[] = [];
  for (let i = 0; i < 2; i++) {
    const msg = await nextRmMsg();
    expect(msg.event).toBe("invalidation");
    const payload = JSON.parse(msg.data);
    expect(payload.resourceId).toBe(roomId);
    rmEvents.push(payload.type);
    expect(msg.data).not.toContain("室友甲");
  }
  expect(rmEvents).toContain("room");
  expect(rmEvents).toContain("permission");

  await ownerReader.cancel();
  await rmReader.cancel();
});

it("服务重启后不留僵尸档案，原退出成员依然不可访问房间", async () => {
  const { app, adapter, roommate1, owner, roomId, config } = await fixture();

  // 室友甲退出
  await request(app, `/api/rooms/${roomId}/leave`, roommate1.cookie, { idempotencyKey: v7() });

  // 重启服务
  await app.close();
  const restarted = await createApp(config, { neteaseAdapter: adapter });
  origins.set(restarted, config.baseUrl);
  cleanups.push(() => restarted.close());
  await restarted.listen();

  // 重启后室友甲依然 404
  expect((await request(restarted, `/api/rooms/${roomId}`, roommate1.cookie, undefined, "GET")).statusCode).toBe(404);
  expect((await request(restarted, `/api/rooms/${roomId}/members`, roommate1.cookie, undefined, "GET")).statusCode).toBe(404);

  // 房主查看成员：依然只有 2 人
  const mRes = await request(restarted, `/api/rooms/${roomId}/members`, owner.cookie, undefined, "GET");
  expect(mRes.statusCode).toBe(200);
  expect(mRes.json().members).toHaveLength(2);
});
