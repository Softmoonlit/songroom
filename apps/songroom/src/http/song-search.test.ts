import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { SearchView, SongCandidate } from "../shared/song-search-contracts.js";
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
    headers: { origin: origins.get(app)!, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
}

type SearchInput = Extract<AdapterInput, { operation: "search" }>;
function songs(start: number, length = 20): SongCandidate[] {
  return Array.from({ length }, (_, index) => ({ id: `s-${start + index}`, name: `歌曲${start + index}`, artists: ["歌手"], album: "专辑" }));
}

function scriptSearch(adapter: ScriptedNeteaseAdapter, handler: (input: SearchInput) => AdapterResult<"search"> | Promise<AdapterResult<"search">>) {
  const original = adapter.call.bind(adapter);
  adapter.call = async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation !== "search") return original(input);
    adapter.inputs.push(input);
    return await handler(input) as AdapterResult<I["operation"]>;
  };
}

async function startSearch(app: SongRoomApp, roomId: string, cookie: string, query = "歌曲") {
  const response = await request(app, `/api/rooms/${roomId}/search`, cookie, { query });
  expect(response.statusCode).toBe(202);
  return response.json().searchId as string;
}

async function completedSearch(app: SongRoomApp, roomId: string, cookie: string, searchId: string, status = "completed"): Promise<SearchView> {
  let view: SearchView;
  await expect.poll(async () => {
    const response = await request(app, `/api/rooms/${roomId}/search/${searchId}`, cookie, undefined, "GET");
    expect(response.statusCode).toBe(200);
    view = response.json();
    return view.status;
  }, { timeout: 5000 }).toBe(status);
  return view!;
}

it("非成员或未认证用户不能搜索；搜索及分页结果仅属于发起成员", async () => {
  const { app, adapter, owner, member, outsider, roomId } = await fixture();
  scriptSearch(adapter, () => ({ ok: true, data: { songs: songs(0), songCount: 40 } }));
  expect((await request(app, `/api/rooms/${roomId}/search`, undefined, { query: "晴天" })).statusCode).toBe(401);
  expect((await request(app, `/api/rooms/${roomId}/search`, outsider.cookie, { query: "晴天" })).statusCode).toBe(404);
  const searchId = await startSearch(app, roomId, member.cookie);
  await completedSearch(app, roomId, member.cookie, searchId);
  for (const cookie of [undefined, outsider.cookie, owner.cookie]) {
    for (const [suffix, method] of [["", "GET"], ["/more", "POST"]]) {
      const response = await request(app, `/api/rooms/${roomId}/search/${searchId}${suffix}`, cookie, undefined, method);
      expect(response.statusCode).toBe(cookie ? 404 : 401);
    }
  }
  expect(adapter.inputs.filter(input => input.operation === "search")).toHaveLength(1);
});

it("首次20首通过SSE失效通知读回；分页按相关性去重追加且不自动预取，整页重复时停止", async () => {
  const { app, adapter, member, roomId, baseUrl } = await fixture();
  scriptSearch(adapter, input => ({ ok: true, data: { songs: input.offset === 0 ? songs(0) : songs(18), songCount: 200 + input.offset } }));
  const sseRes = await fetch(`${baseUrl}/api/events`, { headers: { cookie: member.cookie, accept: "text/event-stream" } });
  const reader = sseRes.body!.getReader();
  cleanups.push(async () => { await reader.cancel(); });
  await reader.read();
  const searchId = await startSearch(app, roomId, member.cookie);
  let event = "";
  const decoder = new TextDecoder();
  while (!event.includes(searchId)) {
    const { value, done } = await reader.read();
    if (done) break;
    event += decoder.decode(value);
  }
  expect(event).toContain("event: invalidation");
  expect(event).toContain(searchId);
  const first = await completedSearch(app, roomId, member.cookie, searchId);
  expect(first.songs).toEqual(songs(0));
  expect(first.hasMore).toBe(true);
  expect(adapter.inputs.filter(input => input.operation === "search")).toHaveLength(1);

  expect((await request(app, `/api/rooms/${roomId}/search/${searchId}/more`, member.cookie)).statusCode).toBe(202);
  const second = await completedSearch(app, roomId, member.cookie, searchId);
  expect(second.songs).toEqual(songs(0, 38));
  expect(second.hasMore).toBe(true);
  expect((await request(app, `/api/rooms/${roomId}/search/${searchId}/more`, member.cookie)).statusCode).toBe(202);
  const last = await completedSearch(app, roomId, member.cookie, searchId);
  expect(last.songs).toEqual(second.songs);
  expect(last.hasMore).toBe(false);
  const exhausted = await request(app, `/api/rooms/${roomId}/search/${searchId}/more`, member.cookie);
  expect(exhausted.statusCode).toBe(409);
  expect(exhausted.json().error.code).toBe("SEARCH_EXHAUSTED");
  expect(adapter.inputs.filter(input => input.operation === "search").map(input => [input.cookie, input.limit, input.offset])).toEqual([
    ["MUSIC_U=test", 20, 0], ["MUSIC_U=test", 20, 20], ["MUSIC_U=test", 20, 40]
  ]);
});

it.each([0, 3])("total声称仍有更多时，长度为%i的短页也终止加载", async length => {
  const { app, adapter, member, roomId } = await fixture();
  scriptSearch(adapter, () => ({ ok: true, data: { songs: songs(0, length), songCount: 9999 } }));
  const searchId = await startSearch(app, roomId, member.cookie);
  const view = await completedSearch(app, roomId, member.cookie, searchId);
  expect(view.songs).toHaveLength(length);
  expect(view.hasMore).toBe(false);
});

it("加载更多重复点击只执行一页；失败保留前页，明确重试后才以同offset再次读取", async () => {
  const { app, adapter, member, roomId } = await fixture();
  let release!: () => void;
  cleanups.push(async () => { release?.(); });
  let attempts = 0;
  scriptSearch(adapter, async input => {
    if (input.offset === 0) return { ok: true, data: { songs: songs(0), songCount: 40 } };
    if (++attempts === 1) {
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: false, error: { code: "NETWORK_ERROR", outcome: "failed" } };
    }
    return { ok: true, data: { songs: songs(20), songCount: 40 } };
  });
  const searchId = await startSearch(app, roomId, member.cookie);
  await completedSearch(app, roomId, member.cookie, searchId);
  const url = `/api/rooms/${roomId}/search/${searchId}/more`;
  await request(app, url, member.cookie);
  await expect.poll(() => attempts, { timeout: 3000 }).toBe(1);
  expect((await request(app, url, member.cookie)).statusCode).toBe(202);
  const loading = await request(app, `/api/rooms/${roomId}/search/${searchId}`, member.cookie, undefined, "GET");
  expect(loading.json().songs).toEqual(songs(0));
  release();
  const failed = await completedSearch(app, roomId, member.cookie, searchId, "failed");
  expect(failed.songs).toEqual(songs(0));
  expect(failed.hasMore).toBe(true);
  expect(failed.errorCode).toBe("NETWORK_ERROR");
  expect(attempts).toBe(1);
  await request(app, url, member.cookie);
  const retried = await completedSearch(app, roomId, member.cookie, searchId);
  expect(retried.songs).toEqual(songs(0, 40));
  expect(retried.hasMore).toBe(false);
  expect(adapter.inputs.filter(input => input.operation === "search").map(input => input.offset)).toEqual([0, 20, 20]);
});

it("新关键词取消已完成旧轮及正在执行的旧分页，晚到结果不能继续分页或污染新轮", async () => {
  const { app, adapter, member, roomId } = await fixture();
  let release!: () => void;
  cleanups.push(async () => { release?.(); });
  let entered = false;
  scriptSearch(adapter, async input => {
    if (input.query === "旧关键词" && input.offset === 20) {
      entered = true;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return { ok: true, data: { songs: songs(input.query === "旧关键词" ? input.offset : 100), songCount: 60 } };
  });
  const firstId = await startSearch(app, roomId, member.cookie, "旧关键词");
  await completedSearch(app, roomId, member.cookie, firstId);
  await request(app, `/api/rooms/${roomId}/search/${firstId}/more`, member.cookie);
  await expect.poll(() => entered, { timeout: 3000 }).toBe(true);
  const secondId = await startSearch(app, roomId, member.cookie, "新关键词");
  release();
  const second = await completedSearch(app, roomId, member.cookie, secondId);
  expect(second.songs).toEqual(songs(100));
  for (const [suffix, method] of [["", "GET"], ["/more", "POST"]]) {
    expect((await request(app, `/api/rooms/${roomId}/search/${firstId}${suffix}`, member.cookie, undefined, method)).statusCode).toBe(404);
  }
  const thirdId = await startSearch(app, roomId, member.cookie, "又一轮");
  expect(thirdId).not.toBe(secondId);
  expect((await request(app, `/api/rooms/${roomId}/search/${secondId}/more`, member.cookie)).statusCode).toBe(404);
});

it.each(["membership", "authorization", "binding"] as const)("分页受理时重新检查%s", async change => {
  const { app, adapter, member, owner, roomId } = await fixture();
  scriptSearch(adapter, () => ({ ok: true, data: { songs: songs(0), songCount: 40 } }));
  const searchId = await startSearch(app, roomId, member.cookie);
  await completedSearch(app, roomId, member.cookie, searchId);
  if (change === "membership") app.database.delete(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, member.userId))).run();
  if (change === "authorization") app.database.update(neteaseAuthorization).set({ status: "waitingAuthorization" }).where(eq(neteaseAuthorization.userId, owner.userId)).run();
  if (change === "binding") app.database.update(publicPlaylistBinding).set({ generation: 2 }).where(eq(publicPlaylistBinding.roomId, roomId)).run();
  const response = await request(app, `/api/rooms/${roomId}/search/${searchId}/more`, member.cookie);
  expect(response.statusCode).toBe(change === "membership" ? 404 : 409);
  expect(response.json().error.code).toBe(change === "membership" ? "ROOM_UNAVAILABLE" : change === "authorization" ? "NETEASE_AUTH_REQUIRED" : "PUBLIC_PLAYLIST_CHANGED");
  expect(adapter.inputs.filter(input => input.operation === "search")).toHaveLength(1);
});

it.each(["membership", "authorization", "binding"] as const)("已排队的搜索执行前重新检查%s，不使用排队前凭据发送", async change => {
  const { app, adapter, member, owner, roomId } = await fixture();
  scriptSearch(adapter, () => ({ ok: true, data: { songs: songs(0), songCount: 40 } }));
  let release!: () => void;
  cleanups.push(async () => { release?.(); });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = app.scheduler.executeMemoryTask("test", async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await entered;
  await startSearch(app, roomId, member.cookie);
  if (change === "membership") app.database.delete(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, member.userId))).run();
  if (change === "authorization") app.database.update(neteaseAuthorization).set({ status: "waitingAuthorization" }).where(eq(neteaseAuthorization.userId, owner.userId)).run();
  if (change === "binding") app.database.update(publicPlaylistBinding).set({ generation: 2 }).where(eq(publicPlaylistBinding.roomId, roomId)).run();
  release();
  await blocked;
  await app.scheduler.settle();
  expect(adapter.inputs.filter(input => input.operation === "search")).toHaveLength(0);
});

it("上游返回前授权失效时不发布候选，恢复同一授权后能读到明确失败状态", async () => {
  const { app, adapter, member, owner, roomId } = await fixture();
  scriptSearch(adapter, () => {
    app.database.update(neteaseAuthorization).set({ status: "waitingAuthorization" }).where(eq(neteaseAuthorization.userId, owner.userId)).run();
    return { ok: true, data: { songs: songs(0), songCount: 40 } };
  });
  const searchId = await startSearch(app, roomId, member.cookie);
  await app.scheduler.settle();
  app.database.update(neteaseAuthorization).set({ status: "active" }).where(eq(neteaseAuthorization.userId, owner.userId)).run();
  const failed = await completedSearch(app, roomId, member.cookie, searchId, "failed");
  expect(failed.errorCode).toBe("NETEASE_AUTH_REQUIRED");
  expect(failed.songs).toEqual([]);
});
