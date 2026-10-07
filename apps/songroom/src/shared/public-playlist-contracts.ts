import { z } from "zod";
import { adapterErrorCodeSchema } from "../netease/protocol.js";
import { commandKey, uuidv7 } from "./contracts.js";

export const publicPlaylistCreateCommand = commandKey;
export const publicPlaylistTrack = z.strictObject({
  position: z.number().int().nonnegative(),
  songId: z.string().min(1),
  name: z.string(),
  artists: z.array(z.string()),
  album: z.string(),
  requesters: z.array(z.string())
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
  status: z.enum(["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"]),
  step: z.enum(["ready", "verified", "sending", "confirming", "succeeded", "rejected", "unknown", "stopped"]).nullable().optional(),
  playlistId: z.string().nullable().optional(),
  recovered: z.boolean().optional(),
  version: z.number().int().positive()
});

export const publicPlaylistAction = z.enum(["createPublicPlaylist", "refreshPublicPlaylist", "requestSong"]);
export type PublicPlaylistAction = z.infer<typeof publicPlaylistAction>;

export const publicPlaylistInvalidatedTarget = z.strictObject({
  playlistId: z.string().min(1),
  name: z.string(),
  checkedAt: z.number().int().positive(),
  status: z.literal("confirmedDeleted")
});
export type PublicPlaylistInvalidatedTarget = z.infer<typeof publicPlaylistInvalidatedTarget>;

export const publicPlaylistView = z.strictObject({
  playlist: z.strictObject({ id: z.string().min(1), name: z.string() }).nullable(),
  invalidatedTarget: publicPlaylistInvalidatedTarget.nullable().optional(),
  snapshot: publicPlaylistSnapshot.nullable().optional(),
  lastRefreshError: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED")]).nullable().optional(),
  operation: publicPlaylistOperation.nullable(),
  allowedActions: z.array(publicPlaylistAction),
  disabledReason: z.enum(["OWNER_ONLY", "NETEASE_AUTH_REQUIRED", "PUBLIC_PLAYLIST_EXISTS", "OPERATION_PENDING", "UPSTREAM_QUEUE_FULL", "ACCOUNT_PAUSED", "TARGET_BLOCKED"]).nullable(),
  version: z.number().int().positive()
});
export type PublicPlaylistView = z.infer<typeof publicPlaylistView>;
export type PublicPlaylistCreateCommand = z.infer<typeof publicPlaylistCreateCommand>;

export const publicSongRequestCommand = z.strictObject({
  idempotencyKey: uuidv7,
  songId: z.string().min(1),
  name: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string()
});
export type PublicSongRequestCommand = z.infer<typeof publicSongRequestCommand>;

export const songRequestOperationView = z.strictObject({
  id: uuidv7,
  roomId: uuidv7,
  songId: z.string().min(1),
  name: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string(),
  status: z.enum(["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"]),
  songConfirmed: z.boolean(),
  tagConfirmed: z.boolean(),
  errorCode: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED"), z.literal("CONCURRENT_OPERATION_LIMIT_EXCEEDED")]).nullable(),
  step: z.enum(["ready", "verified", "sending", "confirming", "tagging", "succeeded", "rejected", "unknown", "stopped"]),
  version: z.number().int().positive()
});
export type SongRequestOperationView = z.infer<typeof songRequestOperationView>;

export const songRequestResponse = z.strictObject({
  replay: z.boolean(),
  operation: songRequestOperationView
});
export type SongRequestResponse = z.infer<typeof songRequestResponse>;
