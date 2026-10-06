import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { v7 as uuidv7 } from "uuid";
import { joinApplicationView } from "../shared/invite-contracts";
import { InviteError } from "./InviteError";
import { inviteRequest } from "./invite-http";
import { queryOptions, RoomRequestError } from "./room-http";

const statusLabels = {
  pending: "等待房主审批", withdrawn: "申请已撤回", cancelled: "邀请已重置，申请已取消",
  approved: "申请已获批", rejected: "房主已拒绝申请", nickname_conflict: "拟用昵称已被占用，申请已终结，请重新提交"
};

export function ApplicationPage({ sessionId }: { sessionId: string }) {
  const { applicationId } = useParams();
  return <ApplicationDetails key={`${sessionId}:${applicationId}`} sessionId={sessionId} applicationId={applicationId!} />;
}

function ApplicationDetails({ sessionId, applicationId }: { sessionId: string; applicationId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["join-application", sessionId, applicationId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => inviteRequest(`/join-applications/${applicationId}`, joinApplicationView, signal), ...queryOptions });
  const [withdrawKey, setWithdrawKey] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (query.data) heading.current?.focus(); }, [query.data?.id, query.data?.status]);
  const mutation = useMutation({
    mutationFn: (idempotencyKey: string) => {
      controller.current = new AbortController();
      return inviteRequest(`/join-applications/${applicationId}/withdraw`, joinApplicationView, controller.current.signal, { idempotencyKey });
    },
    retry: false,
    onSuccess: application => {
      if (controller.current?.signal.aborted) return;
      queryClient.setQueryData(queryKey, application);
      void queryClient.invalidateQueries({ queryKey: ["join-applications", sessionId] });
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      if (failure instanceof RoomRequestError && ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_KEY_EXPIRED"].includes(failure.code)) setWithdrawKey(null);
      if (failure instanceof RoomRequestError && failure.code === "APPLICATION_NOT_PENDING") void query.refetch();
    }
  });
  function withdraw() {
    if (mutation.isPending || query.isFetching || !query.data?.allowedActions.includes("withdrawApplication")) return;
    const key = withdrawKey ?? uuidv7();
    setWithdrawKey(key);
    mutation.mutate(key);
  }
  return <section className="rooms-page" aria-labelledby="application-heading">
    <Link className="back-link" to="/rooms">返回房间列表</Link>
    {query.isPending ? <p role="status">正在读取加入申请…</p> : query.isError ? <InviteError error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /> : <>
      <div className="page-heading"><h1 id="application-heading" ref={heading} tabIndex={-1}>{query.data.room.name} 的加入申请</h1></div>
      <div className="settings-card room-create-form">
        <p>拟用昵称：{query.data.nickname}</p>
        <p className="application-status" role="status">{statusLabels[query.data.status]}</p>
        {query.data.status === "pending" && <p>申请获批前不能查看房间内容。返回房间列表不会授予房间权限。</p>}
        {query.data.status === "approved" && <Link className="text-link" to={`/rooms/${query.data.room.id}`}>进入获批房间</Link>}
        {query.data.allowedActions.includes("withdrawApplication") && <button className="secondary-button" type="button" disabled={mutation.isPending || query.isFetching} onClick={withdraw}>{mutation.isPending ? "撤回中…" : "撤回申请"}</button>}
        {query.data.status !== "pending" && query.data.status !== "approved" && <Link className="text-link" to="/join">使用当前邀请码重新申请</Link>}
        {mutation.isError && <InviteError error={mutation.error} />}
      </div>
    </>}
  </section>;
}
