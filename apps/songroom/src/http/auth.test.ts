import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { createApp, type SongRoomApp } from "./app.js";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import type { AppConfig } from "../config.js";

const roots: string[] = [];
const apps: SongRoomApp[] = [];
const secret = "test-secret-with-at-least-32-characters";
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await Promise.all(apps.map(app => app.close()));
  apps.length = 0;
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function fixture(nodeEnv: AppConfig["nodeEnv"] = "test"): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-auth-"));
  roots.push(root);
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><html><body>SongRoom</body></html>");
  await fs.writeFile(path.join(staticRoot, "assets", "index-Abcd1234.js"), "console.log('SongRoom')");
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);
  return { nodeEnv, host: "127.0.0.1", port, baseUrl: nodeEnv === "production" ? "https://songs.example" : `http://127.0.0.1:${port}`, dbPath, staticRoot, authSecret: secret };
}

async function create(nodeEnv: AppConfig["nodeEnv"] = "test"): Promise<{ app: SongRoomApp; config: AppConfig }> {
  const config = await fixture(nodeEnv);
  const app = await createApp(config);
  apps.push(app);
  return { app, config };
}

async function start(): Promise<{ app: SongRoomApp; config: AppConfig }> {
  const result = await create();
  await result.app.listen();
  return result;
}

async function authRequest(config: AppConfig, pathName: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${config.baseUrl}/api/auth${pathName}`, {
    ...init,
    headers: { origin: config.baseUrl, "content-type": "application/json", ...init.headers }
  });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie()[0];
  expect(cookie).toBeTruthy();
  return cookie!.split(";", 1)[0];
}

async function injectedAuthRequest(app: SongRoomApp, config: AppConfig, pathName: string, init: RequestInit = {}): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method: (init.method ?? "GET") as "GET" | "POST",
    url: `/api/auth${pathName}`,
    headers: { origin: config.baseUrl, "content-type": "application/json", ...init.headers as Record<string, string> },
    payload: typeof init.body === "string" ? init.body : undefined
  };
  return app.fastify.inject(options);
}

async function signUp(config: AppConfig, email: string, name = "可重复称呼"): Promise<Response> {
  return authRequest(config, "/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name, email, password: "correct horse battery staple" })
  });
}

describe("Better Auth 账号闭环", () => {
  it("注册自动登录，允许重复称呼并拒绝重复邮箱", async () => {
    const { config } = await start();
    const first = await signUp(config, "first@example.com");
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("HttpOnly");
    expect(first.headers.get("set-cookie")).toContain("SameSite=Lax");
    const firstBody = await first.json() as { user: { name: string; email: string }; token?: string | null };
    expect(firstBody.user).toMatchObject({ name: "可重复称呼", email: "first@example.com" });
    expect(firstBody.token).toBeTruthy();

    const firstCookie = sessionCookie(first);
    const updated = await authRequest(config, "/update-user", { method: "POST", headers: { cookie: firstCookie }, body: JSON.stringify({ name: "可重复称呼的新称呼" }) });
    expect(updated.status).toBe(200);
    expect((await (await authRequest(config, "/get-session", { headers: { cookie: firstCookie } })).json()).user.name).toBe("可重复称呼的新称呼");

    const second = await signUp(config, "second@example.com");
    expect(second.status).toBe(200);
    const logCalls: unknown[][] = [];
    const logSpies = (["error", "warn", "log"] as const).map(method => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logCalls.push([method, ...args]); }));
    let duplicateEmail: Response;
    try {
      duplicateEmail = await signUp(config, "first@example.com", "另一个称呼");
    } finally {
      logSpies.forEach(spy => spy.mockRestore());
    }
    expect(duplicateEmail!.status).toBe(422);
    expect(await duplicateEmail!.text()).not.toContain("first@example.com");
    expect(JSON.stringify(logCalls)).not.toMatch(/first@example\.com|另一个称呼|correct horse battery staple|session=/);
  });

  it("错误密码不能登录，两个设备会话互不影响且退出只撤销当前会话", async () => {
    const { config } = await start();
    await signUp(config, "device@example.com");
    const wrong = await authRequest(config, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "device@example.com", password: "wrong password" })
    });
    expect(wrong.status).toBe(401);

    const first = await authRequest(config, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "device@example.com", password: "correct horse battery staple" })
    });
    const second = await authRequest(config, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "device@example.com", password: "correct horse battery staple" })
    });
    const firstCookie = sessionCookie(first);
    const secondCookie = sessionCookie(second);
    expect(firstCookie).not.toBe(secondCookie);

    const signedOut = await authRequest(config, "/sign-out", { method: "POST", headers: { cookie: firstCookie }, body: "{}" });
    expect(signedOut.status).toBe(200);
    expect((await authRequest(config, "/get-session", { headers: { cookie: firstCookie } })).status).toBe(200);
    expect(await (await authRequest(config, "/get-session", { headers: { cookie: firstCookie } })).json()).toBeNull();
    const otherSession = await authRequest(config, "/get-session", { headers: { cookie: secondCookie } });
    expect(otherSession.status).toBe(200);
    expect((await otherSession.json()).user.email).toBe("device@example.com");
  });

  it("改密要求当前密码并保留其他设备会话", async () => {
    const { config } = await start();
    await signUp(config, "password@example.com");
    const first = await authRequest(config, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "password@example.com", password: "correct horse battery staple" })
    });
    const second = await authRequest(config, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "password@example.com", password: "correct horse battery staple" })
    });
    const firstCookie = sessionCookie(first);
    const secondCookie = sessionCookie(second);
    const wrongCurrent = await authRequest(config, "/change-password", {
      method: "POST",
      headers: { cookie: firstCookie },
      body: JSON.stringify({ currentPassword: "wrong current password", newPassword: "new correct horse battery staple" })
    });
    expect(wrongCurrent.status).toBe(400);
    const changed = await authRequest(config, "/change-password", {
      method: "POST",
      headers: { cookie: firstCookie },
      body: JSON.stringify({ currentPassword: "correct horse battery staple", newPassword: "new correct horse battery staple" })
    });
    expect(changed.status).toBe(200);
    const oldPassword = await authRequest(config, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "password@example.com", password: "correct horse battery staple" })
    });
    expect(oldPassword.status).toBe(401);
    const otherSession = await authRequest(config, "/get-session", { headers: { cookie: secondCookie } });
    expect((await otherSession.json()).user.email).toBe("password@example.com");
  });

  it("遵循固定的 8 到 128 个字符密码范围", async () => {
    const { config } = await start();
    expect((await authRequest(config, "/sign-up/email", { method: "POST", body: JSON.stringify({ name: "short", email: "short@example.com", password: "1234567" }) })).status).toBe(400);
    expect((await authRequest(config, "/sign-up/email", { method: "POST", body: JSON.stringify({ name: "minimum", email: "minimum@example.com", password: "12345678" }) })).status).toBe(200);
    expect((await authRequest(config, "/sign-up/email", { method: "POST", body: JSON.stringify({ name: "long", email: "long@example.com", password: "x".repeat(129) }) })).status).toBe(400);
  });

  it("会话按一天续期，过期会话失效后可重新登录", async () => {
    const { app, config } = await start();
    const created = await signUp(config, "renew@example.com");
    const cookie = sessionCookie(created);
    const now = Date.now();
    app.database.$client.prepare("UPDATE session SET updated_at = ?, expires_at = ? WHERE user_id = (SELECT id FROM user WHERE email = ?)").run(now, now + 7 * DAY, "renew@example.com");
    const unchanged = app.database.$client.prepare("SELECT expires_at AS expiresAt FROM session WHERE user_id = (SELECT id FROM user WHERE email = ?)").get("renew@example.com") as { expiresAt: number };
    await authRequest(config, "/get-session", { headers: { cookie } });
    const stillUnchanged = app.database.$client.prepare("SELECT expires_at AS expiresAt FROM session WHERE user_id = (SELECT id FROM user WHERE email = ?)").get("renew@example.com") as { expiresAt: number };
    expect(stillUnchanged.expiresAt).toBe(unchanged.expiresAt);
    app.database.$client.prepare("UPDATE session SET updated_at = ?, expires_at = ? WHERE user_id = (SELECT id FROM user WHERE email = ?)").run(now - 2 * DAY, now + DAY, "renew@example.com");
    const refreshed = await authRequest(config, "/get-session", { headers: { cookie } });
    expect((await refreshed.json()).user.email).toBe("renew@example.com");
    const renewed = app.database.$client.prepare("SELECT expires_at AS expiresAt FROM session WHERE user_id = (SELECT id FROM user WHERE email = ?)").get("renew@example.com") as { expiresAt: number };
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 6 * DAY);
    app.database.$client.prepare("UPDATE session SET expires_at = ? WHERE user_id = (SELECT id FROM user WHERE email = ?)").run(Date.now() - 1, "renew@example.com");
    expect(await (await authRequest(config, "/get-session", { headers: { cookie } })).json()).toBeNull();
    expect((await authRequest(config, "/sign-in/email", { method: "POST", body: JSON.stringify({ email: "renew@example.com", password: "correct horse battery staple" }) })).status).toBe(200);
  });

  it("生产入口启用 Secure Cookie，并按认证接口默认规则限流", async () => {
    const { app, config } = await create("production");
    await app.listen();
    const created = await injectedAuthRequest(app, config, "/sign-up/email", { method: "POST", body: JSON.stringify({ name: "production", email: "production@example.com", password: "correct horse battery staple" }) });
    const cookie = Array.isArray(created.headers["set-cookie"]) ? created.headers["set-cookie"][0] : created.headers["set-cookie"];
    expect(cookie).toContain("__Secure-");
    expect(cookie).toContain("Secure");
    const attempts = await Promise.all([1, 2, 3, 4].map(() => injectedAuthRequest(app, config, "/sign-in/email", { method: "POST", body: JSON.stringify({ email: "production@example.com", password: "wrong password" }) })));
    expect(attempts.slice(0, 3).every(response => response.statusCode === 401)).toBe(true);
    expect(attempts[3].statusCode).toBe(429);
  });

  it("达到账号上限时只拒绝新注册，已有账号仍可登录", async () => {
    const { app, config } = await start();
    await signUp(config, "existing@example.com");
    const insert = app.database.$client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    const now = Date.now();
    const insertMany = app.database.$client.transaction(() => {
      for (let index = 0; index < 99; index += 1) insert.run(`fixture-user-${index}`, "fixture", `fixture-${index}@example.com`, 0, now, now);
    });
    insertMany();
    expect((app.database.$client.prepare("SELECT COUNT(*) AS count FROM user").get() as { count: number }).count).toBe(100);
    expect((await signUp(config, "blocked@example.com")).status).toBe(403);
    expect((await authRequest(config, "/sign-in/email", { method: "POST", body: JSON.stringify({ email: "existing@example.com", password: "correct horse battery staple" }) })).status).toBe(200);
  });
});
