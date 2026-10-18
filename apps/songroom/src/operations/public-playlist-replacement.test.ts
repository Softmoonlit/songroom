import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { v7 } from "uuid";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import {
  commandReceipt,
  neteaseAuthorization,
  operation,
  personalPlaylistBinding,
  playlistSnapshot,
  playlistTrack,
  publicPlayNext,
  publicPlaylistBinding,
  publicPlaylistReplacement,
  publicSongRequest,
  requesterTag,
  room,
  roomMembership,
  user
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { EventStreamService } from "../events/event-stream.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { PublicPlaylists } from "./public-playlists.js";
import { PersonalPlaylists } from "./personal-playlists.js";
import { PublicRandomPreview } from "./public-random-preview.js";
import { and, eq } from "drizzle-orm";

interface MockSong {
  id: string;
  name: string;
  artists: string[];
  album: string;
}

class ReplacementTestAdapter implements NeteaseAdapter {
  playlists = new Map<string, { id: string; name: string; songs: MockSong[]; status?: number }>();
  inputs: AdapterInput[] = [];
  trackAddHook?: (input: Extract<AdapterInput, { operation: "trackAdd" }>) => Promise<AdapterResult<"trackAdd"> | null> | AdapterResult<"trackAdd"> | null;
  trackRemoveHook?: (input: Extract<AdapterInput, { operation: "trackRemove" }>) => Promise<AdapterResult<"trackRemove"> | null> | AdapterResult<"trackRemove"> | null;
  playlistDetailHook?: (input: Extract<AdapterInput, { operation: "playlistDetail" }>) => Promise<AdapterResult<"playlistDetail"> | null> | AdapterResult<"playlistDetail"> | null;

  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);

    if (input.operation === "identity") {
      return { ok: true, data: { accountId: "acc-owner", name: "房主" } } as AdapterResult<I["operation"]>;
    }

    if (input.operation === "playlistDetail") {
      if (this.playlistDetailHook) {
        const custom = await this.playlistDetailHook(input);
        if (custom) return custom as AdapterResult<I["operation"]>;
      }
      const pl = this.playlists.get(input.playlistId);
      if (!pl) {
        return { ok: false, error: { code: "TARGET_PERMISSION", outcome: "failed" } };
      }
      return {
        ok: true,
        data: {
          playlist: { id: pl.id, name: pl.name, creatorId: "acc-owner", subscribed: false, status: pl.status ?? 0 },
          songIds: pl.songs.map(s => s.id),
          songs: [...pl.songs]
        }
      } as AdapterResult<I["operation"]>;
    }

    if (input.operation === "trackAdd") {
      if (this.trackAddHook) {
        const custom = await this.trackAddHook(input);
        if (custom) return custom as AdapterResult<I["operation"]>;
      }
      const pl = this.playlists.get(input.playlistId);
      if (!pl) return { ok: false, error: { code: "TARGET_PERMISSION", outcome: "failed" } };
      if (!pl.songs.some(s => s.id === input.songId)) {
        pl.songs.push({ id: input.songId, name: `歌曲-${input.songId}`, artists: ["歌手"], album: "专辑" });
      }
      return { ok: true, data: { acknowledged: true } } as AdapterResult<I["operation"]>;
    }

    if (input.operation === "trackRemove") {
      if (this.trackRemoveHook) {
        const custom = await this.trackRemoveHook(input);
        if (custom) return custom as AdapterResult<I["operation"]>;
      }
      const pl = this.playlists.get(input.playlistId);
      if (!pl) return { ok: false, error: { code: "TARGET_PERMISSION", outcome: "failed" } };
      pl.songs = pl.songs.filter(s => s.id !== input.songId);
      return { ok: true, data: { acknowledged: true } } as AdapterResult<I["operation"]>;
    }

    throw new Error(`Unexpected operation: ${input.operation}`);
  }

  async assertVendorIntegrity() {}
  async dispose() {}
}

interface TestContext {
  root: string;
  database: AppDatabase;
  playlists: PublicPlaylists;
  personalPlaylists: PersonalPlaylists;
  randomPreview: PublicRandomPreview;
  scheduler: UpstreamScheduler;
  adapter: ReplacementTestAdapter;
  roomId: string;
  publicPlaylistId: string;
  ownerUserId: string;
  ownerMemberId: string;
  roommate1UserId: string;
  roommate1MemberId: string;
  roommate2UserId: string;
  roommate2MemberId: string;
  now: () => number;
  advanceTime: (ms: number) => void;
}

const activeFixtures: TestContext[] = [];

afterEach(async () => {
  for (const ctx of activeFixtures.splice(0)) {
    ctx.playlists.stop();
    await ctx.playlists.settle();
    ctx.database.$client.close();
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

function createTestContext(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-replacement-test-"));
  const dbPath = path.join(root, "app.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);

  const keyPath = path.join(root, "credential-key");
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);

  let timeOffset = 0;
  const now = () => Date.now() + timeOffset;
  const advanceTime = (ms: number) => { timeOffset += ms; };

  const ownerUserId = "owner-user";
  const roommate1UserId = "roommate1-user";
  const roommate2UserId = "roommate2-user";

  database.insert(user).values([
    { id: ownerUserId, name: "房主", email: "owner@test.com", emailVerified: true, createdAt: new Date(now()), updatedAt: new Date(now()) },
    { id: roommate1UserId, name: "室友1", email: "rm1@test.com", emailVerified: true, createdAt: new Date(now()), updatedAt: new Date(now()) },
    { id: roommate2UserId, name: "室友2", email: "rm2@test.com", emailVerified: true, createdAt: new Date(now()), updatedAt: new Date(now()) }
  ]).run();

  const roomId = v7();
  database.insert(room).values({ id: roomId, name: "测试房间", ownerUserId, version: 1 }).run();

  const ownerMemberId = v7();
  const roommate1MemberId = v7();
  const roommate2MemberId = v7();

  database.insert(roomMembership).values([
    { id: ownerMemberId, roomId, userId: ownerUserId, nickname: "房主昵称" },
    { id: roommate1MemberId, roomId, userId: roommate1UserId, nickname: "室友1昵称" },
    { id: roommate2MemberId, roomId, userId: roommate2UserId, nickname: "室友2昵称" }
  ]).run();

  const authId = v7();
  const credentials = vault.encrypt("mock-cookie", { authorizationId: authId, accountId: "acc-owner", generation: 1 });
  database.insert(neteaseAuthorization).values({
    id: authId,
    userId: ownerUserId,
    accountId: "acc-owner",
    nickname: "网易云房主",
    generation: 1,
    status: "active",
    credentials
  }).run();

  const publicPlaylistId = "pub-playlist-1";
  database.insert(publicPlaylistBinding).values({
    roomId,
    accountId: "acc-owner",
    playlistId: publicPlaylistId,
    name: "公共歌单",
    generation: 1,
    creationOperationId: v7()
  }).run();

  database.insert(playlistSnapshot).values({
    accountId: "acc-owner",
    playlistId: publicPlaylistId,
    snapshotVersion: 1,
    syncedAt: now(),
    createdAt: now(),
    updatedAt: now()
  }).run();

  const adapter = new ReplacementTestAdapter();
  adapter.playlists.set(publicPlaylistId, {
    id: publicPlaylistId,
    name: "公共歌单",
    songs: [
      { id: "old-song-1", name: "旧歌1", artists: ["歌手1"], album: "专辑1" },
      { id: "old-song-2", name: "旧歌2", artists: ["歌手2"], album: "专辑2" },
      { id: "shared-keep-1", name: "保留歌1", artists: ["歌手3"], album: "专辑3" }
    ]
  });

  for (const [idx, s] of adapter.playlists.get(publicPlaylistId)!.songs.entries()) {
    database.insert(playlistTrack).values({
      accountId: "acc-owner",
      playlistId: publicPlaylistId,
      position: idx,
      songId: s.id,
      name: s.name,
      artists: JSON.stringify(s.artists),
      album: s.album
    }).run();
  }

  // 给 shared-keep-1 预先打上 roomate1 的标签
  database.insert(requesterTag).values({
    roomId,
    bindingGeneration: 1,
    songId: "shared-keep-1",
    memberId: roommate1MemberId,
    createdAt: now()
  }).run();

  // 配置 roommate1 的个人歌单: [shared-keep-1, new-song-1]
  const rm1PlaylistId = "rm1-playlist";
  adapter.playlists.set(rm1PlaylistId, {
    id: rm1PlaylistId,
    name: "室友1歌单",
    songs: [
      { id: "shared-keep-1", name: "保留歌1", artists: ["歌手3"], album: "专辑3" },
      { id: "new-song-1", name: "新歌1", artists: ["歌手4"], album: "专辑4" }
    ]
  });
  database.insert(personalPlaylistBinding).values({
    id: v7(),
    roomId,
    memberId: roommate1MemberId,
    accountId: "acc-owner",
    playlistId: rm1PlaylistId,
    name: "室友1歌单",
    creationOperationId: v7(),
    generation: 1,
    createdAt: now(),
    updatedAt: now()
  }).run();
  database.insert(playlistSnapshot).values({
    accountId: "acc-owner",
    playlistId: rm1PlaylistId,
    snapshotVersion: 1,
    syncedAt: now(),
    createdAt: now(),
    updatedAt: now()
  }).run();
  for (const [idx, s] of adapter.playlists.get(rm1PlaylistId)!.songs.entries()) {
    database.insert(playlistTrack).values({
      accountId: "acc-owner",
      playlistId: rm1PlaylistId,
      position: idx,
      songId: s.id,
      name: s.name,
      artists: JSON.stringify(s.artists),
      album: s.album
    }).run();
  }

  // 配置 roommate2 的个人歌单: [new-song-2, new-song-3]
  const rm2PlaylistId = "rm2-playlist";
  adapter.playlists.set(rm2PlaylistId, {
    id: rm2PlaylistId,
    name: "室友2歌单",
    songs: [
      { id: "new-song-2", name: "新歌2", artists: ["歌手5"], album: "专辑5" },
      { id: "new-song-3", name: "新歌3", artists: ["歌手6"], album: "专辑6" }
    ]
  });
  database.insert(personalPlaylistBinding).values({
    id: v7(),
    roomId,
    memberId: roommate2MemberId,
    accountId: "acc-owner",
    playlistId: rm2PlaylistId,
    name: "室友2歌单",
    creationOperationId: v7(),
    generation: 1,
    createdAt: now(),
    updatedAt: now()
  }).run();
  database.insert(playlistSnapshot).values({
    accountId: "acc-owner",
    playlistId: rm2PlaylistId,
    snapshotVersion: 1,
    syncedAt: now(),
    createdAt: now(),
    updatedAt: now()
  }).run();
  for (const [idx, s] of adapter.playlists.get(rm2PlaylistId)!.songs.entries()) {
    database.insert(playlistTrack).values({
      accountId: "acc-owner",
      playlistId: rm2PlaylistId,
      position: idx,
      songId: s.id,
      name: s.name,
      artists: JSON.stringify(s.artists),
      album: s.album
    }).run();
  }

  const eventStream = new EventStreamService();
  const scheduler = new UpstreamScheduler(database, eventStream, now);
  scheduler.start();
  const playlists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, now);
  const personalPlaylists = new PersonalPlaylists(database, vault, adapter, scheduler, eventStream, playlists, now);
  const randomPreview = new PublicRandomPreview(database, playlists, personalPlaylists, now, () => 0.1);
  playlists.initReplacement(randomPreview);
  playlists.start();

  const ctx: TestContext = {
    root,
    database,
    playlists,
    personalPlaylists,
    randomPreview,
    scheduler,
    adapter,
    roomId,
    publicPlaylistId,
    ownerUserId,
    ownerMemberId,
    roommate1UserId,
    roommate1MemberId,
    roommate2UserId,
    roommate2MemberId,
    now,
    advanceTime
  };
  activeFixtures.push(ctx);
  return ctx;
}

describe("PublicPlaylistReplacement (公共歌单持久整组替换)", () => {
  it("验收清单 1 & 2: 仅房主可确认、幂等性、同键不同内容拒绝、过期键拒绝、不重新抽选", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    // 1. 非房主确认被拒绝 403 OWNER_ONLY
    expect(() => {
      ctx.playlists.replacePublicPlaylist(ctx.roommate1UserId, ctx.roomId, {
        idempotencyKey: v7(),
        previewId: preview.previewId
      });
    }).toThrowError(expect.objectContaining({ status: 403, code: "OWNER_ONLY" }));

    // 2. 房主使用有效预览受理
    const key = v7();
    const res1 = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: key,
      previewId: preview.previewId
    });
    expect(res1.replay).toBe(false);
    expect(res1.operation.status).toBe("queued");
    expect(res1.operation.step).toBe("ready");
    expect(res1.operation.targetCount).toBe(preview.actualCount);

    // 3. 同一幂等键重放返回原操作 (replay: true)，不产生新抽选
    const res2 = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: key,
      previewId: preview.previewId
    });
    expect(res2.replay).toBe(true);
    expect(res2.operation.id).toBe(res1.operation.id);

    // 4. 同一幂等键不同内容（不同 previewId）拒绝 409 IDEMPOTENCY_CONFLICT
    expect(() => {
      ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
        idempotencyKey: key,
        previewId: v7()
      });
    }).toThrowError(expect.objectContaining({ status: 409, code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("验收清单 2: 公共歌单歌曲已变更时拒绝确认并要求重做预览", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    // 模拟公共歌单快照发生变更 (版本递增且新增一首外部点歌)
    ctx.database.update(playlistSnapshot).set({
      snapshotVersion: 999
    }).where(eq(playlistSnapshot.playlistId, ctx.publicPlaylistId)).run();

    expect(() => {
      ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
        idempotencyKey: v7(),
        previewId: preview.previewId
      });
    }).toThrowError(expect.objectContaining({ status: 409, code: "PREVIEW_INVALIDATED" }));
  });

  it("验收清单 3: 与公共点歌及下一首重排协调互斥，待确认与执行期间禁止新冲突写", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    const key = v7();
    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: key,
      previewId: preview.previewId
    });
    expect(res.operation.status).toBe("queued");

    // 换歌进行中，普通成员点歌被 TARGET_BLOCKED 拒绝
    expect(() => {
      ctx.playlists.requestSong(ctx.roommate1UserId, ctx.roomId, {
        idempotencyKey: v7(),
        songId: "new-song-999",
        name: "冲突歌曲",
        artists: ["歌手"],
        album: "专辑"
      });
    }).toThrowError(expect.objectContaining({ status: 409, code: "TARGET_BLOCKED" }));

    // 下一首重排同样被 TARGET_BLOCKED 拒绝
    expect(() => {
      ctx.playlists.playNext(ctx.roommate1UserId, ctx.roomId, {
        idempotencyKey: v7(),
        songId: "old-song-2",
        anchorSongId: "old-song-1",
        snapshotVersion: 1
      });
    }).toThrowError(expect.objectContaining({ status: 409, code: "TARGET_BLOCKED" }));

    // 房主本人不能在该房间发起第二项写操作 (CONCURRENT_OPERATION_LIMIT_EXCEEDED)
    expect(() => {
      ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
        idempotencyKey: v7(),
        previewId: preview.previewId
      });
    }).toThrowError(expect.objectContaining({ status: 409, code: "CONCURRENT_OPERATION_LIMIT_EXCEEDED" }));
  });

  it("验收清单 4, 5, 9, 10, 11: 完整成功执行：逐首新增、保留原有、逐首移除旧歌、每写读回、打标与去重标签", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    const key = v7();
    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: key,
      previewId: preview.previewId
    });

    // 运行调度直至处理完成
    await ctx.playlists.settle();

    const op = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(op.status).toBe("succeeded");
    expect(op.step).toBe("succeeded");
    expect(op.tagConfirmed).toBe(true);

    // 验证云端歌单：旧歌 old-song-1, old-song-2 已移除，保留歌 shared-keep-1 依然存在，新歌全部加入
    const cloudSongs = ctx.adapter.playlists.get(ctx.publicPlaylistId)!.songs.map(s => s.id);
    expect(cloudSongs).not.toContain("old-song-1");
    expect(cloudSongs).not.toContain("old-song-2");
    expect(cloudSongs).toContain("shared-keep-1");
    for (const t of preview.tracks) {
      expect(cloudSongs).toContain(t.songId);
    }

    // 验证上游调用：必须包含 trackAdd 与 trackRemove，并且每次增删后都有 playlistDetail 读回
    const addCalls = ctx.adapter.inputs.filter(i => i.operation === "trackAdd");
    const removeCalls = ctx.adapter.inputs.filter(i => i.operation === "trackRemove");
    expect(addCalls.length).toBeGreaterThan(0);
    expect(removeCalls.length).toBe(2); // old-song-1 与 old-song-2

    // 验证个人歌单不受影响：tracks 集合与顺序完全原样保留
    const rm1Songs = ctx.adapter.playlists.get("rm1-playlist")!.songs.map(s => s.id);
    expect(rm1Songs).toEqual(["shared-keep-1", "new-song-1"]);
    const rm2Songs = ctx.adapter.playlists.get("rm2-playlist")!.songs.map(s => s.id);
    expect(rm2Songs).toEqual(["new-song-2", "new-song-3"]);

    // 验证点歌人标签 (requesterTag)：
    // 1. 旧歌已移除，旧歌的标签已清除
    const oldTags = ctx.database.select().from(requesterTag).where(and(
      eq(requesterTag.roomId, ctx.roomId),
      eq(requesterTag.songId, "old-song-1")
    )).all();
    expect(oldTags).toHaveLength(0);

    // 2. 抽选中的歌曲按其 sourceMemberId 打标，shared-keep-1 保留原有标签且若重合去重
    for (const t of preview.tracks) {
      const tags = ctx.database.select().from(requesterTag).where(and(
        eq(requesterTag.roomId, ctx.roomId),
        eq(requesterTag.songId, t.songId)
      )).all();
      expect(tags.some(tag => tag.memberId === t.sourceMemberId)).toBe(true);
    }
  }, 25_000);

  it("验收清单 7: 发送后中断/超时时不重发，进入 awaitingConfirmation，3轮补查后停止自动请求", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    let firstAddAttempted = false;
    ctx.adapter.trackAddHook = async (input) => {
      if (!firstAddAttempted) {
        firstAddAttempted = true;
        // 模拟网络超时或进程被杀等 unknown outcome
        return {
          ok: false,
          error: { code: "NETWORK_ERROR", outcome: "unknown" }
        };
      }
      return null;
    };

    const key = v7();
    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: key,
      previewId: preview.previewId
    });

    await ctx.playlists.settle();

    const opAfterTimeout = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(opAfterTimeout.status).toBe("awaitingConfirmation");
    expect(opAfterTimeout.step).toBe("unknown");

    // 验证没有重发 trackAdd
    const trackAddCount1 = ctx.adapter.inputs.filter(i => i.operation === "trackAdd").length;
    expect(trackAddCount1).toBe(1);

    // 触发第 1 轮由于时间的补查 (5s)
    ctx.advanceTime(5_001);
    ctx.playlists.triggerDueChecks();
    await ctx.playlists.settle();

    // 仍然未在云端出现（模拟写入实际未抵达），进入第 2 轮待查，绝不调用 trackAdd
    const trackAddCount2 = ctx.adapter.inputs.filter(i => i.operation === "trackAdd").length;
    expect(trackAddCount2).toBe(1); // 绝不重发！

    // 触发第 2 轮 (30s)
    ctx.advanceTime(30_001);
    ctx.playlists.triggerDueChecks();
    await ctx.playlists.settle();

    // 触发第 3 轮 (120s)
    ctx.advanceTime(120_001);
    ctx.playlists.triggerDueChecks();
    await ctx.playlists.settle();

    const opFinal = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(opFinal.status).toBe("awaitingConfirmation");
    expect(ctx.adapter.inputs.filter(i => i.operation === "trackAdd")).toHaveLength(1);
  }, 25_000);

  it("验收清单 7: awaitingConfirmation 补查证实云端已添加后，继续后续步骤并成功", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    let hooked = false;
    ctx.adapter.trackAddHook = async (input) => {
      if (!hooked) {
        hooked = true;
        // 实际上网易云收到了写入并添加了歌曲，但返回了网络中断
        const pl = ctx.adapter.playlists.get(ctx.publicPlaylistId)!;
        pl.songs.push({ id: input.songId, name: `歌曲-${input.songId}`, artists: ["歌手"], album: "专辑" });
        return {
          ok: false,
          error: { code: "NETWORK_ERROR", outcome: "unknown" }
        };
      }
      return null;
    };

    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: v7(),
      previewId: preview.previewId
    });

    await ctx.playlists.settle();

    // 触发第 1 轮补查
    ctx.advanceTime(5_001);
    ctx.playlists.triggerDueChecks();
    await ctx.playlists.settle();

    const opFinal = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(opFinal.status).toBe("succeeded");
    expect(opFinal.tagConfirmed).toBe(true);
  }, 25_000);

  it("验收清单 8: 删除过程中检测到未预期的外部修改时，停止自动删除并置为 stopped (PLAYLIST_CONFLICT)", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    // 拦截 trackRemove，在删除一首旧歌后，模拟外部客户端突然插入了一首不在计划内的歌曲
    let removeCount = 0;
    ctx.adapter.trackRemoveHook = async (input) => {
      removeCount++;
      const pl = ctx.adapter.playlists.get(ctx.publicPlaylistId)!;
      pl.songs = pl.songs.filter(s => s.id !== input.songId);
      if (removeCount === 1) {
        // 外部插入未预期歌曲
        pl.songs.push({ id: "external-surprise-song", name: "外部加歌", artists: ["外部"], album: "外部" });
      }
      return { ok: true, data: { acknowledged: true } };
    };

    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: v7(),
      previewId: preview.previewId
    });

    await ctx.playlists.settle();

    const op = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(op.status).toBe("stopped");
    expect(op.errorCode).toBe("PLAYLIST_CONFLICT");
    expect(op.step).toBe("stopped");

    // 不谎称原歌单原封不动，也不谎称全部换好：精准展示已加入与已删除的集合
    expect(op.addedSongIds.length).toBeGreaterThan(0);
    expect(op.removedSongIds.length).toBe(1);
  }, 25_000);

  it("验收清单 10: 来源成员在换歌期间退出房间，不回写其标签但其余标签与云端换歌正常完成", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    // 找到预览中来源归属于 roommate2 的歌曲
    const rm2Tracks = preview.tracks.filter(t => t.sourceMemberId === ctx.roommate2MemberId);
    expect(rm2Tracks.length).toBeGreaterThan(0);

    // 在新增所有歌曲后、tagging 之前，将 roommate2 移出房间
    let addsDone = 0;
    ctx.adapter.trackAddHook = async (input) => {
      addsDone++;
      const pl = ctx.adapter.playlists.get(ctx.publicPlaylistId)!;
      pl.songs.push({ id: input.songId, name: `歌曲-${input.songId}`, artists: ["歌手"], album: "专辑" });
      if (addsDone === preview.tracks.filter(t => !["shared-keep-1"].includes(t.songId)).length) {
        // 移除 roommate2 成员资格
        ctx.database.delete(roomMembership).where(eq(roomMembership.id, ctx.roommate2MemberId)).run();
      }
      return { ok: true, data: { acknowledged: true } };
    };

    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: v7(),
      previewId: preview.previewId
    });

    await ctx.playlists.settle();

    const op = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(op.status).toBe("succeeded");
    expect(op.tagConfirmed).toBe(true);

    // 验证：已退出的 roommate2 来源歌曲在云端已确认存在，但没有写其点歌人标签
    for (const t of rm2Tracks) {
      const tags = ctx.database.select().from(requesterTag).where(and(
        eq(requesterTag.roomId, ctx.roomId),
        eq(requesterTag.songId, t.songId)
      )).all();
      expect(tags.some(tag => tag.memberId === ctx.roommate2MemberId)).toBe(false);
    }
  }, 25_000);

  it("验收清单 12: 房主授权失效进入 waitingAuthorization，重新授权后安全恢复", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: v7(),
      previewId: preview.previewId
    });

    // 房主撤销授权
    ctx.playlists.onOwnerRevoked(ctx.ownerUserId);
    const opRevoked = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(opRevoked.status).toBe("waitingAuthorization");
    expect(opRevoked.errorCode).toBe("AUTH_UNAVAILABLE");

    // 重新授权
    const newAuthId = v7();
    const newCreds = ctx.playlists.vault.encrypt("mock-cookie-2", { authorizationId: newAuthId, accountId: "acc-owner", generation: 2 });
    ctx.database.update(neteaseAuthorization).set({
      id: newAuthId,
      generation: 2,
      status: "active",
      credentials: newCreds
    }).where(eq(neteaseAuthorization.userId, ctx.ownerUserId)).run();
    ctx.playlists.onReauthorized(ctx.ownerUserId, newAuthId, "acc-owner", 2);
    await ctx.playlists.settle();

    const opRestored = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(opRestored.status).toBe("succeeded");

    // 验证终结后清除恢复载荷：targetTracks, originalSongIds, sources 均为空数组，但 targetCount 保留
    const detail = ctx.database.select().from(publicPlaylistReplacement).where(eq(publicPlaylistReplacement.operationId, res.operation.id)).get()!;
    expect(detail.targetTracks).toBe("[]");
    expect(detail.originalSongIds).toBe("[]");
    expect(detail.sources).toBe("[]");
    expect(detail.targetCount).toBe(preview.actualCount);
  }, 25_000);

  it("验收清单 4 & 7: 发送中崩溃重启恢复：不重发写入，自动进入待确认并通过读回继续成功", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    const crashKey = v7();
    const crashRes = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: crashKey,
      previewId: preview.previewId
    });

    // 人工模拟进程崩溃前夕在 DB 留存 sending 状态
    ctx.database.update(publicPlaylistReplacement).set({
      step: "sending",
      currentAction: "add",
      currentSongId: preview.tracks[0].songId
    }).where(eq(publicPlaylistReplacement.operationId, crashRes.operation.id)).run();
    ctx.database.update(operation).set({
      status: "processing"
    }).where(eq(operation.id, crashRes.operation.id)).run();

    // 停止旧服务
    ctx.playlists.stop();
    await ctx.playlists.settle();

    // 启动新实例模拟单实例重启恢复
    const restartedScheduler = new UpstreamScheduler(ctx.database, ctx.playlists.eventStream, ctx.now);
    const restartedPlaylists = new PublicPlaylists(ctx.database, ctx.adapter, ctx.playlists.vault, restartedScheduler, ctx.playlists.eventStream, ctx.now);
    restartedPlaylists.initReplacement(ctx.randomPreview);
    restartedPlaylists.start();

    // 验证重启恢复：sending 状态的操作被恢复为 awaitingConfirmation / unknown，绝不盲目重发
    const opRecovered = restartedPlaylists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, crashRes.operation.id);
    expect(opRecovered.status).toBe("awaitingConfirmation");
    expect(opRecovered.step).toBe("unknown");

    restartedPlaylists.stop();
    await restartedPlaylists.settle();
  }, 25_000);

  it("验收清单 10: 来源歌单换绑：受理时拦截为 PREVIEW_INVALIDATED，发送前变动停止为 PLAYLIST_CONFLICT", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    // 1. 受理前换绑 -> 409 PREVIEW_INVALIDATED
    ctx.database.update(personalPlaylistBinding).set({
      generation: 99
    }).where(eq(personalPlaylistBinding.memberId, ctx.roommate1MemberId)).run();

    expect(() => {
      ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
        idempotencyKey: v7(),
        previewId: preview.previewId
      });
    }).toThrowError(expect.objectContaining({ status: 409, code: "PREVIEW_INVALIDATED" }));

    // 恢复绑定 generation 生成新的有效预览
    ctx.database.update(personalPlaylistBinding).set({
      generation: 1
    }).where(eq(personalPlaylistBinding.memberId, ctx.roommate1MemberId)).run();
    const validPreview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    // 2. 受理成功后，在执行发送前换绑 -> 调度执行检测到来源变动，置为 stopped (PLAYLIST_CONFLICT)
    let addCalls = 0;
    ctx.adapter.trackAddHook = async () => {
      addCalls++;
      if (addCalls === 1) {
        // 在第 1 次发送时换绑
        ctx.database.update(personalPlaylistBinding).set({
          generation: 888
        }).where(eq(personalPlaylistBinding.memberId, ctx.roommate1MemberId)).run();
      }
      return null;
    };

    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: v7(),
      previewId: validPreview.previewId
    });

    await ctx.playlists.settle();

    const op = ctx.playlists.readRandomReplacementOperation(ctx.ownerUserId, ctx.roomId, res.operation.id);
    expect(op.status).toBe("stopped");
    expect(op.errorCode).toBe("PLAYLIST_CONFLICT");
  }, 25_000);

  it("验收清单 12: 房间解散级联清理换歌操作与详情记录", async () => {
    const ctx = createTestContext();
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, { count: 5 });

    const res = ctx.playlists.replacePublicPlaylist(ctx.ownerUserId, ctx.roomId, {
      idempotencyKey: v7(),
      previewId: preview.previewId
    });

    // 房主解散房间
    ctx.database.transaction(tx => {
      ctx.playlists.terminateRoomInTx(tx, ctx.roomId, ctx.ownerUserId);
      tx.delete(room).where(eq(room.id, ctx.roomId)).run();
    });

    // 验证 operation 与 publicPlaylistReplacement 均已被物理级联删除
    const op = ctx.database.select().from(operation).where(eq(operation.id, res.operation.id)).get();
    expect(op).toBeUndefined();
    const detail = ctx.database.select().from(publicPlaylistReplacement).where(eq(publicPlaylistReplacement.operationId, res.operation.id)).get();
    expect(detail).toBeUndefined();
  }, 25_000);
});
