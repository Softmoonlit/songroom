import { describe, expect, it } from "vitest";
import type { RandomReplacementOperationView } from "../shared/public-playlist-contracts.js";
import {
  getFriendlyReplacementErrorMessage,
  getFriendlyReplacementOperationStatus
} from "./random-replacement-messages.js";

describe("random-replacement-messages", () => {
  describe("getFriendlyReplacementErrorMessage", () => {
    it("returns friendly text for known error codes", () => {
      expect(getFriendlyReplacementErrorMessage("EMPTY_CANDIDATES")).toBe(
        "所选成员歌单暂无歌曲。"
      );
      expect(getFriendlyReplacementErrorMessage("INVALID_MEMBER")).toBe(
        "所选成员不存在或已离开。"
      );
      expect(getFriendlyReplacementErrorMessage("MEMBER_PLAYLIST_NOT_CONFIGURED")).toBe(
        "所选成员未配置个人歌单。"
      );
      expect(getFriendlyReplacementErrorMessage("PREVIEW_INVALIDATED")).toBe(
        "歌单已变更，请重新抽选。"
      );
      expect(getFriendlyReplacementErrorMessage("PREVIEW_NOT_FOUND")).toBe(
        "抽选预览已失效，请重新抽选。"
      );
      expect(getFriendlyReplacementErrorMessage("ACCOUNT_PAUSED")).toBe(
        "网易云账号已暂停，请联系管理员。"
      );
      expect(getFriendlyReplacementErrorMessage("PLAYLIST_CONFLICT")).toBe(
        "歌单正在执行其他写入，请稍候。"
      );
      expect(getFriendlyReplacementErrorMessage("CONCURRENT_OPERATION_LIMIT_EXCEEDED")).toBe(
        "已有未完成的操作，请稍候。"
      );
      expect(getFriendlyReplacementErrorMessage("NETEASE_AUTH_REQUIRED")).toBe(
        "需要房主完成网易云授权。"
      );
      expect(getFriendlyReplacementErrorMessage("MODULE_ERROR")).toBe(
        "网易云接口异常，请稍后重试。"
      );
      expect(getFriendlyReplacementErrorMessage("NETWORK_ERROR")).toBe(
        "网络连接失败，请稍后重试。"
      );
      expect(getFriendlyReplacementErrorMessage("DEADLINE")).toBe(
        "网易云请求超时，请稍后重试。"
      );
      expect(getFriendlyReplacementErrorMessage("RATE_LIMITED")).toBe(
        "网易云请求受限，请稍后重试。"
      );
    });

    it("falls back to generic error text when code is null or unknown", () => {
      expect(getFriendlyReplacementErrorMessage(null)).toBe("操作执行失败，请稍后重试。");
      expect(getFriendlyReplacementErrorMessage("UNKNOWN_FOO")).toBe("暂时无法完成房间请求，请稍后重试。");
    });
  });

  describe("getFriendlyReplacementOperationStatus", () => {
    const baseOp: RandomReplacementOperationView = {
      id: "018f0000-0000-7000-0000-000000000001",
      roomId: "018f0000-0000-7000-0000-000000000002",
      status: "queued",
      step: "ready",
      targetCount: 10,
      targetSongIds: ["s1", "s2"],
      addedSongIds: [],
      removedSongIds: [],
      tagConfirmed: false,
      currentAction: null,
      currentSongId: null,
      errorCode: null,
      version: 1
    };

    it("handles queued status", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "queued" });
      expect(res.title).toBe("换歌已排队");
      expect(res.description).toBe("正在排队处理…");
    });

    it("handles processing steps", () => {
      expect(
        getFriendlyReplacementOperationStatus({ ...baseOp, status: "processing", step: "verified" }).description
      ).toBe("正在核对来源…");

      expect(
        getFriendlyReplacementOperationStatus({
          ...baseOp,
          status: "processing",
          step: "sending",
          currentAction: "add",
          addedSongIds: ["s1", "s2", "s3"],
          targetCount: 10
        }).description
      ).toBe("正在添加新歌曲（已添加 3 / 10 首）…");

      expect(
        getFriendlyReplacementOperationStatus({
          ...baseOp,
          status: "processing",
          step: "sending",
          currentAction: "remove",
          removedSongIds: ["old1", "old2"]
        }).description
      ).toBe("正在移除旧歌曲（已移除 2 首）…");

      expect(
        getFriendlyReplacementOperationStatus({ ...baseOp, status: "processing", step: "confirming" }).description
      ).toBe("正在核验最新歌单与顺序…");

      expect(
        getFriendlyReplacementOperationStatus({ ...baseOp, status: "processing", step: "tagging" }).description
      ).toBe("正在记录点歌人标签…");
    });

    it("handles awaitingConfirmation", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "awaitingConfirmation", step: "unknown" });
      expect(res.title).toBe("换歌结果待确认");
      expect(res.description).toBe("已提交网易云，正在核验最终状态，请勿重试。");
    });

    it("handles waitingAuthorization", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "waitingAuthorization" });
      expect(res.title).toBe("等待房主授权");
      expect(res.description).toBe("需要房主重新授权网易云账号。");
    });

    it("handles needsAdministrator", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "needsAdministrator" });
      expect(res.title).toBe("需要管理员处理");
      expect(res.description).toBe("换歌状态异常，请联系管理员处理。");
    });

    it("handles failed without partial progress", () => {
      const res = getFriendlyReplacementOperationStatus({
        ...baseOp,
        status: "failed",
        errorCode: "DEADLINE",
        addedSongIds: [],
        removedSongIds: []
      });
      expect(res.title).toBe("换歌失败");
      expect(res.description).toBe("网易云请求超时，请稍后重试。");
    });

    it("handles failed with partial progress", () => {
      const res = getFriendlyReplacementOperationStatus({
        ...baseOp,
        status: "failed",
        errorCode: "NETWORK_ERROR",
        addedSongIds: ["s1", "s2"],
        removedSongIds: ["old1"]
      });
      expect(res.title).toBe("换歌失败");
      expect(res.description).toBe("网络连接失败，请稍后重试。（云端已确认：添加 2 首，移除 1 首）");
    });

    it("handles succeeded", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "succeeded", step: "succeeded" });
      expect(res.title).toBe("换歌成功");
      expect(res.description).toBe("点歌台已更新。");
    });

    it("handles stopped", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "stopped", step: "stopped" });
      expect(res.title).toBe("换歌已终止");
      expect(res.description).toBe("操作已终止。");
    });
  });
});
