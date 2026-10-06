import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNeteaseAdapter } from "./adapter.js";
import type { NeteaseAdapter } from "./protocol.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../tests/netease/${name}`, import.meta.url));
const resources: Array<{ root: string; adapter: NeteaseAdapter }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) { await resource.adapter.dispose(); await rm(resource.root, { recursive: true, force: true }); }
});
async function setup(workerPath = fixture("isolation-worker.cjs"), hardDeadlineMs = 25000) {
  const root = await mkdtemp(`${tmpdir()}/songroom-adapter-test-`);
  const adapter = createNeteaseAdapter({ runtimeDir: root, deviceId: "stable-device", workerPath, hardDeadlineMs });
  resources.push({ root, adapter });
  return { root, adapter };
}
describe("production adapter offline process contract", () => {
  it("isolates every invocation in a private directory with explicit credentials and minimal environment", async () => {
    process.env.NETEASE_COOKIE = "ambient-secret";
    process.env.NODE_OPTIONS = "--trace-warnings";
    process.env.SONGROOM_SECRET = "application-secret";
    try {
      const { root, adapter } = await setup();
      const reports = [];
      for (let i = 0; i < 2; i++) {
        const result = await adapter.call({ operation: "qrKey" });
        expect(result.ok).toBe(true);
        if (!result.ok) throw Error(result.error.code);
        reports.push(JSON.parse(result.data.key));
        expect(await readdir(root)).toEqual([]);
      }
      expect(reports[0].pid).not.toBe(reports[1].pid);
      expect(reports[0].cwd).not.toBe(reports[1].cwd);
      for (const report of reports) {
        expect(report.mode).toBe(0o700);
        expect(report.mask).toBe(0o077);
        expect(report.cookie).toBe("");
        expect(report.deviceId).toBe("stable-device");
        expect(report.timeout).toBe(15000);
        expect(report.env).toEqual({ TMPDIR: report.cwd, TMP: report.cwd, TEMP: report.cwd, HOME: report.cwd, NODE_ENV: "production" });
      }
    } finally { delete process.env.NETEASE_COOKIE; delete process.env.NODE_OPTIONS; delete process.env.SONGROOM_SECRET; }
  });
  it.each(["util/request.js", "SOURCE.md", "upstream-pnpm-lock.yaml", "integrity.json", "unexpected.js"])("fails startup and prevents any request after vendor file %s changes", async file => {
    const root = await mkdtemp(`${tmpdir()}/songroom-integrity-test-`);
    const vendorRoot = `${root}/vendor`;
    await cp(fileURLToPath(new URL("../../../../packages/vendor/netease-cloud-music-api-enhanced", import.meta.url)), vendorRoot, { recursive: true, filter: path => !path.includes("node_modules") });
    const adapter = createNeteaseAdapter({ runtimeDir: root, vendorRoot, workerPath: fixture("isolation-worker.cjs") });
    resources.push({ root, adapter });
    await adapter.assertVendorIntegrity();
    await writeFile(`${vendorRoot}/${file}`, "tampered");
    await expect(adapter.assertVendorIntegrity()).rejects.toThrow("INTEGRITY_ERROR");
    expect(await adapter.call({ operation: "playlistCreate", cookie: "explicit", name: "test" })).toEqual({ ok: false, error: { code: "INTEGRITY_ERROR", outcome: "failed" } });
    expect(await readdir(root)).toEqual(["vendor"]);
  });
  it("discards raw stdout and stderr at the process boundary", async () => {
    const { root } = await setup();
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [fixture("logging-host.mjs"), root, fixture("isolation-worker.cjs")]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("RAW-STDOUT-SECRET");
    expect(stdout).not.toContain("RAW-STDERR-SECRET");
    expect(JSON.parse(stdout).result.ok).toBe(true);
    expect(JSON.parse(stdout).directories).toEqual([]);
  });
  it("dispose terminates pending calls and returns only after private directory cleanup", async () => {
    const { root, adapter } = await setup(fixture("adversarial-worker.cjs"));
    const pending = adapter.call({ operation: "trackAdd", cookie: "secret", playlistId: "playlist", songId: "hang" });
    // Observe the contract's private directory before asking the adapter to stop.
    while ((await readdir(root)).length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    await adapter.dispose();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toMatch(/^(PROCESS_ERROR|INVALID_INPUT)$/);
    expect(await readdir(root)).toEqual([]);
  });
  it("sanitizes an unavailable runtime directory before any write can be sent", async () => {
    const root = await mkdtemp(`${tmpdir()}/songroom-directory-test-`);
    const adapter = createNeteaseAdapter({ runtimeDir: `${root}/missing`, workerPath: fixture("adversarial-worker.cjs") });
    resources.push({ root, adapter });
    expect(await adapter.call({ operation: "playlistCreate", cookie: "secret", name: "test" })).toEqual({ ok: false, error: { code: "PROCESS_ERROR", outcome: "failed" } });
    expect(await readdir(root)).toEqual([]);
  });
  it("rejects non-object IPC inputs through the public adapter without exposing exceptions", async () => {
    const { adapter } = await setup();
    for (const input of [null, undefined, "credential", { operation: "arbitraryModule" }]) {
      expect(await adapter.call(input as never)).toEqual({ ok: false, error: { code: "INVALID_INPUT", outcome: "failed" } });
    }
  });
  it("rejects non-whitelisted input without launching a process", async () => {
    const { root, adapter } = await setup();
    expect(await adapter.call({ operation: "qrKey", cookie: "secret", module: "logout" } as never)).toEqual({ ok: false, error: { code: "INVALID_INPUT", outcome: "failed" } });
    expect(await readdir(root)).toEqual([]);
  });
  it("distinguishes read deadlines from possibly sent writes and cleans a hung process", async () => {
    const { root, adapter } = await setup(fixture("adversarial-worker.cjs"), 150);
    expect(await adapter.call({ operation: "qrCheck", key: "hang" })).toEqual({ ok: false, error: { code: "DEADLINE", outcome: "failed" } });
    expect(await adapter.call({ operation: "trackAdd", cookie: "explicit", playlistId: "id", songId: "hang" })).toEqual({ ok: false, error: { code: "DEADLINE", outcome: "unknown" } });
    expect(await readdir(root)).toEqual([]);
  });
  it.each(["exit", "crash", "failedCrash", "malformed", "duplicate"])("keeps %s worker failures sanitized and unknown for a write", async mode => {
    const { root, adapter } = await setup(fixture("adversarial-worker.cjs"));
    const result = await adapter.call({ operation: "trackAdd", cookie: "MUSIC_U=secret", playlistId: "id", songId: mode });
    expect(result).toEqual({ ok: false, error: { code: ["malformed", "duplicate"].includes(mode) ? "PARSE_ERROR" : "PROCESS_ERROR", outcome: "unknown" } });
    expect(await readdir(root)).toEqual([]);
  });
});
