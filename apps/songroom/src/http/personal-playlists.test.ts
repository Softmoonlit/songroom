import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { room, roomMembership, neteaseAuthorization, publicPlaylistBinding } from "../db/schema.js";
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
        { id: "pl-my-fav", name: "我喜欢的音乐", creatorId: "test", subscribed: false, status: 0, specialType: 5 },
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
        creatorId: input.playlistId === "pl-my-fav" ? "test" : "rocker",
        subscribed: input.playlistId !== "pl-my-fav",
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
  it("个人歌单查询限制房间成员，未配置时不暴露创建动作，响应禁止缓存", async () => {
    const { app, owner, member, outsider, roomId } = await fixture();
    const url = `/api/rooms/${roomId}/personal-playlist`;
    expect((await request(app, url)).statusCode).toBe(401);
    expect((await request(app, url, outsider.cookie)).statusCode).toBe(404);
    for (const principal of [owner, member]) {
      const response = await request(app, url, principal.cookie);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(personalPlaylistView.parse(response.json())).toMatchObject({ playlist: null, allowedActions: [] });
    }
  });

  it("旧代分配、解除分配与他人歌单查看接口已下线，请求返回 404", async () => {
    const { app, owner, roomId, ownerMemberId, roommateMemberId } = await fixture();
    const base = `/api/rooms/${roomId}`;
    expect((await request(app, `${base}/personal-playlist/create`, owner.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);
    expect((await request(app, `${base}/personal-playlist/songs/remove`, owner.cookie, { idempotencyKey: v7(), songId: "song-1" })).statusCode).toBe(404);
    expect((await request(app, `${base}/members/${ownerMemberId}/personal-playlist`, owner.cookie)).statusCode).toBe(404);
    expect((await request(app, `${base}/members/${roommateMemberId}/personal-playlist/assign`, owner.cookie, { playlistId: "pl-fav" })).statusCode).toBe(404);
    expect((await request(app, `${base}/members/${roommateMemberId}/personal-playlist/unassign`, owner.cookie, {})).statusCode).toBe(404);
  });

  it("已授权网易云成员可获取自身歌单候选，未授权成员返回 409", async () => {
    const { app, owner, member, outsider, roomId } = await fixture();
    const url = `/api/rooms/${roomId}/personal-playlist/candidates`;

    expect((await request(app, url)).statusCode).toBe(401);
    expect((await request(app, url, outsider.cookie)).statusCode).toBe(404);
    // member 未绑定网易云
    expect((await request(app, url, member.cookie)).statusCode).toBe(409);

    const ownerRes = await request(app, url, owner.cookie);
    expect(ownerRes.statusCode).toBe(200);
    const body = ownerRes.json();
    expect(body.candidates).toEqual([
      expect.objectContaining({ id: "pl-my-fav", name: "我喜欢的音乐", sourceType: "liked" }),
      expect.objectContaining({ id: "pl-sub-rock", name: "摇滚精选", sourceType: "favorite" })
    ]);
  });

  it.each([
    { name: "自建", creatorId: "test", subscribed: false, privacy: 0 },
    { name: "我喜欢的音乐", creatorId: "test", subscribed: false, privacy: 0, specialType: 5 },
    { name: "自建私密", creatorId: "test", subscribed: false, privacy: 10 },
    { name: "收藏", creatorId: "other", subscribed: true, privacy: 0 }
  ])("HTTP 自主绑定与刷新有效的 $name 歌单", async metadata => {
    const { app, adapter, owner, roomId } = await fixture();
    let songId = "before";
    adapter.playlistDetail = input => ({ ok: true, data: {
      playlist: { id: input.playlistId, ...metadata, status: 0 },
      songIds: [songId], songs: [{ id: songId, name: songId, artists: [], album: "" }]
    } });
    const bound = await request(app, `/api/rooms/${roomId}/personal-playlist/bind`, owner.cookie, { playlistId: "pl-source" });
    expect(bound.statusCode).toBe(200);
    expect(personalPlaylistView.parse(bound.json()).snapshot?.tracks[0].songId).toBe("before");
    songId = "after";
    const refreshed = await request(app, `/api/rooms/${roomId}/personal-playlist/refresh`, owner.cookie, {});
    expect(refreshed.statusCode).toBe(200);
    expect(personalPlaylistView.parse(refreshed.json())).toMatchObject({
      playlist: { id: "pl-source", name: metadata.name }, lastRefreshError: null, disabledReason: null,
      snapshot: { tracks: [expect.objectContaining({ songId: "after" })] }
    });
  });

  it.each([
    { name: "未收藏他人", creatorId: "other", subscribed: false, status: 0 },
    { name: "失效自建", creatorId: "test", subscribed: false, status: -1 }
  ])("HTTP 拒绝 $name 歌单绑定", async metadata => {
    const { app, adapter, owner, roomId } = await fixture();
    adapter.playlistDetail = input => ({ ok: true, data: {
      playlist: { id: input.playlistId, ...metadata }, songIds: [], songs: []
    } });
    const response = await request(app, `/api/rooms/${roomId}/personal-playlist/bind`, owner.cookie, { playlistId: "pl-invalid" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "TARGET_PERMISSION" } });
  });

  it("HTTP 候选排除同账号本房间及其他房间公共歌单", async () => {
    const { app, adapter, owner, roomId } = await fixture();
    const otherRoomId = v7();
    app.database.insert(room).values({ id: otherRoomId, name: "另一房间", ownerUserId: owner.userId }).run();
    app.database.insert(publicPlaylistBinding).values([
      { roomId, accountId: "test", playlistId: "public-here", name: "本房间公共", creationOperationId: v7() },
      { roomId: otherRoomId, accountId: "test", playlistId: "public-other", name: "其他房间公共", creationOperationId: v7() }
    ]).run();
    adapter.userPlaylists = () => ({ ok: true, data: {
      playlists: ["public-here", "ordinary-own", "public-other"].map(id => ({
        id, name: id, creatorId: "test", subscribed: false, status: 0
      })), more: false
    } });
    const response = await request(app, `/api/rooms/${roomId}/personal-playlist/candidates`, owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates.map((candidate: { id: string }) => candidate.id)).toEqual(["ordinary-own"]);
  });

  it.each(["本房间", "其他房间"])("HTTP 绑定%s公共目标返回 409 并保留原个人歌单", async scope => {
    const { app, owner, roomId } = await fixture();
    const bindUrl = `/api/rooms/${roomId}/personal-playlist/bind`;
    const original = await request(app, bindUrl, owner.cookie, { playlistId: "pl-sub-rock" });
    expect(original.statusCode).toBe(200);
    const targetRoomId = scope === "本房间" ? roomId : v7();
    if (targetRoomId !== roomId) app.database.insert(room).values({ id: targetRoomId, name: "另一房间", ownerUserId: owner.userId }).run();
    app.database.insert(publicPlaylistBinding).values({
      roomId: targetRoomId, accountId: "test", playlistId: "pl-my-fav", name: "公共目标", creationOperationId: v7()
    }).run();
    const response = await request(app, bindUrl, owner.cookie, { playlistId: "pl-my-fav" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "PLAYLIST_TARGET_CONFLICT" } });
    const current = await request(app, `/api/rooms/${roomId}/personal-playlist`, owner.cookie);
    expect(current.statusCode).toBe(200);
    expect(personalPlaylistView.parse(current.json()).playlist).toEqual(personalPlaylistView.parse(original.json()).playlist);
    expect(personalPlaylistView.parse(current.json()).snapshot).toEqual(personalPlaylistView.parse(original.json()).snapshot);
  });

  it("更换歌单直接覆盖原绑定，未授权网易云成员禁止绑定", async () => {
    const { app, owner, member, roomId } = await fixture();
    const bindUrl = `/api/rooms/${roomId}/personal-playlist/bind`;

    // 未授权网易云成员尝试绑定返回 409
    expect((await request(app, bindUrl, member.cookie, { playlistId: "pl-sub-rock" })).statusCode).toBe(409);

    // 绑定第一份歌单
    const bindRes1 = await request(app, bindUrl, owner.cookie, { playlistId: "pl-sub-rock" });
    expect(bindRes1.statusCode).toBe(200);
    const view1 = personalPlaylistView.parse(bindRes1.json());
    expect(view1.playlist?.id).toBe("pl-sub-rock");

    // 更换为第二份歌单，直接覆盖
    const bindRes2 = await request(app, bindUrl, owner.cookie, { playlistId: "pl-my-fav" });
    expect(bindRes2.statusCode).toBe(200);
    const view2 = personalPlaylistView.parse(bindRes2.json());
    expect(view2.playlist?.id).toBe("pl-my-fav");
  });
});

