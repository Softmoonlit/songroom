import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initializeDatabase } from "../../src/db/database.js";
import { createApp, type SongRoomApp } from "../../src/http/app.js";
import { publicPlaylistView, type PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";
import { offlineAdapter } from "../netease/offline-adapter.js";

const roomId = "0195cf0d-6a80-7000-8000-000000000071";
const operationId = "0195cf0d-6a80-7000-8000-000000000072";
const endpoint = `**/api/rooms/${roomId}/public-playlist`;
const empty: PublicPlaylistView = { playlist: null, operation: null, allowedActions: ["createPublicPlaylist"], disabledReason: null, version: 1 };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function roomPage(page: Page) {
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: {
    session: { id: "public-ui-session", expiresAt: "2099-01-01T00:00:00Z" },
    user: { id: "public-ui-user", name: "房主", email: "public@example.com", emailVerified: false }
  } }));
  await page.route(`**/api/rooms/${roomId}`, route => route.fulfill({ json: {
    room: { id: roomId, name: "音乐间", role: "owner", nickname: "房主" },
    version: 1, pendingCount: 0, allowedActions: ["renameRoom", "renameNickname"], disabledReasons: {}
  } }));
}

for (const width of [320, 390, 900, 1440]) {
  test(`${width}px 键盘提交创建意图、排队后显式更新并显示绑定名称和 ID`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await roomPage(page);
    let view = empty;
    let reads = 0;
    let writes = 0;
    await page.route(endpoint, route => {
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: publicPlaylistView.parse(view) }); }
      writes++;
      expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(uuidPattern) });
      view = { ...empty, operation: { id: operationId, status: "queued", errorCode: null }, allowedActions: [], disabledReason: "OPERATION_PENDING", version: 2 };
      return route.fulfill({ status: 202, json: view });
    });
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "尚未创建公共歌单" })).toBeVisible();
    expect(writes).toBe(0);
    const create = page.getByRole("button", { name: "创建公共歌单", exact: true });
    await create.focus();
    await expect(create).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("已排队");
    await expect(create).toHaveCount(0);
    expect(writes).toBe(1);
    const before = reads;
    view = { playlist: { id: "cloud-071", name: "songroom-音乐间-公共" }, operation: { id: operationId, status: "succeeded", errorCode: null }, allowedActions: [], disabledReason: "PUBLIC_PLAYLIST_EXISTS", version: 3 };
    await page.getByRole("button", { name: "更新状态", exact: true }).click();
    await expect(page.getByRole("heading", { name: view.playlist!.name })).toBeVisible();
    await expect(page.getByText("cloud-071", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("已创建并绑定");
    expect(reads).toBe(before + 1);
    expect(writes).toBe(1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const [status, text] of [
  ["queued", "已排队"], ["processing", "正在创建"], ["awaitingConfirmation", "创建结果待确认"],
  ["waitingAuthorization", "等待房主恢复"], ["needsAdministrator", "需要管理员处理"],
  ["succeeded", "已创建并绑定"], ["failed", "创建明确失败"], ["stopped", "已停止"]
] as const) {
  test(`操作状态 ${status} 由本地 read model 展示，不提供未经允许的重试`, async ({ page }) => {
    await roomPage(page);
    let reads = 0;
    await page.route(endpoint, route => {
      expect(route.request().method()).toBe("GET");
      reads++;
      return route.fulfill({ json: publicPlaylistView.parse({ ...empty, operation: { id: operationId, status, errorCode: null }, allowedActions: [], disabledReason: "OPERATION_PENDING" }) });
    });
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("status")).toContainText(text);
    await expect(page.getByRole("button", { name: /创建公共歌单|重试创建/ })).toHaveCount(0);
    await page.getByRole("button", { name: "房间设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "房间设置", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "公共歌单", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(text);
    expect(reads).toBe(1);
    await page.getByRole("button", { name: "更新状态", exact: true }).click();
    await expect(page.getByRole("button", { name: "更新状态", exact: true })).toBeEnabled();
    expect(reads).toBe(2);
  });
}

for (const [reason, text] of [["OWNER_ONLY", "只有房主"], ["NETEASE_AUTH_REQUIRED", "绑定有效"], ["PUBLIC_PLAYLIST_EXISTS", "已经绑定"], ["OPERATION_PENDING", "未完成"], ["UPSTREAM_QUEUE_FULL", "20 项"], ["ACCOUNT_PAUSED", "已暂停"], ["TARGET_BLOCKED", "权限需要处理"]] as const) {
  test(`禁用原因 ${reason} 以中文展示，动作只来自 read model`, async ({ page }) => {
    await roomPage(page);
    await page.route(endpoint, route => route.fulfill({ json: { ...empty, allowedActions: [], disabledReason: reason } }));
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("region", { name: "公共歌单", exact: true })).toContainText(text);
    await expect(page.getByRole("button", { name: "创建公共歌单", exact: true })).toHaveCount(0);
  });
}

for (const [code, text] of [
  ["ACCOUNT_EMPTY", "账号为空"], ["ACCOUNT_MISMATCH", "身份已变化"], ["AUTH_UNAVAILABLE", "授权不可用"],
  ["RATE_LIMITED", "风控或频繁请求"], ["ACCOUNT_PAUSED", "管理员明确恢复"], ["TARGET_PERMISSION", "目标权限不足"],
  ["NETWORK_ERROR", "网络请求失败"], ["MODULE_ERROR", "接口执行异常"]
] as const) {
  test(`创建操作的稳定业务码 ${code} 有独立中文说明`, async ({ page }) => {
    await roomPage(page);
    await page.route(endpoint, route => route.fulfill({ json: publicPlaylistView.parse({
      ...empty, operation: { id: operationId, status: "needsAdministrator", errorCode: code }, allowedActions: [], disabledReason: "OPERATION_PENDING"
    }) }));
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("region", { name: "公共歌单", exact: true })).toContainText(text);
    await expect(page.getByRole("button", { name: "创建公共歌单", exact: true })).toHaveCount(0);
  });
}

test("创建响应丢失后安全重试复用 UUIDv7，明确本地拒绝后刷新并使用新键", async ({ page }) => {
  await roomPage(page);
  const commands: unknown[] = [];
  await page.route(endpoint, route => {
    if (route.request().method() === "GET") return route.fulfill({ json: empty });
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.abort("failed");
    if (commands.length === 2) return route.fulfill({ status: 409, json: { error: { code: "IDEMPOTENCY_KEY_EXPIRED", message: "raw MUSIC_U=secret" } } });
    return route.fulfill({ status: 202, json: { ...empty, operation: { id: operationId, status: "queued", errorCode: null }, allowedActions: [], disabledReason: "OPERATION_PENDING" } });
  });
  await page.goto(`/rooms/${roomId}`);
  const create = page.getByRole("button", { name: "创建公共歌单", exact: true });
  await create.click();
  await expect(page.getByRole("alert")).toContainText("暂时无法");
  await create.click();
  await expect(page.getByRole("alert")).toContainText("标识已过期");
  await expect(create).toBeEnabled();
  expect(commands[1]).toEqual(commands[0]);
  await expect(page.getByText(/MUSIC_U=secret/)).toHaveCount(0);
  await create.click();
  await expect(page.getByRole("status")).toContainText("已排队");
  expect(commands[2]).not.toEqual(commands[1]);
});

test("完整离线应用：建房不创建歌单，主动创建只写一次，更新与重新进入只读本地", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await offlineAdapter(request => {
    if (request.url.includes("qrcode/unikey")) return { body: { code: 200, unikey: "public-offline-qr" } };
    if (request.url.includes("qrcode/client/login")) return { body: { code: 803 }, cookies: ["MUSIC_U=offline-only; Domain=music.163.com; Path=/"] };
    if (request.url.includes("playlist/create")) return { body: { code: 200, id: "cloud-public-071" } };
    if (request.url.includes("user/account")) return { body: { code: 200, account: { id: "offline-071" }, profile: { userId: "offline-071", nickname: "离线网易云" } } };
    throw new Error(`Unexpected offline call: ${request.url}`);
  });
  const root = await mkdtemp(path.join(tmpdir(), "songroom-public-e2e-"));
  let app: SongRoomApp | undefined;
  try {
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const baseUrl = `http://127.0.0.1:${port}`;
    const dbPath = path.join(root, "app.sqlite");
    const credentialKeyPath = path.join(root, "netease.key");
    initializeDatabase(dbPath);
    await writeFile(credentialKeyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    app = await createApp({ nodeEnv: "test", host: "127.0.0.1", port, baseUrl, dbPath, credentialKeyPath, staticRoot: path.resolve("dist/client"), authSecret: "offline-e2e-secret-with-at-least-32-characters" }, { neteaseAdapter: fixture.adapter });
    await app.listen();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${baseUrl}/register`);
    await page.getByLabel("账号称呼").fill("公共歌单房主");
    await page.getByLabel("邮箱").fill("public-offline@example.com");
    await page.getByLabel("密码").fill("correct horse battery staple");
    await page.getByRole("button", { name: "注册并进入房间列表" }).click();
    await page.getByRole("link", { name: "账号设置", exact: true }).click();
    await page.getByRole("button", { name: "开始扫码绑定" }).click();
    await page.getByRole("button", { name: "检查扫码状态" }).click();
    await page.getByRole("button", { name: "确认绑定此网易云账号" }).click();
    await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "我的房间", exact: true }).click();
    await page.getByRole("link", { name: "创建房间", exact: true }).click();
    await page.getByLabel("房间名称").fill("离线音乐间");
    await page.getByLabel("我的房间昵称").fill("房主");
    await page.getByRole("checkbox", { name: "确认使用此网易云账号创建房间" }).check();
    await page.getByRole("button", { name: "创建并进入房间" }).click();
    await expect(page.getByRole("heading", { name: "尚未创建公共歌单" })).toBeVisible();
    expect(fixture.outbound.filter(call => call.url.includes("playlist/create"))).toHaveLength(0);
    const url = page.url();
    await page.getByRole("button", { name: "创建公共歌单", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(/已排队|正在创建|已创建并绑定/);
    // Observe completion via local GET only; this does not initiate another upstream request.
    await expect.poll(async () => {
      const response = await page.request.get(`${url.replace("/rooms/", "/api/rooms/")}/public-playlist`);
      return publicPlaylistView.parse(await response.json()).operation?.status;
    }, { timeout: 15_000 }).toBe("succeeded");
    await page.getByRole("button", { name: "更新状态", exact: true }).click();
    await expect(page.getByRole("heading", { name: "songroom-离线音乐间-公共" })).toBeVisible();
    await expect(page.getByText("cloud-public-071", { exact: true })).toBeVisible();
    expect(fixture.outbound.filter(call => call.url.includes("playlist/create"))).toHaveLength(1);
    const count = fixture.outbound.length;
    await page.getByRole("button", { name: "更新状态", exact: true }).click();
    await expect(page.getByRole("button", { name: "更新状态", exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByText("cloud-public-071", { exact: true })).toBeVisible();
    expect(fixture.outbound).toHaveLength(count);
    await expect(page.getByRole("button", { name: "创建公共歌单", exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await app?.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
