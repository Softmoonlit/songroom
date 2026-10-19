import { describe, expect, it } from "vitest";
import { BusinessError } from "../shared/errors.js";
import { selectFairRandomTracks, type CandidateMember } from "./random-selector.js";

// 线性同余发生器 (Linear Congruential Generator, Numerical Recipes 参数：a=1664525, c=1013904223, m=2^32)
// 用于提供完全可控、无外部依赖的伪随机数序列，使测试完全可重现且不依赖随机碰运气。
function createMockRandom(seed = 123456789) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("selectFairRandomTracks", () => {
  it("throws EMPTY_CANDIDATES when all member candidate track lists are empty", () => {
    const members: CandidateMember[] = [
      { memberId: "m1", nickname: "Alice", tracks: [] },
      { memberId: "m2", nickname: "Bob", tracks: [] }
    ];

    expect(() => {
      selectFairRandomTracks({
        targetCount: 10,
        publicSongIds: ["s1", "s2"],
        members
      });
    }).toThrowError(expect.objectContaining({
      status: 422,
      code: "EMPTY_CANDIDATES"
    }));
  });

  it("filters out members with empty tracks, keeping only members with candidates", () => {
    const members: CandidateMember[] = [
      { memberId: "m1", nickname: "Alice", tracks: [] },
      {
        memberId: "m2",
        nickname: "Bob",
        tracks: [
          { id: "s1", name: "Song 1", artists: ["A"], album: "Album" },
          { id: "s2", name: "Song 2", artists: ["A"], album: "Album" }
        ]
      }
    ];

    const result = selectFairRandomTracks(
      {
        targetCount: 5,
        publicSongIds: [],
        members
      },
      createMockRandom(42)
    );

    expect(result.actualCount).toBe(2);
    expect(result.memberContributions).toEqual([
      { memberId: "m1", nickname: "Alice", count: 0 },
      { memberId: "m2", nickname: "Bob", count: 2 }
    ]);
  });

  it("succeeds and selects tracks when all candidate tracks already exist in public playlist (no NO_NEW_SONGS requirement)", () => {
    const members: CandidateMember[] = [
      {
        memberId: "m1",
        nickname: "Alice",
        tracks: [
          { id: "s1", name: "Song 1", artists: ["A1"], album: "Album 1" },
          { id: "s2", name: "Song 2", artists: ["A1"], album: "Album 1" }
        ]
      },
      {
        memberId: "m2",
        nickname: "Bob",
        tracks: [
          { id: "s3", name: "Song 3", artists: ["A2"], album: "Album 2" },
          { id: "s4", name: "Song 4", artists: ["A2"], album: "Album 2" }
        ]
      }
    ];

    const result = selectFairRandomTracks(
      {
        targetCount: 10,
        publicSongIds: ["s1", "s2", "s3", "s4"],
        members
      },
      createMockRandom(42)
    );

    expect(result.actualCount).toBe(4);
    expect(result.tracks).toHaveLength(4);
    // Every selected track is marked isNew: false since all are already in public playlist
    expect(result.tracks.every(t => !t.isNew)).toBe(true);
    expect(result.memberContributions).toEqual(expect.arrayContaining([
      { memberId: "m1", nickname: "Alice", count: 2 },
      { memberId: "m2", nickname: "Bob", count: 2 }
    ]));
  });

  it("does not prioritize new songs over old songs within a member's candidates", () => {
    // Member has 2 old songs and 2 new songs.
    // We pick a seed where the shuffled order of candidate songs puts old songs first.
    // Target count is 2. The algorithm must select the first 2 without forcing new songs.
    const member: CandidateMember = {
      memberId: "m1",
      nickname: "Alice",
      tracks: [
        { id: "old1", name: "Old 1", artists: ["A"], album: "Album" },
        { id: "old2", name: "Old 2", artists: ["A"], album: "Album" },
        { id: "new1", name: "New 1", artists: ["A"], album: "Album" },
        { id: "new2", name: "New 2", artists: ["A"], album: "Album" }
      ]
    };

    // Constant mock random that keeps array order unchanged during Fisher-Yates
    // (returns 0.9999 so j = i, i.e., elements stay in initial track order [old1, old2, new1, new2])
    const noSwapRandom = () => 0.999999;

    const result = selectFairRandomTracks(
      {
        targetCount: 2,
        publicSongIds: ["old1", "old2"],
        members: [member]
      },
      noSwapRandom
    );

    expect(result.actualCount).toBe(2);
    // Both selected tracks should be old songs because new songs are not prioritized
    expect(result.tracks.map(t => t.songId)).toEqual(["old1", "old2"]);
    expect(result.tracks.every(t => !t.isNew)).toBe(true);
  });

  it("fairly distributes overlapping candidates non-greedily with controlled PRNG (A={X}, B={X, Y} -> A=X, B=Y)", () => {
    const memberA: CandidateMember = {
      memberId: "mA",
      nickname: "Alice",
      tracks: [
        { id: "X", name: "Song X", artists: ["A1"], album: "Album 1" }
      ]
    };
    const memberB: CandidateMember = {
      memberId: "mB",
      nickname: "Bob",
      tracks: [
        { id: "X", name: "Song X", artists: ["A1"], album: "Album 1" },
        { id: "Y", name: "Song Y", artists: ["A2"], album: "Album 2" }
      ]
    };

    // Even if random sequence tries B before A, A must get X and B must get Y
    const result = selectFairRandomTracks(
      {
        targetCount: 5,
        publicSongIds: [],
        members: [memberA, memberB]
      },
      createMockRandom(100)
    );

    expect(result.actualCount).toBe(2);
    expect(result.tracks).toHaveLength(2);

    const trackForA = result.tracks.find(t => t.sourceMemberId === "mA");
    const trackForB = result.tracks.find(t => t.sourceMemberId === "mB");

    expect(trackForA).toBeDefined();
    expect(trackForA!.songId).toBe("X");

    expect(trackForB).toBeDefined();
    expect(trackForB!.songId).toBe("Y");

    expect(result.memberContributions).toEqual(expect.arrayContaining([
      { memberId: "mA", nickname: "Alice", count: 1 },
      { memberId: "mB", nickname: "Bob", count: 1 }
    ]));
  });

  it("fairly divides target count among members with remainder using controlled PRNG (4 members, 10 tracks -> 3, 3, 2, 2)", () => {
    const makeMember = (id: string, name: string): CandidateMember => ({
      memberId: id,
      nickname: name,
      tracks: Array.from({ length: 10 }, (_, i) => ({
        id: `${id}_s${i}`,
        name: `Song ${id} ${i}`,
        artists: ["Artist"],
        album: "Album"
      }))
    });

    const members = [
      makeMember("m1", "Alice"),
      makeMember("m2", "Bob"),
      makeMember("m3", "Charlie"),
      makeMember("m4", "Dave")
    ];

    const result = selectFairRandomTracks(
      {
        targetCount: 10,
        publicSongIds: [],
        members
      },
      createMockRandom(999)
    );

    expect(result.actualCount).toBe(10);
    const counts = result.memberContributions.map(c => c.count).sort((a, b) => b - a);
    expect(counts).toEqual([3, 3, 2, 2]);
  });

  it("fairly selects members when member count exceeds target count using controlled PRNG (15 members, target 5 -> 5 get 1, 10 get 0)", () => {
    const members: CandidateMember[] = Array.from({ length: 15 }, (_, i) => ({
      memberId: `m${i}`,
      nickname: `Member ${i}`,
      tracks: [
        { id: `s_${i}`, name: `Song ${i}`, artists: ["A"], album: "Album" }
      ]
    }));

    const result = selectFairRandomTracks(
      {
        targetCount: 5,
        publicSongIds: [],
        members
      },
      createMockRandom(777)
    );

    expect(result.actualCount).toBe(5);
    const counts = result.memberContributions.map(c => c.count);
    const ones = counts.filter(c => c === 1).length;
    const zeros = counts.filter(c => c === 0).length;
    expect(ones).toBe(5);
    expect(zeros).toBe(10);
  });

  it("redistributes remaining quota when a member has fewer candidates than quota", () => {
    // Member A only has 1 track.
    // Member B has 10 tracks.
    // Target count 5.
    // A gets 1, B gets 4. Total = 5.
    const memberA: CandidateMember = {
      memberId: "mA",
      nickname: "Alice",
      tracks: [
        { id: "A1", name: "A 1", artists: ["A"], album: "Album" }
      ]
    };
    const memberB: CandidateMember = {
      memberId: "mB",
      nickname: "Bob",
      tracks: Array.from({ length: 10 }, (_, i) => ({
        id: `B${i}`,
        name: `B ${i}`,
        artists: ["B"],
        album: "Album"
      }))
    };

    const result = selectFairRandomTracks(
      {
        targetCount: 5,
        publicSongIds: [],
        members: [memberA, memberB]
      },
      createMockRandom(123)
    );

    expect(result.actualCount).toBe(5);
    const contribA = result.memberContributions.find(c => c.memberId === "mA")!;
    const contribB = result.memberContributions.find(c => c.memberId === "mB")!;
    expect(contribA.count).toBe(1);
    expect(contribB.count).toBe(4);
  });

  it("returns actual count when total unique candidates is less than target count", () => {
    const memberA: CandidateMember = {
      memberId: "mA",
      nickname: "Alice",
      tracks: [
        { id: "s1", name: "Song 1", artists: ["A"], album: "Album" }
      ]
    };
    const memberB: CandidateMember = {
      memberId: "mB",
      nickname: "Bob",
      tracks: [
        { id: "s2", name: "Song 2", artists: ["B"], album: "Album" }
      ]
    };

    // Target is 10, but only 2 unique songs exist.
    const result = selectFairRandomTracks(
      {
        targetCount: 10,
        publicSongIds: [],
        members: [memberA, memberB]
      },
      createMockRandom(555)
    );

    expect(result.actualCount).toBe(2);
    expect(result.totalUniqueCandidates).toBe(2);
    expect(result.tracks).toHaveLength(2);
  });

  it("shuffles the entire selected track set across members without forcing member interleaving", () => {
    // 2 members with 5 songs each, target 10.
    const memberA: CandidateMember = {
      memberId: "mA",
      nickname: "Alice",
      tracks: Array.from({ length: 5 }, (_, i) => ({
        id: `A_${i}`,
        name: `Song A ${i}`,
        artists: ["Artist A"],
        album: "Album A"
      }))
    };
    const memberB: CandidateMember = {
      memberId: "mB",
      nickname: "Bob",
      tracks: Array.from({ length: 5 }, (_, i) => ({
        id: `B_${i}`,
        name: `Song B ${i}`,
        artists: ["Artist B"],
        album: "Album B"
      }))
    };

    // Use a controlled PRNG
    const result = selectFairRandomTracks(
      {
        targetCount: 10,
        publicSongIds: [],
        members: [memberA, memberB]
      },
      createMockRandom(42)
    );

    expect(result.actualCount).toBe(10);
    expect(result.tracks).toHaveLength(10);

    // Verify all 10 tracks retain their accurate source attribution
    for (const track of result.tracks) {
      if (track.songId.startsWith("A_")) {
        expect(track.sourceMemberId).toBe("mA");
        expect(track.sourceMemberNickname).toBe("Alice");
      } else {
        expect(track.sourceMemberId).toBe("mB");
        expect(track.sourceMemberNickname).toBe("Bob");
      }
    }

    // Verify whole-set shuffle allows same-member tracks to appear adjacent
    const memberSequence = result.tracks.map(t => t.sourceMemberId);
    let hasAdjacentSameMember = false;
    for (let i = 0; i < memberSequence.length - 1; i++) {
      if (memberSequence[i] === memberSequence[i + 1]) {
        hasAdjacentSameMember = true;
        break;
      }
    }
    expect(hasAdjacentSameMember).toBe(true);

    // Verify the sequence is not simply all A's then all B's (it is shuffled)
    const allAThenB = memberSequence.slice(0, 5).every(m => m === "mA") && memberSequence.slice(5).every(m => m === "mB");
    expect(allAThenB).toBe(false);
  });

  it("produces deterministic selection and whole-set shuffle results given identical controlled pseudo-random generator", () => {
    const members: CandidateMember[] = Array.from({ length: 4 }, (_, mIdx) => ({
      memberId: `m${mIdx}`,
      nickname: `Member ${mIdx}`,
      tracks: Array.from({ length: 10 }, (_, sIdx) => ({
        id: `s_${mIdx}_${sIdx}`,
        name: `Song ${mIdx}-${sIdx}`,
        artists: ["Artist"],
        album: "Album"
      }))
    }));

    const run1 = selectFairRandomTracks(
      { targetCount: 10, publicSongIds: [], members },
      createMockRandom(42)
    );
    const run2 = selectFairRandomTracks(
      { targetCount: 10, publicSongIds: [], members },
      createMockRandom(42)
    );

    expect(run1.actualCount).toBe(10);
    expect(run1.tracks.map(t => t.songId)).toEqual(run2.tracks.map(t => t.songId));
    expect(run1.tracks.map(t => t.sourceMemberId)).toEqual(run2.tracks.map(t => t.sourceMemberId));

    // A different seed produces a different shuffle
    const run3 = selectFairRandomTracks(
      { targetCount: 10, publicSongIds: [], members },
      createMockRandom(99999)
    );
    expect(run1.tracks.map(t => t.songId)).not.toEqual(run3.tracks.map(t => t.songId));
  });
});
