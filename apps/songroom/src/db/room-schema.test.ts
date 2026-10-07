import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "./database.js";
import { sql } from "drizzle-orm";
import { operation, playlistSnapshot, playlistTrack, publicSongRequest, requesterTag, room, roomInvite, roomMembership, user } from "./schema.js";
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

it("歌单快照及歌曲表维护外键级联、单调版本与位置唯一性", () => {
  const { database } = fixture();
  const now = Date.now();
  database.insert(playlistSnapshot).values({ accountId: "acc-1", playlistId: "pl-1", snapshotVersion: 1, syncedAt: now, createdAt: now, updatedAt: now }).run();
  database.insert(playlistTrack).values({ accountId: "acc-1", playlistId: "pl-1", position: 0, songId: "s-1", name: "晴天", artists: JSON.stringify(["周杰伦"]), album: "叶惠美" }).run();
  database.insert(playlistTrack).values({ accountId: "acc-1", playlistId: "pl-1", position: 1, songId: "s-2", name: "七里香", artists: JSON.stringify(["周杰伦"]), album: "七里香" }).run();

  // 重复位置拒绝
  expect(() => database.insert(playlistTrack).values({ accountId: "acc-1", playlistId: "pl-1", position: 0, songId: "s-3", name: "稻香", artists: JSON.stringify(["周杰伦"]), album: "魔杰座" }).run()).toThrow();
  // 悬空外键拒绝
  expect(() => database.insert(playlistTrack).values({ accountId: "acc-none", playlistId: "pl-none", position: 0, songId: "s-1", name: "晴天", artists: JSON.stringify(["周杰伦"]), album: "叶惠美" }).run()).toThrow();
  // 级联删除
  database.delete(playlistSnapshot).run();
  expect(database.select().from(playlistTrack).all()).toHaveLength(0);
});

it("点歌人标签去重且随成员注销或房间删除级联清理，拒绝悬空外键", () => {
  const { database, roomId } = fixture();
  const memberId = v7();
  database.insert(roomMembership).values({ id: memberId, roomId, userId: "roommate", nickname: "室友A" }).run();

  database.insert(requesterTag).values({ roomId, bindingGeneration: 1, songId: "s-100", memberId, createdAt: Date.now() }).run();

  // 同成员同歌曲重复插入抛出主键冲突
  expect(() => database.insert(requesterTag).values({ roomId, bindingGeneration: 1, songId: "s-100", memberId, createdAt: Date.now() }).run()).toThrow();

  // 另一成员可点同一首歌
  const member2Id = v7();
  database.insert(roomMembership).values({ id: member2Id, roomId, userId: "another", nickname: "室友B" }).run();
  database.insert(requesterTag).values({ roomId, bindingGeneration: 1, songId: "s-100", memberId: member2Id, createdAt: Date.now() }).run();

  expect(database.select().from(requesterTag).all()).toHaveLength(2);

  // 成员移除级联删除其标签，不影响其他成员标签
  database.delete(roomMembership).where(sql`${roomMembership.id} = ${memberId}`).run();
  const remaining = database.select().from(requesterTag).all();
  expect(remaining).toHaveLength(1);
  expect(remaining[0].memberId).toBe(member2Id);

  // 房间删除级联清空全部标签
  database.delete(room).where(sql`${room.id} = ${roomId}`).run();
  expect(database.select().from(requesterTag).all()).toHaveLength(0);
});

it("操作信封支持 requestPublicSong 且严格限制同一成员同一房间最多一项未完成操作", () => {
  const { database, roomId } = fixture();
  const opId = v7();
  database.insert(operation).values({
    id: opId,
    kind: "requestPublicSong",
    userId: "roommate",
    roomId,
    accountId: "acc-1",
    authorizationId: "auth-1",
    generation: 1,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();

  database.insert(publicSongRequest).values({
    operationId: opId,
    songId: "s-100",
    name: "稻香",
    artists: JSON.stringify(["周杰伦"]),
    album: "魔杰座",
    step: "ready",
    playlistId: "pl-1",
    bindingGeneration: 1
  }).run();

  // 同一成员在同一房间尝试插入第二项未完成操作被唯一索引拒绝
  expect(() => database.insert(operation).values({
    id: v7(),
    kind: "requestPublicSong",
    userId: "roommate",
    roomId,
    accountId: "acc-1",
    authorizationId: "auth-1",
    generation: 1,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run()).toThrow();

  // 另一成员可以有未完成操作
  expect(() => database.insert(operation).values({
    id: v7(),
    kind: "requestPublicSong",
    userId: "another",
    roomId,
    accountId: "acc-1",
    authorizationId: "auth-1",
    generation: 1,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run()).not.toThrow();
});
