import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Music2 } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import { publicPlaylistView, type PublicPlaylistCreateCommand, type PublicPlaylistTrack, type PublicPlaylistView } from "../shared/public-playlist-contracts";
import { errorMessage, errorMessageForCode, queryOptions, request, RoomRequestError } from "./room-http";
import { QueryError } from "./RoomQueryError";

const operationMessages: Record<NonNullable<PublicPlaylistView["operation"]>["status"], string> = {
  queued: "已排队，等待创建公共歌单。",
  processing: "正在创建公共歌单。",
  awaitingConfirmation: "创建结果待确认，可能已在网易云创建。请勿重试创建。",
  waitingAuthorization: "正在等待房主恢复网易云授权。",
  needsAdministrator: "创建结果需要管理员处理，请联系管理员，不能重试创建。",
  succeeded: "公共歌单已创建并绑定。",
  failed: "创建明确失败，请查看当前可用操作。",
  stopped: "创建操作已停止。"
};
const disabledMessages = {
  OWNER_ONLY: "只有房主可以创建公共歌单。",
  NETEASE_AUTH_REQUIRED: "请房主先在账号设置中绑定有效的网易云账号。",
  PUBLIC_PLAYLIST_EXISTS: "此房间已经绑定公共歌单。",
  ACCOUNT_PAUSED: "网易云账号因风控或频繁请求已暂停，请联系管理员恢复。",
  TARGET_BLOCKED: "当前目标权限需要处理，其他房间可继续使用。",
  UPSTREAM_QUEUE_FULL: "网易云账号已有 20 项排队或执行中的操作，请等待空位。",
  OPERATION_PENDING: "已有未完成的创建操作，不能再次创建。"
};

function TrackList({ tracks, active }: { tracks: PublicPlaylistTrack[]; active: boolean }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 10
  });

  useLayoutEffect(() => {
    if (active && parentRef.current && savedScrollTop.current > 0) {
      parentRef.current.scrollTop = savedScrollTop.current;
    }
  }, [active]);

  return (
    <div
      ref={parentRef}
      onScroll={e => {
        savedScrollTop.current = e.currentTarget.scrollTop;
      }}
      className="playlist-tracks-container"
      role="list"
      aria-label="歌曲列表"
      tabIndex={0}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative"
        }}
      >
        {virtualizer.getVirtualItems().map(virtualRow => {
          const track = tracks[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              role="listitem"
              tabIndex={0}
              aria-label={`${track.position + 1}. ${track.name}，歌手：${track.artists.join("、")}，专辑：${track.album}`}
              className="track-item"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <span className="track-index" aria-hidden="true">{track.position + 1}</span>
              <div className="track-info">
                <span className="track-name" title={track.name}>{track.name}</span>
                <span className="track-artists-album" title={`${track.artists.join(" / ")} - ${track.album}`}>
                  {track.artists.join(" / ")} · {track.album}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PublicPlaylistPane({ sessionId, roomId, active }: { sessionId: string; roomId: string; active: boolean }) {
  const client = useQueryClient();
  const queryKey = ["room-public-playlist", sessionId, roomId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => request(`/${roomId}/public-playlist`, publicPlaylistView, signal), enabled: active, ...queryOptions });
  const [command, setCommand] = useState<PublicPlaylistCreateCommand | null>(null);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  const [refreshError, setRefreshError] = useState("");

  useEffect(() => () => {
    controller.current?.abort();
    refreshController.current?.abort();
  }, []);

  const mutation = useMutation({
    mutationFn: async (body: PublicPlaylistCreateCommand) => {
      controller.current = new AbortController();
      await client.cancelQueries({ queryKey });
      return request(`/${roomId}/public-playlist`, publicPlaylistView, controller.current.signal, body);
    },
    retry: false,
    onSuccess: view => {
      if (controller.current?.signal.aborted) return;
      client.setQueryData(queryKey, view);
      setCommand(null);
      setMessage("");
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      setMessage(errorMessage(failure));
      if (failure instanceof RoomRequestError) {
        // 过期键已被服务端拒绝；其他失败保留原键，避免响应丢失后产生新的创建意图。
        if (failure.code === "IDEMPOTENCY_KEY_EXPIRED") setCommand(null);
        void client.invalidateQueries({ queryKey });
      }
    }
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      refreshController.current = new AbortController();
      return request(`/${roomId}/public-playlist/refresh`, publicPlaylistView, refreshController.current.signal, {});
    },
    retry: false,
    onSuccess: updatedView => {
      if (refreshController.current?.signal.aborted) return;
      client.setQueryData(queryKey, updatedView);
      setRefreshError("");
    },
    onError: failure => {
      if (refreshController.current?.signal.aborted) return;
      setRefreshError(errorMessage(failure));
    }
  });

  // 进入页面触发一次独立显式刷新
  const refreshedOnEnter = useRef<string | null>(null);
  useEffect(() => {
    const currentView = query.data;
    if (active && currentView?.playlist && currentView.allowedActions.includes("refreshPublicPlaylist")) {
      const key = `${roomId}:${currentView.playlist.id}`;
      if (refreshedOnEnter.current !== key) {
        refreshedOnEnter.current = key;
        refreshMutation.mutate();
      }
    } else if (!active) {
      refreshedOnEnter.current = null;
    }
  }, [active, query.data?.playlist?.id, query.data?.allowedActions]);

  if (query.isPending) return <><h2>公共歌单</h2><p role="status">正在读取公共歌单状态…</p></>;
  if (query.isError) return <><h2>公共歌单</h2><QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} /></>;
  if (!query.data) return null;
  const view = query.data;

  const formatTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

  return <>
    <h2>公共歌单</h2>
    <div className="empty-card">
      <Music2 size={27} aria-hidden="true" />
      {view.playlist ? <>
        <h3>{view.playlist.name}</h3>
        <dl className="netease-identity"><div><dt>网易云歌单 ID</dt><dd>{view.playlist.id}</dd></div></dl>
      </> : <>
        <h3>尚未创建公共歌单</h3>
        <p>创建房间不会自动创建公共歌单。由房主按需创建此房间专用的公共歌单，名称为 songroom-房间名-公共。</p>
      </>}
      {view.operation && <p className="netease-status" role="status">{operationMessages[view.operation.status]}</p>}
      {view.operation?.errorCode && <p className="field-help">{errorMessageForCode(view.operation.errorCode)}</p>}
      {view.disabledReason && view.disabledReason !== "PUBLIC_PLAYLIST_EXISTS" && <p className="field-help">{disabledMessages[view.disabledReason]}</p>}
      {!view.playlist && view.disabledReason === "PUBLIC_PLAYLIST_EXISTS" && <p className="field-help">{disabledMessages.PUBLIC_PLAYLIST_EXISTS}</p>}
      {view.allowedActions.includes("createPublicPlaylist") && <button className="primary-button" type="button" disabled={mutation.isPending || query.isFetching || view.disabledReason !== null} onClick={() => {
        if (mutation.isPending || view.disabledReason) return;
        const next = command ?? { idempotencyKey: uuidv7() };
        setCommand(next);
        setMessage("");
        mutation.mutate(next);
      }}>{mutation.isPending ? "正在提交创建…" : "创建公共歌单"}</button>}
      {view.playlist && <>
        {view.snapshot?.syncedAt ? <p className="sync-time">最近成功同步：{formatTime(view.snapshot.syncedAt)}</p> : null}
        {refreshMutation.isPending ? <p className="netease-status" role="status">正在刷新歌单…</p> : null}
        {!refreshMutation.isPending && view.lastRefreshError ? <p className="field-help" role="alert">刷新未成功（{errorMessageForCode(view.lastRefreshError)}），已保留上次快照</p> : null}
        {!refreshMutation.isPending && refreshError ? <p className="form-message" role="alert">{refreshError}</p> : null}
        {!refreshMutation.isPending && !view.lastRefreshError && !refreshError && view.snapshot?.syncedAt ? <p className="netease-status" role="status">歌单已同步</p> : null}
        <div className="invite-actions">
          {view.allowedActions.includes("refreshPublicPlaylist") && <button className="primary-button" type="button" disabled={refreshMutation.isPending || view.disabledReason === "ACCOUNT_PAUSED"} onClick={() => {
            setRefreshError("");
            refreshMutation.mutate();
          }}>{refreshMutation.isPending ? "正在刷新…" : "刷新歌单"}</button>}
          <button className="secondary-button" type="button" disabled={query.isFetching || mutation.isPending || refreshMutation.isPending} onClick={() => void query.refetch()}>{query.isFetching ? "正在更新状态…" : "更新状态"}</button>
        </div>
        {(!view.snapshot || view.snapshot.syncedAt === null) ? <div className="initial-sync-card">
          <p>正在进行首次同步，请稍候…</p>
        </div> : view.snapshot.trackCount === 0 ? <div className="empty-playlist-card">
          <p>歌单暂无歌曲。房主可在网易云音乐中添加歌曲后点击上方刷新。</p>
        </div> : <TrackList tracks={view.snapshot.tracks} active={active} />}
      </>}
      {!view.playlist && <button className="secondary-button" type="button" disabled={query.isFetching || mutation.isPending} onClick={() => void query.refetch()}>{query.isFetching ? "正在更新状态…" : "更新状态"}</button>}
      {message && <p className="form-message" role="alert">{message}</p>}
    </div>
  </>;
}
