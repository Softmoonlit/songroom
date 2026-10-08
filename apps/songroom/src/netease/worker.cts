import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerInputSchema, resultSchema, isWrite, type WorkerInput, type AdapterResult, type Operation, type AdapterErrorCode } from "./protocol.js";

process.umask(0o077);
const vendorRoot = join(__dirname, "vendor");
let handled = false;
process.on("disconnect", () => process.exit(1));
process.on("message", async raw => {
  if (handled) { process.exit(1); return; }
  handled = true;
  const parsed = workerInputSchema.safeParse(raw);
  if (!parsed.success) { process.exit(1); return; }
  let result: AdapterResult;
  try { result = await invoke(parsed.data); }
  catch { result = error(parsed.data.input.operation, "MODULE_ERROR"); }
  const validated = resultSchema(parsed.data.input.operation).safeParse(result);
  const response = validated.success ? validated.data : error(parsed.data.input.operation, "PARSE_ERROR");
  if (!process.send) { process.exit(1); return; }
  process.send(response, undefined, undefined, () => { process.disconnect(); process.exit(0); });
});

function error(operation: Operation, code: AdapterErrorCode, raw?: any): AdapterResult {
  const status = raw?.httpStatus ?? raw?.status;
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const businessCode = Number.isInteger(raw?.body?.code) ? raw.body.code : undefined;
  const explicitRejection = ["AUTH_UNAVAILABLE", "TARGET_PERMISSION", "RATE_LIMITED", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH", "INVALID_INPUT"].includes(code);
  return { ok: false, error: { code, outcome: isWrite(operation) && !explicitRejection ? "unknown" : "failed", ...(httpStatus === undefined ? {} : { httpStatus }), ...(businessCode === undefined ? {} : { businessCode }) } };
}
function classify(operation: Operation, raw: any): AdapterResult {
  if (raw?.networkError) return error(operation, "NETWORK_ERROR", raw);
  if (raw?.parseError) return error(operation, "PARSE_ERROR", raw);
  const code = raw?.body?.code;
  const message = typeof raw?.body?.msg === "string" ? raw.body.msg : typeof raw?.body?.message === "string" ? raw.body.message : "";
  if ([405, 429].includes(code) || /频繁|风控|风险|操作太快|too many requests/i.test(message)) return error(operation, "RATE_LIMITED", raw);
  if ([301, 401].includes(code)) return error(operation, "AUTH_UNAVAILABLE", raw);
  if ([403, 404].includes(code)) return error(operation, "TARGET_PERMISSION", raw);
  return error(operation, "MODULE_ERROR", raw);
}
function upstreamId(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw Error("invalid upstream id");
}
function song(value: any) {
  return { id: upstreamId(value.id), name: value.name, artists: (value.ar ?? value.artists ?? []).map((artist: any) => artist.name).filter(Boolean), album: (value.al ?? value.album)?.name ?? "" };
}
function playlist(value: any) {
  return { id: upstreamId(value.id), name: value.name, creatorId: upstreamId(value.creator.userId), subscribed: value.subscribed === true, status: value.status ?? 0 };
}
async function invoke(message: WorkerInput): Promise<AdapterResult> {
  const { input, requestTimeoutMs, deviceId } = message;
  const operation = input.operation;
  // No startup guest login, credential discovery, config generation or shared device globals.
  writeFileSync(join(process.cwd(), "anonymous_token"), "", { mode: 0o600 });
  const vendorIndex = require(join(vendorRoot, "util/index.js"));
  const suppliedCookie = vendorIndex.cookieToJson(message.cookie);
  const query: Record<string, unknown> = { cookie: { ...suppliedCookie, deviceId, os: "pc" }, timeout: requestTimeoutMs, randomCNIP: false, checkToken: false };
  let moduleName: string;
  switch (operation) {
    case "qrKey": moduleName = "login_qr_key"; break;
    case "qrCreate": moduleName = "login_qr_create"; Object.assign(query, { key: input.key, qrimg: true, platform: "pc" }); break;
    case "qrCheck": moduleName = "login_qr_check"; query.key = input.key; break;
    case "identity": moduleName = "user_account"; break;
    case "search": moduleName = "cloudsearch"; Object.assign(query, { keywords: input.query, type: 1, limit: 5, offset: 0 }); break;
    case "userPlaylists": moduleName = "user_playlist"; Object.assign(query, { uid: input.accountId, offset: input.offset, limit: input.limit }); break;
    case "playlistDetail": moduleName = "playlist_detail"; query.id = input.playlistId; break;
    case "songDetail": moduleName = "song_detail"; query.ids = input.songIds.join(","); break;
    case "playlistCreate": moduleName = "playlist_create"; Object.assign(query, { name: input.name, privacy: "0", type: "NORMAL" }); break;
    case "playlistDelete": moduleName = "playlist_delete"; query.id = input.playlistId; break;
    case "trackAdd": case "trackRemove": moduleName = "playlist_tracks"; Object.assign(query, { pid: input.playlistId, tracks: input.songId, op: operation === "trackAdd" ? "add" : "del" }); break;
  }
  const request = require(join(vendorRoot, "util/request.js"));
  const module = require(join(vendorRoot, "module", `${moduleName}.js`));
  let raw: any;
  try { raw = await module(query, request); }
  catch (failure) { return classify(operation, failure); }
  if (raw?.body?.body) raw = { ...raw.body };
  const body = raw?.body;
  const code = body?.code;
  if (operation === "qrCheck") {
    if (code === 800) return { ok: true, data: { status: "expired" }, httpStatus: 200, businessCode: code };
    if (code === 801) return { ok: true, data: { status: "waiting" }, httpStatus: 200, businessCode: code };
    if (code === 802) return { ok: true, data: { status: "scanned" }, httpStatus: 200, businessCode: code };
    if (code === 803) {
      if (typeof body.cookie !== "string" || !body.cookie) return error(operation, "AUTH_UNAVAILABLE", raw);
      return { ok: true, data: { status: "authorized", cookie: body.cookie }, httpStatus: 200, businessCode: code };
    }
    return classify(operation, raw);
  }
  if (typeof code !== "number") return error(operation, "PARSE_ERROR", raw);
  if (code !== 200) return classify(operation, raw);
  try {
    let data: unknown;
    switch (operation) {
      case "qrKey": data = { key: body.data.unikey }; break;
      case "qrCreate": data = { url: body.data.qrurl, image: body.data.qrimg }; break;
      case "identity": {
        if (!body.account || !body.profile || body.account.id === null || body.account.id === undefined || body.account.id === "" || body.account.id === 0) return error(operation, "ACCOUNT_EMPTY", raw);
        const accountId = upstreamId(body.account.id);
        if (upstreamId(body.profile.userId) !== accountId || (input.expectedAccountId !== undefined && input.expectedAccountId !== accountId)) return error(operation, "ACCOUNT_MISMATCH", raw);
        data = { accountId, name: body.profile.nickname };
        break;
      }
      case "search": {
        const value = body.result;
        if (!value || (!Array.isArray(value.songs) && value.songCount !== 0)) return error(operation, "PARSE_ERROR", raw);
        data = { songs: (value.songs ?? []).slice(0, 5).map(song) };
        break;
      }
      case "userPlaylists": data = { playlists: body.playlist.map(playlist), more: body.more }; break;
      case "playlistDetail": {
        const value = body.playlist;
        // A tombstone can expose old tracks: status must survive this boundary.
        data = { playlist: playlist(value), songIds: value.trackIds.map((track: any) => upstreamId(track.id)), songs: value.tracks.map(song) };
        if (value.trackCount !== undefined && value.trackCount !== value.trackIds.length) return error(operation, "PARSE_ERROR", raw);
        if (new Set((data as { songIds: string[] }).songIds).size !== value.trackIds.length) return error(operation, "PARSE_ERROR", raw);
        break;
      }
      case "songDetail": data = { songs: body.songs.map(song) }; break;
      case "playlistCreate": data = { playlistId: upstreamId(body.id ?? body.playlist?.id) }; break;
      case "playlistDelete": case "trackAdd": case "trackRemove": data = { acknowledged: true }; break;
    }
    const result = { ok: true, data, httpStatus: raw.httpStatus ?? raw.status, businessCode: code };
    const checked = resultSchema(operation).safeParse(result);
    return checked.success ? checked.data as AdapterResult : error(operation, "PARSE_ERROR", raw);
  } catch { return error(operation, "PARSE_ERROR", raw); }
}
