import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { room, roomMembership, neteaseAuthorization, publicPlaylistBinding } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { publicPlaylistView } from "../shared/public-playlist-contracts.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-public-http-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const dbPath = path.join(root, "songroom.sqlite"); initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const adapter = new ScriptedNeteaseAdapter();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await createApp({ nodeEnv: "test", host: "127.0.0.1", port, baseUrl, dbPath, staticRoot, credentialKeyPath, authSecret: "test-secret-with-at-least-32-characters" }, { neteaseAdapter: adapter });
  origins.set(app, baseUrl);
  cleanups.push(() => app.close());
  await app.listen();
  const owner = await signup(app, "owner@example.com");
  const member = await signup(app, "member@example.com");
  const outsider = await signup(app, "outsider@example.com");
  const roomId = v7(); const authorizationId = v7();
  app.database.insert(room).values({ id: roomId, ownerUserId: owner.userId, name: "测试宿舍" }).run();
  app.database.insert(roomMembership).values([
    { id: v7(), roomId, userId: owner.userId, nickname: "房主" },
    { id: v7(), roomId, userId: member.userId, nickname: "室友" }
  ]).run();
  const credentials = new CredentialVault(credentialKeyPath).encrypt("MUSIC_U=test", { authorizationId, accountId: "test", generation: 1 });
  app.database.insert(neteaseAuthorization).values({ id: authorizationId, userId: owner.userId, accountId: "test", nickname: "网易云", generation: 1, status: "active", credentials }).run();
  return { app, adapter, owner, member, outsider, url: `/api/rooms/${roomId}/public-playlist` };
}
async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({ method: "POST", url: "/api/auth/sign-up/email", headers: { origin: origins.get(app)! }, payload: { name: "测试", email, password: "correct horse battery staple" } });
  expect(response.statusCode).toBe(200);
  return { userId: response.json().user.id as string, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") };
}
function request(app: SongRoomApp, url: string, cookie?: string, body?: unknown, origin = origins.get(app)!) {
  return app.fastify.inject({ method: body === undefined ? "GET" : "POST", url, headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}

it("公共创建入口限制成员查询与房主命令，read model 只读且敏感响应不缓存", async () => {
  const { app, adapter, owner, member, outsider, url } = await fixture();
  const upstreamBefore = adapter.inputs.length;
  expect((await request(app, url)).statusCode).toBe(401);
  expect((await request(app, url, outsider.cookie)).statusCode).toBe(404);
  const visible = await request(app, url, owner.cookie);
  expect(visible.statusCode).toBe(200);
  expect(visible.headers["cache-control"]).toBe("no-store");
  expect(publicPlaylistView.parse(visible.json())).toMatchObject({ playlist: null, operation: null, allowedActions: ["createPublicPlaylist"] });
  expect(publicPlaylistView.parse((await request(app, url, member.cookie)).json())).toMatchObject({ allowedActions: [], disabledReason: "OWNER_ONLY" });
  expect((await request(app, url, member.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);
  expect((await request(app, url, outsider.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);
  expect(adapter.inputs.length).toBe(upstreamBefore);
});

it("浏览器只提交创建意图，伪造上游账号、目标、凭据或内部步骤和跨源请求均拒绝", async () => {
  const { app, owner, url } = await fixture();
  for (const extra of [{ accountId: "other" }, { playlistId: "existing" }, { cookie: "secret" }, { lockKey: "x" }, { step: "sending" }, { operation: "playlistCreate" }, { name: "自定义" }]) {
    expect((await request(app, url, owner.cookie, { idempotencyKey: v7(), ...extra })).statusCode).toBe(400);
  }
  expect((await request(app, url, owner.cookie, {})).statusCode).toBe(400);
  expect((await request(app, url, owner.cookie, { idempotencyKey: v7() }, "https://other.example")).statusCode).toBe(403);
  expect(publicPlaylistView.parse((await request(app, url, owner.cookie)).json()).operation).toBeNull();
});

it("受理立即返回202，同键并发返回200原操作；未来键和跨意图幂等冲突明确拒绝", async () => {
  const { app, owner, url } = await fixture();
  const key = v7();
  const responses = await Promise.all([request(app, url, owner.cookie, { idempotencyKey: key }), request(app, url, owner.cookie, { idempotencyKey: key })]);
  expect(responses.map(response => response.statusCode).sort()).toEqual([200, 202]);
  const views = responses.map(response => publicPlaylistView.parse(response.json()));
  expect(views[0].operation!.id).toBe(views[1].operation!.id);
  expect((await request(app, url, owner.cookie, { idempotencyKey: v7({ msecs: Date.now() + 120_000 }) })).statusCode).toBe(409);
  const renamed = await request(app, url.replace("/public-playlist", "/name"), owner.cookie, { idempotencyKey: key, name: "改名" });
  expect(renamed.statusCode).toBe(409);
  expect(renamed.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  const body = JSON.stringify(views);
  expect(body).not.toMatch(/credentials|cookie|accountId|generation|sending|digest/);
});

it("显式刷新接口仅对成员开放且校验同源，返回最新权威快照视图", async () => {
  const { app, adapter, owner, member, outsider, url } = await fixture();
  const refreshUrl = `${url}/refresh`;

  // 未登录 401
  expect((await request(app, refreshUrl, undefined, {})).statusCode).toBe(401);
  // 房间外用户 404
  expect((await request(app, refreshUrl, outsider.cookie, {})).statusCode).toBe(404);
  // 跨源 403
  expect((await request(app, refreshUrl, member.cookie, {}, "https://evil.com")).statusCode).toBe(403);

  // 尚未绑定歌单 409
  const unboundRes = await request(app, refreshUrl, member.cookie, {});
  expect(unboundRes.statusCode).toBe(409);

  // 插入绑定
  const roomId = url.split("/")[3];
  app.database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "test",
    playlistId: "cloud-pl",
    name: "songroom-测试宿舍-公共",
    creationOperationId: v7(),
    generation: 1
  }).run();

  adapter.playlistDetail = async () => ({
    ok: true,
    data: {
      playlist: { id: "cloud-pl", name: "songroom-测试宿舍-公共", creatorId: "test", subscribed: false, status: 0 },
      songIds: ["s1"],
      songs: [{ id: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
    }
  });

  // 室友成功刷新
  const refreshRes = await request(app, refreshUrl, member.cookie, {});
  expect(refreshRes.statusCode).toBe(200);
  const view = publicPlaylistView.parse(refreshRes.json());
  expect(view.snapshot?.version).toBe(1);
  expect(view.snapshot?.tracks).toHaveLength(1);
  expect(view.snapshot?.tracks[0].name).toBe("晴天");
  expect(view.allowedActions).toContain("refreshPublicPlaylist");
});

it("经由公开刷新核查失效，清空旧快照与标签并允许房主重新创建 generation 2 歌单", async () => {
  const { app, adapter, owner, member, url } = await fixture();
  const refreshUrl = `${url}/refresh`;
  const roomId = url.split("/")[3];

  // 1. 房主经由公开创建接口创建初始公共歌单 (代次 1)
  adapter.playlistCreate = async () => ({
    ok: true,
    data: { playlistId: "cloud-pl-stale" }
  });
  adapter.userPlaylists = async () => ({
    ok: true,
    data: { playlists: [{ id: "cloud-pl-stale", name: "songroom-测试宿舍-公共", creatorId: "test", subscribed: false, status: 0 }], more: false }
  });

  const initCreateRes = await request(app, url, owner.cookie, { idempotencyKey: v7() });
  expect(initCreateRes.statusCode).toBe(202);
  await app.scheduler.settle();

  const initViewRes = await request(app, url, owner.cookie);
  expect(initViewRes.statusCode).toBe(200);
  expect(publicPlaylistView.parse(initViewRes.json()).playlist?.id).toBe("cloud-pl-stale");

  // 2. 上游详情返回墓碑状态，但清单由于分页异常不完整 (more: true 且 playlists 为空) -> 不解除绑定
  adapter.playlistDetail = async () => ({
    ok: true,
    data: {
      playlist: { id: "cloud-pl-stale", name: "songroom-测试宿舍-公共", creatorId: "test", subscribed: false, status: 10 },
      songIds: ["s1"],
      songs: [{ id: "s1", name: "旧歌", artists: ["歌手"], album: "专辑" }]
    }
  });
  adapter.userPlaylists = async () => ({
    ok: true,
    data: { playlists: [], more: true }
  });

  const incompleteRefreshRes = await request(app, refreshUrl, owner.cookie, {});
  expect(incompleteRefreshRes.statusCode).toBe(200);
  const incompleteView = publicPlaylistView.parse(incompleteRefreshRes.json());
  expect(incompleteView.playlist?.id).toBe("cloud-pl-stale");
  expect(incompleteView.lastRefreshError).toBe("TARGET_PERMISSION");
  expect(incompleteView.invalidatedTarget).toBeNull();

  // 3. 完整清单确认目标歌单不存在且详情墓碑 -> 确认失效并解除绑定
  adapter.userPlaylists = async () => ({
    ok: true,
    data: { playlists: [], more: false }
  });

  const refreshRes = await request(app, refreshUrl, owner.cookie, {});
  expect(refreshRes.statusCode).toBe(200);
  const invalidatedView = publicPlaylistView.parse(refreshRes.json());
  expect(invalidatedView.playlist).toBeNull();
  expect(invalidatedView.snapshot).toBeNull();
  expect(invalidatedView.invalidatedTarget).toEqual({
    playlistId: "cloud-pl-stale",
    name: "songroom-测试宿舍-公共",
    checkedAt: expect.any(Number),
    status: "confirmedDeleted"
  });
  expect(invalidatedView.allowedActions).toEqual(["createPublicPlaylist"]);

  // 4. 室友读取：无创建权限，显示 OWNER_ONLY
  const memberGetRes = await request(app, url, member.cookie);
  expect(memberGetRes.statusCode).toBe(200);
  const memberView = publicPlaylistView.parse(memberGetRes.json());
  expect(memberView.playlist).toBeNull();
  expect(memberView.invalidatedTarget?.playlistId).toBe("cloud-pl-stale");
  expect(memberView.allowedActions).toEqual([]);
  expect(memberView.disabledReason).toBe("OWNER_ONLY");

  // 5. 室友尝试重建：拒绝
  const memberRecreateRes = await request(app, url, member.cookie, { idempotencyKey: v7() });
  expect(memberRecreateRes.statusCode).toBe(404);

  // 6. 房主提交重新创建代次 2
  adapter.playlistCreate = async () => ({
    ok: true,
    data: { playlistId: "cloud-pl-v2" }
  });
  const ownerRecreateRes = await request(app, url, owner.cookie, { idempotencyKey: v7() });
  expect(ownerRecreateRes.statusCode).toBe(202);

  // 等待调度执行完成
  await app.scheduler.settle();

  // 查询新状态：绑定已建立为代次 2，invalidatedTarget 为空
  const newViewRes = await request(app, url, owner.cookie);
  expect(newViewRes.statusCode).toBe(200);
  const newView = publicPlaylistView.parse(newViewRes.json());
  expect(newView.playlist?.id).toBe("cloud-pl-v2");
  expect(newView.invalidatedTarget).toBeNull();

  // 7. 刷新新歌单代次 2：正常向上游读取详情并确认空快照，无 AUTH_UNAVAILABLE 错误
  adapter.playlistDetail = async () => ({
    ok: true,
    data: {
      playlist: { id: "cloud-pl-v2", name: "songroom-测试宿舍-公共", creatorId: "test", subscribed: false, status: 0 },
      songIds: [],
      songs: []
    }
  });

  const newRefreshRes = await request(app, refreshUrl, owner.cookie, {});
  expect(newRefreshRes.statusCode).toBe(200);
  const refreshedNewView = publicPlaylistView.parse(newRefreshRes.json());
  expect(refreshedNewView.lastRefreshError).toBeNull();
  expect(refreshedNewView.snapshot?.trackCount).toBe(0);
  expect(refreshedNewView.snapshot?.tracks).toEqual([]);

  const newBinding = app.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()!;
  expect(newBinding.generation).toBe(2);
}, 20000);
