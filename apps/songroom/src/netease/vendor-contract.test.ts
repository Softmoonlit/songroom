import { describe, expect, it } from "vitest";
import { offlineAdapter } from "../../tests/netease/offline-adapter.js";
import type { AdapterInput } from "./protocol.js";

const writes: AdapterInput[] = [
  { operation: "playlistCreate", cookie: "MUSIC_U=explicit-secret", name: "offline" },
  { operation: "playlistDelete", cookie: "MUSIC_U=explicit-secret", playlistId: "300" },
  { operation: "trackAdd", cookie: "MUSIC_U=explicit-secret", playlistId: "300", songId: "400" },
  { operation: "trackRemove", cookie: "MUSIC_U=explicit-secret", playlistId: "300", songId: "400" }
];

describe("audited vendor through production adapter", () => {
  it("never repeats a track add when the real request layer receives business code 512", async () => {
    const fixture = await offlineAdapter(() => ({ body: { code: 512, msg: "Cookie=secret upstream payload" } }));
    try {
      const result = await fixture.call({ operation: "trackAdd", cookie: "MUSIC_U=explicit-secret", playlistId: "300", songId: "400" });
      expect(fixture.outbound).toHaveLength(1);
      expect(fixture.outbound[0].url).toBe("https://interfacepc.music.163.com/eapi/playlist/manipulate/tracks");
      expect(result).toEqual({ ok: false, error: { code: "MODULE_ERROR", outcome: "unknown", httpStatus: 200, businessCode: 512 } });
      expect(await fixture.directories()).toEqual([]);
    } finally { await fixture.close(); }
  });
  it("preserves a QR polling network error without replacing it with a module exception", async () => {
    const fixture = await offlineAdapter(() => ({ body: {}, disconnect: true }));
    try {
      const result = await fixture.call({ operation: "qrCheck", key: "offline-key" });
      expect(result).toEqual({ ok: false, error: { code: "NETWORK_ERROR", outcome: "failed", businessCode: 502, httpStatus: 502 } });
    } finally { await fixture.close(); }
  });
  it("does not replay a playlist creation on an HTTP 307 redirect", async () => {
    const fixture = await offlineAdapter(() => ({ body: { code: 307 }, status: 307, redirect: "/again" }));
    try {
      const result = await fixture.call({ operation: "playlistCreate", cookie: "MUSIC_U=explicit", name: "offline" });
      expect(fixture.outbound).toHaveLength(1);
      expect(result.ok).toBe(false);
    } finally { await fixture.close(); }
  });
  it.each(writes)("$operation sends at most one real Axios request on success, 512, disconnect and redirect", async input => {
    for (const scenario of ["success", "512", "disconnect", "redirect"]) {
      const fixture = await offlineAdapter(() => scenario === "success" ? { body: { code: 200, id: "opaque-playlist" } } : scenario === "512" ? { body: { code: 512, msg: "sensitive" } } : scenario === "disconnect" ? { body: {}, disconnect: true } : { body: { code: 308 }, status: 308, redirect: "/replay" });
      try {
        const result = await fixture.call(input);
        expect(fixture.outbound).toHaveLength(1);
        expect(fixture.outbound[0].timeout).toBe(15000);
        expect(fixture.outbound[0].headers.Cookie).toContain("MUSIC_U=explicit-secret");
        expect(fixture.outbound[0].headers.Cookie).toContain("deviceId=offline-stable-device");
        expect(fixture.outbound[0].report.mode).toBe(0o700);
        expect(fixture.outbound[0].report.mask).toBe(0o077);
        expect(JSON.stringify(result)).not.toContain("sensitive");
        if (scenario === "success") expect(result.ok).toBe(true);
        else { expect(result.ok).toBe(false); if (!result.ok) expect(result.error.outcome).toBe("unknown"); }
        expect(await fixture.directories()).toEqual([]);
      } finally { await fixture.close(); }
    }
  });
  it.each([
    [301, "AUTH_UNAVAILABLE"], [403, "TARGET_PERMISSION"], [404, "TARGET_PERMISSION"],
    [405, "RATE_LIMITED"], [429, "RATE_LIMITED"], [400, "MODULE_ERROR"]
  ] as const)("classifies body code %s independently from HTTP 200 and strips sensitive error data", async (code, expected) => {
    const fixture = await offlineAdapter(() => ({ body: { code, msg: "MUSIC_U=raw-secret", config: { auth: "secret" } } }));
    try {
      expect(await fixture.call({ operation: "identity", cookie: "explicit" })).toEqual({ ok: false, error: { code: expected, outcome: "failed", httpStatus: 200, businessCode: code } });
    } finally { await fixture.close(); }
  });
  it("preserves real opaque identity and only returns QR cookies from the authorized branch", async () => {
    const fixture = await offlineAdapter(request => {
      if (request.url.includes("qrcode/unikey")) return { body: { code: 200, unikey: "private-qr-key", ignored: "raw-secret" } };
      if (request.url.includes("qrcode/client/login")) return { body: { code: 803, ignored: "raw-secret" }, cookies: ["MUSIC_U=candidate-secret; Domain=music.163.com; Path=/"] };
      return { body: { code: 200, account: { id: "000opaque:18446744073709551616" }, profile: { userId: "000opaque:18446744073709551616", nickname: "nickname", email: "raw-secret" }, cookie: "untrusted-new-cookie" }, cookies: ["MUSIC_U=untrusted-new-cookie"] };
    });
    try {
      const keyResult = await fixture.call({ operation: "qrKey", deviceId: "flow-device" });
      expect(keyResult).toEqual({ ok: true, data: { key: "private-qr-key" }, httpStatus: 200, businessCode: 200 });
      const image = await fixture.call({ operation: "qrCreate", key: "private-qr-key", deviceId: "flow-device" });
      expect(image.ok).toBe(true);
      if (image.ok) { expect(image.data.url).toBe("https://music.163.com/login?codekey=private-qr-key"); expect(image.data.image).toMatch(/^data:image\/png;base64,/); }
      const authorized = await fixture.call({ operation: "qrCheck", key: "private-qr-key", deviceId: "flow-device" });
      expect(authorized).toEqual({ ok: true, data: { status: "authorized", cookie: "MUSIC_U=candidate-secret; Path=/" }, httpStatus: 200, businessCode: 803 });
      expect(await fixture.call({ operation: "identity", cookie: "candidate-secret", expectedAccountId: "000opaque:18446744073709551616", deviceId: "flow-device" })).toEqual({ ok: true, data: { accountId: "000opaque:18446744073709551616", name: "nickname" }, httpStatus: 200, businessCode: 200 });
      expect(await fixture.call({ operation: "identity", cookie: "candidate-secret", expectedAccountId: "different" })).toEqual({ ok: false, error: { code: "ACCOUNT_MISMATCH", outcome: "failed", httpStatus: 200, businessCode: 200 } });
    } finally { await fixture.close(); }
  });
  it.each([[800, "expired"], [801, "waiting"], [802, "scanned"]] as const)("returns %s as %s without credentials", async (code, status) => {
    const fixture = await offlineAdapter(() => ({ body: { code, cookie: "body-secret" }, cookies: ["MUSIC_U=secret"] }));
    try { expect(await fixture.call({ operation: "qrCheck", key: "key" })).toEqual({ ok: true, data: { status }, httpStatus: 200, businessCode: code }); }
    finally { await fixture.close(); }
  });
  it("rejects a truncated playlist ID collection and does not treat malformed searches as empty", async () => {
    const fixture = await offlineAdapter(request => request.url.includes("playlist/detail") ? { body: { code: 200, playlist: { id: "list", name: "name", creator: { userId: "owner" }, status: 0, trackCount: 2, trackIds: [{ id: "first" }], tracks: [] } } } : { body: { code: 200, result: { songCount: 4 } } });
    try {
      expect(await fixture.call({ operation: "playlistDetail", cookie: "explicit", playlistId: "list" })).toEqual({ ok: false, error: { code: "PARSE_ERROR", outcome: "failed", httpStatus: 200, businessCode: 200 } });
      expect(await fixture.call({ operation: "search", cookie: "explicit", query: "search" })).toEqual({ ok: false, error: { code: "PARSE_ERROR", outcome: "failed", httpStatus: 200, businessCode: 200 } });
    } finally { await fixture.close(); }
  });
  it("distinguishes empty identity from malformed JSON and ordinary business errors", async () => {
    const fixture = await offlineAdapter(() => ({ body: { code: 200, account: null, profile: null } }));
    try { expect(await fixture.call({ operation: "identity", cookie: "explicit" })).toEqual({ ok: false, error: { code: "ACCOUNT_EMPTY", outcome: "failed", httpStatus: 200, businessCode: 200 } }); }
    finally { await fixture.close(); }
  });
});
