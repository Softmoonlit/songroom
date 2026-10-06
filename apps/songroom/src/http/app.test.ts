import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type SongRoomApp } from "./app.js";
import { initializeDatabase } from "../db/database.js";
import type { AppConfig } from "../config.js";

const roots: string[] = [];
const apps: SongRoomApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map(app => app.close())); apps.length = 0;
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))); roots.length = 0;
});

async function fixture(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-http-")); roots.push(root);
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><html lang=zh-CN><title>SongRoom</title><div id=root>一起点歌</div></html>");
  await fs.writeFile(path.join(staticRoot, "assets", "index-Abcd1234.js"), "console.log('SongRoom')");
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const dbPath = path.join(root, "songroom.sqlite"); initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  return { nodeEnv: "test", host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, dbPath, staticRoot, authSecret: "test-secret-with-at-least-32-characters", credentialKeyPath };
}

async function start(config: AppConfig): Promise<SongRoomApp> {
  const app = await createApp(config); apps.push(app); await app.listen(); return app;
}

describe("同源应用运行边界", () => {
  it("监听后就绪，并提供健康、SPA、哈希资产与安全头", async () => {
    const config = await fixture(); await start(config);
    const health = await fetch(`${config.baseUrl}/healthz`);
    expect(health.status).toBe(200); expect(await health.json()).toMatchObject({ status: "ready", service: "songroom" });
    const html = await fetch(`${config.baseUrl}/unknown-route`);
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await html.text()).toContain("一起点歌");
    const asset = await fetch(`${config.baseUrl}/assets/index-Abcd1234.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("max-age=31536000");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    for (const resource of ["/api/status", "/api/unknown?secret=input", "/assets/missing.js"]) {
      const response = await fetch(config.baseUrl + resource);
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (resource !== "/api/status") expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("input");
    }
  });

  it("第二实例不能监听，失败不改变第一实例", async () => {
    const config = await fixture(); await start(config);
    const second = await createApp(config); apps.push(second);
    await expect(second.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(second.getState()).toBe("starting");
    await second.close();
    expect((await fetch(config.baseUrl + "/healthz")).status).toBe(200);
  });

  it("排空时拒绝新命令、健康变为未就绪，关闭后可重新监听", async () => {
    const config = await fixture(); const app = await start(config); app.drain();
    expect((await fetch(config.baseUrl + "/healthz")).status).toBe(503);
    const rejected = await fetch(config.baseUrl + "/api/example", { method: "POST", headers: { origin: config.baseUrl } });
    expect(rejected.status).toBe(503); expect(await rejected.json()).toMatchObject({ error: { code: "APP_DRAINING" } });
    await app.close(); expect(app.getState()).toBe("stopped");
    await start(config); expect((await fetch(config.baseUrl + "/healthz")).status).toBe(200);
  });

  it("缺少数据库或构建产物启动失败，且不生成文件", async () => {
    const config = await fixture();
    const missing = path.join(path.dirname(config.dbPath), "missing.sqlite");
    await expect(createApp({ ...config, dbPath: missing })).rejects.toThrow();
    await expect(fs.access(missing)).rejects.toThrow();
    await fs.unlink(path.join(config.staticRoot, "index.html"));
    await expect(createApp(config)).rejects.toThrow();
  });

  it("缺少或错误 Origin 的非GET请求拒绝，关闭CORS", async () => {
    const config = await fixture(); await start(config);
    for (const origin of [undefined, "https://untrusted.example"]) {
      const response = await fetch(config.baseUrl + "/api/example", { method: "POST", headers: origin ? { origin } : {} });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
    }
  });
});
