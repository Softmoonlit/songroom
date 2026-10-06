import { and, eq, lte } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt } from "../db/schema.js";
import { inspectCommand, validateCommandKey, type PreparedCommand } from "./commands.js";

type CommandDatabase = Pick<AppDatabase, "select" | "insert" | "delete">;

export function readCommandResource(database: CommandDatabase, command: PreparedCommand, now: number): string | undefined {
  const { key } = validateCommandKey(command.key, now);
  const receipt = database.select().from(commandReceipt).where(and(eq(commandReceipt.userId, command.accountId), eq(commandReceipt.key, key))).get();
  const inspected = inspectCommand({ ...command, key }, "local", receipt ? { accountId: receipt.userId, key: receipt.key, digest: receipt.digest, result: receipt.resourceId } : undefined);
  return inspected.kind === "replay" ? inspected.result : undefined;
}

/** 与业务结果在同一事务内调用；此处只保存摘要和本地资源标识，不保存命令载荷。 */
export function recordCommandResource(database: CommandDatabase, command: PreparedCommand, resourceId: string, now: number): { resourceId: string; replay: boolean } {
  const existing = readCommandResource(database, command, now);
  if (existing) return { resourceId: existing, replay: true };
  const { key, issuedAt } = validateCommandKey(command.key, now);
  database.delete(commandReceipt).where(lte(commandReceipt.expiresAt, now)).run();
  database.insert(commandReceipt).values({ userId: command.accountId, key, digest: command.digest, resourceId, expiresAt: issuedAt + 86_400_000 }).run();
  return { resourceId, replay: false };
}
