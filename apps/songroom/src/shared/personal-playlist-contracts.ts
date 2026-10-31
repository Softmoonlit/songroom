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
  "refreshPersonalPlaylist"
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

export const favoritePlaylistCandidate = z.strictObject({
  sourceType: z.enum(["liked", "created", "favorite"]),
  id: z.string().min(1),
  name: z.string(),
  coverImgUrl: z.string().nullable().optional(),
  trackCount: z.number().int().nonnegative(),
  creatorNickname: z.string().nullable().optional()
});
export type FavoritePlaylistCandidate = z.infer<typeof favoritePlaylistCandidate>;

export const favoritePlaylistCandidatesView = z.strictObject({
  candidates: z.array(favoritePlaylistCandidate),
  version: z.number().int().positive()
});
export type FavoritePlaylistCandidatesView = z.infer<typeof favoritePlaylistCandidatesView>;

export const bindPersonalPlaylistCommand = z.strictObject({
  playlistId: z.string().min(1),
  idempotencyKey: uuidv7.optional()
});
export type BindPersonalPlaylistCommand = z.infer<typeof bindPersonalPlaylistCommand>;

export const assignPersonalPlaylistCommand = bindPersonalPlaylistCommand;
export type AssignPersonalPlaylistCommand = BindPersonalPlaylistCommand;

export const personalPlaylistView = z.strictObject({
  playlist: z.strictObject({
    id: z.string().min(1),
    name: z.string()
  }).nullable(),
  operation: personalPlaylistOperation.nullable().optional(),
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
