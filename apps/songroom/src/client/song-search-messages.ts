import { errorMessageForCode } from "./room-http.js";

/**
 * 个人歌单添加歌曲业务异常与错误提示
 */
export function getFriendlyPersonalSongAdditionErrorMessage(code?: string | null): string {
  if (!code) return "添加歌曲遇到了一点小问题，请稍后重试。";
  switch (code) {
    case "PERSONAL_PLAYLIST_NOT_FOUND":
      return "尚未配置个人歌单，无法添加歌曲。请先在「我的歌单」创建专用歌单。";
    case "CONCURRENT_OPERATION_LIMIT_EXCEEDED":
      return "你在该房间已有未完成的写操作，请等待处理完成。";
    case "TARGET_BLOCKED":
      return "个人歌单当前有待确认的写入操作，请稍候再试。";
    case "NETEASE_AUTH_REQUIRED":
    case "AUTH_UNAVAILABLE":
    case "AUTHORIZATION_CHANGED":
      return "房主的网易云授权需要重新连接，请提醒房主更新授权。";
    case "ACCOUNT_PAUSED":
      return "房主网易云账号已暂停，请联系管理员恢复。";
    case "UPSTREAM_QUEUE_FULL":
      return "网易云账号操作队列已满，请稍候片刻再试。";
    case "RATE_LIMITED":
      return "音乐平台访问稍显频繁，已暂时开启流控保护，请稍候再试。";
    case "TARGET_PERMISSION":
      return "个人歌单权限异常或已被设为私密/删除，请核对歌单状态。";
    case "MODULE_ERROR":
    case "PROCESS_ERROR":
    case "PARSE_ERROR":
      return "音乐平台响应有些不稳定，请稍后重试。";
    case "DEADLINE":
    case "NETWORK_ERROR":
      return "网络连接稍有延迟，请稍后查看个人歌单。";
    default:
      return errorMessageForCode(code);
  }
}

/**
 * 个人歌单异步添加操作状态自然化提示
 */
export function getFriendlyPersonalSongAdditionStatusMessage(status: string, songName?: string): string {
  switch (status) {
    case "queued":
      return songName
        ? `《${songName}》已排队，等待添加到个人歌单…`
        : "添加操作已排队，等待处理…";
    case "processing":
      return songName
        ? `正在将《${songName}》添加到个人歌单并同步…`
        : "正在添加歌曲到个人歌单…";
    case "awaitingConfirmation":
      return songName
        ? `《${songName}》添加结果待确认，正在核验网易云歌单，请勿重复添加。`
        : "添加结果待确认，正在核验网易云歌单，请勿重复添加。";
    case "waitingAuthorization":
      return "房主的网易云授权需要重新确认，正在等待房主恢复授权…";
    case "needsAdministrator":
      return "添加操作需要管理员协助处理，请联系房主或管理员。";
    default:
      return "";
  }
}

/**
 * 搜索异常温和提示
 */
export function getFriendlySearchErrorMessage(code?: string | null): string {
  if (!code) return "搜索遇到了一点小问题，请稍后重试。";
  switch (code) {
    case "NETEASE_AUTH_REQUIRED":
    case "AUTH_UNAVAILABLE":
    case "AUTHORIZATION_CHANGED":
      return "房主尚未完成网易云授权，请提醒房主绑定。";
    case "ACCOUNT_PAUSED":
      return "房主网易云账号已暂停，请联系管理员恢复。";
    case "UPSTREAM_QUEUE_FULL":
      return "搜索请求较为频繁，正在排队中，请稍后重试。";
    case "RATE_LIMITED":
      return "搜索请求过频，请稍作休息后再试。";
    case "DEADLINE":
    case "NETWORK_ERROR":
      return "网络连接稍有延迟，请稍后重试搜索。";
    case "MODULE_ERROR":
    case "PROCESS_ERROR":
    case "PARSE_ERROR":
      return "音乐服务响应异常，请稍后重试。";
    default:
      return errorMessageForCode(code);
  }
}
