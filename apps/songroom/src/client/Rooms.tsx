import { useQuery } from "@tanstack/react-query";
import { Music2 } from "lucide-react";
import { Link } from "react-router";
import { roomListView } from "../shared/room-contracts";
import { queryOptions, request } from "./room-http";
import { QueryError } from "./RoomQueryError";
import { roleLabels } from "./room-role-labels";

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
      <Link className="primary-button inline-button" to="/rooms/new">
        创建房间
      </Link>
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
              <Link
                className="secondary-button inline-button"
                to={`/rooms/${room.id}`}
                aria-label={`进入房间：${room.name}`}
              >
                进入房间
              </Link>
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
    </section>
  );
}
