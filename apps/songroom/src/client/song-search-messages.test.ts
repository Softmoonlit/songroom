import { describe, expect, it } from "vitest";
import {
  getFriendlyPersonalSongAdditionErrorMessage,
  getFriendlyPersonalSongAdditionStatusMessage,
  getFriendlySearchErrorMessage
} from "./song-search-messages.js";

describe("song-search-messages", () => {
  describe("getFriendlyPersonalSongAdditionErrorMessage", () => {
    it("未配置个人歌单给出明确引导提示", () => {
      expect(getFriendlyPersonalSongAdditionErrorMessage("PERSONAL_PLAYLIST_NOT_FOUND")).toContain("尚未配置个人歌单");
    });

    it("已有未完成操作提示等待", () => {
      expect(getFriendlyPersonalSongAdditionErrorMessage("CONCURRENT_OPERATION_LIMIT_EXCEEDED")).toContain("未完成的写操作");
    });

    it("目标冲突提示待确认", () => {
      expect(getFriendlyPersonalSongAdditionErrorMessage("TARGET_BLOCKED")).toContain("待确认的写入操作");
    });

    it("房主未授权提示提醒房主绑定", () => {
      expect(getFriendlyPersonalSongAdditionErrorMessage("NETEASE_AUTH_REQUIRED")).toContain("网易云授权");
    });

    it("账号暂停提示联系管理员", () => {
      expect(getFriendlyPersonalSongAdditionErrorMessage("ACCOUNT_PAUSED")).toContain("账号已暂停");
    });

    it("空或未知错误给出温和提示", () => {
      expect(getFriendlyPersonalSongAdditionErrorMessage(null)).toContain("请稍后重试");
    });
  });

  describe("getFriendlyPersonalSongAdditionStatusMessage", () => {
    it("queued 状态包含歌名和排队说明", () => {
      const msg = getFriendlyPersonalSongAdditionStatusMessage("queued", "晴天");
      expect(msg).toContain("晴天");
      expect(msg).toContain("排队");
    });

    it("processing 状态包含添加中说明", () => {
      const msg = getFriendlyPersonalSongAdditionStatusMessage("processing", "七里香");
      expect(msg).toContain("七里香");
      expect(msg).toContain("正在");
    });

    it("awaitingConfirmation 状态提示核验云端", () => {
      const msg = getFriendlyPersonalSongAdditionStatusMessage("awaitingConfirmation", "稻香");
      expect(msg).toContain("稻香");
      expect(msg).toContain("待确认");
    });

    it("waitingAuthorization 提示等待房主授权", () => {
      const msg = getFriendlyPersonalSongAdditionStatusMessage("waitingAuthorization");
      expect(msg).toContain("等待房主恢复授权");
    });

    it("needsAdministrator 提示需要管理员处理", () => {
      const msg = getFriendlyPersonalSongAdditionStatusMessage("needsAdministrator");
      expect(msg).toContain("管理员");
    });
  });

  describe("getFriendlySearchErrorMessage", () => {
    it("NETEASE_AUTH_REQUIRED 提示需要房主授权", () => {
      expect(getFriendlySearchErrorMessage("NETEASE_AUTH_REQUIRED")).toContain("网易云授权");
    });

    it("ACCOUNT_PAUSED 提示账号暂停", () => {
      expect(getFriendlySearchErrorMessage("ACCOUNT_PAUSED")).toContain("账号已暂停");
    });

    it("NETWORK_ERROR 提示网络连接稍有延迟", () => {
      expect(getFriendlySearchErrorMessage("NETWORK_ERROR")).toContain("网络");
    });
  });
});
