import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useEventStream(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      source = new EventSource("/api/events");

      source.addEventListener("invalidation", (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data as string) as { type: string; roomId: string; resourceId?: string };
          if (payload.type === "publicPlaylist" || payload.type === "songRequest") {
            void queryClient.invalidateQueries({ queryKey: ["room-public-playlist"] });
            void queryClient.invalidateQueries({ queryKey: ["song-request-operation"] });
          } else if (payload.type === "search" && payload.resourceId) {
            void queryClient.invalidateQueries({ queryKey: ["song-search", payload.resourceId] });
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
