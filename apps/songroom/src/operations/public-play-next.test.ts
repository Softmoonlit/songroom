import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { v7 } from "uuid";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import { neteaseAuthorization, playlistSnapshot, playlistTrack, publicPlaylistBinding, room, roomMembership, user } from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { EventStreamService } from "../events/event-stream.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { PublicPlaylists } from "./public-playlists.js";

class OrderAdapter implements NeteaseAdapter {
  order = ["a", "b", "c"];
  calls: AdapterInput["operation"][] = [];
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.calls.push(input.operation);
    if (input.operation === "identity") return { ok: true, data: { accountId: "cloud", name: "房主" } } as AdapterResult<I["operation"]>;
    if (input.operation === "recentSong") return { ok: true, data: { songId: "a" } } as AdapterResult<I["operation"]>;
    if (input.operation === "trackOrder") {
      this.order = input.songIds;
      return { ok: true, data: { acknowledged: true } } as AdapterResult<I["operation"]>;
    }
    if (input.operation === "playlistDetail") return {
      ok: true,
      data: {
        playlist: { id: "playlist", name: "最新名称", creatorId: "cloud", subscribed: false, status: 0 },
        songIds: this.order,
        songs: this.order.map(id => ({ id, name: id, artists: ["artist"], album: "album" }))
      }
    } as AdapterResult<I["operation"]>;
    throw new Error(`unexpected ${input.operation}`);
  }
  async assertVendorIntegrity() {}
  async dispose() {}
}

type Fixture = { root: string; database: AppDatabase; service: PublicPlaylists; adapter: OrderAdapter; roomId: string };
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.service.stop();
    await fixture.service.settle();
    fixture.database.$client.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-play-next-"));
  const dbPath = path.join(root, "app.sqlite");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);
  const keyPath = path.join(root, "credential-key");
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const vault = new CredentialVault(keyPath);
  const now = Date.now();
  database.insert(user).values({ id: "owner", name: "owner", email: "owner@example.com", emailVerified: false, createdAt: new Date(now), updatedAt: new Date(now) }).run();
  database.insert(user).values({ id: "member", name: "member", email: "member@example.com", emailVerified: false, createdAt: new Date(now), updatedAt: new Date(now) }).run();
  const roomId = v7();
  database.insert(room).values({ id: roomId, name: "room", ownerUserId: "owner" }).run();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "owner", nickname: "房主" }).run();
  database.insert(roomMembership).values({ id: v7(), roomId, userId: "member", nickname: "室友" }).run();
  const authorizationId = v7();
  database.insert(neteaseAuthorization).values({ id: authorizationId, userId: "owner", accountId: "cloud", generation: 1, nickname: "房主", status: "active", credentials: vault.encrypt("cookie", { authorizationId, accountId: "cloud", generation: 1 }) }).run();
  database.insert(publicPlaylistBinding).values({ roomId, accountId: "cloud", playlistId: "playlist", name: "旧名称", creationOperationId: v7(), generation: 1 }).run();
  database.insert(playlistSnapshot).values({ accountId: "cloud", playlistId: "playlist", snapshotVersion: 1, syncedAt: now, createdAt: now, updatedAt: now }).run();
  const adapter = new OrderAdapter();
  for (const [position, songId] of adapter.order.entries()) database.insert(playlistTrack).values({ accountId: "cloud", playlistId: "playlist", position, songId, name: songId, artists: JSON.stringify(["artist"]), album: "album" }).run();
  const scheduler = new UpstreamScheduler(database, () => Date.now());
  const service = new PublicPlaylists(database, adapter, vault, scheduler, new EventStreamService());
  service.start();
  const fixture = { root, database, service, adapter, roomId };
  fixtures.push(fixture);
  return fixture;
}

describe("公共歌单下一首播放持久操作", () => {
  it("核对播放锚点后只发送一次整体顺序并以读回完成", async () => {
    const f = fixture();
    const accepted = f.service.playNext("member", f.roomId, { idempotencyKey: v7(), songId: "c", anchorSongId: "a", snapshotVersion: 1 });
    expect(accepted.operation.status).toBe("queued");
    await f.service.settle();
    const result = f.service.readPlayNextOperation("member", f.roomId, accepted.operation.id);
    expect(result.status).toBe("succeeded");
    expect(f.adapter.order).toEqual(["a", "c", "b"]);
    expect(f.adapter.calls.filter(call => call === "trackOrder")).toHaveLength(1);
    expect(f.database.select().from(publicPlaylistBinding).get()?.name).toBe("最新名称");
  }, 20_000);

  it("同一点击重放返回原操作，不接受不同内容", () => {
    const f = fixture();
    const idempotencyKey = v7();
    const first = f.service.playNext("member", f.roomId, { idempotencyKey, songId: "c", anchorSongId: "a", snapshotVersion: 1 });
    const replay = f.service.playNext("member", f.roomId, { idempotencyKey, songId: "c", anchorSongId: "a", snapshotVersion: 1 });
    expect(replay.replay).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);
    expect(() => f.service.playNext("member", f.roomId, { idempotencyKey, songId: "b", anchorSongId: "a", snapshotVersion: 1 })).toThrowError("IDEMPOTENCY_CONFLICT");
  });
});
