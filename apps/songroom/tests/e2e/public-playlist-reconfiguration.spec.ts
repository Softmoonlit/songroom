import { expect, test, type Page } from "@playwright/test";
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
});
