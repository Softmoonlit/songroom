import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { initializeDatabase } from "../src/db/database.js";
import { createApp, type SongRoomApp } from "../src/http/app.js";
import type { AppConfig } from "../src/config.js";

const port = 3210;
const baseUrl = `http://127.0.0.1:${port}`;
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "songroom-e2e-"));
const dbPath = path.join(temporaryDirectory, "songroom.sqlite");
const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port,
  baseUrl,
  dbPath,
  staticRoot: path.resolve("dist/client")
};

let app: SongRoomApp | undefined;
let closing = false;

async function cleanup(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app?.close();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

process.once("SIGINT", () => void cleanup().finally(() => process.exit(0)));
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(0)));
process.on("exit", () => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

try {
  initializeDatabase(dbPath);
  app = await createApp(config);
  await app.listen();
} catch (error) {
  await cleanup();
  throw error;
}
