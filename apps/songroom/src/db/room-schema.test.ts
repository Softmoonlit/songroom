import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "./database.js";
import { room, roomInvite, roomMembership, user } from "./schema.js";
import { roomNickname } from "../shared/room-contracts.js";

const fixtures: Array<{ root: string; database: AppDatabase }> = [];
afterEach(() => {
  for (const { root, database } of fixtures.splice(0)) {
    database.$client.close(); fs.rmSync(root, { force: true, recursive: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-room-schema-"));
  const dbPath = path.join(root, "songroom.sqlite"); initializeDatabase(dbPath);
  const database = openDatabase(dbPath); fixtures.push({ root, database });
  for (const id of ["owner", "roommate", "another"]) database.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
  const roomId = v7();
  database.insert(room).values({ id: roomId, ownerUserId: "owner", name: "宿舍" }).run();
  return { database, roomId };
}

// 数据库约束接缝独立验证未来审批写入也必须遵守的不变量，不给完整 HTTP 测试后门。
it("迁移后的 SQLite 拒绝同房间规范昵称冲突，允许大小写差异和跨房间同名", () => {
  const { database, roomId } = fixture();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "owner", nickname: roomNickname.parse(" e\u0301 ") }).run();
  expect(() => database.insert(roomMembership).values({ id: v7(), roomId, userId: "roommate", nickname: roomNickname.parse("é") }).run()).toThrow();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "roommate", nickname: "É" }).run();
  const anotherRoom = v7();
  database.insert(room).values({ id: anotherRoom, ownerUserId: "another", name: "宿舍" }).run();
  expect(() => database.insert(roomMembership).values({ id: v7(), roomId: anotherRoom, userId: "another", nickname: "é" }).run()).not.toThrow();
});

it("每房间只有一份有效邀请和每账号一份成员关系，外键拒绝悬空关系", () => {
  const { database, roomId } = fixture();
  database.insert(roomInvite).values({ roomId, code: "Ab_cd-1234" }).run();
  expect(() => database.insert(roomInvite).values({ roomId, code: "another123" }).run()).toThrow();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "owner", nickname: "房主" }).run();
  expect(() => database.insert(roomMembership).values({ id: v7(), roomId, userId: "owner", nickname: "另一称呼" }).run()).toThrow();
  expect(() => database.insert(roomMembership).values({ id: v7(), roomId: v7(), userId: "roommate", nickname: "室友" }).run()).toThrow();
});
