import { describe, expect, it } from "vitest";
import {
  getFriendlyDecisionFeedback,
  getFriendlyApprovalDisabledReason
} from "./application-decision-messages.js";
import { getApplicationTimeline } from "./application-timeline.js";

describe("application-approval-workflow", () => {
  it("审批流处理结果保留测试：批准申请后生成正确反馈，并且与待处理申请分离", () => {
    const rawApplications = [
      { id: "app-1", nickname: "小明" },
      { id: "app-2", nickname: "小红" }
    ];

    // 模拟批准 app-1
    const processedItems = [
      {
        id: "app-1",
        nickname: "小明",
        decision: "approve" as const,
        status: "approved" as const,
        message: getFriendlyDecisionFeedback("approved", "小明")
      }
    ];

    // 活跃列表应剔除已处理项，保证已处理项单独留存于反馈视图中
    const processedIds = new Set(processedItems.map(item => item.id));
    const activeApplications = rawApplications.filter(app => !processedIds.has(app.id));

    expect(activeApplications).toHaveLength(1);
    expect(activeApplications[0]!.id).toBe("app-2");

    // 反馈列表中小明已处于批准状态且包含提示
    expect(processedItems[0]!.message).toBe("已批准：小明 加入房间");
    expect(processedItems[0]!.status).toBe("approved");
  });

  it("审批流拒绝测试：拒绝申请后生成正确拒绝反馈", () => {
    const feedback = getFriendlyDecisionFeedback("rejected", "张三");
    expect(feedback).toBe("已拒绝：张三 的申请");
  });

  it("申请人端审批通过感知：时间轴自动完成各步骤", () => {
    const timeline = getApplicationTimeline("approved", "小明");
    expect(timeline.steps.every(step => step.status === "completed")).toBe(true);
    expect(timeline.canReapply).toBe(false);
  });
});
