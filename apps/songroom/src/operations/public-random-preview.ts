import { and, eq, inArray } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import {
  neteaseAuthorization,
  personalPlaylistBinding,
  playlistSnapshot,
  publicPlaylistBinding,
  room,
  roomMembership
} from "../db/schema.js";
import { BusinessError } from "../shared/errors.js";
import type {
  RandomReplacementPreviewCommand,
  RandomReplacementPreviewView
} from "../shared/public-playlist-contracts.js";
import {
  selectFairRandomTracks,
  type CandidateMember,
  type MemberContribution,
  type SelectedTrack
} from "./random-selector.js";
import type { PublicPlaylists } from "./public-playlists.js";
import type { PersonalPlaylists } from "./personal-playlists.js";

export const PREVIEW_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const FRESH_SNAPSHOT_WINDOW_MS = 60 * 1000; // 60 seconds (新鲜快照复用窗口)

export interface SourceBasis {
  memberId: string;
  bindingId: string;
  playlistId: string;
  bindingGeneration: number;
  snapshotVersion: number;
  songIds: string[];
}

export interface StoredRandomPreview {
  previewId: string;
  roomId: string;
  ownerUserId: string;
  targetCount: number;
  actualCount: number;
  tracks: SelectedTrack[];
  memberContributions: MemberContribution[];
  trackSourceMembers: Record<string, string>; // songId -> memberId
  publicPlaylistId: string;
  publicBindingGeneration: number;
  publicSnapshotVersion: number;
  publicSongIds: string[];
  sources: SourceBasis[];
  oldTrackCount: number;
  oldTracksWithRequesterCount: number;
  createdAt: number;
  expiresAt: number;
}

export class PublicRandomPreview {
  readonly #previews = new Map<string, StoredRandomPreview>();
  readonly #verifiedSources = new Map<string, number>(); // key: ${roomId}:${type}:${id} -> verifiedAt timestamp

  constructor(
    private readonly database: AppDatabase,
    private readonly publicPlaylists: PublicPlaylists,
    private readonly personalPlaylists: PersonalPlaylists,
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = Math.random
  ) {}

  #assertOwner(userId: string, roomId: string): { roomId: string; ownerUserId: string } {
    const currentRoom = this.database.select().from(room).where(eq(room.id, roomId)).get();
    const member = this.database.select().from(roomMembership)
      .where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();

    if (!currentRoom || !member) {
      throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是成员");
    }
    if (currentRoom.ownerUserId !== userId) {
      throw new BusinessError(403, "OWNER_ONLY", "只有房主可以操作随机换歌预览");
    }
    return { roomId: currentRoom.id, ownerUserId: currentRoom.ownerUserId };
  }

  async generate(
    userId: string,
    roomId: string,
    command: RandomReplacementPreviewCommand
  ): Promise<RandomReplacementPreviewView> {
    this.#assertOwner(userId, roomId);

    const publicBinding = this.database.select().from(publicPlaylistBinding)
      .where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (!publicBinding) {
      throw new BusinessError(409, "PUBLIC_PLAYLIST_NOT_FOUND", "房间尚未绑定公共歌单");
    }

    // 1. 校验所选成员集合与来源绑定，再同时刷新公共歌单和所有选中来源。
    const rawMemberIds = command.memberIds;
    const requestedMemberIds = Array.from(new Set(rawMemberIds));

    const members = this.database.select().from(roomMembership)
      .where(eq(roomMembership.roomId, roomId)).all();
    const memberMap = new Map(members.map(m => [m.id, m]));

    for (const memberId of requestedMemberIds) {
      if (!memberMap.has(memberId)) {
        throw new BusinessError(400, "INVALID_MEMBER", "所选成员不存在或已离开房间");
      }
    }

    const bindings = this.database.select().from(personalPlaylistBinding)
      .where(eq(personalPlaylistBinding.roomId, roomId)).all();
    const bindingMap = new Map(bindings.map(b => [b.memberId, b]));

    const userIds = requestedMemberIds.map(id => memberMap.get(id)!.userId);
    const auths = userIds.length > 0
      ? this.database.select().from(neteaseAuthorization).where(inArray(neteaseAuthorization.userId, userIds)).all()
      : [];
    const authMap = new Map(auths.map(a => [a.userId, a]));

    for (const memberId of requestedMemberIds) {
      const binding = bindingMap.get(memberId);
      const member = memberMap.get(memberId)!;
      if (!binding) {
        throw new BusinessError(400, "MEMBER_PLAYLIST_NOT_CONFIGURED", `成员 ${member.nickname} 尚未配置个人歌单`);
      }
      const auth = authMap.get(member.userId);
      if (!auth || auth.status !== "active" || !auth.credentials) {
        throw new BusinessError(400, "MEMBER_AUTH_INVALID", `成员 ${member.nickname} 网易云授权已失效，无法参与随机点歌`);
      }
      if (auth.accountId !== binding.accountId) {
        throw new BusinessError(400, "MEMBER_AUTH_INVALID", `成员 ${member.nickname} 网易云账号已变更，无法参与随机点歌`);
      }
    }

    const publicVerifiedKey = `${roomId}:public:${publicBinding.accountId}:${publicBinding.playlistId}:${publicBinding.generation}`;
    const lastPublicVerifiedAt = this.#verifiedSources.get(publicVerifiedKey);
    const publicViewPromise = lastPublicVerifiedAt !== undefined && this.now() - lastPublicVerifiedAt <= FRESH_SNAPSHOT_WINDOW_MS
      ? Promise.resolve(this.publicPlaylists.read(userId, roomId))
      : this.publicPlaylists.refresh(userId, roomId);

    const memberViewPromises = requestedMemberIds.map(async memberId => {
      const memberInfo = memberMap.get(memberId)!;
      const binding = bindingMap.get(memberId)!;
      const memberVerifiedKey = `${roomId}:personal:${binding.accountId}:${binding.playlistId}:${binding.generation}`;
      const lastMemberVerifiedAt = this.#verifiedSources.get(memberVerifiedKey);
      const memberView = lastMemberVerifiedAt !== undefined && this.now() - lastMemberVerifiedAt <= FRESH_SNAPSHOT_WINDOW_MS
        ? this.personalPlaylists.read(userId, roomId, memberId)
        : await this.personalPlaylists.refresh(userId, roomId, memberId);
      return { memberId, memberInfo, binding, memberVerifiedKey, memberView };
    });

    const [publicView, memberResults] = await Promise.all([
      publicViewPromise,
      Promise.all(memberViewPromises)
    ]);

    if (publicView.lastRefreshError) {
      this.#verifiedSources.delete(publicVerifiedKey);
      throw new BusinessError(502, publicView.lastRefreshError, `公共歌单读取失败: ${publicView.lastRefreshError}`);
    }
    if (!publicView.snapshot) {
      this.#verifiedSources.delete(publicVerifiedKey);
      throw new BusinessError(502, "MODULE_ERROR", "公共歌单快照不可用");
    }
    this.#verifiedSources.set(publicVerifiedKey, this.now());

    // 规格：任一已配置来源读取失败，整次预览失败；不凭旧快照放行。
    const candidateMembers: CandidateMember[] = [];
    const sourceBases: SourceBasis[] = [];
    for (const { memberInfo, binding, memberVerifiedKey, memberView } of memberResults) {
      if (memberView.lastRefreshError) {
        this.#verifiedSources.delete(memberVerifiedKey);
        throw new BusinessError(502, memberView.lastRefreshError, `成员 ${memberInfo.nickname} 个人歌单读取失败: ${memberView.lastRefreshError}`);
      }
      if (!memberView.snapshot) {
        this.#verifiedSources.delete(memberVerifiedKey);
        throw new BusinessError(502, "MODULE_ERROR", `成员 ${memberInfo.nickname} 个人歌单快照不可用`);
      }
      this.#verifiedSources.set(memberVerifiedKey, this.now());

      const songIds = memberView.snapshot.tracks.map(t => t.songId);
      sourceBases.push({
        memberId: binding.memberId,
        bindingId: binding.id,
        playlistId: binding.playlistId,
        bindingGeneration: binding.generation,
        snapshotVersion: memberView.snapshot.version,
        songIds
      });

      candidateMembers.push({
        memberId: binding.memberId,
        nickname: memberInfo.nickname,
        tracks: memberView.snapshot.tracks.map(t => ({
          id: t.songId,
          name: t.name,
          artists: t.artists,
          album: t.album
        }))
      });
    }

    // 2. 公共歌单与成员来源均已刷新并写入快照；后续抽选只读取本次最新快照。

    const publicTracks = publicView.snapshot.tracks;
    const oldTrackCount = publicTracks.length;
    const oldTracksWithRequesterCount = publicTracks.filter(t => t.requesters && t.requesters.length > 0).length;
    const publicSongIds = publicTracks.map(t => t.songId);

    // 5. 检查所选成员歌单是否全部为空
    const totalCandidateTracks = candidateMembers.reduce((sum, m) => sum + m.tracks.length, 0);
    if (totalCandidateTracks === 0) {
      throw new BusinessError(422, "EMPTY_CANDIDATES", "所选成员的歌单暂无歌曲");
    }

    // 6. 调用公平随机选歌算法
    const selection = selectFairRandomTracks(
      {
        targetCount: command.count,
        publicSongIds,
        members: candidateMembers
      },
      this.random
    );

    // 7. 规格要求："生成期间所选成员离开或个人歌单失效时，拒绝本次预览"
    const finalMembers = this.database.select().from(roomMembership)
      .where(eq(roomMembership.roomId, roomId)).all();
    const finalMemberIds = new Set(finalMembers.map(m => m.id));
    for (const memberId of requestedMemberIds) {
      if (!finalMemberIds.has(memberId)) {
        throw new BusinessError(400, "INVALID_MEMBER", "生成期间所选成员离开房间");
      }
    }

    const finalBindings = this.database.select().from(personalPlaylistBinding)
      .where(eq(personalPlaylistBinding.roomId, roomId)).all();
    const finalBindingMap = new Map(finalBindings.map(b => [b.memberId, b]));
    for (const base of sourceBases) {
      const currentBinding = finalBindingMap.get(base.memberId);
      if (!currentBinding || currentBinding.generation !== base.bindingGeneration || currentBinding.id !== base.bindingId) {
        throw new BusinessError(400, "MEMBER_PLAYLIST_NOT_CONFIGURED", "生成期间所选成员个人歌单已发生变化或失效");
      }
    }

    // 8. 存储短命预览记录与完整依据
    const previewId = v7();
    const createdAt = this.now();
    const expiresAt = createdAt + PREVIEW_TTL_MS;

    const trackSourceMembers: Record<string, string> = {};
    for (const t of selection.tracks) {
      trackSourceMembers[t.songId] = t.sourceMemberId;
    }

    const stored: StoredRandomPreview = {
      previewId,
      roomId,
      ownerUserId: userId,
      targetCount: command.count,
      actualCount: selection.actualCount,
      tracks: selection.tracks,
      memberContributions: selection.memberContributions,
      trackSourceMembers,
      publicPlaylistId: publicBinding.playlistId,
      publicBindingGeneration: publicBinding.generation,
      publicSnapshotVersion: publicView.snapshot.version,
      publicSongIds,
      sources: sourceBases,
      oldTrackCount,
      oldTracksWithRequesterCount,
      createdAt,
      expiresAt
    };

    this.#previews.set(previewId, stored);

    return {
      previewId,
      roomId,
      targetCount: command.count,
      actualCount: selection.actualCount,
      tracks: selection.tracks,
      memberContributions: selection.memberContributions,
      oldTrackCount,
      oldTracksWithRequesterCount,
      createdAt,
      expiresAt
    };
  }

  #validateInternal(
    userId: string,
    roomId: string,
    previewId: string
  ): { ok: true; preview: StoredRandomPreview } | { ok: false; error: BusinessError } {
    this.#assertOwner(userId, roomId);

    const stored = this.#previews.get(previewId);
    if (!stored || stored.roomId !== roomId || stored.ownerUserId !== userId) {
      return { ok: false, error: new BusinessError(404, "PREVIEW_NOT_FOUND", "换歌预览不存在或已失效") };
    }

    if (this.now() > stored.expiresAt) {
      this.#previews.delete(previewId);
      return { ok: false, error: new BusinessError(410, "PREVIEW_EXPIRED", "换歌预览已过期，请重新预览") };
    }

    // 1. 验证公共歌单是否发生变化
    const publicBinding = this.database.select().from(publicPlaylistBinding)
      .where(eq(publicPlaylistBinding.roomId, roomId)).get();
    if (
      !publicBinding ||
      publicBinding.playlistId !== stored.publicPlaylistId ||
      publicBinding.generation !== stored.publicBindingGeneration
    ) {
      return { ok: false, error: new BusinessError(409, "PREVIEW_INVALIDATED", "公共歌单配置已变更，请重新预览") };
    }

    const publicSnap = this.database.select().from(playlistSnapshot)
      .where(and(eq(playlistSnapshot.accountId, publicBinding.accountId), eq(playlistSnapshot.playlistId, publicBinding.playlistId))).get();
    if (!publicSnap || publicSnap.snapshotVersion !== stored.publicSnapshotVersion) {
      return { ok: false, error: new BusinessError(409, "PREVIEW_INVALIDATED", "公共歌单歌曲已变更，请重新预览") };
    }

    // 2. 验证所有来源成员与个人歌单绑定依据
    const currentBindings = this.database.select().from(personalPlaylistBinding)
      .where(eq(personalPlaylistBinding.roomId, roomId)).all();
    const bindingByMember = new Map(currentBindings.map(b => [b.memberId, b]));

    for (const source of stored.sources) {
      const member = this.database.select().from(roomMembership)
        .where(and(eq(roomMembership.id, source.memberId), eq(roomMembership.roomId, roomId))).get();
      if (!member) {
        return { ok: false, error: new BusinessError(409, "PREVIEW_INVALIDATED", "来源成员已离开房间，请重新预览") };
      }

      const currentBinding = bindingByMember.get(source.memberId);
      if (
        !currentBinding ||
        currentBinding.id !== source.bindingId ||
        currentBinding.playlistId !== source.playlistId ||
        currentBinding.generation !== source.bindingGeneration
      ) {
        return { ok: false, error: new BusinessError(409, "PREVIEW_INVALIDATED", "成员个人歌单配置已变更，请重新预览") };
      }

      const memberSnap = this.database.select().from(playlistSnapshot)
        .where(and(eq(playlistSnapshot.accountId, currentBinding.accountId), eq(playlistSnapshot.playlistId, currentBinding.playlistId))).get();
      if (!memberSnap || memberSnap.snapshotVersion !== source.snapshotVersion) {
        return { ok: false, error: new BusinessError(409, "PREVIEW_INVALIDATED", "成员个人歌单歌曲已变更，请重新预览") };
      }
    }

    // 3. 验证选中歌曲仍在对应来源的歌曲集合中
    for (const track of stored.tracks) {
      const source = stored.sources.find(s => s.memberId === track.sourceMemberId);
      if (!source || !source.songIds.includes(track.songId)) {
        return { ok: false, error: new BusinessError(409, "PREVIEW_INVALIDATED", "候选歌曲已从个人歌单中移除，请重新预览") };
      }
    }

    return { ok: true, preview: stored };
  }

  get(userId: string, roomId: string, previewId: string): RandomReplacementPreviewView | null {
    const result = this.#validateInternal(userId, roomId, previewId);
    if (!result.ok) {
      return null;
    }
    const stored = result.preview;
    return {
      previewId: stored.previewId,
      roomId: stored.roomId,
      targetCount: stored.targetCount,
      actualCount: stored.actualCount,
      tracks: stored.tracks,
      memberContributions: stored.memberContributions,
      oldTrackCount: stored.oldTrackCount,
      oldTracksWithRequesterCount: stored.oldTracksWithRequesterCount,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt
    };
  }

  validate(userId: string, roomId: string, previewId: string): StoredRandomPreview {
    const result = this.#validateInternal(userId, roomId, previewId);
    if (!result.ok) {
      throw result.error;
    }
    return result.preview;
  }
}
