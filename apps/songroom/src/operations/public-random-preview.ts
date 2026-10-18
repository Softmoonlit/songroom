import { and, eq } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import {
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
  targetCount: 5 | 10 | 15 | 20;
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

    // 1. 刷新公共歌单并核实完整快照
    const publicView = await this.publicPlaylists.refresh(userId, roomId);
    if (publicView.lastRefreshError) {
      throw new BusinessError(502, publicView.lastRefreshError, `公共歌单读取失败: ${publicView.lastRefreshError}`);
    }
    if (!publicView.snapshot) {
      throw new BusinessError(502, "MODULE_ERROR", "公共歌单快照不可用");
    }

    // 2. 查找本房间所有已配置个人歌单的成员
    const bindings = this.database.select().from(personalPlaylistBinding)
      .where(eq(personalPlaylistBinding.roomId, roomId)).all();

    const members = this.database.select().from(roomMembership)
      .where(eq(roomMembership.roomId, roomId)).all();
    const memberMap = new Map(members.map(m => [m.id, m]));

    // 3. 逐一刷新已配置成员的个人歌单
    // 规格："任何已配置来源读取失败、目标失效或无法证明读取完整时，整次不换歌，保留当前公共歌单，提示具体来源问题；不把读取失败当作空歌单，也不凭旧快照略过该成员。"
    const candidateMembers: CandidateMember[] = [];
    const sourceBases: SourceBasis[] = [];

    for (const b of bindings) {
      const memberInfo = memberMap.get(b.memberId);
      if (!memberInfo) continue;

      const memberView = await this.personalPlaylists.refresh(userId, roomId, b.memberId);
      if (memberView.lastRefreshError) {
        throw new BusinessError(502, memberView.lastRefreshError, `成员 ${memberInfo.nickname} 个人歌单读取失败: ${memberView.lastRefreshError}`);
      }
      if (!memberView.snapshot) {
        throw new BusinessError(502, "MODULE_ERROR", `成员 ${memberInfo.nickname} 个人歌单快照不可用`);
      }

      const songIds = memberView.snapshot.tracks.map(t => t.songId);
      sourceBases.push({
        memberId: b.memberId,
        bindingId: b.id,
        playlistId: b.playlistId,
        bindingGeneration: b.generation,
        snapshotVersion: memberView.snapshot.version,
        songIds
      });

      candidateMembers.push({
        memberId: b.memberId,
        nickname: memberInfo.nickname,
        tracks: memberView.snapshot.tracks.map(t => ({
          id: t.songId,
          name: t.name,
          artists: t.artists,
          album: t.album
        }))
      });
    }

    // 4. 统计旧公共歌单信息
    const publicTracks = publicView.snapshot.tracks;
    const oldTrackCount = publicTracks.length;
    const oldTracksWithRequesterCount = publicTracks.filter(t => t.requesters && t.requesters.length > 0).length;
    const publicSongIds = publicTracks.map(t => t.songId);

    // 5. 调用公平随机选歌算法
    const selection = selectFairRandomTracks(
      {
        targetCount: command.count,
        publicSongIds,
        members: candidateMembers
      },
      this.random
    );

    // 6. 存储短命预览记录与完整依据
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
