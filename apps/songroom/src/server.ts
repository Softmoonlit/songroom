import { createApp } from "./http/app.js";
import { assertRuntime, loadConfig } from "./config.js";

async function main(): Promise<void> {
  assertRuntime();
  const config = loadConfig();
  const app = await createApp(config);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => {
      console.error(JSON.stringify({ state: "failed", code: "SHUTDOWN_TIMEOUT", message: "停机超时，强制退出" }));
      process.exit(1);
    }, 35_000);
    forceTimer.unref();
    void app.close()
      .catch((error) => {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "SHUTDOWN_FAILED";
        console.error(JSON.stringify({ state: "failed", code, message: "停机清理失败" }));
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(forceTimer);
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await app.listen();
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch(error => {
  // 启动错误只输出稳定码，路径和私有配置内容不进入日志。
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "STARTUP_FAILED";
  console.error(JSON.stringify({ state: "failed", code, message: "启动校验或监听失败；请运行 db check，并核对私有配置、Node.js 版本及构建产物" }));
  process.exitCode = 1;
});
