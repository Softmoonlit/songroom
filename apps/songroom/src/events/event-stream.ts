import type { FastifyReply } from "fastify";
import "@fastify/sse";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { roomMembership } from "../db/schema.js";

export type SseInvalidationType = "room" | "snapshot" | "operation" | "permission" | "search" | "cleanup";

export interface SseInvalidationEvent {
  type: SseInvalidationType;
  resourceId: string;
  version: number;
}

interface ConnectionEntry {
  sessionId: string;
  reply: FastifyReply;
  timer?: NodeJS.Timeout;
}

/**
 * 账号级 SSE 失效流分发服务。
 * 仅发送最小失效事件，包含资源类型、本地资源标识和单调版本，
 * 不携带歌名、昵称、候选、邀请或结果正文。
 */
export class EventStreamService {
  readonly #connections = new Map<string, Set<ConnectionEntry>>();

  async subscribe(userId: string, sessionId: string, reply: FastifyReply, expiresAtMs?: number): Promise<void> {
    let set = this.#connections.get(userId);
    if (!set) {
      set = new Set();
      this.#connections.set(userId, set);
    }

    const entry: ConnectionEntry = { sessionId, reply };

    if (expiresAtMs !== undefined && Number.isFinite(expiresAtMs)) {
      const remainingMs = Math.max(0, expiresAtMs - Date.now());
      entry.timer = setTimeout(() => {
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      }, remainingMs);
    }

    set.add(entry);

    reply.raw.on("close", () => {
      if (entry.timer) clearTimeout(entry.timer);
      set.delete(entry);
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
    const data = {
      type: event.type,
      resourceId: event.resourceId,
      version: event.version
    };
    for (const { reply } of set) {
      try {
        if (reply.sse.isConnected) {
          void reply.sse.send({ event: "invalidation", data });
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

  closeSession(sessionId: string): void {
    for (const [userId, set] of this.#connections.entries()) {
      for (const entry of Array.from(set)) {
        if (entry.sessionId === sessionId) {
          if (entry.timer) clearTimeout(entry.timer);
          try {
            entry.reply.raw.end();
          } catch {
            // ignore
          }
          set.delete(entry);
        }
      }
      if (set.size === 0) {
        this.#connections.delete(userId);
      }
    }
  }

  close(): void {
    for (const set of this.#connections.values()) {
      for (const entry of set) {
        if (entry.timer) clearTimeout(entry.timer);
        try {
          entry.reply.raw.end();
        } catch {
          // ignore
        }
      }
    }
    this.#connections.clear();
  }
}
