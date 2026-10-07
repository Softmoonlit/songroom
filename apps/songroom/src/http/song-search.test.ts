import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { room, roomMembership, neteaseAuthorization, publicPlaylistBinding } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import type { AdapterInput, AdapterResult } from "../netease/protocol.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-search-http-"));
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
  app.database.insert(publicPlaylistBinding).values({ roomId, accountId: "test", playlistId: "pl-test", name: "songroom-测试宿舍-公共", creationOperationId: v7(), generation: 1 }).run();

  return { app, adapter, owner, member, outsider, roomId, baseUrl };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({ method: "POST", url: "/api/auth/sign-up/email", headers: { origin: origins.get(app)! }, payload: { name: "测试", email, password: "correct horse battery staple" } });
  expect(response.statusCode).toBe(200);
  return { userId: response.json().user.id as string, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") };
}

function request(app: SongRoomApp, url: string, cookie?: string, body?: unknown, method = "POST") {
  return app.fastify.inject({
    method: method as any,
    url,
    headers: { origin: origins.get(app)!, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
}

it("非成员或未认证用户不能搜索公共歌单目标", async () => {
  const { app, outsider, roomId } = await fixture();

  // 未登录
  const unauth = await request(app, `/api/rooms/${roomId}/search`, undefined, { query: "晴天" });
  expect(unauth.statusCode).toBe(401);

  // 房间外用户
  const forbidden = await request(app, `/api/rooms/${roomId}/search`, outsider.cookie, { query: "晴天" });
  expect(forbidden.statusCode).toBe(404);
  expect(forbidden.json().error.code).toBe("ROOM_UNAVAILABLE");
});

it("房间成员可直接搜索网易云单曲，返回短命 searchId 并通过 SSE 接收失效更新", async () => {
  const { app, adapter, member, roomId, baseUrl } = await fixture();

  // 覆盖 adapter search 实现
  const origCall = adapter.call.bind(adapter);
  adapter.call = async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "search") {
      return {
        ok: true,
        data: {
          songs: [
            { id: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
            { id: "s-2", name: "晴天 (Live)", artists: ["周杰伦"], album: "无与伦比演唱会" }
          ]
        }
      } as any;
    }
    return origCall(input);
  };

  // 建立 SSE 连接
  const sseRes = await fetch(`${baseUrl}/api/events`, { headers: { cookie: member.cookie, accept: "text/event-stream" } });
  const sseReader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  await sseReader.read(); // connected 初始事件

  // 室友提交搜索
  const searchRes = await request(app, `/api/rooms/${roomId}/search`, member.cookie, { query: "晴天" });
  expect(searchRes.statusCode).toBe(202);
  const searchId = searchRes.json().searchId as string;
  expect(searchId).toBeDefined();

  // 读取 SSE 失效事件
  let sseData = "";
  while (true) {
    const { value, done } = await sseReader.read();
    if (done) break;
    sseData += decoder.decode(value);
    if (sseData.includes(searchId)) break;
  }
  expect(sseData).toContain("event: invalidation");
  expect(sseData).toContain(searchId);

  // 重新获取搜索结果
  const resultRes = await request(app, `/api/rooms/${roomId}/search/${searchId}`, member.cookie, undefined, "GET");
  expect(resultRes.statusCode).toBe(200);
  const result = resultRes.json();
  expect(result.status).toBe("completed");
  expect(result.songs).toHaveLength(2);
  expect(result.songs[0]).toEqual({
    id: "s-1",
    name: "晴天",
    artists: ["周杰伦"],
    album: "叶惠美"
  });

  await sseReader.cancel();
});

it("发起新搜索时自动取消旧搜索并丢弃晚到候选", async () => {
  const { app, adapter, member, roomId } = await fixture();

  let slowResolve: (() => void) | undefined;
  const origCall = adapter.call.bind(adapter);
  adapter.call = async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "search" && (input as any).query === "慢速搜索") {
      await new Promise<void>(resolve => { slowResolve = resolve; });
      return {
        ok: true,
        data: { songs: [{ id: "s-slow", name: "慢歌", artists: ["歌手"], album: "专辑" }] }
      } as any;
    }
    return origCall(input);
  };

  // 发起第一轮搜索
  const first = await request(app, `/api/rooms/${roomId}/search`, member.cookie, { query: "慢速搜索" });
  expect(first.statusCode).toBe(202);
  const firstSearchId = first.json().searchId;

  // 主动发起第二轮新搜索（修改关键词）
  const second = await request(app, `/api/rooms/${roomId}/search`, member.cookie, { query: "新搜索" });
  expect(second.statusCode).toBe(202);
  const secondSearchId = second.json().searchId;

  // 放行第一轮搜索
  slowResolve?.();

  // 查询第一轮搜索，结果没有被提交为 completed
  const firstResult = await request(app, `/api/rooms/${roomId}/search/${firstSearchId}`, member.cookie, undefined, "GET");
  expect(firstResult.json().status).not.toBe("completed");
});
