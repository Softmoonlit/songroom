import { describe, expect, it } from "vitest";
import { getApplicationTimeline } from "./application-timeline.js";

describe("application-timeline", () => {
  it("处理 pending 状态（等待房主审批中）", () => {
    const timeline = getApplicationTimeline("pending", "阿强");
    expect(timeline.canReapply).toBe(false);

    // 第一步：提交申请
    expect(timeline.steps[0].step).toBe(1);
    expect(timeline.steps[0].status).toBe("completed");
    expect(timeline.steps[0].description).toContain("阿强");

    // 第二步：房主审批
    expect(timeline.steps[1].step).toBe(2);
    expect(timeline.steps[1].status).toBe("current");
    expect(timeline.steps[1].title).toBe("等待房主审批");

    // 第三步：进入房间
    expect(timeline.steps[2].step).toBe(3);
    expect(timeline.steps[2].status).toBe("pending");
  });

  it("处理 approved 状态（获批通过）", () => {
    const timeline = getApplicationTimeline("approved", "阿强");
    expect(timeline.canReapply).toBe(false);

    expect(timeline.steps[0].status).toBe("completed");
    expect(timeline.steps[1].status).toBe("completed");
    expect(timeline.steps[1].title).toBe("房主已批准");

    expect(timeline.steps[2].status).toBe("completed");
    expect(timeline.steps[2].title).toBe("成功进入房间");
  });

  it("处理 rejected 状态（已被拒绝，支持重新申请）", () => {
    const timeline = getApplicationTimeline("rejected", "阿强");
    expect(timeline.canReapply).toBe(true);

    expect(timeline.steps[0].status).toBe("completed");
    expect(timeline.steps[1].status).toBe("failed");
    expect(timeline.steps[1].title).toBe("房主已拒绝申请");
    expect(timeline.steps[2].status).toBe("failed");
  });

  it("处理 nickname_conflict 状态（昵称冲突，支持重新申请）", () => {
    const timeline = getApplicationTimeline("nickname_conflict", "阿强");
    expect(timeline.canReapply).toBe(true);

    expect(timeline.steps[1].status).toBe("failed");
    expect(timeline.steps[1].title).toContain("昵称已被占用");
  });

  it("处理 withdrawn 和 cancelled 状态", () => {
    const withdrawn = getApplicationTimeline("withdrawn", "阿强");
    expect(withdrawn.steps[1].title).toBe("申请已撤回");
    expect(withdrawn.canReapply).toBe(true);

    const cancelled = getApplicationTimeline("cancelled", "阿强");
    expect(cancelled.steps[1].title).toBe("邀请已重置，申请已取消");
    expect(cancelled.canReapply).toBe(true);
  });
});
