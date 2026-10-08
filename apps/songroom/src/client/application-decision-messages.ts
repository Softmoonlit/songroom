import type { approvalDisabledReason, joinApplicationStatus } from "../shared/invite-contracts.js";
import type { z } from "zod";

type JoinApplicationStatusType = z.infer<typeof joinApplicationStatus>;
type ApprovalDisabledReasonType = z.infer<typeof approvalDisabledReason>;

export function getFriendlyDecisionFeedback(
  decisionStatus: JoinApplicationStatusType,
  nickname: string
): string {
  switch (decisionStatus) {
    case "approved":
      return `已批准：${nickname} 加入房间`;
    case "rejected":
      return `已拒绝：${nickname} 的申请`;
    case "nickname_conflict":
      return `昵称已被占用：${nickname}；申请已终结，请申请人重新提交。`;
    case "pending":
    case "withdrawn":
    case "cancelled":
      return `申请状态：${decisionStatus}（${nickname}）`;
  }
}

export function getFriendlyApprovalDisabledReason(
  reason?: ApprovalDisabledReasonType
): string {
  if (!reason) return "";
  switch (reason) {
    case "NICKNAME_TAKEN":
      return "这个房间昵称已被使用，请换一个昵称。";
    case "ALREADY_MEMBER":
      return "申请人已是本房间成员";
    case "ROOM_MEMBER_LIMIT":
      return "这个房间已有 10 名成员，暂时不能批准加入。";
    case "JOINED_ROOM_LIMIT":
      return "申请人加入的房间数已达上限";
    case "INVITE_RESET":
      return "邀请已重置，该申请已取消";
  }
}
