import { describe, expect, it } from "vitest";
import { BusinessError } from "../shared/errors.js";
import { selectFairRandomTracks, type CandidateMember } from "./random-selector.js";

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

  it("throws NO_NEW_SONGS when all candidate tracks already exist in public playlist", () => {
    const members: CandidateMember[] = [
      {
        memberId: "m1",
        nickname: "Alice",
        tracks: [
          { id: "s1", name: "Song 1", artists: ["A1"], album: "Album 1" }
        ]
      },
      {
        memberId: "m2",
        nickname: "Bob",
        tracks: [
          { id: "s2", name: "Song 2", artists: ["A2"], album: "Album 2" }
        ]
      }
    ];

    expect(() => {
      selectFairRandomTracks({
        targetCount: 10,
        publicSongIds: ["s1", "s2"],
        members
      });
    }).toThrowError(expect.objectContaining({
      status: 409,
      code: "NO_NEW_SONGS"
    }));
  });

  it("fairly distributes overlapping candidates non-greedily (A={X}, B={X, Y} -> A=X, B=Y)", () => {
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
    const result = selectFairRandomTracks({
      targetCount: 5,
      publicSongIds: [],
      members: [memberA, memberB]
    });

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

  it("fairly divides target count among members with remainder (4 members, 10 tracks -> 3, 3, 2, 2)", () => {
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

    const result = selectFairRandomTracks({
      targetCount: 10,
      publicSongIds: [],
      members
    });

    expect(result.actualCount).toBe(10);
    const counts = result.memberContributions.map(c => c.count).sort((a, b) => b - a);
    expect(counts).toEqual([3, 3, 2, 2]);
  });

  it("fairly selects members when member count exceeds target count (15 members, target 5 -> 5 get 1, 10 get 0)", () => {
    const members: CandidateMember[] = Array.from({ length: 15 }, (_, i) => ({
      memberId: `m${i}`,
      nickname: `Member ${i}`,
      tracks: [
        { id: `s_${i}`, name: `Song ${i}`, artists: ["A"], album: "Album" }
      ]
    }));

    const result = selectFairRandomTracks({
      targetCount: 5,
      publicSongIds: [],
      members
    });

    expect(result.actualCount).toBe(5);
    const counts = result.memberContributions.map(c => c.count);
    const ones = counts.filter(c => c === 1).length;
    const zeros = counts.filter(c => c === 0).length;
    expect(ones).toBe(5);
    expect(zeros).toBe(10);
  });

  it("prioritizes new songs within each member's quota and fills remainder with old songs", () => {
    const member: CandidateMember = {
      memberId: "m1",
      nickname: "Alice",
      tracks: [
        { id: "new1", name: "New 1", artists: ["A"], album: "Album" },
        { id: "new2", name: "New 2", artists: ["A"], album: "Album" },
        { id: "old1", name: "Old 1", artists: ["A"], album: "Album" },
        { id: "old2", name: "Old 2", artists: ["A"], album: "Album" },
        { id: "old3", name: "Old 3", artists: ["A"], album: "Album" }
      ]
    };

    // Public has old1, old2, old3
    const result = selectFairRandomTracks({
      targetCount: 5, // target is 5, but member only has 5 songs total
      publicSongIds: ["old1", "old2", "old3"],
      members: [member]
    });

    expect(result.actualCount).toBe(5);
    const newCount = result.tracks.filter(t => t.isNew).length;
    const oldCount = result.tracks.filter(t => !t.isNew).length;
    expect(newCount).toBe(2);
    expect(oldCount).toBe(3);
  });

  it("guarantees at least one new song when candidates have new songs, without degrading fairness", () => {
    // 6 members, target 5.
    // First 5 members only have old songs. Member 6 has a new song.
    // The selection must adjust so Member 6 gets 1 song and results in at least 1 new song.
    const oldOnlyMembers: CandidateMember[] = Array.from({ length: 5 }, (_, i) => ({
      memberId: `old_m${i}`,
      nickname: `OldMember ${i}`,
      tracks: [
        { id: `old_song_${i}`, name: `Old Song ${i}`, artists: ["A"], album: "Album" }
      ]
    }));

    const newMember: CandidateMember = {
      memberId: "new_m",
      nickname: "NewMember",
      tracks: [
        { id: "brand_new_song", name: "New Song", artists: ["A"], album: "Album" }
      ]
    };

    const publicSongIds = oldOnlyMembers.map(m => m.tracks[0].id);

    // Use a fixed random function that puts newMember last
    const members = [...oldOnlyMembers, newMember];
    const result = selectFairRandomTracks({
      targetCount: 5,
      publicSongIds,
      members
    });

    expect(result.actualCount).toBe(5);
    expect(result.tracks.some(t => t.isNew)).toBe(true);
    expect(result.tracks.some(t => t.songId === "brand_new_song")).toBe(true);
    const counts = result.memberContributions.map(c => c.count).sort((a, b) => b - a);
    expect(counts).toEqual([1, 1, 1, 1, 1, 0]);
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

    const result = selectFairRandomTracks({
      targetCount: 5,
      publicSongIds: [],
      members: [memberA, memberB]
    });

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
    const result = selectFairRandomTracks({
      targetCount: 10,
      publicSongIds: [],
      members: [memberA, memberB]
    });

    expect(result.actualCount).toBe(2);
    expect(result.totalUniqueCandidates).toBe(2);
    expect(result.tracks).toHaveLength(2);
  });

  it("produces deterministic selection results given a controlled pseudo-random generator", () => {
    function createMockRandom(seed = 123456789) {
      let s = seed;
      return () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
      };
    }

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
  });
});
