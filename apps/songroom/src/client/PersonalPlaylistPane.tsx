import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ListMusic, RotateCw } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import {
  personalPlaylistView,
  type PersonalPlaylistTrack,
  type PersonalPlaylistView
} from "../shared/personal-playlist-contracts.js";
import { errorMessage, errorMessageForCode, queryOptions, request } from "./room-http.js";
import { QueryError } from "./RoomQueryError.js";

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
  OPERATION_PENDING: "当前有正在处理的歌单创建操作，请稍候。"
};

function PersonalTrackList({ tracks, active }: { tracks: PersonalPlaylistTrack[]; active: boolean }) {
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

  return (
    <div className="playlist-tracks-wrapper">
      <div className="playlist-tracks-header-bar" role="region" aria-label="歌曲列表表头">
        <span className="tracks-header-col col-index">#</span>
        <span className="tracks-header-col col-title">歌曲与歌手</span>
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

  const query = useQuery({
    queryKey: ["room-personal-playlist", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/personal-playlist`, personalPlaylistView, signal),
    enabled: active,
    refetchInterval: q => {
      const op = q.state.data?.operation;
      return op && !terminalStatuses.has(op.status) ? 2_000 : false;
    },
    ...queryOptions
  });

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
      </div>

      <PersonalTrackList tracks={tracks} active={active} />
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
