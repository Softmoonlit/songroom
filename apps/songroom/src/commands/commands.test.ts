import { describe, expect, it } from "vitest";
import { v7 } from "uuid";
import { canonicalDigest, inspectCommand, prepareCommand } from "./commands.js";

const now = Date.UTC(2026, 9, 6, 12);
const actor = "019a00b0-0000-7000-8000-000000000001";

describe("业务命令契约", () => {
  it("规范摘要不受对象键顺序影响，并保留数组顺序", () => {
    expect(canonicalDigest({ song: "900719925474099399", nested: { a: 1, b: 2 } }))
      .toBe(canonicalDigest({ nested: { b: 2, a: 1 }, song: "900719925474099399" }));
    expect(canonicalDigest(["2", "1"])).not.toBe(canonicalDigest(["1", "2"]));
  });

  it("账号定域的同键同内容返回原结果，异步新提交202、重放200", () => {
    const key = v7({ msecs: now });
    const command = prepareCommand(actor, key, "request-song", { songId: "001" }, now);
    expect(inspectCommand(command, "async")).toEqual({ kind: "new", status: 202 });
    expect(inspectCommand(command, "local")).toEqual({ kind: "new", status: 200 });
    const receipt = { ...command, result: { operationId: v7({ msecs: now }) } };
    expect(inspectCommand(command, "async", receipt)).toEqual({ kind: "replay", status: 200, result: receipt.result });
    expect(() => inspectCommand({ ...command, digest: "different" }, "async", receipt)).toThrowError("IDEMPOTENCY_CONFLICT");
    expect(inspectCommand({ ...command, accountId: v7({ msecs: now }) }, "async", receipt)).toEqual({ kind: "new", status: 202 });
  });

  it("命令定域接受 Better Auth 原生账号标识", () => {
    expect(prepareCommand("NativeAuthUserID", v7({ msecs: now }), "createRoom", {}, now).accountId).toBe("NativeAuthUserID");
  });

  it("相同操作 UUID 的大小写形式归一化，不能绕过防重", () => {
    const key = v7({ msecs: now });
    expect(prepareCommand(actor, key.toUpperCase(), "rename-room", {}, now))
      .toEqual(prepareCommand(actor, key, "rename-room", {}, now));
  });

  it("过期或明显来自未来的键在查询防重记录前拒绝", () => {
    for (const timestamp of [now - 86_400_001, now + 60_001]) {
      expect(() => prepareCommand(actor, v7({ msecs: timestamp }), "rename-room", { name: "A" }, now)).toThrowError("IDEMPOTENCY_KEY_EXPIRED");
    }
    expect(() => prepareCommand(actor, v7({ msecs: now - 86_400_000 }), "rename-room", {}, now)).toThrowError("IDEMPOTENCY_KEY_EXPIRED");
    expect(() => prepareCommand(actor, "not-a-uuid", "rename-room", {}, now)).toThrowError("INVALID_ID");
    expect(() => prepareCommand(actor, v7({ msecs: now }), "rename-room", { missing: undefined }, now)).toThrow();
  });
});
