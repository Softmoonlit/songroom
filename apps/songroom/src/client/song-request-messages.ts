import { errorMessageForCode } from "./room-http.js";

/**
 * 遇到风控、限流、网络或排队等异常时，转换为精炼明确的提示
 */
export function getFriendlySongRequestErrorMessage(code?: string | null): string {
  if (!code) return "点歌失败，请稍后重试。";
  switch (code) {
    case "UPSTREAM_QUEUE_FULL":
      return "操作队列已满，请稍后重试。";
    case "RATE_LIMITED":
    case "ACCOUNT_PAUSED":
      return "网易云请求受限，请稍后重试。";
    case "TARGET_BLOCKED":
      return "歌单写入中，请稍后重试。";
    case "DEADLINE":
    case "NETWORK_ERROR":
      return "网络连接超时，正在核验状态。";
    case "AUTH_UNAVAILABLE":
    case "AUTHORIZATION_CHANGED":
    case "ACCOUNT_EMPTY":
      return "网易云授权失效，请前往账号设置检查或重新授权。";
    case "TARGET_PERMISSION":
      return "歌单权限不足，请核对设置。";
    case "MODULE_ERROR":
    case "PROCESS_ERROR":
    case "PARSE_ERROR":
      return "网易云响应异常，请稍后重试。";
    case "INTEGRITY_ERROR":
      return "组件执行异常，请联系管理员。";
    case "PUBLIC_PLAYLIST_NOT_FOUND":
      return "房间尚未创建点歌台。";
    case "PERSONAL_PLAYLIST_NOT_FOUND":
      return "尚未配置个人歌单。";
    case "SOURCE_PLAYLIST_FORBIDDEN":
      return "只能从个人专属歌单点歌。";
    case "SOURCE_SONG_REMOVED":
      return "该歌曲已从你的个人歌单中移除，无法发起点歌。";
    case "SOURCE_PLAYLIST_UNAVAILABLE":
      return "个人歌单暂时不可访问。";
    default:
      return errorMessageForCode(code);
  }
}

/**
 * 针对不同执行阶段的异步操作，提供精炼直接的进度提示
 */
export function getFriendlyOperationStatusMessage(status: string, songName?: string): string {
  switch (status) {
    case "queued":
      return songName
        ? `正在为房间排队添加《${songName}》…`
        : "正在排队添加歌曲…";
    case "processing":
      return songName
        ? `正在为房间添加《${songName}》…`
        : "正在添加歌曲到点歌台…";
    case "awaitingConfirmation":
      return songName
        ? `《${songName}》已提交，正在核验…`
        : "歌曲已提交，正在核验…";
    case "waitingAuthorization":
      return "等待网易云授权恢复…";
    case "needsAdministrator":
      return "操作状态异常，请联系管理员。";
    default:
      return "";
  }
}
