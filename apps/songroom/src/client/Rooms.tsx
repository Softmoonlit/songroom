import { useQuery } from "@tanstack/react-query";
import { LogIn, Music2, Plus } from "lucide-react";
import { Link } from "react-router";
import { roomListView, publicPlaylistCleanupList, type PublicPlaylistCleanupStatus } from "../shared/room-contracts";
import { queryOptions, request, cleanupRequest } from "./room-http";
import { QueryError } from "./RoomQueryError";
import { roleLabels } from "./room-role-labels";
import { joinApplicationList } from "../shared/invite-contracts";
import { inviteRequest } from "./invite-http";
import { InviteError } from "./InviteError";

const cleanupStatusPresentation: Record<PublicPlaylistCleanupStatus, { label: string; badgeClass: string; nextStep: string }> = {
  succeeded: {
    label: "已完成删除",
    badgeClass: "status-badge success",
    nextStep: "专用公共歌单已在网易云成功删除，清理已完成。"
  },
  waitingAuthorization: {
    label: "等待重新授权",
    badgeClass: "status-badge warning",
    nextStep: "原网易云账号授权已失效，请前往账号设置重新授权以继续云端清理。"
  },
  awaitingConfirmation: {
    label: "结果待确认",
    badgeClass: "status-badge warning",
    nextStep: "删除请求已发出，系统正在核查云端状态，无需重复操作。"
  },
  needsAdministrator: {
    label: "需管理员处理",
    badgeClass: "status-badge danger",
    nextStep: "删除被上游拒绝或遇到异常，请联系系统管理员核查。"
  },
  ready: {
    label: "正在清理…",
    badgeClass: "status-badge info",
    nextStep: "系统正在调度执行网易云删除请求，请稍候。"
  },
  sending: {
    label: "正在清理…",
    badgeClass: "status-badge info",
    nextStep: "系统正在调度执行网易云删除请求，请稍候。"
  }
};

export function getCleanupPresentation(item: { status: PublicPlaylistCleanupStatus; lastErrorCode?: string | null }) {
  if (item.status === "needsAdministrator" && item.lastErrorCode === "TARGET_PERMISSION") {
    return {
      label: "需官方客户端处理",
      badgeClass: "status-badge danger",
      nextStep: "网易云已拒绝删除该歌单，请在原账号网易云官方客户端手工删除该歌单，后续由系统管理员核验完成。"
    };
  }
  return cleanupStatusPresentation[item.status];
}

export function RoomsPage({ sessionId, accountName }: { sessionId: string; accountName: string }) {
  const query = useQuery({
    queryKey: ["rooms", sessionId],
    queryFn: ({ signal }) => request("", roomListView, signal),
    ...queryOptions
  });

  return (
    <section className="rooms-page" aria-labelledby="rooms-heading">
      <div className="rooms-header">
        <div className="page-heading">
          <p className="eyebrow">
            <Music2 size={16} aria-hidden="true" />
            我的房间
          </p>
          <h1 id="rooms-heading">{accountName} 的房间</h1>
          <p>选择你创建或已加入的房间，和室友一起点歌。</p>
        </div>
        {query.isSuccess && (query.data.allowedActions.includes("openCreateRoom") || query.data.allowedActions.includes("openJoin")) && (
          <div className="rooms-toolbar" role="toolbar" aria-label="房间操作">
            {query.data.allowedActions.includes("openCreateRoom") && (
              <Link className="primary-button inline-button" to="/rooms/new">
                <Plus size={16} aria-hidden="true" />
                创建房间
              </Link>
            )}
            {query.data.allowedActions.includes("openJoin") && (
              <Link className="secondary-button inline-button" to="/join">
                <LogIn size={16} aria-hidden="true" />
                输入邀请码加入
              </Link>
            )}
          </div>
        )}
      </div>

      {query.isPending ? (
        <p role="status">正在读取房间列表…</p>
      ) : query.isError ? (
        <QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} />
      ) : query.data.rooms.length ? (
        <ul className="room-list">
          {query.data.rooms.map(room => (
            <li className="room-list-card" key={room.id}>
              <div className="room-card-info">
                <h2>{room.name}</h2>
                <div className="room-card-meta">
                  <span className={`role-badge role-${room.role}`}>
                    {roleLabels[room.role]}
                  </span>
                  <span className="room-card-nickname">我的昵称：{room.nickname}</span>
                  {room.authorizationStatus === "waitingAuthorization" ? (
                    <span className="status-badge warning" role="status">
                      授权失效
                    </span>
                  ) : (
                    <span className="status-badge success">
                      正常运行
                    </span>
                  )}
                </div>
                {room.authorizationStatus === "waitingAuthorization" && (
                  <p className="room-auth-warning" role="status">
                    网易云授权已退出，等待房主重新授权
                  </p>
                )}
              </div>
              {room.allowedActions.includes("enterRoom") && (
                <Link
                  className="secondary-button inline-button"
                  to={`/rooms/${room.id}`}
                  aria-label={`进入房间：${room.name}`}
                >
                  进入房间
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rooms-empty-state">
          <div className="empty-header">
            <div className="empty-icon-wrap" aria-hidden="true">
              <Music2 size={30} />
            </div>
            <h2>还没有房间</h2>
            <p>你可以作为房主创建新房间，也可以作为室友凭邀请码加入已有房间。</p>
          </div>
          <div className="onboarding-grid">
            <div className="onboarding-card owner-track">
              <div className="onboarding-card-header">
                <span className="track-badge owner">我是房主</span>
                <h3>创建新房间</h3>
              </div>
              <p className="onboarding-desc">
                创建专属宿舍点歌台，绑定音乐账号后即可自动同步公共歌单并邀请室友。
              </p>
              {query.data.allowedActions.includes("openCreateRoom") && (
                <div className="onboarding-action-group">
                  <Link className="primary-button onboarding-action" to="/rooms/new">
                    <Plus size={16} aria-hidden="true" />
                    创建我的房间
                  </Link>
                  <p className="onboarding-hint">
                    未绑定音乐平台？
                    <Link to="/account" className="text-link">前往账号设置授权</Link>
                  </p>
                </div>
              )}
            </div>

            <div className="onboarding-card roommate-track">
              <div className="onboarding-card-header">
                <span className="track-badge roommate">我是室友</span>
                <span className="exempt-badge">无需绑定音乐账号</span>
                <h3>加入已有房间</h3>
              </div>
              <p className="onboarding-desc">
                收到房主分享的邀请码？直接申请加入，随时随地向公共歌单点歌。
              </p>
              {query.data.allowedActions.includes("openJoin") && (
                <Link className="secondary-button onboarding-action" to="/join">
                  <LogIn size={16} aria-hidden="true" />
                  加入已有房间
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
      <PendingApplications sessionId={sessionId} />
    </section>
  );
}

function PendingApplications({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: ["join-applications", sessionId],
    queryFn: ({ signal }) => inviteRequest("/join-applications", joinApplicationList, signal),
    ...queryOptions
  });

  if (query.data && query.data.applications.length === 0) {
    return null;
  }

  return (
    <section className="pending-applications" aria-labelledby="pending-applications-heading">
      <h2 id="pending-applications-heading">待处理加入申请</h2>
      <p>等待房主批准后才能进入房间。</p>
      {query.isPending ? (
        <p role="status">正在读取加入申请…</p>
      ) : query.isError ? (
        <InviteError error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />
      ) : (
        <ul className="room-list">
          {query.data.applications.map(application => (
            <li className="room-list-card" key={application.id}>
              <div className="room-card-info">
                <h3>{application.room.name}</h3>
                <p>拟用昵称：{application.nickname} · 等待审批</p>
              </div>
              <Link
                className="secondary-button inline-button"
                to={`/application/${application.id}`}
                aria-label={`查看申请：${application.room.name}`}
              >
                查看申请
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PublicPlaylistCleanups({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: ["public-playlist-cleanups", sessionId],
    queryFn: ({ signal }) => cleanupRequest("/public-playlists", publicPlaylistCleanupList, signal),
    ...queryOptions
  });

  if (!query.data || query.data.cleanups.length === 0) return null;

  return (
    <section className="public-playlist-cleanups" aria-labelledby="cleanups-heading">
      <div className="cleanups-heading-wrap">
        <p className="eyebrow">高级设置</p>
        <h2 id="cleanups-heading">公共歌单清理</h2>
      </div>
      <p>已删除房间专用公共歌单的网易云清理进度（与已删除房间分离，房间不可恢复）。</p>
      <ul className="cleanup-list">
        {query.data.cleanups.map(item => {
          const presentation = getCleanupPresentation(item);
          return (
            <li className="cleanup-card" key={item.id}>
              <div>
                <h3>网易云歌单 ID：{item.playlistId}</h3>
                <p className="cleanup-status">
                  <strong>状态：</strong>
                  <span className={presentation.badgeClass}>{presentation.label}</span>
                </p>
                <p className="cleanup-next-step">
                  <strong>下一步：</strong>
                  {presentation.nextStep}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
