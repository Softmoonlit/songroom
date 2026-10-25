import type { RandomReplacementOperationView } from "../shared/public-playlist-contracts.js";
import { errorMessageForCode } from "./room-http.js";

const replacementErrorMessages: Record<string, string> = {
  EMPTY_CANDIDATES: "所选成员歌单暂无歌曲。",
  INVALID_MEMBER: "所选成员不存在或已离开。",
  MEMBER_PLAYLIST_NOT_CONFIGURED: "所选成员未配置个人歌单。",
  PREVIEW_INVALIDATED: "歌单已变更，请重新抽选。",
  PREVIEW_NOT_FOUND: "抽选预览已失效，请重新抽选。",
  ACCOUNT_PAUSED: "网易云账号已暂停，请联系管理员。",
  PLAYLIST_CONFLICT: "歌单正在执行其他写入，请稍候。",
  CONCURRENT_OPERATION_LIMIT_EXCEEDED: "已有未完成的操作，请稍候。",
  NETEASE_AUTH_REQUIRED: "需要房主完成网易云授权。",
  MODULE_ERROR: "网易云接口异常，请稍后重试。",
  NETWORK_ERROR: "网络连接失败，请稍后重试。",
  DEADLINE: "网易云请求超时，请稍后重试。",
  RATE_LIMITED: "网易云请求受限，请稍后重试。"
};

export function getFriendlyReplacementErrorMessage(code: string | null | undefined): string {
  if (!code) return "操作执行失败，请稍后重试。";
  if (code in replacementErrorMessages) {
    return replacementErrorMessages[code];
  }
  const fallback = errorMessageForCode(code);
  return fallback || "操作执行失败，请稍后重试。";
}

export function getFriendlyReplacementOperationStatus(
  op: RandomReplacementOperationView
): { title: string; description: string } {
  switch (op.status) {
    case "queued":
      return {
        title: "换歌已排队",
        description: "正在排队处理…"
      };
    case "processing": {
      let description = "正在处理…";
      if (op.step === "verified" || op.step === "ready") {
        if (op.removedSongIds.length > 0 && op.addedSongIds.length === 0) {
          description = "已清空旧歌曲，准备添加新歌曲…";
        } else {
          description = "正在核对来源…";
        }
      } else if (op.step === "sending") {
        if (op.currentAction === "add") {
          description = `正在添加新歌曲（已添加 ${op.addedSongIds.length} / ${op.targetCount} 首）…`;
        } else if (op.currentAction === "remove") {
          description = op.removedSongIds.length > 0
            ? `正在移除旧歌曲（已移除 ${op.removedSongIds.length} 首）…`
            : "正在移除旧歌曲…";
        } else {
          description = `正在同步网易云（目标 ${op.targetCount} 首）…`;
        }
      } else if (op.step === "confirming") {
        description = "正在核验最新歌单与顺序…";
      } else if (op.step === "tagging") {
        description = "正在记录点歌人标签…";
      }
      return {
        title: "正在更新点歌台",
        description
      };
    }
    case "awaitingConfirmation":
      return {
        title: "换歌结果待确认",
        description: "已提交网易云，正在核验最终状态，请勿重试。"
      };
    case "waitingAuthorization":
      return {
        title: "等待房主授权",
        description: "需要房主重新授权网易云账号。"
      };
    case "needsAdministrator":
      return {
        title: "需要管理员处理",
        description: "换歌状态异常，请联系管理员处理。"
      };
    case "failed": {
      const err = getFriendlyReplacementErrorMessage(op.errorCode);
      const partial =
        op.addedSongIds.length > 0 || op.removedSongIds.length > 0
          ? `（云端已确认：添加 ${op.addedSongIds.length} 首，移除 ${op.removedSongIds.length} 首）`
          : "";
      return {
        title: "换歌失败",
        description: `${err}${partial}`
      };
    }
    case "stopped":
      return {
        title: "换歌已终止",
        description: "操作已终止。"
      };
    case "succeeded":
      return {
        title: "换歌成功",
        description: "点歌台已更新。"
      };
  }
}
