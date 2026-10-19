import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Info, ListMusic, Plus, RotateCw, Trash2 } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import {
  personalPlaylistView,
  personalSongRemoveResponse,
  type PersonalPlaylistTrack,
  type PersonalPlaylistView
} from "../shared/personal-playlist-contracts.js";
import {
  publicPlaylistView,
  songRequestOperationView,
  songRequestResponse
} from "../shared/public-playlist-contracts.js";
import { errorMessage, errorMessageForCode, queryOptions, request, RoomRequestError } from "./room-http.js";
import { QueryError } from "./RoomQueryError.js";
import { getFriendlyOperationStatusMessage, getFriendlySongRequestErrorMessage } from "./song-request-messages.js";
import { Toast, type ToastData } from "./Toast.js";

function getRefreshErrorMessage(code: string): string {
  switch (code) {
    case "MODULE_ERROR":
      return "网易云服务响应异常，请稍后刷新重试。";
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
    case "ACCOUNT_PAUSED":
      return "网易云账号已暂停，请联系管理员恢复。";
    case "TARGET_PERMISSION":
      return "该歌单已被设为私密或已删除。";
    default:
      return errorMessageForCode(code);
  }
}

const personalOperationMessages: Record<NonNullable<PersonalPlaylistView["operation"]>["status"], string> = {
  queued: "已排队，等待创建专用个人歌单。",
  processing: "正在创建专用个人歌单。",
  awaitingConfirmation: "创建结果待确认，可能已在网易云创建。请勿重复创建。",
  waitingAuthorization: "正在等待房主恢复网易云授权。",
  needsAdministrator: "创建结果未知，需要管理员处理。",
  succeeded: "专用个人歌单已创建并绑定。",
  failed: "创建明确失败，请重试。",
  stopped: "创建操作已停止。"
};

export function getPersonalOperationMessage(op: NonNullable<PersonalPlaylistView["operation"]>): string {
  if (op.step === "confirming") {
    if (op.recovered) {
      return "具体 ID 已恢复，正在核验并完成个人歌单关联。";
    }
    return "已获 ID 待关联，正在建立个人歌单绑定。";
  }
  if (op.step === "unknown" || op.status === "needsAdministrator") {
    return "创建结果未知，需要管理员处理。";
  }
  return personalOperationMessages[op.status];
}

const personalDisabledMessages: Record<NonNullable<PersonalPlaylistView["disabledReason"]>, string> = {
  NETEASE_AUTH_REQUIRED: "房主网易云授权不可用，请等待房主完成授权。",
  ACCOUNT_PAUSED: "房主网易云账号已暂停，请联系管理员核查。",
  TARGET_BLOCKED: "目标歌单已被设为私密或已删除。",
  PERSONAL_PLAYLIST_EXISTS: "当前已配置个人歌单。",
  OPERATION_PENDING: "当前有未完成的写操作，请稍候。"
};

function PersonalTrackList({
  tracks,
  active,
  onRequestSong,
  requestingSongId,
  songRequestDisabledReason,
  onRemoveSong,
  removingSongId,
  songRemovalDisabledReason
}: {
  tracks: PersonalPlaylistTrack[];
  active: boolean;
  onRequestSong?: (track: PersonalPlaylistTrack) => void;
  requestingSongId?: string | null;
  songRequestDisabledReason?: string | null;
  onRemoveSong?: (track: PersonalPlaylistTrack) => void;
  removingSongId?: string | null;
  songRemovalDisabledReason?: string | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const virtualizer = useWindowVirtualizer({
    count: tracks.length,
    estimateSize: () => (window.innerWidth <= 768 ? 84 : 60),
    getItemKey: index => `${tracks[index].songId}-${index}`,
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
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);

  const isRequestDisabled = Boolean(requestingSongId || songRequestDisabledReason);

  return (
    <div className="playlist-tracks-wrapper">
      <div className="playlist-tracks-header-bar" role="region" aria-label="歌曲列表表头">
        <span className="tracks-header-col col-index">#</span>
        <span className="tracks-header-col col-title">歌曲与歌手</span>
        {(onRequestSong || onRemoveSong) && <span className="tracks-header-col col-actions" style={{ textAlign: "right" }}>操作</span>}
      </div>
      {tracks.length === 0 ? (
        <div className="playlist-tracks-empty" role="status">
          <p>歌单内暂无歌曲</p>
        </div>
      ) : (
        <div
          ref={listRef}
          className="playlist-tracks-container"
          role="list"
          aria-label="歌曲列表"
          style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
        >
          {virtualizer.getVirtualItems().map(virtualRow => {
            const track = tracks[virtualRow.index];
            const isThisTrackRequesting = requestingSongId === track.songId;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                role="listitem"
                tabIndex={0}
                className="track-item"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`
                }}
              >
                <span className="track-index" aria-hidden="true">
                  {track.position + 1}
                </span>
                <div className="track-info">
                  <span className="track-name" title={track.name}>
                    {track.name}
                  </span>
                  <span
                    className="track-artists-album"
                    title={`${track.artists.join(" / ")}${track.album ? ` · ${track.album}` : ""}`}
                  >
                    {track.artists.join(" / ")}
                    {track.album && <span className="track-album"> · {track.album}</span>}
                  </span>
                </div>
                {(onRequestSong || onRemoveSong) && (
                  <div className="personal-track-actions">
                    {onRequestSong && <button
                      type="button"
                      className="secondary-button request-song-btn"
                      disabled={isRequestDisabled || Boolean(removingSongId)}
                      onClick={() => onRequestSong(track)}
                      aria-label={`点播《${track.name}》到公共歌单`}
                      title={songRequestDisabledReason ?? "点歌到公共歌单"}
                    >
                      <Plus size={14} aria-hidden="true" />
                      <span>{isThisTrackRequesting ? "点歌中…" : "点歌"}</span>
                    </button>}
                    {onRemoveSong && <button
                      type="button"
                      className="secondary-button personal-song-remove-btn"
                      disabled={Boolean(removingSongId || requestingSongId || songRemovalDisabledReason)}
                      onClick={() => onRemoveSong(track)}
                      aria-label={`从个人歌单删除《${track.name}》`}
                      title={songRemovalDisabledReason ?? "从个人歌单删除"}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      <span>{removingSongId === track.songId ? "删除中…" : "删除"}</span>
                    </button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const terminalStatuses = new Set(["succeeded", "failed", "stopped"]);

export function PersonalPlaylistPane({
  sessionId,
  roomId,
  active
}: {
  sessionId: string;
  roomId: string;
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const [createError, setCreateError] = useState("");
  const [requestingSongId, setRequestingSongId] = useState<string | null>(null);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [operationBanner, setOperationBanner] = useState<{ message: string; type: "info" | "warning" } | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [requestError, setRequestError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const contextKey = `${sessionId}:${roomId}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const handledRemoval = useRef<string | null>(null);
  useEffect(() => {
    setRemoveError("");
    setToast(null);
    handledRemoval.current = null;
  }, [contextKey]);

  const query = useQuery({
    queryKey: ["room-personal-playlist", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/personal-playlist`, personalPlaylistView, signal),
    enabled: active,
    refetchInterval: q => {
      const op = q.state.data?.operation;
      const songOp = q.state.data?.songOperation;
      return (op && !terminalStatuses.has(op.status)) || (songOp && !terminalStatuses.has(songOp.status)) ? 2_000 : false;
    },
    ...queryOptions
  });

  const publicQuery = useQuery({
    queryKey: ["room-public-playlist", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/public-playlist`, publicPlaylistView, signal),
    enabled: active,
    ...queryOptions
  });

  const hasPublicPlaylist = Boolean(publicQuery.data?.playlist);
  const publicDisabledReason = publicQuery.data?.disabledReason;

  // 轮询并监听异步点歌操作
  const operationQuery = useQuery({
    queryKey: ["song-request-operation", activeOperationId],
    queryFn: ({ signal }) => request(`/${roomId}/song-requests/${activeOperationId}`, songRequestOperationView, signal),
    enabled: Boolean(activeOperationId && active),
    refetchInterval: q => (q.state.data?.status && ["queued", "processing", "awaitingConfirmation"].includes(q.state.data.status) ? 2500 : false),
    ...queryOptions
  });

  useEffect(() => {
    if (!operationQuery.data) return;
    const op = operationQuery.data;
    switch (op.status) {
      case "succeeded":
        setActiveOperationId(null);
        setOperationBanner(null);
        setToast({
          id: uuidv7(),
          message: op.songConfirmed && !op.tagConfirmed
            ? `《${op.name}》网易云已确认，但点歌人标签待补记。`
            : `《${op.name}》点歌成功！已加入公共歌单并记录你的标签。`,
          type: "success"
        });
        void queryClient.invalidateQueries({ queryKey: ["room-public-playlist", sessionId, roomId] });
        break;
      case "awaitingConfirmation":
        setOperationBanner({
          message: op.songConfirmed && !op.tagConfirmed
            ? `《${op.name}》网易云已确认，但点歌人标签待补记。`
            : `《${op.name}》已发送至网易云，正在等待云端确认，请稍后刷新查看。`,
          type: "warning"
        });
        void queryClient.invalidateQueries({ queryKey: ["room-public-playlist", sessionId, roomId] });
        break;
      case "waitingAuthorization":
        setOperationBanner({
          message: "房主的网易云授权需要重新确认，正在等待房主恢复授权…",
          type: "warning"
        });
        break;
      case "needsAdministrator":
        setActiveOperationId(null);
        setOperationBanner(null);
        setRequestError("点歌操作需要管理员协助处理，请联系房主或管理员。");
        break;
      case "failed":
      case "stopped":
        setActiveOperationId(null);
        setOperationBanner(null);
        setRequestError(getFriendlySongRequestErrorMessage(op.errorCode));
        break;
      case "queued":
      case "processing":
        setOperationBanner({
          message: getFriendlyOperationStatusMessage(op.status, op.name),
          type: "info"
        });
        break;
    }
  }, [operationQuery.data, queryClient, sessionId, roomId]);

  const createMutation = useMutation({
    mutationFn: () => {
      setCreateError("");
      return request(`/${roomId}/personal-playlist/create`, personalPlaylistView, undefined, {
        idempotencyKey: uuidv7()
      });
    },
    retry: false,
    onSuccess: data => {
      queryClient.setQueryData(["room-personal-playlist", sessionId, roomId], data);
      void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
    },
    onError: failure => {
      setCreateError(errorMessage(failure));
    }
  });

  const refreshMutation = useMutation({
    mutationFn: () => request(`/${roomId}/personal-playlist/refresh`, personalPlaylistView),
    onSuccess: data => {
      queryClient.setQueryData(["room-personal-playlist", sessionId, roomId], data);
    }
  });

  const requestSongMutation = useMutation({
    mutationFn: async (track: PersonalPlaylistTrack) => {
      if (!query.data?.playlist?.id) return null;
      setRequestError("");
      setRequestingSongId(track.songId);
      return request(`/${roomId}/song-requests`, songRequestResponse, undefined, {
        idempotencyKey: uuidv7(),
        sourcePlaylistId: query.data.playlist.id,
        songId: track.songId,
        name: track.name,
        artists: track.artists,
        album: track.album
      });
    },
    onSuccess: (res, track) => {
      setRequestingSongId(null);
      if (!res) return;
      if (res.operation.status === "succeeded") {
        setToast({
          id: uuidv7(),
          message: `《${track.name}》已成功加入公共歌单并记录你的标签！`,
          type: "success"
        });
        void queryClient.invalidateQueries({ queryKey: ["room-public-playlist", sessionId, roomId] });
      } else if (res.operation.status === "failed" || res.operation.status === "stopped") {
        setActiveOperationId(null);
        setOperationBanner(null);
        setRequestError(getFriendlySongRequestErrorMessage(res.operation.errorCode));
      } else {
        setActiveOperationId(res.operation.id);
        setOperationBanner({
          message: getFriendlyOperationStatusMessage(res.operation.status, res.operation.name),
          type: "info"
        });
      }
    },
    onError: failure => {
      setRequestingSongId(null);
      const code = failure instanceof RoomRequestError ? failure.code : null;
      setRequestError(getFriendlySongRequestErrorMessage(code));
    }
  });

  const songOperation = query.data?.songOperation;
  const songOperationPending = Boolean(songOperation && !terminalStatuses.has(songOperation.status));
  const removeMutation = useMutation({
    mutationFn: ({ track, targetRoomId }: { track: PersonalPlaylistTrack; targetRoomId: string; context: string }) =>
      request(`/${targetRoomId}/personal-playlist/songs/remove`, personalSongRemoveResponse, undefined, {
        idempotencyKey: uuidv7(),
        songId: track.songId
      }),
    retry: false,
    onMutate: () => setRemoveError(""),
    onSuccess: (result, variables) => {
      if (currentContext.current !== variables.context) return;
      queryClient.setQueryData(["room-personal-playlist", sessionId, variables.targetRoomId], (previous: PersonalPlaylistView | undefined) =>
        previous ? { ...previous, songOperation: result.operation } : previous);
      void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, variables.targetRoomId] });
    },
    onError: (failure, variables) => {
      if (currentContext.current !== variables.context) return;
      setRemoveError(errorMessage(failure));
      void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, variables.targetRoomId] });
    }
  });

  useEffect(() => {
    if (!active || songOperation?.action !== "remove" || !terminalStatuses.has(songOperation.status)) return;
    const key = `${contextKey}:${songOperation.id}:${songOperation.version}`;
    if (handledRemoval.current === key) return;
    handledRemoval.current = key;
    if (songOperation.status === "succeeded") {
      setToast({ id: uuidv7(), message: `《${songOperation.name}》已从个人歌单删除`, type: "success" });
    } else {
      setRemoveError(songOperation.status === "stopped"
        ? "删除操作已停止，未确认的云端结果不会当作删除成功。"
        : `删除明确失败：${errorMessageForCode(songOperation.errorCode ?? "MODULE_ERROR")}`);
    }
  }, [active, contextKey, songOperation]);

  // 进入页面触发一次显式刷新
  const refreshedOnEnter = useRef<string | null>(null);
  useEffect(() => {
    const current = query.data;
    if (active && current?.playlist && current.allowedActions.includes("refreshPersonalPlaylist")) {
      const key = `${roomId}:${current.playlist.id}`;
      if (refreshedOnEnter.current !== key) {
        refreshedOnEnter.current = key;
        refreshMutation.mutate();
      }
    } else if (!active) {
      refreshedOnEnter.current = null;
    }
  }, [active, query.data?.playlist?.id, query.data?.allowedActions]);

  if (query.isPending) {
    return (
      <div className="personal-playlist-pane">
        <p role="status">正在读取个人歌单…</p>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="personal-playlist-pane">
        <QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} />
      </div>
    );
  }

  const data = query.data;
  const playlist = data.playlist;
  const canCreate = data.allowedActions.includes("createPersonalPlaylist");
  const canRefresh = data.allowedActions.includes("refreshPersonalPlaylist");

  if (!playlist) {
    return (
      <div className="personal-playlist-pane">
        <div className="empty-state">
          <ListMusic size={48} className="empty-state-icon" aria-hidden="true" />
          <h2 className="empty-state-title">尚未配置个人歌单</h2>
          <p className="empty-state-desc">
            在房主网易云账号下创建本房间专属于你的个人歌单，名称为 songroom-房间名-昵称。
          </p>

          {data.operation && data.operation.status !== "succeeded" && (
            <p className="netease-status" role="status">
              {getPersonalOperationMessage(data.operation)}
            </p>
          )}

          {data.operation?.errorCode && (
            <p className="field-help" role="alert">
              {errorMessageForCode(data.operation.errorCode)}
            </p>
          )}

          {data.disabledReason && (
            <p className="field-help">{personalDisabledMessages[data.disabledReason]}</p>
          )}

          {createError && (
            <div className="error-banner" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{createError}</span>
            </div>
          )}

          {canCreate && (
            <button
              type="button"
              className="primary-button"
              disabled={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "正在创建…" : "创建专用个人歌单"}
            </button>
          )}
        </div>
      </div>
    );
  }

  const tracks = data.snapshot?.tracks ?? [];
  const trackCount = data.snapshot?.trackCount ?? tracks.length;

  return (
    <div className="personal-playlist-pane">
      <div className="playlist-header">
        <div className="playlist-header-main">
          <div className="playlist-title-group">
            <h1 className="playlist-name">{playlist.name}</h1>
            <div className="playlist-badges">
              <span className="status-pill role-member">专用歌单</span>
              <span className="candidate-playlist-note">可维护</span>
            </div>
          </div>

          <div className="playlist-actions-row">
            {canRefresh && (
              <button
                type="button"
                className="secondary-button icon-button-text"
                title="同步歌单最新歌曲"
                aria-label="同步个人歌单"
                disabled={refreshMutation.isPending}
                onClick={() => refreshMutation.mutate()}
              >
                <RotateCw
                  size={16}
                  className={refreshMutation.isPending ? "spin-icon" : ""}
                  aria-hidden="true"
                />
                <span>{refreshMutation.isPending ? "正在同步…" : "同步歌单"}</span>
              </button>
            )}
          </div>
        </div>

        <div className="playlist-meta-bar">
          <span className="playlist-count-badge">共 {trackCount} 首歌曲</span>
          {data.snapshot?.syncedAt && (
            <span className="playlist-sync-time">
              同步于 {new Date(data.snapshot.syncedAt).toLocaleString("zh-CN", { hour12: false })}
            </span>
          )}
        </div>

        {data.lastRefreshError && (
          <div className="error-banner" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>
              刷新失败：{getRefreshErrorMessage(data.lastRefreshError)}。已保留当前歌单快照。
            </span>
          </div>
        )}

        {!hasPublicPlaylist && (
          <div className="info-banner" role="status" style={{ marginTop: "0.5rem" }}>
            <Info size={16} aria-hidden="true" />
            <span>房间尚未创建公共歌单，无法发起点歌。可在房主创建公共歌单后点歌。</span>
          </div>
        )}

        {operationBanner && (
          <div
            className={`operation-status-banner ${operationBanner.type}`}
            role="status"
            style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <RotateCw className="spin-icon" size={16} aria-hidden="true" />
            <span>{operationBanner.message}</span>
          </div>
        )}

        {songOperationPending && songOperation?.action === "remove" && (
          <div className="operation-status-banner warning" role="status">
            {songOperation.status === "queued"
              ? `《${songOperation.name}》删除已排队。`
              : songOperation.status === "processing"
                ? `正在从个人歌单删除《${songOperation.name}》并确认结果…`
                : songOperation.status === "awaitingConfirmation"
                  ? `《${songOperation.name}》删除结果待确认，请勿重复删除。可同步歌单继续确认。`
                  : songOperation.status === "waitingAuthorization"
                    ? "删除操作正在等待房主恢复网易云授权。"
                    : "删除结果需要管理员协助确认。"}
          </div>
        )}

        {removeError && (
          <div className="error-banner" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{removeError}</span>
          </div>
        )}

        {requestError && (
          <div className="error-banner" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{requestError}</span>
          </div>
        )}
      </div>

      <PersonalTrackList
        tracks={tracks}
        active={active}
        onRequestSong={track => requestSongMutation.mutate(track)}
        requestingSongId={requestingSongId}
        onRemoveSong={track => removeMutation.mutate({ track, targetRoomId: roomId, context: contextKey })}
        removingSongId={removeMutation.isPending ? removeMutation.variables.track.songId : null}
        songRemovalDisabledReason={
          songOperationPending || activeOperationId
            ? "当前有未完成的写操作，请稍候"
            : !data.allowedActions.includes("removePersonalSong")
              ? data.disabledReason ? personalDisabledMessages[data.disabledReason] : "当前无法删除歌曲，请同步歌单后重试"
              : null
        }
        songRequestDisabledReason={
          songOperationPending || removeMutation.isPending
            ? "当前有未完成的个人歌单操作，请稍候"
            : !hasPublicPlaylist
            ? "房间尚未创建公共歌单，无法发起点歌"
            : publicDisabledReason === "ACCOUNT_PAUSED"
              ? "网易云账号已暂停，暂时无法点歌"
              : publicDisabledReason === "TARGET_BLOCKED"
                ? "公共歌单待确认，暂时无法点歌"
                : activeOperationId
                  ? "已有正在处理中的点歌操作，请稍候"
                  : null
        }
      />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export function MemberPersonalPlaylistSection({
  sessionId,
  roomId,
  memberId,
  active
}: {
  sessionId: string;
  roomId: string;
  memberId: string;
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["member-personal-playlist", sessionId, roomId, memberId],
    queryFn: ({ signal }) => request(`/${roomId}/members/${memberId}/personal-playlist`, personalPlaylistView, signal),
    enabled: active,
    ...queryOptions
  });

  const refreshMutation = useMutation({
    mutationFn: () => request(`/${roomId}/members/${memberId}/personal-playlist/refresh`, personalPlaylistView),
    onSuccess: data => {
      queryClient.setQueryData(["member-personal-playlist", sessionId, roomId, memberId], data);
    }
  });

  const refreshedOnEnter = useRef<string | null>(null);
  useEffect(() => {
    const current = query.data;
    if (active && current?.playlist) {
      const key = `${roomId}:${memberId}:${current.playlist.id}`;
      if (refreshedOnEnter.current !== key) {
        refreshedOnEnter.current = key;
        refreshMutation.mutate();
      }
    } else if (!active) {
      refreshedOnEnter.current = null;
    }
  }, [active, memberId, query.data?.playlist?.id]);

  if (query.isPending) return <p role="status">正在读取成员个人歌单…</p>;
  if (query.isError) return null;

  const data = query.data;
  if (!data?.playlist) {
    return (
      <div className="room-settings-section">
        <div className="room-settings-section-header">
          <h2>个人歌单</h2>
        </div>
        <p className="empty-hint">未配置个人歌单</p>
      </div>
    );
  }

  const tracks = data.snapshot?.tracks ?? [];
  return (
    <div className="room-settings-section">
      <div className="room-settings-section-header">
        <h2>个人歌单</h2>
      </div>
      <dl className="settings-card netease-identity">
        <div>
          <dt>歌单名称</dt>
          <dd>{data.playlist.name}</dd>
        </div>
        <div>
          <dt>来源属性</dt>
          <dd>专用（仅本人可维护）</dd>
        </div>
        <div>
          <dt>歌曲数</dt>
          <dd>{data.snapshot?.trackCount ?? tracks.length} 首</dd>
        </div>
        {data.snapshot?.syncedAt && (
          <div>
            <dt>快照时间</dt>
            <dd>{new Date(data.snapshot.syncedAt).toLocaleString("zh-CN", { hour12: false })}</dd>
          </div>
        )}
      </dl>

      {tracks.length > 0 && (
        <div className="member-playlist-tracks-preview">
          <PersonalTrackList tracks={tracks} active={active} />
        </div>
      )}
    </div>
  );
}
