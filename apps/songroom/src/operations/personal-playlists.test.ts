import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import { v7 } from "uuid";
import { eq } from "drizzle-orm";
import { CredentialVault } from "../netease/credentials.js";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import {
  neteaseAuthorization,
  personalPlaylistBinding,
  playlistSnapshot,
  playlistTrack,
  publicPlaylistCleanup,
  room,
  roomMembership,
  user
} from "../db/schema.js";
import { EventStreamService } from "../events/event-stream.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { PublicPlaylists } from "./public-playlists.js";
import { PersonalPlaylists } from "./personal-playlists.js";
import { terminatePersonalPlaylistsInTx } from "./personal-playlist-lifecycle.js";
import type {
  AdapterInput,
  AdapterResult,
  NeteaseAdapter
} from "../netease/protocol.js";

class Adapter implements NeteaseAdapter {
  inputs: AdapterInput[] = [];
  identity: any = async () => ({ ok: true, data: { accountId: "cloud-owner", nickname: "房主网易云" } });
  userPlaylists: any = async () => ({ ok: true, data: { playlists: [] } });
  detail: any = async () => ({
    ok: true,
    data: {
      playlist: {
        id: "pl-roommate-dedicated",
        name: "songroom-主房间-房主",
        creatorId: "cloud-owner",
        subscribed: false,
        status: 0
      },
      songIds: ["song-1"],
      songs: [
        { id: "song-1", name: "歌曲 A", artists: ["歌手 1"], album: "专辑 1" }
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

  const publicPlaylists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream);
  const service = new PersonalPlaylists(database, vault, adapter, scheduler, eventStream, publicPlaylists);
  return { database, vault, adapter, scheduler, service, roomId, ownerMemberId, roommateMemberId };
}

describe("PersonalPlaylists operations", () => {
  it("未配置时所有成员均不暴露维护动作，局外人不能读取", () => {
    const { service, roomId } = fixture();
    expect(service.read("owner", roomId).allowedActions).toEqual([]);
    expect(service.read("roommate", roomId).allowedActions).toEqual([]);
    expect(() => service.read("outsider", roomId)).toThrowError(expect.objectContaining({ code: "ROOM_UNAVAILABLE" }));
  });

  it("已绑定个人歌单时本人可刷新，他人从成员详情只读查看且不获得维护动作", async () => {
    const { database, service, roomId, ownerMemberId } = fixture();
    database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId,
      memberId: ownerMemberId,
      accountId: "cloud-owner",
      playlistId: "pl-owner-fav",
      name: "我的收藏歌单",
      generation: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();
    database.insert(playlistSnapshot).values({
      accountId: "cloud-owner",
      playlistId: "pl-owner-fav",
      snapshotVersion: 1,
      lastReadStartedAt: Date.now(),
      syncedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();
    database.insert(playlistTrack).values({
      accountId: "cloud-owner",
      playlistId: "pl-owner-fav",
      position: 0,
      songId: "track-1",
      name: "晴天",
      artists: JSON.stringify(["周杰伦"]),
      album: "叶惠美"
    }).run();

    const ownerView = service.read("owner", roomId);
    expect(ownerView.playlist).toEqual({ id: "pl-owner-fav", name: "我的收藏歌单" });
    expect(ownerView.snapshot?.tracks[0].name).toBe("晴天");
    expect(ownerView.allowedActions).toEqual(["refreshPersonalPlaylist"]);

    const roommateViewOfOwner = service.read("roommate", roomId, ownerMemberId);
    expect(roommateViewOfOwner.playlist).toEqual({ id: "pl-owner-fav", name: "我的收藏歌单" });
    expect(roommateViewOfOwner.allowedActions).toEqual([]);
  });

  it("刷新失败时保留已有快照，并正确记录 lastRefreshError", async () => {
    const { database, adapter, service, roomId, ownerMemberId } = fixture();
    database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId,
      memberId: ownerMemberId,
      accountId: "cloud-owner",
      playlistId: "pl-refresh-fail",
      name: "待刷新歌单",
      generation: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();
    database.insert(playlistSnapshot).values({
      accountId: "cloud-owner",
      playlistId: "pl-refresh-fail",
      snapshotVersion: 1,
      lastReadStartedAt: Date.now(),
      syncedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();
    database.insert(playlistTrack).values({
      accountId: "cloud-owner",
      playlistId: "pl-refresh-fail",
      position: 0,
      songId: "track-1",
      name: "原歌曲",
      artists: JSON.stringify(["原歌手"]),
      album: "原专辑"
    }).run();

    adapter.detail = async () => ({
      ok: false,
      error: { code: "NETWORK_ERROR", message: "连接断开", outcome: "failed" }
    });

    const refreshed = await service.refresh("owner", roomId);
    expect(refreshed.lastRefreshError).toBe("NETWORK_ERROR");
    expect(refreshed.snapshot?.tracks[0].name).toBe("原歌曲");
  });

  it("歌单详情响应歌曲不完整或截断时拒绝提交快照并记录 PARSE_ERROR", async () => {
    const { database, adapter, service, roomId, ownerMemberId } = fixture();
    database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId,
      memberId: ownerMemberId,
      accountId: "cloud-owner",
      playlistId: "pl-truncate",
      name: "截断测试",
      generation: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();

    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: { id: "pl-truncate", name: "截断测试", creatorId: "other", subscribed: true, status: 0 },
        songIds: ["s1", "s2"],
        songs: [{ id: "s1", name: "一首歌", artists: [], album: "" }]
      }
    });

    const refreshed = await service.refresh("owner", roomId);
    expect(refreshed.lastRefreshError).toBe("PARSE_ERROR");
  });

  it("成员退出时仅清理本地绑定和未引用的快照，绝不生成云端清理任务", () => {
    const { database, roomId, roommateMemberId } = fixture();
    database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId,
      memberId: roommateMemberId,
      accountId: "cloud-owner",
      playlistId: "pl-fav-cleanup",
      name: "收藏歌单",
      generation: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();
    database.insert(playlistSnapshot).values({
      accountId: "cloud-owner",
      playlistId: "pl-fav-cleanup",
      snapshotVersion: 1,
      lastReadStartedAt: Date.now(),
      syncedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }).run();
    database.insert(playlistTrack).values({
      accountId: "cloud-owner",
      playlistId: "pl-fav-cleanup",
      position: 0,
      songId: "track-1",
      name: "歌",
      artists: "[]",
      album: ""
    }).run();

    database.transaction(tx => {
      terminatePersonalPlaylistsInTx(tx, roomId, "owner", roommateMemberId, Date.now());
    });

    const bindings = database.select().from(personalPlaylistBinding).where(eq(personalPlaylistBinding.roomId, roomId)).all();
    expect(bindings).toHaveLength(0);

    const snapshots = database.select().from(playlistSnapshot).where(eq(playlistSnapshot.playlistId, "pl-fav-cleanup")).all();
    expect(snapshots).toHaveLength(0);

    const cleanups = database.select().from(publicPlaylistCleanup).all();
    expect(cleanups).toHaveLength(0);
  });

  it("房主可拉取收藏歌单候选，过滤自建歌单与非公开收藏，非房主禁止拉取", async () => {
    const { adapter, service, roomId } = fixture();
    adapter.userPlaylists = async () => ({
      ok: true,
      data: {
        playlists: [
          { id: "pl-self", name: "自建歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
          { id: "pl-fav-1", name: "他人收藏歌单1", creatorId: "other-user", subscribed: true, status: 0, trackCount: 50, creatorNickname: "作者A", coverImgUrl: "http://cover/1.jpg" },
          { id: "pl-fav-private", name: "私密歌单", creatorId: "other-user", subscribed: true, status: -1 },
          { id: "pl-fav-unsub", name: "未收藏", creatorId: "other-user", subscribed: false, status: 0 }
        ],
        more: false
      }
    });

    const candidates = await service.getCandidates("owner", roomId);
    expect(candidates.candidates).toEqual([
      {
        id: "pl-fav-1",
        name: "他人收藏歌单1",
        creatorNickname: "作者A",
        coverImgUrl: "http://cover/1.jpg",
        trackCount: 50
      }
    ]);

    await expect(service.getCandidates("roommate", roomId)).rejects.toThrowError(
      expect.objectContaining({ code: "ROOM_OWNER_REQUIRED" })
    );
  });

  it("房主可为成员分配收藏歌单，记录快照与曲目，允许多人绑定同一歌单", async () => {
    const { adapter, service, roomId, ownerMemberId, roommateMemberId } = fixture();
    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: {
          id: "pl-fav-shared",
          name: "热门榜",
          creatorId: "billboard-official",
          subscribed: true,
          status: 0
        },
        songIds: ["song-1", "song-2"],
        songs: [
          { id: "song-1", name: "七里香", artists: ["周杰伦"], album: "七里香" },
          { id: "song-2", name: "夜曲", artists: ["周杰伦"], album: "十一月的萧邦" }
        ]
      }
    });

    // 1. 为室友分配
    const rmView = await service.assign("owner", roomId, roommateMemberId, { playlistId: "pl-fav-shared" });
    expect(rmView.playlist).toEqual({ id: "pl-fav-shared", name: "热门榜" });
    expect(rmView.snapshot?.tracks).toHaveLength(2);
    expect(rmView.snapshot?.tracks[0].name).toBe("七里香");

    // 2. 为房主本人也分配同一歌单（多对一支持）
    const ownerView = await service.assign("owner", roomId, ownerMemberId, { playlistId: "pl-fav-shared" });
    expect(ownerView.playlist).toEqual({ id: "pl-fav-shared", name: "热门榜" });

    // 3. 更换室友歌单，generation 递增
    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: {
          id: "pl-fav-new",
          name: "新歌单",
          creatorId: "other-user-2",
          subscribed: true,
          status: 0
        },
        songIds: ["song-new"],
        songs: [
          { id: "song-new", name: "新歌", artists: ["歌手"], album: "专辑" }
        ]
      }
    });
    const replaced = await service.assign("owner", roomId, roommateMemberId, { playlistId: "pl-fav-new" });
    expect(replaced.playlist).toEqual({ id: "pl-fav-new", name: "新歌单" });

    // 4. 非房主禁止分配
    await expect(service.assign("roommate", roomId, roommateMemberId, { playlistId: "pl-fav-new" })).rejects.toThrowError(
      expect.objectContaining({ code: "ROOM_OWNER_REQUIRED" })
    );

    // 5. 分配自建歌单被拒绝
    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: {
          id: "pl-self-created",
          name: "自建",
          creatorId: "cloud-owner",
          subscribed: false,
          status: 0
        },
        songIds: [],
        songs: []
      }
    });
    await expect(service.assign("owner", roomId, roommateMemberId, { playlistId: "pl-self-created" })).rejects.toThrowError(
      expect.objectContaining({ code: "TARGET_PERMISSION" })
    );
  });

  it("房主可解除成员歌单分配，非房主禁止解除", async () => {
    const { adapter, service, roomId, roommateMemberId } = fixture();
    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: {
          id: "pl-to-unassign",
          name: "待解除歌单",
          creatorId: "other-creator",
          subscribed: true,
          status: 0
        },
        songIds: ["s1"],
        songs: [{ id: "s1", name: "歌", artists: [], album: "" }]
      }
    });

    await service.assign("owner", roomId, roommateMemberId, { playlistId: "pl-to-unassign" });
    expect(service.read("owner", roomId, roommateMemberId).playlist).not.toBeNull();

    // 非房主解除被拒绝
    await expect(service.unassign("roommate", roomId, roommateMemberId)).rejects.toThrowError(
      expect.objectContaining({ code: "ROOM_OWNER_REQUIRED" })
    );

    // 房主解除
    const unassigned = await service.unassign("owner", roomId, roommateMemberId);
    expect(unassigned.playlist).toBeNull();
    expect(service.read("owner", roomId, roommateMemberId).playlist).toBeNull();
  });
});
