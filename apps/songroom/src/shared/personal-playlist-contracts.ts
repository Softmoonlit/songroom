import { z } from "zod";
import { adapterErrorCodeSchema } from "../netease/protocol.js";
import { uuidv7 } from "./contracts.js";

export const personalPlaylistBindingType = z.enum(["ownerCreated", "ownerSubscribed"]);
export type PersonalPlaylistBindingType = z.infer<typeof personalPlaylistBindingType>;

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
  "bindPersonalPlaylist",
  "unbindPersonalPlaylist",
  "refreshPersonalPlaylist"
]);
export type PersonalPlaylistAction = z.infer<typeof personalPlaylistAction>;

export const personalPlaylistView = z.strictObject({
  playlist: z.strictObject({
    id: z.string().min(1),
    name: z.string(),
    type: personalPlaylistBindingType,
    writeable: z.boolean()
  }).nullable(),
  snapshot: personalPlaylistSnapshot.nullable().optional(),
  lastRefreshError: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED")]).nullable().optional(),
  allowedActions: z.array(personalPlaylistAction),
  disabledReason: z.enum(["NOT_OWNER", "NETEASE_AUTH_REQUIRED", "ACCOUNT_PAUSED", "TARGET_BLOCKED"]).nullable(),
  version: z.number().int().positive()
});
export type PersonalPlaylistView = z.infer<typeof personalPlaylistView>;

export const personalPlaylistCandidate = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  type: z.enum(["ownerCreated", "ownerSubscribed"]),
  writeable: z.boolean()
});
export type PersonalPlaylistCandidate = z.infer<typeof personalPlaylistCandidate>;

export const personalPlaylistCandidatesView = z.strictObject({
  candidates: z.array(personalPlaylistCandidate),
  allowedActions: z.array(z.literal("bindPersonalPlaylist")),
  disabledReason: z.enum(["NOT_OWNER", "NETEASE_AUTH_REQUIRED", "ACCOUNT_PAUSED"]).nullable()
});
export type PersonalPlaylistCandidatesView = z.infer<typeof personalPlaylistCandidatesView>;

export const personalPlaylistBindCommand = z.strictObject({
  idempotencyKey: uuidv7,
  playlistId: z.string().min(1)
});
export type PersonalPlaylistBindCommand = z.infer<typeof personalPlaylistBindCommand>;

export const personalPlaylistUnbindCommand = z.strictObject({
  idempotencyKey: uuidv7
});
export type PersonalPlaylistUnbindCommand = z.infer<typeof personalPlaylistUnbindCommand>;
