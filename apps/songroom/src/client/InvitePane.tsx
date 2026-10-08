import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { inviteView, type InviteResetCommand, type InviteView } from "../shared/invite-contracts";
import { InviteError } from "./InviteError";
import { inviteErrorMessage, inviteRequest } from "./invite-http";
import { queryOptions, RoomRequestError } from "./room-http";

export function InvitePane({ sessionId, roomId }: { sessionId: string; roomId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["room-invite", sessionId, roomId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => inviteRequest(`/rooms/${roomId}/invite`, inviteView, signal), ...queryOptions });
  const [copyFeedback, setCopyFeedback] = useState<{ text: string; failed: boolean } | null>(null);
  const [resetFeedback, setResetFeedback] = useState("");
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<InviteView | null>(null);
  const [dialogMessage, setDialogMessage] = useState("");
  const [lastCommand, setLastCommand] = useState<InviteResetCommand | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  async function loadConfirmation() {
    setConfirmation(null);
    try {
      const result = await query.refetch({ throwOnError: true });
      if (mounted.current && result.data) setConfirmation(result.data);
    } catch (failure) {
      if (mounted.current) setDialogMessage(inviteErrorMessage(failure));
    }
  }
  const mutation = useMutation({
    mutationFn: (command: InviteResetCommand) => {
      controller.current = new AbortController();
      return inviteRequest(`/rooms/${roomId}/invite/reset`, inviteView, controller.current.signal, command);
    },
    retry: false,
    onSuccess: view => {
      if (controller.current?.signal.aborted) return;
      queryClient.setQueryData(queryKey, view);
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-applications", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-members", sessionId, roomId] });
      setCopyFeedback(null);
      setResetFeedback("邀请已重置，旧邀请码和链接已失效，旧邀请的待处理申请已取消。");
      setOpen(false);
      setLastCommand(null);
    },
    onError: async failure => {
      if (controller.current?.signal.aborted) return;
      setDialogMessage(inviteErrorMessage(failure));
      if (failure instanceof RoomRequestError && ["INVITE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_KEY_EXPIRED"].includes(failure.code)) {
        setLastCommand(null);
        await loadConfirmation();
      }
      if (failure instanceof RoomRequestError && ["INVITE_FORBIDDEN", "SESSION_REQUIRED", "ROOM_UNAVAILABLE"].includes(failure.code)) setConfirmation(null);
    }
  });
  async function copy() {
    if (!query.data?.allowedActions.includes("copyInvite")) return;
    setCopyFeedback(null);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/join#${query.data.code}`);
      if (mounted.current) setCopyFeedback({ text: "邀请链接已复制。", failed: false });
    } catch {
      if (mounted.current) setCopyFeedback({ text: "复制失败，请检查浏览器剪贴板权限后重试，或手工分享上方邀请码。", failed: true });
    }
  }
  function changeOpen(next: boolean) {
    if (mutation.isPending) return;
    setOpen(next);
    if (next) {
      setDialogMessage("");
      setResetFeedback("");
      void loadConfirmation();
    }
  }
  function reset() {
    if (!confirmation?.allowedActions.includes("resetInvite") || query.isFetching || mutation.isPending) return;
    const command = lastCommand?.version === confirmation.version ? lastCommand : { idempotencyKey: uuidv7(), version: confirmation.version };
    setLastCommand(command);
    setDialogMessage("");
    mutation.mutate(command);
  }
  return <section className="settings-card invite-pane" aria-labelledby="room-invite-heading">
    <h3 id="room-invite-heading">房间邀请</h3>
    <p>邀请码可以重复使用。受邀者提交申请后，仍须由你批准才能加入房间。</p>
    {query.isPending ? <p role="status">正在读取房间邀请…</p> : query.isError && !open ? <InviteError error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /> : query.data && <>
      <dl className="netease-identity"><div><dt>邀请码</dt><dd className="invite-code">{query.data.code}</dd></div></dl>
      <div className="invite-actions">
        {query.data.allowedActions.includes("copyInvite") && <button className="secondary-button" type="button" onClick={() => void copy()}>复制邀请链接</button>}
        {query.data.allowedActions.includes("resetInvite") && (
          <DestructiveConfirmDialog
            trigger={<button className="secondary-button" type="button">重置邀请</button>}
            title="重置房间邀请？"
            descriptionText={
              confirmation
                ? `旧邀请码和链接将立即失效，并取消 ${confirmation.pendingCount} 份待处理申请。当前成员不受影响。`
                : "正在读取最新申请情况，请稍候再确认。"
            }
            badges={[
              { label: "不可撤销", variant: "danger" },
              { label: "旧码立即失效", variant: "danger" },
              ...(confirmation && confirmation.pendingCount > 0
                ? [{ label: `取消 ${confirmation.pendingCount} 份待处理申请`, variant: "warning" as const }]
                : [])
            ]}
            cancelText="保留当前邀请"
            confirmText="确认重置邀请"
            pendingText="重置中…"
            open={open}
            onOpenChange={changeOpen}
            onConfirm={reset}
            isPending={mutation.isPending}
            confirmDisabled={!confirmation?.allowedActions.includes("resetInvite") || query.isFetching}
            error={dialogMessage}
          >
            {!confirmation && !query.isFetching && (
              <button className="secondary-button" type="button" onClick={() => void loadConfirmation()}>
                重新读取影响范围
              </button>
            )}
          </DestructiveConfirmDialog>
        )}
      </div>
      {copyFeedback && <p className={copyFeedback.failed ? "form-message" : "netease-status"} role={copyFeedback.failed ? "alert" : "status"}>{copyFeedback.text}</p>}
      {resetFeedback && <p role="status" className="netease-status">{resetFeedback}</p>}
    </>}
  </section>;
}
