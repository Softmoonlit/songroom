import { describe, expect, it } from "vitest";
import {
  getFriendlySongRequestErrorMessage,
  getFriendlyOperationStatusMessage
} from "./song-request-messages.js";

describe("song-request-messages", () => {
  describe("getFriendlySongRequestErrorMessage", () => {
    it("将排队与限流等系统错误码转换为精炼直接提示", () => {
      // 队列占满
      expect(getFriendlySongRequestErrorMessage("UPSTREAM_QUEUE_FULL")).toBe(
        "操作队列已满，请稍后重试。"
      );

      // 风控或频控保护
      expect(getFriendlySongRequestErrorMessage("RATE_LIMITED")).toBe(
        "网易云请求受限，请稍后重试。"
      );
      expect(getFriendlySongRequestErrorMessage("ACCOUNT_PAUSED")).toBe(
        "网易云请求受限，请稍后重试。"
      );

      // 目标写冲突锁定
      expect(getFriendlySongRequestErrorMessage("TARGET_BLOCKED")).toBe(
        "歌单写入中，请稍后重试。"
      );

      // 网络与超时
      expect(getFriendlySongRequestErrorMessage("DEADLINE")).toBe(
        "网络连接超时，正在核验状态。"
      );
      expect(getFriendlySongRequestErrorMessage("NETWORK_ERROR")).toBe(
        "网络连接超时，正在核验状态。"
      );

      // 授权失效
      expect(getFriendlySongRequestErrorMessage("AUTH_UNAVAILABLE")).toBe(
        "需房主重新授权网易云账号。"
      );

      // 个人歌单校验
      expect(getFriendlySongRequestErrorMessage("PERSONAL_PLAYLIST_NOT_FOUND")).toBe(
        "尚未配置个人歌单。"
      );
      expect(getFriendlySongRequestErrorMessage("PUBLIC_PLAYLIST_NOT_FOUND")).toBe(
        "房间尚未创建点歌台。"
      );
      expect(getFriendlySongRequestErrorMessage("SOURCE_PLAYLIST_FORBIDDEN")).toBe(
        "只能从个人专属歌单点歌。"
      );
      expect(getFriendlySongRequestErrorMessage("SOURCE_SONG_REMOVED")).toBe(
        "该歌曲已从你的个人歌单中移除，无法发起点歌。"
      );
      expect(getFriendlySongRequestErrorMessage("SOURCE_PLAYLIST_UNAVAILABLE")).toBe(
        "个人歌单暂时不可访问。"
      );
    });

    it("空或未识别错误码返回精炼托底提示", () => {
      expect(getFriendlySongRequestErrorMessage(null)).toBe("点歌失败，请稍后重试。");
      expect(getFriendlySongRequestErrorMessage(undefined)).toBe("点歌失败，请稍后重试。");
    });
  });

  describe("getFriendlyOperationStatusMessage", () => {
    it("针对不同进行中状态生成精炼提示", () => {
      expect(getFriendlyOperationStatusMessage("queued", "晴天")).toBe(
        "正在为房间排队添加《晴天》…"
      );
      expect(getFriendlyOperationStatusMessage("processing", "晴天")).toBe(
        "正在为房间添加《晴天》…"
      );
      expect(getFriendlyOperationStatusMessage("awaitingConfirmation", "晴天")).toBe(
        "《晴天》已提交，正在核验…"
      );
      expect(getFriendlyOperationStatusMessage("waitingAuthorization")).toBe(
        "等待房主恢复网易云授权…"
      );
      expect(getFriendlyOperationStatusMessage("needsAdministrator")).toBe(
        "操作状态异常，请联系管理员。"
      );
    });
  });
});
