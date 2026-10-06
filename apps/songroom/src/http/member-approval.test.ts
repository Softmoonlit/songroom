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
import { inviteView, joinApplicationView, type JoinApplicationView } from "../shared/invite-contracts.js";
import { user, room, roomMembership } from "../db/schema.js";

const roots: string[] = [];
const apps: SongRoomApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(now = () => Date.now()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-member-approval-")); roots.push(root);
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
async function decide(config: AppConfig, owner: string, roomId: string, applicationId: string, decision: "approve" | "reject" = "approve", idempotencyKey = v7()) {
  return request(config, `/api/rooms/${roomId}/applications/${applicationId}/decision`, owner, { idempotencyKey, decision });
}
async function members(config: AppConfig, cookie: string, roomId: string) {
  const response = await request(config, `/api/rooms/${roomId}/members`, cookie);
  expect(response.status).toBe(200);
  return (await response.json()).members as Array<{ id: string; nickname: string; role: string; isSelf: boolean }>;
}
async function setup() {
  const fixtureValue = await fixture();
  const owner = await signUp(fixtureValue.config, "owner@example.com");
  const applicant = await signUp(fixtureValue.config, "applicant@example.com");
  const createdRoom = await createRoom(fixtureValue.config, owner);
  const pending = await application(await apply(fixtureValue.config, applicant, createdRoom.invitation.code));
  return { ...fixtureValue, owner, applicant, ...createdRoom, pending };
}
async function admit(config: AppConfig, owner: string, target: { id: string; invitation: { code: string } }, cookie: string, nickname: string) {
  const pending = await application(await apply(config, cookie, target.invitation.code, nickname));
  const approved = await application(await decide(config, owner, target.id, pending.id));
  expect(approved.status).toBe("approved");
  return approved;
}
async function expectCode(response: Response, code: string, status = 409) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

it("房主基本批准后，申请人无需网易云绑定即可作为室友读取房间和成员", async () => {
  const { config, owner, applicant, id, pending } = await setup();
  const approved = await application(await decide(config, owner, id, pending.id));
  expect(approved).toMatchObject({ id: pending.id, nickname: "新室友", status: "approved", allowedActions: [] });
  expect(await (await request(config, `/api/join-applications/${pending.id}`, applicant)).json()).toEqual(approved);
  expect(await (await request(config, "/api/rooms", applicant)).json()).toEqual({ rooms: [{ id, name: "受邀宿舍", nickname: "新室友", role: "roommate" }] });
  expect(await (await request(config, `/api/rooms/${id}`, applicant)).json()).toMatchObject({ room: { id, role: "roommate", nickname: "新室友" }, pendingCount: null });
  expect(await members(config, applicant, id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: expect.any(String), nickname: "房主", role: "owner", isSelf: false }),
    expect.objectContaining({ id: expect.any(String), nickname: "新室友", role: "roommate", isSelf: true })
  ]));
});

it("待审批 read model 和房间壳返回角色动作、禁用原因和当前待处理数量", async () => {
  const { config, owner, applicant, id, pending } = await setup();
  const response = await request(config, `/api/rooms/${id}/applications`, owner);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ applications: [{ id: pending.id, nickname: "新室友", allowedActions: ["approveApplication", "rejectApplication"], disabledReasons: {} }], allowedActions: ["reviewApplications"], disabledReasons: {} });
  expect(await (await request(config, `/api/rooms/${id}`, owner)).json()).toMatchObject({ pendingCount: 1, allowedActions: expect.arrayContaining(["renameRoom", "renameNickname", "reviewApplications", "readInvite"]), disabledReasons: {} });
  await application(await decide(config, owner, id, pending.id, "reject"));
  expect(await (await request(config, `/api/rooms/${id}/applications`, owner)).json()).toEqual({ applications: [], allowedActions: ["reviewApplications"], disabledReasons: {} });
  expect(await (await request(config, `/api/rooms/${id}`, owner)).json()).toMatchObject({ pendingCount: 0 });
  expect((await request(config, `/api/rooms/${id}`, applicant)).status).toBe(404);
});

it("批准同键并发及规范键重放只产生一个成员，异内容与新键再审批被拒绝", async () => {
  const { config, owner, applicant, id, pending } = await setup();
  const key = v7();
  const results = await Promise.all(Array.from({ length: 4 }, () => decide(config, owner, id, pending.id, "approve", key)));
  const approved = await application(results[0]!);
  for (const result of results.slice(1)) expect(await application(result)).toEqual(approved);
  expect(await application(await decide(config, owner, id, pending.id, "approve", key.toUpperCase()))).toEqual(approved);
  await expectCode(await decide(config, owner, id, pending.id, "reject", key), "IDEMPOTENCY_CONFLICT");
  for (const decision of ["approve", "reject"] as const) await expectCode(await decide(config, owner, id, pending.id, decision), "APPLICATION_NOT_PENDING");
  expect(await members(config, applicant, id)).toHaveLength(2);
});

for (const decisions of [["approve", "approve"], ["approve", "reject"]] as const) {
  it(`不同键 ${decisions.join("/")} 竞态只允许一个终态且成员关系一致`, async () => {
    const { config, owner, applicant, id, pending } = await setup();
    const keys = [v7(), v7()];
    const results = await Promise.all(decisions.map((decision, index) => decide(config, owner, id, pending.id, decision, keys[index]!)));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    await expectCode(results.find(result => result.status === 409)!, "APPLICATION_NOT_PENDING");
    const winnerIndex = results.findIndex(result => result.status === 200);
    const winner = await application(results[winnerIndex]!);
    expect(winner.status).toBe(decisions[winnerIndex] === "approve" ? "approved" : "rejected");
    expect(await application(await decide(config, owner, id, pending.id, decisions[winnerIndex]!, keys[winnerIndex]!))).toEqual(winner);
    expect(await (await request(config, `/api/join-applications/${pending.id}`, applicant)).json()).toEqual(winner);
    expect(await members(config, owner, id)).toHaveLength(winner.status === "approved" ? 2 : 1);
  });
}

it("拒绝终结申请，同键重放并允许申请人重新提交", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  const key = v7();
  const rejected = await application(await decide(config, owner, id, pending.id, "reject", key));
  expect(rejected).toMatchObject({ status: "rejected", allowedActions: [] });
  expect(await application(await decide(config, owner, id, pending.id, "reject", key))).toEqual(rejected);
  await expectCode(await decide(config, owner, id, pending.id), "APPLICATION_NOT_PENDING");
  expect(await (await request(config, "/api/join-applications", applicant)).json()).toEqual({ applications: [] });
  const next = await application(await apply(config, applicant, invitation.code));
  expect(next.id).not.toBe(pending.id);
  expect(next.status).toBe("pending");
  expect(await members(config, owner, id)).toHaveLength(1);
});

for (const decision of ["approve", "reject"] as const) {
  it(`${decision} 与撤回竞态只产生一个终态，重放不会改变成员`, async () => {
    const { config, owner, applicant, id, pending } = await setup();
    const decisionKey = v7(); const withdrawalKey = v7();
    const results = await Promise.all([
      decide(config, owner, id, pending.id, decision, decisionKey),
      request(config, `/api/join-applications/${pending.id}/withdraw`, applicant, { idempotencyKey: withdrawalKey })
    ]);
    // 撤回可以在已终结资源上返回当前状态；审批的新命令必须拒绝非 pending。
    expect(results.every(response => [200, 409].includes(response.status))).toBe(true);
    const final = await application(await request(config, `/api/join-applications/${pending.id}`, applicant));
    expect([decision === "approve" ? "approved" : "rejected", "withdrawn"]).toContain(final.status);
    expect(await members(config, owner, id)).toHaveLength(final.status === "approved" ? 2 : 1);
    if (results[0]!.status === 200) expect(await application(await decide(config, owner, id, pending.id, decision, decisionKey))).toEqual(final);
    else await expectCode(results[0]!, "APPLICATION_NOT_PENDING");
    await expectCode(await decide(config, owner, id, pending.id), "APPLICATION_NOT_PENDING");
  });

  it(`${decision} 与邀请重置竞态校验聚合版本和邀请代次`, async () => {
    const { config, owner, applicant, id, pending } = await setup();
    const invitation = inviteView.parse(await (await request(config, `/api/rooms/${id}/invite`, owner)).json());
    const key = v7();
    const results = await Promise.all([
      decide(config, owner, id, pending.id, decision, key),
      request(config, `/api/rooms/${id}/invite/reset`, owner, { idempotencyKey: v7(), version: invitation.version })
    ]);
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    const final = await application(await request(config, `/api/join-applications/${pending.id}`, applicant));
    if (results[0]!.status === 200) {
      expect(final.status).toBe(decision === "approve" ? "approved" : "rejected");
      await expectCode(results[1]!, "INVITE_VERSION_CONFLICT");
      expect(await application(await decide(config, owner, id, pending.id, decision, key))).toEqual(final);
    } else {
      await expectCode(results[0]!, "APPLICATION_NOT_PENDING");
      expect(final.status).toBe("cancelled");
    }
    expect(await members(config, owner, id)).toHaveLength(final.status === "approved" ? 2 : 1);
    await expectCode(await decide(config, owner, id, pending.id), "APPLICATION_NOT_PENDING");
  });
}

it("重置邀请保留已批准成员，旧申请 cancelled 后不能批准", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  await application(await decide(config, owner, id, pending.id));
  const waiting = await signUp(config, "waiting@example.com");
  const second = await application(await apply(config, waiting, invitation.code, "等待"));
  const before = await members(config, owner, id);
  const current = inviteView.parse(await (await request(config, `/api/rooms/${id}/invite`, owner)).json());
  expect((await request(config, `/api/rooms/${id}/invite/reset`, owner, { idempotencyKey: v7(), version: current.version })).status).toBe(200);
  expect(await members(config, applicant, id)).toHaveLength(2);
  expect(await members(config, owner, id)).toEqual(before);
  expect(await application(await request(config, `/api/join-applications/${second.id}`, waiting))).toMatchObject({ status: "cancelled" });
  await expectCode(await decide(config, owner, id, second.id), "APPLICATION_NOT_PENDING");
});

it("同 NFC 昵称的两份申请并发批准仅一人入房，冲突终结并提示重交", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  await application(await request(config, `/api/join-applications/${pending.id}/withdraw`, applicant, { idempotencyKey: v7() }));
  const other = await signUp(config, "nfc-other@example.com");
  const candidates = [await application(await apply(config, applicant, invitation.code, " e\u0301 ")), await application(await apply(config, other, invitation.code, "é"))];
  const keys = [v7(), v7()];
  const decisions = await Promise.all(candidates.map((value, index) => decide(config, owner, id, value.id, "approve", keys[index]!)));
  const outcomes = await Promise.all(decisions.map(application));
  expect(outcomes.map(value => value.status).sort()).toEqual(["approved", "nickname_conflict"]);
  const conflictIndex = outcomes.findIndex(value => value.status === "nickname_conflict");
  const conflict = outcomes[conflictIndex]!;
  expect(conflict).toMatchObject({ nickname: "é", allowedActions: [] });
  expect(await application(await decide(config, owner, id, conflict.id, "approve", keys[conflictIndex]!))).toEqual(conflict);
  await expectCode(await decide(config, owner, id, conflict.id), "APPLICATION_NOT_PENDING");
  expect(await members(config, owner, id)).toHaveLength(2);
  const retry = await application(await apply(config, [applicant, other][conflictIndex]!, invitation.code, "重新选择"));
  expect(retry).toMatchObject({ status: "pending", nickname: "重新选择" });
  expect(retry.id).not.toBe(conflict.id);
});

it("改昵称与批准争用 NFC 昵称时仅一个成员占用", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  await application(await decide(config, owner, id, pending.id));
  const other = await signUp(config, "rename-race@example.com");
  const candidate = await application(await apply(config, other, invitation.code, "é"));
  const results = await Promise.all([
    request(config, `/api/rooms/${id}/nickname`, applicant, { idempotencyKey: v7(), nickname: " e\u0301 " }),
    decide(config, owner, id, candidate.id)
  ]);
  const outcome = await application(results[1]!);
  const current = await members(config, owner, id);
  expect(current.filter(value => value.nickname === "é")).toHaveLength(1);
  if (outcome.status === "approved") await expectCode(results[0]!, "NICKNAME_TAKEN");
  else { expect(outcome.status).toBe("nickname_conflict"); expect(results[0]!.status).toBe(200); }
});

it("成员容量包含房主：九名成员后并发批准只剩一个名额，拒绝仍可执行", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  await application(await decide(config, owner, id, pending.id));
  for (let index = 0; index < 7; index++) {
    const cookie = await signUp(config, `member-${index}@example.com`);
    await admit(config, owner, { id, invitation }, cookie, `成员${index}`);
  }
  expect(await members(config, owner, id)).toHaveLength(9);
  const candidates = [];
  for (let index = 0; index < 2; index++) {
    const cookie = await signUp(config, `last-member-${index}@example.com`);
    candidates.push({ cookie, pending: await application(await apply(config, cookie, invitation.code, `最后${index}`)) });
  }
  const outcomes = await Promise.all(candidates.map(value => decide(config, owner, id, value.pending.id)));
  expect(outcomes.map(value => value.status).sort()).toEqual([200, 409]);
  const blockedIndex = outcomes.findIndex(value => value.status === 409);
  await expectCode(outcomes[blockedIndex]!, "ROOM_MEMBER_LIMIT");
  expect(await members(config, applicant, id)).toHaveLength(10);
  expect(await application(await request(config, `/api/join-applications/${candidates[blockedIndex]!.pending.id}`, candidates[blockedIndex]!.cookie))).toMatchObject({ status: "pending" });
  const review = await request(config, `/api/rooms/${id}/applications`, owner);
  expect(review.status).toBe(200);
  expect(await review.json()).toEqual({ applications: [{ id: candidates[blockedIndex]!.pending.id, nickname: `最后${blockedIndex}`, allowedActions: ["rejectApplication"], disabledReasons: { approveApplication: "ROOM_MEMBER_LIMIT" } }], allowedActions: ["reviewApplications"], disabledReasons: {} });
  expect(await application(await decide(config, owner, id, candidates[blockedIndex]!.pending.id, "reject"))).toMatchObject({ status: "rejected" });
}, 30_000);

it("账号十个归属包含自建房，多个房主并发审批不能突破归属容量", async () => {
  const { config } = await fixture();
  const applicant = await signUp(config, "joined-limit@example.com");
  await createRoom(config, applicant);
  const targets: Array<{ owner: string; id: string; invitation: { code: string } }> = [];
  for (let ownerIndex = 0; ownerIndex < 4; ownerIndex++) {
    const owner = await signUp(config, `joined-owner-${ownerIndex}@example.com`);
    const first = await createRoom(config, owner);
    targets.push({ owner, ...first });
    for (let roomIndex = 1; roomIndex < (ownerIndex === 3 ? 1 : 3); roomIndex++) targets.push({ owner, ...await createRoom(config, owner, first.authorizationId) });
  }
  for (const target of targets.slice(0, 8)) await admit(config, target.owner, target, applicant, "跨房室友");
  expect((await (await request(config, "/api/rooms", applicant)).json()).rooms).toHaveLength(9);
  const waiting = [];
  for (const target of targets.slice(8)) waiting.push({ target, pending: await application(await apply(config, applicant, target.invitation.code, "跨房室友")) });
  expect(waiting).toHaveLength(2);
  const results = await Promise.all(waiting.map(value => decide(config, value.target.owner, value.target.id, value.pending.id)));
  expect(results.map(response => response.status).sort()).toEqual([200, 409]);
  const blockedIndex = results.findIndex(response => response.status === 409);
  await expectCode(results[blockedIndex]!, "JOINED_ROOM_LIMIT");
  expect((await (await request(config, "/api/rooms", applicant)).json()).rooms).toHaveLength(10);
  const blocked = waiting[blockedIndex]!;
  expect(await application(await request(config, `/api/join-applications/${blocked.pending.id}`, applicant))).toMatchObject({ status: "pending" });
  expect(await (await request(config, `/api/rooms/${blocked.target.id}/applications`, blocked.target.owner)).json()).toMatchObject({ applications: [{ id: blocked.pending.id, allowedActions: ["rejectApplication"], disabledReasons: { approveApplication: "JOINED_ROOM_LIMIT" } }] });
  expect(await application(await decide(config, blocked.target.owner, blocked.target.id, blocked.pending.id, "reject"))).toMatchObject({ status: "rejected" });
}, 30_000);

it("全站恰好一百账号二十房间不阻止已有身份在已有房间获批", async () => {
  const { app, config, owner, applicant, id, pending } = await setup();
  // 仅 seed 全站容量；申请和成员关系依然通过 HTTP 建立与观察。
  const now = new Date();
  const seedIds = Array.from({ length: 98 }, () => v7());
  app.database.insert(user).values(seedIds.map((userId, index) => ({ id: userId, email: `global-seed-${index}@example.com`, name: "容量账号", emailVerified: false, createdAt: now, updatedAt: now }))).run();
  for (let index = 0; index < 19; index++) {
    const roomId = v7(); const ownerUserId = seedIds[Math.floor(index / 3)]!;
    app.database.insert(room).values({ id: roomId, name: `容量房${index}`, ownerUserId }).run();
    app.database.insert(roomMembership).values({ id: v7(), roomId, userId: ownerUserId, nickname: "容量房主" }).run();
  }
  expect(await application(await decide(config, owner, id, pending.id))).toMatchObject({ status: "approved" });
  expect(await members(config, applicant, id)).toHaveLength(2);
  expect(await (await request(config, "/api/rooms", applicant)).json()).toMatchObject({ rooms: [{ id, role: "roommate" }] });
});

it("房主审批权限限定当前房间，室友、申请人和其他房主不能读取或执行", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  const roommate = await signUp(config, "role-roommate@example.com");
  await admit(config, owner, { id, invitation }, roommate, "现有室友");
  const otherOwner = await signUp(config, "other-owner@example.com");
  const otherRoom = await createRoom(config, otherOwner);
  for (const cookie of [applicant, roommate, otherOwner]) {
    await expectCode(await request(config, `/api/rooms/${id}/applications`, cookie), "APPLICATION_FORBIDDEN", 404);
    await expectCode(await decide(config, cookie, id, pending.id), "APPLICATION_FORBIDDEN", 404);
    expect((await request(config, `/api/rooms/${id}/invite`, cookie)).status).toBe(404);
  }
  expect((await request(config, `/api/rooms/${otherRoom.id}/applications/${pending.id}/decision`, otherOwner, { idempotencyKey: v7(), decision: "approve" })).status).toBe(404);
  expect((await request(config, `/api/rooms/${v7()}/applications`, owner)).status).toBe(404);
  expect((await decide(config, owner, id, v7())).status).toBe(404);
  expect(await application(await request(config, `/api/join-applications/${pending.id}`, applicant))).toMatchObject({ status: "pending" });
  expect(await members(config, owner, id)).toHaveLength(2);
  const shell = await (await request(config, `/api/rooms/${id}`, roommate)).json();
  expect(shell).toMatchObject({ pendingCount: null, allowedActions: ["renameNickname"], disabledReasons: { renameRoom: expect.any(String), reviewApplications: expect.any(String), readInvite: expect.any(String) } });
  expect(shell).not.toHaveProperty("code");
  expect(shell).not.toHaveProperty("applications");
});

it("房主改房名、所有成员只改自己昵称，旧昵称释放且成员 id 保持", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  await application(await decide(config, owner, id, pending.id));
  const before = await members(config, applicant, id);
  const originalId = before.find(value => value.isSelf)!.id;
  const renameKey = v7();
  const renamed = await request(config, `/api/rooms/${id}/name`, owner, { idempotencyKey: renameKey, name: " 新房名 " });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ room: { id, name: "新房名", role: "owner" }, pendingCount: 0, disabledReasons: {} });
  expect((await request(config, `/api/rooms/${id}/name`, owner, { idempotencyKey: renameKey.toUpperCase(), name: "新房名" })).status).toBe(200);
  await expectCode(await request(config, `/api/rooms/${id}/name`, owner, { idempotencyKey: renameKey, name: "别的房名" }), "IDEMPOTENCY_CONFLICT");
  await expectCode(await request(config, `/api/rooms/${id}/name`, applicant, { idempotencyKey: v7(), name: "越权" }), "ROOM_OWNER_REQUIRED", 404);
  const key = v7();
  const nicknameResponse = await request(config, `/api/rooms/${id}/nickname`, applicant, { idempotencyKey: key, nickname: " e\u0301 " });
  expect(nicknameResponse.status).toBe(200);
  expect(await nicknameResponse.json()).toMatchObject({ room: { name: "新房名", nickname: "é", role: "roommate" }, pendingCount: null, allowedActions: ["renameNickname"], disabledReasons: { renameRoom: expect.any(String), reviewApplications: expect.any(String), readInvite: expect.any(String) } });
  expect((await request(config, `/api/rooms/${id}/nickname`, applicant, { idempotencyKey: key.toUpperCase(), nickname: "é" })).status).toBe(200);
  await expectCode(await request(config, `/api/rooms/${id}/nickname`, applicant, { idempotencyKey: key, nickname: "不同" }), "IDEMPOTENCY_CONFLICT");
  expect((await members(config, applicant, id)).find(value => value.isSelf)).toMatchObject({ id: originalId, nickname: "é" });
  expect((await request(config, `/api/rooms/${id}/nickname`, owner, { idempotencyKey: v7(), nickname: "新房主" })).status).toBe(200);
  const newcomer = await signUp(config, "released-nickname@example.com");
  await admit(config, owner, { id, invitation }, newcomer, "新室友");
  const newcomerId = (await members(config, newcomer, id)).find(value => value.isSelf)!.id;
  expect(newcomerId).not.toBe(originalId);
  const final = await members(config, applicant, id);
  expect(final.find(value => value.isSelf)).toMatchObject({ id: originalId, nickname: "é" });
  expect(final.find(value => value.role === "owner")).toMatchObject({ nickname: "新房主" });
  expect(await (await request(config, "/api/rooms", applicant)).json()).toMatchObject({ rooms: [{ id, name: "新房名", nickname: "é" }] });
});

it("两个成员并发改为相同 NFC 昵称只允许一个成功", async () => {
  const { config, owner, applicant, id, pending } = await setup();
  await application(await decide(config, owner, id, pending.id));
  const responses = await Promise.all([owner, applicant].map((cookie, index) => request(config, `/api/rooms/${id}/nickname`, cookie, { idempotencyKey: v7(), nickname: index ? "é" : " e\u0301 " })));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  await expectCode(responses.find(response => response.status === 409)!, "NICKNAME_TAKEN");
  expect((await members(config, owner, id)).filter(value => value.nickname === "é")).toHaveLength(1);
});

it("成员列表只暴露房间身份与当前动作，不泄漏账号或其他房间身份", async () => {
  const { config, owner, applicant, id, authorizationId, pending } = await setup();
  await application(await decide(config, owner, id, pending.id));
  const second = await createRoom(config, owner, authorizationId);
  await admit(config, owner, second, applicant, "另一房昵称");
  for (const cookie of [owner, applicant]) {
    const response = await request(config, `/api/rooms/${id}/members`, cookie);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.disabledReasons).toEqual(cookie === owner ? {} : { renameRoom: expect.any(String), reviewApplications: expect.any(String), readInvite: expect.any(String) });
    expect(view.allowedActions).toEqual(expect.any(Array));
    for (const member of view.members) {
      expect(Object.keys(member).sort()).toEqual(["allowedActions", "disabledReasons", "id", "isSelf", "nickname", "role"]);
      expect(member.allowedActions).toEqual(member.isSelf ? ["renameNickname"] : []);
      if (member.isSelf) expect(member.disabledReasons).toEqual({});
      else expect(member.disabledReasons).toEqual({ renameNickname: expect.any(String) });
    }
    expect(JSON.stringify(view)).not.toMatch(/example\.com|邀请测试账号|另一房昵称/);
    const shell = await (await request(config, `/api/rooms/${id}`, cookie)).json();
    expect(Object.keys(shell).sort()).toEqual(["allowedActions", "disabledReasons", "pendingCount", "room", "version"]);
    expect(Object.keys(shell.room).sort()).toEqual(["id", "name", "nickname", "role"]);
  }
  await expectCode(await request(config, `/api/rooms/${second.id}/name`, applicant, { idempotencyKey: v7(), name: "跨房越权" }), "ROOM_OWNER_REQUIRED", 404);
  expect((await request(config, `/api/rooms/${id}/nickname`, applicant, { idempotencyKey: v7(), nickname: "另一房昵称" })).status).toBe(200);
});

it("审批和身份命令要求认证、严格输入并拒绝伪造身份或归属", async () => {
  const { config, owner, applicant, id, pending } = await setup();
  const decisionUrl = `/api/rooms/${id}/applications/${pending.id}/decision`;
  const nameUrl = `/api/rooms/${id}/name`; const nicknameUrl = `/api/rooms/${id}/nickname`;
  for (const [url, body] of [
    [`/api/rooms/${id}/applications`, undefined],
    [decisionUrl, { idempotencyKey: v7(), decision: "approve" }],
    [nameUrl, { idempotencyKey: v7(), name: "新房名" }],
    [nicknameUrl, { idempotencyKey: v7(), nickname: "新昵称" }]
  ] as const) expect((await request(config, url, undefined, body)).status).toBe(401);
  for (const body of [{ decision: "approve" }, { idempotencyKey: v7(), decision: "approved" }, { idempotencyKey: "not-a-key", decision: "approve" }, { idempotencyKey: v7(), decision: true }]) {
    expect((await request(config, decisionUrl, owner, body)).status).toBe(400);
  }
  for (const extra of [{ userId: "forged" }, { memberId: v7() }, { roomId: v7() }, { applicationId: v7() }, { role: "owner" }, { nickname: "被改写" }, { status: "approved" }, { inviteGeneration: 99 }]) {
    expect((await request(config, decisionUrl, owner, { idempotencyKey: v7(), decision: "approve", ...extra })).status).toBe(400);
  }
  for (const extra of [{ userId: "forged" }, { memberId: v7() }, { roomId: v7() }, { role: "owner" }]) {
    expect((await request(config, nameUrl, owner, { idempotencyKey: v7(), name: "新房名", ...extra })).status).toBe(400);
    expect((await request(config, nicknameUrl, owner, { idempotencyKey: v7(), nickname: "新昵称", ...extra })).status).toBe(400);
  }
  for (const [url, property, max] of [[nameUrl, "name", 16], [nicknameUrl, "nickname", 12]] as const) {
    for (const value of [" ", "😀".repeat(max + 1), "名\u0000称", "名\n称", 123, null]) {
      expect((await request(config, url, owner, { idempotencyKey: v7(), [property]: value })).status).toBe(400);
    }
    expect((await request(config, url, owner, { [property]: "有效" })).status).toBe(400);
    const response = await request(config, url, owner, { idempotencyKey: v7(), [property]: "😀".repeat(max) });
    expect(response.status).toBe(200);
    expect((await response.json()).room[property]).toBe("😀".repeat(max));
  }
  expect(await application(await request(config, `/api/join-applications/${pending.id}`, applicant))).toMatchObject({ status: "pending", nickname: "新室友" });
  expect(await members(config, owner, id)).toHaveLength(1);
  for (const url of ["/api/rooms/not-a-room/applications", `/api/rooms/${id}/applications/not-an-application/decision`]) {
    expect((await request(config, url, owner, url.endsWith("decision") ? { idempotencyKey: v7(), decision: "approve" } : undefined)).status).toBe(400);
  }
});

it("非成员不能修改房名或昵称，获批后也不能通过命令指定别人", async () => {
  const { config, owner, applicant, id, pending } = await setup();
  for (const suffix of ["name", "nickname"] as const) expect((await request(config, `/api/rooms/${id}/${suffix}`, applicant, { idempotencyKey: v7(), [suffix]: "越权" })).status).toBe(404);
  await application(await decide(config, owner, id, pending.id));
  const before = await members(config, owner, id);
  const targetId = before.find(value => !value.isSelf)!.id;
  expect((await request(config, `/api/rooms/${id}/nickname`, owner, { idempotencyKey: v7(), nickname: "篡改室友", memberId: targetId })).status).toBe(400);
  expect(await members(config, owner, id)).toEqual(before);
  const outsider = await signUp(config, "outsider@example.com");
  for (const suffix of ["name", "nickname"] as const) expect((await request(config, `/api/rooms/${id}/${suffix}`, outsider, { idempotencyKey: v7(), [suffix]: "越权" })).status).toBe(404);
});

it("房主角标使用真实 pendingCount 十，不把展示用的 9+ 写进 read model", async () => {
  const { config, owner, applicant, id, invitation, pending } = await setup();
  for (let index = 0; index < 9; index++) {
    const cookie = await signUp(config, `badge-${index}@example.com`);
    await application(await apply(config, cookie, invitation.code, `待批${index}`));
  }
  expect(await (await request(config, `/api/rooms/${id}`, owner)).json()).toMatchObject({ pendingCount: 10 });
  expect((await (await request(config, `/api/rooms/${id}/applications`, owner)).json()).applications).toHaveLength(10);
  await application(await decide(config, owner, id, pending.id));
  expect(await (await request(config, `/api/rooms/${id}`, owner)).json()).toMatchObject({ pendingCount: 9 });
  expect(await (await request(config, `/api/rooms/${id}`, applicant)).json()).toMatchObject({ pendingCount: null });
}, 30_000);

it("批准、拒绝、重置与撤回四路竞态只留下一个终态和一致的成员关系", async () => {
  const { config, owner, applicant, id, pending } = await setup();
  const current = inviteView.parse(await (await request(config, `/api/rooms/${id}/invite`, owner)).json());
  const approveKey = v7(); const rejectKey = v7();
  const responses = await Promise.all([
    decide(config, owner, id, pending.id, "approve", approveKey),
    decide(config, owner, id, pending.id, "reject", rejectKey),
    request(config, `/api/rooms/${id}/invite/reset`, owner, { idempotencyKey: v7(), version: current.version }),
    request(config, `/api/join-applications/${pending.id}/withdraw`, applicant, { idempotencyKey: v7() })
  ]);
  expect(responses.every(response => [200, 409].includes(response.status))).toBe(true);
  expect(responses.some(response => response.status === 200)).toBe(true);
  const final = await application(await request(config, `/api/join-applications/${pending.id}`, applicant));
  expect(["approved", "rejected", "withdrawn", "cancelled"]).toContain(final.status);
  for (const [index, decision] of ["approve", "reject"].entries()) {
    const response = responses[index]!;
    if (response.status === 409) await expectCode(response, "APPLICATION_NOT_PENDING");
    else {
      expect(await application(response)).toEqual(final);
      expect(await application(await decide(config, owner, id, pending.id, decision as "approve" | "reject", [approveKey, rejectKey][index]!))).toEqual(final);
    }
  }
  if (responses[2]!.status === 409) await expectCode(responses[2]!, "INVITE_VERSION_CONFLICT");
  expect(await members(config, owner, id)).toHaveLength(final.status === "approved" ? 2 : 1);
  expect(await (await request(config, `/api/rooms/${id}`, owner)).json()).toMatchObject({ pendingCount: 0 });
  expect(await (await request(config, `/api/rooms/${id}/applications`, owner)).json()).toMatchObject({ applications: [] });
  await expectCode(await decide(config, owner, id, pending.id), "APPLICATION_NOT_PENDING");
});
