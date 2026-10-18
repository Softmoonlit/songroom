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
import { personalPlaylistCandidatesView, personalPlaylistView } from "../shared/personal-playlist-contracts.js";

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
  it("个人歌单只读查询与候选清单限制房间成员与房主权限，响应头包含 no-store", async () => {
    const { app, owner, member, outsider, roomId } = await fixture();
    const url = `/api/rooms/${roomId}/personal-playlist`;
    const candidatesUrl = `/api/rooms/${roomId}/personal-playlist/candidates`;

    // 未登录
    expect((await request(app, url)).statusCode).toBe(401);
    // 局外人
    expect((await request(app, url, outsider.cookie)).statusCode).toBe(404);

    // 房主查询自己（未配置）
    const ownerRes = await request(app, url, owner.cookie);
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.headers["cache-control"]).toBe("no-store");
    const ownerView = personalPlaylistView.parse(ownerRes.json());
    expect(ownerView.playlist).toBeNull();
    expect(ownerView.allowedActions).toContain("bindPersonalPlaylist");

    // 候选列表：仅房主可获取
    expect((await request(app, candidatesUrl, member.cookie)).statusCode).toBe(403);
    const candidatesRes = await request(app, candidatesUrl, owner.cookie);
    expect(candidatesRes.statusCode).toBe(200);
    const candidatesView = personalPlaylistCandidatesView.parse(candidatesRes.json());
    expect(candidatesView.candidates).toHaveLength(2);
    expect(candidatesView.candidates[0]).toEqual({ id: "pl-my-fav", name: "我喜欢的音乐", type: "ownerCreated", writeable: true });
    expect(candidatesView.candidates[1]).toEqual({ id: "pl-sub-rock", name: "摇滚精选", type: "ownerSubscribed", writeable: false });
  });

  it("房主绑定本人自建或收藏歌单成功，拒绝未授权来源与任意公开可读但未拥有歌单", async () => {
    const { app, owner, member, roomId } = await fixture();
    const bindUrl = `/api/rooms/${roomId}/personal-playlist/bind`;

    // 室友无权绑定
    expect((await request(app, bindUrl, member.cookie, { idempotencyKey: v7(), playlistId: "pl-my-fav" })).statusCode).toBe(403);

    // 跨站拒绝
    expect((await request(app, bindUrl, owner.cookie, { idempotencyKey: v7(), playlistId: "pl-my-fav" }, "https://evil.com")).statusCode).toBe(403);

    // 任意非清单 ID 拒绝
    const rejectRes = await request(app, bindUrl, owner.cookie, { idempotencyKey: v7(), playlistId: "pl-arbitrary-public" });
    expect(rejectRes.statusCode).toBe(422);

    // 绑定自建歌单成功
    const bindRes = await request(app, bindUrl, owner.cookie, { idempotencyKey: v7(), playlistId: "pl-my-fav" });
    expect(bindRes.statusCode).toBe(200);
    const view = personalPlaylistView.parse(bindRes.json());
    expect(view.playlist?.id).toBe("pl-my-fav");
    expect(view.playlist?.writeable).toBe(true);
    expect(view.snapshot?.trackCount).toBe(1);
    expect(view.snapshot?.tracks[0].name).toBe("反方向的钟");

    // 解绑
    const unbindUrl = `/api/rooms/${roomId}/personal-playlist/unbind`;
    const unbindRes = await request(app, unbindUrl, owner.cookie, { idempotencyKey: v7() });
    expect(unbindRes.statusCode).toBe(200);
    const unbindView = personalPlaylistView.parse(unbindRes.json());
    expect(unbindView.playlist).toBeNull();
  });

  it("室友可在成员详情中只读查看房主个人歌单，不暴露维护权限", async () => {
    const { app, owner, member, outsider, roomId, ownerMemberId } = await fixture();
    const bindUrl = `/api/rooms/${roomId}/personal-playlist/bind`;
    await request(app, bindUrl, owner.cookie, { idempotencyKey: v7(), playlistId: "pl-my-fav" });

    const memberViewUrl = `/api/rooms/${roomId}/members/${ownerMemberId}/personal-playlist`;

    // 局外人
    expect((await request(app, memberViewUrl, outsider.cookie)).statusCode).toBe(404);

    // 室友只读查看房主
    const memberRes = await request(app, memberViewUrl, member.cookie);
    expect(memberRes.statusCode).toBe(200);
    const memberView = personalPlaylistView.parse(memberRes.json());
    expect(memberView.playlist?.id).toBe("pl-my-fav");
    expect(memberView.allowedActions).toEqual([]);
  });

  it("室友创建专用个人歌单路由限制与受理：房主被拒绝，室友受理返回 202 并包含 operation 信息", async () => {
    const { app, owner, member, outsider, roomId } = await fixture();
    const createUrl = `/api/rooms/${roomId}/personal-playlist/create`;

    // 未登录
    expect((await request(app, createUrl, undefined, { idempotencyKey: v7() })).statusCode).toBe(401);
    // 局外人
    expect((await request(app, createUrl, outsider.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);

    // 房主被拒绝 (403 ROOMMATE_ONLY)
    const ownerRes = await request(app, createUrl, owner.cookie, { idempotencyKey: v7() });
    expect(ownerRes.statusCode).toBe(403);

    // 室友创建受理 (202)
    const createRes = await request(app, createUrl, member.cookie, { idempotencyKey: v7() });
    expect(createRes.statusCode).toBe(202);
    const view = personalPlaylistView.parse(createRes.json());
    expect(view.playlist).toBeNull();
    expect(view.operation?.status).toBe("queued");
    expect(view.operation?.step).toBe("ready");
  });
});
