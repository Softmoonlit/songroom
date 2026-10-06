import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { errorResponse, healthResponse } from "../shared/contracts.js";
import { BusinessError } from "../shared/errors.js";
import { configSchema, type AppConfig } from "../config.js";
import { CURRENT_SCHEMA_VERSION, openDatabase, type AppDatabase } from "../db/database.js";
import { installZod, type ZodProvider } from "./zod.js";

export type RuntimeState = "starting" | "ready" | "draining" | "stopped";

export interface SongRoomApp {
  fastify: FastifyInstance;
  database: AppDatabase;
  getState: () => RuntimeState;
  listen: () => Promise<string>;
  drain: () => void;
  close: () => Promise<void>;
}

export async function createApp(input: AppConfig): Promise<SongRoomApp> {
  const config = configSchema.parse(input);
  // 构建产物与数据库都先校验；缺失时不得提供空白页面或修复持久状态。
  const staticRoot = await fs.realpath(config.staticRoot);
  const databasePath = await fs.realpath(config.dbPath);
  if (databasePath === staticRoot || databasePath.startsWith(staticRoot + path.sep)) {
    throw new Error("数据库必须位于静态资源目录之外");
  }
  const html = await fs.readFile(path.join(staticRoot, "index.html"), "utf8");
  await fs.access(path.join(staticRoot, "assets"));
  const database = openDatabase(config.dbPath);
  let state: RuntimeState = "starting";
  let closing: Promise<void> | undefined;

  const fastify = Fastify({
    logger: { level: config.nodeEnv === "test" ? "silent" : "info" },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 128 * 1024,
    trustProxy: ["127.0.0.1"],
    return503OnClosing: true,
    forceCloseConnections: "idle"
  });
  fastify.log.info({ state }, "application lifecycle");
  const typed = fastify.withTypeProvider<ZodProvider>();
  installZod(fastify);

  try {
    await fastify.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
          scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:"],
          // HTTPS 升级由生产入口负责，允许回环 HTTP 浏览器测试。
          upgradeInsecureRequests: config.nodeEnv === "production" ? [] : null
        }
      },
      hsts: config.nodeEnv === "production"
    });
    await fastify.register(fastifyStatic, {
      root: path.join(staticRoot, "assets"), prefix: "/assets/", decorateReply: false,
      maxAge: "1y", immutable: true, index: false, redirect: false,
      setHeaders: (response, file) => {
        if (!/-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(path.basename(file))) response.setHeader("cache-control", "no-store");
      }
    });

    fastify.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (state !== "ready") throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
        if (request.headers.origin !== config.baseUrl) throw new BusinessError(403, "ORIGIN_REJECTED", "请求来源不受信任");
      }
    });
    fastify.addHook("onResponse", async (request, reply) => {
      request.log.info({ route: request.routeOptions.url, status: reply.statusCode, elapsedMs: reply.elapsedTime }, "request completed");
    });

    const readStatus = () => ({ status: state, service: "songroom" as const, schemaVersion: CURRENT_SCHEMA_VERSION });
    typed.get("/healthz", { schema: { response: { 200: healthResponse, 503: healthResponse } } }, async (_request, reply) => {
      return reply.code(state === "ready" ? 200 : 503).send(readStatus());
    });
    typed.get("/api/status", { schema: { response: { 200: healthResponse } } }, async () => readStatus());
    fastify.setNotFoundHandler(async (_request, reply) => {
      await reply.code(404).header("cache-control", "no-store").send(errorResponse.parse({ error: { code: "NOT_FOUND", message: "资源不存在" } }));
    });
    fastify.get("/*", async (request, reply) => {
      const pathname = new URL(request.url, config.baseUrl).pathname;
      if (pathname === "/api" || pathname.startsWith("/api/") || pathname === "/assets" || pathname.startsWith("/assets/")) {
        return reply.callNotFound();
      }
      return reply.type("text/html; charset=utf-8").send(html);
    });
    fastify.addHook("onListen", async () => { state = "ready"; fastify.log.info({ state }, "application lifecycle"); });
    await fastify.ready();
  } catch (error) {
    await fastify.close();
    database.$client.close();
    throw error;
  }

  const drain = (): void => {
    if (state !== "stopped" && state !== "draining") {
      state = "draining";
      fastify.log.info({ state }, "application lifecycle");
    }
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      drain();
      try { await fastify.close(); }
      finally {
        database.$client.close();
        state = "stopped";
        fastify.log.info({ state }, "application lifecycle");
      }
    })();
    return closing;
  };
  return { fastify, database, getState: () => state, listen: () => fastify.listen({ host: config.host, port: config.port }), drain, close };
}
