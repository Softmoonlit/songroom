import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import {
  room,
  roomMembership,
  neteaseAuthorization,
  personalPlaylistBinding,
  playlistSnapshot,
  playlistTrack
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-personal-song-http-"));
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
  const app = await createApp(
    {
      nodeEnv: "test",
      host: "127.0.0.1",
      port,
      baseUrl,
      dbPath,
      staticRoot,
      credentialKeyPath,
      authSecret: "test-secret-with-at-least-32-characters"
    },
    { neteaseAdapter: adapter }
  );
  origins.set(app, baseUrl);
  cleanups.push(() => app.close());
  await app.listen();

  const owner = await signup(app, "owner@example.com");
  const member = await signup(app, "member@example.com");
  const outsider = await signup(app, "outsider@example.com");
  const roomId = v7();
  const authorizationId = v7();

  app.database.insert(room).values({ id: roomId, ownerUserId: owner.userId, name: "测试宿舍" }).run();
  const memberRecordId = v7();
  app.database.insert(roomMembership).values([
    { id: v7(), roomId, userId: owner.userId, nickname: "房主" },
    { id: memberRecordId, roomId, userId: member.userId, nickname: "室友" }
  ]).run();

  const credentials = new CredentialVault(credentialKeyPath).encrypt("MUSIC_U=test", { authorizationId, accountId: "test", generation: 1 });
  app.database.insert(neteaseAuthorization).values({
    id: authorizationId,
    userId: owner.userId,
    accountId: "test",
    nickname: "网易云",
    generation: 1,
    status: "active",
    credentials
  }).run();

  // 绑定成员个人歌单
  const now = Date.now();
  app.database.insert(personalPlaylistBinding).values({
    id: v7(),
    roomId,
    memberId: memberRecordId,
    accountId: "test",
    playlistId: "pl-member",
    name: "songroom-测试宿舍-室友-专用",
    creationOperationId: v7(),
    generation: 1,
    createdAt: now,
    updatedAt: now
  }).run();

  app.database.insert(playlistSnapshot).values({
    accountId: "test",
    playlistId: "pl-member",
    snapshotVersion: 1,
    syncedAt: now,
    createdAt: now,
    updatedAt: now
  }).run();

  return { app, adapter, owner, member, outsider, roomId, baseUrl, memberRecordId };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: origins.get(app)! },
    payload: { name: "测试", email, password: "correct horse battery staple" }
  });
  expect(response.statusCode).toBe(200);
  return {
    userId: response.json().user.id as string,
    cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ")
  };
}

async function request(
  app: SongRoomApp,
  url: string,
  cookie?: string,
  body?: unknown,
  method: "GET" | "POST" = "POST"
) {
  return await app.fastify.inject({
    method,
    url,
    headers: cookie ? { cookie, origin: origins.get(app)! } : { origin: origins.get(app)! },
    payload: body as any
  });
}

it("未登录请求添加个人歌曲返回 401", async () => {
  const { app, roomId } = await fixture();
  const response = await request(app, `/api/rooms/${roomId}/personal-playlist/songs`, undefined, {
    idempotencyKey: v7(),
    songId: "s-1",
    name: "歌名",
    artists: ["歌手"],
    album: "专辑"
  });
  expect(response.statusCode).toBe(401);
});

it("局外人请求添加个人歌曲返回 404 ROOM_UNAVAILABLE", async () => {
  const { app, roomId, outsider } = await fixture();
  const response = await request(app, `/api/rooms/${roomId}/personal-playlist/songs`, outsider.cookie, {
    idempotencyKey: v7(),
    songId: "s-1",
    name: "歌名",
    artists: ["歌手"],
    album: "专辑"
  });
  expect(response.statusCode).toBe(404);
  expect(response.json().error.code).toBe("ROOM_UNAVAILABLE");
});

it("未创建专用个人歌单时添加歌曲返回 409 PERSONAL_PLAYLIST_NOT_FOUND", async () => {
  const { app, roomId, owner } = await fixture();
  // 房主未创建个人歌单
  const response = await request(app, `/api/rooms/${roomId}/personal-playlist/songs`, owner.cookie, {
    idempotencyKey: v7(),
    songId: "s-1",
    name: "歌名",
    artists: ["歌手"],
    album: "专辑"
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe("PERSONAL_PLAYLIST_NOT_FOUND");
});

it("正常添加歌曲成功返回 202 Accepted，重复提交返回 200 OK + replay: true", async () => {
  const { app, roomId, member } = await fixture();
  const idempotencyKey = v7();
  const payload = {
    idempotencyKey,
    songId: "s-new-1",
    name: "测试新歌",
    artists: ["歌手A", "歌手B"],
    album: "测试专辑"
  };

  const response1 = await request(app, `/api/rooms/${roomId}/personal-playlist/songs`, member.cookie, payload);
  expect(response1.statusCode).toBe(202);
  const json1 = response1.json();
  expect(json1.replay).toBe(false);
  expect(json1.operation.songId).toBe("s-new-1");
  expect(json1.operation.name).toBe("测试新歌");
  expect(json1.operation.artists).toEqual(["歌手A", "歌手B"]);
  expect(json1.operation.album).toBe("测试专辑");
  expect(json1.operation.status).toBe("queued");
  expect(json1.operation.songConfirmed).toBe(false);

  // 相同 idempotencyKey 重放
  const response2 = await request(app, `/api/rooms/${roomId}/personal-playlist/songs`, member.cookie, payload);
  expect(response2.statusCode).toBe(200);
  const json2 = response2.json();
  expect(json2.replay).toBe(true);
  expect(json2.operation.id).toBe(json1.operation.id);
});

it("快照已含该歌曲时添加返回 200 OK + replay: false + status: succeeded", async () => {
  const { app, roomId, member } = await fixture();
  const now = Date.now();

  app.database.insert(playlistTrack).values({
    accountId: "test",
    playlistId: "pl-member",
    position: 0,
    songId: "s-exists",
    name: "已有歌",
    artists: JSON.stringify(["歌手"]),
    album: "专辑"
  }).run();

  const response = await request(app, `/api/rooms/${roomId}/personal-playlist/songs`, member.cookie, {
    idempotencyKey: v7(),
    songId: "s-exists",
    name: "已有歌",
    artists: ["歌手"],
    album: "专辑"
  });
  expect(response.statusCode).toBe(200);
  const json = response.json();
  expect(json.replay).toBe(false);
  expect(json.operation.status).toBe("succeeded");
  expect(json.operation.songConfirmed).toBe(true);
});

it("查询个人歌曲添加操作：200 返回详情，不存在或他人操作返回 404", async () => {
  const { app, roomId, member, owner } = await fixture();

  const addRes = await request(app, `/api/rooms/${roomId}/personal-playlist/songs`, member.cookie, {
    idempotencyKey: v7(),
    songId: "s-query",
    name: "查询歌曲",
    artists: ["歌手"],
    album: "专辑"
  });
  expect(addRes.statusCode).toBe(202);
  const opId = addRes.json().operation.id;

  // 本人查询
  const getRes = await request(app, `/api/rooms/${roomId}/personal-playlist/songs/${opId}`, member.cookie, undefined, "GET");
  expect(getRes.statusCode).toBe(200);
  const getJson = getRes.json();
  expect(getJson.id).toBe(opId);
  expect(getJson.songId).toBe("s-query");
  expect(getJson.name).toBe("查询歌曲");

  // 房主查询室友操作：404
  const ownerQuery = await request(app, `/api/rooms/${roomId}/personal-playlist/songs/${opId}`, owner.cookie, undefined, "GET");
  expect(ownerQuery.statusCode).toBe(404);
  expect(ownerQuery.json().error.code).toBe("OPERATION_NOT_FOUND");

  // 查询不存在的操作：404
  const notFound = await request(app, `/api/rooms/${roomId}/personal-playlist/songs/${v7()}`, member.cookie, undefined, "GET");
  expect(notFound.statusCode).toBe(404);
  expect(notFound.json().error.code).toBe("OPERATION_NOT_FOUND");
});
