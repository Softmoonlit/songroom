import type { approvalDisabledReason } from "../shared/invite-contracts.js";
import type { z } from "zod";

type ApprovalDisabledReasonType = z.infer<typeof approvalDisabledReason>;

export function getFriendlyDecisionFeedback(
  decisionStatus: string,
  nickname: string
): string {
  switch (decisionStatus) {
    case "approved":
      return `已批准：${nickname} 加入房间`;
    case "rejected":
      return `已拒绝：${nickname} 的申请`;
    case "nickname_conflict":
      return `拟用昵称已被占用：${nickname}；申请已终结，请申请人重新提交。`;
    default:
      return "申请状态已更新，请查看最新待处理申请。";
  }
}

export function getFriendlyApprovalDisabledReason(
  reason?: ApprovalDisabledReasonType | string
): string {
  if (!reason) return "";
  switch (reason) {
    case "NICKNAME_TAKEN":
      return "该拟用昵称已被房间内成员占用";
    case "ALREADY_MEMBER":
      return "申请人已是本房间成员";
    case "ROOM_MEMBER_LIMIT":
      return "房间成员人数已达上限";
    case "JOINED_ROOM_LIMIT":
      return "申请人加入的房间数已达上限";
    case "INVITE_RESET":
      return "邀请已重置，该申请已取消";
    default:
      return "当前暂无法批准该申请";
  }
}
