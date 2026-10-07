import type { FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { roomMembership } from "../db/schema.js";

export type SseInvalidationType = "search" | "publicPlaylist" | "songRequest";

export interface SseInvalidationEvent {
  type: SseInvalidationType;
  roomId: string;
  resourceId?: string;
}

/**
 * 账号级 SSE 失效流分发服务。
 * 仅发送最小失效事件，不携带搜索词、候选或歌单正文。
 */
export class EventStreamService {
  readonly #connections = new Map<string, Set<FastifyReply>>();

  async subscribe(userId: string, reply: FastifyReply): Promise<void> {
    let set = this.#connections.get(userId);
    if (!set) {
      set = new Set();
      this.#connections.set(userId, set);
    }
    set.add(reply);

    reply.raw.on("close", () => {
      set.delete(reply);
      if (set.size === 0) {
        this.#connections.delete(userId);
      }
    });

    reply.sse.keepAlive();
    await reply.sse.send({ event: "connected", data: "ok" });
  }

  notifyUser(userId: string, event: SseInvalidationEvent): void {
    const set = this.#connections.get(userId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(event);
    for (const reply of set) {
      try {
        if (reply.sse.isConnected) {
          void reply.sse.send({ event: "invalidation", data: payload });
        }
      } catch {
        // 忽略单客户端发送异常
      }
    }
  }

  notifyRoom(database: AppDatabase, roomId: string, event: SseInvalidationEvent): void {
    const members = database.select({ userId: roomMembership.userId }).from(roomMembership).where(eq(roomMembership.roomId, roomId)).all();
    for (const m of members) {
      this.notifyUser(m.userId, event);
    }
  }

  close(): void {
    for (const set of this.#connections.values()) {
      for (const reply of set) {
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      }
    }
    this.#connections.clear();
  }
}
