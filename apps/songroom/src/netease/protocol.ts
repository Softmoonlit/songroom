import { z } from "zod";

const id = z.string().min(1).max(256);
const cookie = z.string().min(1).max(32768);
const key = z.string().min(1).max(1024);
const deviceId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional();

export const adapterInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ deviceId, operation: z.literal("qrKey") }),
  z.strictObject({ deviceId, operation: z.literal("qrCreate"), key }),
  z.strictObject({ deviceId, operation: z.literal("qrCheck"), key }),
  z.strictObject({ deviceId, operation: z.literal("identity"), cookie, expectedAccountId: id.optional() }),
  z.strictObject({ deviceId, operation: z.literal("search"), cookie, query: z.string().min(1).max(400) }),
  z.strictObject({ deviceId, operation: z.literal("userPlaylists"), cookie, accountId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(1000) }),
  z.strictObject({ deviceId, operation: z.literal("playlistDetail"), cookie, playlistId: id }),
  z.strictObject({ deviceId, operation: z.literal("songDetail"), cookie, songIds: z.array(id).min(1).max(1000) }),
  z.strictObject({ deviceId, operation: z.literal("playlistCreate"), cookie, name: z.string().min(1).max(100) }),
  z.strictObject({ deviceId, operation: z.literal("playlistDelete"), cookie, playlistId: id }),
  z.strictObject({ deviceId, operation: z.literal("trackAdd"), cookie, playlistId: id, songId: id }),
  z.strictObject({ deviceId, operation: z.literal("trackRemove"), cookie, playlistId: id, songId: id })
]);
export type AdapterInput = z.infer<typeof adapterInputSchema>;
export type Operation = AdapterInput["operation"];
export const adapterErrorCodeSchema = z.enum([
  "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH", "AUTH_UNAVAILABLE", "TARGET_PERMISSION", "RATE_LIMITED",
  "NETWORK_ERROR", "MODULE_ERROR", "DEADLINE", "PROCESS_ERROR", "PARSE_ERROR", "INVALID_INPUT", "INTEGRITY_ERROR"
]);
export type AdapterErrorCode = z.infer<typeof adapterErrorCodeSchema>;
export const adapterErrorSchema = z.strictObject({
  code: adapterErrorCodeSchema,
  outcome: z.enum(["failed", "unknown"]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  businessCode: z.number().int().optional()
});
export type AdapterError = z.infer<typeof adapterErrorSchema>;

export const songSchema = z.strictObject({ id, name: z.string(), artists: z.array(z.string()), album: z.string() });
export const playlistSchema = z.strictObject({ id, name: z.string(), creatorId: id, subscribed: z.boolean(), status: z.number().int() });
export const outputSchemas = {
  qrKey: z.strictObject({ key }),
  qrCreate: z.strictObject({ url: z.string().startsWith("https://music.163.com/"), image: z.string().startsWith("data:image/png;base64,") }),
  qrCheck: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("waiting") }),
    z.strictObject({ status: z.literal("scanned") }),
    z.strictObject({ status: z.literal("expired") }),
    z.strictObject({ status: z.literal("authorized"), cookie })
  ]),
  identity: z.strictObject({ accountId: id, name: z.string() }),
  search: z.strictObject({ songs: z.array(songSchema).max(5) }),
  userPlaylists: z.strictObject({ playlists: z.array(playlistSchema), more: z.boolean() }),
  playlistDetail: z.strictObject({ playlist: playlistSchema, songIds: z.array(id), songs: z.array(songSchema) }),
  songDetail: z.strictObject({ songs: z.array(songSchema) }),
  playlistCreate: z.strictObject({ playlistId: id }),
  playlistDelete: z.strictObject({ acknowledged: z.literal(true) }),
  trackAdd: z.strictObject({ acknowledged: z.literal(true) }),
  trackRemove: z.strictObject({ acknowledged: z.literal(true) })
} satisfies Record<Operation, z.ZodType>;
export type OperationData<O extends Operation> = z.infer<(typeof outputSchemas)[O]>;
export type AdapterResult<O extends Operation = Operation> =
  | { ok: true; data: OperationData<O>; httpStatus?: number; businessCode?: number }
  | { ok: false; error: AdapterError };
export interface NeteaseAdapter {
  call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>>;
  assertVendorIntegrity(): Promise<void>;
  dispose(): Promise<void>;
}

export function resultSchema<O extends Operation>(operation: O) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data: outputSchemas[operation], httpStatus: z.number().int().min(100).max(599).optional(), businessCode: z.number().int().optional() }),
    z.strictObject({ ok: z.literal(false), error: adapterErrorSchema })
  ]);
}
export const workerInputSchema = z.strictObject({
  input: adapterInputSchema,
  cookie: z.string().max(32768),
  deviceId: z.string().min(1).max(256),
  requestTimeoutMs: z.number().int().min(1).max(15000)
});
export type WorkerInput = z.infer<typeof workerInputSchema>;
export function isWrite(operation: Operation): boolean {
  return ["playlistCreate", "playlistDelete", "trackAdd", "trackRemove"].includes(operation);
}
