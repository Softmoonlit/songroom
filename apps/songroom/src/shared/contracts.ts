import { z } from "zod";

export const uuidv7 = z.uuid({ version: "v7" }).transform(value => value.toLowerCase());
// 网易云标识的格式由上游决定；保留前导零以及超出 JS 安全整数范围的文本。
export const upstreamId = z.string().min(1);
export const commandKey = z.strictObject({ idempotencyKey: uuidv7 });

export function normalizedText(max: number) {
  return z.string().transform(value => value.trim().normalize("NFC"))
    .refine(value => [...value].length >= 1 && [...value].length <= max && !/\p{Cc}/u.test(value), `请输入 1 到 ${max} 个字符，不能包含控制字符`);
}

export const accountName = normalizedText(40);

export const healthResponse = z.object({
  status: z.enum(["starting", "ready", "draining", "stopped"]),
  service: z.literal("songroom"),
  schemaVersion: z.number().int()
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string()
  })
});

export type HealthResponse = z.infer<typeof healthResponse>;
