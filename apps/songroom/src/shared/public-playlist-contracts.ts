import { z } from "zod";
import { adapterErrorCodeSchema } from "../netease/protocol.js";
import { commandKey, uuidv7 } from "./contracts.js";

export const publicPlaylistCreateCommand = commandKey;
export const publicPlaylistOperation = z.strictObject({
  id: uuidv7,
  errorCode: z.union([adapterErrorCodeSchema, z.literal("ACCOUNT_PAUSED")]).nullable(),
  status: z.enum(["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"])
});
export const publicPlaylistView = z.strictObject({
  playlist: z.strictObject({ id: z.string().min(1), name: z.string() }).nullable(),
  operation: publicPlaylistOperation.nullable(),
  allowedActions: z.array(z.literal("createPublicPlaylist")),
  disabledReason: z.enum(["OWNER_ONLY", "NETEASE_AUTH_REQUIRED", "PUBLIC_PLAYLIST_EXISTS", "OPERATION_PENDING", "UPSTREAM_QUEUE_FULL", "ACCOUNT_PAUSED", "TARGET_BLOCKED"]).nullable(),
  version: z.number().int().positive()
});
export type PublicPlaylistView = z.infer<typeof publicPlaylistView>;
export type PublicPlaylistCreateCommand = z.infer<typeof publicPlaylistCreateCommand>;
