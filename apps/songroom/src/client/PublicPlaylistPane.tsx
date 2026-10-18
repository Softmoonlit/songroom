import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { LocateFixed, Music2, Plus, RotateCw, Search, Shuffle, X } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import {
  publicPlaylistView,
  randomReplacementOperationView,
  songRequestOperationView,
  songRequestResponse,
  type PublicPlaylistCreateCommand,
  type PublicPlaylistTrack,
  type PublicPlaylistView,
  type RandomReplacementOperationView
} from "../shared/public-playlist-contracts.js";
import type { SongCandidate } from "../shared/song-search-contracts.js";
import { errorMessage, errorMessageForCode, queryOptions, request, RoomRequestError } from "./room-http.js";
import { QueryError } from "./RoomQueryError.js";
import { SongRequestDrawer } from "./SongRequestDrawer.js";
import { RandomReplacementDialog } from "./RandomReplacementDialog.js";
import { usePublicPlayback } from "./usePublicPlayback.js";
import { Toast, type ToastData } from "./Toast.js";
import { getFriendlySongRequestErrorMessage, getFriendlyOperationStatusMessage } from "./song-request-messages.js";
import {
  getFriendlyReplacementErrorMessage,
  getFriendlyReplacementOperationStatus
} from "./random-replacement-messages.js";

const operationMessages: Record<NonNullable<PublicPlaylistView["operation"]>["status"], string> = {
  queued: "已排队，等待创建公共歌单。",
  processing: "正在创建公共歌单。",
  awaitingConfirmation: "创建结果待确认（创建结果待核查），可能已在网易云创建。请勿重试创建。",
  waitingAuthorization: "正在等待房主恢复网易云授权。",
  needsAdministrator: "创建结果未知，需要管理员处理，已阻止该房间再次创建。",
  succeeded: "公共歌单已创建并绑定。",
  failed: "创建明确失败，请查看当前可用操作。",
  stopped: "创建操作已停止。"
};

export function getOperationMessage(op: NonNullable<PublicPlaylistView["operation"]>): string {
  if (op.step === "confirming") {
    if (op.recovered) {
      return "具体 ID 已恢复，正在核验并完成公共歌单关联。";
    }
    return "已获 ID 待关联，正在建立房间公共歌单绑定。";
  }
  if (op.step === "unknown" || op.status === "needsAdministrator") {
    return "创建结果未知，需要管理员处理，已阻止该房间再次创建。";
  }
  return operationMessages[op.status];
}

function getPlaylistRefreshErrorMessage(code: string): string {
  switch (code) {
    case "MODULE_ERROR":
      return "网易云服务暂时响应异常，请稍后刷新重试。";
    case "NETWORK_ERROR":
      return "网络连接失败，请稍后重试。";
    case "DEADLINE":
      return "网易云请求超时，请稍后重试。";
    case "PARSE_ERROR":
      return "网易云返回数据解析异常。";
    case "RATE_LIMITED":
      return "网易云请求受限，请稍后重试。";
    case "AUTH_UNAVAILABLE":
      return "网易云授权失效，请房主前往账号设置检查。";
    default:
      return errorMessageForCode(code);
  }
}

const disabledMessages = {
  OWNER_ONLY: "只有房主可以创建公共歌单。",
  NETEASE_AUTH_REQUIRED: "请房主先在账号设置中绑定有效的网易云账号。",
  PUBLIC_PLAYLIST_EXISTS: "此房间已经绑定公共歌单。",
  ACCOUNT_PAUSED: "网易云账号因风控或频繁请求已暂停，请联系管理员恢复。",
  TARGET_BLOCKED: "当前目标有待确认的写入操作，其他房间可继续使用。",
  UPSTREAM_QUEUE_FULL: "网易云账号已有 20 项排队或执行中的操作，请等待空位。",
  OPERATION_PENDING: "已有未完成的创建操作，不能再次创建。"
};

function TrackList({ tracks, active, highlight, onHighlightEnd, playback, isFilterActive, onClearFilter }: {
  tracks: PublicPlaylistTrack[]; active: boolean;
  highlight: { songId: string; id: string } | null;
  onHighlightEnd: () => void;
  playback: ReturnType<typeof usePublicPlayback>;
  isFilterActive?: boolean;
  onClearFilter?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useWindowVirtualizer({
    count: tracks.length,
    estimateSize: () => window.innerWidth <= 768 ? 104 : 76,
    getItemKey: index => tracks[index].songId,
    overscan: 10,
    scrollMargin,
    enabled: active
  });
  useLayoutEffect(() => {
    if (!active || !listRef.current) return;
    const measure = () => setScrollMargin(listRef.current!.getBoundingClientRect().top + window.scrollY);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [active]);
  useEffect(() => {
    if (!active || !highlight) return;
    const index = tracks.findIndex(track => track.songId === highlight.songId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center", behavior: "auto" });
  }, [highlight?.id, active, tracks, scrollMargin]);
  return <div className="playlist-tracks-wrapper">
    <div className="playlist-tracks-header-bar" role="region" aria-label="歌曲列表表头">
      <span className="tracks-header-col col-index">#</span>
      <span className="tracks-header-col col-title">歌曲与歌手</span>
      <span className="tracks-header-col col-requester">点歌人</span>
    </div>
    {tracks.length === 0 && isFilterActive ? (
      <div className="playlist-tracks-empty-filter" role="status">
        <p>未找到匹配的歌曲</p>
        {onClearFilter && (
          <button type="button" className="secondary-button" onClick={onClearFilter}>
            清除筛选条件
          </button>
        )}
      </div>
    ) : (
      <div ref={listRef} className="playlist-tracks-container" role="list" aria-label="歌曲列表"
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map(row => {
          const track = tracks[row.index];
          const playing = track.songId === playback.anchorSongId;
          return <div key={row.key} ref={virtualizer.measureElement} data-index={row.index}
            data-song-id={track.songId} role="listitem" tabIndex={0}
            aria-label={`${track.position + 1}. ${track.name}，歌手：${track.artists.join("、")}${track.album ? `，专辑：${track.album}` : ""}${track.requesters.length ? `，点歌人：${track.requesters.join("、")}` : ""}${playing ? "，播放指示" : ""}`}
            className={`track-item ${track.songId === highlight?.songId ? "track-item-highlighted" : ""}`}
            onAnimationEnd={event => { if (event.animationName === "trackHighlight") onHighlightEnd(); }}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start - scrollMargin}px)` }}>
            <span className="track-index" aria-hidden="true">{playing ? <span className="playback-indicator"><i /><i /><i /></span> : track.position + 1}</span>
            <div className="track-info">
              <span className="track-name" title={track.name}>{track.name}</span>
              <span className="track-artists-album" title={`${track.artists.join(" / ")} · ${track.album}`}>
                {track.artists.join(" / ")}{track.album && <span className="track-album"> · {track.album}</span>}
              </span>
            </div>
            <div className="track-requesters-side" aria-label={track.requesters.length ? `点歌人：${track.requesters.join("、")}` : undefined}>
              {track.requesters.map(requester => <span key={requester} className="requester-capsule" title={`点歌人：${requester}`} aria-label={`点歌人：${requester}`}>{requester}</span>)}
            </div>
          </div>;
        })}
      </div>
    )}
  </div>;
}

export function PublicPlaylistPane({ sessionId, roomId, active }: { sessionId: string; roomId: string; active: boolean }) {
  const client = useQueryClient();
  const queryKey = ["room-public-playlist", sessionId, roomId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => request(`/${roomId}/public-playlist`, publicPlaylistView, signal), enabled: active, ...queryOptions });
  const [command, setCommand] = useState<PublicPlaylistCreateCommand | null>(null);
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const refreshController = useRef<AbortController | null>(null);

  // 点歌抽屉与正反馈交互状态
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [highlight, setHighlight] = useState<{ songId: string; id: string } | null>(null);
  const [requestErrorMessage, setRequestErrorMessage] = useState("");
  const [operationStatusMessage, setOperationStatusMessage] = useState("");
  const [isRequesting, setIsRequesting] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);

  // 歌单内搜索与筛选状态
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRequester, setSelectedRequester] = useState("all");

  // 随机换一组弹窗与持久操作状态
  const [isRandomDialogOpen, setIsRandomDialogOpen] = useState(false);
  const [activeReplacementOperationId, setActiveReplacementOperationId] = useState<string | null>(null);

  const availableRequesters = useMemo(() => {
    if (!query.data?.snapshot?.tracks) return [];
    const set = new Set<string>();
    for (const track of query.data.snapshot.tracks) {
      for (const requester of track.requesters) {
        set.add(requester);
      }
    }
    return Array.from(set).sort();
  }, [query.data?.snapshot?.tracks]);

  const filteredTracks = useMemo(() => {
    if (!query.data?.snapshot?.tracks) return [];
    let list = query.data.snapshot.tracks;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(track =>
        track.name.toLowerCase().includes(q) ||
        track.artists.some(artist => artist.toLowerCase().includes(q))
      );
    }
    if (selectedRequester && selectedRequester !== "all") {
      list = list.filter(track => track.requesters.includes(selectedRequester));
    }
    return list;
  }, [query.data?.snapshot?.tracks, searchQuery, selectedRequester]);

  const isFilterActive = Boolean(searchQuery.trim() || (selectedRequester && selectedRequester !== "all"));

  const playback = usePublicPlayback({ sessionId, roomId, active, view: query.data,
    pendingWrite: isRequesting || Boolean(activeOperationId) || Boolean(activeReplacementOperationId), notify: setToast });

  const openSongRequestDrawer = () => {
    setRequestErrorMessage("");
    setOperationStatusMessage("");
    setIsDrawerOpen(true);
  };

  const handleSongRequestSucceeded = (songId: string, name: string) => {
    setIsRequesting(false);
    setIsDrawerOpen(false);
    setActiveOperationId(null);
    setOperationStatusMessage("");
    setHighlight({ songId, id: uuidv7() });
    setToast({
      id: uuidv7(),
      message: `《${name}》点歌成功！已加入公共歌单并记录你的标签。`,
      type: "success"
    });
    void client.invalidateQueries({ queryKey });
  };

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
      if (!updatedView.lastRefreshError) setToast({ id: uuidv7(), message: "歌单已同步", type: "success" });
    },
    onError: failure => {
      if (refreshController.current?.signal.aborted) return;
      setRefreshError(errorMessage(failure));
    }
  });

  // 异步点歌操作轮询与监听（由 SSE 失效通知驱动重查，附带低频兜底）
  const operationQuery = useQuery({
    queryKey: ["song-request-operation", activeOperationId],
    queryFn: ({ signal }) => request(`/${roomId}/song-requests/${activeOperationId}`, songRequestOperationView, signal),
    enabled: Boolean(activeOperationId && active),
    refetchInterval: q => (q.state.data?.status && ["queued", "processing", "awaitingConfirmation"].includes(q.state.data.status) ? 10000 : false),
    ...queryOptions
  });

  useEffect(() => {
    if (!operationQuery.data) return;
    const op = operationQuery.data;
    switch (op.status) {
      case "succeeded":
        handleSongRequestSucceeded(op.songId, op.name);
        break;
      case "awaitingConfirmation":
        setIsRequesting(false);
        setIsDrawerOpen(false);
        setOperationStatusMessage("");
        setToast({
          id: uuidv7(),
          message: op.songConfirmed && !op.tagConfirmed
            ? `《${op.name}》网易云已确认，但点歌人标签待补记。`
            : `《${op.name}》已发送至网易云，正在等待云端确认，请稍后刷新查看。`,
          type: "info"
        });
        void client.invalidateQueries({ queryKey });
        // 不清除 activeOperationId，保留轮询直到到达 succeeded
        break;
      case "waitingAuthorization":
        setIsRequesting(false);
        setOperationStatusMessage("");
        setRequestErrorMessage("房主的网易云授权需要重新确认，正在等待房主恢复授权…");
        break;
      case "needsAdministrator":
        setIsRequesting(false);
        setActiveOperationId(null);
        setOperationStatusMessage("");
        setRequestErrorMessage("点歌操作需要管理员协助处理，请联系房主或管理员。");
        break;
      case "failed":
      case "stopped":
        setIsRequesting(false);
        setActiveOperationId(null);
        setOperationStatusMessage("");
        setRequestErrorMessage(getFriendlySongRequestErrorMessage(op.errorCode));
        break;
      case "queued":
      case "processing":
        setOperationStatusMessage(getFriendlyOperationStatusMessage(op.status, op.name));
        break;
    }
  }, [operationQuery.data, client, queryKey]);

  useEffect(() => {
    if (operationQuery.isError) {
      setIsRequesting(false);
      setOperationStatusMessage("");
      setRequestErrorMessage(getFriendlySongRequestErrorMessage("NETWORK_ERROR"));
    }
  }, [operationQuery.isError]);

  const songRequestMutation = useMutation({
    mutationFn: async (candidate: SongCandidate) => {
      setIsRequesting(true);
      setRequestErrorMessage("");
      setOperationStatusMessage("");
      const key = uuidv7();
      return request(`/${roomId}/song-requests`, songRequestResponse, undefined, {
        idempotencyKey: key,
        sourcePlaylistId: "retired-in-issue-03",
        songId: candidate.id,
        name: candidate.name,
        artists: candidate.artists,
        album: candidate.album
      });
    },
    onSuccess: res => {
      if (res.operation.status === "succeeded") {
        handleSongRequestSucceeded(res.operation.songId, res.operation.name);
      } else {
        setActiveOperationId(res.operation.id);
        setOperationStatusMessage(getFriendlyOperationStatusMessage(res.operation.status, res.operation.name));
      }
    },
    onError: failure => {
      setIsRequesting(false);
      setOperationStatusMessage("");
      const code = failure instanceof RoomRequestError ? failure.code : null;
      setRequestErrorMessage(getFriendlySongRequestErrorMessage(code));
    }
  });

  function handleConfirmSongRequest(candidate: SongCandidate) {
    if (isRequesting) return;
    songRequestMutation.mutate(candidate);
  }

  // 异步换歌操作轮询与监听
  const replacementOperationQuery = useQuery({
    queryKey: ["random-replacement-operation", activeReplacementOperationId],
    queryFn: ({ signal }) =>
      request(
        `/${roomId}/public-playlist/random-replacement/${activeReplacementOperationId}`,
        randomReplacementOperationView,
        signal
      ),
    enabled: Boolean(activeReplacementOperationId && active),
    refetchInterval: q =>
      q.state.data?.status &&
      ["queued", "processing", "awaitingConfirmation"].includes(q.state.data.status)
        ? 2500
        : false,
    ...queryOptions
  });

  // 跨页面或刷新恢复：若房间已绑定公共歌单且存在未终结的换歌操作，自动恢复轮询
  useEffect(() => {
    const v = query.data;
    if (
      v?.playlist &&
      v.operation?.kind === "replacePublicPlaylist" &&
      v.operation.status !== "succeeded" &&
      !activeReplacementOperationId
    ) {
      setActiveReplacementOperationId(v.operation.id);
    }
  }, [query.data, activeReplacementOperationId]);

  useEffect(() => {
    if (!replacementOperationQuery.data) return;
    const op = replacementOperationQuery.data;
    if (op.status === "succeeded") {
      setActiveReplacementOperationId(null);
      setToast({
        id: uuidv7(),
        message: "换歌成功！已更新公共歌单。请在网易云官方客户端重新载入歌单并点击「播放全部」。",
        type: "success"
      });
      void client.invalidateQueries({ queryKey });
    } else if (op.status === "failed" || op.status === "stopped") {
      void client.invalidateQueries({ queryKey });
    }
  }, [replacementOperationQuery.data, client, queryKey]);

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

  if (query.isPending) return <><h1 className="public-playlist-title-heading">公共歌单</h1><p role="status">正在读取公共歌单状态…</p></>;
  if (query.isError) return <><h1 className="public-playlist-title-heading">公共歌单</h1><QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} /></>;
  if (!query.data) return null;
  const view = query.data;

  const activeReplacementOperation = replacementOperationQuery.data ?? null;
  const isReplacementBusy = Boolean(
    activeReplacementOperation &&
      ["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator"].includes(
        activeReplacementOperation.status
      )
  );

  const formatTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

  const handleCreatePlaylist = () => {
    if (mutation.isPending || view.disabledReason) return;
    const next = command ?? { idempotencyKey: uuidv7() };
    setCommand(next);
    setMessage("");
    mutation.mutate(next);
  };

  return <>
    <h1 className="public-playlist-title-heading">公共歌单</h1>
    {!view.playlist ? (
      view.invalidatedTarget ? (
        <div className="playlist-empty-state-card invalidated" role="region" aria-label="公共歌单失效状态">
          <div className="empty-state-icon-wrapper danger">
            <Music2 size={28} aria-hidden="true" />
          </div>
          <h3>公共歌单已确认失效</h3>
          <p className="field-help" role="alert">
            原公共歌单「{view.invalidatedTarget.name}」（ID: {view.invalidatedTarget.playlistId}）已从网易云删除。最后核查状态：已确认失效（{formatTime(view.invalidatedTarget.checkedAt)}）。
          </p>
          {view.disabledReason === "OWNER_ONLY" && <p className="field-help" role="status">已确认失效，等待房主重新创建公共歌单。</p>}
          {view.operation && view.operation.status !== "succeeded" && <p className="netease-status" role="status">{getOperationMessage(view.operation)}</p>}
          {view.operation?.errorCode && <p className="field-help">{errorMessageForCode(view.operation.errorCode)}</p>}
          {view.disabledReason && view.disabledReason !== "OWNER_ONLY" && <p className="field-help">{disabledMessages[view.disabledReason]}</p>}
          {view.allowedActions.includes("createPublicPlaylist") && (
            <button
              className="primary-button"
              type="button"
              disabled={mutation.isPending || query.isFetching || view.disabledReason !== null}
              onClick={handleCreatePlaylist}
            >
              {mutation.isPending ? "正在提交创建…" : "重新创建公共歌单"}
            </button>
          )}
          {message && <p className="form-message" role="alert">{message}</p>}
        </div>
      ) : (
        <div className="playlist-empty-state-card uncreated" role="region" aria-label="创建公共歌单">
          <div className="empty-state-icon-wrapper">
            <Music2 size={28} aria-hidden="true" />
          </div>
          <h3>尚未创建公共歌单</h3>
          <p className="empty-state-desc">创建房间不会自动创建公共歌单。由房主按需创建此房间专用的公共歌单，名称为 songroom-房间名-公共。</p>
          {view.operation && view.operation.status !== "succeeded" && <p className="netease-status" role="status">{getOperationMessage(view.operation)}</p>}
          {view.operation?.errorCode && <p className="field-help">{errorMessageForCode(view.operation.errorCode)}</p>}
          {view.disabledReason && <p className="field-help">{disabledMessages[view.disabledReason]}</p>}
          {view.allowedActions.includes("createPublicPlaylist") && (
            <button
              className="primary-button"
              type="button"
              disabled={mutation.isPending || query.isFetching || view.disabledReason !== null}
              onClick={handleCreatePlaylist}
            >
              {mutation.isPending ? "正在提交创建…" : "创建公共歌单"}
            </button>
          )}
          {message && <p className="form-message" role="alert">{message}</p>}
        </div>
      )
    ) : (
      <div className="public-playlist-view">
        <header className="playlist-header">
          <div className="playlist-header-left">
            <div className="playlist-title-row">
              {view.snapshot && (
                <span className="playlist-track-badge" aria-label={isFilterActive ? `筛选出 ${filteredTracks.length} 首，共 ${view.snapshot.trackCount} 首歌曲` : `共 ${view.snapshot.trackCount} 首歌曲`}>
                  {isFilterActive ? (
                    <>筛选出 <strong>{filteredTracks.length}</strong> / 共 {view.snapshot.trackCount} 首</>
                  ) : (
                    <>{view.snapshot.trackCount} 首歌曲</>
                  )}
                </span>
              )}
            </div>
            <div className="playlist-header-meta">
              {refreshMutation.isPending ? (
                <span className="sync-micro-status status-pending" role="status">正在同步歌单…</span>
              ) : view.lastRefreshError ? (
                <span className="sync-micro-status status-error" role="alert">
                  暂时读取失败（刷新未成功：{getPlaylistRefreshErrorMessage(view.lastRefreshError)}），已保留上次快照
                </span>
              ) : refreshError ? (
                <span className="sync-micro-status status-error" role="alert">{refreshError}</span>
              ) : null}
              {playback.playbackFailed && <span className="sync-micro-status status-error" role="status">播放指示读取失败</span>}
            </div>
          </div>

          <div className="playlist-header-right">
            {/* 显眼的右上角「+ 点歌」主操作入口 */}
            {view.allowedActions.includes("requestSong") && (
              <button
                className="primary-button open-request-drawer-btn"
                type="button"
                disabled={view.disabledReason === "ACCOUNT_PAUSED" || playback.unresolved}
                aria-label="+ 点歌"
                aria-haspopup="dialog"
                aria-expanded={isDrawerOpen}
                onClick={openSongRequestDrawer}
              >
                <Plus size={15} aria-hidden="true" />
                <span>点歌</span>
              </button>
            )}

            <button type="button" className="secondary-button locate-playback-button"
              disabled={!playback.anchorSongId} onClick={() => playback.anchorSongId && setHighlight({ songId: playback.anchorSongId, id: uuidv7() })}>
              <LocateFixed size={14} aria-hidden="true" />
              <span>定位到正在播放</span>
            </button>

            {view.allowedActions.includes("refreshPublicPlaylist") && (
              <button
                className="secondary-button sync-playlist-button"
                type="button"
                disabled={refreshMutation.isPending || playback.playbackRefreshing || view.disabledReason === "ACCOUNT_PAUSED"}
                onClick={() => {
                  setRefreshError("");
                  refreshMutation.mutate();
                  playback.refreshPlayback();
                }}
                aria-label={refreshMutation.isPending ? "正在同步歌单…" : "同步歌单"}
              >
                <RotateCw size={14} className={refreshMutation.isPending ? "spin-icon" : ""} aria-hidden="true" />
                <span>{refreshMutation.isPending ? "正在同步…" : "同步歌单"}</span>
              </button>
            )}

            {view.snapshot && view.snapshot.tracks.length > 0 && (
              <button
                type="button"
                className={`secondary-button search-toggle-button ${isSearchOpen || isFilterActive ? "active" : ""}`}
                onClick={() => setIsSearchOpen(prev => !prev)}
                aria-label={isSearchOpen ? "收起搜索筛选" : "展开搜索筛选"}
                aria-expanded={isSearchOpen}
              >
                <Search size={14} aria-hidden="true" />
                <span>搜索</span>
              </button>
            )}

            {view.allowedActions.includes("replacePublicPlaylist") && (
              <button
                type="button"
                className="secondary-button random-replacement-button"
                disabled={isReplacementBusy || isRequesting || Boolean(activeOperationId) || view.disabledReason === "ACCOUNT_PAUSED" || playback.unresolved}
                onClick={() => setIsRandomDialogOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={isRandomDialogOpen}
                title="随机换一组歌曲"
              >
                <Shuffle size={14} aria-hidden="true" />
                <span>随机换一组</span>
              </button>
            )}
          </div>
        </header>

        {(isSearchOpen || isFilterActive) && (
          <div className="playlist-filter-bar" role="search" aria-label="歌单内搜索与筛选">
            <div className="playlist-search-input-wrap">
              <Search size={14} className="search-input-icon" aria-hidden="true" />
              <input
                type="search"
                className="playlist-search-input"
                placeholder="搜索歌名或歌手…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="搜索歌名或歌手"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery("")}
                  aria-label="清空搜索词"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>

            <div className="playlist-requester-filter-wrap">
              <select
                className="playlist-requester-select"
                value={selectedRequester}
                onChange={e => setSelectedRequester(e.target.value)}
                aria-label="按点歌人筛选"
              >
                <option value="all">全部点歌人</option>
                {availableRequesters.map(req => (
                  <option key={req} value={req}>
                    {req}
                  </option>
                ))}
              </select>
            </div>

            {isFilterActive && (
              <button
                type="button"
                className="filter-reset-button"
                onClick={() => {
                  setSearchQuery("");
                  setSelectedRequester("all");
                }}
                aria-label="清除全部筛选"
              >
                清除筛选
              </button>
            )}
          </div>
        )}

        {activeReplacementOperation && activeReplacementOperation.status !== "succeeded" && (
          <div className={`replacement-status-banner status-${activeReplacementOperation.status}`} role="status">
            <div className="replacement-status-header">
              <RotateCw
                size={16}
                className={
                  activeReplacementOperation.status === "processing" ||
                  activeReplacementOperation.status === "queued"
                    ? "spin-icon"
                    : ""
                }
                aria-hidden="true"
              />
              <strong>{getFriendlyReplacementOperationStatus(activeReplacementOperation).title}</strong>
              {(activeReplacementOperation.status === "failed" || activeReplacementOperation.status === "stopped") && (
                <button
                  type="button"
                  className="status-dismiss-btn"
                  onClick={() => setActiveReplacementOperationId(null)}
                  aria-label="关闭状态提示"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <p className="replacement-status-desc">
              {getFriendlyReplacementOperationStatus(activeReplacementOperation).description}
            </p>
          </div>
        )}

        {view.disabledReason && view.disabledReason !== "PUBLIC_PLAYLIST_EXISTS" && (
          <p className="field-help">{disabledMessages[view.disabledReason]}</p>
        )}

        {playback.nextMessage && <p role="status" className="field-help">{playback.nextMessage}</p>}
        {playback.unresolved && <button type="button" className="secondary-button" disabled={playback.checking} onClick={playback.checkNext}>查询下一首播放结果</button>}

        {(!view.snapshot || view.snapshot.syncedAt === null) ? (
          <div className="initial-sync-card">
            <p>正在进行首次同步，请稍候…</p>
          </div>
        ) : view.snapshot.trackCount === 0 ? (
          <div className="empty-playlist-card" role="region" aria-label="空歌单提示">
            <div className="empty-playlist-illustration" aria-hidden="true">
              <div className="empty-disc-glow" />
              <div className="empty-disc">
                <Music2 size={36} className="empty-music-icon" />
              </div>
            </div>
            <h4 className="empty-playlist-title">歌单暂无歌曲</h4>
            <p className="empty-playlist-guidance">
              点击右上角「+ 点歌」或下方按钮，为你和室友添上第一首背景音乐。
            </p>
            {view.allowedActions.includes("requestSong") && (
              <button
                className="primary-button empty-playlist-cta-btn"
                type="button"
                disabled={view.disabledReason === "ACCOUNT_PAUSED" || playback.unresolved}
                aria-label="+ 点歌"
                onClick={openSongRequestDrawer}
              >
                <Plus size={15} aria-hidden="true" />
                <span>点一首歌</span>
              </button>
            )}
          </div>
        ) : (
          <TrackList
            tracks={filteredTracks}
            active={active}
            highlight={highlight}
            onHighlightEnd={() => setHighlight(null)}
            playback={playback}
            isFilterActive={isFilterActive}
            onClearFilter={() => {
              setSearchQuery("");
              setSelectedRequester("all");
            }}
          />
        )}

        {message && <p className="form-message" role="alert">{message}</p>}
      </div>
    )}

    {/* 网易云全网点歌专属抽屉面板 */}
    <SongRequestDrawer
      isOpen={isDrawerOpen}
      onClose={() => setIsDrawerOpen(false)}
      roomId={roomId}
      active={active}
      isRequesting={isRequesting}
      operationStatusMessage={operationStatusMessage}
      onConfirmSongRequest={handleConfirmSongRequest}
      requestErrorMessage={requestErrorMessage}
      clearRequestErrorMessage={() => setRequestErrorMessage("")}
    />

    {/* 随机换一组抽选与替换弹窗 */}
    <RandomReplacementDialog
      open={isRandomDialogOpen}
      onOpenChange={setIsRandomDialogOpen}
      roomId={roomId}
      onReplacementStarted={opId => {
        setActiveReplacementOperationId(opId);
        setToast({
          id: uuidv7(),
          message: "换歌操作已提交，正在执行云端替换…",
          type: "info"
        });
      }}
    />

    {/* 轻量 Toast 正反馈提示 */}
    <Toast toast={toast} onDismiss={() => setToast(null)} />
  </>;
}
