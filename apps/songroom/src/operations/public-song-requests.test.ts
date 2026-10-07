import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { and, eq } from "drizzle-orm";
import { neteaseAuthorization, operation, playlistSnapshot, playlistTrack, publicPlaylistBinding, publicSongRequest, requesterTag, room, roomMembership, user } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { PublicPlaylists } from "./public-playlists.js";
import { EventStreamService } from "../events/event-stream.js";
import type { AdapterInput, AdapterResult } from "../netease/protocol.js";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-song-req-test-"));
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
  const playlists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, now);
  fixtures.push({ root, database, scheduler });

  // 创建用户
  for (const id of ["owner", "roommate1", "roommate2", "outsider"]) {
    database.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: false, createdAt: new Date(now()), updatedAt: new Date(now()) }).run();
  }
  const roomId = v7();
  database.insert(room).values({ id: roomId, ownerUserId: "owner", name: "测试宿舍" }).run();
  database.insert(roomMembership).values([
    { id: v7(), roomId, userId: "owner", nickname: "房主" },
    { id: v7(), roomId, userId: "roommate1", nickname: "室友甲" },
    { id: v7(), roomId, userId: "roommate2", nickname: "室友乙" }
  ]).run();

  const authorizationId = v7();
  const credentials = vault.encrypt("MUSIC_U=owner-credential", { authorizationId, accountId: "acc-owner", generation: 1 });
  database.insert(neteaseAuthorization).values({
    id: authorizationId, userId: "owner", accountId: "acc-owner", nickname: "网易云房主", generation: 1, status: "active", credentials
  }).run();

  // 绑定公共歌单
  database.insert(publicPlaylistBinding).values({
    roomId, accountId: "acc-owner", playlistId: "pl-public", name: "songroom-测试宿舍-公共", creationOperationId: v7(), generation: 1
  }).run();

  // 初始快照
  database.insert(playlistSnapshot).values({
    accountId: "acc-owner", playlistId: "pl-public", snapshotVersion: 1, syncedAt: now(), createdAt: now(), updatedAt: now()
  }).run();

  return { root, database, scheduler, adapter, playlists, roomId, now, advanceTime: (ms: number) => { timeOffset += ms; } };
}

it("公共已有歌曲时不调用增加接口，只写入去重标签；不同成员分别留标签，重复点歌不累计", async () => {
  const f = fixture();
  // 歌单已有《晴天》
  f.database.insert(playlistTrack).values({
    accountId: "acc-owner", playlistId: "pl-public", position: 0, songId: "s-101", name: "晴天", artists: JSON.stringify(["周杰伦"]), album: "叶惠美"
  }).run();

  const inputsBefore = f.adapter.inputs.length;

  // 室友甲点歌
  const res1 = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-101", name: "晴天", artists: ["周杰伦"], album: "叶惠美"
  });
  expect(res1.replay).toBe(false);
  expect(res1.operation.status).toBe("succeeded");
  expect(res1.operation.songConfirmed).toBe(true);
  expect(res1.operation.tagConfirmed).toBe(true);
  // 不调用上游增加接口！
  expect(f.adapter.inputs.length).toBe(inputsBefore);

  // 查看快照展示
  let view = f.playlists.read("roommate1", f.roomId);
  expect(view.snapshot?.tracks[0].requesters).toEqual(["室友甲"]);

  // 室友甲重复点同一首歌：幂等成功，不累计次数
  const res1Again = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-101", name: "晴天", artists: ["周杰伦"], album: "叶惠美"
  });
  expect(res1Again.operation.status).toBe("succeeded");
  view = f.playlists.read("roommate1", f.roomId);
  expect(view.snapshot?.tracks[0].requesters).toEqual(["室友甲"]);

  // 室友乙点同一首歌：分别留标签
  const res2 = f.playlists.requestSong("roommate2", f.roomId, {
    idempotencyKey: v7(), songId: "s-101", name: "晴天", artists: ["周杰伦"], album: "叶惠美"
  });
  expect(res2.operation.status).toBe("succeeded");
  view = f.playlists.read("roommate1", f.roomId);
  expect(view.snapshot?.tracks[0].requesters).toEqual(["室友甲", "室友乙"]);
});

it("公共尚无歌曲时发送一次增加请求并执行写后读回，确认后提交标签", async () => {
  const f = fixture();
  f.playlists.start();

  let addedSongId = "";
  f.adapter.call = async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    f.adapter.inputs.push(input);
    if (input.operation === "identity") {
      return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
    }
    if (input.operation === "trackAdd") {
      addedSongId = (input as any).songId;
      return { ok: true, data: { acknowledged: true } } as any;
    }
    if (input.operation === "playlistDetail") {
      return {
        ok: true,
        data: {
          playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
          songIds: addedSongId ? [addedSongId] : [],
          songs: addedSongId ? [{ id: addedSongId, name: "七里香", artists: ["周杰伦"], album: "七里香" }] : []
        }
      } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  };

  const idempotencyKey = v7();
  const res = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey, songId: "s-202", name: "七里香", artists: ["周杰伦"], album: "七里香"
  });
  expect(res.replay).toBe(false);
  expect(res.operation.status).toBe("queued");

  // 推进时间并 settle 调度
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  // 查询操作状态：歌曲与标签均完成才显示成功
  const op = f.playlists.readOperation("roommate1", f.roomId, res.operation.id);
  expect(op.status).toBe("succeeded");
  expect(op.songConfirmed).toBe(true);
  expect(op.tagConfirmed).toBe(true);

  // 查看歌单快照，包含新增歌曲与室友甲标签
  const view = f.playlists.read("roommate1", f.roomId);
  expect(view.snapshot?.tracks).toHaveLength(1);
  expect(view.snapshot?.tracks[0].songId).toBe("s-202");
  expect(view.snapshot?.tracks[0].requesters).toEqual(["室友甲"]);

  // 验证上游调用：刚好一次 trackAdd
  const trackAddCalls = f.adapter.inputs.filter(i => i.operation === "trackAdd");
  expect(trackAddCalls).toHaveLength(1);
});

it("同一成员在同一房间已有未完成写操作时拒绝第二项不同写入", async () => {
  const f = fixture();
  const key1 = v7();
  // 第一项点歌入队
  const op1 = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: key1, songId: "s-1", name: "歌1", artists: ["歌手"], album: "专1"
  });
  expect(op1.operation.status).toBe("queued");

  // 同一成员尝试提交第二项不同点歌：被拒绝
  expect(() => f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-2", name: "歌2", artists: ["歌手"], album: "专2"
  })).toThrowError("CONCURRENT_OPERATION_LIMIT_EXCEEDED");

  // 相同幂等键相同内容：返回原操作
  const replay = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: key1, songId: "s-1", name: "歌1", artists: ["歌手"], album: "专1"
  });
  expect(replay.replay).toBe(true);
  expect(replay.operation.id).toBe(op1.operation.id);

  // 另一成员可正常提交
  const op2 = f.playlists.requestSong("roommate2", f.roomId, {
    idempotencyKey: v7(), songId: "s-3", name: "歌3", artists: ["歌手"], album: "专3"
  });
  expect(op2.operation.status).toBe("queued");
});

it("有效完整公共刷新确认某歌曲移除时，在同一事务清除该歌曲的全部成员标签；失败刷新保留标签", async () => {
  const f = fixture();
  f.playlists.start();
  // 歌单原有两首歌曲
  f.database.insert(playlistTrack).values([
    { accountId: "acc-owner", playlistId: "pl-public", position: 0, songId: "s-keep", name: "保留曲", artists: JSON.stringify(["歌手"]), album: "专辑" },
    { accountId: "acc-owner", playlistId: "pl-public", position: 1, songId: "s-remove", name: "将被移除曲", artists: JSON.stringify(["歌手"]), album: "专辑" }
  ]).run();

  // 为两首歌曲添加成员标签
  const members = f.database.select().from(roomMembership).where(eq(roomMembership.roomId, f.roomId)).all();
  for (const m of members) {
    f.database.insert(requesterTag).values([
      { roomId: f.roomId, bindingGeneration: 1, songId: "s-keep", memberId: m.id, createdAt: f.now() },
      { roomId: f.roomId, bindingGeneration: 1, songId: "s-remove", memberId: m.id, createdAt: f.now() }
    ]).run();
  }

  expect(f.database.select().from(requesterTag).all()).toHaveLength(6);

  // 模拟刷新失败（网络错误）：标签必须保留
  f.advanceTime(1500);
  f.adapter.call = async () => ({ ok: false, error: { code: "NETWORK_ERROR", outcome: "failed" } });
  await f.playlists.refresh("owner", f.roomId);
  expect(f.database.select().from(requesterTag).all()).toHaveLength(6);

  // 模拟有效完整刷新：网易云只剩 s-keep，s-remove 被移除
  f.advanceTime(1500);
  f.adapter.call = (async () => ({
    ok: true,
    data: {
      playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
      songIds: ["s-keep"],
      songs: [{ id: "s-keep", name: "保留曲", artists: ["歌手"], album: "专辑" }]
    }
  })) as any;

  await f.playlists.refresh("owner", f.roomId);

  // s-remove 的全部标签被清除，s-keep 的 3 个标签全部保留
  const tagsAfter = f.database.select().from(requesterTag).all();
  expect(tagsAfter).toHaveLength(3);
  expect(tagsAfter.every(t => t.songId === "s-keep")).toBe(true);
});

it("歌曲已确认但标签未完成时，恢复只补标签，绝不再次调用 trackAdd", async () => {
  const f = fixture();
  // 歌单已有某歌曲
  f.database.insert(playlistTrack).values({
    accountId: "acc-owner", playlistId: "pl-public", position: 0, songId: "s-half", name: "半完成曲", artists: JSON.stringify(["歌手"]), album: "专辑"
  }).run();

  const opId = v7();
  // 插入一个处于 songConfirmed=true, tagConfirmed=false 的操作
  f.database.insert(operation).values({
    id: opId, kind: "requestPublicSong", userId: "roommate1", roomId: f.roomId, accountId: "acc-owner", authorizationId: f.database.select().from(neteaseAuthorization).get()!.id, generation: 1, status: "queued", createdAt: f.now(), updatedAt: f.now()
  }).run();
  f.database.insert(publicSongRequest).values({
    operationId: opId, songId: "s-half", name: "半完成曲", artists: JSON.stringify(["歌手"]), album: "专辑", step: "tagging", songConfirmed: true, tagConfirmed: false,
    playlistId: "pl-public", bindingGeneration: 1
  }).run();

  const inputsBefore = f.adapter.inputs.length;

  // 启动服务触发恢复
  f.playlists.start();
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  // 验证：绝不调用上游 trackAdd！
  const trackAddCalls = f.adapter.inputs.slice(inputsBefore).filter(i => i.operation === "trackAdd");
  expect(trackAddCalls).toHaveLength(0);

  // 标签已被补齐，操作标记为 succeeded
  const op = f.playlists.readOperation("roommate1", f.roomId, opId);
  expect(op.status).toBe("succeeded");
  expect(op.songConfirmed).toBe(true);
  expect(op.tagConfirmed).toBe(true);

  // 查看快照展示
  const view = f.playlists.read("roommate1", f.roomId);
  expect(view.snapshot?.tracks[0].requesters).toEqual(["室友甲"]);
});

it("5 个确定性终结接缝恢复后，至多调用一次 trackAdd，绝不重发写入", async () => {
  // 接缝 1：before-trackAdd（verified 状态中断并重启恢复）
  {
    const f = fixture();
    const opId = v7();
    f.database.insert(operation).values({
      id: opId, kind: "requestPublicSong", userId: "roommate1", roomId: f.roomId, accountId: "acc-owner", authorizationId: f.database.select().from(neteaseAuthorization).get()!.id, generation: 1, status: "processing", createdAt: f.now(), updatedAt: f.now()
    }).run();
    f.database.insert(publicSongRequest).values({
      operationId: opId, songId: "s-seam-1", name: "接缝1", artists: JSON.stringify(["歌手"]), album: "专辑", step: "verified", songConfirmed: false, tagConfirmed: false,
      playlistId: "pl-public", bindingGeneration: 1
    }).run();

    let trackAddCalls = 0;
    f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
      if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
      if (input.operation === "trackAdd") {
        trackAddCalls++;
        return { ok: true, data: { acknowledged: true } } as any;
      }
      if (input.operation === "playlistDetail") {
        return {
          ok: true,
          data: {
            playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
            songIds: ["s-seam-1"],
            songs: [{ id: "s-seam-1", name: "接缝1", artists: ["歌手"], album: "专辑" }]
          }
        } as any;
      }
      return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
    }) as any;

    // 重启服务恢复：verified 恢复为 ready 并入队，执行一次 trackAdd
    f.playlists.start();
    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();
    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();

    expect(trackAddCalls).toBe(1);
    const op = f.playlists.readOperation("roommate1", f.roomId, opId);
    expect(op.status).toBe("succeeded");
    f.playlists.stop();
  }

  // 接缝 2：after-trackAdd（真实执行 trackAdd 成功后抛出未处理异常崩溃，重启服务恢复）
  {
    const f = fixture();
    let trackAddCalls = 0;
    let detailHasSong = false;

    f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
      if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
      if (input.operation === "trackAdd") {
        trackAddCalls++;
        detailHasSong = true;
        // 模拟调用网易云成功写入后，进程/网络突然中断
        return { ok: false, error: { code: "NETWORK_ERROR", outcome: "unknown" } } as any;
      }
      if (input.operation === "playlistDetail") {
        return {
          ok: true,
          data: {
            playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
            songIds: detailHasSong ? ["s-seam-2"] : [],
            songs: detailHasSong ? [{ id: "s-seam-2", name: "接缝2", artists: ["歌手"], album: "专辑" }] : []
          }
        } as any;
      }
      return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
    }) as any;

    f.playlists.start();
    const req = f.playlists.requestSong("roommate1", f.roomId, {
      idempotencyKey: v7(), songId: "s-seam-2", name: "接缝2", artists: ["歌手"], album: "专辑"
    });

    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();
    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();

    expect(trackAddCalls).toBe(1);
    // 进入 awaitingConfirmation
    const opBeforeRestart = f.playlists.readOperation("roommate1", f.roomId, req.operation.id);
    expect(opBeforeRestart.status).toBe("awaitingConfirmation");

    // 终止当前实例并重启新实例（模拟服务崩溃与重启）
    f.playlists.stop();
    const newPlaylists = new PublicPlaylists(f.database, f.adapter, new CredentialVault(path.join(f.root, "netease.key")), f.scheduler, new EventStreamService(), f.now);
    newPlaylists.start();

    // 触发补查：只能执行只读检查，绝不再次调用 trackAdd
    f.advanceTime(5000);
    newPlaylists.triggerDueChecks();
    await newPlaylists.settle();

    expect(trackAddCalls).toBe(1);
    const opAfter = newPlaylists.readOperation("roommate1", f.roomId, req.operation.id);
    expect(opAfter.status).toBe("succeeded");
    expect(opAfter.songConfirmed).toBe(true);
    expect(opAfter.tagConfirmed).toBe(true);
    newPlaylists.stop();
  }

  // 接缝 3：before-playlistDetail（trackAdd 成功后，读回前异常崩溃并重启服务）
  {
    const f = fixture();
    let trackAddCalls = 0;
    let shouldCrashOnDetail = true;

    f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
      if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
      if (input.operation === "trackAdd") {
        trackAddCalls++;
        return { ok: true, data: { acknowledged: true } } as any;
      }
      if (input.operation === "playlistDetail") {
        if (shouldCrashOnDetail) {
          shouldCrashOnDetail = false;
          throw new Error("Simulated crash right before playlistDetail parsing");
        }
        return {
          ok: true,
          data: {
            playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
            songIds: ["s-seam-3"],
            songs: [{ id: "s-seam-3", name: "接缝3", artists: ["歌手"], album: "专辑" }]
          }
        } as any;
      }
      return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
    }) as any;

    f.playlists.start();
    const req = f.playlists.requestSong("roommate1", f.roomId, {
      idempotencyKey: v7(), songId: "s-seam-3", name: "接缝3", artists: ["歌手"], album: "专辑"
    });

    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();
    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();

    expect(trackAddCalls).toBe(1);
    const opBefore = f.playlists.readOperation("roommate1", f.roomId, req.operation.id);
    expect(opBefore.status).toBe("awaitingConfirmation");

    // 重启服务重建实例
    f.playlists.stop();
    const newPlaylists = new PublicPlaylists(f.database, f.adapter, new CredentialVault(path.join(f.root, "netease.key")), f.scheduler, new EventStreamService(), f.now);
    newPlaylists.start();

    // 只读确认
    f.advanceTime(5000);
    newPlaylists.triggerDueChecks();
    await newPlaylists.settle();

    expect(trackAddCalls).toBe(1);
    const opAfter = newPlaylists.readOperation("roommate1", f.roomId, req.operation.id);
    expect(opAfter.status).toBe("succeeded");
    newPlaylists.stop();
  }

  // 接缝 4：after-playlistDetail（读回返回后，快照校验错误导致进入 awaitingConfirmation）
  {
    const f = fixture();
    let trackAddCalls = 0;
    let detailRound = 0;

    f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
      if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
      if (input.operation === "trackAdd") {
        trackAddCalls++;
        return { ok: true, data: { acknowledged: true } } as any;
      }
      if (input.operation === "playlistDetail") {
        detailRound++;
        if (detailRound === 1) {
          // 首次读回返回 status=10（异常状态）
          return {
            ok: true,
            data: {
              playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 10 },
              songIds: [],
              songs: []
            }
          } as any;
        }
        return {
          ok: true,
          data: {
            playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
            songIds: ["s-seam-4"],
            songs: [{ id: "s-seam-4", name: "接缝4", artists: ["歌手"], album: "专辑" }]
          }
        } as any;
      }
      return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
    }) as any;

    f.playlists.start();
    const req = f.playlists.requestSong("roommate1", f.roomId, {
      idempotencyKey: v7(), songId: "s-seam-4", name: "接缝4", artists: ["歌手"], album: "专辑"
    });

    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();
    f.advanceTime(1500);
    f.scheduler.kick();
    await f.scheduler.settle();

    expect(trackAddCalls).toBe(1);
    const opBefore = f.playlists.readOperation("roommate1", f.roomId, req.operation.id);
    expect(opBefore.status).toBe("awaitingConfirmation");

    // 重启服务重建实例并执行后续补查
    f.playlists.stop();
    const newPlaylists = new PublicPlaylists(f.database, f.adapter, new CredentialVault(path.join(f.root, "netease.key")), f.scheduler, new EventStreamService(), f.now);
    newPlaylists.start();

    f.advanceTime(5000);
    newPlaylists.triggerDueChecks();
    await newPlaylists.settle();

    expect(trackAddCalls).toBe(1);
    const opAfter = newPlaylists.readOperation("roommate1", f.roomId, req.operation.id);
    expect(opAfter.status).toBe("succeeded");
    newPlaylists.stop();
  }

  // 接缝 5：before-tagging（songConfirmed=true, tagConfirmed=false 状态崩溃恢复，仅补标签）
  {
    const f = fixture();
    const opId = v7();
    f.database.insert(operation).values({
      id: opId, kind: "requestPublicSong", userId: "roommate1", roomId: f.roomId, accountId: "acc-owner", authorizationId: f.database.select().from(neteaseAuthorization).get()!.id, generation: 1, status: "queued", createdAt: f.now(), updatedAt: f.now()
    }).run();
    f.database.insert(publicSongRequest).values({
      operationId: opId, songId: "s-seam-5", name: "接缝5", artists: JSON.stringify(["歌手"]), album: "专辑", step: "tagging", songConfirmed: true, tagConfirmed: false,
      playlistId: "pl-public", bindingGeneration: 1
    }).run();

    let trackAddCalls = 0;
    f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
      if (input.operation === "trackAdd") { trackAddCalls++; return { ok: true, data: { acknowledged: true } } as any; }
      return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
    }) as any;

    f.playlists.start();
    expect(trackAddCalls).toBe(0);
    const op = f.playlists.readOperation("roommate1", f.roomId, opId);
    expect(op.status).toBe("succeeded");
    expect(op.songConfirmed).toBe(true);
    expect(op.tagConfirmed).toBe(true);
    f.playlists.stop();
  }
});

it("错误分类：明确拒绝立即终结为失败，不进入补查；未知错误与网络/超时进入 awaitingConfirmation 并启动补查", async () => {
  const f = fixture();
  f.playlists.start();

  // 1. 明确拒绝（outcome: "failed"，如 TARGET_PERMISSION）
  f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
    if (input.operation === "trackAdd") {
      return { ok: false, error: { code: "TARGET_PERMISSION", outcome: "failed" } } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  }) as any;

  const resFail = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-fail", name: "失败歌", artists: ["歌手"], album: "专辑"
  });

  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  const opFail = f.playlists.readOperation("roommate1", f.roomId, resFail.operation.id);
  expect(opFail.status).toBe("needsAdministrator");
  expect(opFail.step).toBe("rejected");
  expect(opFail.errorCode).toBe("TARGET_PERMISSION");

  // 清理上一操作，避免成员并发限制
  f.database.delete(operation).where(eq(operation.id, resFail.operation.id)).run();

  // 1.1 明确业务拒绝（outcome: "failed"，如 INVALID_INPUT）终结为 failed
  f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
    if (input.operation === "trackAdd") {
      return { ok: false, error: { code: "INVALID_INPUT", outcome: "failed" } } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  }) as any;

  const resInvalid = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-invalid", name: "非法歌", artists: ["歌手"], album: "专辑"
  });

  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  const opInvalid = f.playlists.readOperation("roommate1", f.roomId, resInvalid.operation.id);
  expect(opInvalid.status).toBe("failed");
  expect(opInvalid.step).toBe("rejected");
  expect(opInvalid.errorCode).toBe("INVALID_INPUT");

  // 2. 未知错误（outcome: "unknown"，如 DEADLINE 超时）
  f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
    if (input.operation === "trackAdd") {
      return { ok: false, error: { code: "DEADLINE", outcome: "unknown" } } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  }) as any;

  const resUnknown = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-unknown", name: "未知歌", artists: ["歌手"], album: "专辑"
  });

  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  const opUnknown = f.playlists.readOperation("roommate1", f.roomId, resUnknown.operation.id);
  expect(opUnknown.status).toBe("awaitingConfirmation");
  expect(opUnknown.step).toBe("unknown");
  expect(opUnknown.errorCode).toBe("DEADLINE");

  // 3. 读回矛盾（trackAdd 成功，但写后读回快照未出现该歌曲）
  f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
    if (input.operation === "trackAdd") return { ok: true, data: { acknowledged: true } } as any;
    if (input.operation === "playlistDetail") {
      return {
        ok: true,
        data: {
          playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
          songIds: [],
          songs: []
        }
      } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  }) as any;

  // 先清空前面的 awaitingConfirmation，避免 TARGET_BLOCKED 冲突
  f.database.delete(operation).where(eq(operation.id, resUnknown.operation.id)).run();

  const resDiscrepancy = f.playlists.requestSong("roommate2", f.roomId, {
    idempotencyKey: v7(), songId: "s-discrepancy", name: "矛盾歌", artists: ["歌手"], album: "专辑"
  });

  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  const opDiscrepancy = f.playlists.readOperation("roommate2", f.roomId, resDiscrepancy.operation.id);
  expect(opDiscrepancy.status).toBe("awaitingConfirmation");
  expect(opDiscrepancy.step).toBe("unknown");
});

it("3 轮只读补查机制：约 5s, 30s, 2min 推进，若未证实则停止自动请求保持 awaitingConfirmation", async () => {
  const f = fixture();
  f.playlists.start();

  let trackAddCalls = 0;
  let detailCalls = 0;
  let detailHasSong = false;

  f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
    if (input.operation === "trackAdd") {
      trackAddCalls++;
      return { ok: false, error: { code: "NETWORK_ERROR", outcome: "unknown" } } as any;
    }
    if (input.operation === "playlistDetail") {
      detailCalls++;
      return {
        ok: true,
        data: {
          playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
          songIds: detailHasSong ? ["s-check"] : [],
          songs: detailHasSong ? [{ id: "s-check", name: "补查歌", artists: ["歌手"], album: "专辑" }] : []
        }
      } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  }) as any;

  const res = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-check", name: "补查歌", artists: ["歌手"], album: "专辑"
  });

  // 执行写入，遭遇 NETWORK_ERROR
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  expect(trackAddCalls).toBe(1);
  const detail1 = f.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, res.operation.id)).get()!;
  expect(detail1.checkRound).toBe(0);
  expect(detail1.nextCheckAt).not.toBeNull();
  expect(detail1.nextCheckAt! - f.now()).toBeLessThanOrEqual(5000);

  // 第 1 轮补查（5 秒后）
  f.advanceTime(5000);
  f.playlists.triggerDueChecks();
  await f.playlists.settle();
  expect(detailCalls).toBe(1);
  const detailAfterRound1 = f.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, res.operation.id)).get()!;
  expect(detailAfterRound1.checkRound).toBe(1);
  expect(detailAfterRound1.nextCheckAt! - f.now()).toBeLessThanOrEqual(30000);
  expect(detailAfterRound1.nextCheckAt! - f.now()).toBeGreaterThan(25000);

  // 第 2 轮补查（30 秒后）
  f.advanceTime(30000);
  f.playlists.triggerDueChecks();
  await f.playlists.settle();
  expect(detailCalls).toBe(2);
  const detailAfterRound2 = f.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, res.operation.id)).get()!;
  expect(detailAfterRound2.checkRound).toBe(2);
  expect(detailAfterRound2.nextCheckAt! - f.now()).toBeLessThanOrEqual(120000);
  expect(detailAfterRound2.nextCheckAt! - f.now()).toBeGreaterThan(115000);

  // 第 3 轮补查（120 秒后）
  f.advanceTime(120000);
  f.playlists.triggerDueChecks();
  await f.playlists.settle();
  expect(detailCalls).toBe(3);
  const detailAfterRound3 = f.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, res.operation.id)).get()!;
  expect(detailAfterRound3.checkRound).toBe(3);
  expect(detailAfterRound3.nextCheckAt).toBeNull();

  // 3 轮补查完毕后保持 awaitingConfirmation 并停止自动请求，绝无额外 trackAdd
  const opFinal = f.playlists.readOperation("roommate1", f.roomId, res.operation.id);
  expect(opFinal.status).toBe("awaitingConfirmation");
  expect(trackAddCalls).toBe(1);

  // 此时若在页面手动刷新歌单（网易云已延迟入库）
  detailHasSong = true;
  await f.playlists.refresh("roommate1", f.roomId);

  // 手动刷新提交权威快照时，点歌请求被自动证实并补记标签成功！
  const opAfterRefresh = f.playlists.readOperation("roommate1", f.roomId, res.operation.id);
  expect(opAfterRefresh.status).toBe("succeeded");
  expect(opAfterRefresh.songConfirmed).toBe(true);
  expect(opAfterRefresh.tagConfirmed).toBe(true);
});

it("目标冲突隔离：awaitingConfirmation 仅阻塞同一规范化歌单的写入（抛出 TARGET_BLOCKED 409），允许读取和手动刷新", async () => {
  const f = fixture();
  // 在 f.roomId 上插入一个处于 awaitingConfirmation 的点歌操作
  const opId = v7();
  f.database.insert(operation).values({
    id: opId, kind: "requestPublicSong", userId: "roommate1", roomId: f.roomId, accountId: "acc-owner", authorizationId: f.database.select().from(neteaseAuthorization).get()!.id, generation: 1, status: "awaitingConfirmation", createdAt: f.now(), updatedAt: f.now()
  }).run();
  f.database.insert(publicSongRequest).values({
    operationId: opId, songId: "s-blocked", name: "阻塞歌", artists: JSON.stringify(["歌手"]), album: "专辑", step: "unknown", songConfirmed: false, tagConfirmed: false,
    playlistId: "pl-public", bindingGeneration: 1, checkRound: 0, nextCheckAt: f.now() + 5000
  }).run();

  // 查看 view：disabledReason 为 TARGET_BLOCKED，allowedActions 包含 refreshPublicPlaylist 但不包含 requestSong
  const view = f.playlists.read("roommate2", f.roomId);
  expect(view.disabledReason).toBe("TARGET_BLOCKED");
  expect(view.allowedActions).toContain("refreshPublicPlaylist");
  expect(view.allowedActions).not.toContain("requestSong");

  // 原提交者（室友甲）使用新键尝试点歌：也被 TARGET_BLOCKED 409 拒绝（目标歌单阻塞优先于成员单次操作限制）
  expect(() => f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-new-1", name: "原提交者新歌", artists: ["歌手"], album: "专辑"
  })).toThrowError("TARGET_BLOCKED");

  // 室友乙尝试点歌：同样被 TARGET_BLOCKED 409 拒绝
  expect(() => f.playlists.requestSong("roommate2", f.roomId, {
    idempotencyKey: v7(), songId: "s-new", name: "新歌", artists: ["歌手"], album: "专辑"
  })).toThrowError("TARGET_BLOCKED");

  // 创建第二个房间，绑定不同的歌单目标 pl-other
  const room2Id = v7();
  f.database.insert(room).values({ id: room2Id, ownerUserId: "owner", name: "二号宿舍" }).run();
  f.database.insert(roomMembership).values([
    { id: v7(), roomId: room2Id, userId: "owner", nickname: "房主" },
    { id: v7(), roomId: room2Id, userId: "roommate2", nickname: "室友乙" }
  ]).run();
  f.database.insert(publicPlaylistBinding).values({
    roomId: room2Id, accountId: "acc-owner", playlistId: "pl-other", name: "songroom-二号宿舍-公共", creationOperationId: v7(), generation: 1
  }).run();
  f.database.insert(playlistSnapshot).values({
    accountId: "acc-owner", playlistId: "pl-other", snapshotVersion: 1, syncedAt: f.now(), createdAt: f.now(), updatedAt: f.now()
  }).run();

  // 二号房间未受阻塞，可以正常点歌！
  const view2 = f.playlists.read("roommate2", room2Id);
  expect(view2.disabledReason).toBe("PUBLIC_PLAYLIST_EXISTS");
  expect(view2.allowedActions).toContain("requestSong");

  const res2 = f.playlists.requestSong("roommate2", room2Id, {
    idempotencyKey: v7(), songId: "s-other", name: "他房歌", artists: ["歌手"], album: "专辑"
  });
  expect(res2.operation.status).toBe("queued");
});

it("幂等冲突与操作键校验：相同 key 相同内容重放，不同内容 409，过期 key 拒绝", async () => {
  const f = fixture();
  const idempotencyKey = v7();

  const res1 = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey, songId: "s-1", name: "歌1", artists: ["歌手1"], album: "专辑1"
  });
  expect(res1.replay).toBe(false);

  // 相同幂等键相同内容：重放
  const resReplay = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey, songId: "s-1", name: "歌1", artists: ["歌手1"], album: "专辑1"
  });
  expect(resReplay.replay).toBe(true);
  expect(resReplay.operation.id).toBe(res1.operation.id);

  // 相同幂等键不同内容（不同歌名）：409 IDEMPOTENCY_CONFLICT
  expect(() => f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey, songId: "s-1", name: "不同歌名", artists: ["歌手1"], album: "专辑1"
  })).toThrowError("IDEMPOTENCY_CONFLICT");

  // 过期幂等键（超过 24 小时前创建的 UUIDv7）：400 IDEMPOTENCY_KEY_EXPIRED
  const expiredKey = v7({ msecs: f.now() - 25 * 3600 * 1000 });
  expect(() => f.playlists.requestSong("roommate2", f.roomId, {
    idempotencyKey: expiredKey, songId: "s-expired", name: "过期歌", artists: ["歌手"], album: "专辑"
  })).toThrowError("IDEMPOTENCY_KEY_EXPIRED");
});

it("标签补记隔离与当前条件重新校验：成员退出或歌单解绑后停止并不补记标签", async () => {
  const f = fixture();
  const opId = v7();
  f.database.insert(operation).values({
    id: opId, kind: "requestPublicSong", userId: "roommate1", roomId: f.roomId, accountId: "acc-owner", authorizationId: f.database.select().from(neteaseAuthorization).get()!.id, generation: 1, status: "queued", createdAt: f.now(), updatedAt: f.now()
  }).run();
  f.database.insert(publicSongRequest).values({
    operationId: opId, songId: "s-tag-check", name: "标签校验歌", artists: JSON.stringify(["歌手"]), album: "专辑", step: "tagging", songConfirmed: true, tagConfirmed: false,
    playlistId: "pl-public", bindingGeneration: 1
  }).run();

  // 室友甲退出了房间
  f.database.delete(roomMembership).where(and(eq(roomMembership.roomId, f.roomId), eq(roomMembership.userId, "roommate1"))).run();

  // 启动服务触发恢复
  f.playlists.start();

  // 操作被置为 stopped，并且未写入 requesterTag
  const op = f.database.select().from(operation).where(eq(operation.id, opId)).get()!;
  expect(op.status).toBe("stopped");
  const tags = f.database.select().from(requesterTag).where(eq(requesterTag.songId, "s-tag-check")).all();
  expect(tags).toHaveLength(0);
});

it("权限控制：撤销成员资格或非提交者无法读取操作详情", async () => {
  const f = fixture();
  const res = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-auth", name: "权限歌", artists: ["歌手"], album: "专辑"
  });

  // 提交者本人可以读取
  const op = f.playlists.readOperation("roommate1", f.roomId, res.operation.id);
  expect(op.id).toBe(res.operation.id);

  // 室友乙无法读取室友甲的操作（404 OPERATION_NOT_FOUND）
  expect(() => f.playlists.readOperation("roommate2", f.roomId, res.operation.id)).toThrowError("OPERATION_NOT_FOUND");

  // 局外人无法读取（404 ROOM_UNAVAILABLE）
  expect(() => f.playlists.readOperation("outsider", f.roomId, res.operation.id)).toThrowError("ROOM_UNAVAILABLE");

  // 室友甲被移除后无法读取（404 ROOM_UNAVAILABLE）
  f.database.delete(roomMembership).where(and(eq(roomMembership.roomId, f.roomId), eq(roomMembership.userId, "roommate1"))).run();
  expect(() => f.playlists.readOperation("roommate1", f.roomId, res.operation.id)).toThrowError("ROOM_UNAVAILABLE");
});

it("读回快照数据结构校验失败（PARSE_ERROR）时，绝不误标成功，保持 awaitingConfirmation 并推进补查", async () => {
  const f = fixture();
  let trackAddCalls = 0;

  f.adapter.call = (async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    if (input.operation === "identity") return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as any;
    if (input.operation === "trackAdd") {
      trackAddCalls++;
      return { ok: true, data: { acknowledged: true } } as any;
    }
    if (input.operation === "playlistDetail") {
      // 模拟上游返回畸形数据（songIds 包含该歌，但 songs 内部字段为空或与 songIds 不一致，被 commitSnapshot 校验拦截为 PARSE_ERROR）
      return {
        ok: true,
        data: {
          playlist: { id: "pl-public", name: "公共歌单", creatorId: "acc-owner", subscribed: false, status: 0 },
          songIds: ["s-malformed"],
          songs: [{ id: "s-mismatched", name: "", artists: ["歌手"], album: "" }]
        }
      } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  }) as any;

  f.playlists.start();
  const req = f.playlists.requestSong("roommate1", f.roomId, {
    idempotencyKey: v7(), songId: "s-malformed", name: "畸形歌", artists: ["歌手"], album: "专辑"
  });

  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();
  f.advanceTime(1500);
  f.scheduler.kick();
  await f.scheduler.settle();

  expect(trackAddCalls).toBe(1);
  const op = f.playlists.readOperation("roommate1", f.roomId, req.operation.id);
  // 绝不能因为 songIds 中含该歌就错误标记为 succeeded！必须保持 awaitingConfirmation
  expect(op.status).toBe("awaitingConfirmation");
  expect(op.songConfirmed).toBe(false);
  expect(op.tagConfirmed).toBe(false);
  f.playlists.stop();
});
