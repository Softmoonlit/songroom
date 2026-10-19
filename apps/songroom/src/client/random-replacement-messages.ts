import type { RandomReplacementOperationView } from "../shared/public-playlist-contracts.js";
import { errorMessageForCode } from "./room-http.js";

const replacementErrorMessages: Record<string, string> = {
  NO_NEW_SONGS: "暂无新歌曲可换。所有成员候选歌曲均已存在于当前点歌台中。",
  EMPTY_CANDIDATES: "暂无可用的候选歌曲。请确保房间内有成员配置了个人歌单且包含歌曲。",
  PREVIEW_INVALIDATED: "点歌台或成员个人歌单已发生变更，请重新生成预览。",
  PREVIEW_NOT_FOUND: "换歌预览已过期或不存在，请重新生成预览。",
  ACCOUNT_PAUSED: "网易云账号已暂停，请联系管理员恢复。",
  PLAYLIST_CONFLICT: "当前点歌台正在执行其他写入操作，请稍候再试。",
  CONCURRENT_OPERATION_LIMIT_EXCEEDED: "你在该房间已有未完成的写操作，请稍候再试。",
  NETEASE_AUTH_REQUIRED: "请房主先完成网易云账号授权。",
  MODULE_ERROR: "网易云服务响应异常，请稍后重试。",
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
        title: "换歌操作已排队",
        description: "已排队，正在等待后台执行换歌…"
      };
    case "processing": {
      let description = "正在处理中…";
      if (op.step === "verified" || op.step === "ready") {
        description = "正在核对点歌台与各成员来源…";
      } else if (op.step === "sending") {
        if (op.currentAction === "add") {
          description = `正在添加新歌曲到点歌台（已添加 ${op.addedSongIds.length} / ${op.targetCount} 首）…`;
        } else if (op.currentAction === "remove") {
          description = `正在从点歌台移除旧歌曲（已移除 ${op.removedSongIds.length} 首）…`;
        } else {
          description = `正在同步云端歌曲增删（目标 ${op.targetCount} 首）…`;
        }
      } else if (op.step === "confirming") {
        description = "正在核验网易云歌单最新歌曲列表与顺序…";
      } else if (op.step === "tagging") {
        description = "正在记录各歌曲的点歌人标签…";
      }
      return {
        title: "正在执行点歌台替换",
        description
      };
    }
    case "awaitingConfirmation":
      return {
        title: "换歌结果待确认",
        description: "部分操作已发送至网易云，正在只读核验最终歌曲。请勿重试。"
      };
    case "waitingAuthorization":
      return {
        title: "等待房主授权",
        description: "房主的网易云授权需要重新确认，正在等待房主恢复授权…"
      };
    case "needsAdministrator":
      return {
        title: "需要管理员处理",
        description: "换歌结果未知，已暂停后续写入，请联系管理员协助处理。"
      };
    case "failed": {
      const err = getFriendlyReplacementErrorMessage(op.errorCode);
      const partial =
        op.addedSongIds.length > 0 || op.removedSongIds.length > 0
          ? `（云端已确认：添加 ${op.addedSongIds.length} 首，移除 ${op.removedSongIds.length} 首）`
          : "";
      return {
        title: "换歌未完成",
        description: `${err}${partial}`
      };
    }
    case "stopped":
      return {
        title: "换歌操作已停止",
        description: "操作已终止。"
      };
    case "succeeded":
      return {
        title: "换歌成功",
        description: "点歌台已更新。请在网易云官方客户端重新载入歌单并点击「播放全部」。"
      };
  }
}
