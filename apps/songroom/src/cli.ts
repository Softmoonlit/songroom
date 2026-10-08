import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertRuntime, loadConfig, type AppConfig } from "./config.js";
import { checkDatabase, initializeDatabase, migrateDatabase, type DatabaseCheck } from "./db/database.js";
import { AdminCliError, runAccountRecovery, runAdminWhoami, type AccountRecoveryOptions, type AdminWhoamiOptions } from "./admin/account-recovery.js";
import {
  runAdminAbnormalList,
  runAdminAbnormalShow,
  runAdminAbnormalAction,
  ABNORMAL_ACTION_DEFINITIONS,
  type AbnormalActionType,
  type AdminAbnormalCliOptions
} from "./admin/abnormal-operations-cli.js";

type DatabaseCommandResult = DatabaseCheck | {
  ok: true;
  action: "initialized" | "migrated";
  database: string;
};

type CliErrorCode =
  | "RUNTIME_UNSUPPORTED"
  | "CONFIG_INVALID"
  | "DB_USAGE"
  | "DB_NOT_FOUND"
  | "DB_ALREADY_EXISTS"
  | "DB_PORT_OCCUPIED"
  | "DB_SCHEMA_INVALID"
  | "DB_CHECK_FAILED"
  | "DB_MIGRATION_FAILED"
  | "DB_INIT_FAILED"
  | "CLI_USAGE"
  | "ADMIN_ERROR";

class CliError extends Error {
  constructor(readonly code: CliErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
  }
}

export async function runCli(
  argv: readonly string[],
  config: AppConfig,
  options?: AccountRecoveryOptions & AdminWhoamiOptions & AdminAbnormalCliOptions
): Promise<unknown> {
  const [group, action, subAction, targetId] = argv;
  if (group === "db") {
    return runDatabaseCommand(argv, config);
  }
  if (group === "admin" && action === "whoami") {
    return runAdminWhoami(config, options);
  }
  if (group === "admin" && action === "recover-account") {
    return runAccountRecovery(config, options);
  }
  if (group === "admin" && action === "abnormal") {
    if (subAction === "list") {
      return runAdminAbnormalList(config, options);
    }
    if (subAction === "show") {
      if (!targetId) {
        throw new CliError("CLI_USAGE", "用法：admin abnormal show <id>");
      }
      return runAdminAbnormalShow(config, targetId, options);
    }
    if (subAction && subAction in ABNORMAL_ACTION_DEFINITIONS) {
      if (!targetId) {
        throw new CliError("CLI_USAGE", `用法：admin abnormal ${subAction} <id>`);
      }
      return runAdminAbnormalAction(config, subAction as AbnormalActionType, targetId, options);
    }
    throw new CliError("CLI_USAGE", "用法：admin abnormal list | show <id> | resolve-write <id> | resolve-create <id> | authorize-cleanup <id> | verify-cleanup <id> | resume-risk <accountId>");
  }
  throw new CliError("CLI_USAGE", "用法：db init | db migrate | db check | admin whoami | admin recover-account | admin abnormal <command>");
}

export async function runDatabaseCommand(argv: readonly string[], config: AppConfig): Promise<DatabaseCommandResult> {
  const [group, action] = argv;
  if (group !== "db" || !action || argv.length !== 2 || !["init", "migrate", "check"].includes(action)) {
    throw new CliError("DB_USAGE", "用法：db init | db migrate | db check");
  }

  try {
    if (action === "init") {
      const listener = await reserveApplicationPort(config);
      try {
        initializeDatabase(config.dbPath);
        return { ok: true, action: "initialized", database: config.dbPath };
      } finally {
        await closeListener(listener);
      }
    }
    if (action === "check") {
      return checkDatabase(config.dbPath);
    }

    const listener = await reserveApplicationPort(config);
    try {
      migrateDatabase(config.dbPath);
      return { ok: true, action: "migrated", database: config.dbPath };
    } finally {
      await closeListener(listener);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw classifyDatabaseError(action, error);
  }
}

async function reserveApplicationPort(config: AppConfig): Promise<net.Server> {
  const listener = net.createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen({ host: config.host, port: config.port }, () => resolve());
    });
    return listener;
  } catch (error) {
    listener.close();
    throw new CliError("DB_PORT_OCCUPIED", "应用监听端口已被占用", { cause: error });
  }
}

async function closeListener(listener: net.Server): Promise<void> {
  if (!listener.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  });
}

function classifyDatabaseError(action: string, error: unknown): CliError {
  const detail = error instanceof Error ? error.message : "";
  if (/does not exist/i.test(detail)) {
    return new CliError("DB_NOT_FOUND", "数据库不存在，请先执行 db init", { cause: error });
  }
  if (/already exists/i.test(detail)) {
    return new CliError("DB_ALREADY_EXISTS", "数据库已存在", { cause: error });
  }
  if (/schema|migration hash|integrity|journal mode|foreign key/i.test(detail)) {
    return new CliError("DB_SCHEMA_INVALID", "数据库 schema 或迁移事实不匹配", { cause: error });
  }
  if (action === "check") {
    return new CliError("DB_CHECK_FAILED", "数据库只读自检失败", { cause: error });
  }
  if (action === "migrate") {
    return new CliError("DB_MIGRATION_FAILED", "数据库迁移失败", { cause: error });
  }
  return new CliError("DB_INIT_FAILED", "数据库初始化失败", { cause: error });
}

function classifyStartupError(error: unknown): CliError {
  const detail = error instanceof Error ? error.message : "";
  if (/Node\.js 24\.21\.0/.test(detail)) {
    return new CliError("RUNTIME_UNSUPPORTED", "运行时版本不符合要求");
  }
  return new CliError("CONFIG_INVALID", "配置无效或不可读取");
}

async function main(): Promise<void> {
  try {
    assertRuntime();
    const config = loadConfig();
    const result = await runCli(process.argv.slice(2), config);
    console.log(JSON.stringify(result));
  } catch (error) {
    if (error instanceof AdminCliError) {
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const diagnostic = error instanceof CliError ? error : classifyStartupError(error);
    console.error(`${diagnostic.code}: ${diagnostic.message}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  main();
}
