import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { joinApplicationView, roomApplicationsView } from "../shared/invite-contracts";
import { InviteError } from "./InviteError";
import { queryOptions, request, RoomRequestError, errorMessage } from "./room-http";
import { invalidateRoomIdentity } from "./room-identity-queries";

type Decision = { applicationId: string; decision: "approve" | "reject"; idempotencyKey: string };
export function ApplicationsPane({ sessionId, roomId }: { sessionId: string; roomId: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["room-applications", sessionId, roomId], queryFn: ({ signal }) => request(`/${roomId}/applications`, roomApplicationsView, signal), ...queryOptions });
  const [feedback, setFeedback] = useState("");
  const [command, setCommand] = useState<Decision | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const mutation = useMutation({
    mutationFn: (value: Decision) => {
      controller.current = new AbortController();
      return request(`/${roomId}/applications/${value.applicationId}/decision`, joinApplicationView, controller.current.signal, { idempotencyKey: value.idempotencyKey, decision: value.decision });
    },
    retry: false,
    onSuccess: application => {
      if (controller.current?.signal.aborted) return;
      const results = { approved: `已批准：${application.nickname}`, rejected: `已拒绝：${application.nickname}`, nickname_conflict: `昵称已被占用：${application.nickname}；申请已终结，请申请人重新提交。` };
      setFeedback(application.status in results ? results[application.status as keyof typeof results] : "申请状态已变化，请查看最新待处理申请。");
      setCommand(null);
      void invalidateRoomIdentity(client, sessionId, roomId);
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      if (failure instanceof RoomRequestError) {
        setCommand(null);
        void invalidateRoomIdentity(client, sessionId, roomId);
      }
    }
  });
  function decide(applicationId: string, decision: Decision["decision"]) {
    if (mutation.isPending || query.isFetching) return;
    const application = query.data?.applications.find(item => item.id === applicationId);
    if (!query.data?.allowedActions.includes("reviewApplications") || !application?.allowedActions.includes(decision === "approve" ? "approveApplication" : "rejectApplication")) return;
    const next = command?.applicationId === applicationId && command.decision === decision ? command : { applicationId, decision, idempotencyKey: uuidv7() };
    setCommand(next);
    setFeedback("");
    mutation.mutate(next);
  }
  return <section className="settings-card" aria-label="加入申请审批">
    <h3>加入申请审批</h3>
    {feedback && <p role="status">{feedback}</p>}
    {query.isPending ? <p role="status">正在读取待处理申请…</p> : query.isError ? <InviteError error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /> : <>
      {Object.entries(query.data.disabledReasons).map(([action, reason]) => <p key={action} className="field-help">{errorMessage(new RoomRequestError(reason))}</p>)}
      {query.data.applications.length === 0 && <p>暂无待处理申请</p>}
      <ul className="application-review-list">{query.data.applications.map(application => <li key={application.id}>
        <p>{application.nickname}</p>
        <div className="invite-actions">{(["approve", "reject"] as const).map(decision => {
          const action = decision === "approve" ? "approveApplication" : "rejectApplication";
          return application.allowedActions.includes(action) && query.data.allowedActions.includes("reviewApplications") ? <button className="secondary-button" key={decision} type="button" disabled={mutation.isPending || query.isFetching} aria-label={`${decision === "approve" ? "批准" : "拒绝"}：${application.nickname}`} onClick={() => decide(application.id, decision)}>{decision === "approve" ? "批准" : "拒绝"}</button> : null;
        })}</div>
        {Object.entries(application.disabledReasons).map(([action, reason]) => <p key={action} className="field-help">{errorMessage(new RoomRequestError(reason))}</p>)}
      </li>)}</ul>
    </>}
    {mutation.isError && <InviteError error={mutation.error} />}
  </section>;
}
