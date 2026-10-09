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

test.describe("独立点歌面板抽屉与交互正反馈", () => {
  test("点击「+ 点歌」呼出专用抽屉，搜索选择单曲，提交微加载，成功弹出 Toast 并自动收起抽屉高亮新歌，并在 320px-1440px 无溢出", async ({ page }) => {
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
          hasMore: false,
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

      // 验证已有点歌人标签展示与列表表头清晰边界
      await expect(page.locator(".requester-capsule").filter({ hasText: "房主" })).toBeVisible();
      await expect(page.getByRole("region", { name: "歌曲列表表头" })).toBeVisible();

      // 验证主页面上不再常驻易混淆的直接搜索栏
      await expect(page.locator(".sticky-search-toolbar")).toHaveCount(0);

      // 右上角醒目的「+ 点歌」主操作按钮可见
      const openDrawerButton = page.getByRole("button", { name: "+ 点歌" });
      await expect(openDrawerButton).toBeVisible();

      // 点击打开专用点歌抽屉
      await openDrawerButton.click();
      const drawer = page.getByRole("dialog", { name: "网易云点歌" });
      await expect(drawer).toBeVisible();

      // 输入搜索关键词并提交
      const searchInput = drawer.getByPlaceholder("输入歌名或歌手直接点歌…");
      await searchInput.fill("周杰伦");
      await drawer.getByRole("button", { name: "搜索" }).click();

      // 候选歌曲出现
      await expect(drawer.getByText("七里香").first()).toBeVisible();
      await expect(drawer.getByText("夜曲")).toBeVisible();

      // 键盘导航选择单曲
      const candidateItem = drawer.getByRole("option", { name: /七里香/ });
      await candidateItem.focus();
      await page.keyboard.press("Enter");

      // 选歌卡片出现，展示确认点歌与取消选择
      await expect(drawer.getByRole("region", { name: "已选单曲" })).toBeVisible();
      const confirmButton = drawer.getByRole("button", { name: "确认点歌" });
      await expect(confirmButton).toBeVisible();

      // 确认点歌
      await confirmButton.click();

      // 成功反馈 Toast 弹出、抽屉自动收起，并在公共歌单中平滑高亮新入单歌曲
      await expect(page.getByText("点歌成功！")).toBeVisible();
      await expect(drawer).not.toBeVisible();
      await expect(page.locator(".track-item-highlighted .requester-capsule")).toHaveText("室友小明");
      await expect(page.locator(".track-item-highlighted")).toBeVisible();

      // 验证 320px-1440px 无横向滚动溢出
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test("抽屉内搜索可取消并不影响云端", async ({ page }) => {
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
          hasMore: false,
          errorCode: null
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);

    // 空歌单状态下点击右上角或卡片中「+ 点歌」
    await page.getByRole("button", { name: "+ 点歌" }).first().click();
    const drawer = page.getByRole("dialog", { name: "网易云点歌" });
    await expect(drawer).toBeVisible();

    const searchInput = drawer.getByPlaceholder("输入歌名或歌手直接点歌…");
    await searchInput.fill("待取消");
    await drawer.getByRole("button", { name: "搜索" }).click();

    await expect(drawer.getByText("待取消的歌")).toBeVisible();

    // 点击取消搜索
    await drawer.getByRole("button", { name: "取消搜索" }).click();

    // 候选列表消失，并调用了 DELETE
    await expect(drawer.getByText("待取消的歌")).not.toBeVisible();
    expect(deleteCalled).toBe(true);

    // 按 Esc 键可关闭抽屉
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
  });

  test("遇到排队或限流风控时提供人性化温和提示而非系统错误代码", async ({ page }) => {
    await setupRoomPage(page);

    const initialView: PublicPlaylistView = {
      playlist: basePlaylist,
      snapshot: {
        version: 1,
        syncedAt: Date.now(),
        trackCount: 1,
        tracks: [{ position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: [] }]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPublicPlaylist", "requestSong"],
      disabledReason: null,
      version: 1
    };

    await page.route(playlistEndpoint, route => route.fulfill({ json: initialView }));

    // 模拟搜索因队列满返回 UPSTREAM_QUEUE_FULL 业务码
    const searchId = v7();
    await page.route(searchEndpoint, route => route.fulfill({ status: 202, json: { searchId } }));
    await page.route(`${searchEndpoint}/${searchId}`, route => {
      return route.fulfill({
        status: 200,
        json: {
          searchId,
          status: "failed",
          songs: [],
          hasMore: true,
          errorCode: "UPSTREAM_QUEUE_FULL"
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "+ 点歌" }).click();
    const drawer = page.getByRole("dialog", { name: "网易云点歌" });
    await expect(drawer).toBeVisible();

    const searchInput = drawer.getByPlaceholder("输入歌名或歌手直接点歌…");
    await searchInput.fill("任意歌曲");
    await drawer.getByRole("button", { name: "搜索" }).click();

    // 验证出现温和人性化提示，而不是生硬的 UPSTREAM_QUEUE_FULL
    await expect(drawer.getByText("当前点歌的小伙伴较多，通道正在有序排队中，请稍候片刻再试。")).toBeVisible();
    await expect(drawer.getByText("UPSTREAM_QUEUE_FULL")).toHaveCount(0);
  });
});

function candidates(start: number, length = 20) {
  return Array.from({ length }, (_, index) => ({ id: `page-${start + index}`, name: `分页歌曲${start + index}`, artists: ["分页歌手"], album: "分页专辑" }));
}

async function setupSearchDrawer(page: import("@playwright/test").Page) {
  await setupRoomPage(page);
  await page.route(playlistEndpoint, route => route.fulfill({ json: {
    playlist: basePlaylist,
    snapshot: { version: 1, syncedAt: Date.now(), trackCount: 0, tracks: [] },
    lastRefreshError: null, operation: null,
    allowedActions: ["refreshPublicPlaylist", "requestSong"], disabledReason: null, version: 1
  } }));
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "+ 点歌" }).first().click();
  return page.getByRole("dialog", { name: "网易云点歌" });
}

test("搜索首次20首且不预取；分页失败保留列表和位置，重试去重追加并停止加载", async ({ page }) => {
  const searchId = v7();
  const first = candidates(0);
  let view = { searchId, status: "completed", songs: first, hasMore: true, errorCode: null as string | null };
  let moreCalls = 0;
  let releaseMore!: () => void;
  let moreEntered = false;
  await page.route(searchEndpoint, route => route.fulfill({ status: 202, json: { searchId } }));
  await page.route(`${searchEndpoint}/${searchId}`, route => route.fulfill({ json: view }));
  await page.route(`${searchEndpoint}/${searchId}/more`, async route => {
    moreCalls += 1;
    if (moreCalls === 1) {
      moreEntered = true;
      await new Promise<void>(resolve => { releaseMore = resolve; });
      view = { ...view, status: "failed", errorCode: "MODULE_ERROR" };
    } else {
      // 上游跨页重复歌曲；服务端读模型已经按ID去重。
      view = { ...view, status: "completed", songs: candidates(0, 38), hasMore: false, errorCode: null };
    }
    await route.fulfill({ status: 202, json: { searchId } });
  });

  const drawer = await setupSearchDrawer(page);
  await drawer.getByRole("searchbox").fill("分页歌手");
  await drawer.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(drawer.getByRole("option")).toHaveCount(20);
  await expect(drawer.getByText("已加载 20 首候选歌曲")).toBeVisible();
  expect(moreCalls).toBe(0);
  const list = drawer.getByRole("listbox", { name: "搜索候选列表" });
  await list.evaluate(element => { element.scrollTop = 260; });
  const position = await list.evaluate(element => element.scrollTop);
  await drawer.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect.poll(() => moreEntered).toBe(true);
  await expect(drawer.getByRole("button", { name: "加载中…", exact: true })).toBeDisabled();
  await expect(drawer.getByRole("option")).toHaveCount(20);
  expect(await list.evaluate(element => element.scrollTop)).toBe(position);
  releaseMore();
  await expect(drawer.getByRole("button", { name: "重试加载更多" })).toBeVisible();
  await expect(drawer.getByRole("option")).toHaveCount(20);
  expect(await list.evaluate(element => element.scrollTop)).toBe(position);
  expect(moreCalls).toBe(1);
  await drawer.getByRole("button", { name: "重试加载更多" }).click();
  await expect(drawer.getByRole("option")).toHaveCount(38);
  await expect(drawer.getByText("已加载 38 首候选歌曲")).toBeVisible();
  await expect(drawer.getByRole("option", { name: /分页歌曲18 / })).toHaveCount(1);
  await expect(drawer.getByText("没有更多结果了。")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
  expect(moreCalls).toBe(2);
});

test("新关键词提交立即清空候选和选择，旧分页晚到失败不会覆盖新轮结果", async ({ page }) => {
  const oldId = v7();
  const newId = v7();
  let releaseOldPage!: () => void;
  let oldPageStarted = false;
  let releaseNewSearch!: () => void;
  let newSearchStarted = false;
  let oldQueryReads = 0;
  await page.route(searchEndpoint, async route => {
    const query = route.request().postDataJSON().query;
    if (query === "新关键词") {
      newSearchStarted = true;
      await new Promise<void>(resolve => { releaseNewSearch = resolve; });
    }
    await route.fulfill({ status: 202, json: { searchId: query === "新关键词" ? newId : oldId } });
  });
  await page.route(`${searchEndpoint}/${oldId}`, route => {
    oldQueryReads += 1;
    return route.fulfill({ json: { searchId: oldId, status: "completed", songs: candidates(0), hasMore: true, errorCode: null } });
  });
  await page.route(`${searchEndpoint}/${newId}`, route => route.fulfill({ json: {
    searchId: newId, status: "completed", songs: [{ id: "new-song", name: "新轮独有歌曲", artists: ["新歌手"], album: "" }], hasMore: false, errorCode: null
  } }));
  await page.route(`${searchEndpoint}/${oldId}/more`, async route => {
    oldPageStarted = true;
    await new Promise<void>(resolve => { releaseOldPage = resolve; });
    await route.fulfill({ status: 409, json: { error: { code: "ACCOUNT_PAUSED" } } });
  });
  const drawer = await setupSearchDrawer(page);
  const input = drawer.getByRole("searchbox");
  const submit = drawer.getByRole("button", { name: "搜索", exact: true });
  await input.fill("旧关键词");
  await submit.click();
  await expect(drawer.getByRole("option")).toHaveCount(20);
  await drawer.getByRole("option").first().click();
  await expect(drawer.getByRole("region", { name: "已选单曲" })).toBeVisible();
  // 提交另一个关键词时，无论选中单曲还是旧候选均立即清空。
  await input.fill("新关键词");
  await submit.click();
  await expect.poll(() => newSearchStarted).toBe(true);
  await expect(drawer.getByRole("region", { name: "已选单曲" })).toHaveCount(0);
  await expect(drawer.getByRole("option")).toHaveCount(0);
  releaseNewSearch();
  await expect(drawer.getByText("新轮独有歌曲")).toBeVisible();

  // 再发起旧轮分页后立刻切换新轮，验证旧分页的晚到失败隔离。
  await input.fill("旧关键词");
  await submit.click();
  await expect(drawer.getByRole("option")).toHaveCount(20);
  await drawer.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect.poll(() => oldPageStarted).toBe(true);
  await input.fill("新关键词");
  newSearchStarted = false;
  await submit.click();
  await expect.poll(() => newSearchStarted).toBe(true);
  await expect(drawer.getByRole("option")).toHaveCount(0);
  releaseNewSearch();
  await expect(drawer.getByText("新轮独有歌曲")).toBeVisible();
  const readsBeforeOldReply = oldQueryReads;
  const oldReply = page.waitForResponse(response => response.url().endsWith(`/search/${oldId}/more`));
  releaseOldPage();
  await oldReply;
  await drawer.getByRole("option").click();
  await expect(drawer.getByRole("region", { name: "已选单曲" })).toContainText("新轮独有歌曲");
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  expect(oldQueryReads).toBe(readsBeforeOldReply);
});
