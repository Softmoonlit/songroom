import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { room, roomMembership, neteaseAuthorization, publicPlaylistBinding, playlistTrack } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import { createApp, type SongRoomApp } from "./app.js";
import { ScriptedNeteaseAdapter } from "../../tests/netease/scripted-adapter.js";
import type { AdapterInput, AdapterResult } from "../netease/protocol.js";

const origins = new WeakMap<SongRoomApp, string>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-req-http-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const staticRoot = path.join(root, "client");
  await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><div>SongRoom</div>");
  const dbPath = path.join(root, "songroom.sqlite"); initializeDatabase(dbPath);
  const credentialKeyPath = path.join(root, "netease.key");
  await fs.writeFile(credentialKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  const adapter = new ScriptedNeteaseAdapter();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await createApp({ nodeEnv: "test", host: "127.0.0.1", port, baseUrl, dbPath, staticRoot, credentialKeyPath, authSecret: "test-secret-with-at-least-32-characters" }, { neteaseAdapter: adapter });
  origins.set(app, baseUrl);
  cleanups.push(() => app.close());
  await app.listen();
  const owner = await signup(app, "owner@example.com");
  const member = await signup(app, "member@example.com");
  const outsider = await signup(app, "outsider@example.com");
  const roomId = v7(); const authorizationId = v7();
  app.database.insert(room).values({ id: roomId, ownerUserId: owner.userId, name: "测试宿舍" }).run();
  app.database.insert(roomMembership).values([
    { id: v7(), roomId, userId: owner.userId, nickname: "房主" },
    { id: v7(), roomId, userId: member.userId, nickname: "室友" }
  ]).run();
  const credentials = new CredentialVault(credentialKeyPath).encrypt("MUSIC_U=test", { authorizationId, accountId: "test", generation: 1 });
  app.database.insert(neteaseAuthorization).values({ id: authorizationId, userId: owner.userId, accountId: "test", nickname: "网易云", generation: 1, status: "active", credentials }).run();
  app.database.insert(publicPlaylistBinding).values({ roomId, accountId: "test", playlistId: "pl-test", name: "songroom-测试宿舍-公共", creationOperationId: v7(), generation: 1 }).run();

  return { app, adapter, owner, member, outsider, roomId, baseUrl };
}

async function signup(app: SongRoomApp, email: string) {
  const response = await app.fastify.inject({ method: "POST", url: "/api/auth/sign-up/email", headers: { origin: origins.get(app)! }, payload: { name: "测试", email, password: "correct horse battery staple" } });
  expect(response.statusCode).toBe(200);
  return { userId: response.json().user.id as string, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") };
}

function request(app: SongRoomApp, url: string, cookie?: string, body?: unknown, method = "POST") {
  return app.fastify.inject({
    method: method as any,
    url,
    headers: { origin: origins.get(app)!, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
}

it("通过 HTTP 提交点歌并在歌曲已有或新增时正确返回", async () => {
  const { app, adapter, member, roomId } = await fixture();

  let addedSong = "";
  adapter.call = async <I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> => {
    adapter.inputs.push(input);
    if (input.operation === "identity") return { ok: true, data: { accountId: "test", name: "网易云" } } as any;
    if (input.operation === "trackAdd") { addedSong = (input as any).songId; return { ok: true, data: { acknowledged: true } } as any; }
    if (input.operation === "playlistDetail") {
      return {
        ok: true,
        data: {
          playlist: { id: "pl-test", name: "歌单", creatorId: "test", subscribed: false, status: 0 },
          songIds: addedSong ? [addedSong] : [],
          songs: addedSong ? [{ id: addedSong, name: "晴天", artists: ["周杰伦"], album: "叶惠美" }] : []
        }
      } as any;
    }
    return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
  };

  const key1 = v7();
  const res = await request(app, `/api/rooms/${roomId}/song-requests`, member.cookie, {
    idempotencyKey: key1,
    songId: "s-1",
    name: "晴天",
    artists: ["周杰伦"],
    album: "叶惠美"
  });

  expect(res.statusCode).toBe(202);
  const data = res.json();
  expect(data.replay).toBe(false);
  expect(data.operation.status).toBe("queued");
  expect(data.operation.step).toBe("ready");

  // 相同幂等键重放：返回 200 或 202 原操作
  const replayRes = await request(app, `/api/rooms/${roomId}/song-requests`, member.cookie, {
    idempotencyKey: key1,
    songId: "s-1",
    name: "晴天",
    artists: ["周杰伦"],
    album: "叶惠美"
  });
  expect([200, 202]).toContain(replayRes.statusCode);
  expect(replayRes.json().replay).toBe(true);
  expect(replayRes.json().operation.id).toBe(data.operation.id);

  // 查询操作详情
  const opRes = await request(app, `/api/rooms/${roomId}/song-requests/${data.operation.id}`, member.cookie, undefined, "GET");
  expect(opRes.statusCode).toBe(200);
  expect(opRes.json().id).toBe(data.operation.id);
});
