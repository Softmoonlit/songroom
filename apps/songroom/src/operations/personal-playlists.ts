import { and, eq, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import {
  neteaseAuthorization,
  personalPlaylistBinding,
  playlistSnapshot,
  playlistTrack,
  publicPlaylistBinding,
  room,
  roomMembership
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterErrorCode, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { EventStreamService } from "../events/event-stream.js";
import { BusinessError } from "../shared/errors.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import {
  type PersonalPlaylistBindCommand,
  type PersonalPlaylistCandidatesView,
  type PersonalPlaylistCandidate,
  type PersonalPlaylistUnbindCommand,
  type PersonalPlaylistView
} from "../shared/personal-playlist-contracts.js";

type DatabaseTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export class PersonalPlaylists {
  readonly #inFlightRefreshes = new Map<string, Promise<void>>();
  #readCounter = 0;

  constructor(
    private readonly database: AppDatabase,
    private readonly vault: CredentialVault,
    private readonly adapter: NeteaseAdapter,
    private readonly scheduler: UpstreamScheduler,
    private readonly eventStream: EventStreamService,
    private readonly now: () => number = () => Date.now()
  ) {}

  #beginRead(): number {
    return ++this.#readCounter;
  }

  async candidates(userId: string, roomId: string): Promise<PersonalPlaylistCandidatesView> {
    const member = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);
    if (roomRow.ownerUserId !== userId) {
      throw new BusinessError(403, "OWNER_ONLY", "只有房主可以获取自建与收藏歌单");
    }

    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, userId)).get();
    if (!auth || auth.status !== "active" || !auth.credentials) {
      return {
        candidates: [],
        allowedActions: [],
        disabledReason: "NETEASE_AUTH_REQUIRED"
      };
    }

    if (this.scheduler.paused(auth.accountId)) {
      return {
        candidates: [],
        allowedActions: [],
        disabledReason: "ACCOUNT_PAUSED"
      };
    }

    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, {
        authorizationId: auth.id,
        accountId: auth.accountId,
        generation: auth.generation
      });
    } catch {
      return {
        candidates: [],
        allowedActions: [],
        disabledReason: "NETEASE_AUTH_REQUIRED"
      };
    }

    const playlists = await this.#fetchAccountPlaylists(cookie, auth.accountId);
    if (!playlists) {
      return {
        candidates: [],
        allowedActions: [],
        disabledReason: null
      };
    }

    const candidates = playlists
      .filter(p => p.status === 0)
      .map(p => {
        const isOwner = p.creatorId === auth.accountId;
        const isSubscribed = Boolean(p.subscribed);
        if (isOwner) {
          return {
            id: p.id,
            name: p.name,
            type: "ownerCreated" as const,
            writeable: true
          };
        }
        if (isSubscribed) {
          return {
            id: p.id,
            name: p.name,
            type: "ownerSubscribed" as const,
            writeable: false
          };
        }
        return null;
      })
      .filter((p): p is PersonalPlaylistCandidate => p !== null);

    return {
      candidates,
      allowedActions: ["bindPersonalPlaylist"],
      disabledReason: null
    };
  }

  async bind(userId: string, roomId: string, command: PersonalPlaylistBindCommand): Promise<PersonalPlaylistView> {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const member = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);
    if (roomRow.ownerUserId !== userId) {
      throw new BusinessError(403, "OWNER_ONLY", "只有房主可以绑定个人歌单");
    }

    const prepared = prepareCommand(
      userId,
      command.idempotencyKey,
      "bindPersonalPlaylist",
      { roomId, playlistId: command.playlistId },
      this.now()
    );

    const replayed = readCommandResource(this.database, prepared, this.now());
    if (replayed) {
      return this.read(userId, roomId);
    }

    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, userId)).get();
    if (!auth || auth.status !== "active" || !auth.credentials) {
      throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "网易云授权不可用");
    }
    if (this.scheduler.paused(auth.accountId)) {
      throw new BusinessError(423, "ACCOUNT_PAUSED", "网易云账号已暂停");
    }

    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, {
        authorizationId: auth.id,
        accountId: auth.accountId,
        generation: auth.generation
      });
    } catch {
      throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "网易云授权不可用");
    }

    const accountPlaylists = await this.#fetchAccountPlaylists(cookie, auth.accountId);
    if (!accountPlaylists) {
      throw new BusinessError(502, "MODULE_ERROR", "读取网易云歌单失败");
    }

    const target = accountPlaylists.find(p => p.id === command.playlistId && p.status === 0);
    if (!target) {
      throw new BusinessError(422, "TARGET_PERMISSION", "只能绑定本人创建或已收藏的网易云歌单");
    }

    const isOwner = target.creatorId === auth.accountId;
    const isSubscribed = Boolean(target.subscribed);
    if (!isOwner && !isSubscribed) {
      throw new BusinessError(422, "TARGET_PERMISSION", "只能绑定本人创建或已收藏的网易云歌单");
    }

    const bindingType = isOwner ? ("ownerCreated" as const) : ("ownerSubscribed" as const);
    const writeable = isOwner;
    const now = this.now();

    const result = this.database.transaction(tx => {
      const existing = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, member.id))).get();

      let bindingGen = 1;
      let bindingId = "";
      if (existing) {
        bindingGen = existing.generation + 1;
        bindingId = existing.id;
        tx.update(personalPlaylistBinding).set({
          accountId: auth.accountId,
          playlistId: target.id,
          name: target.name,
          type: bindingType,
          writeable,
          generation: bindingGen,
          updatedAt: now
        }).where(eq(personalPlaylistBinding.id, existing.id)).run();

        if (existing.playlistId !== target.id) {
          this.#cleanupOrphanSnapshot(tx, existing.accountId, existing.playlistId);
        }
      } else {
        bindingId = v7();
        tx.insert(personalPlaylistBinding).values({
          id: bindingId,
          roomId,
          memberId: member.id,
          accountId: auth.accountId,
          playlistId: target.id,
          name: target.name,
          type: bindingType,
          writeable,
          generation: 1,
          createdAt: now,
          updatedAt: now
        }).run();
      }

      recordCommandResource(tx, prepared, bindingId, now);
      this.#bumpRoom(tx, roomId);
      const updatedRoom = tx.select({ version: room.version }).from(room).where(eq(room.id, roomId)).get()!;
      return { version: updatedRoom.version, generation: bindingGen };
    });

    this.eventStream.notifyRoom(this.database, roomId, { type: "room", resourceId: roomId, version: result.version });
    this.eventStream.notifyRoom(this.database, roomId, { type: "snapshot", resourceId: roomId, version: result.version });

    // 触发首次快照读取
    await this.#executeRefresh(userId, auth.accountId, target.id, result.generation);

    return this.read(userId, roomId);
  }

  async unbind(userId: string, roomId: string, command: PersonalPlaylistUnbindCommand): Promise<PersonalPlaylistView> {
    const member = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);
    if (roomRow.ownerUserId !== userId) {
      throw new BusinessError(403, "OWNER_ONLY", "只有房主可以解绑个人歌单");
    }

    const prepared = prepareCommand(
      userId,
      command.idempotencyKey,
      "unbindPersonalPlaylist",
      { roomId },
      this.now()
    );

    const replayed = readCommandResource(this.database, prepared, this.now());
    if (replayed) {
      return this.read(userId, roomId);
    }

    const existing = this.database.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, member.id))).get();

    if (!existing) {
      this.database.transaction(tx => {
        recordCommandResource(tx, prepared, roomId, this.now());
      });
      return this.read(userId, roomId);
    }

    const updatedRoom = this.database.transaction(tx => {
      recordCommandResource(tx, prepared, existing.id, this.now());
      tx.delete(personalPlaylistBinding).where(eq(personalPlaylistBinding.id, existing.id)).run();
      this.#cleanupOrphanSnapshot(tx, existing.accountId, existing.playlistId);
      this.#bumpRoom(tx, roomId);
      return tx.select({ version: room.version }).from(room).where(eq(room.id, roomId)).get()!;
    });

    this.eventStream.notifyRoom(this.database, roomId, { type: "room", resourceId: roomId, version: updatedRoom.version });
    this.eventStream.notifyRoom(this.database, roomId, { type: "snapshot", resourceId: roomId, version: updatedRoom.version });

    return this.read(userId, roomId);
  }

  read(userId: string, roomId: string, memberId?: string): PersonalPlaylistView {
    const callerMember = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);

    let targetMember = callerMember;
    let isSelf = true;
    if (memberId && memberId !== callerMember.id) {
      const found = this.database.select().from(roomMembership)
        .where(and(eq(roomMembership.id, memberId), eq(roomMembership.roomId, roomId))).get();
      if (!found) {
        throw new BusinessError(404, "ROOM_UNAVAILABLE", "未找到指定成员");
      }
      targetMember = found;
      isSelf = false;
    }

    const isOwner = (roomRow.ownerUserId === targetMember.userId);
    const binding = this.database.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, targetMember.id))).get();

    if (!binding) {
      return {
        playlist: null,
        snapshot: null,
        lastRefreshError: null,
        allowedActions: isOwner && isSelf ? ["bindPersonalPlaylist"] : [],
        disabledReason: null,
        version: roomRow.version
      };
    }

    const snap = this.database.select().from(playlistSnapshot)
      .where(and(eq(playlistSnapshot.accountId, binding.accountId), eq(playlistSnapshot.playlistId, binding.playlistId))).get();

    const trackRows = this.database.select().from(playlistTrack)
      .where(and(eq(playlistTrack.accountId, binding.accountId), eq(playlistTrack.playlistId, binding.playlistId)))
      .orderBy(playlistTrack.position).all();

    const tracks = trackRows.map(t => ({
      position: t.position,
      songId: t.songId,
      name: t.name,
      artists: JSON.parse(t.artists) as string[],
      album: t.album
    }));

    const snapshot = snap ? {
      version: snap.snapshotVersion,
      syncedAt: snap.syncedAt,
      trackCount: tracks.length,
      tracks
    } : null;

    let allowedActions: PersonalPlaylistView["allowedActions"] = [];
    if (isOwner && isSelf) {
      allowedActions = ["bindPersonalPlaylist", "unbindPersonalPlaylist", "refreshPersonalPlaylist"];
    }

    return {
      playlist: {
        id: binding.playlistId,
        name: binding.name,
        type: binding.type as any,
        writeable: binding.writeable
      },
      snapshot,
      lastRefreshError: (snap?.lastErrorCode as any) ?? null,
      allowedActions,
      disabledReason: null,
      version: roomRow.version
    };
  }

  async refresh(userId: string, roomId: string, memberId?: string): Promise<PersonalPlaylistView> {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const callerMember = this.#getMember(userId, roomId);
    const roomRow = this.#getRoom(roomId);

    let targetMember = callerMember;
    if (memberId && memberId !== callerMember.id) {
      const found = this.database.select().from(roomMembership)
        .where(and(eq(roomMembership.id, memberId), eq(roomMembership.roomId, roomId))).get();
      if (!found) {
        throw new BusinessError(404, "ROOM_UNAVAILABLE", "未找到指定成员");
      }
      targetMember = found;
    }

    const binding = this.database.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, targetMember.id))).get();

    if (!binding) {
      throw new BusinessError(404, "PERSONAL_PLAYLIST_NOT_FOUND", "未绑定个人歌单");
    }

    const refreshKey = `${binding.accountId}:${binding.playlistId}:${binding.generation}`;
    let task = this.#inFlightRefreshes.get(refreshKey);
    if (!task) {
      task = this.#executeRefresh(roomRow.ownerUserId, binding.accountId, binding.playlistId, binding.generation)
        .finally(() => {
          this.#inFlightRefreshes.delete(refreshKey);
        });
      this.#inFlightRefreshes.set(refreshKey, task);
    }
    await task;

    return this.read(userId, roomId, memberId);
  }

  async #executeRefresh(ownerUserId: string, accountId: string, playlistId: string, bindingGeneration: number): Promise<void> {
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, ownerUserId)).get();
    if (!auth || auth.accountId !== accountId || auth.status !== "active" || !auth.credentials) {
      this.#recordRefreshError(accountId, playlistId, "AUTH_UNAVAILABLE");
      return;
    }

    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, {
        authorizationId: auth.id,
        accountId: auth.accountId,
        generation: auth.generation
      });
    } catch {
      this.#recordRefreshError(accountId, playlistId, "AUTH_UNAVAILABLE");
      return;
    }

    const readStartedAt = this.#beginRead();
    let result: Awaited<ReturnType<NeteaseAdapter["call"]>>;
    try {
      result = await this.scheduler.executeMemoryTask(accountId, async () => {
        return this.adapter.call({ operation: "playlistDetail", cookie, playlistId });
      });
    } catch (err) {
      if (err instanceof BusinessError && err.code === "ACCOUNT_PAUSED") {
        this.#recordRefreshError(accountId, playlistId, "ACCOUNT_PAUSED", readStartedAt);
        return;
      }
      this.#recordRefreshError(accountId, playlistId, "MODULE_ERROR", readStartedAt);
      return;
    }

    if (!result.ok) {
      if (result.error.code === "RATE_LIMITED") {
        this.scheduler.pause(accountId);
      }
      this.#recordRefreshError(accountId, playlistId, result.error.code, readStartedAt);
      return;
    }

    const data = result.data as {
      playlist: { id: string; name: string; creatorId: string; subscribed: boolean; status: number };
      songIds: string[];
      songs: Array<{ id: string; name: string; artists: string[]; album: string }>;
    };

    if (data.playlist.id !== playlistId || data.playlist.status !== 0) {
      this.#recordRefreshError(accountId, playlistId, "TARGET_PERMISSION", readStartedAt);
      return;
    }

    if (data.songIds.length !== data.songs.length) {
      this.#recordRefreshError(accountId, playlistId, "PARSE_ERROR", readStartedAt);
      return;
    }

    for (let i = 0; i < data.songIds.length; i++) {
      const song = data.songs[i];
      if (!song || song.id !== data.songIds[i] || !song.name || song.name.length === 0 || typeof song.album !== "string") {
        this.#recordRefreshError(accountId, playlistId, "PARSE_ERROR", readStartedAt);
        return;
      }
    }

    this.#commitSnapshot(accountId, playlistId, bindingGeneration, data, readStartedAt);
  }

  #commitSnapshot(
    accountId: string,
    playlistId: string,
    generation: number,
    data: {
      playlist: { id: string; name: string; creatorId: string; subscribed: boolean; status: number };
      songIds: string[];
      songs: Array<{ id: string; name: string; artists: string[]; album: string }>;
    },
    readStartedAt: number
  ): void {
    const affected = this.database.transaction(tx => {
      const currentBindings = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.accountId, accountId), eq(personalPlaylistBinding.playlistId, playlistId))).all();
      if (!currentBindings.length) return [];

      const hasMatchingGen = currentBindings.some(b => b.generation === generation);
      if (!hasMatchingGen) return [];

      // 验证自建与收藏权限：若为收藏歌单，确认仍在收藏列表中；若为自建歌单，确认创建者仍为本人
      for (const b of currentBindings) {
        if (b.type === "ownerSubscribed" && !data.playlist.subscribed) {
          return null; // 标记权限失效
        }
        if (b.type === "ownerCreated" && data.playlist.creatorId !== accountId) {
          return null;
        }
      }

      const currentSnapshot = tx.select().from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).get();

      if (currentSnapshot && currentSnapshot.lastReadStartedAt > readStartedAt) {
        return [];
      }

      const nextVersion = (currentSnapshot?.snapshotVersion ?? 0) + 1;
      const now = this.now();

      tx.insert(playlistSnapshot).values({
        accountId,
        playlistId,
        snapshotVersion: nextVersion,
        lastReadStartedAt: readStartedAt,
        syncedAt: now,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [playlistSnapshot.accountId, playlistSnapshot.playlistId],
        set: {
          snapshotVersion: nextVersion,
          lastReadStartedAt: readStartedAt,
          syncedAt: now,
          lastErrorCode: null,
          updatedAt: now
        }
      }).run();

      for (const binding of currentBindings) {
        tx.update(personalPlaylistBinding).set({ name: data.playlist.name })
          .where(eq(personalPlaylistBinding.id, binding.id)).run();
      }

      tx.delete(playlistTrack).where(and(eq(playlistTrack.accountId, accountId), eq(playlistTrack.playlistId, playlistId))).run();

      const insertTrack = this.database.$client.prepare(
        "INSERT INTO playlist_track (account_id, playlist_id, position, song_id, name, artists, album) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (let i = 0; i < data.songs.length; i++) {
        const song = data.songs[i];
        insertTrack.run(accountId, playlistId, i, song.id, song.name, JSON.stringify(song.artists), song.album);
      }

      const results: Array<{ roomId: string; version: number }> = [];
      const distinctRooms = new Set(currentBindings.map(b => b.roomId));
      for (const rid of distinctRooms) {
        this.#bumpRoom(tx, rid);
        const updated = tx.select({ version: room.version }).from(room).where(eq(room.id, rid)).get();
        if (updated) results.push({ roomId: rid, version: updated.version });
      }
      return results;
    });

    if (affected === null) {
      // 收藏或自建权限已失效
      this.#recordRefreshError(accountId, playlistId, "TARGET_PERMISSION", readStartedAt);
      return;
    }

    for (const item of affected) {
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "room", resourceId: item.roomId, version: item.version });
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "snapshot", resourceId: item.roomId, version: item.version });
    }
  }

  #recordRefreshError(accountId: string, playlistId: string, errorCode: AdapterErrorCode | "ACCOUNT_PAUSED", readStartedAt?: number): void {
    const affected = this.database.transaction(tx => {
      const now = this.now();
      const existing = tx.select({ lastReadStartedAt: playlistSnapshot.lastReadStartedAt }).from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).get();
      if (readStartedAt !== undefined && existing && existing.lastReadStartedAt > readStartedAt) return [];

      tx.insert(playlistSnapshot).values({
        accountId,
        playlistId,
        snapshotVersion: 0,
        syncedAt: null,
        lastErrorCode: errorCode,
        createdAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [playlistSnapshot.accountId, playlistSnapshot.playlistId],
        set: {
          lastErrorCode: errorCode,
          updatedAt: now
        }
      }).run();

      const bindings = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.accountId, accountId), eq(personalPlaylistBinding.playlistId, playlistId))).all();
      const results: Array<{ roomId: string; version: number }> = [];
      const distinctRooms = new Set(bindings.map(b => b.roomId));
      for (const rid of distinctRooms) {
        this.#bumpRoom(tx, rid);
        const updated = tx.select({ version: room.version }).from(room).where(eq(room.id, rid)).get();
        if (updated) results.push({ roomId: rid, version: updated.version });
      }
      return results;
    });

    for (const item of affected) {
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "room", resourceId: item.roomId, version: item.version });
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "snapshot", resourceId: item.roomId, version: item.version });
    }
  }

  async #fetchAccountPlaylists(cookie: string, accountId: string): Promise<Array<{ id: string; name: string; creatorId: string; subscribed: boolean; status: number }> | null> {
    const list: Array<{ id: string; name: string; creatorId: string; subscribed: boolean; status: number }> = [];
    let offset = 0;
    const limit = 1000;
    let pages = 0;
    while (true) {
      if (++pages > 50) return null;
      let res: AdapterResult<"userPlaylists">;
      try {
        res = await this.scheduler.executeMemoryTask(accountId, async () => {
          return this.adapter.call({ operation: "userPlaylists", cookie, accountId, offset, limit });
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      for (const p of res.data.playlists) {
        list.push({
          id: p.id,
          name: p.name,
          creatorId: p.creatorId,
          subscribed: p.subscribed,
          status: p.status
        });
      }
      if (!res.data.more) break;
      if (res.data.playlists.length === 0) return null;
      offset += res.data.playlists.length;
    }
    return list;
  }

  #cleanupOrphanSnapshot(tx: DatabaseTransaction, accountId: string, playlistId: string): void {
    const personal = tx.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.accountId, accountId), eq(personalPlaylistBinding.playlistId, playlistId))).all();
    const publicList = tx.select().from(publicPlaylistBinding)
      .where(and(eq(publicPlaylistBinding.accountId, accountId), eq(publicPlaylistBinding.playlistId, playlistId))).all();
    if (!personal.length && !publicList.length) {
      tx.delete(playlistTrack).where(and(eq(playlistTrack.accountId, accountId), eq(playlistTrack.playlistId, playlistId))).run();
      tx.delete(playlistSnapshot).where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).run();
    }
  }

  #getMember(userId: string, roomId: string) {
    const member = this.database.select().from(roomMembership)
      .where(and(eq(roomMembership.userId, userId), eq(roomMembership.roomId, roomId))).get();
    if (!member) {
      throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    }
    return member;
  }

  #getRoom(roomId: string) {
    const r = this.database.select().from(room).where(eq(room.id, roomId)).get();
    if (!r) {
      throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    }
    return r;
  }

  #bumpRoom(tx: DatabaseTransaction, roomId: string): void {
    tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
  }
}
