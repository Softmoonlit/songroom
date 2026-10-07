import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { fastifySSE } from "@fastify/sse";
import { createAuth, type SongRoomAuth } from "../auth.js";
import { errorResponse, healthResponse } from "../shared/contracts.js";
import { BusinessError } from "../shared/errors.js";
import { configSchema, type AppConfig } from "../config.js";
import { CURRENT_SCHEMA_VERSION, openDatabase, type AppDatabase } from "../db/database.js";
import { installZod, type ZodProvider } from "./zod.js";
import { registerNeteaseRoutes } from "./netease.js";
import { CredentialVault } from "../netease/credentials.js";
import { NeteaseBinding } from "../netease/binding.js";
import { createNeteaseAdapter } from "../netease/adapter.js";
import type { NeteaseAdapter } from "../netease/protocol.js";
import { Rooms } from "../rooms/rooms.js";
import { registerRoomRoutes } from "./rooms.js";
import { Invites } from "../invites/invites.js";
import { registerInviteRoutes } from "./invites.js";
import { PublicPlaylists } from "../operations/public-playlists.js";
import { UpstreamScheduler } from "../operations/upstream-scheduling.js";
import { registerPublicPlaylistRoutes } from "./public-playlists.js";
import { EventStreamService } from "../events/event-stream.js";
import { SongSearchService } from "../operations/song-search.js";
import { registerSongSearchRoutes } from "./song-search.js";
import { requireSession } from "./session.js";

export type RuntimeState = "starting" | "ready" | "draining" | "stopped";

export interface SongRoomApp {
  fastify: FastifyInstance;
  database: AppDatabase;
  auth: SongRoomAuth;
  eventStream: EventStreamService;
  searchService: SongSearchService;
  playlists: PublicPlaylists;
  scheduler: UpstreamScheduler;
  getState: () => RuntimeState;
  listen: () => Promise<string>;
  drain: () => void;
  close: () => Promise<void>;
}

export async function createApp(input: AppConfig, dependencies: { neteaseAdapter?: NeteaseAdapter; now?: () => number } = {}): Promise<SongRoomApp> {
  const config = configSchema.parse(input);
  // 构建产物与数据库都先校验；缺失时不得提供空白页面或修复持久状态。
  const staticRoot = await fs.realpath(config.staticRoot);
  const databasePath = await fs.realpath(config.dbPath);
  if (databasePath === staticRoot || databasePath.startsWith(staticRoot + path.sep)) {
    throw new Error("数据库必须位于静态资源目录之外");
  }
  const html = await fs.readFile(path.join(staticRoot, "index.html"), "utf8");
  await fs.access(path.join(staticRoot, "assets"));
  const credentialKeyPath = await fs.realpath(config.credentialKeyPath);
  const runtimeDir = await fs.realpath(os.tmpdir());
  for (const privatePath of [credentialKeyPath, runtimeDir]) {
    if (privatePath === staticRoot || privatePath.startsWith(staticRoot + path.sep)) throw new Error("凭据密钥与运行临时目录必须位于静态资源目录之外");
  }
  if (credentialKeyPath === databasePath) throw new Error("凭据密钥必须与数据库分开保存");
  const vault = new CredentialVault(config.credentialKeyPath);
  const database = openDatabase(config.dbPath);
  const adapter = dependencies.neteaseAdapter ?? createNeteaseAdapter({ runtimeDir });
  let binding: NeteaseBinding;
  try {
    await adapter.assertVendorIntegrity();
    binding = new NeteaseBinding(database, adapter, vault, dependencies.now);
  } catch (error) {
    await adapter.dispose();
    database.$client.close();
    throw error;
  }
  const auth = createAuth(database, config);
  const eventStream = new EventStreamService();
  const scheduler = new UpstreamScheduler(database, eventStream, dependencies.now);
  const playlists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, dependencies.now);
  const searchService = new SongSearchService(database, adapter, vault, scheduler, eventStream, dependencies.now);
  binding.onRevoke = userId => playlists.onOwnerRevoked(userId);
  binding.onReauthorize = (userId, authId, accountId, generation) => playlists.onReauthorized(userId, authId, accountId, generation);
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
    await fastify.register(fastifySSE, {
      heartbeatInterval: 30000
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

    const authRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers as Record<string, string | string[] | undefined>)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined && request.body !== null;
      if (!hasBody) {
        headers.delete("content-type");
        headers.delete("content-length");
      }
      let signOutSessionId: string | undefined;
      if (request.url.includes("/sign-out")) {
        try {
          const session = await auth.api.getSession({ headers });
          if (session?.session) signOutSessionId = session.session.id;
        } catch {
          // ignore
        }
      }
      const response = await auth.handler(new Request(new URL(request.url, config.baseUrl), {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined
      }));
      if (signOutSessionId && response.status === 200) {
        eventStream.closeSession(signOutSessionId);
      }
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") reply.header(name, value);
      });
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      reply.code(response.status);
      if (!response.body) return reply.send();
      return reply.send(Buffer.from(await response.arrayBuffer()));
    };
    fastify.route({ method: ["GET", "POST"], url: "/api/auth/*", handler: authRequest });
    registerNeteaseRoutes(fastify, auth, binding);
    registerRoomRoutes(fastify, auth, new Rooms(database, binding, eventStream, dependencies.now));
    registerInviteRoutes(fastify, auth, new Invites(database, eventStream, dependencies.now));
    registerPublicPlaylistRoutes(fastify, auth, playlists);
    registerSongSearchRoutes(fastify, auth, searchService);

    fastify.get("/api/events", { sse: "only" }, async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && origin !== config.baseUrl) {
        throw new BusinessError(403, "ORIGIN_REJECTED", "请求来源不受信任");
      }
      if (request.headers["sec-fetch-site"] === "cross-site") {
        throw new BusinessError(403, "ORIGIN_REJECTED", "请求来源不受信任");
      }
      const principal = await requireSession(auth, request, reply);
      reply.header("cache-control", "no-store, no-cache, must-revalidate");
      reply.header("pragma", "no-cache");
      reply.header("x-accel-buffering", "no");
      await eventStream.subscribe(principal.userId, principal.sessionId, reply, principal.expiresAt?.getTime());
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
    fastify.addHook("onListen", async () => { state = "ready"; scheduler.start(); fastify.log.info({ state }, "application lifecycle"); });
    await fastify.ready();
  } catch (error) {
    await fastify.close();
    binding.clear();
    await adapter.dispose();
    database.$client.close();
    throw error;
  }

  const drain = (): void => {
    if (state !== "stopped" && state !== "draining") {
      state = "draining";
      scheduler.stop();
      eventStream.close();
      binding.clear();
      fastify.log.info({ state }, "application lifecycle");
    }
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      drain();
      try { await fastify.close(); }
      finally {
        binding.clear();
        await adapter.dispose();
        await scheduler.settle();
        database.$client.close();
        state = "stopped";
        fastify.log.info({ state }, "application lifecycle");
      }
    })();
    return closing;
  };
  return { fastify, database, auth, eventStream, searchService, playlists, scheduler, getState: () => state, listen: () => fastify.listen({ host: config.host, port: config.port }), drain, close };
}
