import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";

// Browser hook seam: native HTTP EventSource -> production hook -> real QueryClient -> rendered consumers.
// Only the server boundary is controlled; no tracker/query-client methods are mocked.
let server: ViteDevServer;
let origin: string;
const streams = new Set<ServerResponse>();
const pending = new Set<ServerResponse>();
type View = { id?: string; version: number; label: string };
let views: Record<string, View>;
let hold: string | null;
let held = false;
let fail: string | null;

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useEventStream } from '/src/client/useEventStream.ts';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const names = new URLSearchParams(location.search).get('queries').split(',');
function Consumer({ name }) {
  const operation = name.endsWith('-operation');
  const query = useQuery({
    queryKey: operation ? [name, 'op-1'] : [name, 'session-1', 'room-1'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/view/' + name, { signal });
      if (!response.ok) throw new Error('read failed');
      return response.json();
    },
    refetchInterval: 2500
  });
  return React.createElement('output', { 'aria-label': name }, query.isError ? 'read failed' : query.data?.label ?? 'loading');
}
function App() {
  useEventStream(true);
  return names.map(name => React.createElement(Consumer, { key: name, name }));
}
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client }, React.createElement(App)));
`;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "event-stream-browser-seam",
      resolveId(id) { return id === "/event-stream-fixture.js" ? "\0event-stream-fixture" : undefined; },
      load(id) { return id === "\0event-stream-fixture" ? entry : undefined; },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/fixture?")) {
            res.setHeader("content-type", "text/html");
            res.end('<div id="root"></div><script type="module" src="/event-stream-fixture.js"></script>');
          } else if (req.url === "/api/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
            res.write("event: connected\ndata: ok\n\n");
            streams.add(res);
            res.on("close", () => streams.delete(res));
          } else if (req.url?.startsWith("/view/")) {
            const name = req.url.slice("/view/".length);
            const view = views[name];
            if (hold === name && !held) {
              held = true;
              pending.add(res);
              res.on("close", () => pending.delete(res));
              return;
            }
            res.setHeader("content-type", "application/json");
            res.statusCode = fail === name ? 503 : 200;
            res.end(JSON.stringify(view));
          } else next();
        });
      }
    }]
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  for (const stream of streams) stream.end();
  for (const response of pending) response.end();
  await server?.close();
});
test.beforeEach(() => {
  views = {};
  hold = null;
  held = false;
  fail = null;
});

async function open(page: Page, names: string[]) {
  await page.goto(`${origin}/fixture?queries=${names.join(",")}`);
  await expect.poll(() => streams.size).toBe(1);
}
function notify(type: string, resourceId = "op-1", version = 2) {
  for (const stream of streams) stream.write(`event: invalidation\ndata: ${JSON.stringify({ type, resourceId, version })}\n\n`);
}

for (const name of ["personal-song-addition-operation", "random-replacement-operation", "song-request-operation"]) {
  test(`${name}: completion event updates the browser before the fallback poll`, async ({ page }) => {
    views[name] = { id: "op-1", version: 1, label: "processing" };
    await open(page, [name]);
    await expect(page.getByLabel(name)).toHaveText("processing");
    views[name] = { id: "op-1", version: 2, label: "succeeded" };
    notify("operation");
    await expect(page.getByLabel(name)).toHaveText("succeeded", { timeout: 1200 });
  });
}

test("completion cancels the initial stale read instead of waiting for the fallback poll", async ({ page }) => {
  const name = "personal-song-addition-operation";
  views[name] = { id: "op-1", version: 1, label: "processing" };
  hold = name;
  await open(page, [name]);
  await expect.poll(() => held).toBe(true);
  views[name] = { id: "op-1", version: 2, label: "succeeded" };
  notify("operation");
  // Keep the old HTTP response in flight until the event has had a chance to start a fresh read.
  try {
    await expect(page.getByLabel(name)).toHaveText("succeeded", { timeout: 1200 });
  } finally {
    for (const response of pending) response.end(JSON.stringify({ id: "op-1", version: 1, label: "processing" }));
  }
  await expect(page.getByLabel(name)).toHaveText("succeeded");
});

for (const type of ["operation", "room", "snapshot"]) {
  test(`${type}: the personal playlist updates before the fallback poll`, async ({ page }) => {
    const name = "room-personal-playlist";
    views[name] = { version: 1, label: "empty playlist" };
    await open(page, [name]);
    await expect(page.getByLabel(name)).toHaveText("empty playlist");
    views[name] = { version: 2, label: "new song" };
    notify(type, type === "operation" ? "op-1" : "room-1");
    await expect(page.getByLabel(name)).toHaveText("new song", { timeout: 1200 });
  });
}

for (const [type, sibling] of [
  ["room", "room-shell"],
  ["snapshot", "room-public-playlist"],
  ["operation", "song-request-operation"]
]) {
  test(`${type}: a newer sibling read model cannot swallow an event needed by the personal playlist`, async ({ page }) => {
    const name = "room-personal-playlist";
    views[name] = { version: 1, label: "empty playlist" };
    views[sibling!] = { id: "op-1", version: 9, label: "already current" };
    await open(page, [name, sibling!]);
    await expect(page.getByLabel(sibling!)).toHaveText("already current");
    await expect(page.getByLabel(name)).toHaveText("empty playlist");
    views[name] = { version: 9, label: "new song" };
    notify(type!, type === "operation" ? "op-1" : "room-1", 9);
    await expect(page.getByLabel(name)).toHaveText("new song", { timeout: 1200 });
  });
}

for (const name of ["personal-song-addition-operation", "random-replacement-operation"]) {
  test(`${name}: a failed event-triggered read allows the same notification to retry`, async ({ page }) => {
    views[name] = { id: "op-1", version: 1, label: "processing" };
    await open(page, [name]);
    await expect(page.getByLabel(name)).toHaveText("processing");
    fail = name;
    notify("operation");
    await expect(page.getByLabel(name)).toHaveText("read failed", { timeout: 1200 });
    fail = null;
    views[name] = { id: "op-1", version: 2, label: "succeeded" };
    notify("operation");
    await expect(page.getByLabel(name)).toHaveText("succeeded", { timeout: 1200 });
  });
}

test("a lost notification still converges through the fallback poll", async ({ page }) => {
  const name = "personal-song-addition-operation";
  views[name] = { id: "op-1", version: 1, label: "processing" };
  await open(page, [name]);
  await expect(page.getByLabel(name)).toHaveText("processing");
  views[name] = { id: "op-1", version: 2, label: "succeeded" };
  // Deliberately send no SSE event. Ordinary JSON polling remains the recovery path.
  await expect(page.getByLabel(name)).toHaveText("succeeded", { timeout: 4000 });
});

test("reconnection refresh cannot reuse an initial stale read", async ({ page }) => {
  const name = "room-personal-playlist";
  views[name] = { version: 1, label: "empty playlist" };
  hold = name;
  await open(page, [name]);
  await expect.poll(() => held).toBe(true);
  views[name] = { version: 2, label: "new song" };
  // The server sends this control event on every established connection.
  for (const stream of streams) stream.write("event: connected\ndata: ok\n\n");
  try {
    await expect(page.getByLabel(name)).toHaveText("new song", { timeout: 1200 });
  } finally {
    for (const response of pending) response.end(JSON.stringify({ version: 1, label: "empty playlist" }));
  }
});
