import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";

export interface DestructiveBadge {
  label: string;
  variant?: "danger" | "warning" | "neutral";
}

export interface DestructiveConfirmDialogProps {
  /** 自定义触发元素，若未提供则可使用 triggerText 生成标准危险按钮 */
  trigger?: ReactNode;
  /** 快捷触发按钮文字 */
  triggerText?: string;
  /** 动宾标题，例如“删除房间？”、“退出房间？” */
  title: string;
  /** 核心单句风险描述 */
  descriptionText: string;
  /** 关键危险标签（如：不可撤销、立即生效、权限撤销等） */
  badges?: DestructiveBadge[];
  /** 确认操作文字 */
  confirmText: string;
  /** 提交中操作文字 */
  pendingText: string;
  /** 取消按钮文字，默认为“取消” */
  cancelText?: string;
  /** 受控展开状态 */
  open: boolean;
  /** 打开/关闭状态变更回调 */
  onOpenChange: (open: boolean) => void;
  /** 确认执行回调 */
  onConfirm: () => void;
  /** 提交处理中状态 */
  isPending: boolean;
  /** 是否禁用确认按钮 */
  confirmDisabled?: boolean;
  /** 内联错误提示 */
  error?: string;
  /** 补充内容（如专用歌单说明） */
  children?: ReactNode;
}

export function DestructiveConfirmDialog({
  trigger,
  triggerText,
  title,
  descriptionText,
  badges,
  confirmText,
  pendingText,
  cancelText = "取消",
  open,
  onOpenChange,
  onConfirm,
  isPending,
  confirmDisabled = false,
  error,
  children
}: DestructiveConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? (
        <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      ) : triggerText ? (
        <AlertDialog.Trigger asChild>
          <button className="danger-button" type="button">
            {triggerText}
          </button>
        </AlertDialog.Trigger>
      ) : null}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content
          className="destructive-dialog"
          onEscapeKeyDown={event => {
            if (isPending) event.preventDefault();
          }}
        >
          <div className="destructive-dialog-header">
            <AlertDialog.Title className="destructive-dialog-title">{title}</AlertDialog.Title>
            {badges && badges.length > 0 && (
              <div className="destructive-badges" aria-label="关键危险标识">
                {badges.map((badge, idx) => {
                  const variantClass = badge.variant ? ` ${badge.variant}` : " danger";
                  return (
                    <span key={idx} className={`destructive-badge${variantClass}`}>
                      {badge.label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <AlertDialog.Description asChild>
            <div className="destructive-dialog-body">
              <p className="destructive-dialog-desc">{descriptionText}</p>
              {children}
            </div>
          </AlertDialog.Description>

          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}

          <div className="destructive-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button className="secondary-button" type="button" disabled={isPending}>
                {cancelText}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                className="danger-button"
                type="button"
                disabled={isPending || confirmDisabled}
                onClick={event => {
                  event.preventDefault();
                  onConfirm();
                }}
              >
                {isPending ? pendingText : confirmText}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
