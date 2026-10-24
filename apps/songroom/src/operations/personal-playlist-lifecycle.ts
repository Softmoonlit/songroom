import { and, eq, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt, operation, personalPlaylistBinding, personalPlaylistCreation, personalSongMutation, playlistSnapshot, playlistTrack, publicPlaylistBinding } from "../db/schema.js";

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

  const creations = tx.select({ opId: operation.id, userId: operation.userId }).from(operation)
    .innerJoin(personalPlaylistCreation, eq(personalPlaylistCreation.operationId, operation.id))
    .where(and(eq(operation.roomId, roomId), eq(operation.kind, "createPersonalPlaylist"),
      memberId ? eq(personalPlaylistCreation.memberId, memberId) : undefined)).all();
  for (const { opId, userId } of creations) {
    tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, userId), eq(commandReceipt.resourceId, opId))).run();
    tx.delete(personalPlaylistCreation).where(eq(personalPlaylistCreation.operationId, opId)).run();
    tx.delete(operation).where(eq(operation.id, opId)).run();
  }

  const mutations = tx.select({ opId: operation.id, userId: operation.userId }).from(operation)
    .innerJoin(personalSongMutation, eq(personalSongMutation.operationId, operation.id))
    .where(and(eq(operation.roomId, roomId), sql`${operation.kind} IN ('addPersonalSong', 'removePersonalSong')`,
      memberId ? eq(personalSongMutation.memberId, memberId) : undefined)).all();
  for (const { opId, userId } of mutations) {
    tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, userId), eq(commandReceipt.resourceId, opId))).run();
    tx.delete(personalSongMutation).where(eq(personalSongMutation.operationId, opId)).run();
    tx.delete(operation).where(eq(operation.id, opId)).run();
  }
}

/** Pending personal writes also block requests that read that playlist as their source. */
export function hasPersonalSongWrite(database: AppDatabase, accountId: string, playlistId: string, exceptOperationId?: string): boolean {
  return Boolean(database.select({ id: operation.id }).from(operation)
    .innerJoin(personalSongMutation, eq(personalSongMutation.operationId, operation.id))
    .where(and(eq(operation.accountId, accountId), eq(personalSongMutation.playlistId, playlistId),
      sql`${operation.status} NOT IN ('succeeded', 'failed', 'stopped')`,
      exceptOperationId ? sql`${operation.id} != ${exceptOperationId}` : undefined)).get());
}
