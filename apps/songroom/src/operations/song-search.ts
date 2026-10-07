import { v7 } from "uuid";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { neteaseAuthorization, publicPlaylistBinding, room, roomMembership } from "../db/schema.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterErrorCode, NeteaseAdapter } from "../netease/protocol.js";
import { EventStreamService } from "../events/event-stream.js";
import { BusinessError } from "../shared/errors.js";
import type { SearchView, SongCandidate } from "../shared/song-search-contracts.js";

interface SearchSession {
  searchId: string;
  userId: string;
  roomId: string;
  query: string;
  status: "searching" | "completed" | "failed";
  songs: SongCandidate[];
  errorCode: AdapterErrorCode | "ACCOUNT_PAUSED" | "UPSTREAM_QUEUE_FULL" | null;
  cancelled: boolean;
  createdAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

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
    return current;
  }

  #cleanupExpired(): void {
    const now = this.now();
    for (const [id, session] of this.#sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.#sessions.delete(id);
      }
    }
  }

  async search(userId: string, roomId: string, rawQuery: string): Promise<{ searchId: string }> {
    if (this.scheduler.isStopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    this.#cleanupExpired();
    const query = rawQuery.trim();
    if (!query) throw new BusinessError(400, "INVALID_QUERY", "搜索关键词不能为空");

    const currentRoom = this.#member(userId, roomId);
    const binding = this.database.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (!binding) throw new BusinessError(409, "PUBLIC_PLAYLIST_NOT_FOUND", "房间尚未绑定公共歌单，无法搜索");

    const auth = this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, currentRoom.ownerUserId)).get();
    if (!auth || auth.status !== "active" || !auth.credentials) throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请房主先完成网易云授权");

    const code = this.scheduler.admissionCode(auth.accountId);
    if (code) {
      throw new BusinessError(409, code, code === "ACCOUNT_PAUSED" ? "网易云账号已暂停，请联系管理员" : "网易云账号操作队列已满");
    }

    let cookie: string;
    try {
      cookie = this.vault.decrypt(auth.credentials, { authorizationId: auth.id, accountId: auth.accountId, generation: auth.generation });
    } catch {
      throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "网易云凭据已失效，请房主重新授权");
    }

    // 取消同一成员在同一房间的上一轮未完成搜索
    const memberKey = `${userId}:${roomId}`;
    const previousSearchId = this.#activeByMember.get(memberKey);
    if (previousSearchId) {
      const prev = this.#sessions.get(previousSearchId);
      if (prev && prev.status === "searching") {
        prev.cancelled = true;
      }
    }

    const searchId = v7();
    const session: SearchSession = {
      searchId,
      userId,
      roomId,
      query,
      status: "searching",
      songs: [],
      errorCode: null,
      cancelled: false,
      createdAt: this.now()
    };

    this.#sessions.set(searchId, session);
    this.#activeByMember.set(memberKey, searchId);

    // 提交到调度器排队执行，一轮搜索占一个上游操作
    void this.scheduler.executeMemoryTask(auth.accountId, async () => {
      if (session.cancelled) return;
      const result = await this.adapter.call({ operation: "search", cookie, query });
      if (session.cancelled) return;

      if (!result.ok) {
        if (result.error.code === "RATE_LIMITED") {
          this.scheduler.pause(auth.accountId);
        }
        session.status = "failed";
        session.errorCode = result.error.code;
      } else {
        session.status = "completed";
        session.songs = result.data.songs;
      }

      this.eventStream.notifyUser(userId, {
        type: "search",
        resourceId: searchId,
        version: 1
      });
    }).catch(err => {
      if (session.cancelled) return;
      session.status = "failed";
      if (err instanceof BusinessError && (err.code === "ACCOUNT_PAUSED" || err.code === "UPSTREAM_QUEUE_FULL")) {
        session.errorCode = err.code as any;
      } else {
        session.errorCode = "MODULE_ERROR";
      }
      this.eventStream.notifyUser(userId, {
        type: "search",
        resourceId: searchId,
        version: 1
      });
    });

    return { searchId };
  }

  getSearch(userId: string, roomId: string, searchId: string): SearchView {
    this.#member(userId, roomId);
    const session = this.#sessions.get(searchId);
    if (!session || session.roomId !== roomId || session.userId !== userId) {
      throw new BusinessError(404, "SEARCH_NOT_FOUND", "搜索已过期或不存在，请重新搜索");
    }
    return {
      searchId: session.searchId,
      status: session.status,
      songs: session.songs,
      errorCode: session.errorCode
    };
  }

  cancelSearch(userId: string, roomId: string, searchId: string): void {
    this.#member(userId, roomId);
    const session = this.#sessions.get(searchId);
    if (session && session.roomId === roomId && session.userId === userId) {
      session.cancelled = true;
    }
  }
}
