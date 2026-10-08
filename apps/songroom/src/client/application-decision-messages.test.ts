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
        "昵称已被占用：小李；申请已终结，请申请人重新提交。"
      );
    });
  });

  describe("getFriendlyApprovalDisabledReason", () => {
    it("将审批禁止码转换为友好文本", () => {
      expect(getFriendlyApprovalDisabledReason("NICKNAME_TAKEN")).toBe("这个房间昵称已被使用，请换一个昵称。");
      expect(getFriendlyApprovalDisabledReason("ALREADY_MEMBER")).toBe("申请人已是本房间成员");
      expect(getFriendlyApprovalDisabledReason("ROOM_MEMBER_LIMIT")).toBe("这个房间已有 10 名成员，暂时不能批准加入。");
      expect(getFriendlyApprovalDisabledReason("JOINED_ROOM_LIMIT")).toBe("最多可以归属 10 个房间。");
      expect(getFriendlyApprovalDisabledReason("INVITE_RESET")).toBe("邀请已重置，这份申请已失效。");
      expect(getFriendlyApprovalDisabledReason(undefined)).toBe("");
    });
  });
});
