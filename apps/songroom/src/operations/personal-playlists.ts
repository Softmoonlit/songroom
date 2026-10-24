import { and, desc, eq, sql } from "drizzle-orm";
import { BusinessError } from "../shared/errors.js";
import type { AppDatabase } from "../db/database.js";
import {
  neteaseAuthorization,
  operation,
  personalPlaylistBinding,
  personalPlaylistCreation,
  playlistSnapshot,
  playlistTrack,
  publicSongRequest,
  room,
  roomMembership
} from "../db/schema.js";
import type { CredentialVault } from "../netease/credentials.js";
import type {
  AdapterErrorCode,
  AdapterResult,
  NeteaseAdapter
} from "../netease/protocol.js";
import type { UpstreamScheduler } from "./upstream-scheduling.js";
import type { EventStreamService } from "../events/event-stream.js";
import type { PublicPlaylists } from "./public-playlists.js";
import type {
  PersonalPlaylistView
} from "../shared/personal-playlist-contracts.js";

export class PersonalPlaylists {
  #inFlightRefreshes = new Map<string, Promise<void>>();
  #readCounter = 0;

  constructor(
    private readonly database: AppDatabase,
    private readonly vault: CredentialVault,
    private readonly adapter: NeteaseAdapter,
    private readonly scheduler: UpstreamScheduler,
    private readonly eventStream: EventStreamService,
    private readonly publicPlaylists: PublicPlaylists,
    private readonly now: () => number = () => Date.now()
  ) {}

  #beginRead(): number {
    const persisted = this.database.select({ value: sql<number>`coalesce(max(${playlistSnapshot.lastReadStartedAt}), 0)` }).from(playlistSnapshot).get()!.value;
    this.#readCounter = Math.max(this.now(), this.#readCounter + 1, persisted + 1);
    return this.#readCounter;
  }

  #hasTargetConflict(accountId: string, playlistId: string): boolean {
    const snap = this.database.select({ code: playlistSnapshot.lastErrorCode })
      .from(playlistSnapshot)
      .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId)))
      .get();
    if (snap?.code === "TARGET_PERMISSION") return true;

    const sourceConflict = this.database.select({ id: operation.id }).from(operation)
      .innerJoin(publicSongRequest, eq(publicSongRequest.operationId, operation.id))
      .where(and(eq(operation.accountId, accountId), eq(publicSongRequest.sourcePlaylistId, playlistId),
        sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
    return Boolean(sourceConflict);
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

    const binding = this.database.select().from(personalPlaylistBinding)
      .where(and(eq(personalPlaylistBinding.roomId, roomId), eq(personalPlaylistBinding.memberId, targetMember.id))).get();

    let opView: PersonalPlaylistView["operation"] = null;
    const currentOperation = this.database.select().from(operation)
      .where(and(eq(operation.roomId, roomId), eq(operation.userId, targetMember.userId), eq(operation.kind, "createPersonalPlaylist")))
      .orderBy(desc(operation.createdAt), desc(operation.id))
      .get();
    if (currentOperation) {
      const creationDetail = this.database.select().from(personalPlaylistCreation)
        .where(eq(personalPlaylistCreation.operationId, currentOperation.id)).get();
      if (creationDetail?.memberId === targetMember.id) opView = {
        id: currentOperation.id,
        status: currentOperation.status as any,
        errorCode: currentOperation.errorCode as any,
        step: creationDetail?.step as any,
        playlistId: creationDetail?.playlistId,
        recovered: creationDetail ? Boolean(creationDetail.recovered) : false,
        version: currentOperation.version
      };
    }

    if (!binding) {
      const allowedActions: PersonalPlaylistView["allowedActions"] = [];
      let disabledReason: PersonalPlaylistView["disabledReason"] = null;

      if (isSelf) {
        const ownerAuth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
        if (opView && !["succeeded", "failed", "stopped"].includes(opView.status)) {
          disabledReason = "OPERATION_PENDING";
        } else if (!ownerAuth || ownerAuth.status !== "active" || !ownerAuth.credentials) {
          disabledReason = "NETEASE_AUTH_REQUIRED";
        } else if (this.scheduler.paused(ownerAuth.accountId)) {
          disabledReason = "ACCOUNT_PAUSED";
        }
      }

      return {
        playlist: null,
        operation: opView,
        snapshot: null,
        lastRefreshError: null,
        allowedActions,
        disabledReason,
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

    const allowedActions: PersonalPlaylistView["allowedActions"] = isSelf ? ["refreshPersonalPlaylist"] : [];
    let disabledReason: PersonalPlaylistView["disabledReason"] = null;
    if (isSelf) {
      const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, roomRow.ownerUserId)).get();
      const pending = this.database.select({ id: operation.id }).from(operation).where(and(eq(operation.roomId, roomId), eq(operation.userId, userId), sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`)).get();
      if (!auth || auth.status !== "active" || !auth.credentials || auth.accountId !== binding.accountId) disabledReason = "NETEASE_AUTH_REQUIRED";
      else if (this.scheduler.paused(auth.accountId)) disabledReason = "ACCOUNT_PAUSED";
      else if (pending) disabledReason = "OPERATION_PENDING";
      else if (this.#hasTargetConflict(binding.accountId, binding.playlistId)) disabledReason = "TARGET_BLOCKED";
    }

    return {
      playlist: {
        id: binding.playlistId,
        name: binding.name
      },
      operation: opView,
      snapshot,
      lastRefreshError: (snap?.lastErrorCode as any) ?? null,
      allowedActions,
      disabledReason,
      version: roomRow.version
    };
  }

  async refresh(userId: string, roomId: string, memberId?: string): Promise<PersonalPlaylistView> {
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
      if (!currentBindings.length) return { results: [] };

      const hasMatchingGen = currentBindings.some(b => b.generation === generation);
      if (!hasMatchingGen) return { results: [] };

      const currentSnapshot = tx.select().from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, accountId), eq(playlistSnapshot.playlistId, playlistId))).get();

      if (currentSnapshot && currentSnapshot.lastReadStartedAt > readStartedAt) {
        return { results: [] };
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

      return { results };
    });

    for (const item of affected.results) {
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "room", resourceId: item.roomId, version: item.version });
      this.eventStream.notifyRoom(this.database, item.roomId, { type: "snapshot", resourceId: item.roomId, version: item.version });
    }
  }

  #recordRefreshError(accountId: string, playlistId: string, errorCode: AdapterErrorCode | "ACCOUNT_PAUSED", readStartedAt?: number): void {
    const affected = this.database.transaction(tx => {
      const bindings = tx.select().from(personalPlaylistBinding)
        .where(and(eq(personalPlaylistBinding.accountId, accountId), eq(personalPlaylistBinding.playlistId, playlistId))).all();
      if (!bindings.length) return [];
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

  #bumpRoom(tx: any, roomId: string): void {
    tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
  }

  async fetchUserPlaylists(
    cookie: string,
    accountId: string,
    callStrategy: (fn: () => Promise<AdapterResult<"userPlaylists">>) => Promise<AdapterResult<"userPlaylists">> = fn => fn()
  ): Promise<Array<{ id: string; name: string; creatorId: string; subscribed: boolean; status: number }> | null> {
    const list: Array<{ id: string; name: string; creatorId: string; subscribed: boolean; status: number }> = [];
    let offset = 0;
    const limit = 1000;
    let pages = 0;
    while (true) {
      if (++pages > 50) return null;
      let res: AdapterResult<"userPlaylists">;
      try {
        res = await callStrategy(() => this.adapter.call({ operation: "userPlaylists", cookie, accountId, offset, limit }));
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
}
