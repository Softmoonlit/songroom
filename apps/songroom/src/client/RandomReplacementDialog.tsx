import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AlertCircle, RotateCw, Shuffle, X } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import {
  randomReplacementPreviewView,
  randomReplacementResponse,
  type RandomReplacementPreviewView
} from "../shared/public-playlist-contracts.js";
import { request, RoomRequestError } from "./room-http.js";
import { getFriendlyReplacementErrorMessage } from "./random-replacement-messages.js";

export interface RandomReplacementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  onReplacementStarted: (operationId: string) => void;
}

const COUNT_OPTIONS = [5, 10, 15, 20] as const;
type CountOption = (typeof COUNT_OPTIONS)[number];

export function RandomReplacementDialog({
  open,
  onOpenChange,
  roomId,
  onReplacementStarted
}: RandomReplacementDialogProps) {
  const [selectedCount, setSelectedCount] = useState<CountOption>(10);
  const [preview, setPreview] = useState<RandomReplacementPreviewView | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [replacementCommand, setReplacementCommand] = useState<{ previewId: string; idempotencyKey: string } | null>(null);

  const previewMutation = useMutation({
    mutationFn: (count: CountOption) =>
      request(
        `/${roomId}/public-playlist/random-preview`,
        randomReplacementPreviewView,
        undefined,
        { count }
      ),
    onSuccess: data => {
      setPreview(data);
      setPreviewError("");
      setConfirmError("");
      setReplacementCommand(null);
    },
    onError: failure => {
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
      onReplacementStarted(res.operation.id);
      onOpenChange(false);
    },
    onError: failure => {
      const code = failure instanceof RoomRequestError ? failure.code : null;
      if (code === "PREVIEW_INVALIDATED" || code === "PREVIEW_NOT_FOUND") {
        setConfirmError("点歌台或成员来源已变更，当前预览已失效，请重新生成预览。");
      } else {
        setConfirmError(getFriendlyReplacementErrorMessage(code));
      }
    }
  });

  // 打开弹窗时生成默认 10 首的预览
  useEffect(() => {
    if (open) {
      setSelectedCount(10);
      setPreview(null);
      setPreviewError("");
      setConfirmError("");
      setReplacementCommand(null);
      previewMutation.mutate(10);
    } else {
      setPreview(null);
      setPreviewError("");
      setConfirmError("");
      setReplacementCommand(null);
    }
  }, [open, roomId]);

  const handleCountChange = (count: CountOption) => {
    if (previewMutation.isPending || confirmMutation.isPending) return;
    setSelectedCount(count);
    setConfirmError("");
    setReplacementCommand(null);
    previewMutation.mutate(count);
  };

  const handleReshuffle = () => {
    if (previewMutation.isPending || confirmMutation.isPending) return;
    setConfirmError("");
    setReplacementCommand(null);
    previewMutation.mutate(selectedCount);
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
                从房间所有配置了个人歌单的成员中，尽量均分随机抽选歌曲并打散整组顺序。
              </AlertDialog.Description>
            </div>
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="invite-modal-close"
                aria-label="关闭随机点歌窗口"
                disabled={confirmMutation.isPending}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </AlertDialog.Cancel>
          </div>

          <div className="random-replacement-body">
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
              <button
                type="button"
                className="secondary-button icon-button-text reshuffle-btn"
                disabled={previewMutation.isPending || confirmMutation.isPending}
                onClick={handleReshuffle}
                aria-label="重新抽选预览"
                title="重新抽选一组"
              >
                <RotateCw
                  size={14}
                  className={previewMutation.isPending ? "spin-icon" : ""}
                  aria-hidden="true"
                />
                <span>重新抽选</span>
              </button>
            </div>

            {/* 错误提示 */}
            {previewError && (
              <div className="error-banner" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{previewError}</span>
                <button
                  type="button"
                  className="secondary-button text-button error-retry-btn"
                  onClick={handleReshuffle}
                  disabled={previewMutation.isPending}
                >
                  重试
                </button>
              </div>
            )}

            {confirmError && (
              <div className="error-banner" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{confirmError}</span>
              </div>
            )}

            {/* 加载中 */}
            {previewMutation.isPending ? (
              <div className="random-replacement-loading" role="status">
                <RotateCw size={24} className="spin-icon" aria-hidden="true" />
                <p>正在读取成员个人歌单并公平抽选歌曲…</p>
              </div>
            ) : preview ? (
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
            ) : null}
          </div>

          <div className="modal-actions random-modal-actions">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="secondary-button"
                disabled={confirmMutation.isPending}
              >
                取消
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className="primary-button"
              disabled={!preview || previewMutation.isPending || confirmMutation.isPending}
              onClick={handleConfirm}
            >
              {confirmMutation.isPending ? "正在提交换歌…" : "确认替换"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
