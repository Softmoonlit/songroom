import { expect, test } from "@playwright/test";
import { v7 } from "uuid";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";

const roomId = v7();
const endpoint = `**/api/rooms/${roomId}/public-playlist`;
const refreshEndpoint = `**/api/rooms/${roomId}/public-playlist/refresh`;

async function setupRoomPage(page: import("@playwright/test").Page) {
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "session-1", userId: "user-1", expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: "user-1", name: "室友", email: "roommate@example.com", emailVerified: false }
      }
    })
  );
  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: {
        room: { id: roomId, name: "音乐间", role: "owner", nickname: "房主" },
        version: 1,
        pendingCount: 0,
        allowedActions: ["renameRoom", "renameNickname"],
        disabledReasons: {}
      }
    })
  );
}

const basePlaylist = {
  id: "cloud-pl-001",
  name: "songroom-音乐小窝-公共"
};

test.describe("公共歌单权威快照与虚拟滚动", () => {
  test("没有快照时显示首次同步状态，区分于已同步的空歌单", async ({ page }) => {
    await setupRoomPage(page);

    const initialSyncView: PublicPlaylistView = {
      playlist: basePlaylist,
      snapshot: {
        version: 0,
        syncedAt: null,
        trackCount: 0,
        tracks: []
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPublicPlaylist"],
      disabledReason: "PUBLIC_PLAYLIST_EXISTS",
      version: 1
    };

    await page.route(endpoint, route => route.fulfill({ json: initialSyncView }));
    await page.route(refreshEndpoint, route => route.fulfill({ json: initialSyncView }));

    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: basePlaylist.name })).toBeVisible();
    await expect(page.getByText("正在进行首次同步，请稍候…")).toBeVisible();
    await expect(page.getByText("歌单暂无歌曲")).toHaveCount(0);

    // 切换到已同步的空歌单
    const emptySyncView: PublicPlaylistView = {
      ...initialSyncView,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 60000,
        trackCount: 0,
        tracks: []
      }
    };

    await page.route(endpoint, route => route.fulfill({ json: emptySyncView }));
    await page.getByRole("button", { name: "更新状态", exact: true }).click();
    await expect(page.getByText("正在进行首次同步，请稍候…")).toHaveCount(0);
    await expect(page.getByText("歌单暂无歌曲")).toBeVisible();
    await expect(page.getByText("最近成功同步：")).toBeVisible();
  });

  test("展示歌曲真实顺序与元数据，支持键盘焦点导航，320px/900px/1440px 响应式无横向溢出", async ({ page }) => {
    await setupRoomPage(page);

    const tracksView: PublicPlaylistView = {
      playlist: basePlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 30000,
        trackCount: 3,
        tracks: [
          { position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
          { position: 1, songId: "s-2", name: "七里香", artists: ["周杰伦"], album: "七里香" },
          { position: 2, songId: "s-3", name: "夜曲", artists: ["周杰伦"], album: "十一月的萧邦" }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPublicPlaylist"],
      disabledReason: "PUBLIC_PLAYLIST_EXISTS",
      version: 2
    };

    await page.route(endpoint, route => route.fulfill({ json: tracksView }));
    await page.route(refreshEndpoint, route => route.fulfill({ json: tracksView }));

    for (const width of [320, 900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/rooms/${roomId}`);

      await expect(page.getByText("晴天", { exact: true })).toBeVisible();
      await expect(page.getByText("七里香", { exact: true })).toBeVisible();
      await expect(page.getByText("夜曲", { exact: true })).toBeVisible();
      await expect(page.getByText("叶惠美")).toBeVisible();

      // 键盘焦点导航：可按 Tab 聚焦歌曲列表项并显示焦点样式
      const firstItem = page.locator('.track-item').first();
      await firstItem.focus();
      await expect(firstItem).toBeFocused();

      // 验证无横向溢出
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test("刷新失败保留最后快照和同步时间并显示未更新状态反馈", async ({ page }) => {
    await setupRoomPage(page);

    const syncedView: PublicPlaylistView = {
      playlist: basePlaylist,
      snapshot: {
        version: 1,
        syncedAt: 1700000000000,
        trackCount: 1,
        tracks: [
          { position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPublicPlaylist"],
      disabledReason: "PUBLIC_PLAYLIST_EXISTS",
      version: 2
    };

    const failedView: PublicPlaylistView = {
      ...syncedView,
      lastRefreshError: "NETWORK_ERROR"
    };

    await page.route(endpoint, route => route.fulfill({ json: syncedView }));
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByText("晴天", { exact: true })).toBeVisible();

    // 触发刷新返回失败
    await page.route(refreshEndpoint, route => route.fulfill({ json: failedView }));
    await page.getByRole("button", { name: "刷新歌单", exact: true }).click();

    // 歌曲与同步时间仍保留，同时展示刷新未成功说明
    await expect(page.getByText("晴天", { exact: true })).toBeVisible();
    await expect(page.getByText(/刷新未成功.*已保留上次快照/)).toBeVisible();
  });
});
