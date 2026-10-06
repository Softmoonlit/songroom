import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema, loadConfig } from "./config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))); roots.length = 0; });
const settings = { nodeEnv: "production", host: "127.0.0.1", port: 3000, baseUrl: "https://songs.example", dbPath: "./data/songroom.sqlite", staticRoot: "./dist/client", authSecret: "test-secret-with-at-least-32-characters", credentialKeyPath: "./private/netease.key" };

describe("应用启动配置", () => {
  it("缺失或无效私有配置拒绝，配置文件相对路径以文件目录解析", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-config-")); roots.push(root);
    const file = path.join(root, "config.json");
    expect(() => loadConfig(file)).toThrow();
    await fs.writeFile(file, JSON.stringify(settings), { mode: 0o600 });
    expect(loadConfig(file)).toMatchObject({ dbPath: path.join(root, "data/songroom.sqlite"), staticRoot: path.join(root, "dist/client") });
    await fs.chmod(file, 0o644); expect(() => loadConfig(file)).toThrow();
  });

  it("拒绝生产明文入口、非回环监听、非精确origin及静态目录中的数据库", () => {
    for (const change of [
      { baseUrl: "http://songs.example" }, { host: "0.0.0.0" }, { baseUrl: "https://songs.example/" },
      { baseUrl: "https://songs.example?secret=x" }, { dbPath: "./dist/client/songroom.sqlite" }, { credentialKeyPath: "./dist/client/key" }, { credentialKeyPath: "./data/songroom.sqlite" }
    ]) expect(configSchema.safeParse({ ...settings, ...change }).success).toBe(false);
  });

  it("相对路径不能绕过数据库与静态目录隔离", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-config-")); roots.push(root);
    const file = path.join(root, "config.json");
    await fs.writeFile(file, JSON.stringify({ ...settings, dbPath: "./dist/client/database.sqlite" }), { mode: 0o600 });
    expect(() => loadConfig(file)).toThrow();
  });
});
