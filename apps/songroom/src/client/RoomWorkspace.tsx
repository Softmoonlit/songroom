import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Bell, Music2, Settings, UserPlus, Users } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { v7 } from "uuid";
import { roomLeaveResult, roomMembersView, roomShellView, roomDeletionView, roomDeleteResult } from "../shared/room-contracts";
import { errorMessage, queryOptions, request, RoomRequestError } from "./room-http";
import { QueryError } from "./RoomQueryError";
import { roleLabels } from "./room-role-labels";
import { useVirtualKeyboard } from "./useVirtualKeyboard";
import { IdentityForm } from "./IdentityForm";
import { ApplicationsDrawer } from "./ApplicationsDrawer";
import { InviteDialog } from "./InviteDialog";
import { PublicPlaylistPane } from "./PublicPlaylistPane";
import { DestructiveConfirmDialog, type DestructiveBadge } from "./DestructiveConfirmDialog";
import { getMusicPlatform } from "./music-platforms";

function DeleteRoomDialog({
  sessionId,
  roomId,
  roomName,
  open,
  onOpenChange
}: {
  sessionId: string;
  roomId: string;
  roomName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleteError, setDeleteError] = useState("");

  const deletionQuery = useQuery({
    queryKey: ["room-deletion", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/deletion`, roomDeletionView, signal),
    enabled: open,
    ...queryOptions
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!deletionQuery.data) throw new Error("DELETION_NOT_READY");
      return request(`/${roomId}/delete`, roomDeleteResult, undefined, {
        idempotencyKey: v7(),
        version: deletionQuery.data.version
      });
    },
    retry: false,
    onSuccess: () => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["public-playlist-cleanups", sessionId] });
      void navigate("/rooms");
    },
    onError: async failure => {
      setDeleteError(errorMessage(failure));
      if (failure instanceof RoomRequestError && failure.code === "ROOM_VERSION_CONFLICT") {
        await deletionQuery.refetch();
      }
    }
  });

  const deletion = deletionQuery.data;

  const badges: DestructiveBadge[] = [
    { label: "不可撤销", variant: "danger" },
    { label: "立即生效", variant: "danger" },
    ...(deletion?.publicPlaylist ? [{ label: "云端歌单清理", variant: "danger" as const }] : [])
  ];

  return (
    <DestructiveConfirmDialog
      triggerText="删除房间"
      title="删除房间？"
      descriptionText={`确定要永久删除房间“${roomName}”吗？此操作不可撤销，所有成员将立即失去访问权限。`}
      badges={badges}
      confirmText="确认永久删除"
      pendingText="正在删除…"
      cancelText="取消"
      open={open}
      onOpenChange={next => {
        onOpenChange(next);
        if (next) setDeleteError("");
      }}
      onConfirm={() => deleteMutation.mutate()}
      isPending={deleteMutation.isPending}
      confirmDisabled={!deletion}
      error={deleteError}
    >
      {deletionQuery.isPending ? (
        <p role="status">正在读取最新影响范围…</p>
      ) : deletionQuery.isError ? (
        <p className="form-message" role="alert">读取影响范围失败，请稍后重试。</p>
      ) : deletion?.publicPlaylist ? (
        <p className="destructive-dialog-note">
          专用公共歌单“{deletion.publicPlaylist.name}”将启动网易云删除清理。
        </p>
      ) : null}
    </DestructiveConfirmDialog>
  );
}

export function RoomPage({ sessionId }: { sessionId: string }) {
  const { roomId } = useParams();
  return <RoomWorkspace key={`${sessionId}:${roomId}`} sessionId={sessionId} roomId={roomId!} />;
}
function RoomWorkspace({ sessionId, roomId }: { sessionId: string; roomId: string }) {
  const query = useQuery({
    queryKey: ["room-shell", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}`, roomShellView, signal),
    ...queryOptions
  });
  type RoomTab = "public" | "members" | "settings";
  const [active, setActive] = useState<RoomTab>("public");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scrollPositions = useRef<Record<RoomTab, number>>({ public: 0, members: 0, settings: 0 });
  const keyboardOpen = useVirtualKeyboard();

  const leaveMutation = useMutation({
    mutationFn: () => request(`/${roomId}/leave`, roomLeaveResult, undefined, { idempotencyKey: v7() }),
    retry: false,
    onSuccess: () => {
      setLeaveOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
      void navigate("/rooms");
    },
    onError: failure => {
      setLeaveError(errorMessage(failure));
    }
  });
  function selectTab(next: RoomTab) {
    if (next === active) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    scrollPositions.current[active] = window.scrollY;
    setActive(next);
  }
  useLayoutEffect(() => {
    window.scrollTo({ top: scrollPositions.current[active], behavior: "instant" });
  }, [active]);
  if (query.isPending) return <p role="status">正在读取房间…</p>;
  if (query.isError)
    return (
      <section className="rooms-page">
        <Link className="back-link" to="/rooms">
          <ArrowLeft size={16} aria-hidden="true" />
          返回房间列表
        </Link>
        <QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} />
      </section>
    );
  const room = query.data.room;
  return (
    <section className={`room-workspace${keyboardOpen ? " keyboard-open" : ""}`}>
      <aside className="room-context">
        <Link className="back-link" to="/rooms">
          <ArrowLeft size={16} aria-hidden="true" />
          返回房间列表
        </Link>
        <h1 className="room-title">{room.name}</h1>
        <div className="room-identity-meta">
          <p className="room-meta-pill">当前角色：{roleLabels[room.role]}</p>
          <p className="room-meta-pill">当前昵称：{room.nickname}</p>
        </div>
        <nav className="room-navigation" aria-label="房间导航">
          <button
            type="button"
            aria-current={active === "public" ? "page" : undefined}
            onClick={() => selectTab("public")}
          >
            <Music2 size={18} aria-hidden="true" />
            公共歌单
          </button>
          <button
            type="button"
            aria-label="房间成员"
            aria-current={active === "members" ? "page" : undefined}
            onClick={() => selectTab("members")}
          >
            <Users size={18} aria-hidden="true" />
            房间成员
            {query.data.allowedActions.includes("reviewApplications") && query.data.pendingCount !== null && query.data.pendingCount > 0 && <span className="pending-badge" aria-label={`待审批申请：${query.data.pendingCount}份`}>{query.data.pendingCount > 9 ? "9+" : query.data.pendingCount}</span>}
          </button>
          <button
            type="button"
            aria-current={active === "settings" ? "page" : undefined}
            onClick={() => selectTab("settings")}
          >
            <Settings size={18} aria-hidden="true" />
            房间设置
          </button>
        </nav>
      </aside>
      <div className="room-page-content">
        <section hidden={active !== "public"} aria-label="公共歌单">
          <PublicPlaylistPane sessionId={sessionId} roomId={roomId} active={active === "public"} />
        </section>
        <section hidden={active !== "members"} aria-label="房间成员">
          <MembersPane
            sessionId={sessionId}
            roomId={roomId}
            active={active === "members"}
            pendingCount={query.data.pendingCount}
          />
        </section>
        <section hidden={active !== "settings"} aria-label="房间设置" className="room-settings-pane">
          <div className="room-settings-header">
            <h2>房间设置</h2>
            <p className="room-settings-subtitle">管理房间基础属性、关联播放源与成员权限。</p>
          </div>

          <div className="room-settings-section">
            <div className="room-settings-section-header">
              <h3>基本信息</h3>
              <p>修改房间公开名称与你在该房间内显示的昵称。</p>
            </div>
            <div className="room-settings-cards">
              {query.data.allowedActions.includes("renameRoom") && (
                <IdentityForm sessionId={sessionId} roomId={roomId} field="name" current={room.name} disabledReason={query.data.disabledReasons.renameRoom} />
              )}
              {query.data.allowedActions.includes("renameNickname") && (
                <IdentityForm sessionId={sessionId} roomId={roomId} field="nickname" current={room.nickname} />
              )}
            </div>
          </div>

          <div className="room-settings-section">
            <div className="room-settings-section-header">
              <h3>关联平台账号</h3>
              <p>本房间的公共歌单与播放同步依赖房主授权的音乐平台。</p>
            </div>
            <div className="settings-card platform-linked-card">
              <div className="platform-linked-header">
                <div className="platform-title-wrap">
                  <span className="platform-icon" aria-hidden="true"><Music2 size={18} /></span>
                  <div className="platform-title-text">
                    <strong>{getMusicPlatform("netease").name}</strong>
                    <span className="platform-meta-tag">{room.role === "owner" ? "使用房主（本人）授权" : "使用房主授权"}</span>
                  </div>
                </div>
                <span className="platform-badge active">主播放源</span>
              </div>
              <p className="platform-linked-desc">
                房间的歌曲搜索、公共点歌与歌单快照均以此账号作为权威来源。如需管理或重新授权平台，请前往
                <Link className="text-link inline-link" to="/account">账号设置</Link>。
              </p>
            </div>
          </div>

          {(query.data.allowedActions.includes("leaveRoom") || query.data.allowedActions.includes("deleteRoom")) && (
            <div className="room-settings-section danger-zone-section">
              <div className="room-settings-section-header danger-header">
                <h3 className="danger-zone-heading">危险区域</h3>
                <p>下列操作为破坏性操作，执行后无法恢复，请谨慎操作。</p>
              </div>
              <div className="danger-zone-card">
                {query.data.allowedActions.includes("leaveRoom") && (
                  <div className="danger-action-row">
                    <div className="danger-action-info">
                      <strong>退出房间</strong>
                      <p>退出后将立即失去此房间访问与操作权限，清除本人点歌人标签并释放昵称。</p>
                    </div>
                    <div className="danger-action-trigger">
                      <DestructiveConfirmDialog
                        triggerText="退出房间"
                        title="退出房间？"
                        descriptionText={`确定要退出房间“${room.name}”吗？退出后将立即撤销你在该房间的所有访问与操作权限，并清除你的点歌人标签。`}
                        badges={[
                          { label: "权限立即撤销", variant: "danger" },
                          { label: "清除点歌标签", variant: "danger" },
                          { label: `释放昵称“${room.nickname}”`, variant: "neutral" }
                        ]}
                        confirmText="确认退出"
                        pendingText="正在退出…"
                        cancelText="取消"
                        open={leaveOpen}
                        onOpenChange={open => { setLeaveOpen(open); if (open) setLeaveError(""); }}
                        onConfirm={() => leaveMutation.mutate()}
                        isPending={leaveMutation.isPending}
                        error={leaveError}
                      />
                    </div>
                  </div>
                )}
                {query.data.allowedActions.includes("deleteRoom") && (
                  <div className="danger-action-row">
                    <div className="danger-action-info">
                      <strong>删除房间</strong>
                      <p>永久解散并删除此房间，所有成员将立即失去访问权限，同时启动专用公共歌单清理。</p>
                    </div>
                    <div className="danger-action-trigger">
                      <DeleteRoomDialog
                        sessionId={sessionId}
                        roomId={roomId}
                        roomName={room.name}
                        open={deleteOpen}
                        onOpenChange={setDeleteOpen}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
function MembersPane({
  sessionId,
  roomId,
  active,
  pendingCount
}: {
  sessionId: string;
  roomId: string;
  active: boolean;
  pendingCount: number | null;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["room-members", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/members`, roomMembersView, signal),
    enabled: active,
    ...queryOptions
  });
  const [memberId, setMemberId] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [applicationsDrawerOpen, setApplicationsDrawerOpen] = useState(false);
  const listScroll = useRef(0);
  const selected = query.data?.members.find(member => member.id === memberId);

  const removeMutation = useMutation({
    mutationFn: () => {
      if (!selected || !query.data) throw new Error("MEMBER_NOT_FOUND");
      return request(`/${roomId}/members/${selected.id}/remove`, roomMembersView, undefined, {
        idempotencyKey: v7(),
        version: query.data.version
      });
    },
    retry: false,
    onSuccess: data => {
      setRemoveOpen(false);
      setMemberId(null);
      queryClient.setQueryData(["room-members", sessionId, roomId], data);
      void queryClient.invalidateQueries({ queryKey: ["room-members", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-public-playlist", sessionId, roomId] });
    },
    onError: async failure => {
      setRemoveError(errorMessage(failure));
      if (failure instanceof RoomRequestError && failure.code === "ROOM_VERSION_CONFLICT") {
        await query.refetch();
      }
    }
  });
  useLayoutEffect(() => {
    if (active) window.scrollTo({ top: memberId ? 0 : listScroll.current, behavior: "instant" });
    // Switching primary entries restores the workspace scroll, not the member list scroll.
  }, [memberId]);
  if (query.isPending) return <p role="status">正在读取房间成员…</p>;
  if (query.isError)
    return <QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} />;
  if (selected)
    return (
      <section aria-label="成员详情">
        <nav className="member-detail-context" aria-label="成员详情导航">
          <button type="button" className="back-link text-button" onClick={() => setMemberId(null)}>
            <ArrowLeft size={17} aria-hidden="true" />
            返回成员列表
          </button>
          <span>{selected.nickname}</span>
        </nav>
        <h2>{selected.nickname}</h2>
        {selected.isSelf && selected.allowedActions.includes("renameNickname") && <IdentityForm sessionId={sessionId} roomId={roomId} field="nickname" current={selected.nickname} disabledReason={selected.disabledReasons.renameNickname} />}
        <dl className="netease-identity">
          <div>
            <dt>昵称</dt>
            <dd>{selected.nickname}</dd>
          </div>
          <div>
            <dt>角色</dt>
            <dd>{roleLabels[selected.role]}</dd>
          </div>
        </dl>
        {selected.allowedActions.includes("removeMember") && (
          <div className="member-remove-action">
            <DestructiveConfirmDialog
              triggerText="移除成员"
              title={`移除成员“${selected.nickname}”？`}
              descriptionText={`确定要将“${selected.nickname}”移出房间吗？移出后将立即撤销该成员的所有访问与操作权限，并清除其在公共歌单上的点歌人标签。`}
              badges={[
                { label: "权限立即撤销", variant: "danger" },
                { label: "清除点歌标签", variant: "danger" },
                { label: `释放昵称“${selected.nickname}”`, variant: "neutral" }
              ]}
              confirmText="确认移除"
              pendingText="正在移除…"
              cancelText="取消"
              open={removeOpen}
              onOpenChange={open => { setRemoveOpen(open); if (open) setRemoveError(""); }}
              onConfirm={() => removeMutation.mutate()}
              isPending={removeMutation.isPending}
              error={removeError}
            />
          </div>
        )}
      </section>
    );
  const canReview = query.data.allowedActions.includes("reviewApplications");
  const hasPending = pendingCount !== null && pendingCount > 0;

  return (
    <div className="members-pane-container">
      <div className="members-pane-header">
        <div className="members-pane-title-group">
          <h2>房间成员</h2>
          <span className="members-count-badge" aria-label={`共 ${query.data.members.length} 位成员`}>
            {query.data.members.length} 人
          </span>
        </div>
        <div className="members-header-actions">
          {canReview && !hasPending && (
            <button
              type="button"
              className="applications-trigger-btn secondary-action"
              onClick={() => setApplicationsDrawerOpen(true)}
              aria-label="审批加入申请"
            >
              审批申请
            </button>
          )}
          {query.data.allowedActions.includes("readInvite") && (
            <button
              type="button"
              className="invite-trigger-btn"
              onClick={() => setInviteOpen(true)}
              aria-label="邀请室友"
            >
              <UserPlus size={16} aria-hidden="true" />
              <span>+ 邀请室友</span>
            </button>
          )}
        </div>
      </div>

      {canReview && hasPending && (
        <aside className="pending-review-banner" aria-label="待审批申请提醒">
          <div className="pending-review-banner-left">
            <div className="pending-review-banner-icon" aria-hidden="true">
              <Bell size={18} />
              <span className="pending-banner-pulse" />
            </div>
            <div className="pending-review-banner-info">
              <span className="pending-review-banner-title">
                有 {pendingCount} 位室友申请加入房间
              </span>
              <span className="pending-review-banner-sub">
                审批通过后室友即可参与点歌
              </span>
            </div>
          </div>
          <button
            type="button"
            className="pending-review-banner-btn"
            aria-label="审批加入申请"
            onClick={() => setApplicationsDrawerOpen(true)}
          >
            处理申请
          </button>
        </aside>
      )}

      <ul className="member-list">
        {query.data.members.map(member => (
          <li key={member.id}>
            <button
              className="member-card"
              type="button"
              aria-label={`查看成员：${member.nickname}`}
              onClick={() => {
                listScroll.current = window.scrollY;
                setMemberId(member.id);
              }}
            >
              <div className="member-card-left">
                <span className="member-avatar" aria-hidden="true">
                  {member.nickname.slice(0, 1).toUpperCase()}
                </span>
                <span className="member-nickname-group">
                  <span className="member-nickname">{member.nickname}</span>
                  {member.isSelf && <span className="member-self-tag">（我）</span>}
                </span>
              </div>
              <span className={`status-pill role-${member.role}`}>
                {roleLabels[member.role]}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {active && (
        <>
          <InviteDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            sessionId={sessionId}
            roomId={roomId}
          />
          <ApplicationsDrawer
            open={applicationsDrawerOpen}
            onClose={() => setApplicationsDrawerOpen(false)}
            sessionId={sessionId}
            roomId={roomId}
          />
        </>
      )}
    </div>
  );
}
