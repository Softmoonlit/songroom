import { input, password, confirm } from "@inquirer/prompts";
import fetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import { v7 } from "uuid";
import type { AppConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { adminAuditLog } from "../db/schema.js";

export type AdminCliErrorCode =
  | "NON_TTY"
  | "INSECURE_PROTOCOL"
  | "INVALID_REASON"
  | "INVALID_PASSWORD"
  | "INVALID_TARGET"
  | "AUTHENTICATION_FAILED"
  | "SESSION_INVALID"
  | "FORBIDDEN"
  | "OPERATION_FAILED";

export class AdminCliError extends Error {
  constructor(readonly code: AdminCliErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdminCliError";
  }
}

export function validateRecoveryReason(raw: string): string {
  const trimmed = raw.trim().normalize("NFC");
  if (/\p{Cc}/u.test(trimmed)) {
    throw new AdminCliError("INVALID_REASON", "线下核实原因不能包含控制字符");
  }
  const length = [...trimmed].length;
  if (length < 1 || length > 500) {
    throw new AdminCliError("INVALID_REASON", "线下核实原因长度必须在 1 到 500 个字符之间");
  }
  return trimmed;
}

export function validatePassword(raw: string): string {
  if (raw.length < 8 || raw.length > 128) {
    throw new AdminCliError("INVALID_PASSWORD", "新密码长度必须在 8 到 128 个字符之间");
  }
  return raw;
}

function isPromptCancelled(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "ExitPromptError" || error.name === "AbortError" || error.message.includes("force closed");
  }
  return false;
}

export class AdminClient {
  private readonly cookieJar = new CookieJar();
  private readonly clientFetch: typeof fetch;

  constructor(
    private readonly config: AppConfig,
    customFetch?: typeof fetch
  ) {
    const base = new URL(config.baseUrl);
    if (base.protocol !== "https:") {
      throw new AdminCliError("INSECURE_PROTOCOL", "管理命令只连接配置的浏览器可信 HTTPS 入口，拒绝明文 HTTP");
    }
    this.clientFetch = fetchCookie(customFetch ?? fetch, this.cookieJar);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const reqUrl = `${this.config.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("origin", this.config.baseUrl);
    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }
    return this.clientFetch(reqUrl, {
      ...init,
      headers
    });
  }

  async signIn(email: string, pass: string): Promise<string> {
    const signInRes = await this.request("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: pass })
    });
    if (!signInRes.ok) {
      throw new AdminCliError("AUTHENTICATION_FAILED", "管理员认证失败：邮箱或密码错误");
    }

    const sessionRes = await this.request("/api/auth/get-session", { method: "GET" });
    if (!sessionRes.ok) {
      throw new AdminCliError("SESSION_INVALID", "管理员会话核验失败");
    }
    const sessionData = (await sessionRes.json()) as { user?: { id: string } } | null;
    if (!sessionData?.user?.id) {
      throw new AdminCliError("SESSION_INVALID", "管理员会话无效");
    }
    return sessionData.user.id;
  }

  async signOut(): Promise<void> {
    try {
      await this.request("/api/auth/sign-out", { method: "POST", body: "{}" });
    } catch {
      // 忽略登出失败，后续清空 CookieJar 保证本地清理
    }
  }

  dispose(): void {
    this.cookieJar.removeAllCookiesSync();
  }
}

export type PromptProvider = {
  adminEmail?: () => Promise<string>;
  adminPassword?: () => Promise<string>;
  targetUserId?: () => Promise<string>;
  reason?: () => Promise<string>;
  newPassword?: () => Promise<string>;
  confirm?: (summary: { targetUserId: string; reason: string }) => Promise<boolean>;
};

export type AccountRecoveryOptions = {
  isTTY?: boolean;
  prompts?: PromptProvider;
  fetch?: typeof fetch;
};

export type AccountRecoveryResult = {
  ok: boolean;
  status: "recovered" | "partially_completed" | "failed" | "cancelled";
  adminUserId?: string;
  targetUserId?: string;
  setPasswordResult?: string;
  revokeSessionsResult?: string;
  message?: string;
};

export async function runAccountRecovery(
  config: AppConfig,
  options?: AccountRecoveryOptions
): Promise<AccountRecoveryResult> {
  const isTTY = options?.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    throw new AdminCliError("NON_TTY", "管理命令必须在交互式 TTY 终端中运行，非 TTY 环境安全退出且不执行变更");
  }

  let adminEmail = "";
  let adminPassword = "";
  let targetUserId = "";
  let rawReason = "";
  let newPassword = "";

  const client = new AdminClient(config, options?.fetch);

  try {
    try {
      adminEmail = options?.prompts?.adminEmail
        ? await options.prompts.adminEmail()
        : await password({ message: "管理员邮箱: ", mask: "*" });
      adminPassword = options?.prompts?.adminPassword
        ? await options.prompts.adminPassword()
        : await password({ message: "管理员密码: ", mask: "*" });
      targetUserId = options?.prompts?.targetUserId
        ? await options.prompts.targetUserId()
        : await input({ message: "目标用户内部标识 (User ID): " });
      rawReason = options?.prompts?.reason
        ? await options.prompts.reason()
        : await input({ message: "线下核实原因: " });
      newPassword = options?.prompts?.newPassword
        ? await options.prompts.newPassword()
        : await password({ message: "新密码 (8-128字符): ", mask: "*" });
    } catch (err) {
      if (isPromptCancelled(err)) {
        return { ok: false, status: "cancelled", message: "用户已取消操作，未执行任何变更" };
      }
      throw err;
    }

    targetUserId = targetUserId.trim();
    if (!targetUserId) {
      throw new AdminCliError("INVALID_TARGET", "目标用户内部标识不能为空");
    }

    const validatedReason = validateRecoveryReason(rawReason);
    validatePassword(newPassword);

    let confirmed = true;
    try {
      confirmed = options?.prompts?.confirm
        ? await options.prompts.confirm({ targetUserId, reason: validatedReason })
        : await confirm({ message: `确认恢复用户 ${targetUserId} 的密码并撤销其全部旧会话？` });
    } catch (err) {
      if (isPromptCancelled(err)) {
        return { ok: false, status: "cancelled", message: "用户已取消操作，未执行任何变更" };
      }
      throw err;
    }

    if (!confirmed) {
      return { ok: false, status: "cancelled", message: "管理员取消确认，未执行任何变更" };
    }

    // 1. 标准邮箱登录并核验管理员
    const adminUserId = await client.signIn(adminEmail, adminPassword);
    const configuredAdmins = config.adminUserIds ?? [];
    if (!configuredAdmins.includes(adminUserId)) {
      throw new AdminCliError("FORBIDDEN", "该账号不是配置的受限管理员 (adminUserIds)");
    }

    let setPasswordResult = "not_attempted";
    let revokeSessionsResult = "not_attempted";

    // 2. 原生接口一：设定新密码
    try {
      const setPasswordRes = await client.request("/api/auth/admin/set-user-password", {
        method: "POST",
        body: JSON.stringify({ userId: targetUserId, newPassword })
      });

      if (setPasswordRes.ok) {
        const data = (await setPasswordRes.json()) as { status?: boolean };
        setPasswordResult = data?.status === true ? "succeeded" : "failed";
      } else {
        let errDetail = `HTTP_${setPasswordRes.status}`;
        try {
          const errBody = (await setPasswordRes.json()) as { error?: { code?: string }; code?: string };
          errDetail = errBody?.code || errBody?.error?.code || errDetail;
        } catch {
          // ignore
        }
        setPasswordResult = `failed: ${errDetail}`;
      }
    } catch (err) {
      setPasswordResult = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 3. 原生接口二：撤销目标账号全部会话 (仅在设密成功时调用)
    if (setPasswordResult === "succeeded") {
      try {
        const revokeRes = await client.request("/api/auth/admin/revoke-user-sessions", {
          method: "POST",
          body: JSON.stringify({ userId: targetUserId })
        });

        if (revokeRes.ok) {
          const data = (await revokeRes.json()) as { success?: boolean };
          revokeSessionsResult = data?.success === true ? "succeeded" : "failed";
        } else {
          let errDetail = `HTTP_${revokeRes.status}`;
          try {
            const errBody = (await revokeRes.json()) as { error?: { code?: string }; code?: string };
            errDetail = errBody?.code || errBody?.error?.code || errDetail;
          } catch {
            // ignore
          }
          revokeSessionsResult = `failed: ${errDetail}`;
        }
      } catch (err) {
        revokeSessionsResult = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 4. 最小数据库审计 (明确报错，不吞掉异常)
    try {
      const database = openDatabase(config.dbPath);
      try {
        const overallResult =
          setPasswordResult === "succeeded" && revokeSessionsResult === "succeeded"
            ? "succeeded"
            : setPasswordResult === "succeeded"
            ? "partially_completed"
            : "failed";
        database
          .insert(adminAuditLog)
          .values({
            id: v7(),
            adminUserId,
            targetType: "user",
            targetId: targetUserId,
            action: "recover_account",
            reason: validatedReason,
            previousStatus: null,
            nextStatus: null,
            result: overallResult,
            details: JSON.stringify({ setPasswordResult, revokeSessionsResult }),
            createdAt: new Date()
          })
          .run();
      } finally {
        database.$client.close();
      }
    } catch (err) {
      throw new AdminCliError("OPERATION_FAILED", "审计记录写入失败，操作未确认完成", { cause: err });
    }

    // 5. 分别核验并返回结果
    if (setPasswordResult === "succeeded" && revokeSessionsResult === "succeeded") {
      return {
        ok: true,
        status: "recovered",
        adminUserId,
        targetUserId,
        setPasswordResult: "succeeded",
        revokeSessionsResult: "succeeded",
        message: "账号恢复完成：新密码已设置，全部旧会话已撤销"
      };
    }

    if (setPasswordResult === "succeeded") {
      return {
        ok: false,
        status: "partially_completed",
        adminUserId,
        targetUserId,
        setPasswordResult: "succeeded",
        revokeSessionsResult,
        message: "新密码已设置，但撤销旧会话失败，未完成完整恢复"
      };
    }

    return {
      ok: false,
      status: "failed",
      adminUserId,
      targetUserId,
      setPasswordResult,
      revokeSessionsResult: "not_attempted",
      message: `设置新密码失败 (${setPasswordResult})`
    };
  } finally {
    // 6. 无论是成功、失败、校验错误还是异常，均主动登出并清空内存敏感数据
    await client.signOut();
    client.dispose();
    adminEmail = "";
    adminPassword = "";
    newPassword = "";
  }
}

export type AdminWhoamiOptions = {
  isTTY?: boolean;
  prompts?: {
    adminEmail?: () => Promise<string>;
    adminPassword?: () => Promise<string>;
  };
  fetch?: typeof fetch;
};

export type AdminWhoamiResult = {
  ok: boolean;
  userId?: string;
  isAdmin?: boolean;
  message?: string;
};

export async function runAdminWhoami(
  config: AppConfig,
  options?: AdminWhoamiOptions
): Promise<AdminWhoamiResult> {
  const isTTY = options?.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    throw new AdminCliError("NON_TTY", "管理命令必须在交互式 TTY 终端中运行");
  }

  let adminEmail = "";
  let adminPassword = "";

  const client = new AdminClient(config, options?.fetch);

  try {
    try {
      adminEmail = options?.prompts?.adminEmail
        ? await options.prompts.adminEmail()
        : await password({ message: "管理员邮箱: ", mask: "*" });
      adminPassword = options?.prompts?.adminPassword
        ? await options.prompts.adminPassword()
        : await password({ message: "管理员密码: ", mask: "*" });
    } catch (err) {
      if (isPromptCancelled(err)) {
        return { ok: false, message: "用户已取消操作" };
      }
      throw err;
    }

    const userId = await client.signIn(adminEmail, adminPassword);
    const configuredAdmins = config.adminUserIds ?? [];
    const isAdmin = configuredAdmins.includes(userId);

    return {
      ok: true,
      userId,
      isAdmin,
      message: isAdmin ? "身份核验通过，当前用户是受限管理员" : "身份核验通过，当前用户不是受限管理员"
    };
  } finally {
    await client.signOut();
    client.dispose();
    adminEmail = "";
    adminPassword = "";
  }
}
