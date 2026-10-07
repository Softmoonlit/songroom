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
    operationId: opId, songId: "s-half", name: "半完成曲", artists: JSON.stringify(["歌手"]), album: "专辑", step: "tagging", songConfirmed: true, tagConfirmed: false
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
