import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v7 } from "uuid";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase, openDatabase, type AppDatabase } from "../db/database.js";
import {
  neteaseAuthorization,
  personalPlaylistBinding,
  playlistSnapshot,
  publicPlaylistBinding,
  requesterTag,
  room,
  roomMembership,
  user
} from "../db/schema.js";
import { CredentialVault } from "../netease/credentials.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../netease/protocol.js";
import { EventStreamService } from "../events/event-stream.js";
import { UpstreamScheduler } from "./upstream-scheduling.js";
import { PublicPlaylists } from "./public-playlists.js";
import { PersonalPlaylists } from "./personal-playlists.js";
import { PublicRandomPreview } from "./public-random-preview.js";

class MockAdapter implements NeteaseAdapter {
  readonly inputs: AdapterInput[] = [];
  detailHandler?: (playlistId: string) => AdapterResult<"playlistDetail"> | Promise<AdapterResult<"playlistDetail">>;

  async assertVendorIntegrity(): Promise<void> {}
  async dispose(): Promise<void> {}

  async call(input: AdapterInput): Promise<AdapterResult<any>> {
    this.inputs.push(input);
    if (input.operation === "playlistDetail") {
      if (this.detailHandler) {
        return await this.detailHandler(input.playlistId);
      }
      return {
        ok: true,
        data: {
          playlist: { id: input.playlistId, name: "歌单", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: [],
          songs: []
        }
      };
    }
    if (input.operation === "identity") {
      return {
        ok: true,
        data: { accountId: "cloud-owner", nickname: "网易云房主", avatarUrl: null }
      };
    }
    throw new Error(`Unhandled mock adapter operation: ${input.operation}`);
  }
}

interface TestContext {
  root: string;
  database: AppDatabase;
  playlists: PublicPlaylists;
  personalPlaylists: PersonalPlaylists;
  randomPreview: PublicRandomPreview;
  scheduler: UpstreamScheduler;
  adapter: MockAdapter;
  roomId: string;
  ownerUserId: string;
  memberUserId: string;
  ownerMemberId: string;
  roommateMemberId: string;
  now: () => number;
  advanceTime: (ms: number) => void;
}

const fixtures: TestContext[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.playlists.stop();
    await f.playlists.settle();
    f.scheduler.stop();
    await f.scheduler.settle();
    f.database.$client.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

function createTestContext(random?: () => number): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-random-preview-test-"));
  const dbPath = path.join(root, "test.db");
  initializeDatabase(dbPath);
  const database = openDatabase(dbPath);

  const credentialKeyPath = path.join(root, "cred.key");
  fs.writeFileSync(credentialKeyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  const vault = new CredentialVault(credentialKeyPath);

  let timeOffset = 0;
  const now = () => Date.now() + timeOffset;
  const advanceTime = (ms: number) => { timeOffset += ms; };

  const roomId = v7();
  const ownerUserId = "user-owner-1";
  const memberUserId = "user-roommate-2";

  for (const id of [ownerUserId, memberUserId]) {
    database.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date()
    }).run();
  }

  database.insert(room).values({
    id: roomId,
    ownerUserId,
    name: "测试房间"
  }).run();

  const ownerMemberId = v7();
  const roommateMemberId = v7();

  database.insert(roomMembership).values([
    { id: ownerMemberId, roomId, userId: ownerUserId, nickname: "房主昵称" },
    { id: roommateMemberId, roomId, userId: memberUserId, nickname: "室友昵称" }
  ]).run();

  const authId = v7();
  database.insert(neteaseAuthorization).values({
    id: authId,
    userId: ownerUserId,
    accountId: "cloud-owner",
    generation: 1,
    nickname: "网易云房主",
    status: "active",
    credentials: vault.encrypt("MUSIC_U=owner", { authorizationId: authId, accountId: "cloud-owner", generation: 1 })
  }).run();

  const memberAuthId = v7();
  database.insert(neteaseAuthorization).values({
    id: memberAuthId,
    userId: memberUserId,
    accountId: "cloud-roommate",
    generation: 1,
    nickname: "网易云室友",
    status: "active",
    credentials: vault.encrypt("MUSIC_U=roommate", { authorizationId: memberAuthId, accountId: "cloud-roommate", generation: 1 })
  }).run();

  const adapter = new MockAdapter();
  const eventStream = new EventStreamService();
  const scheduler = new UpstreamScheduler(database, eventStream, now);
  scheduler.start();
  const playlists = new PublicPlaylists(database, adapter, vault, scheduler, eventStream, now);
  const personalPlaylists = new PersonalPlaylists(database, vault, adapter, scheduler, eventStream, playlists, now);
  const randomPreview = new PublicRandomPreview(database, playlists, personalPlaylists, now, random);

  const ctx: TestContext = {
    root,
    database,
    playlists,
    personalPlaylists,
    randomPreview,
    scheduler,
    adapter,
    roomId,
    ownerUserId,
    memberUserId,
    ownerMemberId,
    roommateMemberId,
    now,
    advanceTime
  };
  fixtures.push(ctx);
  return ctx;
}

describe("PublicRandomPreview", () => {
  it("rejects non-owner from generating or reading preview (403 OWNER_ONLY)", async () => {
    const ctx = createTestContext();

    await expect(
      ctx.randomPreview.generate(ctx.memberUserId, ctx.roomId, { memberIds: [ctx.ownerMemberId], count: 10 })
    ).rejects.toThrowError(expect.objectContaining({
      status: 403,
      code: "OWNER_ONLY"
    }));

    expect(() => {
      ctx.randomPreview.get(ctx.memberUserId, ctx.roomId, v7());
    }).toThrowError(expect.objectContaining({
      status: 403,
      code: "OWNER_ONLY"
    }));
  });

  it("generates preview with correct contributions, old tracks and requester tags without modifying cloud or local tracks", async () => {
    const ctx = createTestContext();

    // Setup public playlist binding
    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    // Setup public tracks: 2 songs, one with requester tag
    ctx.database.insert(playlistSnapshot).values({
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      snapshotVersion: 1,
      syncedAt: ctx.now(),
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.database.insert(requesterTag).values({
      roomId: ctx.roomId,
      songId: "old-1",
      memberId: ctx.roommateMemberId,
      bindingGeneration: 1,
      createdAt: ctx.now()
    }).run();

    // Setup personal playlists for owner and roommate
    const ownerPlId = "owner-pl-1";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    const roommatePlId = "roommate-pl-1";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.roommateMemberId,
      accountId: "cloud-roommate",
      playlistId: roommatePlId,
      name: "室友个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    // Mock playlistDetail responses
    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "宿舍歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: ["old-1", "old-2"],
            songs: [
              { id: "old-1", name: "旧歌一", artists: ["A"], album: "Album" },
              { id: "old-2", name: "旧歌二", artists: ["A"], album: "Album" }
            ]
          }
        };
      }
      if (id === ownerPlId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "房主个人歌单", creatorId: "other-creator", subscribed: true, status: 0 },
            songIds: ["new-owner-1", "new-owner-2"],
            songs: [
              { id: "new-owner-1", name: "新歌一", artists: ["A"], album: "Album" },
              { id: "new-owner-2", name: "新歌二", artists: ["A"], album: "Album" }
            ]
          }
        };
      }
      if (id === roommatePlId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "室友个人歌单", creatorId: "other-creator", subscribed: true, status: 0 },
            songIds: ["new-roommate-1", "old-1"],
            songs: [
              { id: "new-roommate-1", name: "室友新歌", artists: ["B"], album: "Album" },
              { id: "old-1", name: "旧歌一", artists: ["A"], album: "Album" }
            ]
          }
        };
      }
      throw new Error(`Unknown playlist: ${id}`);
    };

    // Generate preview
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId, ctx.roommateMemberId],
      count: 10
    });

    expect(preview.roomId).toBe(ctx.roomId);
    expect(preview.targetCount).toBe(10);
    expect(preview.actualCount).toBe(4); // 2 from owner, 2 from roommate (1 new + 1 old)
    expect(preview.oldTrackCount).toBe(2);
    expect(preview.oldTracksWithRequesterCount).toBe(1);

    expect(preview.memberContributions).toEqual(expect.arrayContaining([
      { memberId: ctx.ownerMemberId, nickname: "房主昵称", count: 2 },
      { memberId: ctx.roommateMemberId, nickname: "室友昵称", count: 2 }
    ]));

    // Verify adapter was ONLY called for playlistDetail, NEVER for trackAdd/trackRemove
    const mutatingCalls = ctx.adapter.inputs.filter(i => i.operation === "trackAdd" || i.operation === "trackRemove");
    expect(mutatingCalls).toHaveLength(0);

    // Can retrieve the preview by previewId
    const fetched = ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview.previewId);
    expect(fetched).not.toBeNull();
    expect(fetched?.previewId).toBe(preview.previewId);
  });

  it("fails completely when any configured personal playlist source fails to refresh", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const roommatePlId = "roommate-pl-1";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.roommateMemberId,
      accountId: "cloud-roommate",
      playlistId: roommatePlId,
      name: "室友个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "宿舍歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: [],
            songs: []
          }
        };
      }
      if (id === roommatePlId) {
        return {
          ok: false,
          error: { code: "RATE_LIMITED", message: "限流了", outcome: "failed" }
        };
      }
      throw new Error(`Unknown playlist: ${id}`);
    };

    await expect(
      ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
        memberIds: [ctx.roommateMemberId],
        count: 10
      })
    ).rejects.toThrowError(expect.objectContaining({
      status: 502,
      code: "RATE_LIMITED"
    }));
  });

  it("invalidates preview when public playlist snapshot changes or preview expires", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-1";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    let callCount = 0;
    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: ["s_old"],
            songs: [{ id: "s_old", name: "旧歌", artists: ["A"], album: "Album" }]
          }
        };
      }
      callCount++;
      const songId = `s_new_${callCount}`;
      return {
        ok: true,
        data: {
          playlist: { id, name: "个人歌单", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: [songId],
          songs: [{ id: songId, name: `新歌${callCount}`, artists: ["A"], album: "Album" }]
        }
      };
    };

    const preview1 = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 10
    });
    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview1.previewId)).not.toBeNull();

    // Advance time past TTL (10 minutes)
    ctx.advanceTime(11 * 60 * 1000);
    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview1.previewId)).toBeNull();

    // Generate fresh preview
    const preview2 = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 10
    });
    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview2.previewId)).not.toBeNull();

    // Simulate public playlist snapshot version change (e.g. track added in background)
    ctx.database.update(playlistSnapshot)
      .set({ snapshotVersion: 999 })
      .where(eq(playlistSnapshot.playlistId, publicPlaylistId))
      .run();

    // Now reading preview2 should be null (invalidated)
    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview2.previewId)).toBeNull();
  });

  it("validates preview strictly for confirmation and reports exact invalidation reason", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-1";
    const personalBindingId = v7();
    ctx.database.insert(personalPlaylistBinding).values({
      id: personalBindingId,
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: ["s_old"],
            songs: [{ id: "s_old", name: "旧歌", artists: ["A"], album: "Album" }]
          }
        };
      }
      return {
        ok: true,
        data: {
          playlist: { id, name: "个人歌单", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: ["s_new"],
          songs: [{ id: "s_new", name: "新歌", artists: ["A"], album: "Album" }]
        }
      };
    };

    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 10
    });
    const validated = ctx.randomPreview.validate(ctx.ownerUserId, ctx.roomId, preview.previewId);
    expect(validated.previewId).toBe(preview.previewId);
    expect(validated.trackSourceMembers["s_new"]).toBe(ctx.ownerMemberId);

    // After expiration: throws PREVIEW_EXPIRED
    ctx.advanceTime(11 * 60 * 1000);
    expect(() => {
      ctx.randomPreview.validate(ctx.ownerUserId, ctx.roomId, preview.previewId);
    }).toThrowError(expect.objectContaining({
      status: 410,
      code: "PREVIEW_EXPIRED"
    }));
  });

  it("invalidates preview when source personal playlist changes, rebinding occurs, or generation bumps", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-1";
    const personalBindingId = v7();
    ctx.database.insert(personalPlaylistBinding).values({
      id: personalBindingId,
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: ["s_old"],
            songs: [{ id: "s_old", name: "旧歌", artists: ["A"], album: "Album" }]
          }
        };
      }
      return {
        ok: true,
        data: {
          playlist: { id, name: "个人歌单", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: ["s_new"],
          songs: [{ id: "s_new", name: "新歌", artists: ["A"], album: "Album" }]
        }
      };
    };

    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 10
    });
    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview.previewId)).not.toBeNull();

    // Rebind personal playlist to a new generation or playlist
    ctx.database.update(personalPlaylistBinding)
      .set({ generation: 2 })
      .where(eq(personalPlaylistBinding.id, personalBindingId))
      .run();

    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview.previewId)).toBeNull();
    expect(() => {
      ctx.randomPreview.validate(ctx.ownerUserId, ctx.roomId, preview.previewId);
    }).toThrowError(expect.objectContaining({
      status: 409,
      code: "PREVIEW_INVALIDATED"
    }));
  });

  it("invalidates preview when a selected song is removed from the personal playlist source snapshot", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-1";
    const personalBindingId = v7();
    ctx.database.insert(personalPlaylistBinding).values({
      id: personalBindingId,
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: ["s_old"],
            songs: [{ id: "s_old", name: "旧歌", artists: ["A"], album: "Album" }]
          }
        };
      }
      return {
        ok: true,
        data: {
          playlist: { id, name: "个人歌单", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: ["s_new"],
          songs: [{ id: "s_new", name: "新歌", artists: ["A"], album: "Album" }]
        }
      };
    };

    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 10
    });
    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview.previewId)).not.toBeNull();

    // Source snapshot version changes
    ctx.database.update(playlistSnapshot)
      .set({ snapshotVersion: 2 })
      .where(eq(playlistSnapshot.playlistId, ownerPlId))
      .run();

    expect(ctx.randomPreview.get(ctx.ownerUserId, ctx.roomId, preview.previewId)).toBeNull();
    expect(() => {
      ctx.randomPreview.validate(ctx.ownerUserId, ctx.roomId, preview.previewId);
    }).toThrowError(expect.objectContaining({
      status: 409,
      code: "PREVIEW_INVALIDATED"
    }));
  });

  it("generates preview and validates confirmation successfully even when all candidates already exist in public playlist", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-all-old";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍公共歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    ctx.database.insert(playlistSnapshot).values({
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      snapshotVersion: 1,
      syncedAt: ctx.now(),
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    const ownerPlId = "owner-pl-all-old";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    const roommatePlId = "roommate-pl-all-old";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.roommateMemberId,
      accountId: "cloud-roommate",
      playlistId: roommatePlId,
      name: "室友个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    // All songs in personal playlists are already in public playlist
    const allOldSongs = [
      { id: "s1", name: "旧歌一", artists: ["A"], album: "Album" },
      { id: "s2", name: "旧歌二", artists: ["A"], album: "Album" },
      { id: "s3", name: "旧歌三", artists: ["B"], album: "Album" }
    ];

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: ["s1", "s2", "s3"],
            songs: allOldSongs
          }
        };
      }
      if (id === ownerPlId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "房主歌单", creatorId: "other-creator", subscribed: true, status: 0 },
            songIds: ["s1", "s2"],
            songs: allOldSongs.slice(0, 2)
          }
        };
      }
      if (id === roommatePlId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "室友歌单", creatorId: "other-creator", subscribed: true, status: 0 },
            songIds: ["s3"],
            songs: allOldSongs.slice(2, 3)
          }
        };
      }
      throw new Error(`Unknown playlist: ${id}`);
    };

    // Should succeed without throwing NO_NEW_SONGS
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId, ctx.roommateMemberId],
      count: 10
    });
    expect(preview.actualCount).toBe(3);
    expect(preview.tracks).toHaveLength(3);
    expect(preview.tracks.every(t => !t.isNew)).toBe(true);

    // Validate confirmation must pass as well
    const validated = ctx.randomPreview.validate(ctx.ownerUserId, ctx.roomId, preview.previewId);
    expect(validated.previewId).toBe(preview.previewId);
    expect(validated.tracks.map(t => t.songId).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("rejects non-existent, cross-room or left members with INVALID_MEMBER (400)", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const fakeMemberId = v7();

    await expect(
      ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
        memberIds: [fakeMemberId],
        count: 10
      })
    ).rejects.toThrowError(expect.objectContaining({
      status: 400,
      code: "INVALID_MEMBER"
    }));
  });

  it("rejects members without personal playlist with MEMBER_PLAYLIST_NOT_CONFIGURED (400)", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    // Owner has no personal playlist configured yet
    await expect(
      ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
        memberIds: [ctx.ownerMemberId],
        count: 10
      })
    ).rejects.toThrowError(expect.objectContaining({
      status: 400,
      code: "MEMBER_PLAYLIST_NOT_CONFIGURED"
    }));
  });

  it("only refreshes selected members and ignores unselected broken sources", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-1";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    const roommatePlId = "roommate-broken-pl";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.roommateMemberId,
      accountId: "cloud-roommate",
      playlistId: roommatePlId,
      name: "室友歌单(损坏)",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    const visitedPlaylists: string[] = [];

    ctx.adapter.detailHandler = (id: string) => {
      visitedPlaylists.push(id);
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "宿舍歌单", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: [],
            songs: []
          }
        };
      }
      if (id === ownerPlId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "房主个人歌单", creatorId: "other-creator", subscribed: true, status: 0 },
            songIds: ["s_owner_1"],
            songs: [{ id: "s_owner_1", name: "房主歌曲", artists: ["周杰伦"], album: "范特西" }]
          }
        };
      }
      if (id === roommatePlId) {
        // Unselected roommate source would fail if called
        return {
          ok: false,
          error: { code: "MODULE_ERROR", message: "室友歌单崩了", outcome: "failed" }
        };
      }
      throw new Error(`Unknown playlist: ${id}`);
    };

    // Only select owner
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 10
    });

    expect(preview.actualCount).toBe(1);
    expect(preview.tracks[0]?.songId).toBe("s_owner_1");
    // Verify roommate playlist was never refreshed
    expect(visitedPlaylists).toContain(ownerPlId);
    expect(visitedPlaylists).not.toContain(roommatePlId);
  });

  it("fails when all selected members have empty playlists with EMPTY_CANDIDATES (422)", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-empty-pl";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主空歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      return {
        ok: true,
        data: {
          playlist: { id, name: "歌单", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: [],
          songs: []
        }
      };
    };

    await expect(
      ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
        memberIds: [ctx.ownerMemberId],
        count: 10
      })
    ).rejects.toThrowError(expect.objectContaining({
      status: 422,
      code: "EMPTY_CANDIDATES"
    }));
  });

  it("changes to unselected members do not invalidate preview, but changes to selected members do", async () => {
    const ctx = createTestContext();

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-1";
    const ownerBindingId = v7();
    ctx.database.insert(personalPlaylistBinding).values({
      id: ownerBindingId,
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    const roommatePlId = "roommate-pl-1";
    const roommateBindingId = v7();
    ctx.database.insert(personalPlaylistBinding).values({
      id: roommateBindingId,
      roomId: ctx.roomId,
      memberId: ctx.roommateMemberId,
      accountId: "cloud-roommate",
      playlistId: roommatePlId,
      name: "室友个人歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: [],
            songs: []
          }
        };
      }
      if (id === ownerPlId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "房主", creatorId: "other-creator", subscribed: true, status: 0 },
            songIds: ["s_owner_1"],
            songs: [{ id: "s_owner_1", name: "房主歌", artists: ["A"], album: "Album" }]
          }
        };
      }
      return {
        ok: true,
        data: {
          playlist: { id, name: "室友", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: ["s_roommate_1"],
          songs: [{ id: "s_roommate_1", name: "室友歌", artists: ["B"], album: "Album" }]
        }
      };
    };

    // Preview only includes owner
    const preview = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 10
    });

    // Now unselected roommate's binding generation changes or roommate leaves
    ctx.database.update(personalPlaylistBinding)
      .set({ generation: 2 })
      .where(eq(personalPlaylistBinding.id, roommateBindingId))
      .run();

    // Validate preview should STILL succeed because roommate was NOT selected
    const validated = ctx.randomPreview.validate(ctx.ownerUserId, ctx.roomId, preview.previewId);
    expect(validated.previewId).toBe(preview.previewId);

    // Now modify the selected owner's binding generation
    ctx.database.update(personalPlaylistBinding)
      .set({ generation: 2 })
      .where(eq(personalPlaylistBinding.id, ownerBindingId))
      .run();

    // Validate preview should now FAIL
    expect(() => {
      ctx.randomPreview.validate(ctx.ownerUserId, ctx.roomId, preview.previewId);
    }).toThrowError(expect.objectContaining({
      status: 409,
      code: "PREVIEW_INVALIDATED"
    }));
  });

  it("rejects preview generation if a selected member leaves or personal playlist invalidates during generation", async () => {
    let hookTriggered = false;
    let lateDatabase: AppDatabase | null = null;
    let targetRoommateId = "";

    const ctx = createTestContext(() => {
      if (!hookTriggered && lateDatabase && targetRoommateId) {
        hookTriggered = true;
        lateDatabase.delete(roomMembership)
          .where(eq(roomMembership.id, targetRoommateId))
          .run();
      }
      return 0.5;
    });

    lateDatabase = ctx.database;
    targetRoommateId = ctx.roommateMemberId;

    const publicPlaylistId = "pub-pl-1";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "宿舍歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-1";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    const roommatePlId = "roommate-pl-1";
    const roommateBindingId = v7();
    ctx.database.insert(personalPlaylistBinding).values({
      id: roommateBindingId,
      roomId: ctx.roomId,
      memberId: ctx.roommateMemberId,
      accountId: "cloud-roommate",
      playlistId: roommatePlId,
      name: "室友歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: [],
            songs: []
          }
        };
      }
      if (id === ownerPlId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "房主", creatorId: "other-creator", subscribed: true, status: 0 },
            songIds: ["s_owner_1"],
            songs: [{ id: "s_owner_1", name: "房主歌", artists: ["A"], album: "Album" }]
          }
        };
      }
      return {
        ok: true,
        data: {
          playlist: { id, name: "室友", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: ["s_roommate_1"],
          songs: [{ id: "s_roommate_1", name: "室友歌", artists: ["B"], album: "Album" }]
        }
      };
    };

    // Both selected, but roommate leaves during selection
    await expect(
      ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
        memberIds: [ctx.ownerMemberId, ctx.roommateMemberId],
        count: 10
      })
    ).rejects.toThrowError(expect.objectContaining({
      status: 400,
      code: "INVALID_MEMBER"
    }));
  });

  it("初次预览并行刷新公共歌单与所有选中成员来源", async () => {
    const ctx = createTestContext();
    const publicPlaylistId = "pub-pl-parallel";
    const ownerPlaylistId = "owner-pl-parallel";
    const roommatePlaylistId = "roommate-pl-parallel";

    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "公共歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();
    ctx.database.insert(personalPlaylistBinding).values([
      {
        id: v7(),
        roomId: ctx.roomId,
        memberId: ctx.ownerMemberId,
        accountId: "cloud-owner",
        playlistId: ownerPlaylistId,
        name: "房主歌单",
        generation: 1,
        createdAt: ctx.now(),
        updatedAt: ctx.now()
      },
      {
        id: v7(),
        roomId: ctx.roomId,
        memberId: ctx.roommateMemberId,
        accountId: "cloud-roommate",
        playlistId: roommatePlaylistId,
        name: "室友歌单",
        generation: 1,
        createdAt: ctx.now(),
        updatedAt: ctx.now()
      }
    ]).run();

    let active = 0;
    let maxActive = 0;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    ctx.adapter.detailHandler = async id => {
      active++;
      maxActive = Math.max(maxActive, active);
      arrivals++;
      if (arrivals === 3) release();
      await barrier;
      active--;
      const personal = id === ownerPlaylistId || id === roommatePlaylistId;
      const songId = id === ownerPlaylistId ? "owner-song" : id === roommatePlaylistId ? "roommate-song" : null;
      return {
        ok: true,
        data: {
          playlist: { id, name: personal ? "个人歌单" : "公共歌单", creatorId: personal ? "other-creator" : "cloud-owner", subscribed: personal, status: 0 },
          songIds: songId ? [songId] : [],
          songs: songId ? [{ id: songId, name: songId, artists: ["歌手"], album: "专辑" }] : []
        }
      };
    };

    const preview = ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId, ctx.roommateMemberId],
      count: 5
    });
    await vi.waitFor(() => expect(arrivals).toBe(3));
    release();
    const result = await preview;

    expect(result.actualCount).toBe(2);
    expect(maxActive).toBe(3);
  });

  it("短时间内（60s）重复生成时复用有效新鲜快照，过期后重新向网易云刷新", async () => {
    const ctx = createTestContext();
    fixtures.push(ctx);

    const publicPlaylistId = "pub-pl-fresh-test";
    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "公共歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    const ownerPlId = "owner-pl-fresh";
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.ownerMemberId,
      accountId: "cloud-owner",
      playlistId: ownerPlId,
      name: "房主歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    ctx.adapter.detailHandler = (id: string) => {
      if (id === publicPlaylistId) {
        return {
          ok: true,
          data: {
            playlist: { id, name: "公共", creatorId: "cloud-owner", subscribed: false, status: 0 },
            songIds: [],
            songs: []
          }
        };
      }
      return {
        ok: true,
        data: {
          playlist: { id, name: "房主", creatorId: "other-creator", subscribed: true, status: 0 },
          songIds: ["s_1", "s_2"],
          songs: [
            { id: "s_1", name: "歌1", artists: ["A"], album: "Album" },
            { id: "s_2", name: "歌2", artists: ["B"], album: "Album" }
          ]
        }
      };
    };

    // 1. 初次生成：公共歌单 + 房主歌单均无快照，发起 2 次上游调用
    const initialCallCount = ctx.adapter.inputs.length;
    const res1 = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 5
    });
    expect(res1.actualCount).toBe(2);
    expect(ctx.adapter.inputs.length - initialCallCount).toBe(2);

    // 2. 10 秒后“换一组”：快照处于 60 秒新鲜期内，零上游网络调用，瞬间出结果
    ctx.advanceTime(10_000);
    const countBeforeReroll = ctx.adapter.inputs.length;
    const res2 = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 5
    });
    expect(res2.actualCount).toBe(2);
    // 上游调用计数未增加
    expect(ctx.adapter.inputs.length).toBe(countBeforeReroll);

    // 3. 超过 60 秒（累计 75 秒）：快照过期，重新向网易云刷新
    ctx.advanceTime(65_000);
    const countBeforeExpire = ctx.adapter.inputs.length;
    const res3 = await ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
      memberIds: [ctx.ownerMemberId],
      count: 5
    });
    expect(res3.actualCount).toBe(2);
    // 重新发起了公共与个人歌单的刷新
    expect(ctx.adapter.inputs.length - countBeforeExpire).toBe(2);
  });

  it("随机选歌预览拒绝未配置个人歌单或授权失效的成员", async () => {
    const ctx = createTestContext();
    const publicPlaylistId = "pub-pl-invalid-members";

    ctx.database.insert(publicPlaylistBinding).values({
      roomId: ctx.roomId,
      accountId: "cloud-owner",
      playlistId: publicPlaylistId,
      name: "公共歌单",
      generation: 1,
      creationOperationId: v7()
    }).run();

    // 1. 室友未绑定个人歌单，尝试抽选报错 MEMBER_PLAYLIST_NOT_CONFIGURED (400)
    await expect(
      ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
        memberIds: [ctx.roommateMemberId],
        count: 5
      })
    ).rejects.toThrowError(expect.objectContaining({
      status: 400,
      code: "MEMBER_PLAYLIST_NOT_CONFIGURED"
    }));

    // 绑定个人歌单
    ctx.database.insert(personalPlaylistBinding).values({
      id: v7(),
      roomId: ctx.roomId,
      memberId: ctx.roommateMemberId,
      accountId: "cloud-roommate",
      playlistId: "roommate-pl",
      name: "室友歌单",
      generation: 1,
      createdAt: ctx.now(),
      updatedAt: ctx.now()
    }).run();

    // 2. 将室友网易云授权置为 waitingAuthorization，尝试抽选报错 MEMBER_AUTH_INVALID (400)
    ctx.database.update(neteaseAuthorization)
      .set({ status: "waitingAuthorization" })
      .where(eq(neteaseAuthorization.userId, ctx.memberUserId))
      .run();

    await expect(
      ctx.randomPreview.generate(ctx.ownerUserId, ctx.roomId, {
        memberIds: [ctx.roommateMemberId],
        count: 5
      })
    ).rejects.toThrowError(expect.objectContaining({
      status: 400,
      code: "MEMBER_AUTH_INVALID"
    }));
  });
});
