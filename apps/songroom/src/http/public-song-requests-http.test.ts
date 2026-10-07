import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { v7 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "../db/database.js";
import { eq } from "drizzle-orm";
import { room, roomMembership, neteaseAuthorization, publicPlaylistBinding, playlistTrack, operation, publicSongRequest } from "../db/schema.js";
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

it("HTTP: 目标处于待确认时返回 409 TARGET_BLOCKED，非成员或他人无法读取操作", async () => {
  const { app, owner, member, outsider, roomId } = await fixture();

  // 1. 模拟插入一个处于 awaitingConfirmation 的点歌操作
  const opId = v7();
  app.database.insert(operation).values({
    id: opId, kind: "requestPublicSong", userId: owner.userId, roomId, accountId: "test", authorizationId: v7(), generation: 1, status: "awaitingConfirmation", createdAt: Date.now(), updatedAt: Date.now()
  }).run();
  app.database.insert(publicSongRequest).values({
    operationId: opId, songId: "s-blocked", name: "待确认歌", artists: JSON.stringify(["歌手"]), album: "专辑", step: "unknown", songConfirmed: false, tagConfirmed: false,
    playlistId: "pl-test", bindingGeneration: 1, checkRound: 0, nextCheckAt: Date.now() + 5000
  }).run();

  // 室友尝试点歌，因目标阻塞返回 409 TARGET_BLOCKED
  const blockedRes = await request(app, `/api/rooms/${roomId}/song-requests`, member.cookie, {
    idempotencyKey: v7(),
    songId: "s-2",
    name: "新歌",
    artists: ["歌手"],
    album: "专辑"
  });
  expect(blockedRes.statusCode).toBe(409);
  expect(blockedRes.json().error.code).toBe("TARGET_BLOCKED");

  // 2. 权限控制：局外人读取房主的待确认操作 -> 404
  const outsiderRes = await request(app, `/api/rooms/${roomId}/song-requests/${opId}`, outsider.cookie, undefined, "GET");
  expect(outsiderRes.statusCode).toBe(404);

  // 室友读取房主的操作 -> 404
  const memberReadOwnerOpRes = await request(app, `/api/rooms/${roomId}/song-requests/${opId}`, member.cookie, undefined, "GET");
  expect(memberReadOwnerOpRes.statusCode).toBe(404);

  // 房主本人读取自己的操作 -> 200
  const ownerReadOpRes = await request(app, `/api/rooms/${roomId}/song-requests/${opId}`, owner.cookie, undefined, "GET");
  expect(ownerReadOpRes.statusCode).toBe(200);
  expect(ownerReadOpRes.json().id).toBe(opId);
  expect(ownerReadOpRes.json().status).toBe("awaitingConfirmation");

  // 3. 幂等冲突测试：同一 key 不同内容返回 409
  const keySame = v7();
  // 房主自己的待确认操作阻碍了同房间新点歌，清理后测试幂等
  app.database.delete(operation).where(eq(operation.id, opId)).run();

  const req1 = await request(app, `/api/rooms/${roomId}/song-requests`, member.cookie, {
    idempotencyKey: keySame, songId: "s-idem", name: "歌A", artists: ["歌手"], album: "专辑"
  });
  expect(req1.statusCode).toBe(202);

  const reqConflict = await request(app, `/api/rooms/${roomId}/song-requests`, member.cookie, {
    idempotencyKey: keySame, songId: "s-idem", name: "不同歌名", artists: ["歌手"], album: "专辑"
  });
  expect(reqConflict.statusCode).toBe(409);
  expect(reqConflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
});
