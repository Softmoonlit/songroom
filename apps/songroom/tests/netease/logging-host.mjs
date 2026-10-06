import { createNeteaseAdapter } from "../../dist/netease/adapter.js";
import { readdir } from "node:fs/promises";
const [runtimeDir, workerPath] = process.argv.slice(2);
const adapter = createNeteaseAdapter({ runtimeDir, workerPath, deviceId: "offline-device" });
try {
  const result = await adapter.call({ operation: "qrKey" });
  console.log(JSON.stringify({ result, directories: await readdir(runtimeDir) }));
} finally { await adapter.dispose(); }
