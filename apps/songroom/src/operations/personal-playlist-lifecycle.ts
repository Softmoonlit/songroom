import { and, eq } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import { commandReceipt, operation, personalPlaylistBinding, personalPlaylistCreation, playlistSnapshot, playlistTrack, publicPlaylistBinding } from "../db/schema.js";

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
  ownerUserId: string,
  memberId: string | undefined,
  ensureCleanup: (accountId: string, playlistId: string, creationOperationId: string | null) => string,
  now: number
): string[] {
  const cleanupIds = new Set<string>();
  const bindings = tx.select().from(personalPlaylistBinding).where(and(
    eq(personalPlaylistBinding.roomId, roomId),
    memberId ? eq(personalPlaylistBinding.memberId, memberId) : undefined
  )).all();
  for (const binding of bindings) {
    cleanupIds.add(ensureCleanup(binding.accountId, binding.playlistId, binding.creationOperationId));
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

  const creations = tx.select({ op: operation, detail: personalPlaylistCreation }).from(operation)
    .innerJoin(personalPlaylistCreation, eq(personalPlaylistCreation.operationId, operation.id))
    .where(and(eq(operation.roomId, roomId), eq(operation.kind, "createPersonalPlaylist"),
      memberId ? eq(personalPlaylistCreation.memberId, memberId) : undefined)).all();
  for (const { op, detail } of creations) {
    tx.delete(commandReceipt).where(and(eq(commandReceipt.userId, op.userId), eq(commandReceipt.resourceId, op.id))).run();
    if (detail.playlistId && op.accountId) {
      cleanupIds.add(ensureCleanup(op.accountId, detail.playlistId, op.id));
    }
    if (!detail.playlistId && ["sending", "unknown"].includes(detail.step)) {
      // End the old membership's business identity while retaining the original resource owner.
      tx.update(personalPlaylistCreation).set({ ownerUserId, memberId: v7(), name: "songroom-cleanup",
        beforePlaylists: redactPlaylistEvidence(detail.beforePlaylists), afterPlaylists: redactPlaylistEvidence(detail.afterPlaylists) })
        .where(eq(personalPlaylistCreation.operationId, op.id)).run();
      // Detach the actor so a rejoined account can create for its new membership.
      tx.update(operation).set({ userId: v7(), status: "needsAdministrator", updatedAt: now,
        version: op.version + 1 }).where(eq(operation.id, op.id)).run();
    } else {
      tx.delete(operation).where(eq(operation.id, op.id)).run();
    }
  }
  return [...cleanupIds];
}
