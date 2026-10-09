import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { neteaseAuthorization, playlistTrack, publicPlaylistBinding, room, roomMembership } from "../db/schema.js";
import type { NeteaseAdapter } from "../netease/protocol.js";
import type { CredentialVault } from "../netease/credentials.js";
import { BusinessError } from "../shared/errors.js";
import type { PlaybackView } from "../shared/public-playlist-contracts.js";
import type { UpstreamScheduler } from "./upstream-scheduling.js";

type Authorization = typeof neteaseAuthorization.$inferSelect;
type Cached = PlaybackView & { scope: string };
const scopeOf = (auth: Authorization) => `${auth.accountId}:${auth.id}:${auth.generation}`;

/** Account history is shared, but each caller maps only its own room's current snapshot. */
export class PublicPlayback {
  readonly #cache = new Map<string, Cached>();
  readonly #inflight = new Map<string, Promise<Cached>>();
  constructor(
    readonly database: AppDatabase,
    readonly adapter: NeteaseAdapter,
    readonly vault: CredentialVault,
    readonly scheduler: UpstreamScheduler,
    readonly now: () => number
  ) {}

  invalidate(userId: string): void {
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, userId)).get();
    if (auth) this.#cache.delete(auth.accountId);
  }

  #current(auth: Authorization): boolean {
    const current = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.id, auth.id)).get();
    return !!current && current.status === "active" && !!current.credentials && scopeOf(current) === scopeOf(auth);
  }

  async read(userId: string, roomId: string, force = false): Promise<PlaybackView> {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const currentRoom = this.database.select().from(room).where(eq(room.id, roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();
    if (!currentRoom || !member) throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (!binding) return { songId: null, checkedAt: null, errorCode: null };
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, currentRoom.ownerUserId)).get();
    if (!auth || auth.accountId !== binding.accountId || !this.#current(auth)) {
      return { songId: null, checkedAt: null, errorCode: "AUTH_UNAVAILABLE" };
    }
    if (this.scheduler.paused(auth.accountId)) {
      this.#cache.delete(auth.accountId);
      return { songId: null, checkedAt: null, errorCode: "ACCOUNT_PAUSED" };
    }
    const scope = scopeOf(auth);
    const cached = this.#cache.get(auth.accountId);
    let result: Cached;
    let task = this.#inflight.get(scope);
    if (!task && !force && cached?.scope === scope && cached.checkedAt !== null && this.now() - cached.checkedAt < 30_000) {
      result = cached;
    } else {
      if (!task) {
        task = this.#fetch(auth).finally(() => this.#inflight.delete(scope));
        this.#inflight.set(scope, task);
      }
      result = await task;
    }
    const latestMember = this.database.select().from(roomMembership).where(eq(roomMembership.id, member.id)).get();
    const latestBinding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (!latestMember) throw new BusinessError(404, "ROOM_UNAVAILABLE", "你已不是成员");
    if (!this.#current(auth) || !latestBinding || latestBinding.creationOperationId !== binding.creationOperationId || latestBinding.generation !== binding.generation || latestBinding.accountId !== auth.accountId) {
      return { songId: null, checkedAt: null, errorCode: "AUTH_UNAVAILABLE" };
    }
    if (this.scheduler.paused(auth.accountId)) return { songId: null, checkedAt: null, errorCode: "ACCOUNT_PAUSED" };
    const matches = result.songId && this.database.select().from(playlistTrack).where(and(
      eq(playlistTrack.accountId, binding.accountId), eq(playlistTrack.playlistId, binding.playlistId), eq(playlistTrack.songId, result.songId)
    )).get();
    return { songId: matches ? result.songId : null, checkedAt: result.checkedAt, errorCode: result.errorCode };
  }

  async #fetch(auth: Authorization): Promise<Cached> {
    let view: PlaybackView;
    try {
      const result = await this.scheduler.executeMemoryTask(auth.accountId, async () => {
        if (!this.#current(auth)) throw new BusinessError(409, "AUTH_UNAVAILABLE", "网易云授权已变化");
        const cookie = this.vault.decrypt(auth.credentials!, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
        return this.adapter.call({ operation: "recentSong", cookie });
      });
      if (!result.ok && result.error.code === "RATE_LIMITED" && this.#current(auth)) this.scheduler.pause(auth.accountId);
      view = { songId: result.ok ? result.data.songId : null, checkedAt: this.now(), errorCode: result.ok ? null : result.error.code };
    } catch (error) {
      const code = error instanceof BusinessError ? error.code : "MODULE_ERROR";
      view = { songId: null, checkedAt: this.now(), errorCode: code === "ACCOUNT_PAUSED" || code === "UPSTREAM_QUEUE_FULL" || code === "AUTH_UNAVAILABLE" ? code : "MODULE_ERROR" };
    }
    const value = { ...view, scope: scopeOf(auth) };
    if (this.#current(auth)) this.#cache.set(auth.accountId, value);
    return value;
  }
}
