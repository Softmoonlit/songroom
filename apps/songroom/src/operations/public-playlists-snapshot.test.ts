import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { v7 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { neteaseAuthorization, playlistSnapshot, playlistTrack, publicPlaylistBinding, room, roomMembership, user } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { PublicPlaylists } from "./public-playlists.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { EventStreamService } from "../events/event-stream.js";

class MockAdapter implements NeteaseAdapter {
  inputs: AdapterInput[] = [];
  identity: (input: Extract<AdapterInput, { operation: "identity" }>) => Promise<AdapterResult<"identity">> = async () => ({
    ok: true,
    data: { accountId: "cloud-owner", name: "房主" }
  });
  create: (input: Extract<AdapterInput, { operation: "playlistCreate" }>) => Promise<AdapterResult<"playlistCreate">> = async () => ({
    ok: true,
    data: { playlistId: "cloud-playlist" }
  });
  detail: (input: Extract<AdapterInput, { operation: "playlistDetail" }>) => Promise<AdapterResult<"playlistDetail">> = async () => ({
    ok: true,
    data: {
      playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
      songIds: ["song-1", "song-2"],
      songs: [
        { id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
        { id: "song-2", name: "七里香", artists: ["周杰伦"], album: "七里香" }
      ]
    }
  });
  userPlaylists: (input: Extract<AdapterInput, { operation: "userPlaylists" }>) => Promise<AdapterResult<"userPlaylists">> = async () => ({
    ok: true,
    data: { playlists: [], more: false }
  });

  async assertVendorIntegrity() {}
  async dispose() {}
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);
    if (input.operation === "identity") return await this.identity(input) as AdapterResult<I["operation"]>;
    if (input.operation === "userPlaylists") return await this.userPlaylists(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistCreate") return await this.create(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistDetail") return await this.detail(input) as AdapterResult<I["operation"]>;
    throw new Error(`unexpected adapter call ${input.operation}`);
  }
}

const fixtures: Array<{ root: string; database: AppDatabase; modules: PublicPlaylists[] }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const module of fixture.modules) { module.stop(); await module.settle(); }
    fixture.database.$client.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-snap-test-"));
  const dbPath = path.join(root, "app.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "key");
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);

  for (const id of ["owner", "member", "outsider"]) {
    database.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date()
    }).run();
  }

  const roomId = v7();
  database.insert(room).values({ id: roomId, name: "宿舍", ownerUserId: "owner" }).run();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "owner", nickname: "房主" }).run();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "member", nickname: "室友" }).run();

  const authorizationId = v7();
  const scope = { authorizationId, accountId: "cloud-owner", generation: 1 };
  database.insert(neteaseAuthorization).values({
    id: authorizationId,
    userId: "owner",
    accountId: scope.accountId,
    generation: 1,
    nickname: "房主",
    status: "active",
    credentials: vault.encrypt("MUSIC_U=owner", scope)
  }).run();

  const adapter = new MockAdapter();
  const modules: PublicPlaylists[] = [];
  fixtures.push({ root, database, modules });

  let timeOffset = 0;
  const now = () => Date.now() + timeOffset;

  function module() {
    const scheduler = new UpstreamScheduler(database, now);
    const eventStream = new EventStreamService();
    const result = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, now);
    modules.push(result);
    return result;
  }

  return { database, adapter, roomId, module, authorizationId, vault, advanceTime: (ms: number) => { timeOffset += ms; } };
}

describe("09: 读取并刷新权威公共歌单快照", () => {
  it("没有快照时显示首次同步状态，区分于已同步的空歌单", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 尚未绑定歌单
    const viewUnbound = service.read("owner", f.roomId);
    expect(viewUnbound.playlist).toBeNull();
    expect(viewUnbound.snapshot).toBeNull();

    // 绑定歌单但尚未完成首次同步 (syncedAt === null)
    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();
    f.database.insert(playlistSnapshot).values({
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      snapshotVersion: 0,
      syncedAt: null,
      lastErrorCode: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();

    const viewInitial = service.read("owner", f.roomId);
    expect(viewInitial.playlist).toEqual({ id: "cloud-playlist", name: "songroom-宿舍-公共" });
    expect(viewInitial.snapshot).toEqual({
      version: 0,
      syncedAt: null,
      trackCount: 0,
      tracks: []
    });

    // 首次同步成功但云端实际为空歌单 (syncedAt !== null, trackCount: 0)
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: [],
        songs: []
      }
    });

    f.advanceTime(1500);
    const refreshed = await service.refresh("member", f.roomId);
    expect(refreshed.snapshot).toMatchObject({
      version: 1,
      syncedAt: expect.any(Number),
      trackCount: 0,
      tracks: []
    });
    expect(refreshed.snapshot?.syncedAt).not.toBeNull();
  });

  it("有效完整读取以事务生成单调版本并替换集合与顺序，包含歌曲详细字段", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 第一次刷新：包含 2 首歌
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: ["s1", "s2"],
        songs: [
          { id: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
          { id: "s2", name: "七里香", artists: ["周杰伦"], album: "七里香" }
        ]
      }
    });

    f.advanceTime(1500);
    const view1 = await service.refresh("member", f.roomId);
    expect(view1.snapshot?.version).toBe(1);
    expect(view1.snapshot?.tracks).toEqual([
      { position: 0, songId: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: [] },
      { position: 1, songId: "s2", name: "七里香", artists: ["周杰伦"], album: "七里香", requesters: [] }
    ]);

    // 第二次刷新：云端顺序调整，移除 s1，新增 s3
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: ["s2", "s3"],
        songs: [
          { id: "s2", name: "七里香", artists: ["周杰伦"], album: "七里香" },
          { id: "s3", name: "稻香", artists: ["周杰伦"], album: "魔杰座" }
        ]
      }
    });

    f.advanceTime(1500);
    const view2 = await service.refresh("owner", f.roomId);
    expect(view2.snapshot?.version).toBe(2);
    expect(view2.snapshot?.tracks).toEqual([
      { position: 0, songId: "s2", name: "七里香", artists: ["周杰伦"], album: "七里香", requesters: [] },
      { position: 1, songId: "s3", name: "稻香", artists: ["周杰伦"], album: "魔杰座", requesters: [] }
    ]);

    // 数据库中不再存在的 s1 已被清理
    const tracks = f.database.select().from(playlistTrack).all();
    expect(tracks.map(t => t.songId)).toEqual(["s2", "s3"]);
  });

  it("同目标并发刷新合并为一次调度工作，但房间权限独立", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    let adapterCalls = 0;
    f.adapter.detail = async () => {
      adapterCalls++;
      await new Promise(r => setTimeout(r, 50));
      return {
        ok: true,
        data: {
          playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
          songIds: ["s1"],
          songs: [{ id: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
        }
      };
    };

    f.advanceTime(1500);

    // 两个成员并发刷新同一目标
    const [res1, res2] = await Promise.all([
      service.refresh("member", f.roomId),
      service.refresh("owner", f.roomId)
    ]);

    // 只有一次上游调用
    expect(adapterCalls).toBe(1);
    // 两个成员均得到成功快照
    expect(res1.snapshot?.version).toBe(1);
    expect(res2.snapshot?.version).toBe(1);
    expect(res1.playlist?.name).toBe("songroom-宿舍-公共");
    expect(res2.playlist?.name).toBe("songroom-宿舍-公共");
  });

  it("读取失败保留最后快照和同步时间并明确标记未更新，不解绑目标且不清除歌曲", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 初始成功同步
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: ["s1"],
        songs: [{ id: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
      }
    });

    f.advanceTime(1500);
    const initial = await service.refresh("owner", f.roomId);
    expect(initial.snapshot?.version).toBe(1);
    const lastSyncedAt = initial.snapshot!.syncedAt;

    // 模拟 502 / NETWORK_ERROR
    f.adapter.detail = async () => ({
      ok: false,
      error: { code: "NETWORK_ERROR", outcome: "unknown", httpStatus: 502 }
    });

    f.advanceTime(1500);
    const failedView = await service.refresh("owner", f.roomId);

    // 快照版本与时间未变，歌曲仍保留
    expect(failedView.snapshot?.version).toBe(1);
    expect(failedView.snapshot?.syncedAt).toBe(lastSyncedAt);
    expect(failedView.snapshot?.tracks).toHaveLength(1);
    // 明确标记最后刷新失败
    expect(failedView.lastRefreshError).toBe("NETWORK_ERROR");
    // 绑定未被解除
    expect(failedView.playlist).not.toBeNull();
  });

  it("默认截断列表与部分 tracks 拒绝作为有效快照，不覆盖已有快照", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 初始有效快照
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: ["s1", "s2"],
        songs: [
          { id: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
          { id: "s2", name: "七里香", artists: ["周杰伦"], album: "七里香" }
        ]
      }
    });

    f.advanceTime(1500);
    await service.refresh("owner", f.roomId);

    // 上游返回部分 tracks (songIds 2 首，songs 只有 1 首)
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: ["s1", "s2"],
        songs: [
          { id: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }
        ]
      }
    });

    f.advanceTime(1500);
    const partialView = await service.refresh("owner", f.roomId);
    expect(partialView.lastRefreshError).toBe("PARSE_ERROR");
    expect(partialView.snapshot?.version).toBe(1);
    expect(partialView.snapshot?.tracks).toHaveLength(2);

    // 上游返回已删除对象墓碑状态 (status 10)
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 10 },
        songIds: ["s1"],
        songs: [{ id: "s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
      }
    });

    f.advanceTime(1500);
    const tombstoneView = await service.refresh("owner", f.roomId);
    expect(tombstoneView.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(tombstoneView.snapshot?.version).toBe(1);
    expect(tombstoneView.snapshot?.tracks).toHaveLength(2);
  });

  it("权限隔离：房间外用户无法读取或触发刷新，且接口不接受任意目标参数", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    expect(() => service.read("outsider", f.roomId)).toThrowError("ROOM_UNAVAILABLE");
    await expect(service.refresh("outsider", f.roomId)).rejects.toThrowError("ROOM_UNAVAILABLE");
  });

  it("10,000 首快照本地替换在 3 秒性能工作点内完成，无 OOM 或死锁", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 生成 10,000 首歌曲
    const count = 10_000;
    const songIds: string[] = [];
    const songs: Array<{ id: string; name: string; artists: string[]; album: string }> = [];
    for (let i = 0; i < count; i++) {
      const id = `song-${i}`;
      songIds.push(id);
      songs.push({
        id,
        name: `歌曲名称第${i}首`,
        artists: ["歌手A", "歌手B"],
        album: `专辑${i % 100}`
      });
    }

    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds,
        songs
      }
    });

    f.advanceTime(1500);
    const startTime = performance.now();
    const result = await service.refresh("owner", f.roomId);
    const duration = performance.now() - startTime;

    expect(duration).toBeLessThan(3000); // 严格低于 3000ms
    expect(result.snapshot?.trackCount).toBe(10_000);
    expect(result.snapshot?.tracks).toHaveLength(10_000);
    expect(result.snapshot?.version).toBe(1);

    // 再次替换为另外 10,000 首并验证耗时
    const newSongs = songs.slice().reverse().map((s, idx) => ({ ...s, position: idx }));
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: newSongs.map(s => s.id),
        songs: newSongs
      }
    });

    f.advanceTime(1500);
    const secondStart = performance.now();
    const secondResult = await service.refresh("owner", f.roomId);
    const secondDuration = performance.now() - secondStart;

    expect(secondDuration).toBeLessThan(3000);
    expect(secondResult.snapshot?.version).toBe(2);
    expect(secondResult.snapshot?.trackCount).toBe(10_000);
  });
});
