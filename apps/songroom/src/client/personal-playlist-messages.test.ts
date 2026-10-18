import { describe, expect, it } from "vitest";
import { getPersonalOperationMessage } from "./PersonalPlaylistPane.js";

describe("personal-playlist operation messages", () => {
  it("针对不同状态与 step 生成清晰的操作进度提示", () => {
    expect(getPersonalOperationMessage({
      id: "op-1",
      status: "queued",
      step: "ready",
      errorCode: null,
      version: 1
    })).toBe("已排队，等待创建专用个人歌单。");

    expect(getPersonalOperationMessage({
      id: "op-2",
      status: "processing",
      step: "sending",
      errorCode: null,
      version: 1
    })).toBe("正在创建专用个人歌单。");

    expect(getPersonalOperationMessage({
      id: "op-3",
      status: "processing",
      step: "confirming",
      errorCode: null,
      version: 1
    })).toBe("已获 ID 待关联，正在建立个人歌单绑定。");

    expect(getPersonalOperationMessage({
      id: "op-4",
      status: "processing",
      step: "confirming",
      recovered: true,
      errorCode: null,
      version: 1
    })).toBe("具体 ID 已恢复，正在核验并完成个人歌单关联。");

    expect(getPersonalOperationMessage({
      id: "op-5",
      status: "needsAdministrator",
      step: "unknown",
      errorCode: "MODULE_ERROR",
      version: 1
    })).toBe("创建结果未知，需要管理员处理。");

    expect(getPersonalOperationMessage({
      id: "op-6",
      status: "waitingAuthorization",
      step: "ready",
      errorCode: "AUTH_UNAVAILABLE",
      version: 1
    })).toBe("正在等待房主恢复网易云授权。");
  });
});
