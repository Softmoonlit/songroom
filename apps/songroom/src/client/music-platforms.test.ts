import { describe, expect, it } from "vitest";
import { FUTURE_PLATFORMS, MUSIC_PLATFORMS, type MusicPlatformInfo } from "./music-platforms.js";

describe("music-platforms", () => {
  it("包含网易云音乐作为当前唯一的可用主平台", () => {
    const netease = MUSIC_PLATFORMS.find((p: MusicPlatformInfo) => p.id === "netease");
    expect(netease).toBeDefined();
    expect(netease?.status).toBe("active");
    expect(netease?.name).toBe("网易云音乐");
  });

  it("预留 QQ 音乐、汽水音乐与酷狗音乐等扩展位并标记为即将支持", () => {
    const futureIds = FUTURE_PLATFORMS.map((p: MusicPlatformInfo) => p.id);
    expect(futureIds).toEqual(["qq", "qishui", "kugou"]);
    for (const platform of FUTURE_PLATFORMS) {
      expect(platform.status).toBe("coming-soon");
      expect(platform.statusText).toBe("即将支持");
      expect(platform.description.length).toBeGreaterThan(0);
    }
  });
});
