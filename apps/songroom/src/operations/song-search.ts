import { v7 } from "uuid";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { neteaseAuthorization, publicPlaylistBinding, room, roomMembership } from "../db/schema.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { CredentialVault } from "../netease/credentials.js";
import type { NeteaseAdapter } from "../netease/protocol.js";
import { EventStreamService } from "../events/event-stream.js";
import { BusinessError } from "../shared/errors.js";
import { searchErrorCode, type SearchView, type SongCandidate } from "../shared/song-search-contracts.js";

interface SearchScope {
  membershipId: string;
  authorizationId: string;
  accountId: string;
  authorizationGeneration: number;
  playlistId: string;
  bindingGeneration: number;
  creationOperationId: string;
}

interface SearchSession {
  searchId: string;
  userId: string;
  roomId: string;
  query: string;
  scope: SearchScope;
  status: SearchView["status"];
  songs: SongCandidate[];
  errorCode: SearchView["errorCode"];
  hasMore: boolean;
  nextOffset: number;
  version: number;
  cancelled: boolean;
  createdAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 20;

export class SongSearchService {
  readonly #sessions = new Map<string, SearchSession>();
  readonly #activeByMember = new Map<string, string>();

  constructor(
    readonly database: AppDatabase,
    readonly adapter: NeteaseAdapter,
    readonly vault: CredentialVault,
    readonly scheduler: UpstreamScheduler,
    readonly eventStream: EventStreamService,
    readonly now: () => number = () => Date.now()
  ) {}

  #member(userId: string, roomId: string) {
    const current = this.database.select().from(room).where(eq(room.id, roomId)).get();
    const member = this.database.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();
    if (!current || !member) throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    return { current, member };
  }

  #context(userId: string, roomId: string) {
    const { current, member } = this.#member(userId, roomId);
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (!binding) throw new BusinessError(409, "PUBLIC_PLAYLIST_NOT_FOUND", "房间尚未绑定公共歌单，无法搜索");
    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, current.ownerUserId)).get();
    if (!auth || auth.status !== "active" || !auth.credentials) throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请房主先完成网易云授权");
    if (binding.accountId !== auth.accountId) throw new BusinessError(409, "AUTHORIZATION_CHANGED", "网易云授权已变化，请重新搜索");
    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "网易云凭据已失效，请房主重新授权");
    }
    const scope: SearchScope = {
      membershipId: member.id,
      authorizationId: auth.id,
      accountId: auth.accountId,
      authorizationGeneration: auth.generation,
      playlistId: binding.playlistId,
      bindingGeneration: binding.generation,
      creationOperationId: binding.creationOperationId
    };
    return { scope, cookie };
  }

  #checkScope(session: SearchSession, scope: SearchScope): void {
    if (session.scope.membershipId !== scope.membershipId) {
      throw new BusinessError(404, "ROOM_UNAVAILABLE", "成员资格已变化，请重新搜索");
    }
    if (session.scope.accountId !== scope.accountId || session.scope.authorizationId !== scope.authorizationId || session.scope.authorizationGeneration !== scope.authorizationGeneration) {
      throw new BusinessError(409, "AUTHORIZATION_CHANGED", "网易云授权已变化，请重新搜索");
    }
    if (session.scope.playlistId !== scope.playlistId || session.scope.bindingGeneration !== scope.bindingGeneration || session.scope.creationOperationId !== scope.creationOperationId) {
      throw new BusinessError(409, "PUBLIC_PLAYLIST_CHANGED", "公共歌单已变化，请重新搜索");
    }
  }

  #cleanupExpired(): void {
    for (const [id, session] of this.#sessions) {
      if (this.now() - session.createdAt > SESSION_TTL_MS) {
        session.cancelled = true;
        this.#sessions.delete(id);
        const key = `${session.userId}:${session.roomId}`;
        if (this.#activeByMember.get(key) === id) this.#activeByMember.delete(key);
      }
    }
  }

  #session(userId: string, roomId: string, searchId: string): SearchSession {
    this.#member(userId, roomId);
    this.#cleanupExpired();
    const session = this.#sessions.get(searchId);
    if (!session || session.cancelled || session.roomId !== roomId || session.userId !== userId) {
      throw new BusinessError(404, "SEARCH_NOT_FOUND", "搜索已过期或不存在，请重新搜索");
    }
    return session;
  }

  #admit(accountId: string): void {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const code = this.scheduler.admissionCode(accountId);
    if (code) throw new BusinessError(409, code, code === "ACCOUNT_PAUSED" ? "网易云账号已暂停，请联系管理员" : "网易云账号操作队列已满");
  }

  async search(userId: string, roomId: string, rawQuery: string): Promise<{ searchId: string }> {
    this.#cleanupExpired();
    const query = rawQuery.trim();
    if (!query) throw new BusinessError(400, "INVALID_QUERY", "搜索关键词不能为空");
    const { scope } = this.#context(userId, roomId);
    this.#admit(scope.accountId);

    const memberKey = `${userId}:${roomId}`;
    const previousSearchId = this.#activeByMember.get(memberKey);
    const previous = previousSearchId ? this.#sessions.get(previousSearchId) : undefined;
    if (previous) previous.cancelled = true;

    const searchId = v7();
    const session: SearchSession = {
      searchId, userId, roomId, query, scope,
      status: "searching", songs: [], errorCode: null, hasMore: true,
      nextOffset: 0, version: 0, cancelled: false, createdAt: this.now()
    };
    this.#sessions.set(searchId, session);
    this.#activeByMember.set(memberKey, searchId);
    this.#loadPage(session);
    return { searchId };
  }

  loadMore(userId: string, roomId: string, searchId: string): { searchId: string } {
    const session = this.#session(userId, roomId, searchId);
    const { scope } = this.#context(userId, roomId);
    this.#checkScope(session, scope);
    this.#admit(scope.accountId);
    // 重复点击只返回正在执行的同一页，不再排入另一项任务。
    if (session.status === "searching") return { searchId };
    if (!session.hasMore) throw new BusinessError(409, "SEARCH_EXHAUSTED", "没有更多搜索结果");
    this.#loadPage(session);
    return { searchId };
  }

  #notify(session: SearchSession): void {
    this.eventStream.notifyUser(session.userId, { type: "search", resourceId: session.searchId, version: ++session.version });
  }

  #loadPage(session: SearchSession): void {
    session.status = "searching";
    session.errorCode = null;
    const run = async () => {
      if (session.cancelled) return;
      const context = this.#context(session.userId, session.roomId);
      this.#checkScope(session, context.scope);
      const result = await this.adapter.call({ operation: "search", cookie: context.cookie, query: session.query, limit: PAGE_SIZE, offset: session.nextOffset });
      if (!result.ok && result.error.code === "RATE_LIMITED") this.scheduler.pause(session.scope.accountId);
      if (session.cancelled) return;
      this.#checkScope(session, this.#context(session.userId, session.roomId).scope);
      if (!result.ok) {
        session.status = "failed";
        session.errorCode = result.error.code;
      } else {
        const ids = new Set(session.songs.map(song => song.id));
        const additions = result.data.songs.filter(song => {
          if (ids.has(song.id)) return false;
          ids.add(song.id);
          return true;
        });
        session.songs = [...session.songs, ...additions];
        session.nextOffset += PAGE_SIZE;
        // 总数仅用于是否还有更多；短页或整页重复立即终止，避免变化的总数造成空转。
        session.hasMore = result.data.songs.length === PAGE_SIZE && additions.length > 0 && session.nextOffset < result.data.songCount;
        session.status = "completed";
      }
      this.#notify(session);
    };
    const failed = (error: unknown) => {
      if (session.cancelled) return;
      session.status = "failed";
      const parsed = searchErrorCode.safeParse(error instanceof BusinessError ? error.code : "MODULE_ERROR");
      session.errorCode = parsed.success ? parsed.data : "MODULE_ERROR";
      this.#notify(session);
    };
    try {
      void this.scheduler.executeMemoryTask(session.scope.accountId, run).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  getSearch(userId: string, roomId: string, searchId: string): SearchView {
    const session = this.#session(userId, roomId, searchId);
    this.#checkScope(session, this.#context(userId, roomId).scope);
    return {
      searchId: session.searchId, status: session.status, songs: session.songs,
      errorCode: session.errorCode, hasMore: session.hasMore
    };
  }

  cancelSearch(userId: string, roomId: string, searchId: string): void {
    this.#member(userId, roomId);
    const session = this.#sessions.get(searchId);
    if (session && session.roomId === roomId && session.userId === userId) session.cancelled = true;
  }
}
