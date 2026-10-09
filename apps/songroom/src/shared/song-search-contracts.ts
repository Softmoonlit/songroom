import { z } from "zod";
import { adapterErrorCodeSchema } from "../netease/protocol.js";
import { normalizedText, uuidv7 } from "./contracts.js";

export const songCandidate = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string()
});
export type SongCandidate = z.infer<typeof songCandidate>;

export const searchText = normalizedText(200);

export const searchCommand = z.strictObject({
  query: searchText
});
export type SearchCommand = z.infer<typeof searchCommand>;

export const searchInitiatedResponse = z.strictObject({
  searchId: uuidv7
});
export type SearchInitiatedResponse = z.infer<typeof searchInitiatedResponse>;

export const searchStatus = z.enum(["searching", "completed", "failed"]);
export type SearchStatus = z.infer<typeof searchStatus>;

export const searchErrorCode = z.union([
  adapterErrorCodeSchema,
  z.enum(["ACCOUNT_PAUSED", "UPSTREAM_QUEUE_FULL", "APP_DRAINING", "ROOM_UNAVAILABLE", "NETEASE_AUTH_REQUIRED", "AUTHORIZATION_CHANGED", "PUBLIC_PLAYLIST_NOT_FOUND", "PUBLIC_PLAYLIST_CHANGED"])
]);

export const searchView = z.strictObject({
  searchId: uuidv7,
  status: searchStatus,
  songs: z.array(songCandidate),
  hasMore: z.boolean(),
  errorCode: searchErrorCode.nullable()
});
export type SearchView = z.infer<typeof searchView>;
