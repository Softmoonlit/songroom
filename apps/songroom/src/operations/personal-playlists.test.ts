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
  publicPlaylistBinding,
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

  it("候选包含有效自建、我喜欢和私密自建，过滤非收藏他人歌单及失效自建；未授权时报错，授权室友可拉取自身歌单", async () => {
    const { database, vault, adapter, service, roomId } = fixture();
    adapter.userPlaylists = async () => ({
      ok: true,
      data: {
        playlists: [
          { id: "pl-self", name: "自建歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
          { id: "pl-fav-1", name: "他人收藏歌单1", creatorId: "other-user", subscribed: true, status: 0, trackCount: 50, creatorNickname: "作者A", coverImgUrl: "http://cover/1.jpg" },
          { id: "pl-liked", name: "改过名字的喜欢列表", creatorId: "cloud-owner", subscribed: false, status: 0, specialType: 5 },
          { id: "pl-named-liked", name: "我喜欢的音乐", creatorId: "cloud-owner", subscribed: true, status: 0, specialType: 0 },
          { id: "pl-other-special", name: "他人的特殊歌单", creatorId: "other-user", subscribed: true, status: 0, specialType: 5 },
          { id: "pl-own-private", name: "自建私密歌单", creatorId: "cloud-owner", subscribed: false, status: 0, privacy: 10 },
          { id: "pl-own-invalid", name: "失效自建", creatorId: "cloud-owner", subscribed: false, status: -1 },
          { id: "pl-fav-invalid", name: "失效收藏", creatorId: "other-user", subscribed: true, status: 10 },
          { id: "pl-fav-unsub", name: "未收藏", creatorId: "other-user", subscribed: false, status: 0 }
        ],
        more: false
      }
    });

    const candidates = await service.getCandidates("owner", roomId);
    expect(candidates.candidates.map(candidate => candidate.id)).toEqual([
      "pl-self", "pl-fav-1", "pl-liked", "pl-named-liked", "pl-other-special", "pl-own-private"
    ]);
    expect(candidates.candidates.map(candidate => candidate.sourceType)).toEqual([
      "created", "favorite", "liked", "created", "favorite", "created"
    ]);
    expect(candidates.candidates.find(candidate => candidate.id === "pl-fav-1")).toEqual({
      sourceType: "favorite",
      id: "pl-fav-1", name: "他人收藏歌单1", creatorNickname: "作者A",
      coverImgUrl: "http://cover/1.jpg", trackCount: 50
    });

    // 室友未绑定网易云授权时拉取报错
    await expect(service.getCandidates("roommate", roomId)).rejects.toThrowError(
      expect.objectContaining({ code: "NETEASE_AUTH_REQUIRED" })
    );

    // 为室友添加网易云授权后，室友可获取自己的候选歌单
    const rmAuthId = v7();
    database.insert(neteaseAuthorization).values({
      id: rmAuthId,
      userId: "roommate",
      accountId: "cloud-roommate",
      generation: 1,
      nickname: "室友网易云",
      status: "active",
      credentials: vault.encrypt("MUSIC_U=roommate-cookie", { authorizationId: rmAuthId, accountId: "cloud-roommate", generation: 1 })
    }).run();

    adapter.userPlaylists = async () => ({
      ok: true,
      data: {
        playlists: [
          { id: "pl-rm-fav", name: "室友自建", creatorId: "cloud-roommate", subscribed: false, status: 0 }
        ],
        more: false
      }
    });
    const rmCandidates = await service.getCandidates("roommate", roomId);
    expect(rmCandidates.candidates.map(c => c.id)).toEqual(["pl-rm-fav"]);
  });

  it("候选排除同账号本房间及其他房间公共目标，保留普通自建歌单", async () => {
    const { database, adapter, service, roomId } = fixture();
    const otherRoomId = v7();
    database.insert(room).values({ id: otherRoomId, name: "另一房间", ownerUserId: "owner" }).run();
    database.insert(publicPlaylistBinding).values([
      { roomId, accountId: "cloud-owner", playlistId: "public-here", name: "本房间公共", creationOperationId: v7() },
      { roomId: otherRoomId, accountId: "cloud-owner", playlistId: "public-other", name: "其他房间公共", creationOperationId: v7() }
    ]).run();
    adapter.userPlaylists = async () => ({ ok: true, data: {
      playlists: ["public-here", "ordinary-own", "public-other"].map(id => ({
        id, name: id, creatorId: "cloud-owner", subscribed: false, status: 0
      })), more: false
    } });
    expect((await service.getCandidates("owner", roomId)).candidates.map(candidate => candidate.id))
      .toEqual(["ordinary-own"]);
  });

  it.each(["本房间", "其他房间"])("绑定%s公共目标返回 409，保留原个人绑定与快照", async scope => {
    const { database, adapter, service, roomId } = fixture();
    adapter.detail = async (input: Extract<AdapterInput, { operation: "playlistDetail" }>) => ({ ok: true, data: {
      playlist: { id: input.playlistId, name: input.playlistId, creatorId: "cloud-owner", subscribed: false, status: 0 },
      songIds: ["kept"], songs: [{ id: "kept", name: "原歌曲", artists: [], album: "" }]
    } });
    await service.bind("owner", roomId, { playlistId: "original-personal" });
    const before = service.read("owner", roomId);
    const targetRoomId = scope === "本房间" ? roomId : v7();
    if (targetRoomId !== roomId) database.insert(room).values({ id: targetRoomId, name: "另一房间", ownerUserId: "owner" }).run();
    database.insert(publicPlaylistBinding).values({
      roomId: targetRoomId, accountId: "cloud-owner", playlistId: "public-target", name: "公共目标", creationOperationId: v7()
    }).run();
    await expect(service.bind("owner", roomId, { playlistId: "public-target" }))
      .rejects.toThrowError(expect.objectContaining({ status: 409, code: "PLAYLIST_TARGET_CONFLICT" }));
    const after = service.read("owner", roomId);
    expect(after.playlist).toEqual(before.playlist);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(database.select().from(personalPlaylistBinding).all()).toHaveLength(1);
  });

  it("成员自主绑定个人歌单，记录快照与曲目，再次绑定直接覆盖原绑定", async () => {
    const { database, vault, adapter, service, roomId } = fixture();
    const rmAuthId = v7();
    database.insert(neteaseAuthorization).values({
      id: rmAuthId,
      userId: "roommate",
      accountId: "cloud-roommate",
      generation: 1,
      nickname: "室友网易云",
      status: "active",
      credentials: vault.encrypt("MUSIC_U=roommate-cookie", { authorizationId: rmAuthId, accountId: "cloud-roommate", generation: 1 })
    }).run();

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

    // 1. 室友自主绑定
    const rmView = await service.bind("roommate", roomId, { playlistId: "pl-fav-shared" });
    expect(rmView.playlist).toEqual({ id: "pl-fav-shared", name: "热门榜" });
    expect(rmView.snapshot?.tracks).toHaveLength(2);
    expect(rmView.snapshot?.tracks[0].name).toBe("七里香");

    // 2. 房主也自主绑定同一歌单（多对一支持）
    const ownerView = await service.bind("owner", roomId, { playlistId: "pl-fav-shared" });
    expect(ownerView.playlist).toEqual({ id: "pl-fav-shared", name: "热门榜" });

    // 3. 室友更换歌单覆盖原绑定，generation 递增
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
    const replaced = await service.bind("roommate", roomId, { playlistId: "pl-fav-new" });
    expect(replaced.playlist).toEqual({ id: "pl-fav-new", name: "新歌单" });

    // 4. 未绑定网易云的用户禁止绑定歌单
    await expect(service.bind("outsider", roomId, { playlistId: "pl-fav-new" })).rejects.toThrowError(
      expect.objectContaining({ code: "ROOM_UNAVAILABLE" })
    );

    // 5. 绑定自建歌单
    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: {
          id: "pl-self-created",
          name: "自建",
          creatorId: "cloud-roommate",
          subscribed: false,
          status: 0
        },
        songIds: [],
        songs: []
      }
    });
    const ownView = await service.bind("roommate", roomId, { playlistId: "pl-self-created" });
    expect(ownView.playlist).toEqual({ id: "pl-self-created", name: "自建" });
    expect(ownView.lastRefreshError).toBeNull();
  });

  it.each([
    { name: "自建", creatorId: "cloud-owner", subscribed: false, privacy: 0 },
    { name: "我喜欢的音乐", creatorId: "cloud-owner", subscribed: false, privacy: 0, specialType: 5 },
    { name: "自建私密", creatorId: "cloud-owner", subscribed: false, privacy: 10 },
    { name: "收藏", creatorId: "other", subscribed: true, privacy: 0 }
  ])("$name 绑定后刷新仍有效并更新快照", async metadata => {
    const { adapter, service, roomId } = fixture();
    let songId = "before";
    adapter.detail = async () => ({ ok: true, data: {
      playlist: { id: "pl-source", ...metadata, status: 0 },
      songIds: [songId], songs: [{ id: songId, name: songId, artists: [], album: "" }]
    } });
    const assigned = await service.bind("owner", roomId, { playlistId: "pl-source" });
    expect(assigned.snapshot?.tracks.map(track => track.songId)).toEqual(["before"]);
    songId = "after";
    const refreshed = await service.refresh("owner", roomId);
    expect(refreshed.playlist).toEqual({ id: "pl-source", name: metadata.name });
    expect(refreshed.lastRefreshError).toBeNull();
    expect(refreshed.disabledReason).toBeNull();
    expect(refreshed.snapshot?.tracks.map(track => track.songId)).toEqual(["after"]);
  });

  it.each([
    { name: "未收藏他人", creatorId: "other", subscribed: false, status: 0 },
    { name: "失效自建", creatorId: "cloud-owner", subscribed: false, status: -1 },
    { name: "失效自建且已收藏", creatorId: "cloud-owner", subscribed: true, status: 10 }
  ])("$name 拒绝绑定，已绑定后失效刷新保留最后成功快照", async metadata => {
    const { adapter, service, roomId } = fixture();
    const detail = (playlist: typeof metadata) => ({ ok: true, data: {
      playlist: { id: "pl-invalid", ...playlist, privacy: 10 },
      songIds: ["kept"], songs: [{ id: "kept", name: "保留歌曲", artists: [], album: "" }]
    } });
    adapter.detail = async () => detail(metadata);
    await expect(service.bind("owner", roomId, { playlistId: "pl-invalid" }))
      .rejects.toThrowError(expect.objectContaining({ code: "TARGET_PERMISSION" }));
    expect(service.read("owner", roomId).playlist).toBeNull();
    adapter.detail = async () => detail({ ...metadata, creatorId: "cloud-owner", status: 0 });
    await service.bind("owner", roomId, { playlistId: "pl-invalid" });
    adapter.detail = async () => detail(metadata);
    const refreshed = await service.refresh("owner", roomId);
    expect(refreshed.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(refreshed.disabledReason).toBe("TARGET_BLOCKED");
    expect(refreshed.snapshot?.tracks.map(track => track.songId)).toEqual(["kept"]);
  });

  it("外部收藏歌单在网易云失效（作者删除或取消收藏）：刷新记录 TARGET_PERMISSION，保留原有快照与歌曲", async () => {
    const { adapter, service, roomId } = fixture();
    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: {
          id: "pl-fav-expiring",
          name: "将失效歌单",
          creatorId: "other-creator",
          subscribed: true,
          status: 0
        },
        songIds: ["song-keep-1", "song-keep-2"],
        songs: [
          { id: "song-keep-1", name: "保留歌曲1", artists: ["歌手A"], album: "专辑A" },
          { id: "song-keep-2", name: "保留歌曲2", artists: ["歌手B"], album: "专辑B" }
        ]
      }
    });

    // 1. 绑定并建立初始成功快照
    await service.bind("owner", roomId, { playlistId: "pl-fav-expiring" });
    const initialView = service.read("owner", roomId);
    expect(initialView.snapshot?.tracks).toHaveLength(2);
    expect(initialView.lastRefreshError).toBeNull();
    expect(initialView.disabledReason).toBeNull();

    // 2. 模拟取消了收藏 (subscribed = false)
    adapter.detail = async () => ({
      ok: true,
      data: {
        playlist: {
          id: "pl-fav-expiring",
          name: "将失效歌单",
          creatorId: "other-creator",
          subscribed: false,
          status: 0
        },
        songIds: ["song-keep-1"],
        songs: [{ id: "song-keep-1", name: "保留歌曲1", artists: ["歌手A"], album: "专辑A" }]
      }
    });

    const refreshedView = await service.refresh("owner", roomId);
    expect(refreshedView.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(refreshedView.disabledReason).toBe("TARGET_BLOCKED");
    // 保留最后一次成功快照
    expect(refreshedView.snapshot?.tracks).toHaveLength(2);
    expect(refreshedView.snapshot?.tracks[0].name).toBe("保留歌曲1");
    expect(refreshedView.snapshot?.tracks[1].name).toBe("保留歌曲2");

    // 3. 模拟失去歌单读取权限（TARGET_PERMISSION）
    adapter.detail = async () => ({
      ok: false,
      error: { code: "TARGET_PERMISSION", outcome: "failed" }
    });

    const refreshedDeleted = await service.refresh("owner", roomId);
    expect(refreshedDeleted.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(refreshedDeleted.disabledReason).toBe("TARGET_BLOCKED");
    expect(refreshedDeleted.snapshot?.tracks).toHaveLength(2);
  });
});
