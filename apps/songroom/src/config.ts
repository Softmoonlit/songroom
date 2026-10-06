import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const configFields = z.strictObject({
  nodeEnv: z.enum(["development", "test", "production"]),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  baseUrl: z.url(),
  dbPath: z.string().min(1),
  staticRoot: z.string().min(1)
});

export const configSchema = configFields.superRefine((config, ctx) => {
  const base = new URL(config.baseUrl);
  if (base.origin !== config.baseUrl || base.username || base.password) {
    ctx.addIssue({ code: "custom", message: "baseUrl 必须是无路径、凭据或查询参数的精确 origin" });
  }
  if (config.nodeEnv === "production" && base.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "生产 baseUrl 必须使用 HTTPS" });
  }
  if (config.nodeEnv !== "production" && base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === config.host && Number(base.port || 80) === config.port)) {
    ctx.addIssue({ code: "custom", message: "开发 HTTP 入口必须与本机监听地址和端口一致" });
  }
  const root = path.resolve(config.staticRoot);
  const database = path.resolve(config.dbPath);
  if (database === root || database.startsWith(root + path.sep)) {
    ctx.addIssue({ code: "custom", message: "数据库必须位于静态资源目录之外" });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(filePath = process.env.SONGROOM_CONFIG ?? "/etc/songroom/config.json"): AppConfig {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("配置须由当前用户持有，且仅当前用户可读写（0600 或 0400）");
  }
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const parsed = configFields.parse(raw);
  return configSchema.parse({
    ...parsed,
    dbPath: path.resolve(path.dirname(filePath), parsed.dbPath),
    staticRoot: path.resolve(path.dirname(filePath), parsed.staticRoot)
  });
}

export function assertRuntime(): void {
  if (process.versions.node !== "24.21.0") {
    throw new Error("SongRoom 要求 Node.js 24.21.0");
  }
}
