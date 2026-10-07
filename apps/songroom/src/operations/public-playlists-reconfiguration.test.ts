import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { v7 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import {
  commandReceipt,
  neteaseAuthorization,
  operation,
  playlistSnapshot,
  playlistTrack,
  publicPlaylistBinding,
  publicPlaylistCreation,
  publicSongRequest,
  requesterTag,
  retiredPublicPlaylistBinding,
  room,
  roomInvite,
  roomMembership,
  user
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { EventStreamService } from "../events/event-stream.js";
import { PublicPlaylists } from "./public-playlists.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";

class TestAdapter implements NeteaseAdapter {
  inputs: AdapterInput[] = [];

  identity: (input: Extract<AdapterInput, { operation: "identity" }>) => Promise<AdapterResult<"identity">> = async () => ({
    ok: true,
    data: { accountId: "cloud-owner", name: "房主" }
  });
  create: (input: Extract<AdapterInput, { operation: "playlistCreate" }>) => Promise<AdapterResult<"playlistCreate">> = async () => ({
    ok: true,
    data: { playlistId: "cloud-playlist-new" }
  });
  detail: (input: Extract<AdapterInput, { operation: "playlistDetail" }>) => Promise<AdapterResult<"playlistDetail">> = async () => ({
    ok: true,
    data: {
      playlist: { id: "cloud-playlist-1", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
      songIds: ["song-1", "song-2"],
      songs: [
        { id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
        { id: "song-2", name: "七里香", artists: ["周杰伦"], album: "七里香" }
      ]
    }
  });
  userPlaylists: (input: Extract<AdapterInput, { operation: "userPlaylists" }>) => Promise<AdapterResult<"userPlaylists">> = async () => ({
    ok: true,
    data: {
      playlists: [
        { id: "cloud-playlist-1", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 }
      ],
      more: false
    }
  });
  trackAdd: (input: Extract<AdapterInput, { operation: "trackAdd" }>) => Promise<AdapterResult<"trackAdd">> = async () => ({
    ok: true,
    data: { acknowledged: true }
  });

  async assertVendorIntegrity() {}
  async dispose() {}
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);
    if (input.operation === "identity") return await this.identity(input) as AdapterResult<I["operation"]>;
    if (input.operation === "userPlaylists") return await this.userPlaylists(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistCreate") return await this.create(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistDetail") return await this.detail(input) as AdapterResult<I["operation"]>;
    if (input.operation === "trackAdd") return await this.trackAdd(input) as AdapterResult<I["operation"]>;
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-reconfig-test-"));
  const dbPath = path.join(root, "app.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "key");
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);

  for (const id of ["owner", "member", "outsider", "other-owner"]) {
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

  const inviteCode = "invite1234";
  database.insert(roomInvite).values({ roomId, code: inviteCode, generation: 1 }).run();

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

  const adapter = new TestAdapter();
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

  function advanceTime(ms: number) {
    timeOffset += ms;
  }

  return { root, database, adapter, vault, roomId, ownerAuthId: authorizationId, module, advanceTime, now };
}

describe("失效公共歌单识别与重新创建 (ticket 13)", () => {
  it("只有在身份正确且完整歌单清单确认目标不在时才标记失效；502、读取失败、清单仍存、身份异常均不解除绑定", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 先正常绑定并同步快照
    const initialCreation = service.create("owner", f.roomId, { idempotencyKey: v7() });
    await service.settle();
    f.database.update(publicPlaylistBinding).set({ playlistId: "cloud-playlist-1" }).where(eq(publicPlaylistBinding.roomId, f.roomId)).run();

    const initialView = await service.refresh("owner", f.roomId);
    expect(initialView.playlist?.id).toBe("cloud-playlist-1");
    expect(initialView.snapshot?.version).toBe(1);
    expect(initialView.snapshot?.tracks).toHaveLength(2);

    // 场景 1：一次读取失败 (502 / MODULE_ERROR)
    f.advanceTime(1500);
    f.adapter.detail = async () => ({
      ok: false,
      error: { code: "MODULE_ERROR", outcome: "failed" }
    });
    const view502 = await service.refresh("owner", f.roomId);
    expect(view502.playlist?.id).toBe("cloud-playlist-1");
    expect(view502.lastRefreshError).toBe("MODULE_ERROR");
    expect(view502.snapshot?.version).toBe(1); // 保留上次快照

    // 场景 2：返回删除墓碑 (status 10)，但完整清单中仍包含该歌单
    f.advanceTime(1500);
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist-1", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 10 },
        songIds: ["song-1"],
        songs: [{ id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
      }
    });
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: {
        playlists: [{ id: "cloud-playlist-1", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 }],
        more: false
      }
    });
    const viewTombstoneWithList = await service.refresh("owner", f.roomId);
    expect(viewTombstoneWithList.playlist?.id).toBe("cloud-playlist-1");
    expect(viewTombstoneWithList.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(viewTombstoneWithList.snapshot?.version).toBe(1); // 不能单独解除绑定，保留快照

    // 场景 3：返回删除墓碑 (status 10)，但获取完整清单时 502 失败
    f.advanceTime(1500);
    f.adapter.userPlaylists = async () => ({
      ok: false,
      error: { code: "MODULE_ERROR", outcome: "failed" }
    });
    const viewTombstoneUserPlaylistsFailed = await service.refresh("owner", f.roomId);
    expect(viewTombstoneUserPlaylistsFailed.playlist?.id).toBe("cloud-playlist-1");
    expect(viewTombstoneUserPlaylistsFailed.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(viewTombstoneUserPlaylistsFailed.snapshot?.version).toBe(1);

    // 场景 4：返回删除墓碑 (status 10)，清单中无该歌单，但身份校验失败
    f.advanceTime(1500);
    f.adapter.identity = async () => ({
      ok: false,
      error: { code: "AUTH_UNAVAILABLE", outcome: "failed" }
    });
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: false }
    });
    const viewIdentityFailed = await service.refresh("owner", f.roomId);
    expect(viewIdentityFailed.playlist?.id).toBe("cloud-playlist-1");
    expect(viewIdentityFailed.snapshot?.version).toBe(1);

    // 场景 5：契约完全满足（身份正确、清单完整无此目标、目标详情返回墓碑 status 10）
    f.advanceTime(1500);
    f.adapter.identity = async () => ({
      ok: true,
      data: { accountId: "cloud-owner", name: "房主" }
    });
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: false }
    });
    const viewConfirmedDeleted = await service.refresh("owner", f.roomId);

    // 确认已解除绑定
    expect(viewConfirmedDeleted.playlist).toBeNull();
    expect(viewConfirmedDeleted.snapshot).toBeNull();
    expect(viewConfirmedDeleted.invalidatedTarget).toEqual({
      playlistId: "cloud-playlist-1",
      name: "songroom-宿舍-公共",
      checkedAt: expect.any(Number),
      status: "confirmedDeleted"
    });
    expect(viewConfirmedDeleted.allowedActions).toEqual(["createPublicPlaylist"]);

    // 室友视角：看到目标已失效及最后核查状态，但无创建权限
    const memberView = service.read("member", f.roomId);
    expect(memberView.playlist).toBeNull();
    expect(memberView.invalidatedTarget?.playlistId).toBe("cloud-playlist-1");
    expect(memberView.allowedActions).toEqual([]);
    expect(memberView.disabledReason).toBe("OWNER_ONLY");

    // 房间外用户：仍然 404
    expect(() => service.read("outsider", f.roomId)).toThrowError("ROOM_UNAVAILABLE");
  });

  it("确认失效在本地事务中停止旧目标点歌、清除点歌人标签，且不破坏房间、成员、邀请或其他房间", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 绑定公共歌单代次 1
    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist-1",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 添加点歌人标签
    const memberRow = f.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, f.roomId), eq(roomMembership.userId, "member"))).get()!;
    f.database.insert(requesterTag).values({
      roomId: f.roomId,
      bindingGeneration: 1,
      songId: "song-1",
      memberId: memberRow.id,
      createdAt: f.now()
    }).run();

    // 添加进行中的点歌操作
    const songOpId = v7();
    f.database.insert(operation).values({
      id: songOpId,
      kind: "requestPublicSong",
      userId: "member",
      roomId: f.roomId,
      accountId: "cloud-owner",
      authorizationId: f.ownerAuthId,
      generation: 1,
      status: "queued",
      createdAt: f.now(),
      updatedAt: f.now()
    }).run();
    f.database.insert(publicSongRequest).values({
      operationId: songOpId,
      songId: "song-2",
      name: "七里香",
      artists: JSON.stringify(["周杰伦"]),
      album: "七里香",
      step: "ready",
      songConfirmed: false,
      tagConfirmed: false,
      playlistId: "cloud-playlist-1",
      bindingGeneration: 1,
      checkRound: 0
    }).run();

    // 创建第二个独立的房间和绑定
    const otherRoomId = v7();
    f.database.insert(room).values({ id: otherRoomId, name: "二号房间", ownerUserId: "other-owner" }).run();
    f.database.insert(roomMembership).values({ id: v7(), roomId: otherRoomId, userId: "other-owner", nickname: "二号房主" }).run();
    const otherAuthId = v7();
    f.database.insert(neteaseAuthorization).values({
      id: otherAuthId,
      userId: "other-owner",
      accountId: "other-account",
      generation: 1,
      nickname: "二号房主",
      status: "active",
      credentials: f.vault.encrypt("MUSIC_U=other", { authorizationId: otherAuthId, accountId: "other-account", generation: 1 })
    }).run();
    f.database.insert(publicPlaylistBinding).values({
      roomId: otherRoomId,
      accountId: "other-account",
      playlistId: "cloud-playlist-other",
      name: "songroom-二号房间-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 触发公共歌单 1 失效（详情返回 TARGET_PERMISSION 404，且完整清单确认不存在）
    f.adapter.detail = async () => ({
      ok: false,
      error: { code: "TARGET_PERMISSION", outcome: "failed" }
    });
    f.adapter.identity = async () => ({
      ok: true,
      data: { accountId: "cloud-owner", name: "房主" }
    });
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: false }
    });

    await service.refresh("owner", f.roomId);

    // 验证旧目标点歌操作已停止
    const songOp = f.database.select().from(operation).where(eq(operation.id, songOpId)).get()!;
    expect(songOp.status).toBe("stopped");
    const songReq = f.database.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, songOpId)).get()!;
    expect(songReq.step).toBe("stopped");

    // 验证代次 1 的全部点歌人标签已清除
    const tags = f.database.select().from(requesterTag).where(eq(requesterTag.roomId, f.roomId)).all();
    expect(tags).toHaveLength(0);

    // 验证房间、成员、邀请、网易云授权均保留
    expect(f.database.select().from(room).where(eq(room.id, f.roomId)).get()).toBeDefined();
    expect(f.database.select().from(roomMembership).where(eq(roomMembership.roomId, f.roomId)).all()).toHaveLength(2);
    expect(f.database.select().from(roomInvite).where(eq(roomInvite.roomId, f.roomId)).get()).toBeDefined();
    expect(f.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, "owner")).get()).toBeDefined();

    // 验证二号房间完全不受影响
    const otherBinding = f.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, otherRoomId)).get()!;
    expect(otherBinding.playlistId).toBe("cloud-playlist-other");
  });

  it("房主重建以空状态建立新绑定代次 (generation 2)，不补歌、不恢复旧标签，且拒绝复用旧云端 ID", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 1. 初始化代次 1 并失效
    f.database.insert(retiredPublicPlaylistBinding).values({
      id: v7(),
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist-old",
      name: "songroom-宿舍-公共",
      generation: 1,
      invalidatedAt: f.now()
    }).run();

    // 2. 只有房主可以触发创建，室友和非成员均被拒绝
    expect(() => service.create("member", f.roomId, { idempotencyKey: v7() })).toThrowError("ROOM_OWNER_REQUIRED");
    expect(() => service.create("outsider", f.roomId, { idempotencyKey: v7() })).toThrowError("ROOM_UNAVAILABLE");

    // 3. 房主发起重新创建
    f.adapter.create = async () => ({
      ok: true,
      data: { playlistId: "cloud-playlist-v2" }
    });
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: false }
    });

    const createResult = service.create("owner", f.roomId, { idempotencyKey: v7() });
    expect(createResult.replay).toBe(false);

    // 在创建完成前，房间保持无公共歌单的合法状态
    const midView = service.read("owner", f.roomId);
    expect(midView.playlist).toBeNull();

    await service.settle();

    // 4. 创建成功后，建立新绑定代次 (generation 2)
    const newBinding = f.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, f.roomId)).get()!;
    expect(newBinding.playlistId).toBe("cloud-playlist-v2");
    expect(newBinding.generation).toBe(2);

    // view 不再显示 invalidatedTarget
    const postView = service.read("owner", f.roomId);
    expect(postView.playlist?.id).toBe("cloud-playlist-v2");
    expect(postView.invalidatedTarget).toBeNull();

    // 5. 新歌单从真实云端空状态开始，不补歌
    f.advanceTime(1500);
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist-v2", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: [],
        songs: []
      }
    });
    const refreshed = await service.refresh("owner", f.roomId);
    expect(refreshed.lastRefreshError).toBeNull();
    expect(refreshed.snapshot?.trackCount).toBe(0);
    expect(refreshed.snapshot?.tracks).toEqual([]);

    // 6. 室友再次点同一首旧歌 (song-1)，新建代次 2 的标签，不继承代次 1
    f.advanceTime(1500);
    f.adapter.trackAdd = async () => ({ ok: true, data: { acknowledged: true } });
    f.adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "cloud-playlist-v2", name: "songroom-宿舍-公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
        songIds: ["song-1"],
        songs: [{ id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
      }
    });

    service.requestSong("member", f.roomId, {
      idempotencyKey: v7(),
      songId: "song-1",
      name: "晴天",
      artists: ["周杰伦"],
      album: "叶惠美"
    });
    await service.settle();

    const newTags = f.database.select().from(requesterTag).where(eq(requesterTag.roomId, f.roomId)).all();
    expect(newTags).toHaveLength(1);
    expect(newTags[0].bindingGeneration).toBe(2);
    expect(newTags[0].songId).toBe("song-1");
  });

  it("防止复用已失效的云端歌单 ID：如果上游返回已退休的旧 ID 则进入 needsAdministrator 并拒绝绑定", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 记录旧代次 1
    f.database.insert(retiredPublicPlaylistBinding).values({
      id: v7(),
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist-old",
      name: "songroom-宿舍-公共",
      generation: 1,
      invalidatedAt: f.now()
    }).run();

    // 上游返回了相同的旧 ID
    f.adapter.create = async () => ({
      ok: true,
      data: { playlistId: "cloud-playlist-old" }
    });
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: false }
    });

    service.create("owner", f.roomId, { idempotencyKey: v7() });
    await service.settle();

    // 绑定未建立，操作进入 needsAdministrator
    expect(f.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, f.roomId)).get()).toBeUndefined();
    const op = f.database.select().from(operation).where(and(eq(operation.roomId, f.roomId), eq(operation.kind, "createPublicPlaylist"))).get()!;
    expect(op.status).toBe("needsAdministrator");
    expect(op.errorCode).toBe("TARGET_PERMISSION");
  });

  it("晚到响应与并发竞态隔离：旧代次读取与在途点歌不能覆盖新代次或恢复旧绑定", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 代次 1 绑定
    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist-1",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 模拟在代次 1 上发起了一个点歌操作
    const songOpId = v7();
    f.database.insert(operation).values({
      id: songOpId,
      kind: "requestPublicSong",
      userId: "member",
      roomId: f.roomId,
      accountId: "cloud-owner",
      authorizationId: f.ownerAuthId,
      generation: 1,
      status: "queued",
      createdAt: f.now(),
      updatedAt: f.now()
    }).run();
    f.database.insert(publicSongRequest).values({
      operationId: songOpId,
      songId: "song-stale",
      name: "过期待发歌",
      artists: JSON.stringify(["歌手"]),
      album: "专辑",
      step: "ready",
      songConfirmed: false,
      tagConfirmed: false,
      playlistId: "cloud-playlist-1",
      bindingGeneration: 1,
      checkRound: 0
    }).run();

    // 此时公共歌单 1 被确认失效并由房主重建为代次 2
    f.database.transaction(tx => {
      tx.insert(retiredPublicPlaylistBinding).values({
        id: v7(),
        roomId: f.roomId,
        accountId: "cloud-owner",
        playlistId: "cloud-playlist-1",
        name: "songroom-宿舍-公共",
        generation: 1,
        invalidatedAt: f.now()
      }).run();
      tx.update(publicPlaylistBinding).set({
        playlistId: "cloud-playlist-2",
        generation: 2
      }).where(eq(publicPlaylistBinding.roomId, f.roomId)).run();
    });

    // 晚到的代次 1 点歌操作开始调度执行：因代次不匹配自动停止，不写入任何标签
    await service.settle();

    const finalSongOp = f.database.select().from(operation).where(eq(operation.id, songOpId)).get()!;
    expect(finalSongOp.status).toBe("stopped");
    const tags = f.database.select().from(requesterTag).where(eq(requesterTag.roomId, f.roomId)).all();
    expect(tags).toHaveLength(0);
  });

  it("不完整歌单清单（more 为 true 但页空）视为核查不确定，绝不解除绑定", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 绑定公共歌单代次 1
    f.database.insert(publicPlaylistBinding).values({
      roomId: f.roomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist-1",
      name: "songroom-宿舍-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 目标详情返回 TARGET_PERMISSION 墓碑，身份正确
    f.adapter.detail = async () => ({
      ok: false,
      error: { code: "TARGET_PERMISSION", outcome: "failed" }
    });
    f.adapter.identity = async () => ({
      ok: true,
      data: { accountId: "cloud-owner", name: "房主" }
    });
    // 上游返回 more 为 true 但数据为空（分页停滞或异常）
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: true }
    });

    const view = await service.refresh("owner", f.roomId);

    // 绑定依然保留，记录错误为 TARGET_PERMISSION，绝不误标失效
    expect(view.playlist?.id).toBe("cloud-playlist-1");
    expect(view.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(view.invalidatedTarget).toBeNull();
    expect(f.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, f.roomId)).get()).toBeDefined();
  });

  it("跨房间禁止共用活跃公共歌单：若上游返回其他房间活跃歌单 ID 则进入 needsAdministrator 并拒绝绑定", async () => {
    const f = fixture();
    const service = f.module();
    service.start();

    // 房主在另一个房间拥有活跃公共歌单
    const otherRoomId = v7();
    f.database.insert(room).values({ id: otherRoomId, name: "二号房间", ownerUserId: "owner" }).run();
    f.database.insert(roomMembership).values({ id: v7(), roomId: otherRoomId, userId: "owner", nickname: "房主" }).run();
    f.database.insert(publicPlaylistBinding).values({
      roomId: otherRoomId,
      accountId: "cloud-owner",
      playlistId: "cloud-playlist-active-other",
      name: "songroom-二号房间-公共",
      creationOperationId: v7(),
      generation: 1
    }).run();

    // 在本房间重新创建时，上游返回了二号房间的活跃 ID
    f.adapter.create = async () => ({
      ok: true,
      data: { playlistId: "cloud-playlist-active-other" }
    });
    f.adapter.userPlaylists = async () => ({
      ok: true,
      data: { playlists: [], more: false }
    });

    service.create("owner", f.roomId, { idempotencyKey: v7() });
    await service.settle();

    // 本房间绑定未建立，操作进入 needsAdministrator
    expect(f.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, f.roomId)).get()).toBeUndefined();
    const op = f.database.select().from(operation).where(and(eq(operation.roomId, f.roomId), eq(operation.kind, "createPublicPlaylist"))).get()!;
    expect(op.status).toBe("needsAdministrator");
    expect(op.errorCode).toBe("TARGET_PERMISSION");
  });
});
