import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initializeDatabase } from "../../src/db/database.js";
import { createApp, type SongRoomApp } from "../../src/http/app.js";
import { offlineAdapter } from "../netease/offline-adapter.js";
import { publicPlaylistView, type PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";

const roomId = "018f3a2c-4e89-7000-8000-000000000001";
const operationId1 = "0195cf0d-6a80-7000-8000-000000000072";
const operationId2 = "0195cf0d-6a80-7000-8000-000000000073";
const endpoint = `**/api/rooms/${roomId}/public-playlist`;

async function setupPage(page: Page, role: "owner" | "roommate" = "owner") {
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "s1", userId: "u1" },
        user: { id: "u1", email: "user@example.com", name: role === "owner" ? "房主" : "室友" }
      }
    })
  );
  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: {
        room: { id: roomId, name: "测试宿舍", role, nickname: role === "owner" ? "房主" : "室友" },
        version: 1,
        pendingCount: 0,
        allowedActions: role === "owner" ? ["renameRoom", "renameNickname"] : ["renameNickname"],
        disabledReasons: {}
      }
    })
  );
  await page.route(`**/api/rooms/${roomId}/song-search*`, route =>
    route.fulfill({ json: { songs: [], hasMore: false } })
  );
}

test.describe("公共歌单失效识别与重新创建 (ticket 13)", () => {
  for (const width of [320, 900, 1440]) {
    test(`${width}px 房主视角：确认失效清晰展示并提供「重新创建公共歌单」，无横向溢出`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setupPage(page);

      const invalidatedView: PublicPlaylistView = {
        playlist: null,
        invalidatedTarget: {
          playlistId: "cloud-pl-stale",
          name: "songroom-测试宿舍-公共",
          checkedAt: 1791350000000,
          status: "confirmedDeleted"
        },
        snapshot: null,
        lastRefreshError: null,
        operation: null,
        allowedActions: ["createPublicPlaylist"],
        disabledReason: null,
        version: 1
      };

      await page.route(endpoint, route => {
        if (route.request().method() === "GET") {
          return route.fulfill({ json: publicPlaylistView.parse(invalidatedView) });
        }
        if (route.request().method() === "POST") {
          return route.fulfill({
            status: 202,
            json: publicPlaylistView.parse({
              ...invalidatedView,
              operation: { id: operationId1, status: "queued", errorCode: null }
            })
          });
        }
        return route.abort();
      });

      await page.goto(`/rooms/${roomId}`);

      // 验证失效状态文案清晰展示
      await expect(page.getByRole("heading", { name: "公共歌单已确认失效" })).toBeVisible();
      await expect(page.getByText(/已从网易云删除.*已确认失效/)).toBeVisible();
      await expect(page.getByRole("button", { name: "重新创建公共歌单" })).toBeVisible();

      // 不出现个人歌单、导入或换号入口
      await expect(page.getByText("个人歌单")).toHaveCount(0);
      await expect(page.getByText("导入歌单")).toHaveCount(0);
      await expect(page.getByText("更换网易云账号")).toHaveCount(0);

      // 无横向溢出
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      // 房主点击重新创建
      await page.getByRole("button", { name: "重新创建公共歌单" }).click();
      await expect(page.getByRole("status")).toContainText("已排队，等待创建公共歌单。");
    });

    test(`${width}px 室友视角：确认失效展示最后核查状态与等待房主重新创建，无创建入口，无横向溢出`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setupPage(page, "roommate");

      const memberInvalidatedView: PublicPlaylistView = {
        playlist: null,
        invalidatedTarget: {
          playlistId: "cloud-pl-stale",
          name: "songroom-测试宿舍-公共",
          checkedAt: 1791350000000,
          status: "confirmedDeleted"
        },
        snapshot: null,
        lastRefreshError: null,
        operation: null,
        allowedActions: [],
        disabledReason: "OWNER_ONLY",
        version: 1
      };

      await page.route(endpoint, route => {
        return route.fulfill({ json: publicPlaylistView.parse(memberInvalidatedView) });
      });

      await page.goto(`/rooms/${roomId}`);

      // 验证失效状态与等待房主说明
      await expect(page.getByRole("heading", { name: "公共歌单已确认失效" })).toBeVisible();
      await expect(page.getByText(/已确认失效，等待房主重新创建公共歌单/)).toBeVisible();

      // 室友无创建按钮
      await expect(page.getByRole("button", { name: /创建公共歌单|重新创建公共歌单/ })).toHaveCount(0);

      // 无横向溢出
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test("区分展示暂时读取失败与创建结果待核查", async ({ page }) => {
    await setupPage(page);

    // 1. 暂时读取失败保留上次快照展示
    const readFailedView: PublicPlaylistView = {
      playlist: { id: "cloud-pl-1", name: "songroom-测试宿舍-公共" },
      snapshot: {
        version: 1,
        syncedAt: 1791300000000,
        trackCount: 1,
        tracks: [{ position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: [] }]
      },
      lastRefreshError: "MODULE_ERROR",
      operation: null,
      allowedActions: ["refreshPublicPlaylist"],
      disabledReason: "PUBLIC_PLAYLIST_EXISTS",
      version: 1
    };

    await page.route(endpoint, route => route.fulfill({ json: publicPlaylistView.parse(readFailedView) }));
    await page.goto(`/rooms/${roomId}`);

    await expect(page.getByText(/暂时读取失败.*已保留上次快照/)).toBeVisible();
    await expect(page.getByText("晴天")).toBeVisible();

    // 2. 创建结果待核查细分展示
    const awaitingConfirmationView: PublicPlaylistView = {
      playlist: null,
      snapshot: null,
      lastRefreshError: null,
      operation: {
        id: operationId2,
        status: "awaitingConfirmation",
        errorCode: null
      },
      allowedActions: [],
      disabledReason: "OPERATION_PENDING",
      version: 1
    };

    await page.route(endpoint, route => route.fulfill({ json: publicPlaylistView.parse(awaitingConfirmationView) }));
    await page.reload();

    await expect(page.getByRole("status")).toContainText(/创建结果待核查/);
    await expect(page.getByRole("button", { name: /创建公共歌单|重新创建公共歌单/ })).toHaveCount(0);
  });

  test("真实运行应用（无 route 拦截）：经历公开刷新核查失效并成功重建为新代次", async ({ page }) => {
    test.setTimeout(60_000);
    let playlistState: "initial" | "deleted" | "recreated" = "initial";
    let createCount = 0;

    const fixture = await offlineAdapter(request => {
      if (request.url.includes("qrcode/unikey")) return { body: { code: 200, unikey: "reconfig-qr" } };
      if (request.url.includes("qrcode/client/login")) return { body: { code: 803 }, cookies: ["MUSIC_U=offline-reconfig; Domain=music.163.com; Path=/"] };
      if (request.url.includes("user/account")) return { body: { code: 200, account: { id: "offline-reconfig-owner" }, profile: { userId: "offline-reconfig-owner", nickname: "离线房主" } } };
      if (request.url.includes("playlist/create")) {
        createCount++;
        return { body: { code: 200, id: createCount === 1 ? "cloud-pl-v1" : "cloud-pl-v2" } };
      }
      if (request.url.includes("user/playlist")) {
        if (playlistState === "deleted") {
          return { body: { code: 200, playlist: [], more: false } };
        }
        const id = createCount <= 1 ? "cloud-pl-v1" : "cloud-pl-v2";
        return {
          body: {
            code: 200,
            playlist: [{
              id,
              name: "songroom-离线重建房-公共",
              status: 0,
              creator: { userId: "offline-reconfig-owner" }
            }],
            more: false
          }
        };
      }
      if (request.url.includes("playlist/detail") || request.url.includes("v6/playlist/detail")) {
        const id = createCount <= 1 ? "cloud-pl-v1" : "cloud-pl-v2";
        const status = playlistState === "deleted" ? 10 : 0;
        return {
          body: {
            code: 200,
            playlist: {
              id,
              name: "songroom-离线重建房-公共",
              status,
              creator: { userId: "offline-reconfig-owner" },
              trackIds: [],
              tracks: []
            },
            privileges: []
          }
        };
      }
      throw new Error(`Unexpected offline call: ${request.url}`);
    });

    const root = await mkdtemp(path.join(tmpdir(), "songroom-reconfig-e2e-"));
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
      await writeFile(credentialKeyPath, Buffer.alloc(32, 9), { mode: 0o600 });
      app = await createApp({ nodeEnv: "test", host: "127.0.0.1", port, baseUrl, dbPath, credentialKeyPath, staticRoot: path.resolve("dist/client"), authSecret: "reconfig-e2e-secret-with-at-least-32-chars" }, { neteaseAdapter: fixture.adapter });
      await app.listen();

      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`${baseUrl}/register`);
      await page.getByLabel("账号称呼").fill("重建房主");
      await page.getByLabel("邮箱").fill("reconfig@example.com");
      await page.getByLabel("密码").fill("correct horse battery staple");
      await page.getByRole("button", { name: "注册并进入房间列表" }).click();

      await page.getByRole("link", { name: "账号设置", exact: true }).click();
      await page.getByRole("button", { name: "开始扫码绑定" }).click();
      await page.getByRole("button", { name: "检查扫码状态" }).click();
      await page.getByRole("button", { name: "确认绑定此网易云账号" }).click();
      await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "我的房间", exact: true }).click();
      await page.getByRole("link", { name: "创建房间", exact: true }).click();
      await page.getByLabel("房间名称").fill("离线重建房");
      await page.getByLabel("我的房间昵称").fill("房主");
      await page.getByRole("checkbox", { name: "确认使用此网易云账号创建房间" }).check();
      await page.getByRole("button", { name: "创建并进入房间" }).click();

      // 1. 创建初始公共歌单
      await expect(page.getByRole("heading", { name: "尚未创建公共歌单" })).toBeVisible();
      await page.getByRole("button", { name: "创建公共歌单" }).click();
      await expect.poll(async () => {
        const res = await page.request.get(`${page.url().replace("/rooms/", "/api/rooms/")}/public-playlist`);
        return (await res.json()).playlist?.id;
      }, { timeout: 15_000 }).toBe("cloud-pl-v1");

      await page.getByRole("button", { name: "更新状态" }).click();
      await expect(page.getByRole("heading", { name: "songroom-离线重建房-公共" })).toBeVisible();
      await expect(page.getByRole("button", { name: "刷新歌单" })).toBeVisible();

      // 2. 模拟网易云端歌单被删除，用户点击刷新歌单
      playlistState = "deleted";
      await page.getByRole("button", { name: "刷新歌单" }).click();

      // 3. 验证页面更新为已确认失效，并出现重新创建按钮
      await expect(page.getByRole("heading", { name: "公共歌单已确认失效" })).toBeVisible();
      await expect(page.getByRole("button", { name: "重新创建公共歌单" })).toBeVisible();

      // 4. 房主点击重新创建公共歌单
      playlistState = "recreated";
      await page.getByRole("button", { name: "重新创建公共歌单" }).click();
      await expect.poll(async () => {
        const res = await page.request.get(`${page.url().replace("/rooms/", "/api/rooms/")}/public-playlist`);
        return (await res.json()).playlist?.id;
      }, { timeout: 15_000 }).toBe("cloud-pl-v2");

      // 5. 更新状态验证新歌单绑定生效
      await page.getByRole("button", { name: "更新状态" }).click();
      await expect(page.getByText("cloud-pl-v2")).toBeVisible();
      await expect(page.getByRole("button", { name: /创建公共歌单|重新创建公共歌单/ })).toHaveCount(0);
    } finally {
      await app?.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
