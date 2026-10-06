import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterInput } from "../../src/netease/protocol.js";
import { createNeteaseAdapter } from "../../src/netease/adapter.js";

export type Outbound = { url: string; headers: Record<string, string>; timeout: number; data: string; report: { pid: number; cwd: string; env: Record<string, string>; mode: number; mask: number } };
export async function offlineAdapter(respond: (request: Outbound) => { body: unknown; status?: number; cookies?: string[]; disconnect?: boolean; redirect?: string }) {
  const outbound: Outbound[] = [];
  const server = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += chunk;
    const parsed = JSON.parse(request.headers["x-songroom-offline-contract"] as string) as Outbound;
    parsed.data = input;
    outbound.push(parsed);
    const result = respond(parsed);
    if (result.disconnect) { request.socket.destroy(); return; }
    response.statusCode = result.status ?? 200;
    response.setHeader("content-type", "application/json");
    if (result.cookies) response.setHeader("set-cookie", result.cookies);
    if (result.redirect) response.setHeader("location", result.redirect);
    response.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture bind");
  const root = await mkdtemp(join(tmpdir(), "songroom-netease-offline-"));
  const worker = join(root, "offline-worker.cjs");
  const productionWorker = fileURLToPath(new URL("../../dist/netease/worker.cjs", import.meta.url));
  await writeFile(worker, `process.umask(0o077);
const Module = require('node:module');
const load = Module._load;
const http = require('node:http');
const fs = require('node:fs');
const originalRequest = http.request;
// Real pinned Axios and its redirect dependency run against this loopback fixture.
http.request = function(options, ...args) {
  const parsed = typeof options === 'string' || options instanceof URL ? new URL(options) : options;
  if ((parsed.hostname || parsed.host) !== '127.0.0.1' || Number(parsed.port) !== ${address.port}) throw Error('OFFLINE_NETWORK_GUARD');
  return originalRequest.call(this, options, ...args);
};
require('node:https').request = () => { throw Error('OFFLINE_NETWORK_GUARD'); };
Module._load = function(name, ...args) {
  if (name === 'axios') {
    const realAxios = load.call(this,name,...args).default;
    const transport = settings => {
      const report = {url:settings.url,headers:settings.headers,timeout:settings.timeout,report:{pid:process.pid,cwd:process.cwd(),env:process.env,mode:fs.statSync(process.cwd()).mode&0o777,mask:process.umask()}};
      return realAxios({...settings,url:'http://127.0.0.1:${address.port}/rpc',headers:{...settings.headers,'x-songroom-offline-contract':JSON.stringify(report)}});
    };
    transport.get=()=>Promise.reject(Error('OFFLINE_NETWORK_GUARD'));
    return {default:transport};
  }
  return load.call(this,name,...args);
};
require(${JSON.stringify(productionWorker)});
`);
  const runtime = join(root, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  const adapter = createNeteaseAdapter({ runtimeDir: runtime, deviceId: "offline-stable-device", workerPath: worker });
  return {
    adapter, outbound, root, runtime,
    async call<I extends AdapterInput>(input: I) { return adapter.call(input); },
    async close() { await adapter.dispose(); server.close(); await once(server, "close"); await rm(root, { recursive: true, force: true }); },
    async directories() { return readdir(runtime); }
  };
}
