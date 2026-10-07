import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Music2, Settings, Users } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { v7 } from "uuid";
import { roomLeaveResult, roomMembersView, roomShellView, roomDeletionView, roomDeleteResult } from "../shared/room-contracts";
import { errorMessage, queryOptions, request, RoomRequestError } from "./room-http";
import { QueryError } from "./RoomQueryError";
import { roleLabels } from "./room-role-labels";
import { useVirtualKeyboard } from "./useVirtualKeyboard";
import { IdentityForm } from "./IdentityForm";
import { ApplicationsPane } from "./ApplicationsPane";
import { InvitePane } from "./InvitePane";
import { PublicPlaylistPane } from "./PublicPlaylistPane";

interface DestructiveConfirmDialogProps {
  triggerText: string;
  title: string;
  descriptionText: string;
  consequences: string[];
  confirmText: string;
  pendingText: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending: boolean;
  error?: string;
}

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

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger asChild>
        <button className="danger-button" type="button">删除房间</button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="invite-dialog-overlay" />
        <AlertDialog.Content className="invite-dialog-content">
          <AlertDialog.Title>删除房间？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div>
              <p>确定要永久删除房间“{roomName}”吗？此操作不可撤销。</p>
              {deletionQuery.isPending ? (
                <p role="status">正在读取最新影响范围…</p>
              ) : deletionQuery.isError ? (
                <p className="form-message" role="alert">读取影响范围失败，请稍后重试。</p>
              ) : deletion ? (
                <>
                  <div className="deletion-impact-summary">
                    <p><strong>当前成员：</strong>{deletion.memberCount} 人</p>
                    <p><strong>待处理申请：</strong>{deletion.pendingApplicationCount} 份</p>
                    <p>
                      <strong>公共歌单：</strong>
                      {deletion.publicPlaylist
                        ? deletion.publicPlaylist.id
                          ? `专用歌单“${deletion.publicPlaylist.name}”（ID: ${deletion.publicPlaylist.id}），将启动网易云删除清理`
                          : `在途创建的公共歌单“${deletion.publicPlaylist.name}”，将停止创建并视情况启动云端清理`
                        : "无专用公共歌单，无需云端清理"}
                    </p>
                    <p className="version-tag">聚合版本：v{deletion.version}</p>
                  </div>
                  <ul className="leave-consequences">
                    <li>本地立即永久删除房间，所有设备与成员马上失去访问</li>
                    <li>彻底清除全部成员关系、昵称、邀请码及待审批申请</li>
                    <li>彻底清除全部点歌人标签及公共歌单绑定引用</li>
                    {deletion.publicPlaylist && (
                      <li>仅为该房间创建的专用公共歌单启动云端删除，不影响其他房间与账号</li>
                    )}
                    <li>房间不提供恢复入口，所有数据不可撤销</li>
                  </ul>
                </>
              ) : null}
            </div>
          </AlertDialog.Description>
          {deleteError && <p className="form-message" role="alert">{deleteError}</p>}
          <div className="invite-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button className="secondary-button" type="button" disabled={deleteMutation.isPending}>
                取消
              </button>
            </AlertDialog.Cancel>
            <button
              className="danger-button"
              type="button"
              disabled={deleteMutation.isPending || !deletion}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? "正在删除…" : "确认永久删除"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function DestructiveConfirmDialog({
  triggerText,
  title,
  descriptionText,
  consequences,
  confirmText,
  pendingText,
  open,
  onOpenChange,
  onConfirm,
  isPending,
  error
}: DestructiveConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger asChild>
        <button className="danger-button" type="button">{triggerText}</button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="invite-dialog-overlay" />
        <AlertDialog.Content className="invite-dialog-content">
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div>
              <p>{descriptionText}</p>
              <ul className="leave-consequences">
                {consequences.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          </AlertDialog.Description>
          {error && <p className="form-message" role="alert">{error}</p>}
          <div className="invite-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button className="secondary-button" type="button" disabled={isPending}>取消</button>
            </AlertDialog.Cancel>
            <button
              className="danger-button"
              type="button"
              disabled={isPending}
              onClick={onConfirm}
            >
              {isPending ? pendingText : confirmText}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
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
          <ArrowLeft size={17} aria-hidden="true" />
          返回房间列表
        </Link>
        <h1>{room.name}</h1>
        <p>当前角色：{roleLabels[room.role]}</p>
        <p>当前昵称：{room.nickname}</p>
        <nav className="room-navigation" aria-label="房间导航">
          <button
            type="button"
            aria-current={active === "public" ? "page" : undefined}
            onClick={() => selectTab("public")}
          >
            <Music2 size={20} aria-hidden="true" />
            公共歌单
          </button>
          <button
            type="button"
            aria-label="房间成员"
            aria-current={active === "members" ? "page" : undefined}
            onClick={() => selectTab("members")}
          >
            <Users size={20} aria-hidden="true" />
            房间成员
            {query.data.allowedActions.includes("reviewApplications") && query.data.pendingCount !== null && query.data.pendingCount > 0 && <span className="pending-badge" aria-label={`待审批申请：${query.data.pendingCount}份`}>{query.data.pendingCount > 9 ? "9+" : query.data.pendingCount}</span>}
          </button>
          <button
            type="button"
            aria-current={active === "settings" ? "page" : undefined}
            onClick={() => selectTab("settings")}
          >
            <Settings size={20} aria-hidden="true" />
            房间设置
          </button>
        </nav>
      </aside>
      <div className="room-page-content">
        <section hidden={active !== "public"} aria-label="公共歌单">
          <PublicPlaylistPane sessionId={sessionId} roomId={roomId} active={active === "public"} />
        </section>
        <section hidden={active !== "members"} aria-label="房间成员">
          <MembersPane sessionId={sessionId} roomId={roomId} active={active === "members"} />
        </section>
        <section hidden={active !== "settings"} aria-label="房间设置">
          <h2>房间设置</h2>
          {query.data.allowedActions.includes("renameRoom") && <IdentityForm sessionId={sessionId} roomId={roomId} field="name" current={room.name} disabledReason={query.data.disabledReasons.renameRoom} />}
          {query.data.allowedActions.includes("renameNickname") && <IdentityForm sessionId={sessionId} roomId={roomId} field="nickname" current={room.nickname} />}
          <dl className="netease-identity">
            <div>
              <dt>房间名称</dt>
              <dd>{room.name}</dd>
            </div>
            <div>
              <dt>我的房间昵称</dt>
              <dd>{room.nickname}</dd>
            </div>
            <div>
              <dt>当前角色</dt>
              <dd>{roleLabels[room.role]}</dd>
            </div>
          </dl>
          {query.data.allowedActions.includes("leaveRoom") && (
            <div className="room-leave-action">
              <DestructiveConfirmDialog
                triggerText="退出房间"
                title="退出房间？"
                descriptionText={`确定要退出房间“${room.name}”吗？`}
                consequences={[
                  "退出后立即撤销你在该房间的所有访问与操作权限",
                  `释放你的昵称“${room.nickname}”，供其他人使用`,
                  "清除你在当前公共歌单上的全部点歌人标签",
                  "公共歌单中的已有歌曲及其他成员的点歌人标签仍将保留"
                ]}
                confirmText="确认退出"
                pendingText="正在退出…"
                open={leaveOpen}
                onOpenChange={open => { setLeaveOpen(open); if (open) setLeaveError(""); }}
                onConfirm={() => leaveMutation.mutate()}
                isPending={leaveMutation.isPending}
                error={leaveError}
              />
            </div>
          )}
          {query.data.allowedActions.includes("deleteRoom") && (
            <div className="room-delete-action">
              <DeleteRoomDialog
                sessionId={sessionId}
                roomId={roomId}
                roomName={room.name}
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
              />
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
function MembersPane({ sessionId, roomId, active }: { sessionId: string; roomId: string; active: boolean }) {
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
  const listScroll = useRef(0);
  const [reviewing, setReviewing] = useState(false);
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
              descriptionText={`确定要将“${selected.nickname}”移出房间吗？`}
              consequences={[
                "立即撤销该成员在当前房间的所有访问与操作权限",
                `释放昵称“${selected.nickname}”，供新成员使用`,
                "清除该成员在当前公共歌单上的全部点歌人标签",
                "公共歌单中的已有歌曲及其他成员的点歌人标签仍将保留"
              ]}
              confirmText="确认移除"
              pendingText="正在移除…"
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
  return (
    <>
      <h2>房间成员</h2>
      {query.data.allowedActions.includes("reviewApplications") && <button className="secondary-button" type="button" aria-expanded={reviewing} onClick={() => setReviewing(value => !value)}>审批加入申请</button>}
      {active && reviewing && query.data.allowedActions.includes("reviewApplications") && <ApplicationsPane sessionId={sessionId} roomId={roomId} />}
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
              <span>
                {member.nickname}
                {member.isSelf && <span className="field-help">（我）</span>}
              </span>
              <span className="status-pill">{roleLabels[member.role]}</span>
            </button>
          </li>
        ))}
      </ul>
      {active && query.data.allowedActions.includes("readInvite") && <InvitePane sessionId={sessionId} roomId={roomId} />}
    </>
  );
}
