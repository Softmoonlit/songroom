import { expect, test } from "@playwright/test";
import { v7 } from "uuid";
import type { PublicPlaylistView, SongRequestOperationView } from "../../src/shared/public-playlist-contracts.js";
import type { PersonalPlaylistView } from "../../src/shared/personal-playlist-contracts.js";

const roomId = v7();
const publicPlaylistEndpoint = `**/api/rooms/${roomId}/public-playlist`;
const personalPlaylistEndpoint = `**/api/rooms/${roomId}/personal-playlist`;
const songRequestEndpoint = `**/api/rooms/${roomId}/song-requests`;

async function setupRoomPage(page: import("@playwright/test").Page) {
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "session-1", userId: "user-1", expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: "user-1", name: "室友小明", email: "roommate@example.com", emailVerified: false }
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

const basePublicPlaylist = {
  id: "cloud-pl-public",
  name: "songroom-测试宿舍-公共"
};

const basePersonalPlaylist = {
  id: "cloud-pl-personal",
  name: "songroom-测试宿舍-室友小明"
};

test.describe("个人来源公共点歌与交互正反馈（工单 03）", () => {
  test("公共歌单未创建时，「我的歌单」中点歌按钮禁用并说明原因", async ({ page }) => {
    await setupRoomPage(page);

    // 公共歌单未创建
    const publicView: PublicPlaylistView = {
      playlist: null,
      snapshot: null,
      lastRefreshError: null,
      operation: null,
      allowedActions: [],
      disabledReason: null,
      version: 1
    };
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: publicView }));

    // 个人歌单已有歌曲
    const personalView: PersonalPlaylistView = {
      playlist: basePersonalPlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 5000,
        trackCount: 1,
        tracks: [
          { position: 0, songId: "s-101", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));
    await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: personalView }));

    await page.goto(`/rooms/${roomId}`);

    // 切换到「我的歌单」标签页
    await page.getByRole("button", { name: "我的歌单" }).click();

    // 看到个人歌单信息
    await expect(page.getByText("songroom-测试宿舍-室友小明")).toBeVisible();
    await expect(page.getByText("晴天")).toBeVisible();

    // 看到未创建公共歌单的提示
    await expect(page.getByText("房间尚未创建公共歌单，无法发起点歌。可在房主创建公共歌单后点歌。")).toBeVisible();

    // 歌曲右侧的点歌按钮应禁用
    const requestBtn = page.getByRole("button", { name: "点播《晴天》到公共歌单" });
    await expect(requestBtn).toBeVisible();
    await expect(requestBtn).toBeDisabled();
  });

  test("从我的歌单点击「点歌」，携带 sourcePlaylistId 发起请求，展示微加载、成功 Toast 并更新公共歌单", async ({ page }) => {
    await setupRoomPage(page);

    let publicTracks = [
      { position: 0, songId: "s-init", name: "稻香", artists: ["周杰伦"], album: "魔杰座", requesters: ["房主"] }
    ];

    await page.route(publicPlaylistEndpoint, route => {
      route.fulfill({
        json: {
          playlist: basePublicPlaylist,
          snapshot: {
            version: 1,
            syncedAt: Date.now() - 5000,
            trackCount: publicTracks.length,
            tracks: publicTracks
          },
          lastRefreshError: null,
          operation: null,
          allowedActions: ["refreshPublicPlaylist"],
          disabledReason: null,
          version: 1
        } as PublicPlaylistView
      });
    });

    const personalView: PersonalPlaylistView = {
      playlist: basePersonalPlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 5000,
        trackCount: 1,
        tracks: [
          { position: 0, songId: "s-101", name: "七里香", artists: ["周杰伦"], album: "七里香" }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));
    await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: personalView }));

    let interceptedPayload: any = null;
    await page.route(songRequestEndpoint, route => {
      interceptedPayload = route.request().postDataJSON();
      // 加入公共歌单
      publicTracks = [
        ...publicTracks,
        { position: 1, songId: "s-101", name: "七里香", artists: ["周杰伦"], album: "七里香", requesters: ["室友小明"] }
      ];
      return route.fulfill({
        json: {
          replay: false,
          operation: {
            id: v7(),
            roomId,
            songId: "s-101",
            name: "七里香",
            artists: ["周杰伦"],
            album: "七里香",
            status: "succeeded",
            step: "succeeded",
            errorCode: null,
            songConfirmed: true,
            tagConfirmed: true,
            version: 1
          }
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);

    // 切到我的歌单
    await page.getByRole("button", { name: "我的歌单" }).click();
    await expect(page.getByText("七里香", { exact: true })).toBeVisible();

    // 点击点歌
    const requestBtn = page.getByRole("button", { name: "点播《七里香》到公共歌单" });
    await expect(requestBtn).toBeEnabled();
    await requestBtn.click();

    // 验证发出的请求携带当前个人歌单的 sourcePlaylistId
    expect(interceptedPayload).toMatchObject({
      sourcePlaylistId: "cloud-pl-personal",
      songId: "s-101",
      name: "七里香"
    });

    // 成功 Toast 弹出
    await expect(page.getByText("《七里香》已成功加入公共歌单并记录你的标签！")).toBeVisible();

    // 切回公共歌单，验证七里香已展示，且带有“室友小明”点歌人标签
    await page.getByRole("button", { name: "公共歌单", exact: true }).click();
    await expect(page.getByText("七里香", { exact: true })).toBeVisible();
    await expect(page.getByTitle("点歌人：室友小明")).toBeVisible();
  });

  test("异步点歌排队与状态横幅展示，并在点歌中禁用其他点歌按钮防止并发冲突", async ({ page }) => {
    await setupRoomPage(page);

    await page.route(publicPlaylistEndpoint, route => {
      route.fulfill({
        json: {
          playlist: basePublicPlaylist,
          snapshot: { version: 1, syncedAt: Date.now() - 5000, trackCount: 0, tracks: [] },
          lastRefreshError: null,
          operation: null,
          allowedActions: ["refreshPublicPlaylist"],
          disabledReason: null,
          version: 1
        } as PublicPlaylistView
      });
    });

    const personalView: PersonalPlaylistView = {
      playlist: basePersonalPlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 5000,
        trackCount: 2,
        tracks: [
          { position: 0, songId: "s-101", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
          { position: 1, songId: "s-102", name: "枫", artists: ["周杰伦"], album: "十一月的萧邦" }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));
    await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: personalView }));

    const operationId = v7();
    let opStatus: SongRequestOperationView["status"] = "processing";

    await page.route(songRequestEndpoint, route => {
      return route.fulfill({
        json: {
          replay: false,
          operation: {
            id: operationId,
            roomId,
            songId: "s-101",
            name: "晴天",
            artists: ["周杰伦"],
            album: "叶惠美",
            status: opStatus,
            step: "sending",
            errorCode: null,
            songConfirmed: false,
            tagConfirmed: false,
            version: 1
          }
        }
      });
    });

    await page.route(`**/api/rooms/${roomId}/song-requests/${operationId}`, route => {
      return route.fulfill({
        json: {
          id: operationId,
          roomId,
          songId: "s-101",
          name: "晴天",
          artists: ["周杰伦"],
          album: "叶惠美",
          status: opStatus,
          step: opStatus === "succeeded" ? "succeeded" : "sending",
          errorCode: null,
          songConfirmed: opStatus === "succeeded",
          tagConfirmed: opStatus === "succeeded",
          version: 2
        } as SongRequestOperationView
      });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单" }).click();

    // 点击第一首歌的点歌
    await page.getByRole("button", { name: "点播《晴天》到公共歌单" }).click();

    // 看到正在处理的状态横幅
    await expect(page.getByText(/正在为房间添加《晴天》/)).toBeVisible();

    // 第二首歌的点歌按钮此时应被禁用
    const otherBtn = page.getByRole("button", { name: "点播《枫》到公共歌单" });
    await expect(otherBtn).toBeDisabled();

    // 推进状态到 succeeded
    opStatus = "succeeded";
    await page.waitForTimeout(3000);

    // 成功 Toast 弹出，横幅消除
    await expect(page.getByText("《晴天》点歌成功！已加入公共歌单并记录你的标签。")).toBeVisible();
    await expect(page.getByText(/正在为房间添加《晴天》/)).toHaveCount(0);
  });

  test("来源核验失败时展示友好错误提示", async ({ page }) => {
    await setupRoomPage(page);

    await page.route(publicPlaylistEndpoint, route => {
      route.fulfill({
        json: {
          playlist: basePublicPlaylist,
          snapshot: { version: 1, syncedAt: Date.now() - 5000, trackCount: 0, tracks: [] },
          lastRefreshError: null,
          operation: null,
          allowedActions: ["refreshPublicPlaylist"],
          disabledReason: null,
          version: 1
        } as PublicPlaylistView
      });
    });

    const personalView: PersonalPlaylistView = {
      playlist: basePersonalPlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 5000,
        trackCount: 1,
        tracks: [
          { position: 0, songId: "s-removed", name: "已移除的歌", artists: ["未知"], album: "未知" }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));
    await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: personalView }));

    const operationId = v7();
    await page.route(songRequestEndpoint, route => {
      return route.fulfill({
        json: {
          replay: false,
          operation: {
            id: operationId,
            roomId,
            songId: "s-removed",
            name: "已移除的歌",
            artists: ["未知"],
            album: "未知",
            status: "stopped",
            step: "stopped",
            errorCode: "SOURCE_SONG_REMOVED",
            songConfirmed: false,
            tagConfirmed: false,
            version: 1
          }
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单" }).click();

    await page.getByRole("button", { name: "点播《已移除的歌》到公共歌单" }).click();

    // 出现友好的错误提示
    await expect(page.getByText("该歌曲已从你的个人歌单中移除，无法发起点歌。")).toBeVisible();
  });

  test("在 320px、900px、1440px 视口下「我的歌单」操作区无横向滚动溢出", async ({ page }) => {
    await setupRoomPage(page);

    await page.route(publicPlaylistEndpoint, route => {
      route.fulfill({
        json: {
          playlist: basePublicPlaylist,
          snapshot: { version: 1, syncedAt: Date.now() - 5000, trackCount: 0, tracks: [] },
          lastRefreshError: null,
          operation: null,
          allowedActions: ["refreshPublicPlaylist"],
          disabledReason: null,
          version: 1
        } as PublicPlaylistView
      });
    });

    const personalView: PersonalPlaylistView = {
      playlist: basePersonalPlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 5000,
        trackCount: 3,
        tracks: [
          { position: 0, songId: "s-1", name: "晴天（长标题测试版本超长歌曲名称示范）", artists: ["周杰伦", "合唱歌手"], album: "叶惠美特别纪念版" },
          { position: 1, songId: "s-2", name: "夜曲", artists: ["周杰伦"], album: "十一月的萧邦" }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));
    await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: personalView }));

    for (const width of [320, 900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "我的歌单" }).click();

      await expect(page.getByText("专用歌单")).toBeVisible();
      await expect(page.getByRole("button", { name: "点播《晴天（长标题测试版本超长歌曲名称示范）》到公共歌单" })).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    }
  });
});
