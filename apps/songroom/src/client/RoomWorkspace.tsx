import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Music2, Settings, Users } from "lucide-react";
import { Link, useParams } from "react-router";
import { roomMembersView, roomShellView } from "../shared/room-contracts";
import { queryOptions, request } from "./room-http";
import { QueryError } from "./RoomQueryError";
import { roleLabels } from "./room-role-labels";
import { useVirtualKeyboard } from "./useVirtualKeyboard";
import { IdentityForm } from "./IdentityForm";
import { ApplicationsPane } from "./ApplicationsPane";
import { InvitePane } from "./InvitePane";

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
  const scrollPositions = useRef<Record<RoomTab, number>>({ public: 0, members: 0, settings: 0 });
  const keyboardOpen = useVirtualKeyboard();
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
          <h2>公共歌单</h2>
          <div className="empty-card">
            <Music2 size={27} aria-hidden="true" />
            <h3>尚未创建公共歌单</h3>
            <p>创建房间不会自动创建公共歌单。此房间目前没有公共歌曲。</p>
          </div>
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
        </section>
      </div>
    </section>
  );
}
function MembersPane({ sessionId, roomId, active }: { sessionId: string; roomId: string; active: boolean }) {
  const query = useQuery({
    queryKey: ["room-members", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/members`, roomMembersView, signal),
    enabled: active,
    ...queryOptions
  });
  const [memberId, setMemberId] = useState<string | null>(null);
  const listScroll = useRef(0);
  const [reviewing, setReviewing] = useState(false);
  const selected = query.data?.members.find(member => member.id === memberId);
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
