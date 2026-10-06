import { useQuery } from "@tanstack/react-query";
import { Music2 } from "lucide-react";
import { Link } from "react-router";
import { roomListView } from "../shared/room-contracts";
import { queryOptions, request } from "./room-http";
import { QueryError } from "./RoomQueryError";
import { roleLabels } from "./room-role-labels";
import { joinApplicationList } from "../shared/invite-contracts";
import { inviteRequest } from "./invite-http";
import { InviteError } from "./InviteError";

export function RoomsPage({ sessionId, accountName }: { sessionId: string; accountName: string }) {
  const query = useQuery({
    queryKey: ["rooms", sessionId],
    queryFn: ({ signal }) => request("", roomListView, signal),
    ...queryOptions
  });
  return (
    <section className="rooms-page" aria-labelledby="rooms-heading">
      <div className="page-heading">
        <p className="eyebrow">
          <Music2 size={16} aria-hidden="true" />
          我的房间
        </p>
        <h1 id="rooms-heading">{accountName} 的房间</h1>
        <p>选择你创建或已加入的房间，和室友一起点歌。</p>
      </div>
      {query.isSuccess && query.data.allowedActions.includes("openCreateRoom") && <Link className="primary-button inline-button" to="/rooms/new">
        创建房间
      </Link>}
      {query.isSuccess && query.data.allowedActions.includes("openJoin") && <Link className="secondary-button inline-button" to="/join">通过邀请码申请加入</Link>}
      {query.isPending ? (
        <p role="status">正在读取房间列表…</p>
      ) : query.isError ? (
        <QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} />
      ) : query.data.rooms.length ? (
        <ul className="room-list">
          {query.data.rooms.map(room => (
            <li className="room-list-card" key={room.id}>
              <div>
                <h2>{room.name}</h2>
                <p>
                  {roleLabels[room.role]} · {room.nickname}
                </p>
              </div>
              {room.allowedActions.includes("enterRoom") && <Link
                className="secondary-button inline-button"
                to={`/rooms/${room.id}`}
                aria-label={`进入房间：${room.name}`}
              >
                进入房间
              </Link>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-card">
          <Music2 size={27} aria-hidden="true" />
          <h2>还没有房间</h2>
          <p>绑定网易云账号后可以创建自己的房间。</p>
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
  return <section className="pending-applications" aria-labelledby="pending-applications-heading">
    <h2 id="pending-applications-heading">待处理加入申请</h2>
    <p>等待房主批准后才能进入房间。</p>
    {query.isPending ? <p role="status">正在读取加入申请…</p> : query.isError ? <InviteError error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /> : query.data.applications.length ? <ul className="room-list">
      {query.data.applications.map(application => <li className="room-list-card" key={application.id}>
        <div><h3>{application.room.name}</h3><p>拟用昵称：{application.nickname} · 等待审批</p></div>
        <Link className="secondary-button inline-button" to={`/application/${application.id}`} aria-label={`查看申请：${application.room.name}`}>查看申请</Link>
      </li>)}
    </ul> : <p>暂无待处理加入申请。</p>}
  </section>;
}
