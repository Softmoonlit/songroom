import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { describe, expect, it } from "vitest";
import { initializeDatabase, openDatabase } from "../db/database.js";
import { room, roomMembership, publicPlaylistBinding, neteaseAuthorization } from "../db/schema.js";
import { createApp, type SongRoomApp } from "../http/app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import { CredentialVault } from "../netease/credentials.js";

async function allocatePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

class SseClient {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async readNext(timeoutMs = 4000): Promise<{ event: string; data: string }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const parts = this.#buffer.split("\n\n");
      if (parts.length > 1) {
        const rawMsg = parts.shift()!;
        this.#buffer = parts.join("\n\n");
        let event = "message";
        let data = "";
        for (const line of rawMsg.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        return { event, data };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("读取 SSE 消息超时");

      const readPromise = this.#reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>(resolve =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining)
      );

      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result.done) {
        if (!result.value) throw new Error("读取 SSE 消息超时");
        break;
      }
      this.#buffer += this.#decoder.decode(result.value, { stream: true });
    }
    throw new Error("SSE 流已提前关闭");
  }

  async close(): Promise<void> {
    try {
      await this.#reader.cancel();
    } catch {
      // ignore
    }
  }
}

interface TestServerContext {
  app: SongRoomApp;
  adapter: ScriptedNeteaseAdapter;
  baseUrl: string;
  credentialKeyPath: string;
  close: () => Promise<void>;
}

async function createTestServer(): Promise<TestServerContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-acceptance-load-"));
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");

  const dbPath = path.join(root, "songroom.sqlite");
  initializeDatabase(dbPath);

  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });

  const adapter = new ScriptedNeteaseAdapter();
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const app = await createApp({
    nodeEnv: "test",
    host: "127.0.0.1",
    port,
    baseUrl,
    dbPath,
    staticRoot,
    credentialKeyPath,
    authSecret: "test-secret-with-at-least-32-characters"
  }, { neteaseAdapter: adapter });

  await app.listen();

  const close = async (): Promise<void> => {
    try {
      await app.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  };

  return { app, adapter, baseUrl, credentialKeyPath, close };
}

describe("Ticket 23: 第一期工作点负载与性能基准验证", () => {
  it(
    "本地环境工作点基准：承载 100 条 SSE、20 个活跃浏览器和 10,000 首快照：满足受理 p95 <= 500ms、失效通知 <= 1s、快照替换 <= 3s 且无内存暴涨",
    async () => {
      const server = await createTestServer();
      const sseAbort = new AbortController();
      const sseClients: SseClient[] = [];

      try {
        const { app, adapter, baseUrl, credentialKeyPath } = server;
        const vault = new CredentialVault(credentialKeyPath);

        // 1. 注册 20 个用户（1 名房主 + 19 名室友）
        const users: Array<{ userId: string; cookie: string }> = [];
        for (let i = 0; i < 20; i++) {
          const email = `user-bench-${i}@example.com`;
          const signupRes = await app.fastify.inject({
            method: "POST",
            url: "/api/auth/sign-up/email",
            headers: { origin: baseUrl },
            payload: { name: `用户${i}`, email, password: "correct horse battery staple" }
          });
          expect(signupRes.statusCode).toBe(200);
          const cookie = signupRes.cookies.map(c => `${c.name}=${c.value}`).join("; ");
          users.push({ userId: signupRes.json().user.id as string, cookie });
        }
        expect(users).toHaveLength(20);

        const owner = users[0];
        const roomId = v7();

        // 2. 插入房间与 20 名成员关系
        app.database.insert(room).values({ id: roomId, name: "验收测试房", ownerUserId: owner.userId }).run();
        app.database.insert(roomMembership).values({
          id: v7(),
          roomId,
          userId: owner.userId,
          nickname: "房主"
        }).run();
        for (let i = 1; i < 20; i++) {
          app.database.insert(roomMembership).values({
            id: v7(),
            roomId,
            userId: users[i].userId,
            nickname: `室友${i}`
          }).run();
        }

        // 3. 授权网易云并绑定公共歌单
        const authorizationId = v7();
        const accountId = "cloud-acceptance-owner";
        const scope = { authorizationId, accountId, generation: 1 };
        app.database.insert(neteaseAuthorization).values({
          id: authorizationId,
          userId: owner.userId,
          accountId,
          generation: 1,
          nickname: "网易云房主",
          status: "active",
          credentials: vault.encrypt("MUSIC_U=acceptance", scope)
        }).run();

        const creationOpId = v7();
        const playlistId = "cloud-public-10000";
        app.database.insert(publicPlaylistBinding).values({
          roomId,
          accountId,
          playlistId,
          name: "songroom-验收测试房-公共",
          creationOperationId: creationOpId,
          generation: 1
        }).run();

        // 4. 生成 10,000 首歌曲数据集并验证快照替换耗时 <= 3s
        const count = 10_000;
        const songIds: string[] = [];
        const songs: Array<{ id: string; name: string; artists: string[]; album: string }> = [];
        for (let i = 0; i < count; i++) {
          const id = `bench-song-${i}`;
          songIds.push(id);
          songs.push({
            id,
            name: `点歌测试曲目_${i}`,
            artists: ["艺术家甲", "艺术家乙"],
            album: `测试专辑_${i % 100}`
          });
        }

        adapter.playlistDetail = () => ({
          ok: true,
          data: {
            playlist: { id: playlistId, name: "songroom-验收测试房-公共", creatorId: accountId, subscribed: false, status: 0 },
            songIds,
            songs
          }
        });

        // 首次 10,000 首快照写入
        const t0 = performance.now();
        const refreshRes1 = await fetch(`${baseUrl}/api/rooms/${roomId}/public-playlist/refresh`, {
          method: "POST",
          headers: { cookie: owner.cookie, origin: baseUrl }
        });
        const refreshDuration1 = performance.now() - t0;
        expect(refreshRes1.status).toBe(200);
        const refreshData1 = await refreshRes1.json();
        expect(refreshData1.snapshot.trackCount).toBe(10_000);
        expect(refreshDuration1).toBeLessThan(3000); // 严格低于 3 秒

        // 再次替换为倒序 10,000 首歌曲验证二次替换耗时 <= 3s
        const reversedSongs = songs.slice().reverse();
        const reversedSongIds = songIds.slice().reverse();
        adapter.playlistDetail = () => ({
          ok: true,
          data: {
            playlist: { id: playlistId, name: "songroom-验收测试房-公共", creatorId: accountId, subscribed: false, status: 0 },
            songIds: reversedSongIds,
            songs: reversedSongs
          }
        });

        const t1 = performance.now();
        const refreshRes2 = await fetch(`${baseUrl}/api/rooms/${roomId}/public-playlist/refresh`, {
          method: "POST",
          headers: { cookie: owner.cookie, origin: baseUrl }
        });
        const refreshDuration2 = performance.now() - t1;
        expect(refreshRes2.status).toBe(200);
        const refreshData2 = await refreshRes2.json();
        expect(refreshData2.snapshot.trackCount).toBe(10_000);
        expect(refreshDuration2).toBeLessThan(3000); // 严格低于 3 秒

        // 5. 建立 100 条 SSE 长连接（20 用户 * 5 连接），并校验握手
        for (const user of users) {
          for (let connIdx = 0; connIdx < 5; connIdx++) {
            const sseRes = await fetch(`${baseUrl}/api/events`, {
              headers: { cookie: user.cookie, accept: "text/event-stream" },
              signal: sseAbort.signal
            });
            expect(sseRes.status).toBe(200);
            const client = new SseClient(sseRes.body!.getReader());
            const handshake = await client.readNext(5000);
            expect(handshake.event).toBe("connected");
            sseClients.push(client);
          }
        }
        expect(sseClients).toHaveLength(100);

        // 6. 20 个并发活跃浏览器客户端压测（各客户端错开执行房间查询、成员查询、房间列表与昵称命令）
        const latencies: number[] = [];
        const memBefore = process.memoryUsage();

        type UserContext = { userId: string; cookie: string };
        const queryRoomShell = (u: UserContext) =>
          fetch(`${baseUrl}/api/rooms/${roomId}`, { headers: { cookie: u.cookie } });
        const queryRoomMembers = (u: UserContext) =>
          fetch(`${baseUrl}/api/rooms/${roomId}/members`, { headers: { cookie: u.cookie } });
        const queryUserRooms = (u: UserContext) =>
          fetch(`${baseUrl}/api/rooms`, { headers: { cookie: u.cookie } });
        const commandUpdateNickname = (u: UserContext, uIdx: number, iter: number) =>
          fetch(`${baseUrl}/api/rooms/${roomId}/nickname`, {
            method: "POST",
            headers: { cookie: u.cookie, "content-type": "application/json", origin: baseUrl },
            body: JSON.stringify({ idempotencyKey: v7(), nickname: `新名${uIdx}_${iter}` })
          });

        const clientOperations = [
          (u: UserContext) => queryRoomShell(u),
          (u: UserContext) => queryRoomMembers(u),
          (u: UserContext) => queryUserRooms(u),
          (u: UserContext, uIdx: number, iter: number) => commandUpdateNickname(u, uIdx, iter)
        ];

        await Promise.all(
          users.map(async (user, userIdx) => {
            await new Promise(r => setTimeout(r, userIdx * 5));

            for (let iter = 0; iter < 10; iter++) {
              const opIndex = (userIdx + iter) % clientOperations.length;
              const op = clientOperations[opIndex];
              const tReq = performance.now();
              const res = await op(user, userIdx, iter);
              expect(res.status).toBe(200);
              latencies.push(performance.now() - tReq);
            }
          })
        );

        // 统计延迟分布
        expect(latencies).toHaveLength(200);
        latencies.sort((a, b) => a - b);
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p90 = latencies[Math.floor(latencies.length * 0.9)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];
        const maxLat = latencies[latencies.length - 1];

        // 验证命令与查询受理 p95 <= 500ms
        expect(p95).toBeLessThanOrEqual(500);

        // 7. 验证 SSE 失效通知在 1 秒内发出并被长连接接收
        const tSubmit = performance.now();
        const renameRes = await fetch(`${baseUrl}/api/rooms/${roomId}/name`, {
          method: "POST",
          headers: { cookie: owner.cookie, "content-type": "application/json", origin: baseUrl },
          body: JSON.stringify({ idempotencyKey: v7(), name: "已更名房间" })
        });
        expect(renameRes.status).toBe(200);

        // 抽样验证 20 条 SSE 连接均在 1000ms 内收到该失效通知
        const deliveryTimes = await Promise.all(
          sseClients.slice(0, 20).map(async client => {
            let parsed: { type: string } | null = null;
            while (parsed?.type !== "room") {
              const msg = await client.readNext(3000);
              expect(msg.event).toBe("invalidation");
              parsed = JSON.parse(msg.data);
            }
            expect(parsed.type).toBe("room");
            return performance.now() - tSubmit;
          })
        );
        const maxDelivery = Math.max(...deliveryTimes);
        expect(maxDelivery).toBeLessThanOrEqual(1000); // 严格低于 1000ms

        // 8. 内存与稳定性核查：无 OOM，RSS 与 Heap 正常受控
        const memAfter = process.memoryUsage();
        expect(memAfter.rss).toBeGreaterThan(0);
        expect(memAfter.heapUsed).toBeLessThan(350 * 1024 * 1024); // 堆内存远低于 350 MiB，无内存暴涨

        // 输出可追溯的基准实测数据
        console.log("ACCEPTANCE_BENCHMARK_RESULT:", JSON.stringify({
          snapshotWriteMs: Math.round(refreshDuration1),
          snapshotReplaceMs: Math.round(refreshDuration2),
          sseConnections: sseClients.length,
          activeClients: users.length,
          totalRequests: latencies.length,
          p50Ms: Math.round(p50),
          p90Ms: Math.round(p90),
          p95Ms: Math.round(p95),
          p99Ms: Math.round(p99),
          maxLatencyMs: Math.round(maxLat),
          sseDeliveryMaxMs: Math.round(maxDelivery),
          heapUsedMB: Math.round(memAfter.heapUsed / 1024 / 1024),
          rssMB: Math.round(memAfter.rss / 1024 / 1024)
        }));
      } finally {
        sseAbort.abort();
        await Promise.all(sseClients.map(c => c.close()));
        await server.close();
      }
    },
    45000
  );
});
