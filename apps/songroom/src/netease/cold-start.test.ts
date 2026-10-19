import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { expect, it } from "vitest";
import { createNeteaseAdapter } from "./adapter.js";
import { assertVendorIntegrity } from "./integrity.js";

async function coldStartFixture() {
  const requests: { url: string; jsdom: boolean; token?: string; pid: number }[] = [];
  let v3Tokens = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume actual HTTP request */ }
    const outbound = JSON.parse(String(request.headers["x-contract"])) as typeof requests[number];
    requests.push(outbound);
    if (outbound.url.endsWith("/tool.min.js")) {
      response.end(`window.initWatchman = options => {
        let sequence = 0;
        options.onload({ getInstance: () => ({ I: done => done() }),
          getToken: (businessId, done) => done('v2-token-' + (++sequence)) });
      };`);
      return;
    }
    if (outbound.url.includes("/v3/b?")) {
      response.end('null([200,0,"v3-token-' + (++v3Tokens) + '"])');
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code: 200, data: { list: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture bind");
  const root = await mkdtemp(join(tmpdir(), "songroom-cold-start-"));
  const worker = join(root, "worker.cjs");
  const runtime = join(root, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  const productionWorker = fileURLToPath(new URL("../../dist/netease/worker.cjs", import.meta.url));
  const vendor = fileURLToPath(new URL("../../dist/netease/vendor", import.meta.url));
  await writeFile(worker, `
process.umask(0o077);
const Module = require('node:module');
const load = Module._load;
let jsdom = false;
Module._load = function(name, ...args) {
  if (name === 'jsdom') jsdom = true;
  return load.call(this, name, ...args);
};
const http = require('node:http');
const original = http.request;
http.request = function(options, ...args) {
  if (options.hostname !== '127.0.0.1' || Number(options.port) !== ${address.port}) throw Error('OFFLINE_NETWORK_GUARD');
  return original.call(this, options, ...args);
};
require('node:https').request = () => { throw Error('OFFLINE_NETWORK_GUARD'); };
const axios = require(${JSON.stringify(join(vendor, "node_modules/axios"))}).default;
axios.interceptors.request.use(settings => {
  settings.headers['x-contract'] = JSON.stringify({url: settings.url, jsdom, token: settings.headers['X-antiCheatToken'], pid: process.pid});
  settings.url = 'http://127.0.0.1:${address.port}/rpc';
  return settings;
});
if (process.argv[2] === 'tokens') {
  require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'anonymous_token'), '');
  const request = require(${JSON.stringify(join(vendor, "util/request.js"))});
  (async () => {
    for (const checkToken of [false, 'v2', 'v2', 'v3', 'v3']) {
      await request('/api/play-record/song/list', {limit: 1}, {checkToken, crypto: 'weapi', cookie: {deviceId: 'offline-device', os: 'pc'}, timeout: 15000});
    }
    process.exit(0);
  })().catch(() => process.exit(1));
} else {
  require(${JSON.stringify(productionWorker)});
}
`);
  const adapter = createNeteaseAdapter({ runtimeDir: runtime, workerPath: worker });
  return {
    requests, root, worker, vendor, adapter,
    async close() {
      await adapter.dispose();
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    }
  };
}

it("real isolated workers complete checkToken:false requests without loading jsdom", async () => {
  const fixture = await coldStartFixture();
  try {
    for (let index = 0; index < 2; index++) {
      expect(await fixture.adapter.call({ operation: "recentSong", cookie: "MUSIC_U=offline" })).toMatchObject({ ok: true, data: { songId: null } });
    }
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.map(request => request.jsdom)).toEqual([false, false]);
    expect(new Set(fixture.requests.map(request => request.pid)).size).toBe(2);
  } finally { await fixture.close(); }
});


it("vendor loads the real v2 SDK on demand and obtains fresh v2 and v3 tokens for each request", async () => {
  const fixture = await coldStartFixture();
  try {
    await assertVendorIntegrity(fixture.vendor);
    const directory = join(fixture.root, "token-runtime");
    await mkdir(directory, { mode: 0o700 });
    const child = fork(fixture.worker, ["tokens"], {
      cwd: directory, execArgv: [],
      env: { TMPDIR: directory, TMP: directory, TEMP: directory, HOME: directory, NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [code] = await once(child, "close");
      expect(code).toBe(0);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    const normalRequests = fixture.requests.filter(request => request.url.includes("play-record/song/list"));
    expect(normalRequests.map(request => request.token ?? null)).toEqual([null, "v2-token-1", "v2-token-2", "v3-token-1", "v3-token-2"]);
    expect(normalRequests.map(request => request.jsdom)).toEqual([false, true, true, true, true]);
    expect(fixture.requests.filter(request => request.url.endsWith("/tool.min.js"))).toHaveLength(1);
    expect(fixture.requests.filter(request => request.url.includes("/v3/b?"))).toHaveLength(2);
  } finally { await fixture.close(); }
});
