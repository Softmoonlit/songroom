import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { and, eq } from "drizzle-orm";
import {
  commandReceipt,
  neteaseAuthorization,
  operation,
  personalPlaylistBinding,
  personalSongAddition,
  playlistSnapshot,
  playlistTrack,
  room,
  roomMembership,
  user
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { PublicPlaylists } from "./public-playlists.js";
import { PersonalPlaylists } from "./personal-playlists.js";
import { EventStreamService } from "../events/event-stream.js";
import type { AdapterInput, AdapterResult } from "../netease/protocol.js";

const fixtures: Array<{ root: string; database: AppDatabase; scheduler: UpstreamScheduler; playlists: PersonalPlaylists }> = [];
afterEach(async () => {
  for (const { root, database, scheduler, playlists } of fixtures.splice(0)) {
    playlists.stop();
    scheduler.stop();
    await scheduler.settle();
    database.$client.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-personal-song-test-"));
  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "netease.key");
  fs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);
  let timeOffset = 0;
  const now = () => Date.now() + timeOffset;
  const scheduler = new UpstreamScheduler(database, now);
  const adapter = new ScriptedNeteaseAdapter();
  const eventStream = new EventStreamService();
  const publicPlaylists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, now);
  const playlists = new PersonalPlaylists(database, vault, adapter, scheduler, eventStream, publicPlaylists, now);
  fixtures.push({ root, database, scheduler, playlists });

  // 创建用户
  for (const id of ["owner", "roommate", "outsider"]) {
    database.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: false,
      createdAt: new Date(now()),
      updatedAt: new Date(now())
    }).run();
  }
  const roomId = v7();
  database.insert(room).values({ id: roomId, ownerUserId: "owner", name: "测试宿舍" }).run();
  const ownerMemberId = v7();
  const roommateMemberId = v7();
  database.insert(roomMembership).values([
    { id: ownerMemberId, roomId, userId: "owner", nickname: "房主" },
    { id: roommateMemberId, roomId, userId: "roommate", nickname: "室友" }
  ]).run();

  const authorizationId = v7();
  const credentials = vault.encrypt("MUSIC_U=owner-credential", { authorizationId, accountId: "acc-owner", generation: 1 });
  database.insert(neteaseAuthorization).values({
    id: authorizationId,
    userId: "owner",
    accountId: "acc-owner",
    nickname: "网易云房主",
    generation: 1,
    status: "active",
    credentials
  }).run();

  // 绑定室友的专用个人歌单
  const personalBindingId = v7();
  database.insert(personalPlaylistBinding).values({
    id: personalBindingId,
    roomId,
    memberId: roommateMemberId,
    accountId: "acc-owner",
    playlistId: "pl-roommate",
    name: "songroom-测试宿舍-室友-专用",
    creationOperationId: v7(),
    generation: 1,
    createdAt: now(),
    updatedAt: now()
  }).run();

  // 初始快照（空歌单）
  database.insert(playlistSnapshot).values({
    accountId: "acc-owner",
    playlistId: "pl-roommate",
    snapshotVersion: 1,
    syncedAt: now(),
    createdAt: now(),
    updatedAt: now()
  }).run();

  scheduler.start();

  return {
    root,
    database,
    scheduler,
    adapter,
    playlists,
    roomId,
    ownerMemberId,
    roommateMemberId,
    now,
    advanceTime: (ms: number) => { timeOffset += ms; }
  };
}

function mockDetailWithSongs(playlistId: string, songIds: string[]) {
  return {
    playlist: { id: playlistId, name: "专用歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
    songIds,
    songs: songIds.map(id => ({ id, name: `歌曲-${id}`, artists: ["歌手"], album: "专辑", duration: 200000 }))
  };
}

it("正常流程：室友添加歌曲到个人歌单，trackAdd 成功后读回确认并提交快照", async () => {
  const { adapter, playlists, roomId, database, scheduler } = fixture();

  let trackAddCalled = false;
  let detailCalled = false;
  adapter.trackAdd = input => {
    trackAddCalled = true;
    expect(input.playlistId).toBe("pl-roommate");
    expect(input.songId).toBe("song-101");
    return { ok: true, data: { acknowledged: true } };
  };
  adapter.playlistDetail = () => {
    detailCalled = true;
    return { ok: true, data: mockDetailWithSongs("pl-roommate", ["song-101"]) };
  };

  const res = playlists.addSong("roommate", roomId, {
    idempotencyKey: v7(),
    songId: "song-101",
    name: "歌曲-101",
    artists: ["歌手"],
    album: "专辑"
  });

  expect(res.replay).toBe(false);
  expect(res.operation.status).toBe("queued");
  expect(res.operation.songConfirmed).toBe(false);

  await scheduler.settle();

  expect(trackAddCalled).toBe(true);
  expect(detailCalled).toBe(true);

  const op = playlists.readSongAdditionOperation("roommate", roomId, res.operation.id);
  expect(op.status).toBe("succeeded");
  expect(op.songConfirmed).toBe(true);
  expect(op.step).toBe("succeeded");

  // 验证快照歌曲已同步
  const tracks = database.select().from(playlistTrack)
    .where(and(eq(playlistTrack.accountId, "acc-owner"), eq(playlistTrack.playlistId, "pl-roommate"))).all();
  expect(tracks.map(t => t.songId)).toContain("song-101");
});

it("快照去重：本地快照已含该歌曲时直接标记成功，不调用网易云接口", async () => {
  const { adapter, playlists, roomId, database, scheduler, now } = fixture();

  // 预先插入一首已有歌曲到快照
  database.insert(playlistTrack).values({
    accountId: "acc-owner",
    playlistId: "pl-roommate",
    songId: "song-existing",
    name: "已有歌曲",
    artists: JSON.stringify(["歌手"]),
    album: "专辑",
    position: 0
  }).run();

  let adapterCalled = false;
  adapter.trackAdd = () => {
    adapterCalled = true;
    return { ok: false, error: { code: "MODULE_ERROR", message: "should not be called", outcome: "failed" } };
  };

  const res = playlists.addSong("roommate", roomId, {
    idempotencyKey: v7(),
    songId: "song-existing",
    name: "已有歌曲",
    artists: ["歌手"],
    album: "专辑"
  });

  expect(res.replay).toBe(false);
  expect(res.operation.status).toBe("succeeded");
  expect(res.operation.songConfirmed).toBe(true);
  expect(res.operation.step).toBe("succeeded");

  await scheduler.settle();
  expect(adapterCalled).toBe(false);
});

it("幂等性：同键同内容重放返回已有操作，同键不同内容拒绝", async () => {
  const { playlists, roomId } = fixture();
  const idempotencyKey = v7();

  const first = playlists.addSong("roommate", roomId, {
    idempotencyKey,
    songId: "song-1",
    name: "歌曲-1",
    artists: ["歌手A"],
    album: "专辑A"
  });

  expect(first.replay).toBe(false);

  // 相同内容重放
  const replay = playlists.addSong("roommate", roomId, {
    idempotencyKey,
    songId: "song-1",
    name: "歌曲-1",
    artists: ["歌手A"],
    album: "专辑A"
  });

  expect(replay.replay).toBe(true);
  expect(replay.operation.id).toBe(first.operation.id);

  // 不同内容冲突
  expect(() => {
    playlists.addSong("roommate", roomId, {
      idempotencyKey,
      songId: "song-2",
      name: "歌曲-2",
      artists: ["歌手B"],
      album: "专辑B"
    });
  }).toThrowError(/IDEMPOTENCY_CONFLICT/);
});

it("未配置个人歌单时拒绝添加（409 PERSONAL_PLAYLIST_NOT_FOUND）", () => {
  const { playlists, roomId } = fixture();

  // 房主尚未配置专用个人歌单
  expect(() => {
    playlists.addSong("owner", roomId, {
      idempotencyKey: v7(),
      songId: "song-1",
      name: "歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
  }).toThrowError(/PERSONAL_PLAYLIST_NOT_FOUND/);
});

it("房主网易云未授权时拒绝添加（409 NETEASE_AUTH_REQUIRED）", () => {
  const { playlists, roomId, database } = fixture();

  database.update(neteaseAuthorization).set({ status: "waitingAuthorization" }).run();

  expect(() => {
    playlists.addSong("roommate", roomId, {
      idempotencyKey: v7(),
      songId: "song-1",
      name: "歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
  }).toThrowError(/NETEASE_AUTH_REQUIRED/);
});

it("账号风控暂停时拒绝添加（423 ACCOUNT_PAUSED）", () => {
  const { playlists, roomId, scheduler } = fixture();

  scheduler.pause("acc-owner");

  expect(() => {
    playlists.addSong("roommate", roomId, {
      idempotencyKey: v7(),
      songId: "song-1",
      name: "歌曲",
      artists: ["歌手"],
      album: "专辑"
    });
  }).toThrowError(/ACCOUNT_PAUSED/);
});

it("同成员同房间存在未完成写操作时拒绝并发写（409 CONCURRENT_OPERATION_LIMIT_EXCEEDED）", () => {
  const { playlists, roomId } = fixture();

  playlists.addSong("roommate", roomId, {
    idempotencyKey: v7(),
    songId: "song-1",
    name: "歌曲-1",
    artists: ["歌手"],
    album: "专辑"
  });

  expect(() => {
    playlists.addSong("roommate", roomId, {
      idempotencyKey: v7(),
      songId: "song-2",
      name: "歌曲-2",
      artists: ["歌手"],
      album: "专辑"
    });
  }).toThrowError(/CONCURRENT_OPERATION_LIMIT_EXCEEDED/);
});

it("目标歌单有待确认写入时拒绝添加（409 TARGET_BLOCKED）", () => {
  const { playlists, roomId, database, now } = fixture();

  // 模拟同一目标歌单有 awaitingConfirmation 操作
  const conflictOpId = v7();
  database.insert(operation).values({
    id: conflictOpId,
    kind: "addPersonalSong",
    userId: "owner",
    roomId,
    accountId: "acc-owner",
    authorizationId: v7(),
    generation: 1,
    status: "awaitingConfirmation",
    lastGranted: now(),
    version: 1,
    createdAt: now(),
    updatedAt: now()
  }).run();

  database.insert(personalSongAddition).values({
    operationId: conflictOpId,
    memberId: v7(),
    playlistId: "pl-roommate",
    bindingGeneration: 1,
    songId: "conflict-song",
    name: "冲突歌曲",
    artists: "[]",
    album: "冲突专辑",
    step: "unknown",
    checkRound: 0,
    nextCheckAt: now() + 5000
  }).run();

  expect(() => {
    playlists.addSong("roommate", roomId, {
      idempotencyKey: v7(),
      songId: "song-new",
      name: "新歌",
      artists: ["歌手"],
      album: "专辑"
    });
  }).toThrowError(/TARGET_BLOCKED/);
});

it("上游明确失败（outcome: failed）：操作标记为 failed，step 为 rejected", async () => {
  const { adapter, playlists, roomId, scheduler } = fixture();

  adapter.trackAdd = () => {
    return { ok: false, error: { code: "TARGET_PERMISSION", message: "权限受限", outcome: "failed" } };
  };

  const res = playlists.addSong("roommate", roomId, {
    idempotencyKey: v7(),
    songId: "song-no-copyright",
    name: "无版权歌",
    artists: ["歌手"],
    album: "专辑"
  });

  await scheduler.settle();

  const op = playlists.readSongAdditionOperation("roommate", roomId, res.operation.id);
  expect(op.status).toBe("failed");
  expect(op.errorCode).toBe("TARGET_PERMISSION");
  expect(op.step).toBe("rejected");
  expect(op.songConfirmed).toBe(false);
});

it("上游未知异常：转入 awaitingConfirmation，并在后续轮次读回成功时完成", async () => {
  const { adapter, playlists, roomId, scheduler, advanceTime } = fixture();

  let trackAddCount = 0;
  let detailCount = 0;
  adapter.trackAdd = () => {
    trackAddCount++;
    return { ok: false, error: { code: "NETWORK_ERROR", message: "连接超时", outcome: "unknown" } };
  };
  adapter.playlistDetail = () => {
    detailCount++;
    if (detailCount === 1) {
      return { ok: true, data: mockDetailWithSongs("pl-roommate", []) };
    }
    return { ok: true, data: mockDetailWithSongs("pl-roommate", ["song-unknown"]) };
  };

  const res = playlists.addSong("roommate", roomId, {
    idempotencyKey: v7(),
    songId: "song-unknown",
    name: "未知状态歌曲",
    artists: ["歌手"],
    album: "专辑"
  });

  await scheduler.settle();

  const opBefore = playlists.readSongAdditionOperation("roommate", roomId, res.operation.id);
  expect(opBefore.status).toBe("awaitingConfirmation");
  expect(opBefore.step).toBe("unknown");
  expect(opBefore.errorCode).toBe("NETWORK_ERROR");

  // 推进 5 秒执行定时补查检查
  advanceTime(5000);
  playlists.triggerDueChecks();
  await playlists.settle();

  const opAfter = playlists.readSongAdditionOperation("roommate", roomId, res.operation.id);
  expect(opAfter.status).toBe("succeeded");
  expect(opAfter.step).toBe("succeeded");
  expect(opAfter.songConfirmed).toBe(true);
});

it("三轮补查未读到歌曲：保持 awaitingConfirmation，不再自动重发", async () => {
  const { adapter, playlists, roomId, scheduler, database, advanceTime } = fixture();

  adapter.trackAdd = () => {
    return { ok: false, error: { code: "NETWORK_ERROR", message: "超时", outcome: "unknown" } };
  };
  adapter.playlistDetail = () => {
    return { ok: true, data: mockDetailWithSongs("pl-roommate", []) };
  };

  const res = playlists.addSong("roommate", roomId, {
    idempotencyKey: v7(),
    songId: "song-never-added",
    name: "未成功歌曲",
    artists: ["歌手"],
    album: "专辑"
  });

  await scheduler.settle();

  // 此时 checkRound 为 0，推进 5 秒执行第一轮补查 -> round 1
  advanceTime(5000);
  playlists.triggerDueChecks();
  await playlists.settle();
  let detail = database.select().from(personalSongAddition).where(eq(personalSongAddition.operationId, res.operation.id)).get()!;
  expect(detail.checkRound).toBe(1);

  // 推进 30 秒执行第二轮补查 -> round 2
  advanceTime(30000);
  playlists.triggerDueChecks();
  await playlists.settle();
  detail = database.select().from(personalSongAddition).where(eq(personalSongAddition.operationId, res.operation.id)).get()!;
  expect(detail.checkRound).toBe(2);

  // 推进 120 秒执行第三轮补查 -> round 3 (上限，不再安排 nextCheckAt)
  advanceTime(120000);
  playlists.triggerDueChecks();
  await playlists.settle();
  detail = database.select().from(personalSongAddition).where(eq(personalSongAddition.operationId, res.operation.id)).get()!;
  expect(detail.checkRound).toBe(3);
  expect(detail.nextCheckAt).toBeNull();

  const finalOp = playlists.readSongAdditionOperation("roommate", roomId, res.operation.id);
  expect(finalOp.status).toBe("awaitingConfirmation");
  expect(finalOp.step).toBe("unknown");
});

it("成员离开房间后晚到的操作终结：彻底清除操作，不恢复业务数据", async () => {
  const { adapter, playlists, roomId, scheduler, database, roommateMemberId, advanceTime } = fixture();

  let detailCount = 0;
  adapter.trackAdd = () => {
    return { ok: false, error: { code: "NETWORK_ERROR", message: "超时", outcome: "unknown" } };
  };
  adapter.playlistDetail = () => {
    detailCount++;
    // 首次读回（立刻读回）为空，确保进入 awaitingConfirmation
    if (detailCount === 1) {
      return { ok: true, data: mockDetailWithSongs("pl-roommate", []) };
    }
    return { ok: true, data: mockDetailWithSongs("pl-roommate", ["song-leaving"]) };
  };

  const res = playlists.addSong("roommate", roomId, {
    idempotencyKey: v7(),
    songId: "song-leaving",
    name: "离开成员歌曲",
    artists: ["歌手"],
    album: "专辑"
  });

  await scheduler.settle();

  // 室友离开房间：删除 membership
  database.delete(roomMembership).where(eq(roomMembership.id, roommateMemberId)).run();

  // 推进 5 秒执行补查
  advanceTime(5000);
  playlists.triggerDueChecks();
  await playlists.settle();

  // 验证操作已被删除
  const remainingOp = database.select().from(operation).where(eq(operation.id, res.operation.id)).get();
  expect(remainingOp).toBeUndefined();
  const remainingDetail = database.select().from(personalSongAddition).where(eq(personalSongAddition.operationId, res.operation.id)).get();
  expect(remainingDetail).toBeUndefined();
});

it("房主重新授权：唤醒 waitingAuthorization 状态的添加操作", async () => {
  const { root, adapter, playlists, roomId, database, scheduler } = fixture();

  // 房主授权失效
  database.update(neteaseAuthorization).set({ status: "waitingAuthorization" }).run();

  // 插入一个处于 waitingAuthorization 的 addPersonalSong 操作
  const opId = v7();
  const nowTime = Date.now();
  database.insert(operation).values({
    id: opId,
    kind: "addPersonalSong",
    userId: "roommate",
    roomId,
    accountId: "acc-owner",
    authorizationId: v7(),
    generation: 1,
    status: "waitingAuthorization",
    lastGranted: nowTime,
    version: 1,
    createdAt: nowTime,
    updatedAt: nowTime
  }).run();

  database.insert(personalSongAddition).values({
    operationId: opId,
    memberId: (database.select().from(roomMembership).where(eq(roomMembership.userId, "roommate")).get()!).id,
    playlistId: "pl-roommate",
    bindingGeneration: 1,
    songId: "song-reauth",
    name: "重授权歌曲",
    artists: "[]",
    album: "专辑",
    step: "ready",
    checkRound: 0,
    nextCheckAt: null
  }).run();

  adapter.trackAdd = () => {
    return { ok: true, data: { acknowledged: true } };
  };
  adapter.playlistDetail = () => {
    return { ok: true, data: mockDetailWithSongs("pl-roommate", ["song-reauth"]) };
  };

  // 房主完成重新授权
  const newAuthId = v7();
  const keyPath = path.join(root, "netease.key");
  const vault = new CredentialVault(keyPath);
  const newCredentials = vault.encrypt("MUSIC_U=new-owner-credential", { authorizationId: newAuthId, accountId: "acc-owner", generation: 2 });
  database.update(neteaseAuthorization).set({
    id: newAuthId,
    status: "active",
    generation: 2,
    credentials: newCredentials
  }).where(eq(neteaseAuthorization.userId, "owner")).run();

  playlists.onReauthorized("owner", newAuthId, "acc-owner", 2);

  await scheduler.settle();

  const op = playlists.readSongAdditionOperation("roommate", roomId, opId);
  expect(op.status).toBe("succeeded");
  expect(op.songConfirmed).toBe(true);
});

it("服务重启恢复：在途 sending 操作恢复为 awaitingConfirmation 并安排首轮补查，绝不重新发送 trackAdd", async () => {
  const { root, database, roomId, advanceTime } = fixture();

  // 模拟进程崩溃前遗留的一个处于 processing + sending 的操作
  const crashOpId = v7();
  const nowTime = Date.now();
  database.insert(operation).values({
    id: crashOpId,
    kind: "addPersonalSong",
    userId: "roommate",
    roomId,
    accountId: "acc-owner",
    authorizationId: (database.select().from(neteaseAuthorization).get()!).id,
    generation: 1,
    status: "processing",
    lastGranted: nowTime,
    version: 1,
    createdAt: nowTime,
    updatedAt: nowTime
  }).run();

  const roommateMember = database.select().from(roomMembership).where(eq(roomMembership.userId, "roommate")).get()!;
  database.insert(personalSongAddition).values({
    operationId: crashOpId,
    memberId: roommateMember.id,
    playlistId: "pl-roommate",
    bindingGeneration: 1,
    songId: "song-crashed",
    name: "崩溃恢复歌曲",
    artists: "[]",
    album: "专辑",
    step: "sending",
    checkRound: 0,
    nextCheckAt: null
  }).run();

  // 模拟服务重启：创建全新实例
  const newAdapter = new ScriptedNeteaseAdapter();
  let trackAddCalled = false;
  newAdapter.trackAdd = () => {
    trackAddCalled = true;
    return { ok: true, data: { acknowledged: true } };
  };
  newAdapter.playlistDetail = () => {
    return { ok: true, data: mockDetailWithSongs("pl-roommate", ["song-crashed"]) };
  };

  const keyPath = path.join(root, "netease.key");
  const vault = new CredentialVault(keyPath);
  let timeOffset = 0;
  const now = () => Date.now() + timeOffset;
  const newScheduler = new UpstreamScheduler(database, now);
  const newEventStream = new EventStreamService();
  const newPublicPlaylists = new PublicPlaylists(database, newAdapter, vault, newScheduler, newEventStream, now);
  const newPlaylists = new PersonalPlaylists(database, vault, newAdapter, newScheduler, newEventStream, newPublicPlaylists, now);

  newScheduler.start();
  // 恢复后操作进入 awaitingConfirmation
  const opBefore = newPlaylists.readSongAdditionOperation("roommate", roomId, crashOpId);
  expect(opBefore.status).toBe("awaitingConfirmation");
  expect(opBefore.step).toBe("unknown");

  // 推进时间执行补查
  timeOffset += 5000;
  newPlaylists.triggerDueChecks();
  await newScheduler.settle();

  // 绝不重发 trackAdd，仅通过读回完成确认
  expect(trackAddCalled).toBe(false);
  const opAfter = newPlaylists.readSongAdditionOperation("roommate", roomId, crashOpId);
  expect(opAfter.status).toBe("succeeded");
  expect(opAfter.songConfirmed).toBe(true);

  newPlaylists.stop();
  newScheduler.stop();
  await newScheduler.settle();
});
