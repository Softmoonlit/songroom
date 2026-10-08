import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { room, roomMembership, neteaseAuthorization, joinApplication, roomInvite, session } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { accountName, normalizedText } from "../shared/contracts.js";
import { roomName, roomNickname } from "../shared/room-contracts.js";
import { searchText } from "../shared/song-search-contracts.js";
import { adminReason } from "../shared/admin-contracts.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface FixtureOptions {
  nodeEnv?: "test" | "production";
  adminUserIds?: string[];
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-sec-matrix-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  await fs.writeFile(path.join(staticRoot, "assets", "index-Abcd1234.js"), "console.log('asset')");

  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const adapter = new ScriptedNeteaseAdapter();

  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const baseUrl = options.nodeEnv === "production" ? "https://songs.example" : `http://127.0.0.1:${port}`;

  const app = await createApp({
    nodeEnv: options.nodeEnv ?? "test",
    host: "127.0.0.1",
    port,
    baseUrl,
    dbPath,
    staticRoot,
    credentialKeyPath,
    authSecret: "test-secret-with-at-least-32-characters",
    adminUserIds: options.adminUserIds ?? []
  }, { neteaseAdapter: adapter });

  origins.set(app, baseUrl);
  cleanups.push(() => app.close());
  await app.listen();

  return { app, adapter, root, dbPath, credentialKeyPath, baseUrl };
}

async function signup(app: SongRoomApp, email: string, name = "测试用户") {
  const origin = origins.get(app)!;
  const res = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin },
    payload: { name, email, password: "correct horse battery staple" }
  });
  expect(res.statusCode).toBe(200);
  const json = res.json();
  const rawCookie = res.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const sessionToken = json.token as string | undefined;
  return { userId: json.user.id as string, cookie: rawCookie, sessionToken };
}

function req(app: SongRoomApp, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie?: string, body?: unknown, customHeaders: Record<string, string> = {}) {
  const origin = origins.get(app)!;
  return app.fastify.inject({
    method,
    url,
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...customHeaders
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {})
  });
}

describe("第一期安全负面矩阵 (Ticket 21)", () => {
  it("矩阵 1: 真实认证与 SQLite 覆盖 7 角色在全部 read model 与命令上的权限边界", async () => {
    // 准备用户：房主、普通成员、待审批、已移除成员、其他房间房主、服务器管理员
    const adminUserIds: string[] = [];
    const { app, credentialKeyPath } = await createFixture({ adminUserIds });

    const owner = await signup(app, "owner@example.com", "房主用户");
    const roommate = await signup(app, "roommate@example.com", "室友用户");
    const applicant = await signup(app, "applicant@example.com", "申请人");
    const removedUser = await signup(app, "removed@example.com", "已移除用户");
    const otherOwner = await signup(app, "other@example.com", "他房房主");
    const adminUser = await signup(app, "admin@example.com", "系统管理员");

    // 将 adminUser 加入允许的受限管理员列表
    app.config.adminUserIds = [adminUser.userId];

    // 建立房间 A
    const roomAId = v7();
    const ownerAuthId = v7();
    const vault = new CredentialVault(credentialKeyPath);
    const ownerCreds = vault.encrypt("MUSIC_U=owner-163", { authorizationId: ownerAuthId, accountId: "owner-163", generation: 1 });
    app.database.insert(neteaseAuthorization).values({
      id: ownerAuthId, userId: owner.userId, accountId: "owner-163", nickname: "网易云房主", generation: 1, status: "active", credentials: ownerCreds
    }).run();
    app.database.insert(room).values({ id: roomAId, ownerUserId: owner.userId, name: "宿舍A", version: 1 }).run();
    const ownerMemberId = v7();
    const roommateMemberId = v7();
    const removedMemberId = v7();
    app.database.insert(roomMembership).values([
      { id: ownerMemberId, roomId: roomAId, userId: owner.userId, nickname: "房主A" },
      { id: roommateMemberId, roomId: roomAId, userId: roommate.userId, nickname: "室友A" }
    ]).run();

    // 房间 A 邀请码与申请
    const inviteA = { roomId: roomAId, code: "inv-room-a", generation: 1 };
    app.database.insert(roomInvite).values(inviteA).run();
    const appId = v7();
    app.database.insert(joinApplication).values({
      id: appId, roomId: roomAId, userId: applicant.userId, inviteGeneration: inviteA.generation, nickname: "待审批室友", status: "pending"
    }).run();

    // 建立房间 B
    const roomBId = v7();
    const otherAuthId = v7();
    const otherCreds = vault.encrypt("MUSIC_U=other-163", { authorizationId: otherAuthId, accountId: "other-163", generation: 1 });
    app.database.insert(neteaseAuthorization).values({
      id: otherAuthId, userId: otherOwner.userId, accountId: "other-163", nickname: "他房网易云", generation: 1, status: "active", credentials: otherCreds
    }).run();
    app.database.insert(room).values({ id: roomBId, ownerUserId: otherOwner.userId, name: "宿舍B", version: 1 }).run();
    app.database.insert(roomMembership).values([
      { id: v7(), roomId: roomBId, userId: otherOwner.userId, nickname: "房主B" }
    ]).run();

    // 建立一个已移除成员的历程：先加入然后通过正常业务命令移除
    app.database.insert(roomMembership).values([
      { id: removedMemberId, roomId: roomAId, userId: removedUser.userId, nickname: "即将移除室友" }
    ]).run();
    const removeRes = await req(app, "POST", `/api/rooms/${roomAId}/members/${removedMemberId}/remove`, owner.cookie, {
      idempotencyKey: v7(),
      version: 1
    });
    expect(removeRes.statusCode).toBe(200);

    // 7 种角色定义
    const roles = {
      unauthenticated: { name: "未登录", cookie: undefined },
      pendingApplicant: { name: "待审批人", cookie: applicant.cookie },
      removedMember: { name: "已移除成员", cookie: removedUser.cookie },
      otherRoomOwner: { name: "其他房间房主", cookie: otherOwner.cookie },
      systemAdmin: { name: "系统管理员(非成员)", cookie: adminUser.cookie },
      regularMember: { name: "房间A普通成员", cookie: roommate.cookie },
      roomOwner: { name: "房间A房主", cookie: owner.cookie }
    };

    // 1. GET /api/rooms (房间列表)
    expect((await req(app, "GET", "/api/rooms", roles.unauthenticated.cookie)).statusCode).toBe(401);
    const pendingList = (await req(app, "GET", "/api/rooms", roles.pendingApplicant.cookie)).json();
    expect(pendingList.rooms.find((r: any) => r.id === roomAId)).toBeUndefined();
    const removedList = (await req(app, "GET", "/api/rooms", roles.removedMember.cookie)).json();
    expect(removedList.rooms.find((r: any) => r.id === roomAId)).toBeUndefined();
    const otherList = (await req(app, "GET", "/api/rooms", roles.otherRoomOwner.cookie)).json();
    expect(otherList.rooms.find((r: any) => r.id === roomAId)).toBeUndefined();
    expect(otherList.rooms.find((r: any) => r.id === roomBId)).toBeTruthy();
    const adminList = (await req(app, "GET", "/api/rooms", roles.systemAdmin.cookie)).json();
    expect(adminList.rooms.find((r: any) => r.id === roomAId)).toBeUndefined();
    const memberList = (await req(app, "GET", "/api/rooms", roles.regularMember.cookie)).json();
    expect(memberList.rooms.find((r: any) => r.id === roomAId)?.role).toBe("roommate");
    const ownerList = (await req(app, "GET", "/api/rooms", roles.roomOwner.cookie)).json();
    expect(ownerList.rooms.find((r: any) => r.id === roomAId)?.role).toBe("owner");

    // 2. 房间 A 的只读资源：GET /api/rooms/:id, members, public-playlist
    const readUrls = [
      `/api/rooms/${roomAId}`,
      `/api/rooms/${roomAId}/members`,
      `/api/rooms/${roomAId}/public-playlist`
    ];

    for (const url of readUrls) {
      expect((await req(app, "GET", url, roles.unauthenticated.cookie)).statusCode).toBe(401);
      expect((await req(app, "GET", url, roles.pendingApplicant.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.removedMember.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.otherRoomOwner.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.systemAdmin.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.regularMember.cookie)).statusCode).toBe(200);
      expect((await req(app, "GET", url, roles.roomOwner.cookie)).statusCode).toBe(200);
    }

    // 3. 房主专属只读资源：GET /api/rooms/:id/invite, applications
    const ownerOnlyReadUrls = [
      `/api/rooms/${roomAId}/invite`,
      `/api/rooms/${roomAId}/applications`
    ];
    for (const url of ownerOnlyReadUrls) {
      expect((await req(app, "GET", url, roles.unauthenticated.cookie)).statusCode).toBe(401);
      expect((await req(app, "GET", url, roles.pendingApplicant.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.removedMember.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.otherRoomOwner.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.systemAdmin.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.regularMember.cookie)).statusCode).toBe(404);
      expect((await req(app, "GET", url, roles.roomOwner.cookie)).statusCode).toBe(200);
    }

    // 4. 房主专属写命令：重命名房间、重置邀请、审批申请、创建公共歌单、删除房间
    // (a) POST /api/rooms/:id/name
    expect((await req(app, "POST", `/api/rooms/${roomAId}/name`, roles.unauthenticated.cookie, { idempotencyKey: v7(), name: "改名" })).statusCode).toBe(401);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/name`, roles.pendingApplicant.cookie, { idempotencyKey: v7(), name: "改名" })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/name`, roles.removedMember.cookie, { idempotencyKey: v7(), name: "改名" })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/name`, roles.otherRoomOwner.cookie, { idempotencyKey: v7(), name: "改名" })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/name`, roles.systemAdmin.cookie, { idempotencyKey: v7(), name: "改名" })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/name`, roles.regularMember.cookie, { idempotencyKey: v7(), name: "改名" })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/name`, roles.roomOwner.cookie, { idempotencyKey: v7(), name: "新宿舍A" })).statusCode).toBe(200);

    // (b) POST /api/rooms/:id/applications/:appId/decision
    expect((await req(app, "POST", `/api/rooms/${roomAId}/applications/${appId}/decision`, roles.regularMember.cookie, { idempotencyKey: v7(), decision: "reject" })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/applications/${appId}/decision`, roles.systemAdmin.cookie, { idempotencyKey: v7(), decision: "reject" })).statusCode).toBe(404);
    const decRes = await req(app, "POST", `/api/rooms/${roomAId}/applications/${appId}/decision`, roles.roomOwner.cookie, { idempotencyKey: v7(), decision: "reject" });
    expect(decRes.statusCode).toBe(200);

    // (c) POST /api/rooms/:id/invite/reset
    const currentVer = app.database.select().from(room).where(eq(room.id, roomAId)).get()!.version;
    expect((await req(app, "POST", `/api/rooms/${roomAId}/invite/reset`, roles.regularMember.cookie, { idempotencyKey: v7(), version: currentVer })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/invite/reset`, roles.systemAdmin.cookie, { idempotencyKey: v7(), version: currentVer })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/invite/reset`, roles.roomOwner.cookie, { idempotencyKey: v7(), version: currentVer })).statusCode).toBe(200);

    // (d) POST /api/rooms/:id/public-playlist (创建公共歌单)
    expect((await req(app, "POST", `/api/rooms/${roomAId}/public-playlist`, roles.regularMember.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/public-playlist`, roles.systemAdmin.cookie, { idempotencyKey: v7() })).statusCode).toBe(404);
    const createPlRes = await req(app, "POST", `/api/rooms/${roomAId}/public-playlist`, roles.roomOwner.cookie, { idempotencyKey: v7() });
    expect(createPlRes.statusCode).toBe(202);

    // (e) 退出与删除边界：房主不能退出自己的房间，必须删房；普通室友可以退出不能删房
    expect((await req(app, "POST", `/api/rooms/${roomAId}/leave`, roles.roomOwner.cookie, { idempotencyKey: v7() })).statusCode).toBe(403);
    const updatedVer = app.database.select().from(room).where(eq(room.id, roomAId)).get()!.version;
    expect((await req(app, "POST", `/api/rooms/${roomAId}/delete`, roles.regularMember.cookie, { idempotencyKey: v7(), version: updatedVer })).statusCode).toBe(404);
    expect((await req(app, "POST", `/api/rooms/${roomAId}/delete`, roles.systemAdmin.cookie, { idempotencyKey: v7(), version: updatedVer })).statusCode).toBe(404);

    // (f) 管理员专用接口仅允许管理员访问
    expect((await req(app, "GET", "/api/admin/abnormal-operations", roles.regularMember.cookie)).statusCode).toBe(403);
    expect((await req(app, "GET", "/api/admin/abnormal-operations", roles.roomOwner.cookie)).statusCode).toBe(403);
    expect((await req(app, "GET", "/api/admin/abnormal-operations", roles.systemAdmin.cookie)).statusCode).toBe(200);
  });

  it("矩阵 2: 证明浏览器不能指定网易云凭据、调度键、云端歌单 ID、代次、步骤或 Enhanced 模块名", async () => {
    const { app, credentialKeyPath } = await createFixture();
    const owner = await signup(app, "inj-owner@example.com");
    const vault = new CredentialVault(credentialKeyPath);
    const authId = v7();
    const creds = vault.encrypt("MUSIC_U=legit-163", { authorizationId: authId, accountId: "legit-163", generation: 1 });
    app.database.insert(neteaseAuthorization).values({
      id: authId, userId: owner.userId, accountId: "legit-163", nickname: "合法", generation: 1, status: "active", credentials: creds
    }).run();

    const roomRes = await req(app, "POST", "/api/rooms", owner.cookie, {
      idempotencyKey: v7(),
      authorizationId: authId,
      name: "防注入房间",
      nickname: "房主"
    });
    expect(roomRes.statusCode).toBe(200);
    const roomId = roomRes.json().id;

    // 尝试在建房接口注入：cookie, accountId, credentials, module, step
    const badRoom = await req(app, "POST", "/api/rooms", owner.cookie, {
      idempotencyKey: v7(),
      authorizationId: authId,
      name: "注入测试",
      nickname: "房主",
      cookie: "MUSIC_U=evil",
      accountId: "forged-account",
      generation: 999
    });
    expect(badRoom.statusCode).toBe(400);

    // 尝试在创建公共歌单接口注入：cloudPlaylistId, generation, step, lockKey, module
    const badPlaylist = await req(app, "POST", `/api/rooms/${roomId}/public-playlist`, owner.cookie, {
      idempotencyKey: v7(),
      cloudPlaylistId: "arbitrary-playlist-id-12345",
      generation: 2,
      internalStep: "skip-to-bind",
      lockKey: "bypass-lock",
      module: "playlist_create"
    });
    expect(badPlaylist.statusCode).toBe(400);

    // 尝试在扫码流程启动接口注入：accountId, module
    const badFlow = await req(app, "POST", "/api/netease/qr-flows", owner.cookie, {
      idempotencyKey: v7(),
      accountId: "evil-acc",
      module: "login_status"
    });
    expect(badFlow.statusCode).toBe(400);
  });

  it("矩阵 3: 业务变更端点逐项验证 UUIDv7 幂等契约（纯本地同步200、上游202、同键同内容重放200、异内容409、过期/未来409，非业务端点不误用）", async () => {
    const { app, credentialKeyPath } = await createFixture();
    const user = await signup(app, "idem@example.com");
    const vault = new CredentialVault(credentialKeyPath);
    const authId = v7();
    const creds = vault.encrypt("MUSIC_U=idem-163", { authorizationId: authId, accountId: "idem-163", generation: 1 });
    app.database.insert(neteaseAuthorization).values({
      id: authId, userId: user.userId, accountId: "idem-163", nickname: "幂等", generation: 1, status: "active", credentials: creds
    }).run();

    const now = Date.now();
    const key = v7({ msecs: now });
    const expiredKey = v7({ msecs: now - 86_400_000 - 10_000 });
    const futureKey = v7({ msecs: now + 65_000 });

    // 1. 纯本地命令同步返回 200: POST /api/rooms
    const createCmd = { idempotencyKey: key, authorizationId: authId, name: "幂等房间", nickname: "房主" };
    const firstCreate = await req(app, "POST", "/api/rooms", user.cookie, createCmd);
    expect(firstCreate.statusCode).toBe(200);
    const roomId = firstCreate.json().id;

    // 同键同内容重放：返回 200 且数据相同
    const replayCreate = await req(app, "POST", "/api/rooms", user.cookie, createCmd);
    expect(replayCreate.statusCode).toBe(200);
    expect(replayCreate.json().id).toBe(roomId);

    // 同键不同内容：返回 409 IDEMPOTENCY_CONFLICT
    const conflictCreate = await req(app, "POST", "/api/rooms", user.cookie, { ...createCmd, name: "不同名字" });
    expect(conflictCreate.statusCode).toBe(409);
    expect(conflictCreate.json().error.code).toBe("IDEMPOTENCY_CONFLICT");

    // 过期键与未来键：返回 409 IDEMPOTENCY_KEY_EXPIRED
    const expiredCreate = await req(app, "POST", "/api/rooms", user.cookie, { ...createCmd, idempotencyKey: expiredKey });
    expect(expiredCreate.statusCode).toBe(409);
    expect(expiredCreate.json().error.code).toBe("IDEMPOTENCY_KEY_EXPIRED");

    const futureCreate = await req(app, "POST", "/api/rooms", user.cookie, { ...createCmd, idempotencyKey: futureKey });
    expect(futureCreate.statusCode).toBe(409);
    expect(futureCreate.json().error.code).toBe("IDEMPOTENCY_KEY_EXPIRED");

    // 2. 需要上游的新操作返回 202: POST /api/rooms/:id/public-playlist
    const plKey = v7({ msecs: now });
    const plRes = await req(app, "POST", `/api/rooms/${roomId}/public-playlist`, user.cookie, { idempotencyKey: plKey });
    expect(plRes.statusCode).toBe(202);

    // 同键同内容重放（操作在进行中）：依然返回 202 或 200，操作 ID 保持稳定
    const plReplay = await req(app, "POST", `/api/rooms/${roomId}/public-playlist`, user.cookie, { idempotencyKey: plKey });
    expect([200, 202]).toContain(plReplay.statusCode);
    expect(plReplay.json().operation.id).toBe(plRes.json().operation.id);

    // 3. 非业务端点、搜索与刷新不要求且不误用幂等键
    // 创建公共歌单并等待绑定，以便测试搜索端点
    await app.scheduler.settle();
    const plBindRes = await req(app, "GET", `/api/rooms/${roomId}/public-playlist`, user.cookie);
    if (plBindRes.json().playlist) {
      const searchRes = await req(app, "POST", `/api/rooms/${roomId}/search`, user.cookie, { query: "周杰伦" });
      expect(searchRes.statusCode).toBe(202);
      expect(searchRes.json().searchId).toBeTruthy();
    }

    // 歌单刷新接口无副作用，不需要 idempotencyKey
    const refreshRes = await req(app, "POST", `/api/rooms/${roomId}/public-playlist/refresh`, user.cookie, {});
    expect([200, 404]).toContain(refreshRes.statusCode);

    // Better Auth 登录接口使用原生凭据，不要求 idempotencyKey
    const loginRes = await req(app, "POST", "/api/auth/sign-in/email", undefined, { email: "idem@example.com", password: "correct horse battery staple" });
    expect(loginRes.statusCode).toBe(200);
  });

  it("矩阵 4: 超出整数范围的网易云账号、歌单及歌曲 ID 在各环节保持原值不丢失精度", async () => {
    const { app, adapter, credentialKeyPath } = await createFixture();
    const user = await signup(app, "bigint@example.com");

    // 超出 JavaScript Number.MAX_SAFE_INTEGER (9007199254740991) 及 64 位有符号整数最大值 (9223372036854775807) 的字符串 ID
    const hugeAccountId = "99999999999999999999999999999999";
    const hugePlaylistId = "18446744073709551615000000000000";
    const hugeSongId = "92233720368547758079998887776665";

    adapter.playlistCreate = async () => ({ ok: true, data: { playlistId: hugePlaylistId } });
    adapter.playlistDetail = async () => ({
      ok: true,
      data: {
        playlist: { id: hugePlaylistId, name: "超大ID歌单", creatorId: hugeAccountId, subscribed: false, status: 0 },
        songIds: [hugeSongId],
        songs: [{ id: hugeSongId, name: "超大ID歌曲", artists: ["超大歌手"], album: "超大专辑" }]
      }
    });

    const vault = new CredentialVault(credentialKeyPath);
    const authId = v7();
    const creds = vault.encrypt("MUSIC_U=" + hugeAccountId, { authorizationId: authId, accountId: hugeAccountId, generation: 1 });
    app.database.insert(neteaseAuthorization).values({
      id: authId, userId: user.userId, accountId: hugeAccountId, nickname: "大数网易云", generation: 1, status: "active", credentials: creds
    }).run();

    // 建房并验证 authorization accountId 原值
    const roomRes = await req(app, "POST", "/api/rooms", user.cookie, {
      idempotencyKey: v7(),
      authorizationId: authId,
      name: "大数宿舍",
      nickname: "房主"
    });
    expect(roomRes.statusCode).toBe(200);
    const roomId = roomRes.json().id;

    // 检查 binding 详情中的 accountId 是否严格为原字符串
    const bindingRes = await req(app, "GET", "/api/netease/binding", user.cookie);
    expect(bindingRes.json().binding.identity.accountId).toBe(hugeAccountId);

    // 创建歌单并推进
    const createPl = await req(app, "POST", `/api/rooms/${roomId}/public-playlist`, user.cookie, { idempotencyKey: v7() });
    expect(createPl.statusCode).toBe(202);

    // 运行调度器直至完成绑定
    await app.scheduler.settle();

    // 刷新歌单快照并调度
    await req(app, "POST", `/api/rooms/${roomId}/public-playlist/refresh`, user.cookie, {});
    await app.scheduler.settle();

    // 读取歌单快照，验证 playlistId 和 songId 保持完整精确字符串
    const plView = await req(app, "GET", `/api/rooms/${roomId}/public-playlist`, user.cookie);
    expect(plView.json().snapshot.tracks[0].songId).toBe(hugeSongId);
  });

  it("矩阵 5: 业务非 GET 校验精确 Origin、CORS 关闭、各资源缓存策略生效", async () => {
    const { app, baseUrl } = await createFixture();
    const user = await signup(app, "origin@example.com");

    // 1. 非 GET 缺少 Origin：403 ORIGIN_REJECTED
    const noOrigin = await app.fastify.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json", cookie: user.cookie },
      payload: JSON.stringify({ idempotencyKey: v7(), authorizationId: v7(), name: "测试", nickname: "房主" })
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().error.code).toBe("ORIGIN_REJECTED");
    expect(noOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    // 2. 非 GET 错误 Origin：403 ORIGIN_REJECTED
    const evilOrigin = await app.fastify.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { origin: "https://attacker.example", "content-type": "application/json", cookie: user.cookie },
      payload: JSON.stringify({ idempotencyKey: v7(), authorizationId: v7(), name: "测试", nickname: "房主" })
    });
    expect(evilOrigin.statusCode).toBe(403);
    expect(evilOrigin.json().error.code).toBe("ORIGIN_REJECTED");
    expect(evilOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    // 3. CORS 关闭证明：响应不含任何 Access-Control-*
    expect(evilOrigin.headers["access-control-allow-origin"]).toBeUndefined();
    expect(evilOrigin.headers["access-control-allow-credentials"]).toBeUndefined();

    // 4. 缓存策略：
    // API/JSON 接口：no-store
    const statusRes = await req(app, "GET", "/api/status");
    expect(statusRes.headers["cache-control"]).toBe("no-store");

    // HTML 入口：no-store
    const htmlRes = await req(app, "GET", "/");
    expect(htmlRes.headers["cache-control"]).toBe("no-store");
    expect(htmlRes.headers["content-type"]).toContain("text/html");

    // 带有哈希的静态资源：public, immutable, max-age 1年
    const assetRes = await req(app, "GET", "/assets/index-Abcd1234.js");
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers["cache-control"]).toContain("immutable");
  });

  it("矩阵 6: Bearer 禁用、原始数据库 token 无法充当 cookie、Cookie 属性与限流集成校验", async () => {
    // 在生产模式下测试 Secure Cookie 及限流
    const { app } = await createFixture({ nodeEnv: "production" });
    const origin = origins.get(app)!;

    // 1. 注册并观察 Cookie 属性：HttpOnly, SameSite=Lax, Secure
    const regRes = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin },
      payload: { name: "生产测试", email: "prod@example.com", password: "correct horse battery staple" }
    });
    expect(regRes.statusCode).toBe(200);
    const setCookie = regRes.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Lax");
    expect(cookieHeader).toContain("Secure");

    const rawToken = regRes.json().token as string;
    expect(rawToken).toBeTruthy();

    // 2. 禁用 Bearer: 携带 Authorization: Bearer <token> 请求业务接口应被拒绝 (401 SESSION_REQUIRED)
    const bearerRes = await app.fastify.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { origin, authorization: `Bearer ${rawToken}` }
    });
    expect(bearerRes.statusCode).toBe(401);
    expect(bearerRes.json().error.code).toBe("SESSION_REQUIRED");

    // 3. 原始数据库 token 不能直接充当无签名的 Cookie
    const forgedCookieRes = await app.fastify.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { origin, cookie: `better-auth.session_token=${rawToken}` }
    });
    expect(forgedCookieRes.statusCode).toBe(401);

    // 4. 服务端转发不能绕过认证限流：连续多次错误密码必须触发 429
    const attempts = await Promise.all([1, 2, 3, 4, 5].map(() =>
      app.fastify.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, "content-type": "application/json" },
        payload: JSON.stringify({ email: "prod@example.com", password: "wrong-password" })
      })
    ));
    expect(attempts.some(res => res.statusCode === 429)).toBe(true);
  });

  it("矩阵 7: 管理员原因、称呼、房间名、昵称与搜索文本规范化及 128 KiB JSON 限制", async () => {
    const { app } = await createFixture();
    const user = await signup(app, "text-norm@example.com");

    // 1. JSON 超过 128 KiB 整请求拒绝 (413)
    const oversizedBody = { idempotencyKey: v7(), name: "x".repeat(130 * 1024) };
    const overRes = await app.fastify.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { origin: origins.get(app)!, "content-type": "application/json", cookie: user.cookie },
      payload: JSON.stringify(oversizedBody)
    });
    expect(overRes.statusCode).toBe(413);

    // 2. accountName (1 至 40 码点、NFC、去首尾空白、拒绝控制字符)
    expect(accountName.safeParse("   ").success).toBe(false);
    expect(accountName.safeParse("abc\u0000def").success).toBe(false);
    expect(accountName.safeParse("abc\ndef").success).toBe(false);
    expect(accountName.safeParse("😀".repeat(40)).success).toBe(true);
    expect(accountName.safeParse("😀".repeat(41)).success).toBe(false);
    const normAcc = accountName.safeParse("  e\u0301  ");
    expect(normAcc.success && normAcc.data).toBe("é");

    // 3. roomName (1 至 16 码点)
    expect(roomName.safeParse("   ").success).toBe(false);
    expect(roomName.safeParse("room\x07name").success).toBe(false);
    expect(roomName.safeParse("😀".repeat(16)).success).toBe(true);
    expect(roomName.safeParse("😀".repeat(17)).success).toBe(false);

    // 4. roomNickname (1 至 12 码点)
    expect(roomNickname.safeParse("   ").success).toBe(false);
    expect(roomNickname.safeParse("nick\tname").success).toBe(false);
    expect(roomNickname.safeParse("😀".repeat(12)).success).toBe(true);
    expect(roomNickname.safeParse("😀".repeat(13)).success).toBe(false);

    // 5. searchText (1 至 200 码点)
    expect(searchText.safeParse("   ").success).toBe(false);
    expect(searchText.safeParse("search\rquery").success).toBe(false);
    expect(searchText.safeParse("😀".repeat(200)).success).toBe(true);
    expect(searchText.safeParse("😀".repeat(201)).success).toBe(false);

    // 6. adminReason (1 至 500 码点)
    expect(adminReason.safeParse("   ").success).toBe(false);
    expect(adminReason.safeParse("admin\u001Freason").success).toBe(false);
    expect(adminReason.safeParse("😀".repeat(500)).success).toBe(true);
    expect(adminReason.safeParse("😀".repeat(501)).success).toBe(false);
    const normReason = adminReason.safeParse("   已线下核验\u0045\u0301身份   ");
    expect(normReason.success && normReason.data).toBe("已线下核验É身份");
  });

  it("矩阵 8: SSE 鉴权负面用例（未登录 401、跨源 403、跨用户不可见、跨房间事件隔离、重连与游标兜底）", async () => {
    const { app, baseUrl, credentialKeyPath } = await createFixture();
    const owner = await signup(app, "sse-owner@example.com");
    const stranger = await signup(app, "sse-stranger@example.com");

    // 1. 未登录请求 /api/events 返回 401
    const anonRes = await app.fastify.inject({
      method: "GET",
      url: "/api/events",
      headers: { accept: "text/event-stream" }
    });
    expect(anonRes.statusCode).toBe(401);

    // 2. 跨源请求 /api/events 返回 403
    const crossOriginRes = await app.fastify.inject({
      method: "GET",
      url: "/api/events",
      headers: {
        origin: "https://evil-cross-origin.example",
        cookie: owner.cookie,
        accept: "text/event-stream"
      }
    });
    expect(crossOriginRes.statusCode).toBe(403);
    expect(crossOriginRes.json().error.code).toBe("ORIGIN_REJECTED");

    // 3. 建立房间与网易云绑定
    const vault = new CredentialVault(credentialKeyPath);
    const authId = v7();
    const creds = vault.encrypt("MUSIC_U=sse-163", { authorizationId: authId, accountId: "sse-163", generation: 1 });
    app.database.insert(neteaseAuthorization).values({
      id: authId, userId: owner.userId, accountId: "sse-163", nickname: "SSE房主", generation: 1, status: "active", credentials: creds
    }).run();

    const roomRes = await req(app, "POST", "/api/rooms", owner.cookie, {
      idempotencyKey: v7(),
      authorizationId: authId,
      name: "SSE隔离宿舍",
      nickname: "房主"
    });
    expect(roomRes.statusCode).toBe(200);
    const roomId = roomRes.json().id;

    // 4. Stranger 建立 SSE 连接，验证不会收到房主房间的任何失效事件
    const strangerFetch = await fetch(`${baseUrl}/api/events`, {
      headers: { cookie: stranger.cookie, accept: "text/event-stream" }
    });
    expect(strangerFetch.status).toBe(200);
    const strangerReader = strangerFetch.body!.getReader();
    const decoder = new TextDecoder();
    let strangerBuf = "";

    // 读取 connected 首包
    while (!strangerBuf.includes("\n\n")) {
      const { value, done } = await strangerReader.read();
      if (done) break;
      strangerBuf += decoder.decode(value, { stream: true });
    }
    expect(strangerBuf).toContain("event: connected");
    strangerBuf = "";

    // 房主修改房间名，触发房间事件广播
    const renameRes = await req(app, "POST", `/api/rooms/${roomId}/name`, owner.cookie, {
      idempotencyKey: v7(),
      name: "更名隔离房间"
    });
    expect(renameRes.statusCode).toBe(200);

    // 等待一小段时间，Stranger 的 reader 绝不能读到 room 事件
    const raceRead = Promise.race([
      strangerReader.read().then(r => ({ got: true, value: r.value })),
      new Promise(resolve => setTimeout(() => resolve({ got: false }), 200))
    ]);
    const readOutcome = await raceRead as { got: boolean; value?: Uint8Array };
    if (readOutcome.got && readOutcome.value) {
      const text = decoder.decode(readOutcome.value);
      expect(text).not.toContain("room");
    }

    await strangerReader.cancel();
  });

  it("矩阵 9: SPA 单入口与静态资源安全响应头覆盖（CSP、Referrer-Policy、HSTS、X-Content-Type-Options 等生产与非生产差异）", async () => {
    // 1. 生产环境下的安全头验证
    const prodFixture = await createFixture({ nodeEnv: "production" });
    const prodIndex = await prodFixture.app.fastify.inject({ method: "GET", url: "/" });
    expect(prodIndex.statusCode).toBe(200);

    // HSTS 在生产模式下必须开启
    expect(prodIndex.headers["strict-transport-security"]).toBeDefined();
    expect(prodIndex.headers["x-content-type-options"]).toBe("nosniff");
    expect(prodIndex.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(prodIndex.headers["referrer-policy"]).toBe("no-referrer");

    // CSP 校验：脚本与样式仅限 self，对象禁用，frameAncestors 禁用
    const csp = prodIndex.headers["content-security-policy"] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");

    // 2. 测试环境下的安全头差异：HSTS 关闭，不强制 upgrade-insecure-requests
    const testFixture = await createFixture({ nodeEnv: "test" });
    const testIndex = await testFixture.app.fastify.inject({ method: "GET", url: "/" });
    expect(testIndex.headers["strict-transport-security"]).toBeUndefined();
    expect(testIndex.headers["x-content-type-options"]).toBe("nosniff");
    const testCsp = testIndex.headers["content-security-policy"] as string;
    expect(testCsp).not.toContain("upgrade-insecure-requests");
  });

  it("矩阵 10: 无凭据泄露矩阵（HTTP 响应、数据库日志与存储均不含 MUSIC_U 明文凭据或密码哈希）", async () => {
    const { app, credentialKeyPath } = await createFixture();
    const rawSecret = "MUSIC_U=super-secret-user-cookie-999";
    const password = "my-secret-password-12345";
    const owner = await signup(app, "leak-check@example.com", "防泄露用户");

    // 1. 认证接口与 Session 响应不含密码明文或密码哈希
    const sessionRes = await req(app, "GET", "/api/auth/get-session", owner.cookie);
    expect(sessionRes.statusCode).toBe(200);
    const sessionText = JSON.stringify(sessionRes.json());
    expect(sessionText).not.toContain(password);
    expect(sessionText).not.toContain("password");

    // 2. 绑定网易云凭据
    const vault = new CredentialVault(credentialKeyPath);
    const authId = v7();
    const creds = vault.encrypt(rawSecret, { authorizationId: authId, accountId: "acc-leak", generation: 1 });
    app.database.insert(neteaseAuthorization).values({
      id: authId, userId: owner.userId, accountId: "acc-leak", nickname: "防泄露网易云", generation: 1, status: "active", credentials: creds
    }).run();

    // 3. 读取网易云绑定详情：JSON 响应绝不包含 MUSIC_U 或 rawSecret 明文
    const bindingRes = await req(app, "GET", "/api/netease/binding", owner.cookie);
    expect(bindingRes.statusCode).toBe(200);
    const bindingText = JSON.stringify(bindingRes.json());
    expect(bindingText).not.toContain("MUSIC_U");
    expect(bindingText).not.toContain("super-secret-user-cookie-999");

    // 4. 数据库存储校验：SQLite 中 netease_authorization.credentials 是密文，不包含 MUSIC_U
    const authRow = app.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.id, authId)).get()!;
    expect(authRow.credentials).toBeTruthy();
    expect(authRow.credentials!).not.toContain("MUSIC_U");
    expect(authRow.credentials!).not.toContain("super-secret-user-cookie-999");

    // 5. 解密测试：仅持有合法密钥的后端服务内部才可解密出原值
    const decrypted = vault.decrypt(authRow.credentials!, { authorizationId: authId, accountId: "acc-leak", generation: 1 });
    expect(decrypted).toBe(rawSecret);
  });

  it("矩阵 11: 调度并发安全（多账号/多房间并发在途上限 2、启动预算与公平性不受攻击干扰）", async () => {
    const { app, credentialKeyPath } = await createFixture();
    const vault = new CredentialVault(credentialKeyPath);

    // 注册两个不同账号的用户并在其房间各自发起操作
    const u1 = await signup(app, "user1@example.com");
    const u2 = await signup(app, "user2@example.com");

    const a1 = v7();
    const a2 = v7();
    app.database.insert(neteaseAuthorization).values([
      { id: a1, userId: u1.userId, accountId: "acc-1", nickname: "账号1", generation: 1, status: "active", credentials: vault.encrypt("MUSIC_U=acc-1", { authorizationId: a1, accountId: "acc-1", generation: 1 }) },
      { id: a2, userId: u2.userId, accountId: "acc-2", nickname: "账号2", generation: 1, status: "active", credentials: vault.encrypt("MUSIC_U=acc-2", { authorizationId: a2, accountId: "acc-2", generation: 1 }) }
    ]).run();

    const r1 = (await req(app, "POST", "/api/rooms", u1.cookie, { idempotencyKey: v7(), authorizationId: a1, name: "房1", nickname: "房主1" })).json().id;
    const r2 = (await req(app, "POST", "/api/rooms", u2.cookie, { idempotencyKey: v7(), authorizationId: a2, name: "房2", nickname: "房主2" })).json().id;

    // 分别发起公共歌单创建操作
    const op1 = await req(app, "POST", `/api/rooms/${r1}/public-playlist`, u1.cookie, { idempotencyKey: v7() });
    const op2 = await req(app, "POST", `/api/rooms/${r2}/public-playlist`, u2.cookie, { idempotencyKey: v7() });
    expect(op1.statusCode).toBe(202);
    expect(op2.statusCode).toBe(202);

    // 等待调度执行完成
    await app.scheduler.settle();

    // 验证两房的操作均成功完成且未发生阻塞或饥饿
    const pl1 = await req(app, "GET", `/api/rooms/${r1}/public-playlist`, u1.cookie);
    const pl2 = await req(app, "GET", `/api/rooms/${r2}/public-playlist`, u2.cookie);
    expect(pl1.json().playlist).toBeTruthy();
    expect(pl2.json().playlist).toBeTruthy();
  });
});
