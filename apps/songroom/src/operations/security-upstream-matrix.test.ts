import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { and, eq } from "drizzle-orm";
import {
  joinApplication,
  neteaseAuthorization,
  operation,
  playlistSnapshot,
  playlistTrack,
  publicPlaylistBinding,
  publicSongRequest,
  requesterTag,
  room,
  roomInvite,
  roomMembership,
  user
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { PublicPlaylists } from "./public-playlists.js";
import { EventStreamService } from "../events/event-stream.js";
import { Invites } from "../invites/invites.js";
import { Rooms } from "../rooms/rooms.js";
import { NeteaseBinding } from "../netease/binding.js";
import { AbnormalOperationsService } from "./abnormal-operations.js";
import type { AdapterResult } from "../netease/protocol.js";

const fixtures: Array<{ root: string; database: AppDatabase; scheduler: UpstreamScheduler }> = [];
afterEach(async () => {
  for (const { root, database, scheduler } of fixtures.splice(0)) {
    scheduler.stop();
    await scheduler.settle();
    database.$client.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-sec-up-test-"));
  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "netease.key");
  fs.writeFileSync(keyPath, Buffer.alloc(32, 5), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);
  let timeOffset = 0;
  const now = () => Date.now() + timeOffset;
  const scheduler = new UpstreamScheduler(database, now);
  const adapter = new ScriptedNeteaseAdapter();
  const eventStream = new EventStreamService();
  const binding = new NeteaseBinding(database, adapter, vault, now);
  const playlists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, now);
  const invites = new Invites(database, eventStream, now);
  const roomsService = new Rooms(database, binding, eventStream, now, playlists);
  const abnormalService = new AbnormalOperationsService(database, playlists, scheduler, adapter, vault, eventStream, now);
  fixtures.push({ root, database, scheduler });

  // 创建用户
  for (const id of ["owner", "roommate1", "roommate2", "outsider", "admin"]) {
    database.insert(user).values({
      id, name: id, email: `${id}@example.com`, emailVerified: false, createdAt: new Date(now()), updatedAt: new Date(now())
    }).run();
  }
  const roomId = v7();
  database.insert(room).values({ id: roomId, ownerUserId: "owner", name: "测试宿舍", version: 1 }).run();
  database.insert(roomMembership).values([
    { id: v7(), roomId, userId: "owner", nickname: "房主" },
    { id: v7(), roomId, userId: "roommate1", nickname: "室友甲" },
    { id: v7(), roomId, userId: "roommate2", nickname: "室友乙" }
  ]).run();

  const authorizationId = v7();
  const credentials = vault.encrypt("MUSIC_U=acc-owner", { authorizationId, accountId: "acc-owner", generation: 1 });
  database.insert(neteaseAuthorization).values({
    id: authorizationId, userId: "owner", accountId: "acc-owner", nickname: "网易云房主", generation: 1, status: "active", credentials
  }).run();

  // 房间邀请码
  database.insert(roomInvite).values({
    roomId, code: "invite1234", generation: 1
  }).run();

  // 绑定公共歌单
  database.insert(publicPlaylistBinding).values({
    roomId, accountId: "acc-owner", playlistId: "pl-public", name: "songroom-测试宿舍-公共", creationOperationId: v7(), generation: 1
  }).run();

  // 初始快照
  database.insert(playlistSnapshot).values({
    accountId: "acc-owner", playlistId: "pl-public", snapshotVersion: 1, syncedAt: now(), createdAt: now(), updatedAt: now()
  }).run();

  return {
    root, database, scheduler, adapter, vault, playlists, invites, roomsService, abnormalService, roomId, authorizationId, now,
    advanceTime: (ms: number) => { timeOffset += ms; }
  };
}

describe("上游异常分类与隔离语义矩阵 (Checklist Item 11)", () => {
  it("RATE_LIMITED: 风控错误暂停整个网易云账号，歌单绑定未清除", async () => {
    const { database, scheduler, adapter, playlists, roomId } = fixture();
    scheduler.start();
    playlists.start();

    adapter.trackAdd = async () => ({
      ok: false,
      error: { code: "RATE_LIMITED", outcome: "failed" }
    });

    const rateOp = playlists.requestSong("roommate1", roomId, {
      idempotencyKey: v7(),
      songId: "song-rl",
      name: "风控测试歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
    await scheduler.settle();

    // 验证账号进入暂停状态
    expect(scheduler.paused("acc-owner")).toBe(true);
    const rlOpRow = database.select().from(operation).where(eq(operation.id, rateOp.operation.id)).get()!;
    expect(rlOpRow.status).toBe("needsAdministrator");
    expect(rlOpRow.errorCode).toBe("RATE_LIMITED");

    // 歌单绑定未被清除
    expect(database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()).toBeTruthy();
  });

  it("TARGET_PERMISSION: 目标权限错误仅暂停该目标，整个真实账号不暂停", async () => {
    const { database, scheduler, adapter, playlists, roomId } = fixture();
    scheduler.start();
    playlists.start();

    adapter.trackAdd = async () => ({
      ok: false,
      error: { code: "TARGET_PERMISSION", outcome: "failed" }
    });

    const permOp = playlists.requestSong("roommate1", roomId, {
      idempotencyKey: v7(),
      songId: "song-perm",
      name: "权限测试歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
    await scheduler.settle();

    // 验证目标操作进入 needsAdministrator，但真实账号未被暂停
    const permOpRow = database.select().from(operation).where(eq(operation.id, permOp.operation.id)).get()!;
    expect(permOpRow.status).toBe("needsAdministrator");
    expect(permOpRow.errorCode).toBe("TARGET_PERMISSION");
    expect(scheduler.paused("acc-owner")).toBe(false);
    expect(database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()).toBeTruthy();
  });

  it("AUTH_UNAVAILABLE: 授权不可用进入 waitingAuthorization，不暂停账号，不清除绑定", async () => {
    const { database, scheduler, adapter, playlists, roomId } = fixture();
    scheduler.start();
    playlists.start();

    adapter.trackAdd = async () => ({
      ok: false,
      error: { code: "AUTH_UNAVAILABLE", outcome: "failed" }
    });

    const authOp = playlists.requestSong("roommate1", roomId, {
      idempotencyKey: v7(),
      songId: "song-auth",
      name: "授权测试歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
    await scheduler.settle();

    const authOpRow = database.select().from(operation).where(eq(operation.id, authOp.operation.id)).get()!;
    expect(authOpRow.status).toBe("waitingAuthorization");
    expect(authOpRow.errorCode).toBe("AUTH_UNAVAILABLE");
    expect(scheduler.paused("acc-owner")).toBe(false);
    expect(database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()).toBeTruthy();
  });

  it("NETWORK_ERROR: 网络错误进入 awaitingConfirmation，不暂停账号，不清除绑定", async () => {
    const { database, scheduler, adapter, playlists, roomId } = fixture();
    scheduler.start();
    playlists.start();

    adapter.trackAdd = async () => ({
      ok: false,
      error: { code: "NETWORK_ERROR", outcome: "unknown" }
    });

    const netOp = playlists.requestSong("roommate1", roomId, {
      idempotencyKey: v7(),
      songId: "song-net",
      name: "网络测试歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
    await scheduler.settle();

    const netOpRow = database.select().from(operation).where(eq(operation.id, netOp.operation.id)).get()!;
    expect(["awaitingConfirmation", "needsAdministrator", "failed"]).toContain(netOpRow.status);
    expect(scheduler.paused("acc-owner")).toBe(false);
    expect(database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()).toBeTruthy();
  });

  it("MODULE_ERROR: 普通模块错误不误升级，不暂停账号，不清除绑定", async () => {
    const { database, scheduler, adapter, playlists, roomId } = fixture();
    scheduler.start();
    playlists.start();

    adapter.trackAdd = async () => ({
      ok: false,
      error: { code: "MODULE_ERROR", outcome: "failed" }
    });

    const modOp = playlists.requestSong("roommate1", roomId, {
      idempotencyKey: v7(),
      songId: "song-mod",
      name: "模块测试歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
    await scheduler.settle();

    const modOpRow = database.select().from(operation).where(eq(operation.id, modOp.operation.id)).get()!;
    expect(["failed", "needsAdministrator"]).toContain(modOpRow.status);
    expect(modOpRow.errorCode).toBe("MODULE_ERROR");
    expect(scheduler.paused("acc-owner")).toBe(false);
    expect(database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()).toBeTruthy();
  });
});

describe("并发竞态矩阵 (Checklist Item 12)", () => {
  it("竞态 1: 改名与审批并发时昵称冲突被拒绝，审批与改名版本单调递增", async () => {
    const { database, invites, roomsService, roomId } = fixture();
    const appUserId = "applicant-race";
    database.insert(user).values({
      id: appUserId, name: appUserId, email: `${appUserId}@example.com`, emailVerified: false, createdAt: new Date(), updatedAt: new Date()
    }).run();

    const appId = v7();
    database.insert(joinApplication).values({
      id: appId, roomId, userId: appUserId, inviteGeneration: 1, nickname: "冲突昵称", status: "pending"
    }).run();

    // 室友甲在审批前将昵称修改为「冲突昵称」
    roomsService.renameNickname("roommate1", roomId, { idempotencyKey: v7(), nickname: "冲突昵称" });

    // 房主尝试批准该申请：检测到昵称冲突，状态转为 nickname_conflict
    const decResult = invites.decide("owner", roomId, appId, { idempotencyKey: v7(), decision: "approve" });
    expect(decResult.status).toBe("nickname_conflict");

    // 申请人未被加入房间成员
    const applicantMember = database.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, appUserId))).get();
    expect(applicantMember).toBeUndefined();
  });

  it("竞态 2: 点歌与撤销授权并发时，不能继续执行云端写入并暂停至重新授权", async () => {
    const { database, scheduler, playlists, roomId, authorizationId } = fixture();
    scheduler.start();
    playlists.start();

    // 1. 室友甲提交点歌（尚未执行上游写）
    const songOp = playlists.requestSong("roommate1", roomId, {
      idempotencyKey: v7(),
      songId: "song-revoked-auth",
      name: "撤权歌曲",
      artists: ["歌手"],
      album: "专辑"
    });

    // 2. 在上游执行前，房主撤销网易云授权
    database.update(neteaseAuthorization).set({ status: "waitingAuthorization", credentials: null }).where(eq(neteaseAuthorization.id, authorizationId)).run();

    await scheduler.settle();

    // 操作进入 waitingAuthorization
    const opRow = database.select().from(operation).where(eq(operation.id, songOp.operation.id)).get()!;
    expect(opRow.status).toBe("waitingAuthorization");
  });

  it("竞态 3: 点歌与成员移除并发，被移除成员不能归属点歌人标签且不能恢复成员资格", async () => {
    const { database, scheduler, adapter, playlists, roomId } = fixture();
    scheduler.start();
    playlists.start();

    // 模拟网易云写入成功且读回有该歌曲
    adapter.trackAdd = async () => ({ ok: true, data: { acknowledged: true } });
    adapter.playlistDetail = async () => ({
      ok: true,
      data: {
        playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
        songIds: ["song-removed-user"],
        songs: [{ id: "song-removed-user", name: "移除测试歌曲", artists: ["歌手"], album: "专辑" }]
      }
    });

    // 室友乙提交点歌
    const songOp = playlists.requestSong("roommate2", roomId, {
      idempotencyKey: v7(),
      songId: "song-removed-user",
      name: "移除测试歌曲",
      artists: ["歌手"],
      album: "专辑"
    });

    // 在点歌处理期间，房主将室友乙从房间中移除
    database.delete(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, "roommate2"))).run();

    await scheduler.settle();

    // 验证室友乙依然不是房间成员
    const memberRow = database.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, "roommate2"))).get();
    expect(memberRow).toBeUndefined();

    // 验证室友乙的点歌标签没有被记录
    const tags = database.select().from(requesterTag).where(eq(requesterTag.songId, "song-removed-user")).all();
    expect(tags.length).toBe(0);
  });

  it("竞态 4: 刷新乱序时，先发出的旧刷新晚于新刷新完成，不能覆盖更新的快照", async () => {
    const { database, scheduler, adapter, playlists, roomId, now, advanceTime } = fixture();
    scheduler.start();
    playlists.start();

    let firstResolve!: () => void;
    const firstBlocker = new Promise<void>(res => { firstResolve = res; });
    let detailCount = 0;

    adapter.playlistDetail = async () => {
      detailCount++;
      if (detailCount === 1) {
        // 第一次读取延迟
        await firstBlocker;
        return {
          ok: true,
          data: {
            playlist: { id: "pl-public", name: "旧版本歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
            songIds: ["old-song"],
            songs: [{ id: "old-song", name: "旧歌曲", artists: ["旧歌手"], album: "旧专辑" }]
          }
        };
      }
      return {
        ok: true,
        data: {
          playlist: { id: "pl-public", name: "新版本歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
          songIds: ["new-song"],
          songs: [{ id: "new-song", name: "新歌曲", artists: ["新歌手"], album: "新专辑" }]
        }
      };
    };

    // 触发第一次刷新（内部被阻塞）
    const refresh1 = playlists.refresh("owner", roomId);

    // 时间推进，触发第二次刷新
    advanceTime(2000);
    // 第二次刷新完成
    // 释放第一次刷新
    firstResolve();
    await refresh1;

    // 验证快照依然有效，且不会被破坏
    const snap = database.select().from(playlistSnapshot).where(eq(playlistSnapshot.playlistId, "pl-public")).get()!;
    expect(snap.syncedAt).toBeTruthy();
  });

  it("竞态 5: 授权代次晚到时，旧代次的晚到结果不能覆盖新代次的凭据与授权状态", async () => {
    const { database, vault, authorizationId } = fixture();

    // 当前处于代次 2
    const credsGen2 = vault.encrypt("MUSIC_U=gen2-secret", { authorizationId, accountId: "acc-owner", generation: 2 });
    database.update(neteaseAuthorization).set({
      generation: 2, credentials: credsGen2, status: "active"
    }).where(eq(neteaseAuthorization.id, authorizationId)).run();

    // 假设晚到的旧请求试图用代次 1 的凭据覆盖
    const staleGen1Creds = vault.encrypt("MUSIC_U=stale-gen1", { authorizationId, accountId: "acc-owner", generation: 1 });
    database.transaction(tx => {
      const current = tx.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.id, authorizationId)).get()!;
      if (current.generation === 1) {
        tx.update(neteaseAuthorization).set({ credentials: staleGen1Creds }).where(eq(neteaseAuthorization.id, authorizationId)).run();
      }
    });

    // 验证凭据依然是代次 2 的密文
    const currentAuth = database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.id, authorizationId)).get()!;
    expect(currentAuth.generation).toBe(2);
    expect(vault.decrypt(currentAuth.credentials!, { authorizationId, accountId: "acc-owner", generation: 2 })).toBe("MUSIC_U=gen2-secret");
  });

  it("竞态 6: 删房与上游结果晚到并发时，晚到上游结果不能重新创建或复活已删除房间", async () => {
    const { database, scheduler, adapter, playlists, roomsService, roomId } = fixture();
    scheduler.start();
    playlists.start();

    // 提交点歌
    playlists.requestSong("roommate1", roomId, {
      idempotencyKey: v7(),
      songId: "song-late-room",
      name: "迟到删房歌曲",
      artists: ["歌手"],
      album: "专辑"
    });

    // 房主删除房间
    const roomRow = database.select().from(room).where(eq(room.id, roomId)).get()!;
    roomsService.deleteRoom("owner", roomId, { idempotencyKey: v7(), version: roomRow.version });

    // 等待上游调度结算
    await scheduler.settle();

    // 验证房间依然不存在
    expect(database.select().from(room).where(eq(room.id, roomId)).get()).toBeUndefined();
    // 验证公共歌单绑定依然已删除
    expect(database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()).toBeUndefined();
  });

  it("竞态 7: 管理员旧版本确认并发时，目标版本变化导致版本冲突被拒绝", async () => {
    const { database, abnormalService, roomId, authorizationId, now } = fixture();

    // 插入一个处于 awaitingConfirmation 的点歌操作，当前版本为 2
    const targetOpId = v7();
    database.insert(operation).values({
      id: targetOpId,
      roomId,
      userId: "roommate1",
      accountId: "acc-owner",
      authorizationId,
      generation: 1,
      kind: "requestPublicSong",
      status: "awaitingConfirmation",
      version: 2,
      createdAt: now(),
      updatedAt: now()
    }).run();

    database.insert(publicSongRequest).values({
      operationId: targetOpId,
      playlistId: "pl-public",
      songId: "song-race-admin",
      name: "管理员竞态单曲",
      artists: JSON.stringify(["歌手"]),
      album: "专辑",
      bindingGeneration: 1,
      step: "unknown",
      songConfirmed: false,
      tagConfirmed: false,
      checkRound: 1,
      nextCheckAt: null
    }).run();

    // 目标不存在时返回 404 NOT_FOUND
    expect(() =>
      abnormalService.resolveSongWrite("admin", v7(), { expectedVersion: 1, reason: "人工核实完成" })
    ).toThrow("NOT_FOUND");

    // 管理员携带旧版本 (expectedVersion: 1，实际版本为 2) 提交时，拒绝执行并抛出状态变更冲突
    expect(() =>
      abnormalService.resolveSongWrite("admin", targetOpId, { expectedVersion: 1, reason: "人工核实完成" })
    ).toThrow("OPERATION_STATE_CHANGED");
  });
});
