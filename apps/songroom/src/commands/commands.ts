import { createHash } from "node:crypto";
import { uuidv7 } from "../shared/contracts.js";
import { BusinessError } from "../shared/errors.js";
import { parse } from "uuid";
import { z } from "zod";

const preparedCommand = z.object({ accountId: uuidv7, key: uuidv7, digest: z.string() });
export type PreparedCommand = z.infer<typeof preparedCommand>;

export function prepareCommand(accountId: string, key: string, intent: string, content: unknown, now = Date.now()): PreparedCommand {
  const validatedAccount = uuidv7.safeParse(accountId);
  const validatedKey = uuidv7.safeParse(key);
  if (!validatedAccount.success || !validatedKey.success) {
    throw new BusinessError(400, "INVALID_ID", "标识必须为 UUIDv7");
  }
  const issuedAt = parse(validatedKey.data).slice(0, 6).reduce((timestamp, byte) => timestamp * 256 + byte, 0);
  if (issuedAt < now - 86_400_000 || issuedAt > now + 60_000) {
    throw new BusinessError(409, "IDEMPOTENCY_KEY_EXPIRED", "操作标识已过期或来自未来，请重新提交");
  }
  return { accountId: validatedAccount.data, key: validatedKey.data, digest: canonicalDigest({ intent, content }) };
}

export function inspectCommand<Result>(command: PreparedCommand, kind: "local" | "async", receipt?: PreparedCommand & { result: Result }):
  | { kind: "new"; status: 200 | 202 }
  | { kind: "replay"; status: 200; result: Result } {
  if (!receipt || receipt.accountId !== command.accountId || receipt.key !== command.key) {
    return { kind: "new", status: kind === "async" ? 202 : 200 };
  }
  if (receipt.digest !== command.digest) {
    throw new BusinessError(409, "IDEMPOTENCY_CONFLICT", "同一操作标识不能用于不同内容");
  }
  return { kind: "replay", status: 200, result: receipt.result };
}

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValue), z.record(z.string(), jsonValue)
]));

export function canonicalDigest(value: unknown): string {
  jsonValue.parse(value);
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value)!;
}
