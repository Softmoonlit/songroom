import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDatabaseCommand } from "./cli.js";
import { initializeDatabase } from "./db/database.js";
import type { AppConfig } from "./config.js";

const temporaryDirectories: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function occupiedPort(): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  return (server.address() as net.AddressInfo).port;
}

function config(port: number, dbPath: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    dbPath,
    staticRoot: path.join(path.dirname(dbPath), "static"),
    authSecret: "test-secret-with-at-least-32-characters"
  };
}

describe("database CLI", () => {
  it("runs a read-only check without claiming the application port", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-cli-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "songroom.sqlite");
    initializeDatabase(filePath);
    const port = await occupiedPort();

    await expect(runDatabaseCommand(["db", "check"], config(port, filePath))).resolves.toMatchObject({ ok: true });
  });

  it("claims the application port before running an offline migration", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-cli-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "songroom.sqlite");
    initializeDatabase(filePath);
    const port = await occupiedPort();

    await expect(runDatabaseCommand(["db", "migrate"], config(port, filePath))).rejects.toThrow();
  });
});
