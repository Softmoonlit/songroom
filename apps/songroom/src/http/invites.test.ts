import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fork } from "node:child_process";
import { once } from "node:events";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "./app.js";
import type { AppConfig } from "../config.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { inviteView, joinApplicationView, type JoinApplicationView } from "../shared/invite-contracts.js";
import { user, roomMembership } from "../db/schema.js";
import { eq } from "drizzle-orm";

const roots: string[] = [];
const apps: SongRoomApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(now = () => Date.now()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-invites-")); roots.push(root);
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
  const response = await request(config, "/api/auth/sign-up/email", undefined, { name: "邀请测试账号", email, password: "correct horse battery staple" });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}
async function createRoom(config: AppConfig, owner: string, authorizationId?: string) {
  if (!authorizationId) {
    const started = await request(config, "/api/netease/qr-flows", owner, { idempotencyKey: v7() });
    const { id } = await started.json();
    await request(config, `/api/netease/qr-flows/${id}/check`, owner, {});
    authorizationId = (await (await request(config, `/api/netease/qr-flows/${id}/confirm`, owner, { idempotencyKey: v7() })).json()).binding.id;
  }
  const response = await request(config, "/api/rooms", owner, { idempotencyKey: v7(), authorizationId, name: "受邀宿舍", nickname: "房主" });
  expect(response.status).toBe(200);
  const { id } = await response.json() as { id: string };
  const inviteResponse = await request(config, `/api/rooms/${id}/invite`, owner);
  expect(inviteResponse.status).toBe(200);
  const invitation = inviteView.parse(await inviteResponse.json());
  return { id, invitation, authorizationId: authorizationId! };
}
async function apply(config: AppConfig, cookie: string, code: string, nickname = "新室友", idempotencyKey = v7()) {
  return request(config, "/api/join-applications", cookie, { code, nickname, idempotencyKey });
}
async function application(response: Response): Promise<JoinApplicationView> {
  expect(response.status).toBe(200);
  return joinApplicationView.parse(await response.json());
}
async function expectCode(response: Response, code: string, status = 409) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

it("邀请只供当前房主读取，受邀者只能获知房间名称并创建待处理申请", async () => {
  const { config, adapter } = await fixture();
  const owner = await signUp(config, "owner@example.com");
  const applicant = await signUp(config, "applicant@example.com");
  const { id, invitation } = await createRoom(config, owner);
  expect(invitation).toMatchObject({ code: expect.stringMatching(/^[A-Za-z0-9_-]{10}$/), generation: 1, version: 1, pendingCount: 0 });
  const before = adapter.inputs.length;
  expect((await request(config, `/api/rooms/${id}/invite`)).status).toBe(401);
  expect((await request(config, `/api/rooms/${id}/invite`, applicant)).status).toBe(404);
  const inspected = await request(config, "/api/invites/inspect", applicant, { code: invitation.code });
  expect(inspected.status).toBe(200);
  expect(await inspected.json()).toEqual({ room: { id, name: "受邀宿舍" }, application: null, isMember: false });
  const created = await application(await apply(config, applicant, invitation.code));
  expect(created).toMatchObject({ room: { id, name: "受邀宿舍" }, nickname: "新室友", status: "pending" });
  expect(await (await request(config, "/api/rooms", applicant)).json()).toEqual({ rooms: [], allowedActions: ["openCreateRoom", "openJoin"], disabledReasons: {} });
  for (const suffix of ["", "/members", "/invite"]) expect((await request(config, `/api/rooms/${id}${suffix}`, applicant)).status).toBe(404);
  expect(await (await request(config, "/api/join-applications", applicant)).json()).toEqual({ applications: [created] });
  expect(adapter.inputs.length).toBe(before);
});

it("同键规范内容返回原申请，另一键或不同内容冲突，多人同昵称仍可申请", async () => {
  const { config } = await fixture();
  const owner = await signUp(config, "idempotent-owner@example.com");
  const applicant = await signUp(config, "idempotent-applicant@example.com");
  const other = await signUp(config, "same-nickname@example.com");
  const { id, invitation } = await createRoom(config, owner);
  const key = v7();
  const parallel = await Promise.all(Array.from({ length: 4 }, () => apply(config, applicant, invitation.code, " e\u0301 ", key)));
  const originals = await Promise.all(parallel.map(application));
  expect(originals.every(value => value.id === originals[0]!.id)).toBe(true);
  expect(originals[0]).toMatchObject({ nickname: "é", status: "pending" });
  expect(await application(await apply(config, applicant, invitation.code, "é", key.toUpperCase()))).toEqual(originals[0]);
  await expectCode(await apply(config, applicant, invitation.code, "另一个昵称", key), "IDEMPOTENCY_CONFLICT");
  await expectCode(await apply(config, applicant, invitation.code), "APPLICATION_PENDING");
  await expectCode(await apply(config, owner, invitation.code), "ALREADY_MEMBER");
  expect(await application(await apply(config, other, invitation.code, "é"))).toMatchObject({ nickname: "é", status: "pending" });
  expect(await (await request(config, `/api/rooms/${id}/invite`, owner)).json()).toMatchObject({ pendingCount: 2, version: 3 });
  const login = await request(config, "/api/auth/sign-in/email", undefined, { email: "idempotent-applicant@example.com", password: "correct horse battery staple" });
  const device = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  expect(await application(await apply(config, device, invitation.code, "é", key))).toEqual({ ...originals[0], version: 3 });
  expect(await (await request(config, "/api/join-applications", device)).json()).toEqual({ applications: [{ ...originals[0], version: 3 }] });
});

it("仅申请人可读取和撤回自己的申请，撤回释放容量且旧操作不能恢复它", async () => {
  const { config, adapter } = await fixture();
  const owner = await signUp(config, "withdraw-owner@example.com");
  const applicant = await signUp(config, "withdraw-applicant@example.com");
  const other = await signUp(config, "withdraw-other@example.com");
  const { id, invitation } = await createRoom(config, owner);
  const key = v7();
  const created = await application(await apply(config, applicant, invitation.code, "新室友", key));
  const before = adapter.inputs.length;
  for (const cookie of [owner, other]) {
    await expectCode(await request(config, `/api/join-applications/${created.id}`, cookie), "APPLICATION_UNAVAILABLE", 404);
    await expectCode(await request(config, `/api/join-applications/${created.id}/withdraw`, cookie, { idempotencyKey: v7() }), "APPLICATION_UNAVAILABLE", 404);
  }
  const withdraw = { idempotencyKey: v7() };
  const withdrawn = await application(await request(config, `/api/join-applications/${created.id}/withdraw`, applicant, withdraw));
  expect(withdrawn).toMatchObject({ id: created.id, status: "withdrawn", allowedActions: [] });
  expect(await application(await request(config, `/api/join-applications/${created.id}/withdraw`, applicant, withdraw))).toEqual(withdrawn);
  expect(await application(await apply(config, applicant, invitation.code, "新室友", key))).toEqual(withdrawn);
  expect(await (await request(config, "/api/join-applications", applicant)).json()).toEqual({ applications: [] });
  expect(await (await request(config, `/api/rooms/${id}/invite`, owner)).json()).toMatchObject({ pendingCount: 0, version: 3 });
  const next = await application(await apply(config, applicant, invitation.code));
  expect(next.id).not.toBe(created.id);
  expect(next.status).toBe("pending");
  expect((await request(config, `/api/rooms/${id}`, applicant)).status).toBe(404);
  expect(adapter.inputs.length).toBe(before);
});

it("邀请重置要求当前聚合版本，原子取消旧代申请，旧码失效且成员保留", async () => {
  const { app, config, adapter } = await fixture();
  const owner = await signUp(config, "reset-owner@example.com");
  const applicant = await signUp(config, "reset-applicant@example.com");
  const { id, invitation } = await createRoom(config, owner);
  const originalMembers = await (await request(config, `/api/rooms/${id}/members`, owner)).json();
  const applyKey = v7();
  const first = await application(await apply(config, applicant, invitation.code, "新室友", applyKey));
  await expectCode(await request(config, `/api/rooms/${id}/invite/reset`, applicant, { idempotencyKey: v7(), version: 2 }), "INVITE_FORBIDDEN", 404);
  await expectCode(await request(config, `/api/rooms/${id}/invite/reset`, owner, { idempotencyKey: v7(), version: invitation.version }), "INVITE_VERSION_CONFLICT");
  const current = inviteView.parse(await (await request(config, `/api/rooms/${id}/invite`, owner)).json());
  expect(current).toMatchObject({ pendingCount: 1, version: 2, generation: 1 });
  const command = { idempotencyKey: v7(), version: current.version };
  const parallel = await Promise.all([request(config, `/api/rooms/${id}/invite/reset`, owner, command), request(config, `/api/rooms/${id}/invite/reset`, owner, command)]);
  expect(parallel.map(response => response.status)).toEqual([200, 200]);
  const reset = inviteView.parse(await parallel[0]!.json());
  expect(await parallel[1]!.json()).toEqual(reset);
  expect(reset).toMatchObject({ pendingCount: 0, version: 3, generation: 2 });
  expect(reset.code).not.toBe(invitation.code);
  expect(await (await request(config, `/api/join-applications/${first.id}`, applicant)).json()).toMatchObject({ status: "cancelled", allowedActions: [] });
  expect(await (await request(config, "/api/join-applications", applicant)).json()).toEqual({ applications: [] });
  await expectCode(await request(config, "/api/invites/inspect", applicant, { code: invitation.code }), "INVITE_RESET");
  await expectCode(await apply(config, applicant, invitation.code), "INVITE_RESET");
  await expectCode(await apply(config, applicant, invitation.code, "新室友", applyKey), "INVITE_RESET");
  expect(await (await request(config, `/api/rooms/${id}/members`, owner)).json()).toEqual({ ...originalMembers, version: reset.version });
  const next = await application(await apply(config, applicant, reset.code));
  expect(next.id).not.toBe(first.id);
  expect(next.status).toBe("pending");
  await app.close();
  const restarted = await createApp(config, { neteaseAdapter: adapter }); apps.push(restarted); await restarted.listen();
  await expectCode(await apply(config, applicant, invitation.code), "INVITE_RESET");
  expect(await (await request(config, `/api/join-applications/${next.id}`, applicant)).json()).toEqual(next);
  expect(await (await request(config, `/api/rooms/${id}/invite`, owner)).json()).toMatchObject({ code: reset.code, generation: 2, pendingCount: 1 });
});

it("每账号最多三份待处理申请，多设备并发不能超限，撤回后可补交", async () => {
  const { config } = await fixture();
  const owner = await signUp(config, "account-capacity-owner@example.com");
  const otherOwner = await signUp(config, "account-capacity-owner2@example.com");
  const first = await createRoom(config, owner);
  const rooms = [first, await createRoom(config, owner, first.authorizationId), await createRoom(config, owner, first.authorizationId), await createRoom(config, otherOwner)];
  const applicant = await signUp(config, "account-capacity-applicant@example.com");
  const login = await request(config, "/api/auth/sign-in/email", undefined, { email: "account-capacity-applicant@example.com", password: "correct horse battery staple" });
  const device = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const concurrent = await Promise.all(rooms.map((value, index) => apply(config, index % 2 ? device : applicant, value.invitation.code)));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 200, 200, 409]);
  const rejectedIndex = concurrent.findIndex(response => response.status === 409);
  await expectCode(concurrent[rejectedIndex]!, "ACCOUNT_APPLICATION_LIMIT");
  const accepted = await Promise.all(concurrent.filter(response => response.status === 200).map(application));
  expect((await (await request(config, "/api/join-applications", device)).json()).applications).toHaveLength(3);
  await application(await request(config, `/api/join-applications/${accepted[0]!.id}/withdraw`, applicant, { idempotencyKey: v7() }));
  expect(await application(await apply(config, device, rooms[rejectedIndex]!.invitation.code))).toMatchObject({ status: "pending" });
  expect((await (await request(config, "/api/join-applications", applicant)).json()).applications).toHaveLength(3);
});

it("每房间最多十份待处理申请，并发不挤出既有申请，撤回与重置均释放容量", async () => {
  const { config } = await fixture();
  const owner = await signUp(config, "room-capacity-owner@example.com");
  const { id, invitation } = await createRoom(config, owner);
  const applicants = [];
  for (let index = 0; index < 12; index++) applicants.push(await signUp(config, `room-capacity-${index}@example.com`));
  const concurrent = await Promise.all(applicants.map(cookie => apply(config, cookie, invitation.code, "相同昵称")));
  expect(concurrent.map(response => response.status).sort()).toEqual([...Array.from({ length: 10 }, () => 200), 409, 409]);
  const accepted = [];
  const rejected = [];
  for (const [index, response] of concurrent.entries()) {
    if (response.status === 200) accepted.push({ index, application: await application(response) });
    else { await expectCode(response, "ROOM_APPLICATION_LIMIT"); rejected.push(index); }
  }
  expect(await (await request(config, `/api/rooms/${id}/invite`, owner)).json()).toMatchObject({ pendingCount: 10, version: 11 });
  await application(await request(config, `/api/join-applications/${accepted[0]!.application.id}/withdraw`, applicants[accepted[0]!.index], { idempotencyKey: v7() }));
  await application(await apply(config, applicants[rejected[0]!]!, invitation.code));
  await expectCode(await apply(config, applicants[rejected[1]!]!, invitation.code), "ROOM_APPLICATION_LIMIT");
  for (const remaining of accepted.slice(1)) expect(await (await request(config, `/api/join-applications/${remaining.application.id}`, applicants[remaining.index])).json()).toEqual({ ...remaining.application, version: 13 });
  const latest = inviteView.parse(await (await request(config, `/api/rooms/${id}/invite`, owner)).json());
  const resetResponse = await request(config, `/api/rooms/${id}/invite/reset`, owner, { idempotencyKey: v7(), version: latest.version });
  expect(resetResponse.status).toBe(200);
  const reset = inviteView.parse(await resetResponse.json());
  expect(reset.pendingCount).toBe(0);
  expect(await application(await apply(config, applicants[rejected[1]!]!, reset.code))).toMatchObject({ status: "pending" });
});

it("不同操作键同账号同房间并发只建立一份申请，后续房间变化使重置旧确认失效", async () => {
  const { config } = await fixture();
  const owner = await signUp(config, "distinct-keys-owner@example.com");
  const applicant = await signUp(config, "distinct-keys-applicant@example.com");
  const { id, invitation } = await createRoom(config, owner);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => apply(config, applicant, invitation.code)));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 409, 409, 409, 409]);
  for (const response of concurrent.filter(response => response.status === 409)) await expectCode(response, "APPLICATION_PENDING");
  const created = await application(concurrent.find(response => response.status === 200)!);
  const confirmation = inviteView.parse(await (await request(config, `/api/rooms/${id}/invite`, owner)).json());
  await application(await request(config, `/api/join-applications/${created.id}/withdraw`, applicant, { idempotencyKey: v7() }));
  await expectCode(await request(config, `/api/rooms/${id}/invite/reset`, owner, { idempotencyKey: v7(), version: confirmation.version }), "INVITE_VERSION_CONFLICT");
  expect(await (await request(config, `/api/rooms/${id}/invite`, owner)).json()).toMatchObject({ pendingCount: 0, version: 3, code: invitation.code, generation: 1 });
});

it("邀请入口要求认证和严格格式，昵称按 Unicode 码点与 NFC 校验，不接受伪造归属", async () => {
  const { config } = await fixture();
  const owner = await signUp(config, "validation-owner@example.com");
  const applicant = await signUp(config, "validation-applicant@example.com");
  const { id, invitation } = await createRoom(config, owner);
  for (const [url, body] of [
    ["/api/invites/inspect", { code: invitation.code }],
    ["/api/join-applications", { idempotencyKey: v7(), code: invitation.code, nickname: "室友" }],
    ["/api/join-applications", undefined],
    [`/api/rooms/${id}/invite/reset`, { idempotencyKey: v7(), version: 1 }],
    [`/api/join-applications/${v7()}`, undefined],
    [`/api/join-applications/${v7()}/withdraw`, { idempotencyKey: v7() }]
  ] as const) expect((await request(config, url, undefined, body)).status).toBe(401);
  for (const code of ["", "123456789", "12345678901", "12345/7890", "一二三四五六七八九十"]) {
    expect((await request(config, "/api/invites/inspect", applicant, { code })).status).toBe(400);
    expect((await apply(config, applicant, code)).status).toBe(400);
  }
  await expectCode(await request(config, "/api/invites/inspect", applicant, { code: "invalid_-0" }), "INVITE_INVALID", 404);
  for (const nickname of [" ", "😀".repeat(13), "室友\u0000", "室\n友"]) expect((await apply(config, applicant, invitation.code, nickname)).status).toBe(400);
  for (const extra of [{ userId: "other" }, { roomId: id }, { status: "pending" }, { inviteGeneration: 1 }, { role: "owner" }]) {
    expect((await request(config, "/api/join-applications", applicant, { idempotencyKey: v7(), code: invitation.code, nickname: "室友", ...extra })).status).toBe(400);
  }
  expect(await application(await apply(config, applicant, invitation.code, "😀".repeat(12)))).toMatchObject({ nickname: "😀".repeat(12) });
  expect((await request(config, `/api/rooms/${id}/invite`, owner)).headers.get("cache-control")).toBe("no-store");
});

it("申请操作键过期与跨业务复用都被拒绝，原申请不会重复执行", async () => {
  let now = Date.now();
  const { config } = await fixture(() => now);
  const owner = await signUp(config, "expired-invite-owner@example.com");
  const applicant = await signUp(config, "expired-invite-applicant@example.com");
  const { invitation } = await createRoom(config, owner);
  const key = v7();
  const created = await application(await apply(config, applicant, invitation.code, "室友", key));
  await expectCode(await request(config, `/api/join-applications/${created.id}/withdraw`, applicant, { idempotencyKey: key }), "IDEMPOTENCY_CONFLICT");
  await expectCode(await apply(config, applicant, invitation.code, "室友", v7({ msecs: now + 60_001 })), "IDEMPOTENCY_KEY_EXPIRED");
  now = Number.parseInt(key.replaceAll("-", "").slice(0, 12), 16) + 86_400_000;
  await expectCode(await apply(config, applicant, invitation.code, "室友", key), "IDEMPOTENCY_KEY_EXPIRED");
  expect((await (await request(config, "/api/join-applications", applicant)).json()).applications).toHaveLength(1);
});

it("普通室友不能读取或重置邀请，非房主调用一律 404", async () => {
  const { config, app } = await fixture();
  const owner = await signUp(config, "owner-only@example.com");
  const roommate = await signUp(config, "roommate-only@example.com");
  const { id, invitation } = await createRoom(config, owner);

  // 模拟将该用户加入房间成为普通成员
  const roommateUser = app.database.select({ id: user.id }).from(user).where(eq(user.email, "roommate-only@example.com")).get()!;
  app.database.insert(roomMembership).values({
    id: v7(),
    roomId: id,
    userId: roommateUser.id,
    nickname: "室友"
  }).run();

  expect((await request(config, `/api/rooms/${id}/invite`, roommate)).status).toBe(404);
  const resetAttempt = await request(config, `/api/rooms/${id}/invite/reset`, roommate, { idempotencyKey: v7(), version: invitation.version });
  expect(resetAttempt.status).toBe(404);
});

it("fragment 邀请不进入实际请求 URL、Referer 或普通访问日志，手工码也只通过 POST 提交", { timeout: 15000 }, async () => {
  const { app, config } = await fixture();
  await app.close();
  const host = fork(new URL("../../tests/invites/logging-host.ts", import.meta.url), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = ""; let stderr = "";
  host.stdout!.setEncoding("utf8").on("data", value => { stdout += value; });
  host.stderr!.setEncoding("utf8").on("data", value => { stderr += value; });
  const observed: Array<{ url: string; referer: string | null }> = [];
  host.on("message", message => {
    if (typeof message === "object" && message && "url" in message) observed.push(message as { url: string; referer: string | null });
  });
  try {
    const ready = once(host, "message");
    host.send(config);
    expect((await ready)[0]).toEqual({ ready: true });
    const owner = await signUp(config, "logging-owner@example.com");
    const applicant = await signUp(config, "logging-applicant@example.com");
    const { id, invitation } = await createRoom(config, owner);
    expect((await fetch(`${config.baseUrl}/join#${invitation.code}`)).status).toBe(200);
    const inspect = await request(config, "/api/invites/inspect", applicant, { code: invitation.code });
    expect(inspect.status).toBe(200);
    await application(await apply(config, applicant, invitation.code));
    const latest = inviteView.parse(await (await request(config, `/api/rooms/${id}/invite`, owner)).json());
    const resetResponse = await request(config, `/api/rooms/${id}/invite/reset`, owner, { idempotencyKey: v7(), version: latest.version });
    expect(resetResponse.status).toBe(200);
    const reset = inviteView.parse(await resetResponse.json());
    await expectCode(await apply(config, applicant, invitation.code), "INVITE_RESET");
    const exited = once(host, "exit");
    host.kill("SIGTERM");
    await exited;
    expect(observed.some(value => value.url === "/join")).toBe(true);
    expect(JSON.stringify(observed)).not.toContain(invitation.code);
    expect(JSON.stringify(observed)).not.toContain(reset.code);
    expect(stdout).toContain('"route":"/api/rooms/:roomId/invite/reset"');
    for (const secret of [invitation.code, reset.code, "logging-owner@example.com", "logging-applicant@example.com", "correct horse battery staple", "MUSIC_U="]) {
      expect(stdout + stderr).not.toContain(secret);
    }
  } finally {
    if (host.exitCode === null) host.kill("SIGKILL");
  }
});
