import { createApp } from "./http/app.js";
import { assertRuntime, loadConfig } from "./config.js";

async function main(): Promise<void> {
  assertRuntime();
  const config = loadConfig();
  const app = await createApp(config);
  const shutdown = (): void => {
    void app.close().catch(() => { process.exitCode = 1; });
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
