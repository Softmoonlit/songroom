import { createApp, type SongRoomApp } from "../../src/http/app.js";
import type { AppConfig } from "../../src/config.js";
import { ScriptedNeteaseAdapter } from "../netease/scripted-adapter.js";

let app: SongRoomApp | undefined;
process.on("message", async (config: AppConfig) => {
  app = await createApp({ ...config, nodeEnv: "development" }, { neteaseAdapter: new ScriptedNeteaseAdapter() });
  // 观察真正收到的 URL 与 Referer；不把请求正文输出到日志。
  app.fastify.server.on("request", request => {
    process.send?.({ url: request.url, referer: request.headers.referer ?? null });
  });
  await app.listen();
  process.send?.({ ready: true });
});
process.on("SIGTERM", async () => {
  await app?.close();
  process.exit(0);
});
