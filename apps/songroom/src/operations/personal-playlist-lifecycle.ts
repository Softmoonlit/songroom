import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { personalPlaylistBinding, playlistSnapshot, playlistTrack, publicPlaylistBinding } from "../db/schema.js";

type DatabaseTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/** Retain only exact target IDs needed to establish a creation's before/after difference. */
export function redactPlaylistEvidence(value: string | null): string | null {
  if (!value) return null;
  try {
    const playlists: unknown = JSON.parse(value);
    if (!Array.isArray(playlists) || !playlists.every(playlist => playlist !== null &&
      typeof playlist === "object" && typeof playlist.id === "string" && playlist.id.length > 0)) return null;
    return JSON.stringify(playlists.map(playlist => ({ id: playlist.id, name: "" })));
  } catch { return null; }
}

/** Capture owned cloud targets before member/room cascades discard their bindings. */
export function terminatePersonalPlaylistsInTx(
  tx: DatabaseTransaction,
  roomId: string,
  _ownerUserId: string,
  memberId: string | undefined,
  _now: number
): void {
  const bindings = tx.select().from(personalPlaylistBinding).where(and(
    eq(personalPlaylistBinding.roomId, roomId),
    memberId ? eq(personalPlaylistBinding.memberId, memberId) : undefined
  )).all();
  for (const binding of bindings) {
    tx.delete(personalPlaylistBinding).where(eq(personalPlaylistBinding.id, binding.id)).run();
    const target = and(eq(playlistSnapshot.accountId, binding.accountId), eq(playlistSnapshot.playlistId, binding.playlistId));
    const personalReference = tx.select({ id: personalPlaylistBinding.id }).from(personalPlaylistBinding).where(and(
      eq(personalPlaylistBinding.accountId, binding.accountId), eq(personalPlaylistBinding.playlistId, binding.playlistId)
    )).get();
    const publicReference = tx.select({ id: publicPlaylistBinding.roomId }).from(publicPlaylistBinding).where(and(
      eq(publicPlaylistBinding.accountId, binding.accountId), eq(publicPlaylistBinding.playlistId, binding.playlistId)
    )).get();
    if (!personalReference && !publicReference) {
      tx.delete(playlistTrack).where(and(eq(playlistTrack.accountId, binding.accountId), eq(playlistTrack.playlistId, binding.playlistId))).run();
      tx.delete(playlistSnapshot).where(target).run();
    }
  }
}

/** Pending personal writes also block requests that read that playlist as their source. */
export function hasPersonalSongWrite(_database: AppDatabase, _accountId: string, _playlistId: string, _exceptOperationId?: string): boolean {
  return false;
}
