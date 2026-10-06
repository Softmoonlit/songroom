import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { commandReceipt, joinApplication, retiredRoomInvite, room, roomInvite, roomMembership, user } from "../db/schema.js";
import { Invites } from "./invites.js";
import { Rooms } from "../rooms/rooms.js";
import { NeteaseBinding } from "../netease/binding.js";
import { CredentialVault } from "../netease/credentials.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";

const fixtures: Array<{ root: string; databases: AppDatabase[] }> = [];
afterEach(() => {
  for (const { root, databases } of fixtures.splice(0)) {
    for (const database of databases) if (database.$client.open) database.$client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-invites-"));
  const filePath = path.join(root, "songroom.sqlite");
  initializeDatabase(filePath);
  const database = openDatabase(filePath);
  const databases = [database];
  fixtures.push({ root, databases });
  const now = Date.now();
  for (const id of ["owner", "member", ...Array.from({ length: 12 }, (_, i) => `applicant${i}`)]) {
    database.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: false,
      createdAt: new Date(now), updatedAt: new Date(now) }).run();
  }
  const invites = new Invites(database, () => now);
  const makeRoom = (code: string, name = "宿舍") => {
    const id = v7();
    database.insert(room).values({ id, name, ownerUserId: "owner" }).run();
    database.insert(roomMembership).values({ id: v7(), roomId: id, userId: "owner", nickname: "房主" }).run();
    database.insert(roomInvite).values({ roomId: id, code }).run();
    return id;
  };
  const roomId = makeRoom("abcdefgh01");
  const key = () => v7({ msecs: now });
  const reopen = () => {
    const next = openDatabase(filePath); databases.push(next);
    return new Invites(next, () => now);
  };
  return { root, database, invites, roomId, makeRoom, key, reopen };
}

it("同一邀请可重复申请，pending 昵称不占成员昵称且只暴露房间名称与本人申请", () => {
  const { database, invites, roomId, key } = fixture();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "member", nickname: "室友" }).run();
  expect(invites.inspect("applicant0", "abcdefgh01")).toEqual({ room: { id: roomId, name: "宿舍" }, application: null, isMember: false });
  const a = invites.submit("applicant0", { idempotencyKey: key(), code: "abcdefgh01", nickname: " 室友 " });
  const b = invites.submit("applicant1", { idempotencyKey: key(), code: "abcdefgh01", nickname: "室友" });
  expect(a.nickname).toBe("室友");
  expect(b.nickname).toBe("室友");
  expect(invites.inspect("applicant0", "abcdefgh01").application).toEqual(a);
  expect(invites.inspect("applicant2", "abcdefgh01").application).toBeNull();
  expect(invites.inspect("member", "abcdefgh01").isMember).toBe(true);
  expect(database.select().from(roomMembership).all()).toHaveLength(2);
  for (const userId of ["member", "owner"]) {
    expect(() => invites.submit(userId, { idempotencyKey: key(), code: "abcdefgh01", nickname: "自己" })).toThrowError("ALREADY_MEMBER");
  }
  for (const userId of ["member", "applicant0", "applicant2"]) {
    expect(() => invites.readInvite(userId, roomId)).toThrowError("INVITE_FORBIDDEN");
    expect(() => invites.reset(userId, roomId, { idempotencyKey: key(), version: 3 })).toThrowError("INVITE_FORBIDDEN");
  }
  expect(() => invites.readApplication("applicant1", a.id)).toThrowError("APPLICATION_UNAVAILABLE");
  expect(() => invites.withdraw("applicant1", a.id, { idempotencyKey: key() })).toThrowError("APPLICATION_UNAVAILABLE");
});

it("申请与撤回回执持久幂等、同键异内容冲突、终态重放不会占容量或恢复申请", () => {
  const { database, invites, roomId, key, reopen, makeRoom } = fixture();
  makeRoom("abcdefgh02");
  const command = { idempotencyKey: key(), code: "abcdefgh01", nickname: " e\u0301 " };
  const a = invites.submit("applicant0", command);
  expect(a.nickname).toBe("é");
  expect(invites.submit("applicant0", { ...command, nickname: "é" })).toEqual(a);
  expect(() => invites.submit("applicant0", { ...command, nickname: "另一昵称" })).toThrowError("IDEMPOTENCY_CONFLICT");
  expect(() => invites.submit("applicant0", { ...command, code: "abcdefgh02" })).toThrowError("IDEMPOTENCY_CONFLICT");
  expect(() => invites.submit("applicant0", { ...command, idempotencyKey: key() })).toThrowError("APPLICATION_PENDING");
  expect(invites.readInvite("owner", roomId)).toMatchObject({ version: 2, pendingCount: 1 });
  const withdrawCommand = { idempotencyKey: key() };
  expect(invites.withdraw("applicant0", a.id, withdrawCommand).status).toBe("withdrawn");
  const next = reopen();
  expect(next.withdraw("applicant0", a.id, withdrawCommand).status).toBe("withdrawn");
  expect(next.submit("applicant0", command).status).toBe("withdrawn");
  expect(next.readList("applicant0")).toEqual({ applications: [] });
  expect(next.readInvite("owner", roomId)).toMatchObject({ version: 3, pendingCount: 0 });
  const b = next.submit("applicant0", { ...command, idempotencyKey: key() });
  expect(b.id).not.toBe(a.id);
  expect(next.readList("applicant0").applications).toEqual([b]);
  expect(() => next.withdraw("applicant0", b.id, withdrawCommand)).toThrowError("IDEMPOTENCY_CONFLICT");
  expect(() => next.withdraw("applicant0", b.id, { idempotencyKey: command.idempotencyKey })).toThrowError("IDEMPOTENCY_CONFLICT");
  expect(database.select().from(commandReceipt).all()).toHaveLength(3);
  expect(JSON.stringify(database.select().from(commandReceipt).all())).not.toContain(command.code);
});

it("账号三份与房间十份容量在事务内限制，另一连接同样遵守且撤回后立即释放", () => {
  const { invites, roomId, makeRoom, key, reopen } = fixture();
  const codes = ["abcdefgh01", "abcdefgh02", "abcdefgh03", "abcdefgh04"];
  for (const code of codes.slice(1)) makeRoom(code);
  const ownedApplications = codes.slice(0, 3).map(code => invites.submit("applicant0", { idempotencyKey: key(), code, nickname: "室友" }));
  const next = reopen();
  expect(() => next.submit("applicant0", { idempotencyKey: key(), code: codes[3]!, nickname: "室友" })).toThrowError("ACCOUNT_APPLICATION_LIMIT");
  next.withdraw("applicant0", ownedApplications[1]!.id, { idempotencyKey: key() });
  expect(next.submit("applicant0", { idempotencyKey: key(), code: codes[3]!, nickname: "室友" }).status).toBe("pending");
  for (let i = 1; i < 10; i++) invites.submit(`applicant${i}`, { idempotencyKey: key(), code: codes[0]!, nickname: "同名" });
  expect(invites.readInvite("owner", roomId).pendingCount).toBe(10);
  expect(() => next.submit("applicant10", { idempotencyKey: key(), code: codes[0]!, nickname: "同名" })).toThrowError("ROOM_APPLICATION_LIMIT");
  const fullVersion = invites.readInvite("owner", roomId).version;
  next.withdraw("applicant0", ownedApplications[0]!.id, { idempotencyKey: key() });
  expect(next.submit("applicant10", { idempotencyKey: key(), code: codes[0]!, nickname: "同名" }).status).toBe("pending");
  expect(invites.readInvite("owner", roomId)).toMatchObject({ pendingCount: 10, version: fullVersion + 2 });
});

it("申请影响变更使旧重置确认失效，重置取消 pending 并持久区分旧码和无效码", () => {
  const { database, invites, roomId, key, reopen } = fixture();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "member", nickname: "室友" }).run();
  const stale = invites.readInvite("owner", roomId);
  const commandA = { idempotencyKey: key(), code: stale.code, nickname: "甲" };
  const a = invites.submit("applicant0", commandA);
  const b = invites.submit("applicant1", { idempotencyKey: key(), code: stale.code, nickname: "乙" });
  invites.withdraw("applicant1", b.id, { idempotencyKey: key() });
  expect(() => invites.reset("owner", roomId, { idempotencyKey: key(), version: stale.version })).toThrowError("INVITE_VERSION_CONFLICT");
  expect(database.select().from(retiredRoomInvite).all()).toEqual([]);
  const current = invites.readInvite("owner", roomId);
  const resetCommand = { idempotencyKey: key(), version: current.version };
  const reset = invites.reset("owner", roomId, resetCommand);
  expect(reset.code).toMatch(/^[A-Za-z0-9_-]{10}$/);
  expect(reset.code).not.toBe(stale.code);
  expect(reset).toMatchObject({ generation: 2, version: current.version + 1, pendingCount: 0 });
  expect(invites.readApplication("applicant0", a.id).status).toBe("cancelled");
  expect(invites.readApplication("applicant1", b.id).status).toBe("withdrawn");
  expect(database.select().from(roomMembership).all()).toHaveLength(2);
  const next = reopen();
  expect(next.reset("owner", roomId, resetCommand)).toEqual(reset);
  expect(() => next.reset("owner", roomId, { ...resetCommand, version: reset.version })).toThrowError("IDEMPOTENCY_CONFLICT");
  expect(() => next.inspect("applicant0", stale.code)).toThrowError("INVITE_RESET");
  expect(() => next.submit("applicant0", { ...commandA, idempotencyKey: key() })).toThrowError("INVITE_RESET");
  expect(() => next.submit("applicant0", commandA)).toThrowError("INVITE_RESET");
  expect(next.withdraw("applicant0", a.id, { idempotencyKey: key() }).status).toBe("cancelled");
  expect(() => next.inspect("applicant0", "invalid000")).toThrowError("INVITE_INVALID");
  expect(next.readList("applicant0")).toEqual({ applications: [] });
  expect(database.select().from(retiredRoomInvite).all()).toEqual([{ roomId, digest: createHash("sha256").update(stale.code).digest("hex") }]);
  // 另一代 reset 后，重放前代 reset 读取最新状态而非再旋转。
  const second = next.reset("owner", roomId, { idempotencyKey: key(), version: reset.version });
  expect(next.reset("owner", roomId, resetCommand)).toEqual(second);
  database.delete(roomMembership).where(eq(roomMembership.roomId, roomId)).run();
  database.delete(room).where(eq(room.id, roomId)).run();
  expect(database.select().from(retiredRoomInvite).all()).toEqual([]);
  expect(database.select().from(joinApplication).all()).toEqual([]);
  expect(() => next.inspect("applicant0", stale.code)).toThrowError("INVITE_INVALID");
});

it("withdraw 和新 pending 均使旧确认版本失效，无效操作不推进版本", () => {
  const { invites, roomId, key } = fixture();
  const a = invites.submit("applicant0", { idempotencyKey: key(), code: "abcdefgh01", nickname: "甲" });
  const stale = invites.readInvite("owner", roomId);
  const command = { idempotencyKey: key() };
  invites.withdraw("applicant0", a.id, command);
  expect(() => invites.reset("owner", roomId, { idempotencyKey: key(), version: stale.version })).toThrowError("INVITE_VERSION_CONFLICT");
  const current = invites.readInvite("owner", roomId);
  invites.withdraw("applicant0", a.id, { idempotencyKey: key() });
  expect(invites.readInvite("owner", roomId)).toEqual(current);
  expect(() => invites.submit("applicant0", { idempotencyKey: key(), code: "invalid000", nickname: "甲" })).toThrowError("INVITE_INVALID");
  expect(invites.readInvite("owner", roomId)).toEqual(current);
});

it("数据库 partial unique 只限制 pending，终态允许新申请；失败 reset 事务回滚所有影响", () => {
  const { database, invites, roomId, key } = fixture();
  const a = invites.submit("applicant0", { idempotencyKey: key(), code: "abcdefgh01", nickname: "甲" });
  expect(() => database.insert(joinApplication).values({ id: v7(), roomId, userId: "applicant0", nickname: "乙", inviteGeneration: 1 }).run()).toThrow();
  const current = invites.readInvite("owner", roomId);
  database.$client.exec("CREATE TRIGGER reject_invite_reset BEFORE UPDATE ON room_invite BEGIN SELECT RAISE(ABORT, 'test reset failure'); END");
  expect(() => invites.reset("owner", roomId, { idempotencyKey: key(), version: current.version })).toThrowError("test reset failure");
  expect(invites.readInvite("owner", roomId)).toEqual(current);
  expect(invites.readApplication("applicant0", a.id).status).toBe("pending");
  expect(database.select().from(retiredRoomInvite).all()).toEqual([]);
  expect(database.select().from(commandReceipt).all()).toHaveLength(1);
  database.$client.exec("DROP TRIGGER reject_invite_reset");
  invites.withdraw("applicant0", a.id, { idempotencyKey: key() });
  expect(() => database.insert(joinApplication).values({ id: v7(), roomId, userId: "applicant0", nickname: "乙", inviteGeneration: 1 }).run()).not.toThrow();
  expect(database.select().from(joinApplication).where(and(eq(joinApplication.roomId, roomId), eq(joinApplication.status, "pending"))).all()).toHaveLength(1);
});

it("普通室友无邀请管理权限；reset 保留当前成员；已移除成员可用新邀请从申请开始", () => {
  const { root, database, invites, roomId, key } = fixture();
  const keyPath = path.join(root, "netease.key");
  fs.writeFileSync(keyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const adapter = new ScriptedNeteaseAdapter();
  const binding = new NeteaseBinding(database, adapter, new CredentialVault(keyPath));
  const rooms = new Rooms(database, binding);
  // 未来审批/移除不在本 ticket；成员资格只由真实数据库 fixture 建立和改变。
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "member", nickname: "老室友" }).run();
  expect(rooms.readShell("member", roomId).room).toMatchObject({ role: "roommate", nickname: "老室友" });
  const members = rooms.readMembers("owner", roomId);
  const current = invites.readInvite("owner", roomId);
  expect(() => invites.readInvite("member", roomId)).toThrowError("INVITE_FORBIDDEN");
  expect(() => invites.reset("member", roomId, { idempotencyKey: key(), version: current.version })).toThrowError("INVITE_FORBIDDEN");
  const a = invites.submit("applicant0", { idempotencyKey: key(), code: current.code, nickname: "老室友" });
  expect(() => rooms.readShell("applicant0", roomId)).toThrowError("ROOM_UNAVAILABLE");
  const reset = invites.reset("owner", roomId, { idempotencyKey: key(), version: invites.readInvite("owner", roomId).version });
  expect(invites.readApplication("applicant0", a.id)).toMatchObject({ status: "cancelled", allowedActions: [] });
  expect(rooms.readMembers("owner", roomId)).toEqual(members);
  expect(rooms.readShell("member", roomId).room).toMatchObject({ role: "roommate", nickname: "老室友" });
  expect(() => invites.submit("member", { idempotencyKey: key(), code: reset.code, nickname: "老室友" })).toThrowError("ALREADY_MEMBER");
  // 用 fixture 表示该成员已被后续生命周期操作移除；没有 HTTP 后门或业务实现替身。
  database.delete(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, "member"))).run();
  expect(rooms.readList("member")).toEqual({ rooms: [] });
  expect(() => rooms.readShell("member", roomId)).toThrowError("ROOM_UNAVAILABLE");
  expect(invites.inspect("member", reset.code)).toMatchObject({ application: null, isMember: false });
  const reapplication = invites.submit("member", { idempotencyKey: key(), code: reset.code, nickname: "新昵称" });
  expect(reapplication).toMatchObject({ nickname: "新昵称", status: "pending", allowedActions: ["withdrawApplication"] });
  expect(invites.readList("member")).toEqual({ applications: [reapplication] });
  expect(rooms.readList("member")).toEqual({ rooms: [] });
  expect(rooms.readMembers("owner", roomId).members).toHaveLength(1);
  expect(() => rooms.readShell("member", roomId)).toThrowError("ROOM_UNAVAILABLE");
  expect(adapter.inputs).toEqual([]);
});
