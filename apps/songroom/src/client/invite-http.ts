import { errorMessage, RoomRequestError } from "./room-http";
export { apiRequest as inviteRequest } from "./room-http";

const messages: Record<string, string> = {
  INVITE_INVALID: "邀请码无效，请检查后重新输入。",
  INVITE_RESET: "邀请已重置，请向房主索取新的邀请码。",
  INVITE_VERSION_CONFLICT: "申请情况已变化，请查看最新影响后重新确认。",
  ALREADY_MEMBER: "你已经是这个房间的成员。",
  APPLICATION_PENDING: "你已有这个房间的待处理申请，请查看原申请。",
  ACCOUNT_APPLICATION_LIMIT: "你最多可以有 3 份待处理申请，请先撤回一份或等待审批。",
  ROOM_APPLICATION_LIMIT: "这个房间已有 10 份待处理申请，请等待房主处理后再申请。",
  APPLICATION_UNAVAILABLE: "申请不可查看，请返回房间列表。",
  APPLICATION_NOT_PENDING: "这份申请已不再等待处理，请重新读取状态。",
  INVITE_FORBIDDEN: "邀请不可查看，请返回房间列表。",
  SESSION_EXPIRED: "账号会话已过期，请重新登录。",
  UNAUTHORIZED: "账号会话无效，请重新登录。",
  IDEMPOTENCY_CONFLICT: "提交内容已变化，请检查后重新提交。",
  IDEMPOTENCY_KEY_EXPIRED: "此次提交已失效，请检查当前状态后重新提交。",
  INVALID_INPUT: "请检查邀请码和房间昵称。"
};

export function inviteErrorMessage(error: unknown) {
  return error instanceof RoomRequestError && messages[error.code]
    ? messages[error.code]
    : errorMessage(error);
}
