import type { z } from "zod";

export const errorMessages: Record<string, string> = {
  SESSION_REQUIRED: "点歌台会话已失效，请重新登录。",
  ROOM_UNAVAILABLE: "房间不可访问，请返回房间列表。",
  AUTHORIZATION_CHANGED: "网易云授权已变化，请重新读取并确认身份。",
  AUTH_UNAVAILABLE: "网易云授权不可用，请前往账号设置检查绑定。",
  NETEASE_AUTH_REQUIRED: "请先在账号设置中绑定有效的网易云账号。",
  ACCOUNT_MISMATCH: "网易云身份已变化，请重新读取并确认身份。",
  OWNED_ROOM_LIMIT: "最多可以自建 3 个房间。",
  JOINED_ROOM_LIMIT: "最多可以归属 10 个房间。",
  GLOBAL_ROOM_LIMIT: "全站房间数量已达到上限，请稍后再试。",
  INVALID_INPUT: "请输入有效的房间名称和昵称。",
  IDEMPOTENCY_CONFLICT: "此次操作内容已变化，请重新填写后提交。",
  IDEMPOTENCY_KEY_EXPIRED: "此次操作标识已过期，请重新填写后提交。"
};
export class RoomRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function errorMessage(error: unknown) {
  return error instanceof RoomRequestError && errorMessages[error.code]
    ? errorMessages[error.code]
    : "暂时无法完成房间请求，请稍后重试。";
}
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: unknown
): Promise<T> {
  const response = await fetch(`/api/rooms${path}`, {
    method: body === undefined ? "GET" : "POST",
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
