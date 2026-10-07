import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SseInvalidationEvent } from "../events/event-stream.js";

/**
 * 客户端失效版本跟踪器。
 * 负责重复、乱序和晚到事件按单调版本去重；
 * 跟踪服务端权威 JSON 读取到的最新版本，保证事件与查询竞态时以服务端当前版本为准。
 */
export class InvalidationTracker {
  readonly #knownVersions = new Map<string, number>();

  recordFromServer(type: string, resourceId: string, version: number): void {
    const key = `${type}:${resourceId}`;
    const current = this.#knownVersions.get(key) ?? 0;
    this.#knownVersions.set(key, Math.max(current, version));
  }

  reset(type: string, resourceId: string): void {
    const key = `${type}:${resourceId}`;
    this.#knownVersions.delete(key);
  }

  shouldInvalidate(type: string, resourceId: string, version: number): boolean {
    const key = `${type}:${resourceId}`;
    const last = this.#knownVersions.get(key) ?? 0;
    if (version <= last) return false;
    this.#knownVersions.set(key, version);
    return true;
  }

  getVersion(type: string, resourceId: string): number {
    return this.#knownVersions.get(`${type}:${resourceId}`) ?? 0;
  }
}

export function useEventStream(enabled: boolean): void {
  const queryClient = useQueryClient();
  const trackerRef = useRef<InvalidationTracker>(new InvalidationTracker());
  const isFirstConnect = useRef(true);

  // 监听 queryClient 缓存中的最新版本，保证事件与 JSON 查询竞态时以服务端当前版本为准
  useEffect(() => {
    if (!enabled) return;

    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "success") {
        const data = event.query.state.data as Record<string, unknown> | undefined;
        if (!data || typeof data !== "object") return;
        const queryKey = event.query.queryKey;
        const firstKey = queryKey[0];
        const tracker = trackerRef.current;

        if (
          (firstKey === "room-shell" ||
            firstKey === "room-members" ||
            firstKey === "room-applications" ||
            firstKey === "room-invite") &&
          typeof data.version === "number"
        ) {
          const roomId = queryKey[2] as string | undefined;
          if (roomId) {
            tracker.recordFromServer("room", roomId, data.version);
            tracker.recordFromServer("permission", roomId, data.version);
          }
        }

        if (firstKey === "join-application" && typeof data.version === "number") {
          const roomObj = data.room as { id?: string } | undefined;
          if (roomObj?.id) {
            tracker.recordFromServer("room", roomObj.id, data.version);
            tracker.recordFromServer("permission", roomObj.id, data.version);
          }
        }

        if (firstKey === "room-public-playlist") {
          const roomId = queryKey[2] as string | undefined;
          if (roomId && typeof data.version === "number") {
            tracker.recordFromServer("room", roomId, data.version);
            tracker.recordFromServer("snapshot", roomId, data.version);
          }
          const operation = data.operation as { id?: string; version?: number } | undefined;
          if (operation && typeof operation.version === "number" && operation.id) {
            tracker.recordFromServer("operation", operation.id, operation.version);
          }
        }

        if (firstKey === "song-request-operation" && typeof data.version === "number" && typeof data.id === "string") {
          tracker.recordFromServer("operation", data.id, data.version);
        }

        if (firstKey === "song-search") {
          const searchId = queryKey[1] as string | undefined;
          if (searchId) {
            tracker.recordFromServer("search", searchId, 1);
          }
        }
      } else if (event.type === "updated" && event.action.type === "error") {
        // 查询遇错时不锁定最高版本，允许后续失效事件再次触发重新读取
        const firstKey = event.query.queryKey[0];
        if (firstKey === "song-request-operation") {
          const opId = event.query.queryKey[1] as string | undefined;
          if (opId) trackerRef.current.reset("operation", opId);
        } else if (firstKey === "song-search") {
          const searchId = event.query.queryKey[1] as string | undefined;
          if (searchId) trackerRef.current.reset("search", searchId);
        } else if (firstKey === "join-application") {
          const appId = event.query.queryKey[2] as string | undefined;
          if (appId) {
            trackerRef.current.reset("room", appId);
            trackerRef.current.reset("permission", appId);
          }
        } else {
          const roomId = event.query.queryKey[2] as string | undefined;
          if (roomId) {
            trackerRef.current.reset("room", roomId);
            trackerRef.current.reset("permission", roomId);
            trackerRef.current.reset("snapshot", roomId);
          }
        }
      }
    });

    return () => unsubscribe();
  }, [enabled, queryClient]);

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      source = new EventSource("/api/events");

      source.addEventListener("connected", () => {
        // 断线、服务重启或休眠后重连时，完整使当前活跃 read model 失效并重新读取
        if (!isFirstConnect.current) {
          void queryClient.invalidateQueries({ type: "active" });
        }
        isFirstConnect.current = false;
      });

      source.addEventListener("invalidation", (event: MessageEvent) => {
        try {
          let payload = JSON.parse(event.data as string) as SseInvalidationEvent | string;
          if (typeof payload === "string") {
            payload = JSON.parse(payload) as SseInvalidationEvent;
          }
          const { type, resourceId, version } = payload;
          if (!type || !resourceId || typeof version !== "number") return;

          // 重复、乱序和晚到事件按资源版本去重或忽略
          if (!trackerRef.current.shouldInvalidate(type, resourceId, version)) {
            return;
          }

          // 仅使对应 TanStack Query read model 失效并通过普通 JSON 重新读取
          switch (type) {
            case "room":
              void queryClient.invalidateQueries({ queryKey: ["rooms"] });
              void queryClient.invalidateQueries({ queryKey: ["public-playlist-cleanups"] });
              void queryClient.invalidateQueries({ queryKey: ["room-shell"] });
              void queryClient.invalidateQueries({ queryKey: ["room-applications"] });
              void queryClient.invalidateQueries({ queryKey: ["room-invite"] });
              void queryClient.invalidateQueries({ queryKey: ["room-public-playlist"] });
              void queryClient.invalidateQueries({ queryKey: ["join-application"] });
              void queryClient.invalidateQueries({ queryKey: ["join-applications"] });
              break;
            case "permission":
              void queryClient.invalidateQueries({ queryKey: ["room-members"] });
              void queryClient.invalidateQueries({ queryKey: ["room-shell"] });
              void queryClient.invalidateQueries({ queryKey: ["room-invite"] });
              void queryClient.invalidateQueries({ queryKey: ["rooms"] });
              void queryClient.invalidateQueries({ queryKey: ["join-application"] });
              void queryClient.invalidateQueries({ queryKey: ["join-applications"] });
              break;
            case "snapshot":
              void queryClient.invalidateQueries({ queryKey: ["room-public-playlist"] });
              break;
            case "operation":
              void queryClient.invalidateQueries({ queryKey: ["song-request-operation"] });
              void queryClient.invalidateQueries({ queryKey: ["room-public-playlist"] });
              break;
            case "search":
              void queryClient.invalidateQueries({ queryKey: ["song-search", resourceId] });
              break;
            case "cleanup":
              void queryClient.invalidateQueries({ queryKey: ["public-playlist-cleanups"] });
              break;
          }
        } catch {
          // 忽略格式解析异常
        }
      });
    }

    connect();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [enabled, queryClient]);
}
