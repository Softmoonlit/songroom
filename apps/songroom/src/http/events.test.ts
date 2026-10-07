import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { room, roomMembership } from "../db/schema.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-events-http-"));
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
  const roomId = v7();
  app.database.insert(room).values({ id: roomId, ownerUserId: owner.userId, name: "测试宿舍" }).run();
  app.database.insert(roomMembership).values([
    { id: v7(), roomId, userId: owner.userId, nickname: "房主" },
    { id: v7(), roomId, userId: member.userId, nickname: "室友" }
  ]).run();
  return { app, owner, member, roomId, baseUrl };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({ method: "POST", url: "/api/auth/sign-up/email", headers: { origin: origins.get(app)! }, payload: { name: "测试", email, password: "correct horse battery staple" } });
  expect(response.statusCode).toBe(200);
  return { userId: response.json().user.id as string, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") };
}

it("未登录请求 /api/events 拒绝访问", async () => {
  const { app } = await fixture();
  const response = await app.fastify.inject({
    method: "GET",
    url: "/api/events",
    headers: { accept: "text/event-stream" }
  });
  expect(response.statusCode).toBe(401);
});

it("已登录用户可建立 SSE 连接并接收最小失效事件，响应带有 no-store", async () => {
  const { app, owner, roomId, baseUrl } = await fixture();

  // 使用原生 fetch 建立真正的流式 SSE 监听
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: {
      cookie: owner.cookie,
      accept: "text/event-stream"
    }
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");

  const reader = response.body?.getReader();
  expect(reader).toBeDefined();

  const decoder = new TextDecoder();
  // 首先读取初始连通事件，保证连接已完全建立
  const first = await reader!.read();
  expect(decoder.decode(first.value)).toContain("event: connected");

  // 触发一次账号级失效事件
  const searchId = v7();
  app.eventStream.notifyUser(owner.userId, {
    type: "search",
    roomId,
    resourceId: searchId
  });

  // 读取事件流数据
  let receivedText = "";
  while (true) {
    const { value, done } = await reader!.read();
    if (done) break;
    receivedText += decoder.decode(value);
    if (receivedText.includes("invalidation")) break;
  }

  expect(receivedText).toContain("event: invalidation");
  expect(receivedText).toContain(searchId);
  // 确保事件正文不包含任何虚构搜索结果正文或曲目
  expect(receivedText).not.toContain("晴天");
  expect(receivedText).not.toContain("candidates");

  await reader!.cancel();
});

it("SSE 失效流具备账号隔离，其他账号不会收到无关事件", async () => {
  const { app, owner, member, roomId, baseUrl } = await fixture();

  const ownerRes = await fetch(`${baseUrl}/api/events`, { headers: { cookie: owner.cookie, accept: "text/event-stream" } });
  const memberRes = await fetch(`${baseUrl}/api/events`, { headers: { cookie: member.cookie, accept: "text/event-stream" } });

  const ownerReader = ownerRes.body!.getReader();
  const memberReader = memberRes.body!.getReader();
  const decoder = new TextDecoder();

  // 消化初始连通消息
  await ownerReader.read();
  await memberReader.read();

  const ownerSearchId = v7();
  // 只通知 owner
  app.eventStream.notifyUser(owner.userId, { type: "search", roomId, resourceId: ownerSearchId });

  // owner 读取到
  const ownerChunk = await ownerReader.read();
  expect(decoder.decode(ownerChunk.value)).toContain(ownerSearchId);

  // member 没有收到通知，超时读取为 race
  const memberTimeout = new Promise<string>(resolve => setTimeout(() => resolve("timeout"), 200));
  const memberRead = memberReader.read().then(c => decoder.decode(c.value));
  const result = await Promise.race([memberRead, memberTimeout]);
  expect(result).toBe("timeout");

  await ownerReader.cancel();
  await memberReader.cancel();
});

it("notifyRoom 会同时通知房间内所有成员", async () => {
  const { app, owner, member, roomId, baseUrl } = await fixture();

  const ownerRes = await fetch(`${baseUrl}/api/events`, { headers: { cookie: owner.cookie, accept: "text/event-stream" } });
  const memberRes = await fetch(`${baseUrl}/api/events`, { headers: { cookie: member.cookie, accept: "text/event-stream" } });

  const ownerReader = ownerRes.body!.getReader();
  const memberReader = memberRes.body!.getReader();
  const decoder = new TextDecoder();

  await ownerReader.read();
  await memberReader.read();

  const opId = v7();
  app.eventStream.notifyRoom(app.database, roomId, { type: "publicPlaylist", roomId, resourceId: opId });

  const ownerChunk = await ownerReader.read();
  expect(decoder.decode(ownerChunk.value)).toContain(opId);

  const memberChunk = await memberReader.read();
  expect(decoder.decode(memberChunk.value)).toContain(opId);

  await ownerReader.cancel();
  await memberReader.cancel();
});
