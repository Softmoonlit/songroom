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
        "所选成员的歌单暂无歌曲。"
      );
      expect(getFriendlyReplacementErrorMessage("INVALID_MEMBER")).toBe(
        "所选成员不存在或已离开房间。"
      );
      expect(getFriendlyReplacementErrorMessage("MEMBER_PLAYLIST_NOT_CONFIGURED")).toBe(
        "所选成员尚未配置个人歌单。"
      );
      expect(getFriendlyReplacementErrorMessage("PREVIEW_INVALIDATED")).toBe(
        "点歌台或成员个人歌单已发生变更，请重新生成预览。"
      );
      expect(getFriendlyReplacementErrorMessage("PREVIEW_NOT_FOUND")).toBe(
        "换歌预览已过期或不存在，请重新生成预览。"
      );
      expect(getFriendlyReplacementErrorMessage("ACCOUNT_PAUSED")).toBe(
        "网易云账号已暂停，请联系管理员恢复。"
      );
      expect(getFriendlyReplacementErrorMessage("PLAYLIST_CONFLICT")).toBe(
        "当前点歌台正在执行其他写入操作，请稍候再试。"
      );
      expect(getFriendlyReplacementErrorMessage("CONCURRENT_OPERATION_LIMIT_EXCEEDED")).toBe(
        "你在该房间已有未完成的写操作，请稍候再试。"
      );
      expect(getFriendlyReplacementErrorMessage("NETEASE_AUTH_REQUIRED")).toBe(
        "请房主先完成网易云账号授权。"
      );
      expect(getFriendlyReplacementErrorMessage("MODULE_ERROR")).toBe(
        "网易云服务响应异常，请稍后重试。"
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
      expect(res.title).toBe("换歌操作已排队");
      expect(res.description).toContain("等待后台执行换歌");
    });

    it("handles processing steps", () => {
      expect(
        getFriendlyReplacementOperationStatus({ ...baseOp, status: "processing", step: "verified" }).description
      ).toContain("正在核对点歌台与各成员来源");

      expect(
        getFriendlyReplacementOperationStatus({
          ...baseOp,
          status: "processing",
          step: "sending",
          currentAction: "add",
          addedSongIds: ["s1", "s2", "s3"],
          targetCount: 10
        }).description
      ).toBe("正在添加歌曲到点歌台（已添加 3 / 10 首）…");

      expect(
        getFriendlyReplacementOperationStatus({
          ...baseOp,
          status: "processing",
          step: "sending",
          currentAction: "remove",
          removedSongIds: ["old1", "old2"]
        }).description
      ).toBe("正在从点歌台移除旧歌曲（已移除 2 首）…");

      expect(
        getFriendlyReplacementOperationStatus({ ...baseOp, status: "processing", step: "confirming" }).description
      ).toContain("正在核验网易云歌单最新歌曲列表与顺序");

      expect(
        getFriendlyReplacementOperationStatus({ ...baseOp, status: "processing", step: "tagging" }).description
      ).toContain("正在记录各歌曲的点歌人标签");
    });

    it("handles awaitingConfirmation", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "awaitingConfirmation", step: "unknown" });
      expect(res.title).toBe("换歌结果待确认");
      expect(res.description).toContain("正在只读核验最终歌曲");
    });

    it("handles waitingAuthorization", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "waitingAuthorization" });
      expect(res.title).toBe("等待房主授权");
      expect(res.description).toContain("等待房主恢复授权");
    });

    it("handles needsAdministrator", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "needsAdministrator" });
      expect(res.title).toBe("需要管理员处理");
      expect(res.description).toContain("已暂停后续写入");
    });

    it("handles failed without partial progress", () => {
      const res = getFriendlyReplacementOperationStatus({
        ...baseOp,
        status: "failed",
        errorCode: "DEADLINE",
        addedSongIds: [],
        removedSongIds: []
      });
      expect(res.title).toBe("换歌未完成");
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
      expect(res.title).toBe("换歌未完成");
      expect(res.description).toBe("网络连接失败，请稍后重试。（云端已确认：添加 2 首，移除 1 首）");
    });

    it("handles succeeded", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "succeeded", step: "succeeded" });
      expect(res.title).toBe("换歌成功");
      expect(res.description).toContain("播放全部");
    });

    it("handles stopped", () => {
      const res = getFriendlyReplacementOperationStatus({ ...baseOp, status: "stopped", step: "stopped" });
      expect(res.title).toBe("换歌操作已停止");
      expect(res.description).toBe("操作已终止。");
    });
  });
});
