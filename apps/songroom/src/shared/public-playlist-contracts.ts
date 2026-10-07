import { z } from "zod";
import { adapterErrorCodeSchema } from "../netease/protocol.js";
import { commandKey, uuidv7 } from "./contracts.js";

export const publicPlaylistCreateCommand = commandKey;
export const publicPlaylistTrack = z.strictObject({
  position: z.number().int().nonnegative(),
  songId: z.string().min(1),
  name: z.string(),
  artists: z.array(z.string()),
  album: z.string()
});
export type PublicPlaylistTrack = z.infer<typeof publicPlaylistTrack>;

export const publicPlaylistSnapshot = z.strictObject({
  version: z.number().int().nonnegative(),
  syncedAt: z.number().int().positive().nullable(),
  trackCount: z.number().int().nonnegative(),
  tracks: z.array(publicPlaylistTrack)
});
export type PublicPlaylistSnapshot = z.infer<typeof publicPlaylistSnapshot>;

export const publicPlaylistOperation = z.strictObject({
  id: uuidv7,
  errorCode: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED")]).nullable(),
  status: z.enum(["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"])
});

export const publicPlaylistAction = z.enum(["createPublicPlaylist", "refreshPublicPlaylist"]);
export type PublicPlaylistAction = z.infer<typeof publicPlaylistAction>;

export const publicPlaylistView = z.strictObject({
  playlist: z.strictObject({ id: z.string().min(1), name: z.string() }).nullable(),
  snapshot: publicPlaylistSnapshot.nullable().optional(),
  lastRefreshError: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED")]).nullable().optional(),
  operation: publicPlaylistOperation.nullable(),
  allowedActions: z.array(publicPlaylistAction),
  disabledReason: z.enum(["OWNER_ONLY", "NETEASE_AUTH_REQUIRED", "PUBLIC_PLAYLIST_EXISTS", "OPERATION_PENDING", "UPSTREAM_QUEUE_FULL", "ACCOUNT_PAUSED", "TARGET_BLOCKED"]).nullable(),
  version: z.number().int().positive()
});
export type PublicPlaylistView = z.infer<typeof publicPlaylistView>;
export type PublicPlaylistCreateCommand = z.infer<typeof publicPlaylistCreateCommand>;
