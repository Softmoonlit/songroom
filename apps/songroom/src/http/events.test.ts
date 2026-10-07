import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function allocatePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

async function fixture(existingRoot?: string, existingPort?: number) {
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "songroom-events-http-"));
  if (!existingRoot) {
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  }
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const dbPath = path.join(root, "songroom.sqlite");
  if (!existingRoot) {
    initializeDatabase(dbPath);
  }
  const credentialKeyPath = path.join(root, "netease.key");
  if (!existingRoot) {
    await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  }
  const adapter = new ScriptedNeteaseAdapter();
  const port = existingPort ?? await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await createApp({
    nodeEnv: "test",
    host: "127.0.0.1",
    port,
    baseUrl,
    dbPath,
    staticRoot,
    credentialKeyPath,
    authSecret: "test-secret-with-at-least-32-characters"
  }, { neteaseAdapter: adapter });
  origins.set(app, baseUrl);
  cleanups.push(() => app.close());
  await app.listen();
  return { app, baseUrl, root, port };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: origins.get(app)! },
    payload: { name: "测试用户", email, password: "correct horse battery staple" }
  });
  expect(response.statusCode).toBe(200);
  return {
    userId: response.json().user.id as string,
    cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ")
  };
}

async function createRoomViaHttp(app: SongRoomApp, cookie: string, baseUrl: string, name: string, nickname: string) {
  // 绑定网易云
  const startRes = await app.fastify.inject({
    method: "POST",
    url: "/api/netease/qr-flows",
    headers: { origin: baseUrl, cookie },
    payload: { idempotencyKey: v7() }
  });
  expect(startRes.statusCode).toBe(200);
  const flow = startRes.json() as { id: string };
  const checkRes = await app.fastify.inject({
    method: "POST",
    url: `/api/netease/qr-flows/${flow.id}/check`,
    headers: { origin: baseUrl, cookie },
    payload: {}
  });
  expect(checkRes.statusCode).toBe(200);
  const confirmRes = await app.fastify.inject({
    method: "POST",
    url: `/api/netease/qr-flows/${flow.id}/confirm`,
    headers: { origin: baseUrl, cookie },
    payload: { idempotencyKey: v7() }
  });
  expect(confirmRes.statusCode).toBe(200);
  const authId = confirmRes.json().binding.id as string;

  // 创建房间
  const roomRes = await app.fastify.inject({
    method: "POST",
    url: "/api/rooms",
    headers: { origin: baseUrl, cookie },
    payload: { idempotencyKey: v7(), authorizationId: authId, name, nickname }
  });
  expect(roomRes.statusCode).toBe(200);
  return roomRes.json() as { id: string; name: string; role: string; nickname: string };
}

interface SseMessage {
  event: string;
  data: string;
}

async function readNextSseMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  bufferRef: { buffer: string },
  timeoutMs = 3000
): Promise<SseMessage> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const parts = bufferRef.buffer.split("\n\n");
    if (parts.length > 1) {
      const rawMsg = parts.shift()!;
      bufferRef.buffer = parts.join("\n\n");
      let event = "message";
      let data = "";
      for (const line of rawMsg.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      return { event, data };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("读取 SSE 消息超时");

    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(resolve =>
      setTimeout(() => resolve({ done: true, value: undefined }), remaining)
    );

    const result = await Promise.race([readPromise, timeoutPromise]);
    if (result.done) {
      if (!result.value) throw new Error("读取 SSE 消息超时");
      break;
    }
    bufferRef.buffer += decoder.decode(result.value, { stream: true });
  }
  throw new Error("SSE 流已提前关闭");
}

it("未登录请求 /api/events 拒绝访问，返回 401", async () => {
  const { app } = await fixture();
  const response = await app.fastify.inject({
    method: "GET",
    url: "/api/events",
    headers: { accept: "text/event-stream" }
  });
  expect(response.statusCode).toBe(401);
});

it("跨源 Origin 或 cross-site 请求 /api/events 被拒绝，返回 403", async () => {
  const { app, baseUrl } = await fixture();
  const user = await signup(app, "attacker@example.com");

  // 跨源 Origin
  const crossOriginRes = await app.fastify.inject({
    method: "GET",
    url: "/api/events",
    headers: {
      origin: "https://evil.example.com",
      cookie: user.cookie,
      accept: "text/event-stream"
    }
  });
  expect(crossOriginRes.statusCode).toBe(403);
  expect(crossOriginRes.json().error.code).toBe("ORIGIN_REJECTED");

  // sec-fetch-site: cross-site
  const crossSiteRes = await app.fastify.inject({
    method: "GET",
    url: "/api/events",
    headers: {
      origin: baseUrl,
      "sec-fetch-site": "cross-site",
      cookie: user.cookie,
      accept: "text/event-stream"
    }
  });
  expect(crossSiteRes.statusCode).toBe(403);
  expect(crossSiteRes.json().error.code).toBe("ORIGIN_REJECTED");
});

it("多端失效：同账号另一设备通过真实 HTTP 修改房间后，第二设备接收到最小失效事件并重读权威状态", async () => {
  const { app, baseUrl } = await fixture();
  const owner = await signup(app, "owner-multi@example.com");
  const room = await createRoomViaHttp(app, owner.cookie, baseUrl, "原房间名", "房主");

  // 设备 2 建立 SSE 连接
  const client2Res = await fetch(`${baseUrl}/api/events`, {
    headers: { cookie: owner.cookie, accept: "text/event-stream" }
  });
  expect(client2Res.status).toBe(200);
  expect(client2Res.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");

  const reader = client2Res.body!.getReader();
  const decoder = new TextDecoder();
  const bufferRef = { buffer: "" };

  // 验证初次连接握手
  const connectedMsg = await readNextSseMessage(reader, decoder, bufferRef);
  expect(connectedMsg.event).toBe("connected");
  expect(connectedMsg.data).toContain("ok");

  // 设备 1 通过真实 HTTP API 改名
  const renameRes = await app.fastify.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/name`,
    headers: { origin: baseUrl, cookie: owner.cookie },
    payload: { idempotencyKey: v7(), name: "新房间名" }
  });
  expect(renameRes.statusCode).toBe(200);

  // 设备 2 通过 SSE 收到最小失效事件
  const invalidationMsg = await readNextSseMessage(reader, decoder, bufferRef);
  expect(invalidationMsg.event).toBe("invalidation");
  const payload = JSON.parse(invalidationMsg.data) as { type: string; resourceId: string; version: number };
  expect(payload.type).toBe("room");
  expect(payload.resourceId).toBe(room.id);
  expect(payload.version).toBeGreaterThan(1);
  // 事件绝不包含新房间名称或任何正文
  expect(invalidationMsg.data).not.toContain("新房间名");
  expect(invalidationMsg.data).not.toContain("原房间名");

  // 设备 2 根据失效事件主动调用普通 HTTP GET 读取权威 read model
  const readRes = await app.fastify.inject({
    method: "GET",
    url: `/api/rooms/${room.id}`,
    headers: { cookie: owner.cookie }
  });
  expect(readRes.statusCode).toBe(200);
  expect(readRes.json().room.name).toBe("新房间名");
  expect(readRes.json().version).toBe(payload.version);

  await reader.cancel();
});

it("账号隔离：无关账号不会收到其他房间的失效事件", async () => {
  const { app, baseUrl } = await fixture();
  const owner = await signup(app, "owner-iso@example.com");
  const stranger = await signup(app, "stranger@example.com");
  const room = await createRoomViaHttp(app, owner.cookie, baseUrl, "独立房", "房主");

  // stranger 建立 SSE
  const strangerRes = await fetch(`${baseUrl}/api/events`, {
    headers: { cookie: stranger.cookie, accept: "text/event-stream" }
  });
  const strangerReader = strangerRes.body!.getReader();
  const strangerDecoder = new TextDecoder();
  const strangerBuf = { buffer: "" };

  const strangerConn = await readNextSseMessage(strangerReader, strangerDecoder, strangerBuf);
  expect(strangerConn.event).toBe("connected");

  // 房主发起改名
  const renameRes = await app.fastify.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/name`,
    headers: { origin: baseUrl, cookie: owner.cookie },
    payload: { idempotencyKey: v7(), name: "更名测试" }
  });
  expect(renameRes.statusCode).toBe(200);

  // stranger 不会收到任何 invalidation 事件
  await expect(readNextSseMessage(strangerReader, strangerDecoder, strangerBuf, 300)).rejects.toThrow("超时");

  await strangerReader.cancel();
});

it("断线重连与服务重启：重连后建立新流，并可完整查询当前可见状态", async () => {
  const { app, baseUrl, root, port } = await fixture();
  const owner = await signup(app, "restart-test@example.com");
  const room = await createRoomViaHttp(app, owner.cookie, baseUrl, "重启房", "房主");

  // 1. 建立初始连接并主动断开（模拟网络中断）
  const conn1 = await fetch(`${baseUrl}/api/events`, { headers: { cookie: owner.cookie, accept: "text/event-stream" } });
  const reader1 = conn1.body!.getReader();
  const decoder1 = new TextDecoder();
  const buf1 = { buffer: "" };
  await readNextSseMessage(reader1, decoder1, buf1);
  await reader1.cancel();

  // 2. 模拟服务重启：关闭当前 app，重新用相同的 sqlite 路径启动新 app 实例
  await app.close();
  const restarted = await fixture(root, port);

  // 3. 客户端重连新服务实例的 SSE
  const conn2 = await fetch(`${restarted.baseUrl}/api/events`, { headers: { cookie: owner.cookie, accept: "text/event-stream" } });
  expect(conn2.status).toBe(200);
  const reader2 = conn2.body!.getReader();
  const decoder2 = new TextDecoder();
  const buf2 = { buffer: "" };
  const reconnectedMsg = await readNextSseMessage(reader2, decoder2, buf2);
  expect(reconnectedMsg.event).toBe("connected");

  // 4. 重连后客户端完整拉取当前权威 read model
  const readRes = await restarted.app.fastify.inject({
    method: "GET",
    url: `/api/rooms/${room.id}`,
    headers: { cookie: owner.cookie }
  });
  expect(readRes.statusCode).toBe(200);
  expect(readRes.json().room.name).toBe("重启房");

  await reader2.cancel();
});

it("会话注销（sign-out）后当前设备 SSE 连接自动关闭，后续重连返回 401", async () => {
  const { app, baseUrl } = await fixture();
  const user = await signup(app, "signout-test@example.com");

  const sseRes = await fetch(`${baseUrl}/api/events`, {
    headers: { cookie: user.cookie, accept: "text/event-stream" }
  });
  expect(sseRes.status).toBe(200);
  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  const buf = { buffer: "" };
  const first = await readNextSseMessage(reader, decoder, buf);
  expect(first.event).toBe("connected");

  // 执行 sign-out
  const signOutRes = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/sign-out",
    headers: { origin: baseUrl, cookie: user.cookie }
  });
  expect(signOutRes.statusCode).toBe(200);

  // SSE 流应被服务端主动关闭（reader.read() 返回 done: true）
  const nextChunk = await reader.read();
  expect(nextChunk.done).toBe(true);

  // 退出后再建立 SSE 连接返回 401
  const reconnectRes = await app.fastify.inject({
    method: "GET",
    url: "/api/events",
    headers: { cookie: user.cookie, accept: "text/event-stream" }
  });
  expect(reconnectRes.statusCode).toBe(401);
});

it("申请提交与审批后，房主与申请人多端分别收到最小失效事件", async () => {
  const { app, baseUrl } = await fixture();
  const owner = await signup(app, "owner-approval@example.com");
  const applicant = await signup(app, "applicant@example.com");
  const room = await createRoomViaHttp(app, owner.cookie, baseUrl, "审批房", "房主");

  // 获取房主邀请码
  const inviteRes = await app.fastify.inject({
    method: "GET",
    url: `/api/rooms/${room.id}/invite`,
    headers: { cookie: owner.cookie }
  });
  expect(inviteRes.statusCode).toBe(200);
  const code = inviteRes.json().code as string;

  // 房主建立 SSE 连接
  const ownerSse = await fetch(`${baseUrl}/api/events`, { headers: { cookie: owner.cookie, accept: "text/event-stream" } });
  const ownerReader = ownerSse.body!.getReader();
  const ownerDecoder = new TextDecoder();
  const ownerBuf = { buffer: "" };
  await readNextSseMessage(ownerReader, ownerDecoder, ownerBuf);

  // 申请人建立 SSE 连接
  const applicantSse = await fetch(`${baseUrl}/api/events`, { headers: { cookie: applicant.cookie, accept: "text/event-stream" } });
  const applicantReader = applicantSse.body!.getReader();
  const applicantDecoder = new TextDecoder();
  const applicantBuf = { buffer: "" };
  await readNextSseMessage(applicantReader, applicantDecoder, applicantBuf);

  // 申请人提交加入申请
  const applyRes = await app.fastify.inject({
    method: "POST",
    url: "/api/join-applications",
    headers: { origin: baseUrl, cookie: applicant.cookie },
    payload: { idempotencyKey: v7(), code, nickname: "室友小明" }
  });
  expect(applyRes.statusCode).toBe(200);
  const applicationId = applyRes.json().id as string;

  // 房主通过 SSE 收到 room 失效通知（有新申请待处理）
  const ownerMsg = await readNextSseMessage(ownerReader, ownerDecoder, ownerBuf);
  expect(ownerMsg.event).toBe("invalidation");
  const ownerPayload = JSON.parse(ownerMsg.data) as { type: string; resourceId: string; version: number };
  expect(ownerPayload.type).toBe("room");
  expect(ownerPayload.resourceId).toBe(room.id);

  // 房主通过 HTTP 审批通过
  const approveRes = await app.fastify.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/applications/${applicationId}/decision`,
    headers: { origin: baseUrl, cookie: owner.cookie },
    payload: { idempotencyKey: v7(), decision: "approve" }
  });
  expect(approveRes.statusCode).toBe(200);

  // 申请人通过 SSE 收到 room 失效通知（加入房间成功）
  const appMsg = await readNextSseMessage(applicantReader, applicantDecoder, applicantBuf);
  expect(appMsg.event).toBe("invalidation");
  const appPayload = JSON.parse(appMsg.data) as { type: string; resourceId: string; version: number };
  expect(appPayload.resourceId).toBe(room.id);

  // 申请人拉取权威 read model，确认自己已是室友
  const memberShellRes = await app.fastify.inject({
    method: "GET",
    url: `/api/rooms/${room.id}`,
    headers: { cookie: applicant.cookie }
  });
  expect(memberShellRes.statusCode).toBe(200);
  expect(memberShellRes.json().room.role).toBe("roommate");
  expect(memberShellRes.json().room.nickname).toBe("室友小明");

  await ownerReader.cancel();
  await applicantReader.cancel();
});

it("会话到期后定时器自动关闭 SSE 连接", async () => {
  const { app, baseUrl } = await fixture();
  const user = await signup(app, "expires-test@example.com");

  // 直接验证 EventStreamService 的 expiresAtMs 定时器边界
  let ended = false;
  const mockReply: any = {
    raw: {
      end: () => { ended = true; },
      on: () => {}
    },
    sse: {
      keepAlive: () => {},
      send: async () => {},
      isConnected: true
    }
  };
  await app.eventStream.subscribe("test-user", "test-session", mockReply, Date.now() + 30);
  expect(ended).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(ended).toBe(true);

  // 验证实际 HTTP 连接在 session 被撤销时关闭
  const sseRes = await fetch(`${baseUrl}/api/events`, {
    headers: { cookie: user.cookie, accept: "text/event-stream" }
  });
  expect(sseRes.status).toBe(200);
  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  const buf = { buffer: "" };
  const first = await readNextSseMessage(reader, decoder, buf);
  expect(first.event).toBe("connected");

  const session = await app.fastify.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie: user.cookie } });
  const sessionId = session.json().session.id as string;
  app.eventStream.closeSession(sessionId);

  const chunk = await reader.read();
  expect(chunk.done).toBe(true);
});

