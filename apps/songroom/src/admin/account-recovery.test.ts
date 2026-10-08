import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase, openDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "../http/app.js";
import type { AppConfig } from "../config.js";
import {
  AdminCliError,
  runAccountRecovery,
  runAdminWhoami,
  validatePassword,
  validateRecoveryReason
} from "./account-recovery.js";
import { adminAuditLog, user } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function createHttpsFetch(caCert: Buffer) {
  return async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const u = new URL(urlStr);
      const headers = new Headers(init.headers);
      const headerObj: Record<string, string> = {};
      headers.forEach((v, k) => {
        headerObj[k] = v;
      });

      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init.method || "GET",
          headers: headerObj,
          ca: caCert
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            const responseHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) {
                for (const item of v) responseHeaders.append(k, item);
              } else if (v) {
                responseHeaders.set(k, v);
              }
            }
            const response = new Response(body, {
              status: res.statusCode ?? 200,
              statusText: res.statusMessage ?? "OK",
              headers: responseHeaders
            });
            Object.defineProperty(response, "url", { value: urlStr });
            resolve(response);
          });
        }
      );
      req.on("error", reject);
      if (init.body) {
        req.write(typeof init.body === "string" ? init.body : String(init.body));
      }
      req.end();
    });
  };
}

// Generate test SSL key and cert once for the entire test suite
const certDir = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-test-ssl-"));
const keyPath = path.join(certDir, "https-key.pem");
const certPath = path.join(certDir, "https-cert.pem");
execSync(
  `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 1 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"`,
  { stdio: "ignore" }
);
const sslKey = await fs.readFile(keyPath);
const sslCert = await fs.readFile(certPath);

async function setupTestApp(options: { adminUserIds?: string[] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-admin-test-"));
  cleanups.push(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><html><body>SongRoom</body></html>");

  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);

  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });

  // Free port for Fastify (HTTP internal)
  const appSocket = createServer();
  await new Promise<void>((resolve) => appSocket.listen(0, "127.0.0.1", resolve));
  const appPort = (appSocket.address() as { port: number }).port;
  await new Promise<void>((resolve) => appSocket.close(() => resolve()));

  // Start HTTPS reverse proxy on ephemeral port
  let currentAppPort = appPort;
  let currentApp: SongRoomApp;

  const proxy = https.createServer({ key: sslKey, cert: sslCert }, (req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: currentAppPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${httpsPort}`,
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https"
        }
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const httpsPort = (proxy.address() as { port: number }).port;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  const baseUrl = `https://127.0.0.1:${httpsPort}`;

  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: appPort,
    baseUrl,
    dbPath,
    staticRoot,
    authSecret: "test-secret-with-at-least-32-characters",
    credentialKeyPath,
    adminUserIds: options.adminUserIds ?? []
  };

  currentApp = await createApp(config);
  await currentApp.listen();

  cleanups.push(async () => {
    await currentApp.close();
  });

  const trustedFetch = createHttpsFetch(sslCert);

  const restartApp = async (adminUserIds: string[]) => {
    await currentApp.close();
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    currentAppPort = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));

    config.port = currentAppPort;
    config.adminUserIds = adminUserIds;
    currentApp = await createApp(config);
    await currentApp.listen();
  };

  return { config, app: currentApp, dbPath, baseUrl, trustedFetch, sslCert, restartApp };
}

describe("纯规则与输入验证", () => {
  it("validateRecoveryReason 规范化 Unicode NFC 并去除首尾空白", () => {
    const normalized = validateRecoveryReason("  线下核实\u0045\u0301身份  ");
    expect(normalized).toBe("线下核实\u00C9身份");
  });

  it("validateRecoveryReason 拒绝控制字符", () => {
    expect(() => validateRecoveryReason("线下核实\u0000身份")).toThrowError(AdminCliError);
    expect(() => validateRecoveryReason("线下核实\n身份")).toThrowError(AdminCliError);
    expect(() => validateRecoveryReason("线下核实\t身份")).toThrowError(AdminCliError);
  });

  it("validateRecoveryReason 限制 1 到 500 个码点", () => {
    expect(() => validateRecoveryReason("")).toThrowError(AdminCliError);
    expect(() => validateRecoveryReason("   ")).toThrowError(AdminCliError);

    const valid500 = "字".repeat(500);
    expect(validateRecoveryReason(valid500)).toBe(valid500);

    const invalid501 = "字".repeat(501);
    expect(() => validateRecoveryReason(invalid501)).toThrowError(AdminCliError);

    // 多字节 Emoji / 码点计数
    const emojis = "🎵".repeat(100);
    expect(validateRecoveryReason(emojis)).toBe(emojis);
  });

  it("validatePassword 限制 8 到 128 字符", () => {
    expect(() => validatePassword("short")).toThrowError(AdminCliError);
    expect(() => validatePassword("a".repeat(129))).toThrowError(AdminCliError);
    expect(validatePassword("valid-password-123")).toBe("valid-password-123");
  });
});

describe("管理员环境与安全校验", () => {
  it("非 TTY 环境安全退出且不执行变更", async () => {
    const { config, trustedFetch } = await setupTestApp();
    await expect(
      runAccountRecovery(config, {
        isTTY: false,
        fetch: trustedFetch
      })
    ).rejects.toThrowError(/TTY/);
  });

  it("拒绝明文 HTTP 协议入口", async () => {
    const { config, trustedFetch } = await setupTestApp();
    const insecureConfig: AppConfig = {
      ...config,
      baseUrl: "http://127.0.0.1:3000"
    };

    await expect(
      runAccountRecovery(insecureConfig, {
        isTTY: true,
        fetch: trustedFetch
      })
    ).rejects.toThrowError(/HTTPS/);
  });

  it("证书不受信任时 Node.js 默认 TLS 证书校验报错且命令中止", async () => {
    const { config } = await setupTestApp();
    // 使用全局 fetch (未信任测试自签名 CA)
    await expect(
      runAccountRecovery(config, {
        isTTY: true,
        prompts: {
          adminEmail: async () => "admin@example.com",
          adminPassword: async () => "admin-password-123",
          targetUserId: async () => "target-123",
          reason: async () => "线下核实完成",
          newPassword: async () => "new-password-123",
          confirm: async () => true
        }
      })
    ).rejects.toThrow();
  });

  it("管理员密码错误认证失败，返回 401 并不执行变更", async () => {
    const { config, trustedFetch } = await setupTestApp();

    // 先通过 API 注册管理员账号
    await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "real-admin-password" })
    });

    await expect(
      runAccountRecovery(config, {
        isTTY: true,
        fetch: trustedFetch,
        prompts: {
          adminEmail: async () => "admin@example.com",
          adminPassword: async () => "wrong-password",
          targetUserId: async () => "target-123",
          reason: async () => "线下核实完成",
          newPassword: async () => "new-password-123",
          confirm: async () => true
        }
      })
    ).rejects.toThrowError(AdminCliError);
  });

  it("普通用户登录成功但未在 adminUserIds 中声明，拒绝执行管理命令", async () => {
    const { config, trustedFetch } = await setupTestApp({ adminUserIds: ["someone-else"] });

    // 普通用户注册
    await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "User", email: "user@example.com", password: "user-password-123" })
    });

    await expect(
      runAccountRecovery(config, {
        isTTY: true,
        fetch: trustedFetch,
        prompts: {
          adminEmail: async () => "user@example.com",
          adminPassword: async () => "user-password-123",
          targetUserId: async () => "target-123",
          reason: async () => "线下核实完成",
          newPassword: async () => "new-password-123",
          confirm: async () => true
        }
      })
    ).rejects.toThrowError(/adminUserIds/);
  });

  it("管理员取消确认时安全退出，未执行任何变更", async () => {
    const { config, trustedFetch } = await setupTestApp();

    const result = await runAccountRecovery(config, {
      isTTY: true,
      fetch: trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "password-123",
        targetUserId: async () => "target-123",
        reason: async () => "线下核实完成",
        newPassword: async () => "new-password-123",
        confirm: async () => false
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("cancelled");
  });
});

describe("账号恢复原生执行与审计记录", () => {
  it("具权管理员成功恢复目标账号密码，撤销其旧会话，记录最小审计且目标可用新密码登录", async () => {
    // 1. 先注册管理员账号
    const preRoot = await setupTestApp();
    const adminRegRes = await preRoot.trustedFetch(`${preRoot.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: preRoot.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminData = (await adminRegRes.json()) as { user: { id: string } };
    const adminUserId = adminData.user.id;

    // 2. 注册目标用户并获取其会话
    const targetRegRes = await preRoot.trustedFetch(`${preRoot.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: preRoot.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "TargetUser", email: "target@example.com", password: "old-password-123" })
    });
    const targetData = (await targetRegRes.json()) as { user: { id: string } };
    const targetUserId = targetData.user.id;
    const targetOldCookie = targetRegRes.headers.getSetCookie()[0]!.split(";", 1)[0];

    // 验证目标用户的旧会话当前有效
    const oldSessionRes = await preRoot.trustedFetch(`${preRoot.config.baseUrl}/api/auth/get-session`, {
      headers: { origin: preRoot.config.baseUrl, cookie: targetOldCookie }
    });
    expect(oldSessionRes.status).toBe(200);
    expect(((await oldSessionRes.json()) as { user: { id: string } }).user.id).toBe(targetUserId);

    // 3. 将 adminUserId 配置到 adminUserIds 并重新启动服务进行正式恢复
    await preRoot.restartApp([adminUserId]);

    // 4. 运行 whoami 核验管理员身份
    const whoamiResult = await runAdminWhoami(preRoot.config, {
      isTTY: true,
      fetch: preRoot.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123"
      }
    });
    expect(whoamiResult.ok).toBe(true);
    expect(whoamiResult.userId).toBe(adminUserId);
    expect(whoamiResult.isAdmin).toBe(true);

    // 5. 具权管理员执行账号恢复
    const recoveryResult = await runAccountRecovery(preRoot.config, {
      isTTY: true,
      fetch: preRoot.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        targetUserId: async () => targetUserId,
        reason: async () => "  核实室友电话及线下本人身份证件  ",
        newPassword: async () => "new-recovered-password-123",
        confirm: async () => true
      }
    });

    expect(recoveryResult.ok).toBe(true);
    expect(recoveryResult.status).toBe("recovered");
    expect(recoveryResult.setPasswordResult).toBe("succeeded");
    expect(recoveryResult.revokeSessionsResult).toBe("succeeded");

    // 6. 验证旧会话已失效
    const oldSessionAfterRes = await preRoot.trustedFetch(`${preRoot.config.baseUrl}/api/auth/get-session`, {
      headers: { origin: preRoot.config.baseUrl, cookie: targetOldCookie }
    });
    expect(oldSessionAfterRes.status).toBe(200);
    const oldSessionJson = await oldSessionAfterRes.json();
    expect(oldSessionJson).toBeNull();

    // 7. 验证旧密码无法登录
    const oldLoginRes = await preRoot.trustedFetch(`${preRoot.config.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: preRoot.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ email: "target@example.com", password: "old-password-123" })
    });
    expect(oldLoginRes.status).toBe(401);

    // 8. 验证新密码成功登录
    const newLoginRes = await preRoot.trustedFetch(`${preRoot.config.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: preRoot.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ email: "target@example.com", password: "new-recovered-password-123" })
    });
    expect(newLoginRes.status).toBe(200);
    expect(((await newLoginRes.json()) as { user: { id: string } }).user.id).toBe(targetUserId);

    // 9. 验证数据库最小审计记录
    const db = openDatabase(preRoot.dbPath);
    try {
      const auditRows = db.select().from(adminAuditLog).where(and(eq(adminAuditLog.targetType, "user"), eq(adminAuditLog.targetId, targetUserId))).all();
      expect(auditRows.length).toBe(1);
      const audit = auditRows[0]!;
      expect(audit.adminUserId).toBe(adminUserId);
      expect(audit.targetType).toBe("user");
      expect(audit.targetId).toBe(targetUserId);
      expect(audit.action).toBe("recover_account");
      expect(audit.reason).toBe("核实室友电话及线下本人身份证件");
      expect(audit.result).toBe("succeeded");
      expect(audit.details).toContain("succeeded");

      // 验证审计记录绝不包含密码、Cookie 或邮箱
      const rawRow = JSON.stringify(audit);
      expect(rawRow).not.toContain("password");
      expect(rawRow).not.toContain("admin-password-123");
      expect(rawRow).not.toContain("old-password-123");
      expect(rawRow).not.toContain("new-recovered-password-123");
      expect(rawRow).not.toContain("target@example.com");
      expect(rawRow).not.toContain("admin@example.com");
    } finally {
      db.$client.close();
    }
  });

  it("目标用户不存在时设置密码失败，记录审计且未假报完整恢复", async () => {
    const { config, trustedFetch, dbPath, restartApp } = await setupTestApp();

    // 注册管理员
    const adminRegRes = await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await restartApp([adminUserId]);

    const nonExistentUserId = v7();
    const result = await runAccountRecovery(config, {
      isTTY: true,
      fetch: trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        targetUserId: async () => nonExistentUserId,
        reason: async () => "核实不存在的账号",
        newPassword: async () => "new-password-123",
        confirm: async () => true
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.setPasswordResult).toContain("failed");
    expect(result.revokeSessionsResult).toBe("not_attempted");

    // 检查审计
    const db = openDatabase(dbPath);
    try {
      const auditRows = db.select().from(adminAuditLog).where(and(eq(adminAuditLog.targetType, "user"), eq(adminAuditLog.targetId, nonExistentUserId))).all();
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]!.result).toBe("failed");
      expect(auditRows[0]!.details).toContain("failed");
    } finally {
      db.$client.close();
    }
  });

  it("设密成功但撤销会话失败时报告部分完成，不假报完整恢复", async () => {
    const { config, trustedFetch, dbPath, restartApp } = await setupTestApp();

    // 注册管理员
    const adminRegRes = await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await restartApp([adminUserId]);

    // 注册目标用户
    const targetRegRes = await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Target", email: "target-part@example.com", password: "old-password-123" })
    });
    const targetUserId = ((await targetRegRes.json()) as { user: { id: string } }).user.id;

    // 拦截 revoke-user-sessions 请求使其返回 500 模拟失败
    const interceptedFetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/admin/revoke-user-sessions")) {
        return new Response(JSON.stringify({ error: { code: "SIMULATED_REVOKE_FAILURE" } }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
      return trustedFetch(url, init);
    };

    const result = await runAccountRecovery(config, {
      isTTY: true,
      fetch: interceptedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        targetUserId: async () => targetUserId,
        reason: async () => "核实身份恢复密码",
        newPassword: async () => "new-password-123",
        confirm: async () => true
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("partially_completed");
    expect(result.setPasswordResult).toBe("succeeded");
    expect(result.revokeSessionsResult).toContain("failed");
    expect(result.message).toContain("未完成完整恢复");

    // 检查审计
    const db = openDatabase(dbPath);
    try {
      const auditRows = db.select().from(adminAuditLog).where(and(eq(adminAuditLog.targetType, "user"), eq(adminAuditLog.targetId, targetUserId))).all();
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]!.result).toBe("partially_completed");
      expect(auditRows[0]!.details).toContain("succeeded");
      expect(auditRows[0]!.details).toContain("failed");
    } finally {
      db.$client.close();
    }
  });

  it("未白名单开放的管理端点 (如 list-users) 返回 404", async () => {
    const { config, trustedFetch } = await setupTestApp();

    const res = await trustedFetch(`${config.baseUrl}/api/auth/admin/list-users`, {
      method: "GET",
      headers: { origin: config.baseUrl }
    });
    expect(res.status).toBe(404);
  });

  it("审计数据库写入异常时命令明确报错，不假报成功", async () => {
    const { config, trustedFetch, restartApp } = await setupTestApp();

    // 注册管理员
    const adminRegRes = await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await restartApp([adminUserId]);

    // 注册目标用户
    const targetRegRes = await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Target", email: "target-audit@example.com", password: "old-password-123" })
    });
    const targetUserId = ((await targetRegRes.json()) as { user: { id: string } }).user.id;

    // 修改 config.dbPath 指向只读或无效路径触发审计写入异常
    const invalidDbConfig = {
      ...config,
      dbPath: "/dev/null/nonexistent.sqlite"
    };

    await expect(
      runAccountRecovery(invalidDbConfig, {
        isTTY: true,
        fetch: trustedFetch,
        prompts: {
          adminEmail: async () => "admin@example.com",
          adminPassword: async () => "admin-password-123",
          targetUserId: async () => targetUserId,
          reason: async () => "核实身份",
          newPassword: async () => "new-password-123",
          confirm: async () => true
        }
      })
    ).rejects.toThrowError(/审计/);
  });

  it("命令执行过程中发送精确匹配的 Origin 请求头，并在退出后完成服务端 sign-out", async () => {
    const { config, trustedFetch, restartApp } = await setupTestApp();

    // 注册管理员
    const adminRegRes = await trustedFetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await restartApp([adminUserId]);

    const capturedOrigins: string[] = [];
    let sawSignOut = false;

    const trackingFetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const headers = new Headers(init.headers);
      const origin = headers.get("origin");
      if (origin) {
        capturedOrigins.push(origin);
      }
      if (urlStr.includes("/sign-out")) {
        sawSignOut = true;
      }
      return trustedFetch(url, init);
    };

    const whoami = await runAdminWhoami(config, {
      isTTY: true,
      fetch: trackingFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123"
      }
    });

    expect(whoami.ok).toBe(true);
    expect(sawSignOut).toBe(true);
    expect(capturedOrigins.length).toBeGreaterThan(0);
    for (const origin of capturedOrigins) {
      expect(origin).toBe(config.baseUrl);
    }
  });
});
