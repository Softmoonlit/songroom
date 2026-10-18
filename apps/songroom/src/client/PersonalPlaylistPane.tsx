import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AlertCircle, ListMusic, RotateCw, X } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import {
  personalPlaylistCandidatesView,
  personalPlaylistView,
  type PersonalPlaylistCandidate,
  type PersonalPlaylistTrack,
  type PersonalPlaylistView
} from "../shared/personal-playlist-contracts.js";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog.js";
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
  NOT_OWNER: "只有房主可配置自建或收藏歌单。",
  ROOMMATE_ONLY: "房主请绑定已有或收藏歌单，不能创建专用个人歌单。",
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
    <div className="playlist-tracks-wrapper" ref={listRef}>
      <div className="playlist-tracks-header-bar" role="region" aria-label="歌曲列表表头">
        <span className="tracks-header-col col-index">#</span>
        <span className="tracks-header-col col-title">歌曲与歌手</span>
        <span className="tracks-header-col col-requester">专辑</span>
      </div>
      {tracks.length === 0 ? (
        <div className="playlist-tracks-empty" role="status">
          <p>歌单内暂无歌曲</p>
        </div>
      ) : (
        <div
          className="playlist-tracks-virtual-container"
          style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
        >
          {virtualizer.getVirtualItems().map(virtualRow => {
            const track = tracks[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                className="playlist-track-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <div className="track-col col-index" aria-label={`序号 ${track.position + 1}`}>
                  {track.position + 1}
                </div>
                <div className="track-col col-title">
                  <span className="track-name">{track.name}</span>
                  <span className="track-artists">{track.artists.join(" / ")}</span>
                </div>
                <div className="track-col col-requester">
                  <span className="track-album-name">{track.album || "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PersonalPlaylistBindDialog({
  open,
  onOpenChange,
  sessionId,
  roomId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  roomId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bindError, setBindError] = useState("");

  const candidatesQuery = useQuery({
    queryKey: ["room-personal-playlist-candidates", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/personal-playlist/candidates`, personalPlaylistCandidatesView, signal),
    enabled: open,
    ...queryOptions
  });

  const bindMutation = useMutation({
    mutationFn: (playlistId: string) => {
      return request(`/${roomId}/personal-playlist/bind`, personalPlaylistView, undefined, {
        idempotencyKey: uuidv7(),
        playlistId
      });
    },
    retry: false,
    onSuccess: data => {
      queryClient.setQueryData(["room-personal-playlist", sessionId, roomId], data);
      void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
      onOpenChange(false);
    },
    onError: failure => {
      setBindError(errorMessage(failure));
    }
  });

  const candidates = candidatesQuery.data?.candidates ?? [];

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="invite-modal" aria-describedby="bind-playlist-desc">
          <div className="invite-modal-header">
            <div>
              <AlertDialog.Title className="invite-modal-title">绑定个人歌单</AlertDialog.Title>
              <AlertDialog.Description id="bind-playlist-desc" className="invite-modal-desc">
                从你网易云账号已创建或收藏的歌单中选择一个作为当前房间的个人歌单来源。
              </AlertDialog.Description>
            </div>
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="invite-modal-close"
                aria-label="关闭绑定窗口"
                disabled={bindMutation.isPending}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </AlertDialog.Cancel>
          </div>

          <div className="invite-modal-body">
            {bindError && (
              <div className="error-banner" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{bindError}</span>
              </div>
            )}

            {candidatesQuery.isPending ? (
              <p role="status">正在读取网易云歌单清单…</p>
            ) : candidatesQuery.isError ? (
              <QueryError
                error={candidatesQuery.error}
                retrying={candidatesQuery.isFetching}
                retry={() => void candidatesQuery.refetch()}
              />
            ) : candidates.length === 0 ? (
              <p className="empty-hint" role="status">
                暂无可绑定的歌单。请先在网易云音乐中创建歌单或收藏歌单。
              </p>
            ) : (
              <div className="candidate-playlist-list" role="radiogroup" aria-label="候选歌单列表">
                {candidates.map(c => {
                  const isSelected = selectedId === c.id;
                  return (
                    <label
                      key={c.id}
                      className={`candidate-playlist-item ${isSelected ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="personal-playlist-candidate"
                        value={c.id}
                        checked={isSelected}
                        onChange={() => {
                          setSelectedId(c.id);
                          setBindError("");
                        }}
                      />
                      <div className="candidate-playlist-info">
                        <span className="candidate-playlist-name">{c.name}</span>
                        <div className="candidate-playlist-tags">
                          <span className={`status-pill ${c.type === "ownerCreated" ? "role-owner" : "role-member"}`}>
                            {c.type === "ownerCreated" ? "自建" : "收藏"}
                          </span>
                          <span className="candidate-playlist-note">
                            {c.writeable ? "可维护" : "只读"}
                          </span>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="modal-actions">
            <AlertDialog.Cancel asChild>
              <button type="button" className="secondary-button" disabled={bindMutation.isPending}>
                取消
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className="primary-button"
              disabled={!selectedId || bindMutation.isPending}
              onClick={() => {
                if (selectedId) bindMutation.mutate(selectedId);
              }}
            >
              {bindMutation.isPending ? "正在绑定…" : "确认绑定"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

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
  const [bindDialogOpen, setBindDialogOpen] = useState(false);
  const [unbindDialogOpen, setUnbindDialogOpen] = useState(false);
  const [unbindError, setUnbindError] = useState("");
  const [createError, setCreateError] = useState("");

  const query = useQuery({
    queryKey: ["room-personal-playlist", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/personal-playlist`, personalPlaylistView, signal),
    enabled: active,
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

  const unbindMutation = useMutation({
    mutationFn: () => {
      return request(`/${roomId}/personal-playlist/unbind`, personalPlaylistView, undefined, {
        idempotencyKey: uuidv7()
      });
    },
    retry: false,
    onSuccess: data => {
      setUnbindDialogOpen(false);
      queryClient.setQueryData(["room-personal-playlist", sessionId, roomId], data);
      void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
    },
    onError: failure => {
      setUnbindError(errorMessage(failure));
    }
  });

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
  const canBind = data.allowedActions.includes("bindPersonalPlaylist");
  const canCreate = data.allowedActions.includes("createPersonalPlaylist");
  const canUnbind = data.allowedActions.includes("unbindPersonalPlaylist");
  const canRefresh = data.allowedActions.includes("refreshPersonalPlaylist");

  if (!playlist) {
    return (
      <div className="personal-playlist-pane">
        <div className="empty-state">
          <ListMusic size={48} className="empty-state-icon" aria-hidden="true" />
          <h2 className="empty-state-title">尚未配置个人歌单</h2>
          <p className="empty-state-desc">
            {canBind
              ? "绑定网易云已创建或收藏的歌单作为个人歌单来源。个人歌单为可选配置，不影响你直接搜索点歌。"
              : canCreate
              ? "在房主网易云账号下创建专属于你的个人歌单，名称为 songroom-房间名-昵称。个人歌单为可选配置，不影响你直接搜索点歌。"
              : "当前未配置个人歌单。个人歌单为可选配置，不影响你直接搜索点歌。"}
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

          {canBind && (
            <button
              type="button"
              className="primary-button"
              onClick={() => setBindDialogOpen(true)}
            >
              绑定个人歌单
            </button>
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
        {bindDialogOpen && (
          <PersonalPlaylistBindDialog
            open={bindDialogOpen}
            onOpenChange={setBindDialogOpen}
            sessionId={sessionId}
            roomId={roomId}
          />
        )}
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
              <span className={`status-pill ${playlist.type === "ownerCreated" ? "role-owner" : "role-member"}`}>
                {playlist.type === "ownerCreated" ? "自建歌单" : playlist.type === "roommateDedicated" ? "专用歌单" : "收藏歌单"}
              </span>
              <span className="candidate-playlist-note">
                {playlist.writeable ? "可维护" : "只读"}
              </span>
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

            {canBind && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setBindDialogOpen(true)}
              >
                更换歌单
              </button>
            )}

            {canUnbind && (
              <button
                type="button"
                className="danger-button text-button"
                onClick={() => setUnbindDialogOpen(true)}
              >
                解除绑定
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

      {bindDialogOpen && (
        <PersonalPlaylistBindDialog
          open={bindDialogOpen}
          onOpenChange={setBindDialogOpen}
          sessionId={sessionId}
          roomId={roomId}
        />
      )}

      {unbindDialogOpen && (
        <DestructiveConfirmDialog
          open={unbindDialogOpen}
          onOpenChange={open => {
            setUnbindDialogOpen(open);
            if (open) setUnbindError("");
          }}
          title={`解绑歌单“${playlist.name}”？`}
          descriptionText={`确定要解除当前房间与歌单“${playlist.name}”的绑定吗？解绑后仅移除该房间配置，不会删除网易云上的歌单或取消收藏，其他房间的绑定也不受影响。`}
          badges={[
            { label: "不删除云端歌单", variant: "neutral" },
            { label: "仅解绑当前房间", variant: "neutral" }
          ]}
          confirmText="确认解绑"
          pendingText="正在解绑…"
          cancelText="取消"
          onConfirm={() => unbindMutation.mutate()}
          isPending={unbindMutation.isPending}
          error={unbindError}
        />
      )}
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
          <dd>
            {data.playlist.type === "ownerCreated" ? "自建（可维护）" : data.playlist.type === "roommateDedicated" ? "专用（可维护）" : "收藏（只读）"}
          </dd>
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
