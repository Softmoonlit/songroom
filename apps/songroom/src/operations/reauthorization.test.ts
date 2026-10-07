import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import {
  neteaseAuthorization,
  operation,
  playlistSnapshot,
  publicPlaylistBinding,
  publicSongRequest,
  room,
  roomMembership,
  session,
  user
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { PublicPlaylists } from "./public-playlists.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { EventStreamService } from "../events/event-stream.js";
import { Rooms } from "../rooms/rooms.js";
import { NeteaseBinding } from "../netease/binding.js";
import type { SessionPrincipal } from "../auth.js";

const fixtures: Array<{ root: string; database: AppDatabase; modules: PublicPlaylists[] }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const module of fixture.modules) {
      module.stop();
      await module.settle();
    }
    fixture.database.$client.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function setupFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-reauth-"));
  const dbPath = path.join(root, "app.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "key");
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);

  for (const id of ["owner", "roommate"]) {
    database.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date()
    }).run();
  }

  const sessionId = v7();
  database.insert(session).values({
    id: sessionId,
    token: "token-owner",
    userId: "owner",
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    updatedAt: new Date()
  }).run();
  const principal: SessionPrincipal = { userId: "owner", sessionId };

  const roomId = v7();
  database.insert(room).values({ id: roomId, name: "宿舍", ownerUserId: "owner" }).run();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "owner", nickname: "房主" }).run();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "roommate", nickname: "室友" }).run();

  const authId = v7();
  const scope = { authorizationId: authId, accountId: "cloud-owner", generation: 1 };
  database.insert(neteaseAuthorization).values({
    id: authId,
    userId: "owner",
    accountId: scope.accountId,
    generation: 1,
    nickname: "房主",
    status: "active",
    credentials: vault.encrypt("MUSIC_U=owner", scope)
  }).run();

  const adapter = new ScriptedNeteaseAdapter();
  adapter.identityAccount = "cloud-owner";
  const eventStream = new EventStreamService();
  const scheduler = new UpstreamScheduler(database);
  const playlists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream);
  const neteaseBinding = new NeteaseBinding(database, adapter, vault);
  const rooms = new Rooms(database, neteaseBinding, eventStream);

  neteaseBinding.onRevoke = userId => playlists.onOwnerRevoked(userId);
  neteaseBinding.onReauthorize = (userId, aId, accId, gen) => playlists.onReauthorized(userId, aId, accId, gen);

  fixtures.push({ root, database, modules: [playlists] });
  return { database, adapter, vault, scheduler, playlists, neteaseBinding, rooms, roomId, authId, principal };
}

it("房主退出授权时，排队中的创建公共歌单操作进入 waitingAuthorization，房间列表提示等待授权", async () => {
  const { database, playlists, rooms, roomId, adapter, neteaseBinding, principal } = setupFixture();

  let release!: () => void;
  const gate = new Promise<void>(res => { release = res; });
  adapter.playlistCreate = async () => {
    await gate;
    return { ok: true, data: { playlistId: "cloud-playlist" } };
  };

  const res = playlists.create("owner", roomId, { idempotencyKey: v7() });
  expect(res.replay).toBe(false);
  const opId = res.view.operation!.id;

  const initialOp = database.select().from(operation).where(eq(operation.id, opId)).get()!;
  expect(["queued", "processing"]).toContain(initialOp.status);

  // 房主通过公开接口退出授权
  neteaseBinding.revoke(principal, v7());

  const opAfterRevoke = database.select().from(operation).where(eq(operation.id, opId)).get()!;
  expect(opAfterRevoke.status).toBe("waitingAuthorization");
  expect(opAfterRevoke.errorCode).toBe("AUTH_UNAVAILABLE");

  // 房间列表中显示等待授权
  const roomList = rooms.readList("owner");
  expect(roomList.rooms[0].authorizationStatus).toBe("waitingAuthorization");

  const roommateList = rooms.readList("roommate");
  expect(roommateList.rooms[0].authorizationStatus).toBe("waitingAuthorization");

  release();
});

it("同账号重新授权后，未发创建公共歌单操作自动恢复 queued 并成功完成", async () => {
  const { database, playlists, roomId, adapter, neteaseBinding, principal } = setupFixture();

  let release!: () => void;
  const gate = new Promise<void>(res => { release = res; });
  adapter.playlistCreate = async () => {
    await gate;
    return { ok: true, data: { playlistId: "cloud-playlist" } };
  };

  const res = playlists.create("owner", roomId, { idempotencyKey: v7() });
  const opId = res.view.operation!.id;

  neteaseBinding.revoke(principal, v7());
  expect(database.select().from(operation).where(eq(operation.id, opId)).get()!.status).toBe("waitingAuthorization");

  // 通过公开扫码流程重新授权同一网易云账号
  adapter.identityAccount = "cloud-owner";
  const flow = await neteaseBinding.start(principal, v7());
  await neteaseBinding.check(principal, flow.id);
  await neteaseBinding.confirm(principal, flow.id, v7());

  const recoveredOp = database.select().from(operation).where(eq(operation.id, opId)).get()!;
  expect(recoveredOp.status).toBe("queued");
  expect(recoveredOp.generation).toBe(2);
  expect(recoveredOp.errorCode).toBeNull();

  release();
});

it("已发送/处于 awaitingConfirmation 的点歌操作在重新授权后只执行只读核查，绝不再次调用 trackAdd", async () => {
  const { database, adapter, playlists, roomId, authId } = setupFixture();

  const creationOpId = v7();
  database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "cloud-owner",
    playlistId: "cloud-playlist",
    name: "公共歌单",
    creationOperationId: creationOpId,
    generation: 1
  }).run();

  database.insert(playlistSnapshot).values({
    accountId: "cloud-owner",
    playlistId: "cloud-playlist",
    snapshotVersion: 1,
    syncedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();

  // 创建一个处于 unknown/awaitingConfirmation 状态的点歌操作
  const opId = v7();
  database.insert(operation).values({
    id: opId,
    kind: "requestPublicSong",
    userId: "roommate",
    roomId,
    accountId: "cloud-owner",
    authorizationId: authId,
    generation: 1,
    status: "awaitingConfirmation",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();

  database.insert(publicSongRequest).values({
    operationId: opId,
    songId: "song-123",
    name: "测试歌曲",
    artists: JSON.stringify(["歌手"]),
    album: "专辑",
    step: "unknown",
    playlistId: "cloud-playlist",
    bindingGeneration: 1,
    checkRound: 2,
    songConfirmed: false,
    tagConfirmed: false
  }).run();

  adapter.playlistDetail = async () => ({
    ok: true,
    data: {
      playlist: { id: "cloud-playlist", name: "公共歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
      songIds: ["song-123"],
      songs: [{ id: "song-123", name: "测试歌曲", artists: ["歌手"], album: "专辑" }]
    }
  });

  // 重新授权触发
  playlists.onReauthorized("owner", authId, "cloud-owner", 2);

  const opAfterReauth = database.select().from(operation).where(eq(operation.id, opId)).get()!;
  expect(opAfterReauth.status).toBe("awaitingConfirmation");
  const detail = database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, opId)).get()!;
  expect(detail.checkRound).toBe(0);

  // 绝无调用 trackAdd
  expect(adapter.inputs.filter(i => i.operation === "trackAdd")).toHaveLength(0);
});

it("室友在等待授权期间已离开房间时，重新授权将未发点歌操作置为 stopped", async () => {
  const { database, playlists, roomId, authId } = setupFixture();

  const creationOpId = v7();
  database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "cloud-owner",
    playlistId: "cloud-playlist",
    name: "公共歌单",
    creationOperationId: creationOpId,
    generation: 1
  }).run();

  const opId = v7();
  database.insert(operation).values({
    id: opId,
    kind: "requestPublicSong",
    userId: "roommate",
    roomId,
    accountId: "cloud-owner",
    authorizationId: authId,
    generation: 1,
    status: "waitingAuthorization",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();

  database.insert(publicSongRequest).values({
    operationId: opId,
    songId: "song-456",
    name: "测试歌曲2",
    artists: JSON.stringify(["歌手"]),
    album: "专辑",
    step: "ready",
    playlistId: "cloud-playlist",
    bindingGeneration: 1,
    checkRound: 0,
    songConfirmed: false,
    tagConfirmed: false
  }).run();

  // 室友离开房间（删除 roomMembership）
  database.delete(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, "roommate"))).run();

  // 重新授权触发
  playlists.onReauthorized("owner", authId, "cloud-owner", 2);

  const opAfter = database.select().from(operation).where(eq(operation.id, opId)).get()!;
  expect(opAfter.status).toBe("stopped");
});

it("ACCOUNT_PAUSED 或 needsAdministrator 状态的操作在重新授权后保持现状，不自动恢复", async () => {
  const { database, playlists, roomId, authId } = setupFixture();

  const pausedOpId = v7();
  database.insert(operation).values({
    id: pausedOpId,
    kind: "requestPublicSong",
    userId: "roommate",
    roomId,
    accountId: null,
    authorizationId: null,
    generation: null,
    status: "failed",
    errorCode: "ACCOUNT_PAUSED",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();

  const adminOpId = v7();
  database.insert(operation).values({
    id: adminOpId,
    kind: "createPublicPlaylist",
    userId: "owner",
    roomId,
    accountId: "cloud-owner",
    authorizationId: authId,
    generation: 1,
    status: "needsAdministrator",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }).run();

  playlists.onReauthorized("owner", authId, "cloud-owner", 2);

  expect(database.select().from(operation).where(eq(operation.id, pausedOpId)).get()!.status).toBe("failed");
  expect(database.select().from(operation).where(eq(operation.id, adminOpId)).get()!.status).toBe("needsAdministrator");
});
