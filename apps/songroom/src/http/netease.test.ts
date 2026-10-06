import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "./app.js";
import type { AppConfig } from "../config.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter, Operation } from "../netease/protocol.js";

class ScriptedAdapter implements NeteaseAdapter {
  identity = { accountId: "000123", name: "真实网易云称呼" };
  status: "waiting" | "scanned" | "expired" | "authorized" = "authorized";
  inputs: AdapterInput[] = [];
  beforeCall?: (input: AdapterInput) => Promise<void>;
  error?: Extract<AdapterResult, { ok: false }>["error"];
  async assertVendorIntegrity() {}
  async dispose() {}
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);
    await this.beforeCall?.(input);
    if (this.error) return { ok: false, error: this.error };
    const data: Partial<Record<Operation, unknown>> = {
      qrKey: { key: "private-qr-key" },
      qrCreate: { url: "https://music.163.com/login?code=private-qr-key", image: "data:image/png;base64,cXItc2VjcmV0" },
      qrCheck: this.status === "authorized" ? { status: "authorized", cookie: "MUSIC_U=private-cookie" } : { status: this.status },
      identity: this.identity
    };
    return { ok: true, data: data[input.operation] } as AdapterResult<I["operation"]>;
  }
}

const roots: string[] = [];
const apps: SongRoomApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(adapter = new ScriptedAdapter(), now = () => Date.now()): Promise<{ app: SongRoomApp; config: AppConfig; adapter: ScriptedAdapter }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-binding-"));
  roots.push(root);
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const config: AppConfig = { nodeEnv: "test", host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, dbPath, staticRoot, authSecret: "test-secret-with-at-least-32-characters", credentialKeyPath };
  const app = await createApp(config, { neteaseAdapter: adapter, now });
  apps.push(app);
  await app.listen();
  return { app, config, adapter };
}

async function request(config: AppConfig, url: string, cookie?: string, body?: unknown): Promise<Response> {
  return fetch(config.baseUrl + url, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: config.baseUrl, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function signUp(config: AppConfig, email: string): Promise<string> {
  const response = await request(config, "/api/auth/sign-up/email", undefined, { name: "扫码测试", email, password: "correct horse battery staple" });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

it("未登录不能读取绑定，登录账号只查看自己的授权状态", async () => {
  const { config } = await fixture();
  expect((await request(config, "/api/netease/binding")).status).toBe(401);
  const cookie = await signUp(config, "binding@example.com");
  const response = await request(config, "/api/netease/binding", cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ binding: null, allowedActions: ["startQr"] });
});

async function startFlow(config: AppConfig, cookie: string, key = v7()): Promise<Response> {
  return request(config, "/api/netease/qr-flows", cookie, { idempotencyKey: key });
}

async function scan(config: AppConfig, cookie: string): Promise<string> {
  const started = await startFlow(config, cookie);
  expect(started.status).toBe(200);
  const flow = await started.json() as { id: string; qrImage: string; status: string };
  expect(flow.status).toBe("waiting");
  expect(flow.qrImage).toMatch(/^data:image\/png;base64,/);
  const checked = await request(config, `/api/netease/qr-flows/${flow.id}/check`, cookie, {});
  expect(checked.status).toBe(200);
  expect(await checked.json()).toMatchObject({ status: "awaitingConfirmation", identity: { accountId: "000123", nickname: "真实网易云称呼" }, qrImage: null });
  return flow.id;
}

it("扫码后服务端核实真实身份，只有最终确认才持久绑定且凭据不返回浏览器", async () => {
  const { app, config, adapter } = await fixture();
  const cookie = await signUp(config, "success@example.com");
  const flowId = await scan(config, cookie);
  expect(await (await request(config, "/api/netease/binding", cookie)).json()).toMatchObject({ binding: null });
  const confirmed = await request(config, `/api/netease/qr-flows/${flowId}/confirm`, cookie, { idempotencyKey: v7() });
  expect(confirmed.status).toBe(200);
  const body = await confirmed.text();
  expect(body).not.toMatch(/private-cookie|private-qr-key|credentials|generation/);
  expect(JSON.parse(body)).toMatchObject({ binding: { identity: { accountId: "000123", nickname: "真实网易云称呼" }, status: "active" }, allowedActions: [] });
  expect(adapter.inputs.filter(input => input.operation === "identity")).toEqual([
    expect.objectContaining({ operation: "identity", cookie: "MUSIC_U=private-cookie" }),
    expect.objectContaining({ operation: "identity", cookie: "MUSIC_U=private-cookie", expectedAccountId: "000123" })
  ]);
  expect(new Set(adapter.inputs.map(input => input.deviceId)).size).toBe(1);
  expect(adapter.inputs[0]?.deviceId).toMatch(/^[A-F0-9]{52}$/);
  await app.close();
  const restarted = await createApp(config, { neteaseAdapter: adapter }); apps.push(restarted); await restarted.listen();
  expect(await (await request(config, "/api/netease/binding", cookie)).json()).toEqual(JSON.parse(body));
});

it("替代扫码立即撤销旧流程，跨账号与同账号另一设备都不能读取、检查或完成", async () => {
  const { config } = await fixture();
  const cookie = await signUp(config, "owner@example.com");
  const other = await signUp(config, "other@example.com");
  const login = await request(config, "/api/auth/sign-in/email", undefined, { email: "owner@example.com", password: "correct horse battery staple" });
  const anotherDevice = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const first = await scan(config, cookie);
  for (const foreignCookie of [other, anotherDevice]) {
    expect((await request(config, `/api/netease/qr-flows/${first}`, foreignCookie)).status).toBe(404);
    expect((await request(config, `/api/netease/qr-flows/${first}/check`, foreignCookie, {})).status).toBe(404);
    expect((await request(config, `/api/netease/qr-flows/${first}/confirm`, foreignCookie, { idempotencyKey: v7() })).status).toBe(404);
  }
  const next = await startFlow(config, cookie);
  expect(next.status).toBe(200);
  expect((await request(config, `/api/netease/qr-flows/${first}`, cookie)).status).toBe(404);
  expect((await request(config, `/api/netease/qr-flows/${first}/confirm`, cookie, { idempotencyKey: v7() })).status).toBe(404);
  const nextId = (await next.json()).id as string;
  expect((await request(config, `/api/netease/qr-flows/${nextId}`, cookie)).status).toBe(200);
});

it("五分钟过期后不能完成，发起会话退出后也不能读取或完成", async () => {
  let now = Date.now();
  const { config } = await fixture(new ScriptedAdapter(), () => now);
  const cookie = await signUp(config, "expiry@example.com");
  const id = await scan(config, cookie);
  now += 5 * 60_000;
  const expired = await request(config, `/api/netease/qr-flows/${id}/confirm`, cookie, { idempotencyKey: v7() });
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({ error: { code: "QR_FLOW_EXPIRED" } });
  now = Date.now();
  const newId = await scan(config, cookie);
  expect((await request(config, "/api/auth/sign-out", cookie, {})).status).toBe(200);
  expect((await request(config, `/api/netease/qr-flows/${newId}`, cookie)).status).toBe(401);
  expect((await request(config, `/api/netease/qr-flows/${newId}/confirm`, cookie, { idempotencyKey: v7() })).status).toBe(401);
});

it("浏览器不能声明真实账号、凭据或代次；本地查询不会访问上游", async () => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, "forged@example.com");
  expect((await request(config, "/api/netease/qr-flows", cookie, { idempotencyKey: v7(), accountId: "forged" })).status).toBe(400);
  const id = await scan(config, cookie);
  const beforeReads = adapter.inputs.length;
  await request(config, `/api/netease/qr-flows/${id}`, cookie);
  await request(config, "/api/netease/binding", cookie);
  expect(adapter.inputs.length).toBe(beforeReads);
  for (const extra of [{ accountId: "forged" }, { cookie: "MUSIC_U=forged" }, { generation: 100 }, { operation: "playlistDelete" }]) {
    const response = await request(config, `/api/netease/qr-flows/${id}/confirm`, cookie, { idempotencyKey: v7(), ...extra });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("forged");
  }
  expect(await (await request(config, "/api/netease/binding", cookie)).json()).toMatchObject({ binding: null });
});

it("同一真实网易云账号的并发确认只绑定一个点歌台账号，完成流程不能再次使用", async () => {
  const { config } = await fixture();
  const first = await signUp(config, "race-one@example.com");
  const second = await signUp(config, "race-two@example.com");
  const ids = await Promise.all([scan(config, first), scan(config, second)]);
  const keys = [v7(), v7()];
  const confirmed = await Promise.all([first, second].map((cookie, index) => request(config, `/api/netease/qr-flows/${ids[index]}/confirm`, cookie, { idempotencyKey: keys[index] })));
  expect(confirmed.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = confirmed.findIndex(response => response.status === 200);
  const loser = 1 - winner;
  expect(await confirmed[loser]!.json()).toMatchObject({ error: { code: "NETEASE_ACCOUNT_OWNED" } });
  const winnerCookie = [first, second][winner]!;
  const replay = await request(config, `/api/netease/qr-flows/${ids[winner]}/confirm`, winnerCookie, { idempotencyKey: keys[winner] });
  expect(replay.status).toBe(200);
  const repeated = await request(config, `/api/netease/qr-flows/${ids[winner]}/confirm`, winnerCookie, { idempotencyKey: v7() });
  expect(repeated.status).toBe(409);
  expect(await repeated.json()).toMatchObject({ error: { code: "QR_FLOW_USED" } });
});

it("已绑定用户不能再次发起扫码，原绑定保持不变且不暴露授权变更动作", async () => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, "original@example.com");
  const id = await scan(config, cookie);
  const original = await request(config, `/api/netease/qr-flows/${id}/confirm`, cookie, { idempotencyKey: v7() });
  const originalView = await original.json();
  adapter.identity = { accountId: "another-account", name: "另一个真实账号" };
  const repeated = await startFlow(config, cookie);
  expect(repeated.status).toBe(409);
  expect(await repeated.json()).toMatchObject({ error: { code: "NETEASE_ALREADY_BOUND" } });
  expect(await (await request(config, "/api/netease/binding", cookie)).json()).toEqual(originalView);
});

it("原会话退出后的在途确认被拒绝，也不能撤销另一有效会话新发起的流程", async () => {
  const { config, adapter } = await fixture();
  const firstCookie = await signUp(config, "late-session@example.com");
  const id = await scan(config, firstCookie);
  let reachedCall!: () => void;
  let releaseCall!: () => void;
  const reached = new Promise<void>(resolve => { reachedCall = resolve; });
  const release = new Promise<void>(resolve => { releaseCall = resolve; });
  adapter.beforeCall = async input => {
    if (input.operation === "identity" && input.expectedAccountId) {
      reachedCall();
      await release;
    }
  };
  const pending = request(config, `/api/netease/qr-flows/${id}/confirm`, firstCookie, { idempotencyKey: v7() });
  await reached;
  await request(config, "/api/auth/sign-out", firstCookie, {});
  const login = await request(config, "/api/auth/sign-in/email", undefined, { email: "late-session@example.com", password: "correct horse battery staple" });
  const secondCookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const secondFlow = await (await startFlow(config, secondCookie)).json() as { id: string };
  releaseCall();
  expect((await pending).status).toBe(401);
  expect((await request(config, `/api/netease/qr-flows/${secondFlow.id}`, secondCookie)).status).toBe(200);
  expect(await (await request(config, "/api/netease/binding", secondCookie)).json()).toMatchObject({ binding: null });
});

it("操作标识按点歌台账号定域，不能跨扫码命令或流程复用", async () => {
  const { config } = await fixture();
  const cookie = await signUp(config, "idempotency@example.com");
  const key = v7();
  const flow = await (await startFlow(config, cookie, key)).json() as { id: string };
  const replay = await (await startFlow(config, cookie, key)).json() as { id: string };
  expect(replay.id).toBe(flow.id);
  await request(config, `/api/netease/qr-flows/${flow.id}/check`, cookie, {});
  const conflicting = await request(config, `/api/netease/qr-flows/${flow.id}/confirm`, cookie, { idempotencyKey: key });
  expect(conflicting.status).toBe(409);
  expect(await conflicting.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
});

it("重启丢弃临时二维码，但不会把已用操作标识重新执行", async () => {
  const { app, config, adapter } = await fixture();
  const cookie = await signUp(config, "restart-flow@example.com");
  const key = v7();
  const first = await startFlow(config, cookie, key);
  expect(first.status).toBe(200);
  await app.close();
  const restarted = await createApp(config, { neteaseAdapter: adapter }); apps.push(restarted); await restarted.listen();
  const before = adapter.inputs.length;
  const replay = await startFlow(config, cookie, key);
  expect(replay.status).toBe(404);
  expect(adapter.inputs.length).toBe(before);
  expect((await startFlow(config, cookie)).status).toBe(200);
});

it("允许的小幅未来操作标识在自己的24小时有效期内仍不会重放", async () => {
  let now = Date.now();
  const { config, adapter } = await fixture(new ScriptedAdapter(), () => now);
  const cookie = await signUp(config, "future-key@example.com");
  const key = v7({ msecs: now + 60_000 });
  expect((await startFlow(config, cookie, key)).status).toBe(200);
  now += 86_400_000 + 30_000;
  const before = adapter.inputs.length;
  expect((await startFlow(config, cookie, key)).status).toBe(409);
  expect(adapter.inputs.length).toBe(before);
  now += 30_000;
  const expired = await startFlow(config, cookie, key);
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_EXPIRED" } });
});

it("替换凭据主密钥后启动明确失败，原绑定不能被静默忽略", async () => {
  const { app, config, adapter } = await fixture();
  const cookie = await signUp(config, "lost-key@example.com");
  const id = await scan(config, cookie);
  expect((await request(config, `/api/netease/qr-flows/${id}/confirm`, cookie, { idempotencyKey: v7() })).status).toBe(200);
  await app.close();
  await fs.writeFile(config.credentialKeyPath, Buffer.alloc(32, 2));
  await expect(createApp(config, { neteaseAdapter: adapter })).rejects.toThrow("凭据无法解密");
});

it("扫码检查区分等待、已扫码及上游过期状态", async () => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, "qr-status@example.com");
  const flow = await (await startFlow(config, cookie)).json() as { id: string };
  for (const status of ["waiting", "scanned"] as const) {
    adapter.status = status;
    expect(await (await request(config, `/api/netease/qr-flows/${flow.id}/check`, cookie, {})).json()).toMatchObject({ status, identity: null, allowedActions: ["check"] });
  }
  adapter.status = "expired";
  const expired = await request(config, `/api/netease/qr-flows/${flow.id}/check`, cookie, {});
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({ error: { code: "QR_FLOW_EXPIRED" } });
  expect((await request(config, `/api/netease/qr-flows/${flow.id}`, cookie)).status).toBe(404);
});

it("最终身份变化拒绝提交，也不接受未经核实的候选凭据", async () => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, "identity-changed@example.com");
  const id = await scan(config, cookie);
  adapter.identity = { accountId: "different-account", name: "变化后的身份" };
  const response = await request(config, `/api/netease/qr-flows/${id}/confirm`, cookie, { idempotencyKey: v7() });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "ACCOUNT_MISMATCH" } });
  expect(await (await request(config, "/api/netease/binding", cookie)).json()).toMatchObject({ binding: null });
});

it.each(["ACCOUNT_EMPTY", "AUTH_UNAVAILABLE", "TARGET_PERMISSION", "RATE_LIMITED", "NETWORK_ERROR", "MODULE_ERROR", "DEADLINE", "PROCESS_ERROR", "PARSE_ERROR"] as const)("上游 %s 保留稳定分类且不绑定", async code => {
  const { config, adapter } = await fixture();
  const cookie = await signUp(config, `${code.toLowerCase()}@example.com`);
  const flow = await (await startFlow(config, cookie)).json() as { id: string };
  adapter.error = { code, outcome: "failed" };
  const response = await request(config, `/api/netease/qr-flows/${flow.id}/check`, cookie, {});
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { code } });
  expect(await (await request(config, "/api/netease/binding", cookie)).json()).toMatchObject({ binding: null });
});
