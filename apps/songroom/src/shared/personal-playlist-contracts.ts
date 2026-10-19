import { z } from "zod";
import { adapterErrorCodeSchema } from "../netease/protocol.js";
import { uuidv7 } from "./contracts.js";

export const personalPlaylistTrack = z.strictObject({
  position: z.number().int().nonnegative(),
  songId: z.string().min(1),
  name: z.string(),
  artists: z.array(z.string()),
  album: z.string()
});
export type PersonalPlaylistTrack = z.infer<typeof personalPlaylistTrack>;

export const personalPlaylistSnapshot = z.strictObject({
  version: z.number().int().nonnegative(),
  syncedAt: z.number().int().positive().nullable(),
  trackCount: z.number().int().nonnegative(),
  tracks: z.array(personalPlaylistTrack)
});
export type PersonalPlaylistSnapshot = z.infer<typeof personalPlaylistSnapshot>;

export const personalPlaylistAction = z.enum([
  "refreshPersonalPlaylist",
  "createPersonalPlaylist",
  "removePersonalSong"
]);
export type PersonalPlaylistAction = z.infer<typeof personalPlaylistAction>;

export const personalPlaylistOperation = z.strictObject({
  id: uuidv7,
  errorCode: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED")]).nullable(),
  status: z.enum(["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"]),
  step: z.enum(["ready", "verified", "sending", "confirming", "succeeded", "rejected", "unknown", "stopped"]).nullable().optional(),
  playlistId: z.string().nullable().optional(),
  recovered: z.boolean().optional(),
  version: z.number().int().positive()
});
export type PersonalPlaylistOperation = z.infer<typeof personalPlaylistOperation>;

export const personalSongOperationView = z.strictObject({
  id: uuidv7,
  action: z.enum(["add", "remove"]),
  roomId: uuidv7,
  songId: z.string().min(1),
  name: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string(),
  status: z.enum(["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"]),
  songConfirmed: z.boolean(),
  errorCode: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED"), z.literal("CONCURRENT_OPERATION_LIMIT_EXCEEDED")]).nullable(),
  step: z.enum(["ready", "verified", "prepared", "sending", "confirming", "succeeded", "rejected", "unknown", "stopped"]),
  version: z.number().int().positive()
});
export type PersonalSongOperationView = z.infer<typeof personalSongOperationView>;


export const personalPlaylistView = z.strictObject({
  playlist: z.strictObject({
    id: z.string().min(1),
    name: z.string()
  }).nullable(),
  operation: personalPlaylistOperation.nullable().optional(),
  songOperation: personalSongOperationView.nullable().optional(),
  snapshot: personalPlaylistSnapshot.nullable().optional(),
  lastRefreshError: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED")]).nullable().optional(),
  allowedActions: z.array(personalPlaylistAction),
  disabledReason: z.enum([
    "NETEASE_AUTH_REQUIRED",
    "ACCOUNT_PAUSED",
    "TARGET_BLOCKED",
    "PERSONAL_PLAYLIST_EXISTS",
    "OPERATION_PENDING"
  ]).nullable(),
  version: z.number().int().positive()
});
export type PersonalPlaylistView = z.infer<typeof personalPlaylistView>;

export const personalPlaylistCreateCommand = z.strictObject({
  idempotencyKey: uuidv7
});
export type PersonalPlaylistCreateCommand = z.infer<typeof personalPlaylistCreateCommand>;

export const personalSongAddCommand = z.strictObject({
  idempotencyKey: uuidv7,
  songId: z.string().min(1),
  name: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string()
});
export type PersonalSongAddCommand = z.infer<typeof personalSongAddCommand>;

export const personalSongMutationResponse = z.strictObject({
  replay: z.boolean(),
  operation: personalSongOperationView
});
export type PersonalSongMutationResponse = z.infer<typeof personalSongMutationResponse>;

export const personalSongRemoveCommand = z.strictObject({
  idempotencyKey: uuidv7,
  songId: z.string().min(1)
});
export type PersonalSongRemoveCommand = z.infer<typeof personalSongRemoveCommand>;
