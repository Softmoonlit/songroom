import { describe, expect, it } from "vitest";
import {
  getFriendlyDecisionFeedback,
  getFriendlyApprovalDisabledReason
} from "./application-decision-messages.js";

describe("application-decision-messages", () => {
  describe("getFriendlyDecisionFeedback", () => {
    it("生成批准、拒绝和冲突的人性化反馈", () => {
      expect(getFriendlyDecisionFeedback("approved", "小李")).toBe("已批准：小李 加入房间");
      expect(getFriendlyDecisionFeedback("rejected", "小李")).toBe("已拒绝：小李 的申请");
      expect(getFriendlyDecisionFeedback("nickname_conflict", "小李")).toBe(
        "拟用昵称已被占用：小李；申请已终结，请申请人重新提交。"
      );
    });

    it("未知状态返回兜底提示", () => {
      expect(getFriendlyDecisionFeedback("unknown", "小李")).toBe(
        "申请状态已更新，请查看最新待处理申请。"
      );
    });
  });

  describe("getFriendlyApprovalDisabledReason", () => {
    it("将审批禁止码转换为友好文本", () => {
      expect(getFriendlyApprovalDisabledReason("NICKNAME_TAKEN")).toBe("该拟用昵称已被房间内成员占用");
      expect(getFriendlyApprovalDisabledReason("ALREADY_MEMBER")).toBe("申请人已是本房间成员");
      expect(getFriendlyApprovalDisabledReason("ROOM_MEMBER_LIMIT")).toBe("房间成员人数已达上限");
      expect(getFriendlyApprovalDisabledReason("JOINED_ROOM_LIMIT")).toBe("申请人加入的房间数已达上限");
      expect(getFriendlyApprovalDisabledReason("INVITE_RESET")).toBe("邀请已重置，该申请已取消");
    });

    it("空或未知码返回兜底提示", () => {
      expect(getFriendlyApprovalDisabledReason(undefined)).toBe("");
      expect(getFriendlyApprovalDisabledReason("OTHER_REASON")).toBe("当前暂无法批准该申请");
    });
  });
});
