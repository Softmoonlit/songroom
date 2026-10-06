import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeAll, expect, it } from "vitest";
import { assertRuntime } from "./config.js";
import { initializeDatabase } from "./db/database.js";

// 子进程使用 process.execPath；先明确运行时要求，避免将版本拒绝误判为缺库等启动行为。
beforeAll(() => { assertRuntime(); });

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  await Promise.all(children.map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  }));
  children.length = 0;
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))); roots.length = 0;
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-process-")); roots.push(root);
  await fs.mkdir(path.join(root, "client/assets"), { recursive: true });
  await fs.writeFile(path.join(root, "client/index.html"), "<!doctype html><title>SongRoom</title><div id=root></div>");
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  await fs.writeFile(path.join(root, "netease.key"), Buffer.alloc(32, 1), { mode: 0o600 });
  const settings = { nodeEnv: "development", host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, dbPath: "songroom.sqlite", staticRoot: "client", authSecret: "test-secret-with-at-least-32-characters", credentialKeyPath: "netease.key" };
  const config = path.join(root, "config.json"); await fs.writeFile(config, JSON.stringify(settings), { mode: 0o600 });
  initializeDatabase(path.join(root, settings.dbPath));
  return { config, root, origin: settings.baseUrl };
}

function runServer(config: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { PATH: process.env.PATH, SONGROOM_CONFIG: config }, stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  let output = "";
  const exited = once(child, "close").then(([code, signal]) => ({ code, signal, output }));
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", chunk => { output += chunk.toString(); if (output.includes('"state":"ready"')) resolve(); });
    child.stderr!.on("data", chunk => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      // 仅显示生命周期状态与本测试关注的稳定码，不转发原始日志、配置或凭据。
      const allowedStates = new Set(["starting", "ready", "draining", "stopped", "failed"]);
      const allowedCodes = new Set(["STARTUP_FAILED", "EADDRINUSE", "ENOENT"]);
      const states = output.split("\n").flatMap(line => {
        try {
          const entry = JSON.parse(line) as { state?: unknown; code?: unknown };
          return typeof entry.state === "string" && allowedStates.has(entry.state)
            ? [{ state: entry.state, code: typeof entry.code === "string" && allowedCodes.has(entry.code) ? entry.code : undefined }]
            : [];
        } catch { return []; }
      });
      reject(new Error(`process exited before readiness: ${JSON.stringify({ code, signal, states })}`));
    });
  });
  void ready.catch(() => undefined);
  return { child, ready, exited };
}

it("真实服务进程监听冲突明确失败，SIGTERM正常关闭，重启保留数据库", async () => {
  const fixtureData = await fixture();
  const first = runServer(fixtureData.config); await first.ready;
  expect((await fetch(fixtureData.origin + "/healthz")).status).toBe(200);
  const second = runServer(fixtureData.config);
  const secondExit = await second.exited;
  expect(secondExit.code).toBe(1); expect(secondExit.output).toContain("EADDRINUSE");
  first.child.kill("SIGTERM");
  const shutdown = await first.exited; expect(shutdown.code).toBe(0); expect(shutdown.output).toContain('"state":"stopped"');
  const restarted = runServer(fixtureData.config); await restarted.ready;
  expect((await fetch(fixtureData.origin + "/api/status")).status).toBe(200);
  restarted.child.kill("SIGTERM"); expect((await restarted.exited).code).toBe(0);
}, 15_000);

it("真实服务缺库启动失败，不隐式初始化", async () => {
  const fixtureData = await fixture(); const database = path.join(fixtureData.root, "songroom.sqlite");
  await fs.unlink(database);
  const launched = runServer(fixtureData.config);
  const result = await launched.exited;
  expect(result.code).toBe(1);
  expect(result.output).toContain('"state":"failed","code":"ENOENT"');
  await expect(fs.access(database)).rejects.toThrow();
}, 10_000);
