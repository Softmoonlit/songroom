import { useEffect } from "react";
import { Check, AlertCircle, Info, X } from "lucide-react";

export interface ToastData {
  id: string;
  message: string;
  type?: "success" | "info" | "warning" | "error";
  duration?: number;
}

export function Toast({
  toast,
  onDismiss
}: {
  toast: ToastData | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const duration = toast.duration ?? 4000;
    const timer = setTimeout(() => {
      onDismiss();
    }, duration);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const type = toast.type ?? "success";

  return (
    <div
      className={`songroom-toast toast-${type}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="toast-icon-wrapper" aria-hidden="true">
        {type === "success" && <Check size={16} />}
        {type === "error" && <AlertCircle size={16} />}
        {type === "info" && <Info size={16} />}
        {type === "warning" && <AlertCircle size={16} />}
      </div>
      <span className="toast-message-text">{toast.message}</span>
      <button
        type="button"
        className="toast-dismiss-btn"
        onClick={onDismiss}
        aria-label="关闭提示"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
