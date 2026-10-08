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
    confirm?: (summary: { action: string; targetId: string; reason: string; impact: string }) => Promise<boolean>;
  };
  fetch?: typeof fetch;
};

export type AdminAbnormalActionResult = {
  ok: boolean;
  status: "succeeded" | "failed" | "cancelled";
  result?: AbnormalActionResult;
  message?: string;
};

export const ABNORMAL_ACTION_DEFINITIONS = {
  "resolve-write": {
    actionName: "resolve_song_write",
    endpointSuffix: "resolve-song-write",
    description: "终结长期未知普通歌曲写入",
    requiresVersion: true
  },
  "resolve-create": {
    actionName: "resolve_playlist_create",
    endpointSuffix: "resolve-playlist-create",
    description: "处置公共歌单未知创建",
    requiresVersion: true
  },
  "authorize-cleanup": {
    actionName: "authorize_cleanup_retry",
    endpointSuffix: "authorize-cleanup-retry",
    description: "授权公共歌单单次删除重试",
    requiresVersion: true
  },
  "verify-cleanup": {
    actionName: "verify_manual_cleanup",
    endpointSuffix: "verify-manual-cleanup",
    description: "记录手工清理并触发只读核验",
    requiresVersion: true
  },
  "resume-risk": {
    actionName: "resume_risk_pause",
    endpointSuffix: "resume-risk-pause",
    description: "恢复账号风控暂停调度",
    requiresVersion: false
  }
} as const;

export type AbnormalActionType = keyof typeof ABNORMAL_ACTION_DEFINITIONS;

async function withAdminSession<T>(
  config: AppConfig,
  options: AdminAbnormalCliOptions | undefined,
  fn: (client: AdminClient) => Promise<T>
): Promise<T | { ok: false; status?: "cancelled"; message: string }> {
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
        return { ok: false, status: "cancelled", message: "用户已取消操作" };
      }
      throw err;
    }

    const adminUserId = await client.signIn(adminEmail, adminPassword);
    const configuredAdmins = config.adminUserIds ?? [];
    if (!configuredAdmins.includes(adminUserId)) {
      throw new AdminCliError("FORBIDDEN", "该账号不是配置的受限管理员 (adminUserIds)");
    }

    return await fn(client);
  } finally {
    await client.signOut();
    client.dispose();
    adminEmail = "";
    adminPassword = "";
  }
}

export async function runAdminAbnormalList(
  config: AppConfig,
  options?: AdminAbnormalCliOptions
): Promise<{ ok: boolean; operations?: AbnormalOperationSummary[]; message?: string }> {
  const res = await withAdminSession(config, options, async (client) => {
    const listRes = await client.request("/api/admin/abnormal-operations", { method: "GET" });
    if (!listRes.ok) {
      throw new AdminCliError("OPERATION_FAILED", `获取异常操作列表失败: HTTP_${listRes.status}`);
    }
    const data = (await listRes.json()) as { operations: AbnormalOperationSummary[] };
    return { ok: true, operations: data.operations };
  });

  return res;
}

export async function runAdminAbnormalShow(
  config: AppConfig,
  id: string,
  options?: AdminAbnormalCliOptions
): Promise<{ ok: boolean; detail?: AbnormalOperationDetail; message?: string }> {
  const res = await withAdminSession(config, options, async (client) => {
    const detailRes = await client.request(`/api/admin/abnormal-operations/${encodeURIComponent(id)}`, { method: "GET" });
    if (!detailRes.ok) {
      throw new AdminCliError("OPERATION_FAILED", `获取异常操作详情失败: HTTP_${detailRes.status}`);
    }
    const detail = (await detailRes.json()) as AbnormalOperationDetail;
    return { ok: true, detail };
  });

  return res;
}

export async function runAdminAbnormalAction(
  config: AppConfig,
  actionType: AbnormalActionType,
  id: string,
  options?: AdminAbnormalCliOptions
): Promise<AdminAbnormalActionResult> {
  const def = ABNORMAL_ACTION_DEFINITIONS[actionType];
  if (!def) {
    throw new AdminCliError("CLI_USAGE", `未知的处置操作: ${actionType}`);
  }

  const sessionResult = await withAdminSession(config, options, async (client) => {
    // 1. 获取最新脱敏事实、当前版本与业务影响 (执行前读取)
    const detailRes = await client.request(`/api/admin/abnormal-operations/${encodeURIComponent(id)}`, { method: "GET" });
    if (!detailRes.ok) {
      throw new AdminCliError("OPERATION_FAILED", `获取目标异常操作详情失败: HTTP_${detailRes.status}`);
    }
    const detail = (await detailRes.json()) as AbnormalOperationDetail;

    // 2. 交互式提示输入原因
    let rawReason = "";
    try {
      rawReason = options?.prompts?.reason
        ? await options.prompts.reason()
        : await input({ message: "处置原因: " });
    } catch (err) {
      if (isPromptCancelled(err)) {
        return { ok: false, status: "cancelled", message: "用户已取消操作" } as AdminAbnormalActionResult;
      }
      throw err;
    }

    const validatedReason = validateRecoveryReason(rawReason);

    // 3. 交互式确认：展示原账号、具体目标、当前状态和预期影响
    let confirmed = true;
    try {
      confirmed = options?.prompts?.confirm
        ? await options.prompts.confirm({
            action: actionType,
            targetId: id,
            reason: validatedReason,
            impact: detail.impactDescription
          })
        : await confirm({
            message: `确认对目标 ${id} 执行【${def.description}】？\n` +
              `  原账号: ${detail.accountId}\n` +
              `  具体目标: ${detail.targetId}\n` +
              `  当前状态: ${detail.status}\n` +
              `  处置影响: ${detail.impactDescription}\n`
          });
    } catch (err) {
      if (isPromptCancelled(err)) {
        return { ok: false, status: "cancelled", message: "用户已取消操作" } as AdminAbnormalActionResult;
      }
      throw err;
    }

    if (!confirmed) {
      return { ok: false, status: "cancelled", message: "管理员取消确认，未执行任何变更" } as AdminAbnormalActionResult;
    }

    // 4. 调用服务端对应端点 (携带 expectedVersion 严格校验乐观锁)
    const endpoint = `/api/admin/abnormal-operations/${encodeURIComponent(id)}/${def.endpointSuffix}`;
    const bodyPayload = def.requiresVersion
      ? { reason: validatedReason, expectedVersion: detail.version }
      : { reason: validatedReason };

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
      } as AdminAbnormalActionResult;
    }

    const actionResult = (await actionRes.json()) as AbnormalActionResult;
    return {
      ok: true,
      status: "succeeded",
      result: actionResult,
      message: actionResult.message
    } as AdminAbnormalActionResult;
  });

  return sessionResult as AdminAbnormalActionResult;
}
