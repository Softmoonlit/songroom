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
  kind: z.enum(["createPublicPlaylist", "requestPublicSong", "replacePublicPlaylist", "playNext"]).optional(),
  errorCode: z.union([adapterErrorCodeSchema, z.enum(["ACCOUNT_PAUSED", "PLAYBACK_CONFLICT", "PLAYLIST_CONFLICT", "PLAY_NEXT_NOOP", "CONCURRENT_OPERATION_LIMIT_EXCEEDED"])]).nullable(),
  status: z.enum(["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"]),
  step: z.enum(["ready", "verified", "sending", "confirming", "tagging", "succeeded", "rejected", "unknown", "stopped"]).nullable().optional(),
  playlistId: z.string().nullable().optional(),
  recovered: z.boolean().optional(),
  version: z.number().int().positive()
});

export const publicPlaylistAction = z.enum(["createPublicPlaylist", "refreshPublicPlaylist", "requestSong", "replacePublicPlaylist"]);
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
  sourcePlaylistId: z.string().min(1),
  songId: z.string().min(1),
  name: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string()
});
export type PublicSongRequestCommand = z.infer<typeof publicSongRequestCommand>;

export const songRequestOperationView = z.strictObject({
  id: uuidv7,
  roomId: uuidv7,
  sourcePlaylistId: z.string().min(1).nullable().optional(),
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

export const playNextErrorCode = z.union([adapterErrorCodeSchema, z.enum([
  "ACCOUNT_PAUSED", "PLAYBACK_CONFLICT", "PLAYLIST_CONFLICT", "PLAY_NEXT_NOOP"
])]);
export const playbackView = z.strictObject({
  songId: z.string().min(1).nullable(),
  checkedAt: z.number().int().positive().nullable(),
  errorCode: z.union([adapterErrorCodeSchema, z.enum(["ACCOUNT_PAUSED", "UPSTREAM_QUEUE_FULL"])]).nullable()
});
export type PlaybackView = z.infer<typeof playbackView>;
export const playNextCommand = z.strictObject({
  idempotencyKey: uuidv7,
  songId: z.string().min(1),
  anchorSongId: z.string().min(1),
  snapshotVersion: z.number().int().nonnegative()
});
export type PlayNextCommand = z.infer<typeof playNextCommand>;
export const playNextOperationView = z.strictObject({
  id: uuidv7,
  roomId: uuidv7,
  songId: z.string().min(1),
  anchorSongId: z.string().min(1),
  status: publicPlaylistOperation.shape.status,
  step: z.enum(["ready", "identityVerified", "playbackVerified", "verified", "sending", "confirming", "unknown", "succeeded", "rejected", "stopped"]),
  errorCode: playNextErrorCode.nullable(),
  version: z.number().int().positive()
});
export type PlayNextOperationView = z.infer<typeof playNextOperationView>;
export const playNextResponse = z.strictObject({ replay: z.boolean(), operation: playNextOperationView });
export type PlayNextResponse = z.infer<typeof playNextResponse>;

export const randomReplacementPreviewCommand = z.strictObject({
  count: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).default(10)
});
export type RandomReplacementPreviewCommand = z.infer<typeof randomReplacementPreviewCommand>;

export const randomPreviewTrack = z.strictObject({
  songId: z.string().min(1),
  name: z.string(),
  artists: z.array(z.string()),
  album: z.string(),
  sourceMemberId: uuidv7,
  sourceMemberNickname: z.string(),
  isNew: z.boolean()
});
export type RandomPreviewTrack = z.infer<typeof randomPreviewTrack>;

export const randomPreviewMemberContribution = z.strictObject({
  memberId: uuidv7,
  nickname: z.string(),
  count: z.number().int().nonnegative()
});
export type RandomPreviewMemberContribution = z.infer<typeof randomPreviewMemberContribution>;

export const randomReplacementPreviewView = z.strictObject({
  previewId: uuidv7,
  roomId: uuidv7,
  targetCount: z.number().int().positive(),
  actualCount: z.number().int().nonnegative(),
  tracks: z.array(randomPreviewTrack),
  memberContributions: z.array(randomPreviewMemberContribution),
  oldTrackCount: z.number().int().nonnegative(),
  oldTracksWithRequesterCount: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive()
});
export type RandomReplacementPreviewView = z.infer<typeof randomReplacementPreviewView>;

export const randomReplacementConfirmCommand = z.strictObject({
  idempotencyKey: uuidv7,
  previewId: uuidv7
});
export type RandomReplacementConfirmCommand = z.infer<typeof randomReplacementConfirmCommand>;

export const randomReplacementOperationView = z.strictObject({
  id: uuidv7,
  roomId: uuidv7,
  status: publicPlaylistOperation.shape.status,
  step: z.enum(["ready", "verified", "sending", "confirming", "tagging", "succeeded", "rejected", "unknown", "stopped"]),
  targetCount: z.number().int().nonnegative(),
  targetSongIds: z.array(z.string()),
  addedSongIds: z.array(z.string()),
  removedSongIds: z.array(z.string()),
  tagConfirmed: z.boolean(),
  currentAction: z.enum(["add", "remove"]).nullable().optional(),
  currentSongId: z.string().nullable().optional(),
  errorCode: z.union([adapterErrorCodeSchema, z.enum([
    "ACCOUNT_PAUSED", "PLAYLIST_CONFLICT", "CONCURRENT_OPERATION_LIMIT_EXCEEDED"
  ])]).nullable(),
  version: z.number().int().positive()
});
export type RandomReplacementOperationView = z.infer<typeof randomReplacementOperationView>;

export const randomReplacementResponse = z.strictObject({
  replay: z.boolean(),
  operation: randomReplacementOperationView
});
export type RandomReplacementResponse = z.infer<typeof randomReplacementResponse>;


