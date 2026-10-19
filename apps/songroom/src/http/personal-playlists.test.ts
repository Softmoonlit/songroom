import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { room, roomMembership, neteaseAuthorization } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { personalPlaylistView } from "../shared/personal-playlist-contracts.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-personal-http-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const adapter = new ScriptedNeteaseAdapter();
  adapter.userPlaylists = async () => ({
    ok: true,
    data: {
      playlists: [
        { id: "pl-my-fav", name: "我喜欢的音乐", creatorId: "test", subscribed: false, status: 0 },
        { id: "pl-sub-rock", name: "摇滚精选", creatorId: "rocker", subscribed: true, status: 0 }
      ],
      more: false
    }
  });
  adapter.playlistDetail = async input => ({
    ok: true,
    data: {
      playlist: {
        id: input.playlistId,
        name: input.playlistId === "pl-my-fav" ? "我喜欢的音乐" : "摇滚精选",
        creatorId: "test",
        subscribed: false,
        status: 0
      },
      songIds: ["song-1"],
      songs: [{ id: "song-1", name: "反方向的钟", artists: ["周杰伦"], album: "Jay" }]
    }
  });

  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await createApp(
    { nodeEnv: "test", host: "127.0.0.1", port, baseUrl, dbPath, staticRoot, credentialKeyPath, authSecret: "test-secret-with-at-least-32-characters" },
    { neteaseAdapter: adapter }
  );
  origins.set(app, baseUrl);
  cleanups.push(() => app.close());
  await app.listen();

  const owner = await signup(app, "owner@example.com");
  const member = await signup(app, "member@example.com");
  const outsider = await signup(app, "outsider@example.com");

  const roomId = v7();
  const ownerMemberId = v7();
  const roommateMemberId = v7();
  const authorizationId = v7();

  app.database.insert(room).values({ id: roomId, ownerUserId: owner.userId, name: "测试宿舍" }).run();
  app.database.insert(roomMembership).values([
    { id: ownerMemberId, roomId, userId: owner.userId, nickname: "房主" },
    { id: roommateMemberId, roomId, userId: member.userId, nickname: "室友" }
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

  return { app, adapter, owner, member, outsider, roomId, ownerMemberId, roommateMemberId };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: origins.get(app)! },
    payload: { name: "测试", email, password: "correct horse battery staple" }
  });
  expect(response.statusCode).toBe(200);
  return { userId: response.json().user.id as string, cookie: response.cookies.map(c => `${c.name}=${c.value}`).join("; ") };
}

function request(app: SongRoomApp, url: string, cookie?: string, body?: unknown, origin = origins.get(app)!) {
  return app.fastify.inject({
    method: body === undefined ? "GET" : "POST",
    url,
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
}

describe("personal-playlist HTTP routes", () => {
  it("个人歌单查询限制房间成员，房主与室友只显示主动创建且响应禁止缓存", async () => {
    const { app, owner, member, outsider, roomId } = await fixture();
    const url = `/api/rooms/${roomId}/personal-playlist`;
    expect((await request(app, url)).statusCode).toBe(401);
    expect((await request(app, url, outsider.cookie)).statusCode).toBe(404);
    for (const principal of [owner, member]) {
      const response = await request(app, url, principal.cookie);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(personalPlaylistView.parse(response.json())).toMatchObject({ playlist: null, allowedActions: ["createPersonalPlaylist"] });
    }
  });

  it("已有、自建和收藏歌单候选、绑定及解绑 API 已退役", async () => {
    const { app, owner, roomId } = await fixture();
    const base = `/api/rooms/${roomId}/personal-playlist`;
    expect((await request(app, `${base}/candidates`, owner.cookie)).statusCode).toBe(404);
    expect((await request(app, `${base}/bind`, owner.cookie, { idempotencyKey: v7(), playlistId: "pl-my-fav" })).statusCode).toBe(404);
    expect((await request(app, `${base}/unbind`, owner.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);
  });

  it("室友可在成员详情中只读查看房主个人歌单，不暴露维护权限", async () => {
    const { app, owner, member, outsider, roomId, ownerMemberId } = await fixture();
    const createUrl = `/api/rooms/${roomId}/personal-playlist/create`;
    const createRes = await request(app, createUrl, owner.cookie, { idempotencyKey: v7() });
    expect(createRes.statusCode).toBe(202);
    await app.scheduler.settle();

    const memberViewUrl = `/api/rooms/${roomId}/members/${ownerMemberId}/personal-playlist`;

    // 局外人
    expect((await request(app, memberViewUrl, outsider.cookie)).statusCode).toBe(404);

    // 室友只读查看房主
    const memberRes = await request(app, memberViewUrl, member.cookie);
    expect(memberRes.statusCode).toBe(200);
    const memberView = personalPlaylistView.parse(memberRes.json());
    expect(memberView.playlist).toEqual({ id: expect.any(String), name: "摇滚精选" });
    expect(memberView.snapshot?.trackCount).toBe(1);
    expect(memberView.allowedActions).toEqual([]);
  });

  it("成员创建接口校验登录、成员与同源，房主和室友均可受理并幂等返回", async () => {
    const { app, owner, member, outsider, roomId } = await fixture();
    const createUrl = `/api/rooms/${roomId}/personal-playlist/create`;

    // 未登录
    expect((await request(app, createUrl, undefined, { idempotencyKey: v7() })).statusCode).toBe(401);
    // 局外人
    expect((await request(app, createUrl, outsider.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);

    expect((await request(app, createUrl, owner.cookie, { idempotencyKey: v7() }, "https://evil.com")).statusCode).toBe(403);
    for (const principal of [owner, member]) {
      const key = v7();
      const createRes = await request(app, createUrl, principal.cookie, { idempotencyKey: key });
      expect(createRes.statusCode).toBe(202);
      const view = personalPlaylistView.parse(createRes.json());
      expect(view.operation?.status).toBe("queued");
      expect(view.operation?.step).toBe("ready");
      const replayed = await request(app, createUrl, principal.cookie, { idempotencyKey: key });
      expect(replayed.statusCode).toBe(200);
      expect(personalPlaylistView.parse(replayed.json()).operation?.id).toBe(view.operation?.id);
    }
  });

  it("创建接口拒绝指定其他成员或绑定外部目标，不能越权创建", async () => {
    const { app, owner, roomId, roommateMemberId } = await fixture();
    const url = `/api/rooms/${roomId}/personal-playlist/create`;
    expect((await request(app, url, owner.cookie, { idempotencyKey: v7(), memberId: roommateMemberId })).statusCode).toBe(400);
    expect((await request(app, url, owner.cookie, { idempotencyKey: v7(), playlistId: "external" })).statusCode).toBe(400);
  });
});

it("单首删除 HTTP 校验本人、同源、命令及幂等，刷新可恢复操作而他人成员详情不泄露", async () => {
  const { app, adapter, owner, member, outsider, roomId, roommateMemberId } = await fixture();
  const { personalPlaylistBinding } = await import("../db/schema.js");
  const { personalSongRemoveResponse, personalSongOperationView } = await import("../shared/personal-playlist-contracts.js");
  app.database.insert(personalPlaylistBinding).values({ id: v7(), roomId, memberId: roommateMemberId,
    accountId: "test", playlistId: "pl-personal", name: "个人", creationOperationId: v7(), generation: 1, createdAt: Date.now(), updatedAt: Date.now() }).run();
  const base = `/api/rooms/${roomId}/personal-playlist`;
  const command = { idempotencyKey: v7(), songId: "song-1" };
  expect((await request(app, `${base}/songs/remove`, undefined, command)).statusCode).toBe(401);
  expect((await request(app, `${base}/songs/remove`, outsider.cookie, command)).statusCode).toBe(404);
  expect((await request(app, `${base}/songs/remove`, owner.cookie, command)).statusCode).toBe(409);
  expect((await request(app, `${base}/songs/remove`, member.cookie, command, "https://evil.com")).statusCode).toBe(403);
  expect((await request(app, `${base}/songs/remove`, member.cookie, { ...command, memberId: roommateMemberId })).statusCode).toBe(400);
  expect((await request(app, `${base}/songs/remove`, member.cookie, { ...command, songId: "" })).statusCode).toBe(400);
  let removed = false;
  adapter.trackRemove = () => { removed = true; return { ok: true, data: { acknowledged: true } }; };
  adapter.playlistDetail = () => ({ ok: true, data: {
    playlist: { id: "pl-personal", name: "个人", creatorId: "test", subscribed: false, status: 0 },
    songIds: removed ? [] : ["song-1"],
    songs: removed ? [] : [{ id: "song-1", name: "歌曲", artists: [], album: "" }]
  } });
  const accepted = await request(app, `${base}/songs/remove`, member.cookie, command);
  expect(accepted.statusCode).toBe(202);
  const result = personalSongRemoveResponse.parse(accepted.json());
  expect(result.operation).toMatchObject({ action: "remove", name: "song-1", songConfirmed: false });
  await app.scheduler.settle();
  const operationUrl = `${base}/songs/${result.operation.id}`;
  expect(personalSongOperationView.parse((await request(app, operationUrl, member.cookie)).json())).toMatchObject({ action: "remove", status: "succeeded" });
  expect((await request(app, operationUrl, owner.cookie)).statusCode).toBe(404);
  expect(personalPlaylistView.parse((await request(app, base, member.cookie)).json())).toMatchObject({ songOperation: { id: result.operation.id, action: "remove" } });
  const other = await request(app, `/api/rooms/${roomId}/members/${roommateMemberId}/personal-playlist`, owner.cookie);
  expect(other.json()).not.toHaveProperty("songOperation");
  const replay = await request(app, `${base}/songs/remove`, member.cookie, command);
  expect(replay.statusCode).toBe(200);
  expect(personalSongRemoveResponse.parse(replay.json())).toMatchObject({ replay: true, operation: { id: result.operation.id } });
  expect((await request(app, `${base}/songs/remove`, member.cookie, { ...command, songId: "other" })).statusCode).toBe(409);
  expect(adapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(1);
});
