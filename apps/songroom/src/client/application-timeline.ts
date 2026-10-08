import type { joinApplicationStatus } from "../shared/invite-contracts.js";
import type { z } from "zod";

export type JoinApplicationStatusType = z.infer<typeof joinApplicationStatus>;
export type TimelineStepStatus = "completed" | "current" | "pending" | "failed";

export interface TimelineStep {
  step: number;
  title: string;
  description: string;
  status: TimelineStepStatus;
}

export interface ApplicationTimelineView {
  badgeLabel: string;
  steps: [TimelineStep, TimelineStep, TimelineStep];
  canReapply: boolean;
}

export function getApplicationTimeline(
  status: JoinApplicationStatusType,
  nickname: string
): ApplicationTimelineView {
  const step1: TimelineStep = {
    step: 1,
    title: "提交申请",
    description: `拟用昵称「${nickname}」，申请已提交`,
    status: "completed"
  };

  let step2: TimelineStep;
  let step3: TimelineStep;
  let badgeLabel: string;
  let canReapply = false;

  switch (status) {
    case "pending":
      badgeLabel = "等待房主审批";
      step2 = {
        step: 2,
        title: "等待房主审批",
        description: "房主审批通过后将自动进入房间",
        status: "current"
      };
      step3 = {
        step: 3,
        title: "进入房间",
        description: "审批通过后可参与点歌",
        status: "pending"
      };
      break;

    case "approved":
      badgeLabel = "申请已获批";
      step2 = {
        step: 2,
        title: "房主已批准",
        description: "房主已同意你的加入申请",
        status: "completed"
      };
      step3 = {
        step: 3,
        title: "成功进入房间",
        description: "欢迎加入！正在进入房间点歌台…",
        status: "completed"
      };
      break;

    case "rejected":
      badgeLabel = "房主已拒绝申请";
      step2 = {
        step: 2,
        title: "房主已拒绝申请",
        description: "房主未批准本次加入申请",
        status: "failed"
      };
      step3 = {
        step: 3,
        title: "未进入房间",
        description: "申请未通过",
        status: "failed"
      };
      canReapply = true;
      break;

    case "withdrawn":
      badgeLabel = "申请已撤回";
      step2 = {
        step: 2,
        title: "申请已撤回",
        description: "你已主动撤回加入申请",
        status: "failed"
      };
      step3 = {
        step: 3,
        title: "未进入房间",
        description: "申请已撤回",
        status: "failed"
      };
      canReapply = true;
      break;

    case "cancelled":
      badgeLabel = "邀请已重置，申请已取消";
      step2 = {
        step: 2,
        title: "邀请已重置，申请已取消",
        description: "原邀请码已重置失效",
        status: "failed"
      };
      step3 = {
        step: 3,
        title: "未进入房间",
        description: "邀请已失效",
        status: "failed"
      };
      canReapply = true;
      break;

    case "nickname_conflict":
      badgeLabel = "拟用昵称已被占用，申请已终结，请重新提交";
      step2 = {
        step: 2,
        title: "拟用昵称已被占用",
        description: "拟用昵称已被房间内成员占用，请重新提交",
        status: "failed"
      };
      step3 = {
        step: 3,
        title: "未进入房间",
        description: "需更换昵称重新申请",
        status: "failed"
      };
      canReapply = true;
      break;
  }

  return {
    badgeLabel,
    steps: [step1, step2, step3],
    canReapply
  };
}
