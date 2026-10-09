import { useEffect, useRef, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link as LinkIcon, RefreshCw, X } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import { inviteView, type InviteResetCommand, type InviteView } from "../shared/invite-contracts.js";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog.js";
import { InviteError } from "./InviteError.js";
import { inviteErrorMessage, inviteRequest } from "./invite-http.js";
import { queryOptions, RoomRequestError } from "./room-http.js";

export interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  roomId: string;
}

export function InviteDialog({ open, onOpenChange, sessionId, roomId }: InviteDialogProps) {
  const queryClient = useQueryClient();
  const queryKey = ["room-invite", sessionId, roomId];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => inviteRequest(`/rooms/${roomId}/invite`, inviteView, signal),
    enabled: open,
    ...queryOptions
  });

  const [copyFeedback, setCopyFeedback] = useState<"link" | "code" | null>(null);
  const [copyError, setCopyError] = useState("");
  const [resetSuccess, setResetSuccess] = useState("");
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<InviteView | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [lastCommand, setLastCommand] = useState<InviteResetCommand | null>(null);

  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (open) {
      setCopyFeedback(null);
      setCopyError("");
      setResetSuccess("");
    }
  }, [open]);

  async function loadConfirmation() {
    setConfirmation(null);
    try {
      const result = await query.refetch({ throwOnError: true });
      if (mounted.current && result.data) setConfirmation(result.data);
    } catch (failure) {
      if (mounted.current) setDialogError(inviteErrorMessage(failure));
    }
  }

  const resetMutation = useMutation({
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
      setResetSuccess("邀请已重置，旧邀请码和链接已失效，旧待处理申请已取消。");
      setResetDialogOpen(false);
      setLastCommand(null);
    },
    onError: async failure => {
      if (controller.current?.signal.aborted) return;
      setDialogError(inviteErrorMessage(failure));
      if (
        failure instanceof RoomRequestError &&
        ["INVITE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_KEY_EXPIRED"].includes(failure.code)
      ) {
        setLastCommand(null);
        await loadConfirmation();
      }
      if (
        failure instanceof RoomRequestError &&
        ["INVITE_FORBIDDEN", "SESSION_REQUIRED", "ROOM_UNAVAILABLE"].includes(failure.code)
      ) {
        setConfirmation(null);
      }
    }
  });

  async function handleCopy(type: "link" | "code") {
    if (!query.data?.allowedActions.includes("copyInvite")) return;
    setCopyError("");
    setResetSuccess("");
    const textToCopy =
      type === "link"
        ? `${window.location.origin}/join#${query.data.code}`
        : query.data.code;

    try {
      await navigator.clipboard.writeText(textToCopy);
      if (mounted.current) {
        setCopyFeedback(type);
      }
    } catch {
      if (mounted.current) {
        setCopyError("复制失败，请检查浏览器剪贴板权限或手动复制上方邀请码。");
      }
    }
  }

  function handleOpenResetDialog(next: boolean) {
    if (resetMutation.isPending) return;
    setResetDialogOpen(next);
    if (next) {
      setDialogError("");
      void loadConfirmation();
    }
  }

  function handleConfirmReset() {
    if (!confirmation?.allowedActions.includes("resetInvite") || query.isFetching || resetMutation.isPending) return;
    const command =
      lastCommand?.version === confirmation.version
        ? lastCommand
        : { idempotencyKey: uuidv7(), version: confirmation.version };
    setLastCommand(command);
    setDialogError("");
    resetMutation.mutate(command);
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="invite-modal" aria-describedby="invite-modal-desc">
          <div className="invite-modal-header">
            <div>
              <AlertDialog.Title className="invite-modal-title">邀请室友加入</AlertDialog.Title>
              <AlertDialog.Description id="invite-modal-desc" className="invite-modal-desc">
                邀请码可重复使用。受邀室友提交申请后，需由房主审批通过方可加入。
              </AlertDialog.Description>
            </div>
            <button
              type="button"
              className="invite-modal-close"
              onClick={() => onOpenChange(false)}
              aria-label="关闭邀请弹窗"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="invite-modal-body">
            {query.isPending ? (
              <p className="invite-loading-state" role="status">正在获取最新邀请码…</p>
            ) : query.isError ? (
              <InviteError error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />
            ) : query.data ? (
              <>
                <div className="invite-code-card">
                  <span className="invite-code-label">房间邀请码</span>
                  <div className="invite-code-display" aria-label={`邀请码 ${query.data.code}`}>
                    {query.data.code}
                  </div>
                </div>

                <div className="invite-modal-actions">
                  {query.data.allowedActions.includes("copyInvite") && (
                    <>
                      <button
                        type="button"
                        className={`invite-copy-btn primary-copy${copyFeedback === "link" ? " success" : ""}`}
                        aria-label="复制邀请链接"
                        onClick={() => void handleCopy("link")}
                      >
                        {copyFeedback === "link" ? (
                          <>
                            <Check size={16} aria-hidden="true" />
                            <span>邀请链接已复制</span>
                          </>
                        ) : (
                          <>
                            <LinkIcon size={16} aria-hidden="true" />
                            <span>复制邀请链接</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        className={`invite-copy-btn secondary-copy${copyFeedback === "code" ? " success" : ""}`}
                        aria-label="仅复制邀请码"
                        onClick={() => void handleCopy("code")}
                      >
                        {copyFeedback === "code" ? (
                          <>
                            <Check size={16} aria-hidden="true" />
                            <span>邀请码已复制</span>
                          </>
                        ) : (
                          <>
                            <Copy size={16} aria-hidden="true" />
                            <span>仅复制邀请码</span>
                          </>
                        )}
                      </button>
                    </>
                  )}
                </div>

                {copyFeedback && (
                  <p className="netease-status" role="status">
                    {copyFeedback === "link" ? "邀请链接已复制" : "邀请码已复制"}
                  </p>
                )}

                {copyError && (
                  <p className="form-message" role="alert">
                    {copyError}
                  </p>
                )}

                {resetSuccess && (
                  <p className="netease-status" role="status">
                    {resetSuccess}
                  </p>
                )}

                {query.data.allowedActions.includes("resetInvite") && (
                  <div className="invite-modal-footer">
                    <DestructiveConfirmDialog
                      trigger={
                        <button type="button" className="invite-reset-trigger">
                          <RefreshCw size={13} aria-hidden="true" />
                          <span>重置邀请码</span>
                        </button>
                      }
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
                      open={resetDialogOpen}
                      onOpenChange={handleOpenResetDialog}
                      onConfirm={handleConfirmReset}
                      isPending={resetMutation.isPending}
                      confirmDisabled={!confirmation?.allowedActions.includes("resetInvite") || query.isFetching}
                      error={dialogError}
                    >
                      {!confirmation && !query.isFetching && (
                        <button className="secondary-button" type="button" onClick={() => void loadConfirmation()}>
                          重新读取影响范围
                        </button>
                      )}
                    </DestructiveConfirmDialog>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
