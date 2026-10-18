import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { neteaseAuthorization, operation, personalPlaylistBinding, personalPlaylistCreation, playlistSnapshot, playlistTrack, publicPlaylistBinding, publicPlaylistCleanup, room, roomMembership, user } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { EventStreamService } from "../events/event-stream.js";
import { PublicPlaylists } from "./public-playlists.js";
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
        name: input.playlistId === "pl-created-1"
          ? "房主自建我喜欢的歌"
          : input.playlistId === "pl-sub-2"
          ? "房主收藏周杰伦精选"
          : "songroom-主房间-室友",
        creatorId: "cloud-owner",
        subscribed: input.playlistId === "pl-sub-2",
        status: 0
      },
      songIds: ["song-1", "song-2"],
      songs: [
        { id: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
        { id: "song-2", name: "七里香", artists: ["周杰伦"], album: "七里香" }
      ]
    }
  });
  create: (input: Extract<AdapterInput, { operation: "playlistCreate" }>) => Promise<AdapterResult<"playlistCreate">> = async () => ({
    ok: true,
    data: { playlistId: "pl-roommate-dedicated" }
  });

  async assertVendorIntegrity() {}
  async dispose() {}
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);
    if (input.operation === "identity") return await this.identity(input) as AdapterResult<I["operation"]>;
    if (input.operation === "userPlaylists") return await this.userPlaylists(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistDetail") return await this.detail(input) as AdapterResult<I["operation"]>;
    if (input.operation === "playlistCreate") return await this.create(input) as AdapterResult<I["operation"]>;
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
  it("未配置时所有成员仅可创建自己的个人歌单，局外人不能读写", () => {
    const { service, roomId } = fixture();
    expect(service.read("owner", roomId).allowedActions).toEqual(["createPersonalPlaylist"]);
    expect(service.read("roommate", roomId).allowedActions).toEqual(["createPersonalPlaylist"]);
    expect(() => service.read("outsider", roomId)).toThrowError(expect.objectContaining({ code: "ROOM_UNAVAILABLE" }));
    expect(() => service.create("outsider", roomId, { idempotencyKey: v7() })).toThrowError(expect.objectContaining({ code: "ROOM_UNAVAILABLE" }));
  });

  it("房主在不同房间分别主动创建个人歌单，不共享目标或快照", async () => {
    const { database, adapter, service, roomId, scheduler } = fixture();
    const secondRoomId = v7();
    database.insert(room).values({ id: secondRoomId, name: "第二房间", ownerUserId: "owner" }).run();
    database.insert(roomMembership).values({ id: v7(), roomId: secondRoomId, userId: "owner", nickname: "另一昵称" }).run();
    let nextId = 0;
    adapter.create = async () => ({ ok: true, data: { playlistId: `dedicated-${++nextId}` } });
    service.create("owner", roomId, { idempotencyKey: v7() });
    service.create("owner", secondRoomId, { idempotencyKey: v7() });
    await scheduler.settle();
    expect(service.read("owner", roomId).playlist?.id).toBe("dedicated-1");
    expect(service.read("owner", secondRoomId).playlist?.id).toBe("dedicated-2");
    expect(adapter.inputs.filter(i => i.operation === "playlistCreate")).toEqual([
      expect.objectContaining({ name: "songroom-主房间-房主", cookie: "MUSIC_U=owner-cookie" }),
      expect.objectContaining({ name: "songroom-第二房间-另一昵称", cookie: "MUSIC_U=owner-cookie" })
    ]);
  });

  it("其他成员只能从成员详情只读查看房主个人歌单，不获得维护或点歌来源资格", async () => {
    const { service, roomId, ownerMemberId, scheduler } = fixture();
    service.create("owner", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

    // 室友在我的歌单 tab 尚未配置
    const roommateSelfView = service.read("roommate", roomId);
    expect(roommateSelfView.playlist).toBeNull();

    // 室友在成员详情中查看房主的个人歌单
    const ownerFromRoommateView = service.read("roommate", roomId, ownerMemberId);
    expect(ownerFromRoommateView.playlist?.id).toBe("pl-roommate-dedicated");
    expect(ownerFromRoommateView.snapshot?.trackCount).toBe(2);
    // 只读：不获得任何操作动作
    expect(ownerFromRoommateView.allowedActions).toEqual([]);
  });

  it("刷新失败时保留已有快照，并正确记录 lastRefreshError", async () => {
    const { adapter, service, roomId, scheduler } = fixture();
    service.create("owner", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

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

  it("相同用户的创建幂等键不能用于不同房间", () => {
    const { database, service, roomId } = fixture();
    const secondRoomId = v7();
    database.insert(room).values({ id: secondRoomId, name: "第二房间", ownerUserId: "owner" }).run();
    database.insert(roomMembership).values({ id: v7(), roomId: secondRoomId, userId: "owner", nickname: "房主" }).run();
    const key = v7();
    service.create("owner", roomId, { idempotencyKey: key });
    expect(() => service.create("owner", secondRoomId, { idempotencyKey: key })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("成员清理后晚到的刷新错误不重新建立已删除快照", async () => {
    const { database, adapter, service, roomId, roommateMemberId, scheduler } = fixture();
    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    adapter.detail = async () => {
      database.delete(roomMembership).where(eq(roomMembership.id, roommateMemberId)).run();
      database.delete(playlistTrack).run();
      database.delete(playlistSnapshot).run();
      return { ok: false, error: { code: "NETWORK_ERROR", outcome: "failed" } };
    };
    await expect(service.refresh("owner", roomId, roommateMemberId)).rejects.toThrowError(
      expect.objectContaining({ code: "ROOM_UNAVAILABLE" })
    );
    expect(database.select().from(playlistSnapshot).all()).toEqual([]);
  });

  it("歌单详情响应歌曲不完整或截断时拒绝提交快照并记录 PARSE_ERROR", async () => {
    const { adapter, service, roomId, scheduler } = fixture();
    service.create("owner", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

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

  it("刷新只接受房主真实账号创建的专用目标，保留原快照并报告权限错误", async () => {
    const { adapter, service, roomId, scheduler } = fixture();
    service.create("owner", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    adapter.detail = async input => ({
      ok: true,
      data: {
        playlist: { id: input.playlistId, name: "他人的歌单", creatorId: "someone-else", subscribed: true, status: 0 },
        songIds: [], songs: []
      }
    });
    adapter.inputs = [];
    const view = await service.refresh("owner", roomId);
    expect(view.lastRefreshError).toBe("TARGET_PERMISSION");
    expect(view.snapshot?.trackCount).toBe(2);
    expect(adapter.inputs.map(input => input.operation)).toEqual(["playlistDetail"]);
  });

  it("室友主动创建自己的个人歌单，视图只返回目标 ID 和名称", async () => {
    const { service, roomId, scheduler } = fixture();
    const result = service.create("roommate", roomId, { idempotencyKey: v7() });
    expect(result.accepted).toBe(true);
    expect(result.view.operation?.status).toBe("queued");

    // 等待调度器异步执行完成
    await scheduler.settle();

    const readView = service.read("roommate", roomId);
    expect(readView.playlist).toEqual({
      id: "pl-roommate-dedicated",
      name: "songroom-主房间-室友"
    });
    expect(readView.allowedActions).toEqual(["refreshPersonalPlaylist"]);
    expect(readView.snapshot?.trackCount).toBe(2);
  });

  it("房主与室友一样可主动创建自己的专用个人歌单", async () => {
    const { service, roomId, scheduler } = fixture();
    expect(service.read("owner", roomId).allowedActions).toEqual(["createPersonalPlaylist"]);
    const result = service.create("owner", roomId, { idempotencyKey: v7() });
    expect(result.accepted).toBe(true);
    await scheduler.settle();
    expect(service.read("owner", roomId).operation?.status).toBe("succeeded");
    expect(service.read("owner", roomId).playlist).toEqual({
      id: "pl-roommate-dedicated", name: "songroom-主房间-室友"
    });
  });

  it("已有个人歌单的室友再次创建被 409 拒绝（PERSONAL_PLAYLIST_EXISTS）", async () => {
    const { service, roomId, scheduler } = fixture();
    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

    expect(() => service.create("roommate", roomId, { idempotencyKey: v7() })).toThrowError(
      expect.objectContaining({ code: "PERSONAL_PLAYLIST_EXISTS" })
    );
  });

  it("同成员同一房间存在未完成写操作时拒绝新的创建（409 OPERATION_PENDING）", async () => {
    const { service, roomId } = fixture();
    // 首次创建被受理处于排队中
    service.create("roommate", roomId, { idempotencyKey: v7() });

    // 再次用不同 idempotencyKey 创建
    expect(() => service.create("roommate", roomId, { idempotencyKey: v7() })).toThrowError(
      expect.objectContaining({ code: "OPERATION_PENDING" })
    );
  });

  it("创建专用个人歌单同键重放返回原操作，不重复发送创建", async () => {
    const { adapter, scheduler, service, roomId } = fixture();
    const key = v7();
    const first = service.create("roommate", roomId, { idempotencyKey: key });
    expect(first.accepted).toBe(true);

    const replayed = service.create("roommate", roomId, { idempotencyKey: key });
    expect(replayed.accepted).toBe(false);
    expect(replayed.view.operation?.id).toBe(first.view.operation?.id);
    await scheduler.settle();
    expect(service.create("roommate", roomId, { idempotencyKey: key }).accepted).toBe(false);
    expect(adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
  });

  it("房主网易云账号已风控暂停或授权失效时拒绝室友创建（ACCOUNT_PAUSED / NETEASE_AUTH_REQUIRED）", async () => {
    const { database, service, roomId, scheduler } = fixture();
    scheduler.pause("cloud-owner");

    expect(() => service.create("roommate", roomId, { idempotencyKey: v7() })).toThrowError(
      expect.objectContaining({ code: "ACCOUNT_PAUSED" })
    );

    scheduler.resume("cloud-owner");
    // 置授权为失效
    database.update(neteaseAuthorization).set({ status: "waitingAuthorization" }).where(eq(neteaseAuthorization.userId, "owner")).run();

    expect(() => service.create("roommate", roomId, { idempotencyKey: v7() })).toThrowError(
      expect.objectContaining({ code: "NETEASE_AUTH_REQUIRED" })
    );
  });

  it("创建响应指向其他成员已用目标时保持待管理员核查，不共用目标", async () => {
    const { service, roomId, scheduler } = fixture();
    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    service.create("owner", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    expect(service.read("owner", roomId).playlist).toBeNull();
    expect(service.read("owner", roomId).operation?.status).toBe("needsAdministrator");
    expect(service.read("roommate", roomId).playlist?.id).toBe("pl-roommate-dedicated");
  });

  it.each(["personal", "public"])("其他账号的 %s 目标使用相同歌单 ID，不阻止当前账号创建", async kind => {
    const { database, vault, adapter, service, roomId, scheduler } = fixture();
    if (kind === "personal") {
      service.create("roommate", roomId, { idempotencyKey: v7() });
      await scheduler.settle();
    } else {
      database.insert(publicPlaylistBinding).values({
        roomId, accountId: "cloud-owner", playlistId: "pl-roommate-dedicated", name: "另一个账号公共歌单", creationOperationId: v7()
      }).run();
    }
    const secondRoomId = v7();
    database.insert(room).values({ id: secondRoomId, name: "独立账号房间", ownerUserId: "outsider" }).run();
    database.insert(roomMembership).values({ id: v7(), roomId: secondRoomId, userId: "outsider", nickname: "另一房主" }).run();
    const authorizationId = v7();
    database.insert(neteaseAuthorization).values({
      id: authorizationId, userId: "outsider", accountId: "cloud-other", generation: 1, nickname: "另一网易云", status: "active",
      credentials: vault.encrypt("MUSIC_U=other-cookie", { authorizationId, accountId: "cloud-other", generation: 1 })
    }).run();
    adapter.identity = async input => ({ ok: true, data: { accountId: input.cookie === "MUSIC_U=other-cookie" ? "cloud-other" : "cloud-owner", name: "当前账号" } });
    const originalDetail = adapter.detail;
    adapter.detail = async input => {
      const result = await originalDetail(input);
      if (result.ok && input.cookie === "MUSIC_U=other-cookie") result.data.playlist.creatorId = "cloud-other";
      return result;
    };
    service.create("outsider", secondRoomId, { idempotencyKey: v7() });
    await scheduler.settle();
    const view = service.read("outsider", secondRoomId);
    expect(view.operation?.status).toBe("succeeded");
    expect(view.playlist?.id).toBe("pl-roommate-dedicated");
    expect(service.read("roommate", roomId).playlist?.id).toBe(kind === "personal" ? "pl-roommate-dedicated" : undefined);
  });

  it("创建返回公共歌单已用目标时不建立个人绑定或清理公共资源", async () => {
    const { database, service, roomId, scheduler } = fixture();
    database.insert(publicPlaylistBinding).values({
      roomId, accountId: "cloud-owner", playlistId: "pl-roommate-dedicated", name: "公共歌单", creationOperationId: v7()
    }).run();
    service.create("owner", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    const view = service.read("owner", roomId);
    expect(view.playlist).toBeNull();
    expect(view.operation?.status).toBe("needsAdministrator");
    expect(view.operation?.errorCode).toBe("TARGET_PERMISSION");
    expect(database.select().from(publicPlaylistCleanup).all()).toEqual([]);
  });

  it("创建过程遇到明确失败（outcome: failed）时直接标记为 failed，不进入 needsAdministrator", async () => {
    const { adapter, service, roomId, scheduler } = fixture();
    adapter.create = async () => ({
      ok: false,
      error: { code: "TARGET_PERMISSION", message: "无权创建", outcome: "failed" }
    });

    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

    const view = service.read("roommate", roomId);
    expect(view.playlist).toBeNull();
    expect(view.operation?.status).toBe("failed");
    expect(view.operation?.errorCode).toBe("TARGET_PERMISSION");
  });

  it("创建过程遇到上游未知异常时安全记录证据并进入 needsAdministrator 状态", async () => {
    const { adapter, service, roomId, scheduler } = fixture();
    adapter.create = async () => {
      throw new Error("network timeout");
    };

    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

    const view = service.read("roommate", roomId);
    expect(view.playlist).toBeNull();
    expect(view.operation?.status).toBe("needsAdministrator");
    expect(view.operation?.step).toBe("unknown");
    expect(view.disabledReason).toBe("OPERATION_PENDING");
    scheduler.stop();
    await scheduler.settle();
    scheduler.start();
    await scheduler.settle();
    expect(service.read("roommate", roomId).operation?.step).toBe("unknown");
    expect(adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
  });

  it("退出后晚到的未知创建补查只保留目标 ID，不重新保存成员昵称和清单名称", async () => {
    const { database, adapter, service, roomId, scheduler } = fixture();
    adapter.create = async () => {
      database.delete(roomMembership).where(eq(roomMembership.userId, "roommate")).run();
      adapter.userPlaylists = async () => ({ ok: true, data: {
        playlists: [{ id: "unknown-created", name: "songroom-主房间-室友", creatorId: "cloud-owner", subscribed: false, status: 0 }],
        more: false
      } });
      throw new Error("unknown create result");
    };
    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    const detail = database.select().from(personalPlaylistCreation).get();
    expect(detail).toMatchObject({
      name: "songroom-cleanup", step: "unknown",
      beforePlaylists: '[{"id":"pl-created-1","name":""},{"id":"pl-sub-2","name":""}]',
      afterPlaylists: '[{"id":"unknown-created","name":""}]'
    });
    expect(database.select().from(operation).get()?.status).toBe("needsAdministrator");
  });

  it.each(["not-json", "{}", '[{"name":"旧昵称"}]'])("退出后未知创建证据格式损坏（%s）时保存 null，仍可等待核查", async beforeEvidence => {
    const { database, adapter, service, roomId, scheduler } = fixture();
    adapter.create = async () => {
      database.update(personalPlaylistCreation).set({ beforePlaylists: beforeEvidence }).run();
      database.delete(roomMembership).where(eq(roomMembership.userId, "roommate")).run();
      throw new Error("unknown create result");
    };
    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    expect(database.select().from(personalPlaylistCreation).get()).toMatchObject({
      name: "songroom-cleanup", step: "unknown", beforePlaylists: null
    });
    expect(database.select().from(operation).get()?.status).toBe("needsAdministrator");
  });

  it("24小时后终结操作被清理，不会因外键阻碍修剪已绑定专用歌单", async () => {
    const { database, service, roomId, scheduler } = fixture();
    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

    const readView = service.read("roommate", roomId);
    expect(readView.playlist?.id).toBe("pl-roommate-dedicated");

    // 模拟 25 小时后修剪终结操作
    const past = Date.now() - 25 * 60 * 60 * 1000;
    database.update(operation).set({ updatedAt: past }).run();

    // 触发下一次 prune 操作（比如创建新房间并调用 prune）
    expect(() => {
      database.delete(operation).where(
        eq(operation.kind, "createPersonalPlaylist")
      ).run();
    }).not.toThrow();

    // 绑定依然有效存活
    const binding = database.select().from(personalPlaylistBinding).where(eq(personalPlaylistBinding.roomId, roomId)).get();
    expect(binding).toBeDefined();
    expect(binding?.playlistId).toBe("pl-roommate-dedicated");
  });

  it("创建执行期间室友被移除，删除创建详情并将原目标转入最小清理任务", async () => {
    const { database, adapter, service, roomId, scheduler } = fixture();
    // 拦截创建：在 playlistCreate 成功拿到 ID 之后，模拟室友被移除
    adapter.create = async () => {
      // 模拟室友在写入上游期间被移除
      database.delete(roomMembership).where(eq(roomMembership.userId, "roommate")).run();
      return { ok: true, data: { playlistId: "pl-roommate-late" } };
    };

    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

    expect(database.select().from(personalPlaylistCreation).get()).toBeUndefined();
    expect(database.select().from(operation).get()?.status).toBe("stopped");

    // 绑定未建立
    const binding = database.select().from(personalPlaylistBinding).where(eq(personalPlaylistBinding.roomId, roomId)).get();
    expect(binding).toBeUndefined();

    // 转化为云端清理任务
    const cleanups = database.select().from(publicPlaylistCleanup).all();
    expect(cleanups.length).toBe(1);
    expect(cleanups[0].playlistId).toBe("pl-roommate-late");
  });

  it("创建写入期间同账号退出后重新加入，晚到结果只清理旧成员目标", async () => {
    const { database, adapter, service, roomId, scheduler } = fixture();
    adapter.create = async () => {
      database.delete(roomMembership).where(eq(roomMembership.userId, "roommate")).run();
      database.insert(roomMembership).values({ id: v7(), roomId, userId: "roommate", nickname: "新成员" }).run();
      return { ok: true, data: { playlistId: "old-member-target" } };
    };
    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    expect(service.read("roommate", roomId).playlist).toBeNull();
    expect(service.read("roommate", roomId).operation).toBeNull();
    expect(database.select().from(publicPlaylistCleanup).get()).toMatchObject({
      userId: "owner", accountId: "cloud-owner", playlistId: "old-member-target"
    });
  });

  it("已获目标 ID 后原账号重新授权可安全完成绑定，不重发创建", async () => {
    const { database, vault, adapter, service, roomId, scheduler } = fixture();
    adapter.create = async () => {
      database.update(neteaseAuthorization).set({ status: "waitingAuthorization" }).where(eq(neteaseAuthorization.userId, "owner")).run();
      return { ok: true, data: { playlistId: "known-target" } };
    };
    service.create("owner", roomId, { idempotencyKey: v7() });
    await scheduler.settle();
    expect(service.read("owner", roomId).operation?.status).toBe("waitingAuthorization");
    const auth = database.select().from(neteaseAuthorization).get()!;
    database.update(neteaseAuthorization).set({ status: "active", generation: 2,
      credentials: vault.encrypt("MUSIC_U=owner-cookie", { authorizationId: auth.id, accountId: auth.accountId, generation: 2 })
    }).where(eq(neteaseAuthorization.id, auth.id)).run();
    service.onReauthorized("owner", auth.id, auth.accountId, 2);
    await scheduler.settle();
    expect(service.read("owner", roomId).playlist?.id).toBe("known-target");
    expect(service.read("owner", roomId).operation?.status).toBe("succeeded");
    expect(adapter.inputs.filter(input => input.operation === "playlistCreate")).toHaveLength(1);
  });

  it("创建期间房主授权代次变化，不恢复绑定到新代次", async () => {
    const { database, adapter, service, roomId, scheduler } = fixture();
    adapter.create = async () => {
      // 模拟房主重新授权，generation 从 1 变为 2
      database.update(neteaseAuthorization).set({ generation: 2 }).where(eq(neteaseAuthorization.userId, "owner")).run();
      return { ok: true, data: { playlistId: "pl-gen-mismatch" } };
    };

    service.create("roommate", roomId, { idempotencyKey: v7() });
    await scheduler.settle();

    // 绑定未建立，操作进入 waitingAuthorization
    const binding = database.select().from(personalPlaylistBinding).where(eq(personalPlaylistBinding.roomId, roomId)).get();
    expect(binding).toBeUndefined();

    const op = database.select().from(operation).get()!;
    expect(op.status).toBe("waitingAuthorization");
  });
});
