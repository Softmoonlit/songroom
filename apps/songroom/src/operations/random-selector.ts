import { BusinessError } from "../shared/errors.js";

export interface CandidateTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
}

export interface CandidateMember {
  memberId: string;
  nickname: string;
  tracks: CandidateTrack[];
}

export interface SelectedTrack {
  songId: string;
  name: string;
  artists: string[];
  album: string;
  sourceMemberId: string;
  sourceMemberNickname: string;
  isNew: boolean;
}

export interface MemberContribution {
  memberId: string;
  nickname: string;
  count: number;
}

export interface RandomSelectionResult {
  actualCount: number;
  tracks: SelectedTrack[];
  memberContributions: MemberContribution[];
  totalUniqueCandidates: number;
}

export interface RandomSelectionInput {
  targetCount: number;
  publicSongIds: string[];
  members: CandidateMember[];
}

function shuffleArray<T>(array: T[], random: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

export function selectFairRandomTracks(
  input: RandomSelectionInput,
  random: () => number = Math.random
): RandomSelectionResult {
  const { targetCount, publicSongIds, members } = input;
  const publicSongSet = new Set(publicSongIds);

  // 1. 过滤未配置或空歌单成员
  const activeMembers = members.filter(member => member.tracks.length > 0);
  if (activeMembers.length === 0) {
    throw new BusinessError(422, "EMPTY_CANDIDATES", "暂无可用的候选歌曲");
  }

  // 2. 收集全房间候选歌曲
  const allUniqueCandidateIds = new Set<string>();
  const songDetails = new Map<string, CandidateTrack>();
  const memberCandidateSongs = new Map<string, string[]>();

  for (const member of activeMembers) {
    const uniqueSongs: string[] = [];
    const memberSeen = new Set<string>();

    for (const track of member.tracks) {
      if (memberSeen.has(track.id)) continue;
      memberSeen.add(track.id);
      uniqueSongs.push(track.id);
      allUniqueCandidateIds.add(track.id);
      if (!songDetails.has(track.id)) {
        songDetails.set(track.id, track);
      }
    }

    memberCandidateSongs.set(member.memberId, uniqueSongs);
  }

  // 3. 计算初始基础配额与余数分配
  const effectiveTargetCount = Math.min(targetCount, allUniqueCandidateIds.size);
  const memberCount = activeMembers.length;
  const shuffledMembers = shuffleArray(activeMembers, random);
  const targetQuota = new Map<string, number>();

  if (memberCount <= effectiveTargetCount) {
    const baseQuota = Math.floor(effectiveTargetCount / memberCount);
    let remainder = effectiveTargetCount % memberCount;

    for (const member of shuffledMembers) {
      let quota = baseQuota;
      if (remainder > 0) {
        quota += 1;
        remainder -= 1;
      }
      targetQuota.set(member.memberId, quota);
    }
  } else {
    // 成员数多于有效目标首数：随机选 effectiveTargetCount 名成员各分 1 首
    for (let i = 0; i < effectiveTargetCount; i++) {
      targetQuota.set(shuffledMembers[i].memberId, 1);
    }
    for (let i = effectiveTargetCount; i < memberCount; i++) {
      targetQuota.set(shuffledMembers[i].memberId, 0);
    }
  }

  // 4. 为每位成员生成偏好序列（内部随机洗牌，不区分新旧）
  const memberOrderedPreferences = new Map<string, string[]>();
  for (const member of activeMembers) {
    const shuffledSongs = shuffleArray(memberCandidateSongs.get(member.memberId)!, random);
    memberOrderedPreferences.set(member.memberId, shuffledSongs);
  }

  // 5. 二分图多重匹配与增广路径分配（公平分配、支持交叉调整归属）
  const songAssignedTo = new Map<string, string>(); // songId -> memberId
  const memberAssignedSongs = new Map<string, Set<string>>();
  for (const member of activeMembers) {
    memberAssignedSongs.set(member.memberId, new Set<string>());
  }

  // 贪心优先分配各自偏好列表的前部
  for (const member of shuffledMembers) {
    const quota = targetQuota.get(member.memberId) ?? 0;
    const preferences = memberOrderedPreferences.get(member.memberId) ?? [];
    for (const songId of preferences) {
      if (memberAssignedSongs.get(member.memberId)!.size >= quota) break;
      if (!songAssignedTo.has(songId)) {
        songAssignedTo.set(songId, member.memberId);
        memberAssignedSongs.get(member.memberId)!.add(songId);
      }
    }
  }

  // 二分图增广重排：若某个成员配额未满，寻找增广路调整
  function augmentPath(memberId: string): boolean {
    const visitedMembers = new Set<string>();
    const visitedSongs = new Set<string>();
    const queue: string[] = [memberId];
    visitedMembers.add(memberId);

    const prevMember = new Map<string, string>(); // currentMemberId -> priorMemberId
    const prevSong = new Map<string, string>();   // currentMemberId -> priorSongId

    let foundUnassignedSong: string | null = null;
    let foundTerminatingMember: string | null = null;

    while (queue.length > 0) {
      const currentMemberId = queue.shift()!;
      const preferences = memberOrderedPreferences.get(currentMemberId) ?? [];

      for (const songId of preferences) {
        if (visitedSongs.has(songId)) continue;
        visitedSongs.add(songId);

        const assignedOwnerId = songAssignedTo.get(songId);
        if (!assignedOwnerId) {
          // 找到了未分配的歌曲，增广路径形成
          foundUnassignedSong = songId;
          foundTerminatingMember = currentMemberId;
          break;
        } else if (!visitedMembers.has(assignedOwnerId)) {
          visitedMembers.add(assignedOwnerId);
          prevMember.set(assignedOwnerId, currentMemberId);
          prevSong.set(assignedOwnerId, songId);
          queue.push(assignedOwnerId);
        }
      }

      if (foundUnassignedSong) break;
    }

    if (!foundUnassignedSong || !foundTerminatingMember) {
      return false;
    }

    // 回溯路径应用增广
    let currentMemberId: string | null = foundTerminatingMember;
    let currentSongId: string | null = foundUnassignedSong;

    while (currentMemberId !== null && currentSongId !== null) {
      const priorMemberId: string | undefined = prevMember.get(currentMemberId);
      const priorSongId: string | undefined = prevSong.get(currentMemberId);

      songAssignedTo.set(currentSongId, currentMemberId);
      memberAssignedSongs.get(currentMemberId)!.add(currentSongId);

      if (priorMemberId && priorSongId) {
        memberAssignedSongs.get(currentMemberId)!.delete(priorSongId);
        currentMemberId = priorMemberId;
        currentSongId = priorSongId;
      } else {
        currentMemberId = null;
        currentSongId = null;
      }
    }

    return true;
  }

  // 针对配额未满的成员尝试增广
  for (const member of shuffledMembers) {
    const quota = targetQuota.get(member.memberId) ?? 0;
    while (memberAssignedSongs.get(member.memberId)!.size < quota) {
      const success = augmentPath(member.memberId);
      if (!success) break;
    }
  }

  // 6. 候选不足时的剩余配额重分配：
  // 若部分成员候选不足以填满配额，而其他成员还有剩余候选歌曲，在其他成员间继续均分分配直到全房间总数达到 targetCount 或无更多可用歌曲
  let currentTotalAssigned = Array.from(memberAssignedSongs.values()).reduce((sum, set) => sum + set.size, 0);

  while (currentTotalAssigned < targetCount && currentTotalAssigned < allUniqueCandidateIds.size) {
    // 找出当前已分配数最少且有剩余未分配可用歌曲的成员
    let candidateMembersWithSpareSongs = activeMembers
      .map(member => {
        const assignedSet = memberAssignedSongs.get(member.memberId)!;
        const spareSongs = (memberOrderedPreferences.get(member.memberId) ?? []).filter(songId => !songAssignedTo.has(songId));
        return { memberId: member.memberId, assignedCount: assignedSet.size, spareSongs };
      })
      .filter(item => item.spareSongs.length > 0);

    if (candidateMembersWithSpareSongs.length === 0) {
      break;
    }

    // 优先分配给当前分配数量最少的成员
    const minAssignedCount = Math.min(...candidateMembersWithSpareSongs.map(item => item.assignedCount));
    candidateMembersWithSpareSongs = candidateMembersWithSpareSongs.filter(item => item.assignedCount === minAssignedCount);
    const chosenMember = shuffleArray(candidateMembersWithSpareSongs, random)[0];

    const songId = chosenMember.spareSongs[0];
    songAssignedTo.set(songId, chosenMember.memberId);
    memberAssignedSongs.get(chosenMember.memberId)!.add(songId);
    currentTotalAssigned++;
  }

  // 7. 组装输出结果并整组洗牌
  const memberMap = new Map(activeMembers.map(member => [member.memberId, member]));
  const resultTracks: SelectedTrack[] = [];

  for (const [songId, assignedMemberId] of songAssignedTo.entries()) {
    const track = songDetails.get(songId)!;
    const member = memberMap.get(assignedMemberId)!;
    resultTracks.push({
      songId: track.id,
      name: track.name,
      artists: track.artists,
      album: track.album,
      sourceMemberId: assignedMemberId,
      sourceMemberNickname: member.nickname,
      isNew: !publicSongSet.has(track.id)
    });
  }

  // 对确定好的整组歌曲洗牌，不保证成员交错，允许同一成员歌曲相邻
  const finalTracks = shuffleArray(resultTracks, random);

  const memberContributions: MemberContribution[] = members.map(member => ({
    memberId: member.memberId,
    nickname: member.nickname,
    count: memberAssignedSongs.get(member.memberId)?.size ?? 0
  }));

  return {
    actualCount: finalTracks.length,
    tracks: finalTracks,
    memberContributions,
    totalUniqueCandidates: allUniqueCandidateIds.size
  };
}
