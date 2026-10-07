import { expect, test } from "@playwright/test";
import { v7 } from "uuid";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";

const roomId = v7();
const playlistEndpoint = `**/api/rooms/${roomId}/public-playlist`;
const searchEndpoint = `**/api/rooms/${roomId}/search`;
const songRequestEndpoint = `**/api/rooms/${roomId}/song-requests`;

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
        room: { id: roomId, name: "测试宿舍", role: "roommate", nickname: "室友小明" },
        version: 1,
        pendingCount: 0,
        allowedActions: ["renameNickname"],
        disabledReasons: {}
      }
    })
  );
  // 模拟 SSE 连接
  await page.route("**/api/events", route => {
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body: ": heartbeat\n\n"
    });
  });
}

const basePlaylist = {
  id: "cloud-pl-001",
  name: "songroom-测试宿舍-公共"
};

test.describe("直接搜索与公共点歌前端交互", () => {
  test("提供吸顶直接搜索工具栏，渐进展示候选，支持键盘选择与确认点歌，并在 320px-1440px 无溢出", async ({ page }) => {
    await setupRoomPage(page);

    const initialView: PublicPlaylistView = {
      playlist: basePlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 10000,
        trackCount: 1,
        tracks: [
          { position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: ["房主"] }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPublicPlaylist", "requestSong"],
      disabledReason: null,
      version: 1
    };

    let playlistCurrentView = { ...initialView };
    await page.route(playlistEndpoint, route => route.fulfill({ json: playlistCurrentView }));

    const searchId = v7();
    // 拦截搜索提交
    await page.route(searchEndpoint, route => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 202, json: { searchId } });
      }
      return route.fallback();
    });

    // 拦截搜索查询
    await page.route(`${searchEndpoint}/${searchId}`, route => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      return route.fulfill({
        status: 200,
        json: {
          searchId,
          status: "completed",
          songs: [
            { id: "s-2", name: "七里香", artists: ["周杰伦"], album: "七里香" },
            { id: "s-3", name: "夜曲", artists: ["周杰伦"], album: "十一月的萧邦" }
          ],
          errorCode: null
        }
      });
    });

    // 拦截点歌提交
    await page.route(songRequestEndpoint, route => {
      // 点歌成功后把歌曲加到歌单快照
      playlistCurrentView = {
        ...playlistCurrentView,
        snapshot: {
          version: 2,
          syncedAt: Date.now(),
          trackCount: 2,
          tracks: [
            { position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: ["房主"] },
            { position: 1, songId: "s-2", name: "七里香", artists: ["周杰伦"], album: "七里香", requesters: ["室友小明"] }
          ]
        }
      };

      return route.fulfill({
        status: 200,
        json: {
          replay: false,
          operation: {
            id: v7(),
            roomId,
            songId: "s-2",
            name: "七里香",
            artists: ["周杰伦"],
            album: "七里香",
            status: "succeeded",
            songConfirmed: true,
            tagConfirmed: true,
            errorCode: null,
            step: "succeeded",
            version: 1
          }
        }
      });
    });

    for (const width of [320, 900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/rooms/${roomId}`);

      // 验证已有点歌人标签展示
      await expect(page.getByText("点歌人：房主")).toBeVisible();

      // 吸顶直接搜索工具栏可见
      const searchToolbar = page.getByRole("search", { name: "直接单曲搜索" });
      await expect(searchToolbar).toBeVisible();

      // 输入搜索关键词并提交
      const searchInput = page.getByPlaceholder("输入歌名或歌手直接点歌…");
      await searchInput.fill("周杰伦");
      await page.getByRole("button", { name: "搜索" }).click();

      // 候选歌曲出现
      await expect(page.getByText("七里香").first()).toBeVisible();
      await expect(page.getByText("夜曲")).toBeVisible();

      // 键盘导航选择单曲
      const candidateItem = page.getByRole("option", { name: /七里香/ });
      await candidateItem.focus();
      await page.keyboard.press("Enter");

      // 选歌卡片出现，展示确认点歌与取消选择
      await expect(page.getByRole("region", { name: "已选单曲" })).toBeVisible();
      const confirmButton = page.getByRole("button", { name: "确认点歌" });
      await expect(confirmButton).toBeVisible();

      // 确认点歌
      await confirmButton.click();

      // 成功反馈与新标签
      await expect(page.getByText("点歌成功！")).toBeVisible();
      await expect(page.getByText("点歌人：室友小明")).toBeVisible();

      // 验证 320px-1440px 无横向滚动溢出
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test("搜索可取消并不影响云端", async ({ page }) => {
    await setupRoomPage(page);

    const initialView: PublicPlaylistView = {
      playlist: basePlaylist,
      snapshot: { version: 1, syncedAt: Date.now(), trackCount: 0, tracks: [] },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPublicPlaylist", "requestSong"],
      disabledReason: null,
      version: 1
    };

    await page.route(playlistEndpoint, route => route.fulfill({ json: initialView }));

    const searchId = v7();
    let deleteCalled = false;
    await page.route(searchEndpoint, route => route.fulfill({ status: 202, json: { searchId } }));
    await page.route(`${searchEndpoint}/${searchId}`, route => {
      if (route.request().method() === "DELETE") {
        deleteCalled = true;
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      return route.fulfill({
        status: 200,
        json: {
          searchId,
          status: "completed",
          songs: [{ id: "s-cancel", name: "待取消的歌", artists: ["歌手"], album: "专辑" }],
          errorCode: null
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);
    const searchInput = page.getByPlaceholder("输入歌名或歌手直接点歌…");
    await searchInput.fill("待取消");
    await page.getByRole("button", { name: "搜索" }).click();

    await expect(page.getByText("待取消的歌")).toBeVisible();

    // 点击取消搜索
    await page.getByRole("button", { name: "取消搜索" }).click();

    // 候选列表消失，并调用了 DELETE
    await expect(page.getByText("待取消的歌")).not.toBeVisible();
    expect(deleteCalled).toBe(true);
  });
});
