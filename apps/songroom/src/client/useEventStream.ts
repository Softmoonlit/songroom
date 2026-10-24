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

  // search 的版本仅对应自身查询；共享事件仅按已处理事件去重。
  useEffect(() => {
    if (!enabled) return;

    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "error") {
        // 查询遇错时不锁定最高版本，允许后续失效事件再次触发重新读取
        const firstKey = event.query.queryKey[0];
        if (
          firstKey === "song-request-operation" ||
          firstKey === "random-replacement-operation"
        ) {
          const opId = event.query.queryKey[1] as string | undefined;
          if (opId) trackerRef.current.reset("operation", opId);

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

    function refresh(queryKey: string[]) {
      // 初次读取没有缓存时也须取消旧请求，确保事件后的读取不会复用旧响应。
      void queryClient.cancelQueries({ queryKey }).then(() => queryClient.invalidateQueries({ queryKey }));
    }

    function connect() {
      if (cancelled) return;
      source = new EventSource("/api/events");

      source.addEventListener("connected", () => {
        // 断线、服务重启或休眠后重连时，完整使当前活跃 read model 失效并重新读取
        if (!isFirstConnect.current) {
          const active = { type: "active" as const };
          void queryClient.cancelQueries(active).then(() => queryClient.invalidateQueries(active));
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
              refresh(["rooms"]);
              refresh(["public-playlist-cleanups"]);
              refresh(["room-shell"]);
              refresh(["room-applications"]);
              refresh(["room-invite"]);
              refresh(["room-public-playlist"]);
              refresh(["room-personal-playlist"]);
              refresh(["join-application"]);
              refresh(["join-applications"]);
              break;
            case "permission":
              refresh(["room-members"]);
              refresh(["room-shell"]);
              refresh(["room-invite"]);
              refresh(["rooms"]);
              refresh(["join-application"]);
              refresh(["join-applications"]);
              break;
            case "snapshot":
              refresh(["room-public-playlist"]);
              refresh(["room-personal-playlist"]);
              break;
            case "operation":
              refresh(["song-request-operation"]);
              refresh(["personal-song-addition-operation"]);
              refresh(["random-replacement-operation"]);
              refresh(["room-personal-playlist"]);
              refresh(["room-public-playlist"]);
              break;
            case "cleanup":
              refresh(["public-playlist-cleanups"]);
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
