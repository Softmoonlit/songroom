import { describe, expect, it } from "vitest";
import {
  getFriendlySongRequestErrorMessage,
  getFriendlyOperationStatusMessage
} from "./song-request-messages.js";

describe("song-request-messages", () => {
  describe("getFriendlySongRequestErrorMessage", () => {
    it("将排队与限流等系统错误码转换为温和人性化提示", () => {
      // 队列占满
      expect(getFriendlySongRequestErrorMessage("UPSTREAM_QUEUE_FULL")).toBe(
        "当前点歌的小伙伴较多，通道正在有序排队中，请稍候片刻再试。"
      );

      // 风控或频控保护
      expect(getFriendlySongRequestErrorMessage("RATE_LIMITED")).toBe(
        "音乐平台访问稍显频繁，已暂时开启流控保护，请稍作休息后再试。"
      );
      expect(getFriendlySongRequestErrorMessage("ACCOUNT_PAUSED")).toBe(
        "音乐平台访问稍显频繁，已暂时开启流控保护，请稍作休息后再试。"
      );

      // 目标写冲突锁定
      expect(getFriendlySongRequestErrorMessage("TARGET_BLOCKED")).toBe(
        "前一首歌曲正在写入歌单，请稍等数秒再点下一首。"
      );

      // 网络与超时
      expect(getFriendlySongRequestErrorMessage("DEADLINE")).toBe(
        "网络连接稍有延迟，我们正在确认入单状态，请稍后查看歌单。"
      );
      expect(getFriendlySongRequestErrorMessage("NETWORK_ERROR")).toBe(
        "网络连接稍有延迟，我们正在确认入单状态，请稍后查看歌单。"
      );

      // 授权失效
      expect(getFriendlySongRequestErrorMessage("AUTH_UNAVAILABLE")).toBe(
        "房主的网易云授权需要重新连接，请提醒房主更新授权。"
      );
    });

    it("空或未识别错误码返回温和托底提示", () => {
      expect(getFriendlySongRequestErrorMessage(null)).toBe("点歌遇到了一点小问题，请稍后重试。");
      expect(getFriendlySongRequestErrorMessage(undefined)).toBe("点歌遇到了一点小问题，请稍后重试。");
    });
  });

  describe("getFriendlyOperationStatusMessage", () => {
    it("针对不同进行中状态生成友好的人性化提示", () => {
      expect(getFriendlyOperationStatusMessage("queued", "晴天")).toBe(
        "《晴天》已提交，正在排队等待网易云处理…"
      );
      expect(getFriendlyOperationStatusMessage("processing", "晴天")).toBe(
        "正在为房间添加《晴天》并同步到网易云…"
      );
      expect(getFriendlyOperationStatusMessage("awaitingConfirmation", "晴天")).toBe(
        "《晴天》已提交网易云，正在等待云端确认，请稍后刷新查看。"
      );
      expect(getFriendlyOperationStatusMessage("waitingAuthorization")).toBe(
        "房主的网易云授权需要重新确认，正在等待房主恢复授权…"
      );
      expect(getFriendlyOperationStatusMessage("needsAdministrator")).toBe(
        "点歌操作需要管理员协助处理，请联系房主或管理员。"
      );
    });
  });
});
