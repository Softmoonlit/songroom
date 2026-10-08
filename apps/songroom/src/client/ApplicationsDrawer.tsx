import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Clock, UserCheck, X, XCircle } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import { joinApplicationView, roomApplicationsView, type JoinApplicationView } from "../shared/invite-contracts.js";
import {
  getFriendlyApprovalDisabledReason,
  getFriendlyDecisionFeedback
} from "./application-decision-messages.js";
import type { JoinApplicationStatusType } from "./application-timeline.js";
import { InviteError } from "./InviteError.js";
import { queryOptions, request, RoomRequestError } from "./room-http.js";

export interface ApplicationsDrawerProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  roomId: string;
}

interface ProcessedItem {
  id: string;
  nickname: string;
  decision: "approve" | "reject";
  status: JoinApplicationStatusType;
  message: string;
}

interface DecisionCommand {
  applicationId: string;
  decision: "approve" | "reject";
  idempotencyKey: string;
}

export function ApplicationsDrawer({ open, onClose, sessionId, roomId }: ApplicationsDrawerProps) {
  const queryClient = useQueryClient();
  const queryKey = ["room-applications", sessionId, roomId];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => request(`/${roomId}/applications`, roomApplicationsView, signal),
    enabled: open,
    ...queryOptions
  });

  const [operatingId, setOperatingId] = useState<string | null>(null);
  const [processedItems, setProcessedItems] = useState<ProcessedItem[]>([]);
  const controller = useRef<AbortController | null>(null);

  // Esc 按键监听
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  // 关闭时清理状态
  useEffect(() => {
    if (!open) {
      setOperatingId(null);
      setProcessedItems([]);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      controller.current?.abort();
    };
  }, []);

  const decisionMutation = useMutation({
    mutationFn: (command: DecisionCommand) => {
      controller.current = new AbortController();
      return request(
        `/${roomId}/applications/${command.applicationId}/decision`,
        joinApplicationView,
        controller.current.signal,
        { idempotencyKey: command.idempotencyKey, decision: command.decision }
      );
    },
    retry: false,
    onSuccess: (application, variables) => {
      if (controller.current?.signal.aborted) return;
      const message = getFriendlyDecisionFeedback(application.status, application.nickname);
      setProcessedItems(prev => [
        {
          id: variables.applicationId,
          nickname: application.nickname,
          decision: variables.decision,
          status: application.status,
          message
        },
        ...prev.filter(item => item.id !== variables.applicationId)
      ]);
      setOperatingId(null);

      // 失效并同步更新相关查询
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-members", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-invite", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      setOperatingId(null);
      if (failure instanceof RoomRequestError) {
        void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
        void queryClient.invalidateQueries({ queryKey });
      }
    }
  });

  function handleDecide(applicationId: string, decision: "approve" | "reject") {
    if (decisionMutation.isPending || query.isFetching) return;
    const application = query.data?.applications.find(item => item.id === applicationId);
    if (!query.data?.allowedActions.includes("reviewApplications")) return;
    if (decision === "approve" && !application?.allowedActions.includes("approveApplication")) return;
    if (decision === "reject" && !application?.allowedActions.includes("rejectApplication")) return;

    setOperatingId(applicationId);
    decisionMutation.mutate({
      applicationId,
      decision,
      idempotencyKey: uuidv7()
    });
  }

  if (!open) return null;

  const applications = query.data?.applications ?? [];
  const processedIds = new Set(processedItems.map(item => item.id));
  const activeApplications = applications.filter(app => !processedIds.has(app.id));
  const hasRemaining = activeApplications.length > 0;
  const hasProcessed = processedItems.length > 0;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer applications-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="加入申请审批"
      >
        <div className="drawer-header">
          <div className="drawer-header-text">
            <h2 className="drawer-title">加入申请审批</h2>
            <p className="drawer-subtitle">
              批准后室友将立即成为房间成员，参与点歌与互动
            </p>
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="关闭审批抽屉"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="drawer-content applications-drawer-body">
          {query.isPending && !hasProcessed ? (
            <div className="drawer-loading" role="status">
              <Clock size={20} className="spin" aria-hidden="true" />
              <span>正在读取待处理申请…</span>
            </div>
          ) : query.isError && !hasProcessed ? (
            <div className="drawer-error">
              <InviteError
                error={query.error}
                retry={() => void query.refetch()}
                retrying={query.isFetching}
              />
            </div>
          ) : (
            <div className="applications-list-container">
              {/* 已处理结果列表：保持视觉留存，保证用户清晰感知审批结果 */}
              {hasProcessed && (
                <div className="processed-results-section" aria-label="刚刚处理的申请">
                  <span className="processed-section-title">处理反馈</span>
                  <ul className="drawer-application-list">
                    {processedItems.map(item => {
                      const isApproved = item.decision === "approve" && item.status === "approved";
                      return (
                        <li
                          key={item.id}
                          className={`drawer-application-card result-feedback${isApproved ? " approved" : " rejected"}`}
                        >
                          <div className="application-result-badge">
                            {isApproved ? (
                              <CheckCircle2 size={18} aria-hidden="true" />
                            ) : (
                              <XCircle size={18} aria-hidden="true" />
                            )}
                            <span className="application-result-text">{item.message}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* 待处理申请列表 */}
              {hasRemaining ? (
                <div className="pending-section">
                  {hasProcessed && <span className="processed-section-title">其他待审批申请</span>}
                  <ul className="drawer-application-list">
                    {activeApplications.map(application => {
                      const isOperating = operatingId === application.id;
                      const disabledReason = application.disabledReasons.approveApplication;
                      const disabledReasonText = getFriendlyApprovalDisabledReason(disabledReason);

                      return (
                        <li key={application.id} className="drawer-application-card">
                          <div className="application-applicant-info">
                            <div className="applicant-avatar" aria-hidden="true">
                              {application.nickname.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="applicant-meta">
                              <span className="applicant-nickname">{application.nickname}</span>
                              <span className="applicant-hint">申请加入房间</span>
                            </div>
                          </div>

                          {disabledReasonText && (
                            <div className="application-disabled-tip" role="alert">
                              {disabledReasonText}
                            </div>
                          )}

                          <div className="application-actions">
                            {application.allowedActions.includes("approveApplication") && (
                              <button
                                type="button"
                                className="application-action-btn approve"
                                disabled={
                                  isOperating ||
                                  decisionMutation.isPending ||
                                  query.isFetching ||
                                  Boolean(disabledReason)
                                }
                                onClick={() => handleDecide(application.id, "approve")}
                                aria-label={`批准 ${application.nickname}`}
                              >
                                {isOperating ? (
                                  <span>处理中…</span>
                                ) : (
                                  <>
                                    <Check size={14} aria-hidden="true" />
                                    <span>批准</span>
                                  </>
                                )}
                              </button>
                            )}

                            {application.allowedActions.includes("rejectApplication") && (
                              <button
                                type="button"
                                className="application-action-btn reject"
                                disabled={isOperating || decisionMutation.isPending || query.isFetching}
                                onClick={() => handleDecide(application.id, "reject")}
                                aria-label={`拒绝 ${application.nickname}`}
                              >
                                <X size={14} aria-hidden="true" />
                                <span>拒绝</span>
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : !hasProcessed ? (
                <div className="drawer-empty-state">
                  <div className="drawer-empty-icon" aria-hidden="true">
                    <UserCheck size={28} />
                  </div>
                  <h3 className="drawer-empty-title">暂无待处理申请</h3>
                  <p className="drawer-empty-desc">
                    当室友通过邀请码提交加入申请时，将在此处显示并由你审核。
                  </p>
                </div>
              ) : (
                <div className="drawer-all-done-hint" role="status">
                  <span>所有待处理申请已审批完毕</span>
                </div>
              )}

              {decisionMutation.isError && (
                <div className="drawer-mutation-error">
                  <InviteError error={decisionMutation.error} />
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
