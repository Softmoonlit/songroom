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
  targetCount: 5 | 10 | 15 | 20 | number;
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

  // 2. 收集全房间候选歌曲与新旧分类
  let hasAnyNewSong = false;
  const allUniqueCandidateIds = new Set<string>();
  const songDetails = new Map<string, CandidateTrack>();
  const memberNewSongs = new Map<string, string[]>();
  const memberOldSongs = new Map<string, string[]>();

  for (const member of activeMembers) {
    const newSongs: string[] = [];
    const oldSongs: string[] = [];
    const memberUniqueSongs = new Set<string>();

    for (const track of member.tracks) {
      if (memberUniqueSongs.has(track.id)) continue;
      memberUniqueSongs.add(track.id);
      allUniqueCandidateIds.add(track.id);
      if (!songDetails.has(track.id)) {
        songDetails.set(track.id, track);
      }

      if (publicSongSet.has(track.id)) {
        oldSongs.push(track.id);
      } else {
        newSongs.push(track.id);
        hasAnyNewSong = true;
      }
    }

    memberNewSongs.set(member.memberId, newSongs);
    memberOldSongs.set(member.memberId, oldSongs);
  }

  // 3. 规格：没有新歌时不换
  if (!hasAnyNewSong) {
    throw new BusinessError(409, "NO_NEW_SONGS", "暂无新歌曲可换");
  }

  // 4. 计算初始基础配额与余数分配
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
    let newSongEnsured = false;
    for (let i = 0; i < effectiveTargetCount; i++) {
      const member = shuffledMembers[i];
      targetQuota.set(member.memberId, 1);
      if (memberNewSongs.get(member.memberId)!.length > 0) {
        newSongEnsured = true;
      }
    }
    for (let i = effectiveTargetCount; i < memberCount; i++) {
      targetQuota.set(shuffledMembers[i].memberId, 0);
    }

    // 规格："候选有新歌时最终预览包含新歌，不为追求变化降低已经可以达到的成员均分程度"
    if (!newSongEnsured) {
      const memberWithNewIndex = shuffledMembers.findIndex((member, idx) => idx >= effectiveTargetCount && memberNewSongs.get(member.memberId)!.length > 0);
      if (memberWithNewIndex !== -1) {
        const swapInMember = shuffledMembers[memberWithNewIndex];
        const swapOutMember = shuffledMembers[0];
        targetQuota.set(swapInMember.memberId, 1);
        targetQuota.set(swapOutMember.memberId, 0);
      }
    }
  }

  // 5. 为每位成员生成偏好序列（内部洗牌：新歌在前，旧歌在后）
  const memberOrderedPreferences = new Map<string, string[]>();
  for (const member of activeMembers) {
    const shuffledNew = shuffleArray(memberNewSongs.get(member.memberId)!, random);
    const shuffledOld = shuffleArray(memberOldSongs.get(member.memberId)!, random);
    memberOrderedPreferences.set(member.memberId, [...shuffledNew, ...shuffledOld]);
  }

  // 6. 二分图多重匹配与增广路径分配（公平分配、支持交叉调整归属）
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

  // 7. 候选不足时的剩余配额重分配：
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

  // 8. 确保最终结果包含至少一首新歌（如果全房间候选中有新歌）
  let totalNewSongsInResult = 0;
  for (const [songId] of songAssignedTo) {
    if (!publicSongSet.has(songId)) {
      totalNewSongsInResult++;
    }
  }

  if (totalNewSongsInResult === 0 && hasAnyNewSong) {
    // 若当前结果中全是旧歌，但在候选中有新歌未被选中，
    // 寻找一个拥有未选中新歌的成员，用该新歌替换该成员或其他成员的一首旧歌
    const allAssignedOldSongs = Array.from(songAssignedTo.entries()).filter(([songId]) => publicSongSet.has(songId));

    if (allAssignedOldSongs.length > 0) {
      let replaced = false;
      for (const member of activeMembers) {
        const spareNewSongs = (memberNewSongs.get(member.memberId) ?? []).filter(songId => !songAssignedTo.has(songId));
        if (spareNewSongs.length > 0) {
          const newSongId = spareNewSongs[0];
          // 优先替换该成员自己的旧歌
          const memberAssignedOld = Array.from(memberAssignedSongs.get(member.memberId)!).filter(songId => publicSongSet.has(songId));
          if (memberAssignedOld.length > 0) {
            const oldSongId = memberAssignedOld[0];
            memberAssignedSongs.get(member.memberId)!.delete(oldSongId);
            memberAssignedSongs.get(member.memberId)!.add(newSongId);
            songAssignedTo.delete(oldSongId);
            songAssignedTo.set(newSongId, member.memberId);
            replaced = true;
            break;
          } else {
            // 替换其他成员的一首旧歌
            const [oldSongId, oldOwnerId] = allAssignedOldSongs[0];
            memberAssignedSongs.get(oldOwnerId)!.delete(oldSongId);
            songAssignedTo.delete(oldSongId);
            memberAssignedSongs.get(member.memberId)!.add(newSongId);
            songAssignedTo.set(newSongId, member.memberId);
            replaced = true;
            break;
          }
        }
      }
    }
  }

  // 9. 组装输出结果
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

  const memberContributions: MemberContribution[] = members.map(member => ({
    memberId: member.memberId,
    nickname: member.nickname,
    count: memberAssignedSongs.get(member.memberId)?.size ?? 0
  }));

  return {
    actualCount: resultTracks.length,
    tracks: resultTracks,
    memberContributions,
    totalUniqueCandidates: allUniqueCandidateIds.size
  };
}
