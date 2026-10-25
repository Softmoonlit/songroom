import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AlertCircle, RotateCw, Shuffle, X } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import {
  randomReplacementPreviewView,
  randomReplacementResponse,
  type RandomReplacementOperationView,
  type RandomReplacementPreviewView
} from "../shared/public-playlist-contracts.js";
import { roomMembersView } from "../shared/room-contracts.js";
import { queryOptions, request, RoomRequestError } from "./room-http.js";
import { getFriendlyReplacementErrorMessage, getFriendlyReplacementOperationStatus } from "./random-replacement-messages.js";

export interface RandomReplacementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  sessionId: string;
  replacementOperation: RandomReplacementOperationView | null;
  onReplacementStarted: (operationId: string) => void;
}

const COUNT_OPTIONS = [5, 10, 15, 20] as const;
type CountOption = (typeof COUNT_OPTIONS)[number];

export function RandomReplacementDialog({
  open,
  onOpenChange,
  roomId,
  sessionId,
  replacementOperation,
  onReplacementStarted
}: RandomReplacementDialogProps) {
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [selectedCount, setSelectedCount] = useState<CountOption>(10);
  const [preview, setPreview] = useState<RandomReplacementPreviewView | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [replacementCommand, setReplacementCommand] = useState<{ previewId: string; idempotencyKey: string } | null>(null);
  const [replacementStarted, setReplacementStarted] = useState(false);

  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  const membersQuery = useQuery({
    queryKey: ["room-members", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/members`, roomMembersView, signal),
    enabled: open,
    ...queryOptions
  });

  const previewMutation = useMutation({
    mutationFn: (variables: { memberIds: string[]; count: CountOption }) =>
      request(
        `/${roomId}/public-playlist/random-preview`,
        randomReplacementPreviewView,
        undefined,
        variables
      ),
    onSuccess: data => {
      if (!open) return;
      setPreview(data);
      setPreviewError("");
      setConfirmError("");
      setReplacementCommand(null);
    },
    onError: failure => {
      if (!open) return;
      setPreview(null);
      setReplacementCommand(null);
      const code = failure instanceof RoomRequestError ? failure.code : null;
      setPreviewError(getFriendlyReplacementErrorMessage(code));
    }
  });

  const confirmMutation = useMutation({
    mutationFn: (cmd: { previewId: string; idempotencyKey: string }) =>
      request(
        `/${roomId}/public-playlist/random-replacement`,
        randomReplacementResponse,
        undefined,
        cmd
      ),
    onSuccess: res => {
      setReplacementCommand(null);
      setReplacementStarted(true);
      onReplacementStarted(res.operation.id);
    },
    onMutate: () => {
      setReplacementStarted(true);
    },
    onError: failure => {
      setReplacementStarted(false);
      const code = failure instanceof RoomRequestError ? failure.code : null;
      if (code === "PREVIEW_INVALIDATED" || code === "PREVIEW_NOT_FOUND") {
        setConfirmError("来源已变更，当前预览已失效，请重新抽选。");
      } else {
        setConfirmError(getFriendlyReplacementErrorMessage(code));
      }
    }
  });

  // 每次打开或关闭弹窗：重置状态并取消未完成 mutation
  useEffect(() => {
    if (!open) {
      previewMutation.reset();
      setSelectedMemberIds([]);
      setSelectedCount(10);
      setPreview(null);
      setPreviewError("");
      setConfirmError("");
      setReplacementCommand(null);
      setReplacementStarted(false);
    }
  }, [open, roomId]);

  const replacementFinished = Boolean(
    replacementOperation && ["succeeded", "failed", "stopped"].includes(replacementOperation.status)
  );
  const replacementStatus = replacementOperation
    ? getFriendlyReplacementOperationStatus(replacementOperation)
    : { title: "正在提交", description: "正在排队处理…" };

  const members = membersQuery.data?.members ?? [];
  const eligibleMembers = members.filter(m => m.hasPersonalPlaylist);
  const eligibleMemberIds = eligibleMembers.map(m => m.id);

  const isAllEligibleSelected =
    eligibleMembers.length > 0 && eligibleMemberIds.every(id => selectedMemberIds.includes(id));
  const isPartiallySelected =
    !isAllEligibleSelected && selectedMemberIds.some(id => eligibleMemberIds.includes(id));

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = isPartiallySelected;
    }
  }, [isPartiallySelected]);

  const handleToggleSelectAll = () => {
    if (eligibleMembers.length === 0 || previewMutation.isPending) return;
    if (isAllEligibleSelected) {
      setSelectedMemberIds([]);
    } else {
      setSelectedMemberIds(eligibleMemberIds);
    }
    setPreviewError("");
  };

  const handleToggleMember = (memberId: string) => {
    if (previewMutation.isPending) return;
    setSelectedMemberIds(prev =>
      prev.includes(memberId) ? prev.filter(id => id !== memberId) : [...prev, memberId]
    );
    setPreviewError("");
  };

  const handleCountChange = (count: CountOption) => {
    if (previewMutation.isPending || confirmMutation.isPending) return;
    setSelectedCount(count);
  };

  const handleGeneratePreview = () => {
    if (selectedMemberIds.length === 0 || previewMutation.isPending) return;
    setPreviewError("");
    setConfirmError("");
    previewMutation.mutate({ memberIds: selectedMemberIds, count: selectedCount });
  };

  const handleReshuffle = () => {
    if (selectedMemberIds.length === 0 || previewMutation.isPending || confirmMutation.isPending) return;
    setConfirmError("");
    setReplacementCommand(null);
    previewMutation.mutate({ memberIds: selectedMemberIds, count: selectedCount });
  };

  const handleBackToAdjust = () => {
    if (confirmMutation.isPending) return;
    setPreview(null);
    setPreviewError("");
    setConfirmError("");
    setReplacementCommand(null);
  };

  const handleConfirm = () => {
    if (!preview || confirmMutation.isPending || previewMutation.isPending) return;
    const cmd =
      replacementCommand?.previewId === preview.previewId
        ? replacementCommand
        : { previewId: preview.previewId, idempotencyKey: uuidv7() };
    setReplacementCommand(cmd);
    confirmMutation.mutate(cmd);
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content
          className="invite-modal random-replacement-modal"
          aria-describedby="random-replacement-desc"
        >
          <div className="invite-modal-header">
            <div>
              <AlertDialog.Title className="invite-modal-title">
                <Shuffle size={18} aria-hidden="true" style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
                随机点歌
              </AlertDialog.Title>
              <AlertDialog.Description id="random-replacement-desc" className="invite-modal-desc">
                选择参与抽选的房间成员，从其个人歌单中尽量均分随机抽歌并打散整组顺序。
              </AlertDialog.Description>
            </div>
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="invite-modal-close"
                aria-label="关闭随机点歌窗口"
                disabled={previewMutation.isPending || confirmMutation.isPending || (replacementStarted && !replacementFinished)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </AlertDialog.Cancel>
          </div>

          <div className="random-replacement-body">
            {replacementStarted ? (
              <div
                className={`replacement-dialog-status replacement-status-banner status-${replacementOperation?.status ?? "queued"}`}
                role="status"
              >
                <div className="replacement-status-header">
                  <RotateCw
                    size={16}
                    className={replacementFinished ? "" : "spin-icon"}
                    aria-hidden="true"
                  />
                  <strong>{replacementStatus.title}</strong>
                </div>
                <p className="replacement-status-desc">{replacementStatus.description}</p>
              </div>
            ) : <>
            {/* 错误提示 */}
            {previewError && (
              <div className="error-banner" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{previewError}</span>
                {selectedMemberIds.length > 0 && (
                  <button
                    type="button"
                    className="secondary-button text-button error-retry-btn"
                    onClick={handleGeneratePreview}
                    disabled={previewMutation.isPending}
                  >
                    重试
                  </button>
                )}
              </div>
            )}

            {confirmError && (
              <div className="error-banner" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{confirmError}</span>
              </div>
            )}

            {/* 加载中状态 */}
            {previewMutation.isPending ? (
              <div className="random-replacement-loading" role="status">
                <RotateCw size={24} className="spin-icon" aria-hidden="true" />
                <p>{preview ? "正在核验歌单…" : "正在同步歌单…"}</p>
              </div>
            ) : preview ? (
              /* 预览结果模式 */
              <div className="random-replacement-content">
                {/* 统计概览 */}
                <div className="random-stats-card">
                  <div className="random-stats-row">
                    <span className="stats-main-count">
                      本次抽选：<strong>{preview.actualCount}</strong> 首
                      {preview.actualCount < preview.targetCount && (
                        <span className="count-shortfall-note">
                          （目标 {preview.targetCount} 首，可用候选不足）
                        </span>
                      )}
                    </span>
                    <span className="stats-replace-scope">
                      将替换点歌台全部 <strong>{preview.oldTrackCount}</strong> 首旧歌曲
                      {preview.oldTracksWithRequesterCount > 0 && (
                        <>（其中 {preview.oldTracksWithRequesterCount} 首带点歌人标签）</>
                      )}
                    </span>
                  </div>

                  {/* 成员贡献均分展示 */}
                  <div className="random-member-contributions" aria-label="各成员贡献数量">
                    <span className="contributions-title">成员贡献：</span>
                    <div className="contribution-pills">
                      {preview.memberContributions.map(c => (
                        <span key={c.memberId} className="contribution-pill">
                          {c.nickname}：{c.count} 首
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 候选歌曲清单 */}
                <div className="random-preview-tracks-section">
                  <h3 className="preview-tracks-heading">歌曲预览列表 ({preview.tracks.length} 首)</h3>
                  <div className="random-preview-tracks-list" role="list" tabIndex={0} aria-label="抽选歌曲预览">
                    {preview.tracks.map((track, idx) => (
                      <div key={`${track.songId}-${idx}`} className="preview-track-item" role="listitem">
                        <span className="preview-track-index">{idx + 1}</span>
                        <div className="preview-track-info">
                          <span className="preview-track-name" title={track.name}>
                            {track.name}
                          </span>
                          <span
                            className="preview-track-meta"
                            title={`${track.artists.join(" / ")}${track.album ? ` · ${track.album}` : ""}`}
                          >
                            {track.artists.join(" / ")}
                            {track.album && <span> · {track.album}</span>}
                          </span>
                        </div>
                        <div className="preview-track-tags">
                          <span
                            className="requester-capsule"
                            title={`来源成员：${track.sourceMemberNickname}`}
                          >
                            {track.sourceMemberNickname}
                          </span>
                          {track.isNew && <span className="track-badge is-new">新歌</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 替换说明与官方客户端重新载入提示 */}
                <p className="random-confirm-guidance">
                  确认后将替换点歌台中的全部歌曲，最终顺序以网易云实际读回为准。换歌完成后，请在网易云官方客户端重新载入该歌单并点击「播放全部」以开始播放新列表。
                </p>
              </div>
            ) : (
              /* 配置/选择模式 */
              <div className="random-replacement-config">
                {/* 成员选择区 */}
                <div className="random-member-selection-section">
                  <div className="random-section-header">
                    <span className="random-section-title">参与成员：</span>
                  </div>

                  <div className="random-member-list" role="group" aria-label="选择参与成员">
                    {eligibleMembers.length > 0 && (
                      <label className="random-member-item random-select-all-item">
                        <input
                          ref={selectAllCheckboxRef}
                          type="checkbox"
                          className="random-checkbox"
                          checked={isAllEligibleSelected}
                          onChange={handleToggleSelectAll}
                          disabled={previewMutation.isPending}
                          aria-label="全选参与成员"
                        />
                        <span className="random-member-nickname">全选</span>
                      </label>
                    )}

                    {membersQuery.isLoading ? (
                      <p className="random-member-loading" role="status">正在加载成员列表…</p>
                    ) : members.length === 0 ? (
                      <p className="random-member-empty">暂无成员</p>
                    ) : (
                      members.map(member => {
                        const isEligible = member.hasPersonalPlaylist;
                        const isChecked = selectedMemberIds.includes(member.id);
                        return (
                          <label
                            key={member.id}
                            className={`random-member-item ${!isEligible ? "disabled" : ""}`}
                          >
                            <input
                              type="checkbox"
                              className="random-checkbox"
                              checked={isChecked}
                              disabled={!isEligible || previewMutation.isPending}
                              onChange={() => handleToggleMember(member.id)}
                              aria-label={`选择成员 ${member.nickname}`}
                            />
                            <span className="random-member-nickname">{member.nickname}</span>
                            {!isEligible && (
                              <span className="random-member-reason">未分配歌单</span>
                            )}
                          </label>
                        );
                      })
                    )}
                  </div>

                  {selectedMemberIds.length === 0 && (
                    <p className="random-selection-hint" role="status">请至少选择一位成员</p>
                  )}
                </div>

                {/* 数量选择器 */}
                <div className="random-count-selector" role="radiogroup" aria-label="期望换歌首数">
                  <span className="random-count-label">期望首数：</span>
                  <div className="random-count-buttons">
                    {COUNT_OPTIONS.map(c => (
                      <button
                        key={c}
                        type="button"
                        className={`random-count-btn ${selectedCount === c ? "active" : ""}`}
                        disabled={previewMutation.isPending || confirmMutation.isPending}
                        onClick={() => handleCountChange(c)}
                        aria-checked={selectedCount === c}
                        role="radio"
                      >
                        {c}首{c === 10 ? " (默认)" : ""}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            </>}
          </div>

          <div className="modal-actions random-modal-actions">
            {replacementStarted ? (
              <AlertDialog.Cancel asChild>
                <button type="button" className="secondary-button" disabled={!replacementFinished}>
                  {replacementFinished ? "关闭" : "处理中…"}
                </button>
              </AlertDialog.Cancel>
            ) : preview ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={confirmMutation.isPending || previewMutation.isPending}
                  onClick={handleBackToAdjust}
                >
                  返回调整
                </button>
                <button
                  type="button"
                  className="secondary-button icon-button-text reshuffle-btn"
                  disabled={previewMutation.isPending || confirmMutation.isPending}
                  onClick={handleReshuffle}
                  aria-label="重新抽选预览"
                >
                  <RotateCw
                    size={14}
                    className={previewMutation.isPending ? "spin-icon" : ""}
                    aria-hidden="true"
                  />
                  <span>重新抽选</span>
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={confirmMutation.isPending || previewMutation.isPending}
                  onClick={handleConfirm}
                >
                  {confirmMutation.isPending ? "正在提交换歌…" : "确认替换"}
                </button>
              </>
            ) : (
              <>
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={previewMutation.isPending}
                  >
                    取消
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  className="primary-button"
                  disabled={selectedMemberIds.length === 0 || previewMutation.isPending || membersQuery.isLoading}
                  onClick={handleGeneratePreview}
                >
                  {previewMutation.isPending ? "正在生成预览…" : "生成预览"}
                </button>
              </>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
