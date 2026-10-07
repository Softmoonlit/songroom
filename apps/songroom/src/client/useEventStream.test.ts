import { describe, expect, it } from "vitest";
import { InvalidationTracker } from "./useEventStream.js";

describe("InvalidationTracker", () => {
  it("首次收到版本允许失效并记录当前版本", () => {
    const tracker = new InvalidationTracker();
    expect(tracker.shouldInvalidate("room", "r-1", 1)).toBe(true);
    expect(tracker.getVersion("room", "r-1")).toBe(1);
  });

  it("递增版本允许失效并推进记录", () => {
    const tracker = new InvalidationTracker();
    expect(tracker.shouldInvalidate("room", "r-1", 1)).toBe(true);
    expect(tracker.shouldInvalidate("room", "r-1", 2)).toBe(true);
    expect(tracker.shouldInvalidate("room", "r-1", 3)).toBe(true);
    expect(tracker.getVersion("room", "r-1")).toBe(3);
  });

  it("重复版本被忽略，不触发失效", () => {
    const tracker = new InvalidationTracker();
    expect(tracker.shouldInvalidate("room", "r-1", 2)).toBe(true);
    expect(tracker.shouldInvalidate("room", "r-1", 2)).toBe(false);
    expect(tracker.getVersion("room", "r-1")).toBe(2);
  });

  it("乱序和晚到的较旧版本被忽略，不触发失效", () => {
    const tracker = new InvalidationTracker();
    // 收到较新版本 5
    expect(tracker.shouldInvalidate("operation", "op-1", 5)).toBe(true);
    // 迟到的旧版本 3 和 4 被丢弃
    expect(tracker.shouldInvalidate("operation", "op-1", 3)).toBe(false);
    expect(tracker.shouldInvalidate("operation", "op-1", 4)).toBe(false);
    expect(tracker.shouldInvalidate("operation", "op-1", 1)).toBe(false);
    expect(tracker.getVersion("operation", "op-1")).toBe(5);
  });

  it("不同资源类型或资源标识互相独立隔离", () => {
    const tracker = new InvalidationTracker();
    expect(tracker.shouldInvalidate("room", "r-1", 3)).toBe(true);
    expect(tracker.shouldInvalidate("room", "r-2", 1)).toBe(true);
    expect(tracker.shouldInvalidate("permission", "r-1", 2)).toBe(true);

    expect(tracker.getVersion("room", "r-1")).toBe(3);
    expect(tracker.getVersion("room", "r-2")).toBe(1);
    expect(tracker.getVersion("permission", "r-1")).toBe(2);
  });

  it("竞态控制：服务端普通 JSON 查询先返回较新版本时，迟到的旧 SSE 事件被忽略", () => {
    const tracker = new InvalidationTracker();
    // 用户通过 HTTP GET 读取到版本 4
    tracker.recordFromServer("snapshot", "r-1", 4);
    expect(tracker.getVersion("snapshot", "r-1")).toBe(4);

    // 随后迟到的 SSE 事件版本 2 和 4 到达，均不应再次触发失效
    expect(tracker.shouldInvalidate("snapshot", "r-1", 2)).toBe(false);
    expect(tracker.shouldInvalidate("snapshot", "r-1", 4)).toBe(false);

    // 真正有更高版本 5 时才允许失效
    expect(tracker.shouldInvalidate("snapshot", "r-1", 5)).toBe(true);
    expect(tracker.getVersion("snapshot", "r-1")).toBe(5);
  });

  it("recordFromServer 不会降低已经记录的更高版本", () => {
    const tracker = new InvalidationTracker();
    expect(tracker.shouldInvalidate("operation", "op-1", 10)).toBe(true);
    tracker.recordFromServer("operation", "op-1", 8);
    expect(tracker.getVersion("operation", "op-1")).toBe(10);
  });

  it("reset 成功清除记录版本，允许重新失效（防止短暂错误导致永久陈旧）", () => {
    const tracker = new InvalidationTracker();
    expect(tracker.shouldInvalidate("room", "r-1", 3)).toBe(true);
    expect(tracker.shouldInvalidate("room", "r-1", 3)).toBe(false);

    // 查询遇错触发 reset
    tracker.reset("room", "r-1");
    expect(tracker.getVersion("room", "r-1")).toBe(0);

    // 随后重试或同版本事件可以再次触发失效
    expect(tracker.shouldInvalidate("room", "r-1", 3)).toBe(true);
  });
});
