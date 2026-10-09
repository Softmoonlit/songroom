import { focusManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { v7 } from "uuid";
import { playbackView, playNextCommand, playNextResponse, playNextOperationView, type PublicPlaylistView } from "../shared/public-playlist-contracts.js";
import { errorMessage, errorMessageForCode, queryOptions, request, RoomRequestError } from "./room-http.js";
import type { ToastData } from "./Toast.js";

const terminal = new Set(["succeeded", "failed", "stopped"]);
const subscribeFocus = (notify: () => void) => focusManager.subscribe(notify);
const getFocus = () => focusManager.isFocused();

type NextCommand = ReturnType<typeof playNextCommand.parse>;
type StoredNext = { command: NextCommand; operationId: string | null };

export function usePublicPlayback({ sessionId, roomId, active, view, pendingWrite, notify }: {
  sessionId: string; roomId: string; active: boolean; view: PublicPlaylistView | undefined;
  pendingWrite: boolean; notify: (toast: ToastData) => void;
}) {
  const client = useQueryClient();
  const focused = useSyncExternalStore(subscribeFocus, getFocus);
  const playlistKey = ["room-public-playlist", sessionId, roomId];
  const playbackKey = ["room-public-playback", sessionId, roomId, view?.playlist?.id];
  const authorized = Boolean(view?.playlist &&
    !["ACCOUNT_PAUSED", "NETEASE_AUTH_REQUIRED"].includes(view.disabledReason ?? ""));
  const playback = useQuery({
    ...queryOptions,
    queryKey: playbackKey,
    queryFn: ({ signal }) => request(`/${roomId}/public-playlist/playback`, playbackView, signal),
    enabled: active && focused && authorized,
    refetchInterval: 30_000,
    refetchOnWindowFocus: "always"
  });
  const playbackRefresh = useMutation({
    mutationFn: async () => {
      await client.cancelQueries({ queryKey: playbackKey });
      return request(`/${roomId}/public-playlist/playback/refresh`, playbackView, undefined, {});
    },
    retry: false,
    onSuccess: data => client.setQueryData(playbackKey, data)
  });
  const refreshFailed = playbackRefresh.isError && playbackRefresh.submittedAt > playback.dataUpdatedAt;
  const playbackFailed = playback.isError || refreshFailed || Boolean(playback.data?.errorCode);
  const songId = authorized && !playbackFailed ? playback.data?.songId ?? null : null;
  const anchorIndex = view?.snapshot?.tracks.findIndex(track => track.songId === songId) ?? -1;
  const anchorSongId = anchorIndex >= 0 ? songId : null;

  const storageKey = `songroom:play-next:${sessionId}:${roomId}`;
  const [stored, setStored] = useState<StoredNext | null>(() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (!value || typeof value !== "object" || !("command" in value)) return null;
      const command = playNextCommand.safeParse(value.command);
      return command.success ? { command: command.data, operationId: "operationId" in value && typeof value.operationId === "string" ? value.operationId : null } : null;
    } catch { return null; }
  });
  const [nextMessage, setNextMessage] = useState("");
  useEffect(() => {
    if (stored) sessionStorage.setItem(storageKey, JSON.stringify(stored));
    else sessionStorage.removeItem(storageKey);
  }, [storageKey, stored]);
  const nextQuery = useQuery({
    ...queryOptions,
    queryKey: ["play-next-operation", sessionId, roomId, stored?.operationId],
    queryFn: ({ signal }) => request(`/${roomId}/public-playlist/play-next/${stored!.operationId}`, playNextOperationView, signal),
    enabled: Boolean(active && focused && stored?.operationId),
    refetchInterval: q => !q.state.data || !terminal.has(q.state.data.status) ? 5_000 : false
  });
  const nextMutation = useMutation({
    mutationFn: (command: NextCommand) => request(`/${roomId}/public-playlist/play-next`, playNextResponse, undefined, command),
    retry: false,
    onSuccess: result => {
      setStored(previous => previous ? { ...previous, operationId: result.operation.id } : previous);
      client.setQueryData(["play-next-operation", sessionId, roomId, result.operation.id], result.operation);
    },
    onError: failure => {
      // Transport/parse failures may follow an accepted write. Preserve the exact command.
      if (failure instanceof RoomRequestError && failure.code !== "UNKNOWN") {
        setStored(null);
        setNextMessage(errorMessage(failure));
        void client.invalidateQueries({ queryKey: playlistKey });
        void client.invalidateQueries({ queryKey: playbackKey });
      } else setNextMessage("提交结果待确认，请查询原操作；请勿重复安排歌曲。");
    }
  });
  useEffect(() => {
    const operation = nextQuery.data;
    if (!operation) return;
    if (operation.status === "succeeded") {
      notify({ id: v7(), message: "已安排下一首播放。", type: "success" });
      setNextMessage("");
      setStored(null);
      void client.invalidateQueries({ queryKey: playlistKey });
    } else if (terminal.has(operation.status)) {
      setNextMessage(operation.errorCode ? errorMessageForCode(operation.errorCode) : "歌单或播放指示已变化，请核对后重新操作。");
      setStored(null);
      void client.invalidateQueries({ queryKey: playlistKey });
      void client.invalidateQueries({ queryKey: playbackKey });
    } else if (operation.status === "awaitingConfirmation") {
      setNextMessage("下一首播放结果待确认，正在核查云端顺序，请勿重复操作。");
    } else if (operation.status === "waitingAuthorization") {
      setNextMessage("等待房主恢复网易云授权后核查下一首播放结果。");
    } else if (operation.status === "needsAdministrator") {
      setNextMessage("下一首播放结果未知，需要管理员核查。");
    } else setNextMessage("正在安排下一首播放…");
  }, [nextQuery.data]);
  const canPlayNext = (view?.allowedActions as readonly string[] | undefined)?.includes("playNext") || view?.allowedActions.includes("requestSong") === true;
  const nextBlocked = pendingWrite || Boolean(stored) || nextMutation.isPending ||
    !canPlayNext || Boolean(view?.disabledReason && view.disabledReason !== "PUBLIC_PLAYLIST_EXISTS");
  function playNext(songId: string) {
    if (nextBlocked || !anchorSongId || !view?.snapshot) return;
    const command = { idempotencyKey: v7(), songId, anchorSongId, snapshotVersion: view.snapshot.version };
    setStored({ command, operationId: null });
    setNextMessage("正在安排下一首播放…");
    nextMutation.mutate(command);
  }
  return {
    anchorSongId, anchorIndex, nextBlocked, playNext, nextMessage,
    playbackFailed, playbackRefreshing: playbackRefresh.isPending,
    refreshPlayback: () => playbackRefresh.mutate(),
    unresolved: Boolean(stored),
    checking: nextMutation.isPending || nextQuery.isFetching,
    checkNext: () => {
      if (!stored || nextMutation.isPending) return;
      if (stored.operationId) void nextQuery.refetch();
      else nextMutation.mutate(stored.command);
    }
  };
}
