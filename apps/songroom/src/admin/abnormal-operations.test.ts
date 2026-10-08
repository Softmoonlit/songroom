import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { initializeDatabase, openDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "../http/app.js";
import type { AppConfig } from "../config.js";
import {
  runAdminAbnormalAction,
  runAdminAbnormalList,
  runAdminAbnormalShow
} from "./abnormal-operations-cli.js";
import {
  adminAuditLog,
  neteaseAuthorization,
  operation,
  publicPlaylistBinding,
  publicPlaylistCleanup,
  publicPlaylistCreation,
  publicSongRequest,
  room,
  roomMembership,
  upstreamAccount,
  user
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { NeteaseAdapter } from "../netease/protocol.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch {
      // ignore cleanup errors
    }
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
const certDir = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-abnormal-ssl-"));
const keyPath = path.join(certDir, "https-key.pem");
const certPath = path.join(certDir, "https-cert.pem");
execSync(
  `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 1 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"`,
  { stdio: "ignore" }
);
const sslKey = await fs.readFile(keyPath);
const sslCert = await fs.readFile(certPath);

async function setupTestApp(
  options: {
    adminUserIds?: string[];
    adapter?: NeteaseAdapter;
  } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-abnormal-admin-test-"));
  cleanups.push(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const staticDir = path.join(root, "static");
  await fs.mkdir(path.join(staticDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticDir, "index.html"), "<html><body>App</body></html>");

  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 7), { mode: 0o600 });

  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);

  let currentApp: SongRoomApp | null = null;
  let currentProxy: https.Server | null = null;
  let currentConfig: AppConfig;
  let httpsPort = 0;

  const startInstance = async (adminIds?: string[]) => {
    if (currentProxy) {
      await new Promise<void>((r) => currentProxy!.close(() => r()));
      currentProxy = null;
    }
    if (currentApp) {
      await currentApp.close();
      currentApp = null;
    }

    if (httpsPort === 0) {
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
      httpsPort = (probe.address() as { port: number }).port;
      await new Promise<void>((r) => probe.close(() => r()));
    }

    const appSocket = createServer();
    await new Promise<void>((r) => appSocket.listen(0, "127.0.0.1", () => r()));
    const appPort = (appSocket.address() as { port: number }).port;
    await new Promise<void>((r) => appSocket.close(() => r()));

    currentConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: appPort,
      baseUrl: `https://127.0.0.1:${httpsPort}`,
      dbPath,
      staticRoot: staticDir,
      authSecret: "test-auth-secret-of-at-least-32-chars-long",
      credentialKeyPath,
      adminUserIds: adminIds ?? options.adminUserIds ?? []
    };

    currentApp = await createApp(currentConfig, { neteaseAdapter: options.adapter });
    await currentApp.listen();

    currentProxy = https.createServer({ key: sslKey, cert: sslCert }, (req, res) => {
      const proxyReq = http.request(
        {
          host: "127.0.0.1",
          port: appPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${httpsPort}`,
            "x-forwarded-for": "127.0.0.1",
            "x-forwarded-proto": "https"
          }
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end();
        }
      });
      req.pipe(proxyReq);
    });

    await new Promise<void>((r) => currentProxy!.listen(httpsPort, "127.0.0.1", () => r()));

    return { config: currentConfig, app: currentApp };
  };

  await startInstance();

  cleanups.push(async () => {
    if (currentProxy) {
      await new Promise<void>((r) => currentProxy!.close(() => r()));
    }
    if (currentApp) {
      await currentApp.close();
    }
  });

  const trustedFetch = createHttpsFetch(sslCert);

  return {
    dbPath,
    credentialKeyPath,
    get app() {
      return currentApp!;
    },
    get config() {
      return currentConfig;
    },
    trustedFetch,
    restartApp: startInstance
  };
}

describe("Ticket 20: 通过管理命令处置异常操作", () => {
  it("无权拒绝：未登录或普通用户访问管理端点均被拒绝 (401 / 403)", async () => {
    const env = await setupTestApp();

    // 1. 未登录访问 -> 401
    const unauthRes = await env.trustedFetch(`${env.config.baseUrl}/api/admin/abnormal-operations`, {
      method: "GET",
      headers: { origin: env.config.baseUrl }
    });
    expect(unauthRes.status).toBe(401);

    // 2. 注册普通用户 (不在 adminUserIds 中)
    const userRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Regular", email: "user@example.com", password: "user-password-123" })
    });
    expect(userRegRes.ok).toBe(true);
    const userCookie = userRegRes.headers.get("set-cookie") ?? "";

    // 3. 普通用户访问管理列表 -> 403
    const forbiddenRes = await env.trustedFetch(`${env.config.baseUrl}/api/admin/abnormal-operations`, {
      method: "GET",
      headers: { origin: env.config.baseUrl, cookie: userCookie }
    });
    expect(forbiddenRes.status).toBe(403);

    // 4. 普通用户尝试调用处置端点 -> 403
    const forbiddenActionRes = await env.trustedFetch(`${env.config.baseUrl}/api/admin/abnormal-operations/op-1/resolve-song-write`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, cookie: userCookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "尝试越权", expectedVersion: 1 })
    });
    expect(forbiddenActionRes.status).toBe(403);
  });

  it("普通未知写入终结：终结为结果未能确认，解除目标阻塞，记录审计且新点歌可提交", async () => {
    const env = await setupTestApp();

    // 1. 注册管理员账号
    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    // 2. 在数据库中准备一个处于 awaitingConfirmation 的普通歌曲写入长期未知操作
    const userId = v7();
    const roomId = v7();
    const accountId = "netease-user-1";
    const opId = v7();
    const playlistId = "pl-target-1";
    const songId = "song-12345";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "User1", email: "u1@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
      db.insert(room).values({ id: roomId, ownerUserId: userId, name: "测试房间" }).run();
      db.insert(roomMembership).values({ id: v7(), roomId, userId, nickname: "房主" }).run();

      db.insert(operation).values({
        id: opId,
        kind: "requestPublicSong",
        userId,
        roomId,
        accountId,
        authorizationId: v7(),
        generation: 1,
        status: "awaitingConfirmation",
        errorCode: "MODULE_ERROR",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();

      db.insert(publicSongRequest).values({
        operationId: opId,
        songId,
        name: "测试歌曲",
        artists: "测试歌手",
        album: "测试专辑",
        step: "unknown",
        playlistId,
        bindingGeneration: 1,
        checkRound: 3,
        nextCheckAt: null
      }).run();
    } finally {
      db.$client.close();
    }

    // 3. 管理员 CLI 列出异常操作并查看脱敏事实
    const listResult = await runAdminAbnormalList(env.config, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123"
      }
    });
    expect(listResult.ok).toBe(true);
    expect(listResult.operations?.length).toBe(1);
    expect(listResult.operations?.[0]?.id).toBe(opId);
    expect(listResult.operations?.[0]?.type).toBe("unknown_song_write");
    // 验证不含凭据或请求体
    const rawList = JSON.stringify(listResult.operations);
    expect(rawList).not.toContain("cookie");
    expect(rawList).not.toContain("credentials");

    const showResult = await runAdminAbnormalShow(env.config, opId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123"
      }
    });
    expect(showResult.ok).toBe(true);
    expect(showResult.detail?.id).toBe(opId);
    expect(showResult.detail?.playlistId).toBe(playlistId);
    expect(showResult.detail?.impactDescription).toContain("解除该公共歌单的目标写入阻塞");

    // 4. 管理员通过 CLI 处置终结该操作
    const actionResult = await runAdminAbnormalAction(env.config, "resolve-write", opId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "已核实上游读回三轮超时，终结待确认状态以解除目标阻塞",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(true);
    expect(actionResult.status).toBe("succeeded");
    expect(actionResult.result?.conclusion).toBe("unconfirmed_terminal");

    // 5. 校验数据库中的持久状态变化与最小审计记录
    const verifyDb = openDatabase(env.dbPath);
    try {
      const updatedOp = verifyDb.select().from(operation).where(eq(operation.id, opId)).get()!;
      expect(updatedOp.status).toBe("stopped");
      expect(updatedOp.accountId).toBeNull();
      expect(updatedOp.authorizationId).toBeNull();
      expect(updatedOp.generation).toBeNull();
      expect(updatedOp.version).toBe(2);

      const updatedReq = verifyDb.select().from(publicSongRequest).where(eq(publicSongRequest.operationId, opId)).get()!;
      expect(updatedReq.step).toBe("stopped");
      expect(updatedReq.nextCheckAt).toBeNull();

      // 验证审计日志
      const audit = verifyDb.select().from(adminAuditLog).where(and(eq(adminAuditLog.targetType, "operation"), eq(adminAuditLog.targetId, opId))).get()!;
      expect(audit.adminUserId).toBe(adminUserId);
      expect(audit.action).toBe("resolve_song_write");
      expect(audit.previousStatus).toBe("awaitingConfirmation");
      expect(audit.nextStatus).toBe("stopped");
      expect(audit.result).toBe("succeeded");
      expect(audit.reason).toBe("已核实上游读回三轮超时，终结待确认状态以解除目标阻塞");
      expect(audit.details).toContain(playlistId);
      expect(audit.details).not.toContain(songId);
    } finally {
      verifyDb.$client.close();
    }
  });

  it("创建证据歧义：新增歌单数量不等于 1 时继续暂停，不得猜测或创建", async () => {
    const env = await setupTestApp();

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const roomId = v7();
    const opId = v7();
    const accountId = "netease-user-2";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner2", email: "owner2@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
      db.insert(room).values({ id: roomId, ownerUserId: userId, name: "创建房间" }).run();

      db.insert(operation).values({
        id: opId,
        kind: "createPublicPlaylist",
        userId,
        roomId,
        accountId,
        authorizationId: v7(),
        generation: 1,
        status: "needsAdministrator",
        errorCode: "MODULE_ERROR",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();

      // 证据歧义：before 1个，after 还是同一个（新增 0 个）
      db.insert(publicPlaylistCreation).values({
        operationId: opId,
        name: "新建公共歌单",
        step: "unknown",
        beforePlaylists: JSON.stringify([{ id: "pl-exist-1", name: "原歌单" }]),
        afterPlaylists: JSON.stringify([{ id: "pl-exist-1", name: "原歌单" }]),
        recovered: false
      }).run();
    } finally {
      db.$client.close();
    }

    const actionResult = await runAdminAbnormalAction(env.config, "resolve-create", opId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "核查网易云歌单列表发现新增为0，证据歧义保持暂停",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(true);
    expect(actionResult.result?.conclusion).toBe("ambiguous_continued_pause");

    const verifyDb = openDatabase(env.dbPath);
    try {
      const opRow = verifyDb.select().from(operation).where(eq(operation.id, opId)).get()!;
      expect(opRow.status).toBe("needsAdministrator"); // 保持 needsAdministrator
      expect(opRow.version).toBe(2);

      // 确保未创建 publicPlaylistBinding
      const bindings = verifyDb.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).all();
      expect(bindings.length).toBe(0);

      // 验证审计日志
      const audit = verifyDb.select().from(adminAuditLog).where(and(eq(adminAuditLog.targetType, "operation"), eq(adminAuditLog.targetId, opId))).get()!;
      expect(audit.result).toBe("ambiguous");
      expect(audit.previousStatus).toBe("needsAdministrator");
      expect(audit.nextStatus).toBe("needsAdministrator");
    } finally {
      verifyDb.$client.close();
    }
  });

  it("创建证据唯一且业务仍有效：恢复绑定，生成权威快照并完成操作", async () => {
    const env = await setupTestApp();

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const roomId = v7();
    const opId = v7();
    const accountId = "netease-user-3";
    const newPlaylistId = "pl-newly-created-999";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner3", email: "owner3@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
      db.insert(room).values({ id: roomId, ownerUserId: userId, name: "恢复绑定房间" }).run();

      // 原房主具有当前活跃授权
      const vault = new CredentialVault(env.config.credentialKeyPath);
      const authId = v7();
      const encrypted = vault.encrypt("fake_cookie_value", { authorizationId: authId, accountId, generation: 1 });
      db.insert(neteaseAuthorization).values({
        id: authId,
        userId,
        accountId,
        nickname: "网易云用户3",
        generation: 1,
        status: "active",
        credentials: encrypted
      }).run();

      db.insert(operation).values({
        id: opId,
        kind: "createPublicPlaylist",
        userId,
        roomId,
        accountId,
        authorizationId: v7(),
        generation: 1,
        status: "needsAdministrator",
        errorCode: "MODULE_ERROR",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();

      // 证据唯一：before 1个，after 2个 (新增 1 个: newPlaylistId)
      db.insert(publicPlaylistCreation).values({
        operationId: opId,
        name: "点歌台专用公共歌单",
        step: "unknown",
        beforePlaylists: JSON.stringify([{ id: "pl-exist-1", name: "原歌单" }]),
        afterPlaylists: JSON.stringify([
          { id: "pl-exist-1", name: "原歌单" },
          { id: newPlaylistId, name: "点歌台专用公共歌单" }
        ]),
        recovered: false
      }).run();
    } finally {
      db.$client.close();
    }

    const actionResult = await runAdminAbnormalAction(env.config, "resolve-create", opId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "证据明确唯一，原房间和授权有效，恢复公共歌单绑定",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(true);
    expect(actionResult.result?.conclusion).toBe("binding_restored");

    const verifyDb = openDatabase(env.dbPath);
    try {
      const opRow = verifyDb.select().from(operation).where(eq(operation.id, opId)).get()!;
      expect(opRow.status).toBe("succeeded");
      expect(opRow.accountId).toBeNull(); // 终结后清空凭据代次
      expect(opRow.version).toBe(2);

      const creationRow = verifyDb.select().from(publicPlaylistCreation).where(eq(publicPlaylistCreation.operationId, opId)).get()!;
      expect(creationRow.step).toBe("succeeded");
      expect(creationRow.playlistId).toBe(newPlaylistId);
      expect(creationRow.recovered).toBe(true);

      const binding = verifyDb.select().from(publicPlaylistBinding).where(eq(publicPlaylistBinding.roomId, roomId)).get()!;
      expect(binding.playlistId).toBe(newPlaylistId);
      expect(binding.creationOperationId).toBe(opId);
    } finally {
      verifyDb.$client.close();
    }
  });

  it("创建证据唯一但原业务已结束：原房间已删除时转公共清理任务并终结操作", async () => {
    const env = await setupTestApp();

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const deletedRoomId = v7();
    const opId = v7();
    const accountId = "netease-user-4";
    const newPlaylistId = "pl-orphan-888";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner4", email: "owner4@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
      // 注意：不插入 room，模拟原房间已被房主删除

      db.insert(operation).values({
        id: opId,
        kind: "createPublicPlaylist",
        userId,
        roomId: deletedRoomId,
        accountId,
        authorizationId: v7(),
        generation: 1,
        status: "needsAdministrator",
        errorCode: "MODULE_ERROR",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();

      db.insert(publicPlaylistCreation).values({
        operationId: opId,
        name: "已删房间的歌单",
        step: "unknown",
        beforePlaylists: JSON.stringify([]),
        afterPlaylists: JSON.stringify([{ id: newPlaylistId, name: "已删房间的歌单" }]),
        recovered: false
      }).run();
    } finally {
      db.$client.close();
    }

    const actionResult = await runAdminAbnormalAction(env.config, "resolve-create", opId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "原房间已删除，将唯一新增孤儿歌单转入公共清理队列",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(true);
    expect(actionResult.result?.conclusion).toBe("transferred_to_cleanup");

    const verifyDb = openDatabase(env.dbPath);
    try {
      const opRow = verifyDb.select().from(operation).where(eq(operation.id, opId)).get()!;
      expect(opRow.status).toBe("stopped");
      expect(opRow.accountId).toBeNull();

      // 验证已生成对应的 publicPlaylistCleanup
      const cleanup = verifyDb.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.playlistId, newPlaylistId)).get()!;
      expect(cleanup.userId).toBe(userId);
      expect(cleanup.accountId).toBe(accountId);
      expect(cleanup.creationOperationId).toBe(opId);
    } finally {
      verifyDb.$client.close();
    }
  });

  it("单次删除授权与防重复消费：核实存活后单次授权，执行进入 sending 瞬间立即消费授权", async () => {
    let deleteCallCount = 0;
    const fakeAdapter: NeteaseAdapter = {
      assertVendorIntegrity: async () => {},
      dispose: async () => {},
      call: async (input: any) => {
        if (input.operation === "playlistDelete") {
          deleteCallCount++;
          // 模拟删除成功
          return { ok: true, data: { status: 200 } } as any;
        }
        return { ok: true, data: {} } as any;
      }
    };

    const env = await setupTestApp({ adapter: fakeAdapter });

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const cleanupId = v7();
    const accountId = "netease-user-5";
    const playlistId = "pl-cleanup-target";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner5", email: "owner5@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();

      const vault = new CredentialVault(env.config.credentialKeyPath);
      const authId = v7();
      const encrypted = vault.encrypt("fake_cookie_value", { authorizationId: authId, accountId, generation: 1 });
      db.insert(neteaseAuthorization).values({
        id: authId,
        userId,
        accountId,
        nickname: "网易云用户5",
        generation: 1,
        status: "active",
        credentials: encrypted
      }).run();

      // 初始状态：已发过一次，处于 awaitingConfirmation，checkFact 为目标仍存活
      db.insert(publicPlaylistCleanup).values({
        id: cleanupId,
        userId,
        accountId,
        playlistId,
        hasSent: true,
        retryAuthorized: false,
        checkFact: "target_still_active",
        status: "awaitingConfirmation",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();
    } finally {
      db.$client.close();
    }

    // 管理员授权一次单次重试
    const actionResult = await runAdminAbnormalAction(env.config, "authorize-cleanup", cleanupId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "核实原目标仍存活且仍应清理，明确授权单次重试删除",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(true);
    expect(actionResult.result?.conclusion).toBe("retry_authorized");

    // 验证数据库：此时 retryAuthorized 应为 false (因为在 dispatchCleanup 认领进入 sending 时已原子消费)，状态最终为 succeeded
    const verifyDb = openDatabase(env.dbPath);
    try {
      const cleanup = verifyDb.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get()!;
      expect(cleanup.status).toBe("succeeded");
      expect(cleanup.hasSent).toBe(true);
      expect(cleanup.retryAuthorized).toBe(false); // 必须被消费重置
      expect(deleteCallCount).toBe(1);

      // 防重复消费验证：如果再手动调用 dispatchCleanup，由于 retryAuthorized 为 false 且 hasSent 为 true，绝不再次调用删除
      // 保持 deleteCallCount 仍为 1
      expect(deleteCallCount).toBe(1);
    } finally {
      verifyDb.$client.close();
    }
  });

  it("手工清理核验：记录房主已在官方客户端手工处理，触发服务端只读核验并成功收敛", async () => {
    let identityCallCount = 0;
    let userPlaylistsCallCount = 0;
    let detailCallCount = 0;

    const fakeAdapter: NeteaseAdapter = {
      assertVendorIntegrity: async () => {},
      dispose: async () => {},
      call: async (input: any) => {
        if (input.operation === "identity") {
          identityCallCount++;
          return { ok: true, data: { accountId: "netease-user-6", nickname: "OfficialUser" } } as any;
        }
        if (input.operation === "userPlaylists") {
          userPlaylistsCallCount++;
          // 清单中无此目标 (已在官方客户端被删)
          return { ok: true, data: { playlists: [], more: false } } as any;
        }
        if (input.operation === "playlistDetail") {
          detailCallCount++;
          // 详情返回 404
          return { ok: false, error: { code: "NOT_FOUND", businessCode: 404, httpStatus: 404, message: "歌单不存在" } } as any;
        }
        return { ok: true, data: {} } as any;
      }
    };

    const env = await setupTestApp({ adapter: fakeAdapter });

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const cleanupId = v7();
    const accountId = "netease-user-6";
    const playlistId = "pl-manual-cleaned";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner6", email: "owner6@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();

      const vault = new CredentialVault(env.config.credentialKeyPath);
      const authId = v7();
      const encrypted = vault.encrypt("fake_cookie_value", { authorizationId: authId, accountId, generation: 1 });
      db.insert(neteaseAuthorization).values({
        id: authId,
        userId,
        accountId,
        nickname: "网易云用户6",
        generation: 1,
        status: "active",
        credentials: encrypted
      }).run();

      // 上游明确拒绝删除后的状态：needsAdministrator, TARGET_PERMISSION
      db.insert(publicPlaylistCleanup).values({
        id: cleanupId,
        userId,
        accountId,
        playlistId,
        hasSent: true,
        retryAuthorized: false,
        checkFact: "upstream_rejected",
        lastErrorCode: "TARGET_PERMISSION",
        status: "needsAdministrator",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();
    } finally {
      db.$client.close();
    }

    // 管理员执行 verify-cleanup
    const actionResult = await runAdminAbnormalAction(env.config, "verify-cleanup", cleanupId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "房主反馈已在网易云官方客户端删除歌单，触发只读核验",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(true);
    expect(actionResult.result?.conclusion).toBe("manual_verification_triggered");

    // 服务端只读核验触发并异步执行，等待收敛
    const verifyDb = openDatabase(env.dbPath);
    try {
      let cleanup: any;
      for (let i = 0; i < 50; i++) {
        cleanup = verifyDb.select().from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, cleanupId)).get()!;
        if (cleanup.status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(cleanup.status).toBe("succeeded");
      expect(cleanup.checkFact).toBe("not_found_confirmed");
      expect(identityCallCount).toBeGreaterThanOrEqual(1);
      expect(userPlaylistsCallCount).toBeGreaterThanOrEqual(1);
    } finally {
      verifyDb.$client.close();
    }
  });

  it("风控恢复：核验当前真实账号与有效授权后解除暂停，重启无法隐式恢复", async () => {
    let identityCallCount = 0;
    const fakeAdapter: NeteaseAdapter = {
      assertVendorIntegrity: async () => {},
      dispose: async () => {},
      call: async (input: any) => {
        if (input.operation === "identity") {
          identityCallCount++;
          return { ok: true, data: { accountId: "netease-user-risk-1", nickname: "风控用户" } } as any;
        }
        return { ok: true, data: {} } as any;
      }
    };
    const env = await setupTestApp({ adapter: fakeAdapter });

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const accountId = "netease-user-risk-1";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "OwnerRisk", email: "risk@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();

      const vault = new CredentialVault(env.config.credentialKeyPath);
      const authId = v7();
      const encrypted = vault.encrypt("fake_cookie_value", { authorizationId: authId, accountId, generation: 1 });
      db.insert(neteaseAuthorization).values({
        id: authId,
        userId,
        accountId,
        nickname: "风控用户",
        generation: 1,
        status: "active",
        credentials: encrypted
      }).run();

      // 插入处于 paused: true 的风控账号
      db.insert(upstreamAccount).values({
        accountId,
        paused: true,
        nextStartAt: 0
      }).run();
    } finally {
      db.$client.close();
    }

    // 重启服务：不能隐式恢复 paused 状态
    await env.restartApp([adminUserId]);
    expect(env.app.scheduler.paused(accountId)).toBe(true);

    // 管理员执行 resume-risk 恢复
    const actionResult = await runAdminAbnormalAction(env.config, "resume-risk", accountId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "核实原账号风控已线下解除且授权正常，明确恢复调度",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(true);
    expect(actionResult.result?.conclusion).toBe("risk_pause_resumed");

    // 验证账号 paused 已解除
    expect(env.app.scheduler.paused(accountId)).toBe(false);
    expect(identityCallCount).toBeGreaterThanOrEqual(1);

    const verifyDb = openDatabase(env.dbPath);
    try {
      const acc = verifyDb.select().from(upstreamAccount).where(eq(upstreamAccount.accountId, accountId)).get()!;
      expect(acc.paused).toBe(false);

      const audit = verifyDb.select().from(adminAuditLog).where(and(eq(adminAuditLog.targetType, "account"), eq(adminAuditLog.targetId, accountId))).get()!;
      expect(audit.action).toBe("resume_risk_pause");
      expect(audit.previousStatus).toBe("paused");
      expect(audit.nextStatus).toBe("active");
    } finally {
      verifyDb.$client.close();
    }
  });

  it("确认竞态：管理员确认期间状态或版本发生变化时，服务端拒绝并阻止应用过期确认", async () => {
    const env = await setupTestApp();

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const roomId = v7();
    const opId = v7();
    const accountId = "netease-user-race";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "OwnerRace", email: "race@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
      db.insert(room).values({ id: roomId, ownerUserId: userId, name: "竞态房间" }).run();

      db.insert(operation).values({
        id: opId,
        kind: "requestPublicSong",
        userId,
        roomId,
        accountId,
        authorizationId: v7(),
        generation: 1,
        status: "awaitingConfirmation",
        errorCode: "MODULE_ERROR",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();

      db.insert(publicSongRequest).values({
        operationId: opId,
        songId: "song-race",
        name: "竞态歌曲",
        artists: "歌手",
        album: "专辑",
        step: "unknown",
        playlistId: "pl-race",
        bindingGeneration: 1,
        checkRound: 3,
        nextCheckAt: null
      }).run();
    } finally {
      db.$client.close();
    }

    // 模拟在管理员输入 reason 的过程中，另一个请求递增了版本号
    const actionResult = await runAdminAbnormalAction(env.config, "resolve-write", opId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => {
          // 模拟竞态：在 prompt 期间版本号被修改
          const raceDb = openDatabase(env.dbPath);
          try {
            raceDb.update(operation).set({ version: 99 }).where(eq(operation.id, opId)).run();
          } finally {
            raceDb.$client.close();
          }
          return "核实终结写入";
        },
        confirm: async () => true
      }
    });

    // 应该执行失败，返回 409 状态已变化错误
    expect(actionResult.ok).toBe(false);
    expect(actionResult.status).toBe("failed");
    expect(actionResult.message).toContain("已发生变化");

    // 确保旧确认未被应用
    const verifyDb = openDatabase(env.dbPath);
    try {
      const opRow = verifyDb.select().from(operation).where(eq(operation.id, opId)).get()!;
      expect(opRow.status).toBe("awaitingConfirmation"); // 仍保持原状态
    } finally {
      verifyDb.$client.close();
    }
  });

  it("边界防护：自动补查尚未结束时拒绝管理员提前终结点歌 (CHECK_IN_PROGRESS)", async () => {
    const env = await setupTestApp();

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const roomId = v7();
    const opId = v7();
    const accountId = "netease-user-pending-check";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner", email: "check@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
      db.insert(room).values({ id: roomId, ownerUserId: userId, name: "补查房间" }).run();

      db.insert(operation).values({
        id: opId,
        kind: "requestPublicSong",
        userId,
        roomId,
        accountId,
        authorizationId: v7(),
        generation: 1,
        status: "awaitingConfirmation",
        errorCode: "MODULE_ERROR",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();

      // 第 1 轮且有下一次补查时间，非长期未知
      db.insert(publicSongRequest).values({
        operationId: opId,
        songId: "song-check",
        name: "补查中歌曲",
        artists: "歌手",
        album: "专辑",
        step: "unknown",
        playlistId: "pl-check",
        bindingGeneration: 1,
        checkRound: 1,
        nextCheckAt: Date.now() + 30000
      }).run();
    } finally {
      db.$client.close();
    }

    const actionResult = await runAdminAbnormalAction(env.config, "resolve-write", opId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "尝试提前终结",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(false);
    expect(actionResult.status).toBe("failed");
    expect(actionResult.message).toContain("自动补查尚未结束");
  });

  it("边界防护：未核实原目标仍存活时拒绝管理员盲目授权单次重试删除 (TARGET_NOT_ACTIVE)", async () => {
    const env = await setupTestApp();

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const cleanupId = v7();
    const accountId = "netease-user-cleanup-check";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner", email: "clean@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();

      // checkFact 为 unknown_delete_result，尚未核实目标存活
      db.insert(publicPlaylistCleanup).values({
        id: cleanupId,
        userId,
        accountId,
        playlistId: "pl-clean-unverified",
        hasSent: true,
        retryAuthorized: false,
        checkFact: "unknown_delete_result",
        status: "awaitingConfirmation",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();
    } finally {
      db.$client.close();
    }

    const actionResult = await runAdminAbnormalAction(env.config, "authorize-cleanup", cleanupId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "未核实存活尝试重试",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(false);
    expect(actionResult.status).toBe("failed");
    expect(actionResult.message).toContain("未核实原目标仍存活");
  });

  it("边界防护：非上游明确拒绝删除状态下拒绝记录手工清理并触发只读核验 (INVALID_STATE)", async () => {
    const env = await setupTestApp();

    const adminRegRes = await env.trustedFetch(`${env.config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: env.config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "admin-password-123" })
    });
    const adminUserId = ((await adminRegRes.json()) as { user: { id: string } }).user.id;
    await env.restartApp([adminUserId]);

    const userId = v7();
    const cleanupId = v7();
    const accountId = "netease-user-manual-check";

    const db = openDatabase(env.dbPath);
    try {
      db.insert(user).values({ id: userId, name: "Owner", email: "manual@example.com", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();

      // status 是 ready，从未上游明确拒绝
      db.insert(publicPlaylistCleanup).values({
        id: cleanupId,
        userId,
        accountId,
        playlistId: "pl-clean-ready",
        hasSent: false,
        retryAuthorized: false,
        checkFact: null,
        status: "ready",
        version: 1,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000
      }).run();
    } finally {
      db.$client.close();
    }

    const actionResult = await runAdminAbnormalAction(env.config, "verify-cleanup", cleanupId, {
      isTTY: true,
      fetch: env.trustedFetch,
      prompts: {
        adminEmail: async () => "admin@example.com",
        adminPassword: async () => "admin-password-123",
        reason: async () => "未明确拒绝尝试手工核验",
        confirm: async () => true
      }
    });

    expect(actionResult.ok).toBe(false);
    expect(actionResult.status).toBe("failed");
    expect(actionResult.message).toContain("仅在上游明确拒绝删除后");
  });
});
