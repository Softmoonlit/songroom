import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v7 } from "uuid";
import { afterEach, expect, it, vi } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { and, eq } from "drizzle-orm";
import {
  commandReceipt,
  neteaseAuthorization,
  operation,
  personalPlaylistBinding,
  publicPlaylistBinding,
  personalSongMutation,
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
  vi.useRealTimers();
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
  adapter.identityAccount = "acc-owner";
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
    vault,
    publicPlaylists,
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

  const op = playlists.readSongOperation("roommate", roomId, res.operation.id);
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

  database.insert(personalSongMutation).values({
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

  const op = playlists.readSongOperation("roommate", roomId, res.operation.id);
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

  const opBefore = playlists.readSongOperation("roommate", roomId, res.operation.id);
  expect(opBefore.status).toBe("awaitingConfirmation");
  expect(opBefore.step).toBe("unknown");
  expect(opBefore.errorCode).toBe("NETWORK_ERROR");

  // 推进 5 秒执行定时补查检查
  advanceTime(5000);
  playlists.triggerDueChecks();
  await playlists.settle();

  const opAfter = playlists.readSongOperation("roommate", roomId, res.operation.id);
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
  let detail = database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, res.operation.id)).get()!;
  expect(detail.checkRound).toBe(1);

  // 推进 30 秒执行第二轮补查 -> round 2
  advanceTime(30000);
  playlists.triggerDueChecks();
  await playlists.settle();
  detail = database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, res.operation.id)).get()!;
  expect(detail.checkRound).toBe(2);

  // 推进 120 秒执行第三轮补查 -> round 3 (上限，不再安排 nextCheckAt)
  advanceTime(120000);
  playlists.triggerDueChecks();
  await playlists.settle();
  detail = database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, res.operation.id)).get()!;
  expect(detail.checkRound).toBe(3);
  expect(detail.nextCheckAt).toBeNull();

  const finalOp = playlists.readSongOperation("roommate", roomId, res.operation.id);
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
  const remainingDetail = database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, res.operation.id)).get();
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

  database.insert(personalSongMutation).values({
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

  const op = playlists.readSongOperation("roommate", roomId, opId);
  expect(op.status).toBe("succeeded");
  expect(op.songConfirmed).toBe(true);
});

it.each(["addPersonalSong", "removePersonalSong"] as const)("服务重启恢复：%s sending 操作只确认，绝不重新发送", async kind => {
  const { root, database, roomId, advanceTime } = fixture();

  // 模拟进程崩溃前遗留的一个处于 processing + sending 的操作
  const crashOpId = v7();
  const nowTime = Date.now();
  database.insert(operation).values({
    id: crashOpId,
    kind,
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
  database.insert(personalSongMutation).values({
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
    return { ok: true, data: mockDetailWithSongs("pl-roommate", kind === "addPersonalSong" ? ["song-crashed"] : []) };
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
  const opBefore = newPlaylists.readSongOperation("roommate", roomId, crashOpId);
  expect(opBefore.status).toBe("awaitingConfirmation");
  expect(opBefore.step).toBe("unknown");

  // 推进时间执行补查
  timeOffset += 5000;
  newPlaylists.triggerDueChecks();
  await newScheduler.settle();

  // 绝不重发 trackAdd，仅通过读回完成确认
  expect(trackAddCalled).toBe(false);
  expect(newAdapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(0);
  const opAfter = newPlaylists.readSongOperation("roommate", roomId, crashOpId);
  expect(opAfter.status).toBe("succeeded");
  expect(opAfter.songConfirmed).toBe(true);

  newPlaylists.stop();
  newScheduler.stop();
  await newScheduler.settle();
});

it("本人单首删除只写一次，完整读回云端顺序并由个人页恢复操作", async () => {
  const { database, adapter, playlists, scheduler, roomId } = fixture();
  database.insert(playlistTrack).values({ accountId: "acc-owner", playlistId: "pl-roommate", position: 0,
    songId: "song-remove", name: "待删歌曲", artists: '["歌手"]', album: "专辑" }).run();
  let deleted = false;
  adapter.trackRemove = input => {
    expect(input).toMatchObject({ playlistId: "pl-roommate", songId: "song-remove" });
    expect(deleted).toBe(false);
    deleted = true;
    return { ok: true, data: { acknowledged: true } };
  };
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", deleted ? ["song-3", "song-2"] : ["song-remove", "song-2"]) });
  expect(playlists.read("roommate", roomId).allowedActions).toContain("removePersonalSong");
  const command = { idempotencyKey: v7(), songId: "song-remove" };
  const result = playlists.removeSong("roommate", roomId, command);
  expect(result.operation).toMatchObject({ action: "remove", name: "待删歌曲", status: "queued" });
  await scheduler.settle();
  expect(adapter.inputs.map(input => input.operation)).toEqual(["playlistDetail", "trackRemove", "playlistDetail"]);
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id)).toMatchObject({ action: "remove", status: "succeeded", songConfirmed: true });
  expect(playlists.read("roommate", roomId)).toMatchObject({ songOperation: { id: result.operation.id, action: "remove", status: "succeeded" },
    snapshot: { tracks: [{ songId: "song-3" }, { songId: "song-2" }] } });
  expect(playlists.read("owner", roomId, database.select().from(roomMembership).where(eq(roomMembership.userId, "roommate")).get()!.id).songOperation).toBeUndefined();
  expect(playlists.removeSong("roommate", roomId, command)).toMatchObject({ replay: true, operation: { id: result.operation.id } });
});

it("删除执行前实时确认本人专用目标，权限变化不能发出删除", async () => {
  const { database, adapter, playlists, scheduler, roomId } = fixture();
  database.insert(playlistTrack).values({ accountId: "acc-owner", playlistId: "pl-roommate", position: 0,
    songId: "song-remove", name: "待删歌曲", artists: "[]", album: "专辑" }).run();
  adapter.playlistDetail = () => ({ ok: true, data: { ...mockDetailWithSongs("pl-roommate", ["song-remove"]),
    playlist: { id: "pl-roommate", name: "已转移", creatorId: "other-account", subscribed: false, status: 0 } } });
  const result = playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" });
  await scheduler.settle();
  expect(adapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(0);
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id)).toMatchObject({ status: "failed", errorCode: "TARGET_PERMISSION" });
});

it("个人删除未知三轮停止补查，管理员可查询和终结普通未知任务且不补写", async () => {
  const { database, adapter, playlists, scheduler, roomId, advanceTime, vault, publicPlaylists, now } = fixture();
  database.insert(playlistTrack).values({ accountId: "acc-owner", playlistId: "pl-roommate", position: 0,
    songId: "song-remove", name: "待删歌曲", artists: "[]", album: "专辑" }).run();
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", ["song-remove"]) });
  adapter.trackRemove = () => ({ ok: false, error: { code: "NETWORK_ERROR", outcome: "unknown" } });
  const result = playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" });
  await scheduler.settle();
  for (const delay of [5000, 30000, 120000]) { advanceTime(delay); playlists.triggerDueChecks(); await scheduler.settle(); }
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id)).toMatchObject({ status: "awaitingConfirmation", step: "unknown" });
  const { AbnormalOperationsService } = await import("./abnormal-operations.js");
  const service = new AbnormalOperationsService(database, publicPlaylists, scheduler, adapter, vault, new EventStreamService(), playlists, now);
  expect(service.listAbnormalOperations()).toContainEqual(expect.objectContaining({ id: result.operation.id, type: "unknown_song_write" }));
  expect(service.getAbnormalOperation(result.operation.id)).toMatchObject({ playlistId: "pl-roommate", checkRound: 3 });
  const version = playlists.readSongOperation("roommate", roomId, result.operation.id).version;
  expect(service.resolveSongWrite("owner", result.operation.id, { reason: "确认停止追查", expectedVersion: version })).toMatchObject({ conclusion: "unconfirmed_terminal" });
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id)).toMatchObject({ status: "stopped", songConfirmed: false });
  expect(adapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(1);
});

it("本地缺少歌曲仍受理删除，以完整云端读回证明不存在，不凭快照判定成功", async () => {
  const { adapter, playlists, scheduler, roomId } = fixture();
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", []) });
  const result = playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "not-in-snapshot" });
  expect(result.operation).toMatchObject({ status: "queued", name: "not-in-snapshot", songConfirmed: false });
  await scheduler.settle();
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id)).toMatchObject({ status: "succeeded", songConfirmed: true });
  expect(adapter.inputs.filter(input => input.operation === "playlistDetail")).toHaveLength(1);
  expect(adapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(0);
});

it("写入确认后云端仍含歌曲只待确认，刷新完整读证明删除后收敛且不重发", async () => {
  const { adapter, playlists, scheduler, roomId, advanceTime } = fixture();
  let cloudSongs = ["song-remove", "song-keep"];
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", cloudSongs) });
  const result = playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" });
  await scheduler.settle();
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id)).toMatchObject({ status: "awaitingConfirmation", songConfirmed: false });
  advanceTime(5000); playlists.triggerDueChecks(); await scheduler.settle();
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id).status).toBe("awaitingConfirmation");
  cloudSongs = ["song-keep"];
  await playlists.refresh("roommate", roomId);
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id)).toMatchObject({ status: "succeeded", songConfirmed: true });
  expect(adapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(1);
});

it("原账号重授权后的 sending 删除只确认原目标，不重复删除", async () => {
  const { database, adapter, playlists, scheduler, roomId, vault, now } = fixture();
  const auth = database.select().from(neteaseAuthorization).get()!;
  const member = database.select().from(roomMembership).where(eq(roomMembership.userId, "roommate")).get()!;
  const id = v7();
  database.insert(operation).values({ id, kind: "removePersonalSong", userId: "roommate", roomId, accountId: "acc-owner",
    authorizationId: auth.id, generation: 1, status: "waitingAuthorization", createdAt: now(), updatedAt: now() }).run();
  database.insert(personalSongMutation).values({ operationId: id, memberId: member.id, playlistId: "pl-roommate", bindingGeneration: 1,
    songId: "song-remove", name: "歌曲", artists: "[]", album: "专辑", step: "sending" }).run();
  const newAuthId = v7();
  const credentials = vault.encrypt("MUSIC_U=reauthorized", { authorizationId: newAuthId, accountId: "acc-owner", generation: 2 });
  database.update(neteaseAuthorization).set({ id: newAuthId, credentials, generation: 2, status: "active" }).run();
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", []) });
  playlists.onReauthorized("owner", newAuthId, "acc-owner", 2);
  await scheduler.settle();
  expect(playlists.readSongOperation("roommate", roomId, id)).toMatchObject({ status: "succeeded", songConfirmed: true });
  expect(adapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(0);
});

it("个人删除每次上游调用让出调度，无固定间隔且让同账号其他任务公平执行", async () => {
  vi.useFakeTimers();
  const { adapter, playlists, scheduler, roomId } = fixture();
  const calls: Array<{ operation: string; at: number; songId?: string }> = [];
  const original = adapter.call.bind(adapter);
  adapter.call = async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    calls.push({ operation: input.operation, at: Date.now() });
    return original(input);
  };
  let removed = false;
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", removed ? [] : ["song-remove"]) });
  adapter.trackRemove = () => { removed = true; return { ok: true, data: { acknowledged: true } }; };
  const result = playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" });
  const competing = scheduler.executeMemoryTask("acc-owner", async () => {
    calls.push({ operation: "competing-task", at: Date.now() });
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(playlists.readSongOperation("roommate", roomId, result.operation.id).status).toBe("succeeded");
  await scheduler.settle(); await competing;
  expect(calls.map(call => call.operation)).toEqual(["playlistDetail", "competing-task", "trackRemove", "playlistDetail"]);
  expect(new Set(calls.map(call => call.at)).size).toBe(1);
}, 10000);

it("本人个人删除排队或未知时拒绝公共同源点歌，公共点歌未完时拒绝再删除", async () => {
  const { database, adapter, playlists, publicPlaylists, scheduler, roomId } = fixture();
  const { publicPlaylistBinding } = await import("../db/schema.js");
  database.insert(publicPlaylistBinding).values({ roomId, accountId: "acc-owner", playlistId: "pl-public", name: "公共", creationOperationId: v7(), generation: 1 }).run();
  adapter.playlistDetail = input => ({ ok: true, data: mockDetailWithSongs(input.playlistId, ["song-remove"]) });
  const command = { idempotencyKey: v7(), sourcePlaylistId: "pl-roommate", songId: "song-remove", name: "歌曲", artists: [], album: "专辑" };
  const removal = playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" });
  expect(() => publicPlaylists.requestSong("roommate", roomId, command)).toThrow(/TARGET_BLOCKED/);
  await scheduler.settle();
  expect(playlists.readSongOperation("roommate", roomId, removal.operation.id).status).toBe("awaitingConfirmation");
  expect(() => publicPlaylists.requestSong("roommate", roomId, command)).toThrow(/TARGET_BLOCKED/);
});

it("公共同源点歌已受理时，个人删除及维护权限受到未完成写操作约束", () => {
  const { database, adapter, playlists, publicPlaylists, roomId } = fixture();
  database.insert(publicPlaylistBinding).values({ roomId, accountId: "acc-owner", playlistId: "pl-public", name: "公共", creationOperationId: v7(), generation: 1 }).run();
  adapter.playlistDetail = input => ({ ok: true, data: mockDetailWithSongs(input.playlistId, ["song-remove"]) });
  publicPlaylists.requestSong("roommate", roomId, { idempotencyKey: v7(), sourcePlaylistId: "pl-roommate", songId: "song-remove", name: "歌曲", artists: [], album: "专辑" });
  expect(() => playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" })).toThrow(/CONCURRENT_OPERATION_LIMIT_EXCEEDED/);
  expect(playlists.read("roommate", roomId)).toMatchObject({ disabledReason: "OPERATION_PENDING", allowedActions: ["refreshPersonalPlaylist"] });
});

it.each(["member", "room"] as const)("删除发送后%s撤销，晚到响应不能恢复绑定或快照", async boundary => {
  const { database, adapter, playlists, publicPlaylists, scheduler, roomId, roommateMemberId } = fixture();
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", ["song-remove"]) });
  adapter.trackRemove = () => {
    database.transaction(tx => {
      if (boundary === "member") {
        publicPlaylists.terminateMemberInTx(tx, roomId, "roommate");
        tx.delete(roomMembership).where(eq(roomMembership.id, roommateMemberId)).run();
      } else {
        publicPlaylists.terminateRoomInTx(tx, roomId, "owner");
        tx.delete(roomMembership).where(eq(roomMembership.roomId, roomId)).run();
        tx.delete(room).where(eq(room.id, roomId)).run();
      }
    });
    return { ok: true, data: { acknowledged: true } };
  };
  playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" });
  await scheduler.settle();
  expect(() => playlists.read("roommate", roomId)).toThrow(/ROOM_UNAVAILABLE/);
  expect(database.select().from(personalPlaylistBinding).all()).toHaveLength(0);
  expect(database.select().from(playlistTrack).all()).toHaveLength(0);
  expect(database.select().from(playlistSnapshot).all()).toHaveLength(0);
  expect(adapter.inputs.filter(input => input.operation === "trackRemove")).toHaveLength(1);
    const details = database.select().from(personalSongMutation).all();
  expect(details).toHaveLength(1);
  expect(details[0]).toMatchObject({ songId: "song-remove", name: "song-remove", artists: "[]", album: "" });
  expect(details[0]!.memberId).not.toBe(roommateMemberId);
  expect(database.select().from(operation).all().every(op => op.userId !== "roommate")).toBe(true);
});

it("终态24小时后查询页不再恢复旧删除，清理载荷并拒绝过期幂等键", async () => {
  const { database, adapter, playlists, scheduler, roomId, advanceTime, now } = fixture();
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", []) });
  const command = { idempotencyKey: v7(), songId: "song-remove" };
  const result = playlists.removeSong("roommate", roomId, command);
  await scheduler.settle();
  advanceTime(86_400_001);
  expect(playlists.read("roommate", roomId).songOperation).toBeNull();
  // A subsequent accepted command drives the existing terminal pruning path.
  playlists.removeSong("roommate", roomId, { idempotencyKey: v7({ msecs: now() }), songId: "song-other" });
  expect(() => playlists.readSongOperation("roommate", roomId, result.operation.id)).toThrow(/OPERATION_NOT_FOUND/);
  expect(database.select().from(personalSongMutation).where(eq(personalSongMutation.operationId, result.operation.id)).get()).toBeUndefined();
  expect(() => playlists.removeSong("roommate", roomId, command)).toThrow(/IDEMPOTENCY_KEY_EXPIRED/);
});

it("删除确认在账号队列等待期间撤权，实际获得执行权后不再发旧请求", async () => {
  const { adapter, database, playlists, publicPlaylists, scheduler, roomId, roommateMemberId, advanceTime } = fixture();
  adapter.playlistDetail = () => ({ ok: true, data: mockDetailWithSongs("pl-roommate", ["song-remove"]) });
  playlists.removeSong("roommate", roomId, { idempotencyKey: v7(), songId: "song-remove" });
  await scheduler.settle();
  const readCount = adapter.inputs.filter(input => input.operation === "playlistDetail").length;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const occupied = scheduler.executeMemoryTask("acc-owner", async () => { enter(); await gate; });
  await entered;
  advanceTime(5000);
  playlists.triggerDueChecks();
  database.transaction(tx => {
    publicPlaylists.terminateMemberInTx(tx, roomId, "roommate");
    tx.delete(roomMembership).where(eq(roomMembership.id, roommateMemberId)).run();
  });
  release();
  await occupied; await scheduler.settle();
  expect(adapter.inputs.filter(input => input.operation === "playlistDetail")).toHaveLength(readCount);
  expect(database.select().from(playlistSnapshot).all()).toHaveLength(0);
}, 10000);
