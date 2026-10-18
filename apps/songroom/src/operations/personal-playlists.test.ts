import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { neteaseAuthorization, personalPlaylistBinding, playlistSnapshot, playlistTrack, room, roomMembership, user } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { EventStreamService } from "../events/event-stream.js";
import { PersonalPlaylists } from "./personal-playlists.js";
import { BusinessError } from "../shared/errors.js";

class Adapter implements NeteaseAdapter {
  inputs: AdapterInput[] = [];
  identity: (input: Extract<AdapterInput, { operation: "identity" }>) => Promise<AdapterResult<"identity">> = async () => ({
    ok: true,
    data: { accountId: "cloud-owner", name: "房主" }
  });
  userPlaylists: (input: Extract<AdapterInput, { operation: "userPlaylists" }>) => Promise<AdapterResult<"userPlaylists">> = async () => ({
    ok: true,
    data: {
      playlists: [
        { id: "pl-created-1", name: "房主自建我喜欢的歌", creatorId: "cloud-owner", subscribed: false, status: 0 },
        { id: "pl-sub-2", name: "房主收藏周杰伦精选", creatorId: "someone-else", subscribed: true, status: 0 }
      ],
      more: false
    }
  });
  detail: (input: Extract<AdapterInput, { operation: "playlistDetail" }>) => Promise<AdapterResult<"playlistDetail">> = async input => ({
    ok: true,
    data: {
      playlist: {
        id: input.playlistId,
        name: input.playlistId === "pl-created-1" ? "房主自建我喜欢的歌" : "房主收藏周杰伦精选",
        creatorId: input.playlistId === "pl-created-1" ? "cloud-owner" : "someone-else",
        subscribed: input.playlistId !== "pl-created-1",
        status: 0
      },
      songIds: ["song-1", "song-2"],
      songs: [
        { id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
        { id: "song-2", name: "七里香", artists: ["周杰伦"], album: "七里香" }
      ]
    }
  });

  async assertVendorIntegrity() {}
  async dispose() {}
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);
    if (input.operation === "identity") return await this.identity(input) as AdapterResult<I["operation"]>;
    if (input.operation === "userPlaylists") return await this.userPlaylists(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistDetail") return await this.detail(input) as AdapterResult<I["operation"]>;
    throw new Error(`unexpected adapter call: ${input.operation}`);
  }
}

const fixtures: Array<{ root: string; database: AppDatabase; scheduler: UpstreamScheduler }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.scheduler.stop();
    await f.scheduler.settle();
    f.database.$client.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-personal-playlists-"));
  const dbPath = path.join(root, "app.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "key");
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);

  for (const id of ["owner", "roommate", "outsider"]) {
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
  database.insert(room).values({ id: roomId, name: "主房间", ownerUserId: "owner" }).run();
  const ownerMemberId = v7();
  const roommateMemberId = v7();
  database.insert(roomMembership).values({ id: ownerMemberId, roomId, userId: "owner", nickname: "房主" }).run();
  database.insert(roomMembership).values({ id: roommateMemberId, roomId, userId: "roommate", nickname: "室友" }).run();

  const authorizationId = v7();
  const scope = { authorizationId, accountId: "cloud-owner", generation: 1 };
  database.insert(neteaseAuthorization).values({
    id: authorizationId,
    userId: "owner",
    accountId: scope.accountId,
    generation: 1,
    nickname: "房主网易云",
    status: "active",
    credentials: vault.encrypt("MUSIC_U=owner-cookie", scope)
  }).run();

  const adapter = new Adapter();
  const eventStream = new EventStreamService();
  const scheduler = new UpstreamScheduler(database, eventStream);
  scheduler.start();
  fixtures.push({ root, database, scheduler });

  const service = new PersonalPlaylists(database, vault, adapter, scheduler, eventStream);
  return { database, vault, adapter, scheduler, service, roomId, ownerMemberId, roommateMemberId };
}

describe("PersonalPlaylists operations", () => {
  it("房主可获取当前网易云账号已有的自建与收藏歌单清单，区分可维护与只读能力", async () => {
    const { service, roomId } = fixture();
    const result = await service.candidates("owner", roomId);
    expect(result.allowedActions).toContain("bindPersonalPlaylist");
    expect(result.candidates).toEqual([
      { id: "pl-created-1", name: "房主自建我喜欢的歌", type: "ownerCreated", writeable: true },
      { id: "pl-sub-2", name: "房主收藏周杰伦精选", type: "ownerSubscribed", writeable: false }
    ]);
  });

  it("非房主不能获取候选清单或绑定房主个人歌单", async () => {
    const { service, roomId } = fixture();
    await expect(service.candidates("roommate", roomId)).rejects.toThrow(BusinessError);
    await expect(service.bind("roommate", roomId, { idempotencyKey: v7(), playlistId: "pl-created-1" })).rejects.toThrow(BusinessError);
  });

  it("房主绑定本人自建歌单建立可维护来源，写入后自动触发首轮快照并提供刷新与解绑", async () => {
    const { service, roomId } = fixture();
    const bindResult = await service.bind("owner", roomId, {
      idempotencyKey: v7(),
      playlistId: "pl-created-1"
    });

    expect(bindResult.playlist).toEqual({
      id: "pl-created-1",
      name: "房主自建我喜欢的歌",
      type: "ownerCreated",
      writeable: true
    });
    expect(bindResult.allowedActions).toEqual(expect.arrayContaining(["bindPersonalPlaylist", "unbindPersonalPlaylist", "refreshPersonalPlaylist"]));
    expect(bindResult.snapshot).toBeDefined();
    expect(bindResult.snapshot?.trackCount).toBe(2);
    expect(bindResult.snapshot?.tracks[0].name).toBe("晴天");

    // 重读同样返回已保存状态
    const readView = service.read("owner", roomId);
    expect(readView.playlist?.id).toBe("pl-created-1");
    expect(readView.playlist?.writeable).toBe(true);
  });

  it("房主绑定收藏歌单建立只读来源，只读来源标记 writeable: false", async () => {
    const { service, roomId } = fixture();
    const bindResult = await service.bind("owner", roomId, {
      idempotencyKey: v7(),
      playlistId: "pl-sub-2"
    });

    expect(bindResult.playlist).toEqual({
      id: "pl-sub-2",
      name: "房主收藏周杰伦精选",
      type: "ownerSubscribed",
      writeable: false
    });
  });

  it("拒绝绑定任意公开可读但不在房主自建或收藏清单中的歌单 ID", async () => {
    const { service, roomId } = fixture();
    // pl-arbitrary 虽可能在上游公开存在，但不在当前账号清单内
    await expect(service.bind("owner", roomId, {
      idempotencyKey: v7(),
      playlistId: "pl-arbitrary-public"
    })).rejects.toThrow(BusinessError);
  });

  it("同一歌单可绑定到房主创建的多个自建房间，并共享同一规范化快照", async () => {
    const { database, service, roomId } = fixture();
    const secondRoomId = v7();
    database.insert(room).values({ id: secondRoomId, name: "第二房间", ownerUserId: "owner" }).run();
    database.insert(roomMembership).values({ id: v7(), roomId: secondRoomId, userId: "owner", nickname: "房主" }).run();

    // 在房间 1 绑定
    await service.bind("owner", roomId, { idempotencyKey: v7(), playlistId: "pl-created-1" });
    // 在房间 2 绑定同一歌单
    await service.bind("owner", secondRoomId, { idempotencyKey: v7(), playlistId: "pl-created-1" });

    const view1 = service.read("owner", roomId);
    const view2 = service.read("owner", secondRoomId);
    expect(view1.playlist?.id).toBe("pl-created-1");
    expect(view2.playlist?.id).toBe("pl-created-1");
    expect(view1.snapshot?.version).toBe(view2.snapshot?.version);
  });

  it("单房间解绑不影响其他房间对同一目标的绑定，且不删除云端歌单", async () => {
    const { database, service, roomId } = fixture();
    const secondRoomId = v7();
    database.insert(room).values({ id: secondRoomId, name: "第二房间", ownerUserId: "owner" }).run();
    database.insert(roomMembership).values({ id: v7(), roomId: secondRoomId, userId: "owner", nickname: "房主" }).run();

    await service.bind("owner", roomId, { idempotencyKey: v7(), playlistId: "pl-created-1" });
    await service.bind("owner", secondRoomId, { idempotencyKey: v7(), playlistId: "pl-created-1" });

    // 解绑房间 1
    const unbindResult = await service.unbind("owner", roomId, { idempotencyKey: v7() });
    expect(unbindResult.playlist).toBeNull();

    // 房间 2 的绑定依然有效，且快照仍保留
    const view2 = service.read("owner", secondRoomId);
    expect(view2.playlist?.id).toBe("pl-created-1");
    expect(view2.snapshot?.trackCount).toBe(2);

    // 数据库中快照记录仍存在
    const snaps = database.select().from(playlistSnapshot).where(eq(playlistSnapshot.playlistId, "pl-created-1")).all();
    expect(snaps).toHaveLength(1);
  });

  it("其他成员只能从成员详情只读查看房主个人歌单，不获得维护或点歌来源资格", async () => {
    const { service, roomId, ownerMemberId } = fixture();
    await service.bind("owner", roomId, { idempotencyKey: v7(), playlistId: "pl-created-1" });

    // 室友在我的歌单 tab 尚未配置
    const roommateSelfView = service.read("roommate", roomId);
    expect(roommateSelfView.playlist).toBeNull();

    // 室友在成员详情中查看房主的个人歌单
    const ownerFromRoommateView = service.read("roommate", roomId, ownerMemberId);
    expect(ownerFromRoommateView.playlist?.id).toBe("pl-created-1");
    expect(ownerFromRoommateView.snapshot?.trackCount).toBe(2);
    // 只读：不获得任何操作动作
    expect(ownerFromRoommateView.allowedActions).toEqual([]);
  });

  it("刷新失败时保留已有快照，并正确记录 lastRefreshError", async () => {
    const { adapter, service, roomId } = fixture();
    await service.bind("owner", roomId, { idempotencyKey: v7(), playlistId: "pl-created-1" });

    // 上游刷新发生网络错误
    adapter.detail = async () => ({
      ok: false,
      error: { code: "NETWORK_ERROR", outcome: "failed" }
    });

    const refreshView = await service.refresh("owner", roomId);
    // 保留旧快照
    expect(refreshView.snapshot?.trackCount).toBe(2);
    // 标记刷新错误
    expect(refreshView.lastRefreshError).toBe("NETWORK_ERROR");
  });

  it("幂等防重：同键同内容重放不重复写入与递增代次，同键不同内容拒绝", async () => {
    const { database, service, roomId } = fixture();
    const key = v7();

    const res1 = await service.bind("owner", roomId, { idempotencyKey: key, playlistId: "pl-created-1" });
    const b1 = database.select().from(personalPlaylistBinding).where(eq(personalPlaylistBinding.roomId, roomId)).get()!;
    expect(b1.generation).toBe(1);

    // 同键重放
    const res2 = await service.bind("owner", roomId, { idempotencyKey: key, playlistId: "pl-created-1" });
    expect(res2.playlist?.id).toBe("pl-created-1");
    const b2 = database.select().from(personalPlaylistBinding).where(eq(personalPlaylistBinding.roomId, roomId)).get()!;
    expect(b2.generation).toBe(1); // 代次未递增

    // 同键不同内容拒绝冲突
    await expect(service.bind("owner", roomId, { idempotencyKey: key, playlistId: "pl-sub-2" })).rejects.toThrow(BusinessError);
  });

  it("歌单详情响应歌曲不完整或截断时拒绝提交快照并记录 PARSE_ERROR", async () => {
    const { adapter, service, roomId } = fixture();
    // 绑定自建歌单
    await service.bind("owner", roomId, { idempotencyKey: v7(), playlistId: "pl-created-1" });

    // 上游返回截断数据（songIds 有 2 首，但 songs 只有 1 首）
    adapter.detail = async input => ({
      ok: true,
      data: {
        playlist: {
          id: input.playlistId,
          name: "房主自建我喜欢的歌",
          creatorId: "cloud-owner",
          subscribed: false,
          status: 0
        },
        songIds: ["song-1", "song-2"],
        songs: [{ id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
      }
    });

    const refreshView = await service.refresh("owner", roomId);
    // 快照歌曲数仍保留此前完整的 2 首
    expect(refreshView.snapshot?.trackCount).toBe(2);
    expect(refreshView.lastRefreshError).toBe("PARSE_ERROR");
  });

  it("收藏歌单在网易云被取消收藏后，刷新识别权限失效并记录 TARGET_PERMISSION", async () => {
    const { adapter, service, roomId } = fixture();
    // 绑定收藏歌单
    await service.bind("owner", roomId, { idempotencyKey: v7(), playlistId: "pl-sub-2" });

    // 网易云端用户取消了收藏，上游返回 subscribed: false
    adapter.detail = async input => ({
      ok: true,
      data: {
        playlist: {
          id: input.playlistId,
          name: "房主收藏周杰伦精选",
          creatorId: "someone-else",
          subscribed: false, // 已取消收藏
          status: 0
        },
        songIds: ["song-1"],
        songs: [{ id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }]
      }
    });

    const refreshView = await service.refresh("owner", roomId);
    expect(refreshView.lastRefreshError).toBe("TARGET_PERMISSION");
  });
});
