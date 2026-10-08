import { errorMessageForCode } from "./room-http.js";

/**
 * 遇到风控、限流、网络或排队等异常时，转换为温和易懂的情感化提示
 */
export function getFriendlySongRequestErrorMessage(code?: string | null): string {
  if (!code) return "点歌遇到了一点小问题，请稍后重试。";
  switch (code) {
    case "UPSTREAM_QUEUE_FULL":
      return "当前点歌的小伙伴较多，通道正在有序排队中，请稍候片刻再试。";
    case "RATE_LIMITED":
    case "ACCOUNT_PAUSED":
      return "音乐平台访问稍显频繁，已暂时开启流控保护，请稍作休息后再试。";
    case "TARGET_BLOCKED":
      return "前一首歌曲正在写入歌单，请稍等数秒再点下一首。";
    case "DEADLINE":
    case "NETWORK_ERROR":
      return "网络连接稍有延迟，我们正在确认入单状态，请稍后查看歌单。";
    case "AUTH_UNAVAILABLE":
    case "AUTHORIZATION_CHANGED":
    case "ACCOUNT_EMPTY":
      return "房主的网易云授权需要重新连接，请提醒房主更新授权。";
    case "TARGET_PERMISSION":
      return "歌单写入权限异常，请联系房主核对歌单设置。";
    case "MODULE_ERROR":
    case "PROCESS_ERROR":
    case "PARSE_ERROR":
      return "音乐平台响应有些不稳定，请稍后重试或刷新歌单。";
    case "INTEGRITY_ERROR":
      return "音乐组件执行异常，请联系管理员协助处理。";
    default:
      return errorMessageForCode(code);
  }
}

/**
 * 针对不同执行阶段的异步操作，提供自然连贯的人性化进度提示
 */
export function getFriendlyOperationStatusMessage(status: string, songName?: string): string {
  switch (status) {
    case "queued":
      return songName
        ? `《${songName}》已提交，正在排队等待网易云处理…`
        : "点歌已提交，正在排队等待网易云处理…";
    case "processing":
      return songName
        ? `正在为房间添加《${songName}》并同步到网易云…`
        : "正在为房间添加歌曲并同步到网易云…";
    case "awaitingConfirmation":
      return songName
        ? `《${songName}》已提交网易云，正在等待云端确认，请稍后刷新查看。`
        : "歌曲已提交网易云，正在等待云端确认，请稍后刷新查看。";
    case "waitingAuthorization":
      return "房主的网易云授权需要重新确认，正在等待房主恢复授权…";
    case "needsAdministrator":
      return "点歌操作需要管理员协助处理，请联系房主或管理员。";
    default:
      return "";
  }
}
