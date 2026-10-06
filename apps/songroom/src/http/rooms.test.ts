import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "./app.js";
import type { AppConfig } from "../config.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";

const roots: string[] = [];
const apps: SongRoomApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(now = () => Date.now()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-rooms-")); roots.push(root);
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const dbPath = path.join(root, "songroom.sqlite"); initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const config: AppConfig = { nodeEnv: "test", host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, dbPath, staticRoot, credentialKeyPath, authSecret: "test-secret-with-at-least-32-characters" };
  const adapter = new ScriptedNeteaseAdapter();
  const app = await createApp(config, { neteaseAdapter: adapter, now }); apps.push(app); await app.listen();
  return { app, config, adapter };
}
async function request(config: AppConfig, url: string, cookie?: string, body?: unknown) {
  return fetch(config.baseUrl + url, { method: body === undefined ? "GET" : "POST", headers: { origin: config.baseUrl, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function signUp(config: AppConfig, email: string) {
  const response = await request(config, "/api/auth/sign-up/email", undefined, { name: "测试账号", email, password: "correct horse battery staple" });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}
async function bind(config: AppConfig, cookie: string): Promise<string> {
  const started = await request(config, "/api/netease/qr-flows", cookie, { idempotencyKey: v7() });
  expect(started.status).toBe(200);
  const flow = await started.json() as { id: string };
  expect((await request(config, `/api/netease/qr-flows/${flow.id}/check`, cookie, {})).status).toBe(200);
  const result = await request(config, `/api/netease/qr-flows/${flow.id}/confirm`, cookie, { idempotencyKey: v7() });
  expect(result.status).toBe(200);
  return (await result.json()).binding.id as string;
}
function command(authorizationId: string, extra: Record<string, unknown> = {}) {
  return { idempotencyKey: v7(), authorizationId, name: "同名宿舍", nickname: " 房主 ", ...extra };
}

it("未登录不可查看房间或建房，未授权账号不能建房", async () => {
  const { config } = await fixture();
  for (const url of ["/api/rooms", "/api/rooms/create-view", `/api/rooms/${v7()}`]) expect((await request(config, url)).status).toBe(401);
  const cookie = await signUp(config, "unbound@example.com");
  expect(await (await request(config, "/api/rooms", cookie)).json()).toEqual({ rooms: [] });
  expect(await (await request(config, "/api/rooms/create-view", cookie)).json()).toMatchObject({ authorization: null, allowedActions: [], disabledReason: "NETEASE_AUTH_REQUIRED" });
  const rejected = await request(config, "/api/rooms", cookie, command(v7()));
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: { code: "NETEASE_AUTH_REQUIRED" } });
});

it("有效授权建房只建立房主成员，重复名称可建、查询隔离且重启保留", async () => {
  const { app, config, adapter } = await fixture();
  const owner = await signUp(config, "owner@example.com");
  const other = await signUp(config, "other@example.com");
  const authorizationId = await bind(config, owner);
  const before = adapter.inputs.length;
  const createView = await request(config, "/api/rooms/create-view", owner);
  expect(createView.headers.get("cache-control")).toBe("no-store");
  expect(await createView.json()).toMatchObject({ authorization: { id: authorizationId, identity: { nickname: "测试网易云身份" } }, allowedActions: ["createRoom"] });
  expect(adapter.inputs.length).toBe(before);
  const first = await request(config, "/api/rooms", owner, command(authorizationId));
  expect(first.status).toBe(200);
  const summary = await first.json() as { id: string; name: string };
  expect(summary).toMatchObject({ name: "同名宿舍", role: "owner", nickname: "房主" });
  const second = await request(config, "/api/rooms", owner, command(authorizationId));
  expect(second.status).toBe(200);
  expect((await second.json()).id).not.toBe(summary.id);
  expect(adapter.inputs.slice(before).map(input => input.operation)).toEqual(["identity", "identity"]);
  expect(await (await request(config, "/api/rooms", owner)).json()).toMatchObject({ rooms: [{ id: summary.id }, { name: "同名宿舍" }] });
  expect(await (await request(config, "/api/rooms", other)).json()).toEqual({ rooms: [] });
  for (const suffix of ["", "/members"]) {
    expect((await request(config, `/api/rooms/${summary.id}${suffix}`, other)).status).toBe(404);
    expect((await request(config, `/api/rooms/${v7()}${suffix}`, owner)).status).toBe(404);
  }
  expect(await (await request(config, `/api/rooms/${summary.id}`, owner)).json()).toMatchObject({ room: { id: summary.id, role: "owner" }, version: 1 });
  const members = await request(config, `/api/rooms/${summary.id}/members`, owner);
  expect(await members.json()).toEqual({ members: [{ id: expect.any(String), nickname: "房主", role: "owner", isSelf: true, allowedActions: ["renameNickname"], disabledReasons: {} }], allowedActions: ["renameRoom", "renameNickname", "reviewApplications", "readInvite"], disabledReasons: {} });
  const body = await (await request(config, `/api/rooms/${summary.id}/members`, owner)).text();
  expect(body).not.toMatch(/email|ownerUserId|accountId|credentials|invitation|code/);
  await app.close();
  const restarted = await createApp(config, { neteaseAdapter: adapter }); apps.push(restarted); await restarted.listen();
  expect(await (await request(config, `/api/rooms/${summary.id}`, owner)).json()).toMatchObject({ room: { id: summary.id, name: "同名宿舍" } });
});

it("并发建房在自建上限只接受三个，同键并发及多设备重放不多建", async () => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, "capacity@example.com");
  const id = await bind(config, cookie);
  const first = command(id);
  const duplicate = await Promise.all([request(config, "/api/rooms", cookie, first), request(config, "/api/rooms", cookie, first)]);
  expect(duplicate.map(response => response.status)).toEqual([200, 200]);
  const originals = await Promise.all(duplicate.map(response => response.json()));
  expect(originals[0]).toEqual(originals[1]);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => request(config, "/api/rooms", cookie, command(id))));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 200, 409, 409, 409]);
  for (const response of concurrent.filter(response => response.status === 409)) expect(await response.json()).toMatchObject({ error: { code: "OWNED_ROOM_LIMIT" } });
  expect((await (await request(config, "/api/rooms", cookie)).json()).rooms).toHaveLength(3);
  expect(await (await request(config, "/api/rooms/create-view", cookie)).json()).toMatchObject({ allowedActions: [], disabledReason: "OWNED_ROOM_LIMIT" });
  const login = await request(config, "/api/auth/sign-in/email", undefined, { email: "capacity@example.com", password: "correct horse battery staple" });
  const device = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const before = adapter.inputs.length;
  expect(await (await request(config, "/api/rooms", device, first)).json()).toEqual(originals[0]);
  expect(adapter.inputs.length).toBe(before);
  const conflict = await request(config, "/api/rooms", cookie, { ...first, name: "不同内容" });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
});

it("全站并发容量最多二十个房间，拒绝新增后已有房间仍可进入", async () => {
  const { config } = await fixture();
  const owners: Array<{ cookie: string; authorizationId: string }> = [];
  for (let index = 0; index < 7; index++) {
    const cookie = await signUp(config, `global-${index}@example.com`);
    const authorizationId = await bind(config, cookie);
    owners.push({ cookie, authorizationId });
    for (let roomIndex = 0; roomIndex < 2; roomIndex++) expect((await request(config, "/api/rooms", cookie, command(authorizationId))).status).toBe(200);
  }
  const concurrent = await Promise.all(owners.map(({ cookie, authorizationId }) => request(config, "/api/rooms", cookie, command(authorizationId))));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 409]);
  expect(await concurrent.find(response => response.status === 409)!.json()).toMatchObject({ error: { code: "GLOBAL_ROOM_LIMIT" } });
  const lists = await Promise.all(owners.map(async ({ cookie }) => (await (await request(config, "/api/rooms", cookie)).json()).rooms as Array<{ id: string }>));
  expect(lists.flat()).toHaveLength(20);
  for (const [index, rooms] of lists.entries()) {
    expect(rooms.length).toBeGreaterThanOrEqual(2);
    for (const visible of rooms) expect((await request(config, `/api/rooms/${visible.id}`, owners[index]!.cookie)).status).toBe(200);
  }
});

it("建房拒绝伪造房主、角色、上游账号或别人的本地授权", async () => {
  const { config } = await fixture();
  const cookie = await signUp(config, "forged-room@example.com");
  const other = await signUp(config, "forged-other@example.com");
  const authorizationId = await bind(config, cookie);
  const foreignId = await bind(config, other);
  for (const extra of [{ ownerUserId: "other" }, { role: "owner" }, { accountId: "forged" }, { cookie: "private" }, { generation: 2 }]) {
    expect((await request(config, "/api/rooms", cookie, command(authorizationId, extra))).status).toBe(400);
  }
  const foreign = await request(config, "/api/rooms", cookie, command(foreignId));
  expect(foreign.status).toBe(409);
  expect(await foreign.json()).toMatchObject({ error: { code: "AUTHORIZATION_CHANGED" } });
  expect(await (await request(config, "/api/rooms", cookie)).json()).toEqual({ rooms: [] });
});

it.each(["AUTH_UNAVAILABLE", "RATE_LIMITED", "NETWORK_ERROR"] as const)("建房重新核实身份，%s 不创建房间", async code => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, `${code.toLowerCase()}@example.com`);
  const authorizationId = await bind(config, cookie);
  adapter.identityError = { code, outcome: "failed" };
  const response = await request(config, "/api/rooms", cookie, command(authorizationId));
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { code } });
  expect(await (await request(config, "/api/rooms", cookie)).json()).toEqual({ rooms: [] });
});

it("建房核实出的真实身份不匹配时保留原绑定并拒绝建房", async () => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, "mismatch@example.com");
  const authorizationId = await bind(config, cookie);
  adapter.identityAccount = "another-account";
  const response = await request(config, "/api/rooms", cookie, command(authorizationId));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "ACCOUNT_MISMATCH" } });
  expect((await (await request(config, "/api/netease/binding", cookie)).json()).binding.id).toBe(authorizationId);
  expect(await (await request(config, "/api/rooms", cookie)).json()).toEqual({ rooms: [] });
});

it("在途身份核实期间会话退出，晚到结果不能建房", async () => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, "late-room@example.com");
  const authorizationId = await bind(config, cookie);
  let reached!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  adapter.beforeIdentity = async () => { reached(); await blocked; };
  const pending = request(config, "/api/rooms", cookie, command(authorizationId));
  await started;
  expect((await request(config, "/api/auth/sign-out", cookie, {})).status).toBe(200);
  release();
  expect((await pending).status).toBe(401);
  const login = await request(config, "/api/auth/sign-in/email", undefined, { email: "late-room@example.com", password: "correct horse battery staple" });
  const device = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  expect(await (await request(config, "/api/rooms", device)).json()).toEqual({ rooms: [] });
});

it("房间名和昵称按 NFC 与码点长度校验，控制字符和空白输入被拒绝", async () => {
  const { config } = await fixture();
  const cookie = await signUp(config, "text@example.com");
  const authorizationId = await bind(config, cookie);
  for (const extra of [{ name: "  " }, { nickname: "\t " }, { name: "宿舍\u0000" }, { nickname: "成员\n称呼" }, { name: "😀".repeat(17) }, { nickname: "😀".repeat(13) }]) {
    expect((await request(config, "/api/rooms", cookie, command(authorizationId, extra))).status).toBe(400);
  }
  const created = await request(config, "/api/rooms", cookie, command(authorizationId, { name: " e\u0301宿舍 ", nickname: " e\u0301 " }));
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ name: "é宿舍", nickname: "é" });
  const emoji = await request(config, "/api/rooms", cookie, command(authorizationId, { name: "😀".repeat(16), nickname: "😀".repeat(12) }));
  expect(emoji.status).toBe(200);
});

it("跨扫码命令不能复用建房操作标识，同键以规范文本判断内容", async () => {
  const { config } = await fixture();
  const cookie = await signUp(config, "keys@example.com");
  const qrKey = v7();
  const started = await request(config, "/api/netease/qr-flows", cookie, { idempotencyKey: qrKey });
  const flowId = (await started.json()).id as string;
  await request(config, `/api/netease/qr-flows/${flowId}/check`, cookie, {});
  const authorizationId = (await (await request(config, `/api/netease/qr-flows/${flowId}/confirm`, cookie, { idempotencyKey: v7() })).json()).binding.id as string;
  const conflict = await request(config, "/api/rooms", cookie, command(authorizationId, { idempotencyKey: qrKey }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  const input = command(authorizationId, { name: " e\u0301 " });
  const created = await (await request(config, "/api/rooms", cookie, input)).json();
  expect(await (await request(config, "/api/rooms", cookie, { ...input, idempotencyKey: input.idempotencyKey.toUpperCase(), name: "é" })).json()).toEqual(created);
  const used = await request(config, `/api/netease/qr-flows/${flowId}/confirm`, cookie, { idempotencyKey: input.idempotencyKey });
  expect(used.status).toBe(409);
  expect(await used.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
});

it("操作键二十四小时到期及未来键拒绝，已有房间不会被重放创建", async () => {
  let now = Date.now();
  const { config } = await fixture(() => now);
  const cookie = await signUp(config, "expired-key@example.com");
  const authorizationId = await bind(config, cookie);
  const input = command(authorizationId);
  expect((await request(config, "/api/rooms", cookie, { ...input, idempotencyKey: v7({ msecs: now + 60_001 }) })).status).toBe(409);
  expect((await request(config, "/api/rooms", cookie, input)).status).toBe(200);
  now = parseKeyTime(input.idempotencyKey) + 86_400_000;
  const expired = await request(config, "/api/rooms", cookie, input);
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_EXPIRED" } });
  expect((await (await request(config, "/api/rooms", cookie)).json()).rooms).toHaveLength(1);
});
function parseKeyTime(key: string): number {
  return Number.parseInt(key.replaceAll("-", "").slice(0, 12), 16);
}
