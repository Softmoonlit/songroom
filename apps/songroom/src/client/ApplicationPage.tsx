import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCircle2, ChevronRight, Clock, Music2, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { v7 as uuidv7 } from "uuid";
import { joinApplicationView } from "../shared/invite-contracts.js";
import { getApplicationTimeline, type TimelineStepStatus } from "./application-timeline.js";
import { InviteError } from "./InviteError.js";
import { inviteRequest } from "./invite-http.js";
import { queryOptions, RoomRequestError } from "./room-http.js";

export function ApplicationPage({ sessionId }: { sessionId: string }) {
  const { applicationId } = useParams();
  return (
    <ApplicationDetails
      key={`${sessionId}:${applicationId}`}
      sessionId={sessionId}
      applicationId={applicationId!}
    />
  );
}

function ApplicationDetails({
  sessionId,
  applicationId
}: {
  sessionId: string;
  applicationId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ["join-application", sessionId, applicationId];

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => inviteRequest(`/join-applications/${applicationId}`, joinApplicationView, signal),
    refetchInterval: q => (q.state.data?.status === "pending" ? 2000 : false),
    ...queryOptions
  });

  const [withdrawKey, setWithdrawKey] = useState<string | null>(null);
  const [hasTriggeredAutoNav, setHasTriggeredAutoNav] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const controller = useRef<AbortController | null>(null);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      controller.current?.abort();
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (query.data) heading.current?.focus();
  }, [query.data?.id, query.data?.status]);

  // 当获批时自动感知并伴随动画进入房间
  useEffect(() => {
    if (query.data?.status === "approved" && !hasTriggeredAutoNav) {
      setHasTriggeredAutoNav(true);
      navTimerRef.current = setTimeout(() => {
        void navigate(`/rooms/${query.data!.room.id}`, { replace: true });
      }, 1200);
    }
  }, [query.data?.status, query.data?.room.id, hasTriggeredAutoNav, navigate]);

  const withdrawMutation = useMutation({
    mutationFn: (idempotencyKey: string) => {
      controller.current = new AbortController();
      return inviteRequest(
        `/join-applications/${applicationId}/withdraw`,
        joinApplicationView,
        controller.current.signal,
        { idempotencyKey }
      );
    },
    retry: false,
    onSuccess: application => {
      if (controller.current?.signal.aborted) return;
      queryClient.setQueryData(queryKey, application);
      void queryClient.invalidateQueries({ queryKey: ["join-applications", sessionId] });
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      if (
        failure instanceof RoomRequestError &&
        ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_KEY_EXPIRED"].includes(failure.code)
      ) {
        setWithdrawKey(null);
      }
      if (failure instanceof RoomRequestError && failure.code === "APPLICATION_NOT_PENDING") {
        void query.refetch();
      }
    }
  });

  function handleWithdraw() {
    if (
      withdrawMutation.isPending ||
      query.isFetching ||
      !query.data?.allowedActions.includes("withdrawApplication")
    ) {
      return;
    }
    const key = withdrawKey ?? uuidv7();
    setWithdrawKey(key);
    withdrawMutation.mutate(key);
  }

  return (
    <section className="rooms-page application-page-wrapper" aria-labelledby="application-heading">
      <Link className="back-link" to="/rooms">
        <ArrowLeft size={16} aria-hidden="true" />
        返回房间列表
      </Link>

      {query.isPending ? (
        <div className="application-loading-state" role="status">
          <Clock size={22} className="spin" aria-hidden="true" />
          <span>正在读取加入申请进度…</span>
        </div>
      ) : query.isError ? (
        <InviteError
          error={query.error}
          retry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data ? (
        <div className="application-tracking-container">
          <div className="application-card">
            <div className="application-card-header">
              <div className="application-room-meta">
                <Music2 size={22} className="application-header-icon" aria-hidden="true" />
                <div>
                  <h1 id="application-heading" ref={heading} tabIndex={-1} className="application-title">
                    {query.data.room.name}
                  </h1>
                  <p className="application-subtitle">加入申请跟踪</p>
                </div>
              </div>

              {query.data.status === "approved" && (
                <div className="approved-badge-tag" role="status">
                  <Sparkles size={14} aria-hidden="true" />
                  <span>已获批准</span>
                </div>
              )}
            </div>

            <div className="application-applicant-pill">
              <span className="applicant-pill-label">拟用昵称：</span>
              <span className="applicant-pill-val">{query.data.nickname}</span>
            </div>

            {/* 步骤时间轴 */}
            <div className="application-timeline" aria-label="申请处理时间轴">
              {(() => {
                const timeline = getApplicationTimeline(query.data.status, query.data.nickname);
                return timeline.steps.map((stepItem, idx) => {
                  const isLast = idx === timeline.steps.length - 1;
                  return (
                    <div
                      key={stepItem.step}
                      className={`timeline-step-item step-${stepItem.status}`}
                    >
                      <div className="timeline-node-col">
                        <div className="timeline-node" aria-hidden="true">
                          {renderStepIcon(stepItem.status)}
                        </div>
                        {!isLast && <div className="timeline-connector" />}
                      </div>

                      <div className="timeline-content-col">
                        <div className="timeline-step-header">
                          <h2 className="timeline-step-title">{stepItem.title}</h2>
                          {stepItem.status === "current" && (
                            <span className="timeline-live-dot" title="等待处理中" />
                          )}
                        </div>
                        <p className="timeline-step-desc">{stepItem.description}</p>

                        {/* 节点2处于 pending 时的撤回操作 */}
                        {stepItem.step === 2 &&
                          query.data.status === "pending" &&
                          query.data.allowedActions.includes("withdrawApplication") && (
                            <div className="timeline-step-actions">
                              <button
                                className="secondary-button compact withdraw-btn"
                                type="button"
                                disabled={withdrawMutation.isPending || query.isFetching}
                                onClick={handleWithdraw}
                              >
                                {withdrawMutation.isPending ? "正在撤回…" : "撤回申请"}
                              </button>
                            </div>
                          )}

                        {/* 节点3获批时的进入房间引导 */}
                        {stepItem.step === 3 && query.data.status === "approved" && (
                          <div className="timeline-step-actions">
                            <Link
                              className="primary-button enter-room-auto-btn"
                              to={`/rooms/${query.data.room.id}`}
                            >
                              <span>立即进入房间</span>
                              <ChevronRight size={16} aria-hidden="true" />
                            </Link>
                            <span className="auto-enter-tip" role="status">
                              系统正在自动为你跳转进房…
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* 终结状态重新申请提示 */}
            {query.data.status !== "pending" && query.data.status !== "approved" && (
              <div className="application-reapply-box">
                <p className="reapply-tip">
                  {query.data.status === "nickname_conflict"
                    ? "由于拟用昵称已被房间成员占用，你可以更换新昵称重新提交申请。"
                    : "该申请已终结，如需加入请获取有效邀请码重新申请。"}
                </p>
                <Link className="primary-button reapply-btn" to="/join">
                  <RotateCcw size={15} aria-hidden="true" />
                  <span>重新申请加入</span>
                </Link>
              </div>
            )}

            {withdrawMutation.isError && (
              <div className="application-mutation-error">
                <InviteError error={withdrawMutation.error} />
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function renderStepIcon(status: TimelineStepStatus) {
  switch (status) {
    case "completed":
      return <Check size={14} className="node-icon" />;
    case "current":
      return <span className="node-pulse-inner" />;
    case "failed":
      return <XCircle size={14} className="node-icon" />;
    case "pending":
    default:
      return <span className="node-empty-inner" />;
  }
}
