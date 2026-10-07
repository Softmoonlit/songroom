import type { z } from "zod";

export const errorMessages: Record<string, string> = {
  UPSTREAM_QUEUE_FULL: "网易云账号已有 20 项排队或执行中的操作，请等待空位。",
  ACCOUNT_PAUSED: "网易云账号已暂停，请联系管理员明确恢复。",
  TARGET_BLOCKED: "当前歌单目标已阻塞，等待权限处理。",
  RATE_LIMITED: "网易云风控或频繁请求已暂停整个账号，请联系管理员。",
  ACCOUNT_EMPTY: "网易云返回的账号为空，请房主恢复授权。",
  TARGET_PERMISSION: "当前歌单目标权限不足，等待处理。",
  NETWORK_ERROR: "网易云网络请求失败，请查看操作的确认状态。",
  MODULE_ERROR: "网易云接口执行异常，请查看操作的确认状态。",
  DEADLINE: "网易云请求超时，请查看操作的确认状态。",
  PROCESS_ERROR: "网易云请求执行中断，请查看操作的确认状态。",
  PARSE_ERROR: "网易云返回的结果无法识别，请查看操作的确认状态。",
  INTEGRITY_ERROR: "网易云组件校验失败，请联系管理员。",
  SESSION_REQUIRED: "点歌台会话已失效，请重新登录。",
  ROOM_UNAVAILABLE: "房间不可访问，请返回房间列表。",
  AUTHORIZATION_CHANGED: "网易云授权已变化，请重新读取并确认身份。",
  AUTH_UNAVAILABLE: "网易云授权不可用，请前往账号设置检查绑定。",
  NETEASE_AUTH_REQUIRED: "请先在账号设置中绑定有效的网易云账号。",
  ACCOUNT_MISMATCH: "网易云身份已变化，请重新读取并确认身份。",
  OWNED_ROOM_LIMIT: "最多可以自建 3 个房间。",
  JOINED_ROOM_LIMIT: "最多可以归属 10 个房间。",
  GLOBAL_ROOM_LIMIT: "全站房间数量已达到上限，请稍后再试。",
  OWNER_ONLY: "只有房主可以执行此操作。",
  SELF_ONLY: "只能修改自己的房间昵称。",
  NICKNAME_TAKEN: "这个房间昵称已被使用，请换一个昵称。",
  NICKNAME_CONFLICT: "这个房间昵称已被使用，请换一个昵称。",
  ROOM_MEMBER_LIMIT: "这个房间已有 10 名成员，暂时不能批准加入。",
  GLOBAL_MEMBER_LIMIT: "全站成员数量已达到上限，请稍后再试。",
  APPLICATION_NOT_PENDING: "这份申请已不再等待处理，请查看最新申请。",
  APPLICATION_UNAVAILABLE: "申请不可查看，请返回房间列表。",
  APPLICATION_FORBIDDEN: "你无权审批这个房间的申请。",
  INVITE_RESET: "邀请已重置，这份申请已失效。",
  ROOM_OWNER_REQUIRED: "只有房主可以执行此操作。",
  INVALID_INPUT: "请输入有效的房间名称和昵称。",
  IDEMPOTENCY_CONFLICT: "此次操作内容已变化，请重新填写后提交。",
  IDEMPOTENCY_KEY_EXPIRED: "此次操作标识已过期，请重新填写后提交。"
};
export class RoomRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function errorMessageForCode(code: string) {
  return errorMessages[code] ?? "暂时无法完成房间请求，请稍后重试。";
}
export function errorMessage(error: unknown) {
  return error instanceof RoomRequestError ? errorMessageForCode(error.code)
    : "暂时无法完成房间请求，请稍后重试。";
}
export function request<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: unknown,
  method?: string
): Promise<T> {
  return apiRequest(`/rooms${path}`, schema, signal, body, method);
}

export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: unknown,
  method?: string
): Promise<T> {
  const httpMethod = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(`/api${path}`, {
    method: httpMethod,
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const code =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "object" &&
      payload.error !== null &&
      "code" in payload.error &&
      typeof payload.error.code === "string"
        ? payload.error.code
        : "UNKNOWN";
    throw new RoomRequestError(code);
  }
  return schema.parse(payload);
}
export const queryOptions = { retry: false, refetchOnWindowFocus: false, refetchOnMount: "always" as const };
