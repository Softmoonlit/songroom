import { confirm, input, password } from "@inquirer/prompts";
import type { AppConfig } from "../config.js";
import type {
  AbnormalActionResult,
  AbnormalOperationDetail,
  AbnormalOperationSummary
} from "../shared/admin-contracts.js";
import {
  AdminClient,
  AdminCliError,
  validateRecoveryReason
} from "./account-recovery.js";

function isPromptCancelled(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "ExitPromptError" || error.name === "AbortError" || error.message.includes("force closed");
  }
  return false;
}

export type AdminAbnormalCliOptions = {
  isTTY?: boolean;
  prompts?: {
    adminEmail?: () => Promise<string>;
    adminPassword?: () => Promise<string>;
    reason?: () => Promise<string>;
    confirm?: (summary: { action: string; targetId: string; reason: string }) => Promise<boolean>;
  };
  fetch?: typeof fetch;
};

export type AdminAbnormalActionResult = {
  ok: boolean;
  status: "succeeded" | "failed" | "cancelled";
  result?: AbnormalActionResult;
  message?: string;
};

export async function runAdminAbnormalList(
  config: AppConfig,
  options?: AdminAbnormalCliOptions
): Promise<{ ok: boolean; operations?: AbnormalOperationSummary[]; message?: string }> {
  const isTTY = options?.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    throw new AdminCliError("NON_TTY", "管理命令必须在交互式 TTY 终端中运行");
  }

  const client = new AdminClient(config, options?.fetch);
  let adminEmail = "";
  let adminPassword = "";

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

    const adminUserId = await client.signIn(adminEmail, adminPassword);
    const configuredAdmins = config.adminUserIds ?? [];
    if (!configuredAdmins.includes(adminUserId)) {
      throw new AdminCliError("FORBIDDEN", "该账号不是配置的受限管理员 (adminUserIds)");
    }

    const res = await client.request("/api/admin/abnormal-operations", { method: "GET" });
    if (!res.ok) {
      throw new AdminCliError("OPERATION_FAILED", `获取异常操作列表失败: HTTP_${res.status}`);
    }

    const data = (await res.json()) as { operations: AbnormalOperationSummary[] };
    return { ok: true, operations: data.operations };
  } finally {
    await client.signOut();
    client.dispose();
    adminEmail = "";
    adminPassword = "";
  }
}

export async function runAdminAbnormalShow(
  config: AppConfig,
  id: string,
  options?: AdminAbnormalCliOptions
): Promise<{ ok: boolean; detail?: AbnormalOperationDetail; message?: string }> {
  const isTTY = options?.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    throw new AdminCliError("NON_TTY", "管理命令必须在交互式 TTY 终端中运行");
  }

  const client = new AdminClient(config, options?.fetch);
  let adminEmail = "";
  let adminPassword = "";

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

    const adminUserId = await client.signIn(adminEmail, adminPassword);
    const configuredAdmins = config.adminUserIds ?? [];
    if (!configuredAdmins.includes(adminUserId)) {
      throw new AdminCliError("FORBIDDEN", "该账号不是配置的受限管理员 (adminUserIds)");
    }

    const res = await client.request(`/api/admin/abnormal-operations/${encodeURIComponent(id)}`, { method: "GET" });
    if (!res.ok) {
      throw new AdminCliError("OPERATION_FAILED", `获取异常操作详情失败: HTTP_${res.status}`);
    }

    const detail = (await res.json()) as AbnormalOperationDetail;
    return { ok: true, detail };
  } finally {
    await client.signOut();
    client.dispose();
    adminEmail = "";
    adminPassword = "";
  }
}

export type AbnormalActionType =
  | "resolve-write"
  | "resolve-create"
  | "authorize-cleanup"
  | "verify-cleanup"
  | "resume-risk";

export async function runAdminAbnormalAction(
  config: AppConfig,
  actionType: AbnormalActionType,
  id: string,
  options?: AdminAbnormalCliOptions
): Promise<AdminAbnormalActionResult> {
  const isTTY = options?.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    throw new AdminCliError("NON_TTY", "管理命令必须在交互式 TTY 终端中运行");
  }

  const client = new AdminClient(config, options?.fetch);
  let adminEmail = "";
  let adminPassword = "";
  let rawReason = "";

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
        return { ok: false, status: "cancelled", message: "用户已取消操作" };
      }
      throw err;
    }

    const adminUserId = await client.signIn(adminEmail, adminPassword);
    const configuredAdmins = config.adminUserIds ?? [];
    if (!configuredAdmins.includes(adminUserId)) {
      throw new AdminCliError("FORBIDDEN", "该账号不是配置的受限管理员 (adminUserIds)");
    }

    // 1. 获取最新脱敏事实与当前版本 (执行前读取)
    const detailRes = await client.request(`/api/admin/abnormal-operations/${encodeURIComponent(id)}`, { method: "GET" });
    if (!detailRes.ok) {
      throw new AdminCliError("OPERATION_FAILED", `获取目标异常操作详情失败: HTTP_${detailRes.status}`);
    }
    const detail = (await detailRes.json()) as AbnormalOperationDetail;

    // 2. 交互式提示输入原因
    try {
      rawReason = options?.prompts?.reason
        ? await options.prompts.reason()
        : await input({ message: "处置原因: " });
    } catch (err) {
      if (isPromptCancelled(err)) {
        return { ok: false, status: "cancelled", message: "用户已取消操作" };
      }
      throw err;
    }

    const validatedReason = validateRecoveryReason(rawReason);

    // 3. 交互式提示确认
    let confirmed = true;
    try {
      confirmed = options?.prompts?.confirm
        ? await options.prompts.confirm({ action: actionType, targetId: id, reason: validatedReason })
        : await confirm({
            message: `确认对目标 ${id} (原账号: ${detail.accountId}, 当前状态: ${detail.status}) 执行 ${actionType} 操作？`
          });
    } catch (err) {
      if (isPromptCancelled(err)) {
        return { ok: false, status: "cancelled", message: "用户已取消操作" };
      }
      throw err;
    }

    if (!confirmed) {
      return { ok: false, status: "cancelled", message: "管理员取消确认，未执行任何变更" };
    }

    // 4. 调用服务端对应端点 (携带 expectedVersion 进行乐观锁原子验证)
    const endpointMap: Record<AbnormalActionType, string> = {
      "resolve-write": `/api/admin/abnormal-operations/${encodeURIComponent(id)}/resolve-song-write`,
      "resolve-create": `/api/admin/abnormal-operations/${encodeURIComponent(id)}/resolve-playlist-create`,
      "authorize-cleanup": `/api/admin/abnormal-operations/${encodeURIComponent(id)}/authorize-cleanup-retry`,
      "verify-cleanup": `/api/admin/abnormal-operations/${encodeURIComponent(id)}/verify-manual-cleanup`,
      "resume-risk": `/api/admin/abnormal-operations/${encodeURIComponent(id)}/resume-risk-pause`
    };

    const endpoint = endpointMap[actionType];
    const bodyPayload = actionType === "resume-risk"
      ? { reason: validatedReason }
      : { reason: validatedReason, expectedVersion: detail.version ?? undefined };

    const actionRes = await client.request(endpoint, {
      method: "POST",
      body: JSON.stringify(bodyPayload)
    });

    if (!actionRes.ok) {
      let errDetail = `HTTP_${actionRes.status}`;
      try {
        const errJson = (await actionRes.json()) as { error?: { message?: string; code?: string } };
        errDetail = errJson.error?.message || errJson.error?.code || errDetail;
      } catch {
        // ignore
      }
      return {
        ok: false,
        status: "failed",
        message: `处置失败: ${errDetail}`
      };
    }

    const actionResult = (await actionRes.json()) as AbnormalActionResult;
    return {
      ok: true,
      status: "succeeded",
      result: actionResult,
      message: actionResult.message
    };
  } finally {
    await client.signOut();
    client.dispose();
    adminEmail = "";
    adminPassword = "";
  }
}
