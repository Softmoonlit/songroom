import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { v7 } from "uuid";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";
import type {
  PersonalPlaylistView,
  PersonalSongAddResponse,
  PersonalSongOperationView
} from "../../src/shared/personal-playlist-contracts.js";
import type { SearchView, SearchInitiatedResponse } from "../../src/shared/song-search-contracts.js";

const roomId = v7();
const publicPlaylistEndpoint = `**/api/rooms/${roomId}/public-playlist`;
const personalPlaylistEndpoint = `**/api/rooms/${roomId}/personal-playlist`;
const searchInitiateEndpoint = `**/api/rooms/${roomId}/search`;
const personalSongAddEndpoint = `**/api/rooms/${roomId}/personal-playlist/songs`;

async function setupRoom(page: import("@playwright/test").Page, role: "owner" | "roommate" = "roommate") {
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "session-1", userId: "user-1", expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: "user-1", name: role === "owner" ? "房主小林" : "室友小明", email: "user@example.com", emailVerified: false }
      }
    })
  );
  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: {
        room: { id: roomId, name: "测试音乐间", role, nickname: role === "owner" ? "房主小林" : "室友小明" },
        version: 1,
        pendingCount: 0,
        allowedActions: role === "owner" ? ["renameRoom", "renameNickname"] : ["renameNickname"],
        disabledReasons: {}
      }
    })
  );
  await page.route("**/api/rooms", route =>
    route.fulfill({
      json: {
        rooms: [
          {
            id: roomId,
            name: "测试音乐间",
            role,
            nickname: role === "owner" ? "房主小林" : "室友小明",
            version: 1,
            allowedActions: ["enterRoom"],
            disabledReasons: {}
          }
        ],
        allowedActions: ["openCreateRoom", "openJoin"],
        disabledReasons: {}
      }
    })
  );
  // 模拟 SSE 连接
  await page.route("**/api/events", route =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body: ": heartbeat\n\n"
    })
  );
}

const mockCandidates = [
  { id: "song-101", name: "晴天", artists: ["周杰伦"], album: "叶惠美" },
  { id: "song-102", name: "七里香", artists: ["周杰伦"], album: "七里香" },
  { id: "song-103", name: "稻香", artists: ["周杰伦"], album: "魔杰座" }
];

test.describe("搜索歌曲独立页面与个人歌单点歌 (工单 04)", () => {
  for (const width of [320, 375, 1440]) {
    test(`${width}px 导航依次为五标签，默认进入「搜索歌曲」，无横向溢出且通过 Axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setupRoom(page, "owner");

      const emptyPersonal: PersonalPlaylistView = {
        playlist: null,
        snapshot: null,
        lastRefreshError: null,
        operation: null,
        allowedActions: ["createPersonalPlaylist"],
        disabledReason: null,
        version: 1
      };
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonal }));

      await page.goto(`/rooms/${roomId}`);

      // 验证导航五标签顺序与默认激活
      const nav = page.getByRole("navigation", { name: "房间导航" });
      await expect(nav.getByRole("button")).toHaveText(["搜索歌曲", "公共歌单", "我的歌单", "房间成员", "房间设置"]);
      await expect(nav.getByRole("button", { name: "搜索歌曲" })).toHaveAttribute("aria-current", "page");

      // 验证搜索歌曲页面主标题
      await expect(page.getByRole("heading", { name: "搜索歌曲", exact: true })).toBeVisible();

      // 验证移动端及桌面端均无横向溢出
      const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(hasHorizontalScroll).toBe(false);

      // 无障碍违规检查
      const axe = await new AxeBuilder({ page }).include(".room-workspace").disableRules(["color-contrast"]).analyze();
      expect(axe.violations).toEqual([]);
    });
  }

  test("未配置个人歌单：可正常搜索，添加按钮禁用并说明原因，提供前往配置入口，不自动创建", async ({ page }) => {
    await setupRoom(page, "roommate");

    const emptyPersonal: PersonalPlaylistView = {
      playlist: null,
      snapshot: null,
      lastRefreshError: null,
      operation: null,
      allowedActions: ["createPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonal }));

    const searchId = v7();
    await page.route(searchInitiateEndpoint, route =>
      route.fulfill({ json: { searchId } satisfies SearchInitiatedResponse })
    );
    await page.route(`**/api/rooms/${roomId}/search/${searchId}`, route =>
      route.fulfill({
        json: {
          searchId,
          version: 1,
          status: "completed",
          songs: mockCandidates,
          hasMore: false,
          errorCode: null
        } satisfies SearchView
      })
    );

    await page.goto(`/rooms/${roomId}`);

    // 展示未配置个人歌单提示条
    const missingBanner = page.getByRole("status", { name: "未配置个人歌单提示" });
    await expect(missingBanner).toBeVisible();
    await expect(missingBanner.getByText("尚未配置个人歌单")).toBeVisible();
    await expect(missingBanner.getByRole("button", { name: "前往我的歌单" })).toBeVisible();

    // 进行歌曲搜索
    const searchInput = page.getByRole("searchbox", { name: "搜索歌曲" });
    await searchInput.fill("周杰伦");
    await page.getByRole("button", { name: "搜索", exact: true }).click();

    // 搜索出结果列表
    await expect(page.getByText("找到 3 首候选歌曲")).toBeVisible();
    await expect(page.getByText("晴天", { exact: true })).toBeVisible();
    await expect(page.getByText("七里香", { exact: true })).toBeVisible();

    // 候选歌曲的添加按钮全部禁用
    const addBtn1 = page.getByRole("button", { name: "添加《晴天》（尚未配置个人歌单）" });
    await expect(addBtn1).toBeVisible();
    await expect(addBtn1).toBeDisabled();

    // 点击「前往我的歌单」跳转到我的歌单标签页
    await missingBanner.getByRole("button", { name: "前往我的歌单" }).click();
    await expect(page.getByRole("button", { name: "我的歌单" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
    await expect(page.getByRole("button", { name: "创建专用个人歌单" })).toBeVisible();
  });

  test("已配置个人歌单：逐首添加不弹确认框，已存在提示已在个人歌单，新歌添加提示已加入", async ({ page }) => {
    await setupRoom(page, "roommate");

    let personalTracks = [
      { position: 0, songId: "song-101", name: "晴天", artists: ["周杰伦"], album: "叶惠美" }
    ];

    const personalView: PersonalPlaylistView = {
      playlist: { id: "pl-personal-1", name: "songroom-测试音乐间-室友小明" },
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 5000,
        trackCount: personalTracks.length,
        tracks: personalTracks
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };

    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));

    const searchId = v7();
    await page.route(searchInitiateEndpoint, route =>
      route.fulfill({ json: { searchId } satisfies SearchInitiatedResponse })
    );
    await page.route(`**/api/rooms/${roomId}/search/${searchId}`, route =>
      route.fulfill({
        json: {
          searchId,
          version: 1,
          status: "completed",
          songs: mockCandidates,
          hasMore: false,
          errorCode: null
        } satisfies SearchView
      })
    );

    let addedSongId = "";
    await page.route(personalSongAddEndpoint, route => {
      const body = route.request().postDataJSON() as { songId: string; name: string };
      addedSongId = body.songId;
      const op: PersonalSongOperationView = {
        id: v7(),
        roomId,
        songId: body.songId,
        name: body.name,
        artists: ["周杰伦"],
        album: "叶惠美",
        status: "succeeded",
        songConfirmed: true,
        action: "add",
        errorCode: null,
        step: "succeeded",
        version: 1
      };
      return route.fulfill({ json: { replay: false, operation: op } satisfies PersonalSongAddResponse });
    });

    await page.goto(`/rooms/${roomId}`);

    // 未配置提示不应显示
    await expect(page.getByRole("status", { name: "未配置个人歌单提示" })).toHaveCount(0);

    // 搜索
    await page.getByRole("searchbox", { name: "搜索歌曲" }).fill("周杰伦");
    await page.keyboard.press("Enter");

    await expect(page.getByText("找到 3 首候选歌曲")).toBeVisible();

    // 1. 点击已在个人歌单的《晴天》
    const addQingtianBtn = page.getByRole("button", { name: "添加《晴天》到个人歌单" });
    await expect(addQingtianBtn).toBeEnabled();
    await addQingtianBtn.click();
    expect(addedSongId).toBe("song-101");
    // 提示已在个人歌单
    await expect(page.getByText("《晴天》已在个人歌单")).toBeVisible();

    // 2. 点击新歌《七里香》
    const addQilixiangBtn = page.getByRole("button", { name: "添加《七里香》到个人歌单" });
    await expect(addQilixiangBtn).toBeEnabled();
    await addQilixiangBtn.click();
    expect(addedSongId).toBe("song-102");
    // 提示已加入个人歌单
    await expect(page.getByText("《七里香》已加入个人歌单")).toBeVisible();

    // 依然停留在搜索页，现场未丢失
    await expect(page.getByRole("heading", { name: "搜索歌曲", exact: true })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "搜索歌曲" })).toHaveValue("周杰伦");
  });

  test("异步添加操作排队与待确认状态真实区分，在途横幅与微加载反馈", async ({ page }) => {
    await setupRoom(page, "roommate");

    const personalView: PersonalPlaylistView = {
      playlist: { id: "pl-personal-1", name: "songroom-测试音乐间-室友小明" },
      snapshot: { version: 1, syncedAt: Date.now() - 5000, trackCount: 0, tracks: [] },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));

    const searchId = v7();
    await page.route(searchInitiateEndpoint, route => route.fulfill({ json: { searchId } }));
    await page.route(`**/api/rooms/${roomId}/search/${searchId}`, route =>
      route.fulfill({
        json: {
          searchId,
          version: 1,
          status: "completed",
          songs: [mockCandidates[0]],
          hasMore: false,
          errorCode: null
        }
      })
    );

    const operationId = v7();
    let currentOpStatus: "queued" | "awaitingConfirmation" | "succeeded" = "queued";

    await page.route(personalSongAddEndpoint, route => {
      const op: PersonalSongOperationView = {
        id: operationId,
        roomId,
        songId: "song-101",
        name: "晴天",
        artists: ["周杰伦"],
        album: "叶惠美",
        status: "queued",
        songConfirmed: false,
        action: "add",
        errorCode: null,
        step: "ready",
        version: 1
      };
      return route.fulfill({ json: { replay: false, operation: op } });
    });

    await page.route(`**/api/rooms/${roomId}/personal-playlist/songs/${operationId}`, route => {
      const op: PersonalSongOperationView = {
        id: operationId,
        roomId,
        songId: "song-101",
        name: "晴天",
        artists: ["周杰伦"],
        album: "叶惠美",
        status: currentOpStatus,
        songConfirmed: currentOpStatus === "succeeded",
        action: "add",
        errorCode: null,
        step: currentOpStatus === "succeeded" ? "succeeded" : currentOpStatus === "awaitingConfirmation" ? "confirming" : "ready",
        version: currentOpStatus === "succeeded" ? 2 : 1
      };
      return route.fulfill({ json: op });
    });

    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("searchbox", { name: "搜索歌曲" }).fill("晴天");
    await page.getByRole("button", { name: "搜索", exact: true }).click();

    // 点击添加
    await page.getByRole("button", { name: "添加《晴天》到个人歌单" }).click();

    // 出现排队状态横幅
    await expect(page.getByText("《晴天》已排队，等待添加到个人歌单…")).toBeVisible();

    // 变更为 awaitingConfirmation
    currentOpStatus = "awaitingConfirmation";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("《晴天》添加结果待确认，正在核验网易云歌单，请勿重复添加。")).toBeVisible();

    // 页面刷新：搜索输入被清空，但在途未完成添加操作跨刷新从 sessionStorage 恢复
    await page.reload();
    await expect(page.getByRole("searchbox", { name: "搜索歌曲" })).toHaveValue("");
    await expect(page.getByText("《晴天》添加结果待确认，正在核验网易云歌单，请勿重复添加。")).toBeVisible();

    // 变更为 succeeded
    currentOpStatus = "succeeded";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("《晴天》已加入个人歌单")).toBeVisible();
  });

  test("同房间切换全部一级标签页后保留搜索现场与浏览位置；离开房间重新进入后清空", async ({ page }) => {
    await setupRoom(page, "roommate");

    const personalView: PersonalPlaylistView = {
      playlist: { id: "pl-personal-1", name: "songroom-测试音乐间-室友小明" },
      snapshot: { version: 1, syncedAt: Date.now() - 5000, trackCount: 0, tracks: [] },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPersonalPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: personalView }));

    const manySongs = Array.from({ length: 30 }, (_, i) => ({
      id: `song-${i + 1}`,
      name: `测试歌曲 ${i + 1}`,
      artists: ["测试歌手"],
      album: "测试专辑"
    }));

    const searchId = v7();
    await page.route(searchInitiateEndpoint, route => route.fulfill({ json: { searchId } }));
    await page.route(`**/api/rooms/${roomId}/search/${searchId}`, route =>
      route.fulfill({
        json: {
          searchId,
          version: 1,
          status: "completed",
          songs: manySongs,
          hasMore: true,
          errorCode: null
        }
      })
    );

    await page.goto(`/rooms/${roomId}`);

    // 在搜索页输入关键词搜索
    const searchInput = page.getByRole("searchbox", { name: "搜索歌曲" });
    await searchInput.fill("测试歌曲");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("找到 30 首候选歌曲")).toBeVisible();

    // 滚动页面一段距离
    await page.getByRole("button", { name: "加载更多" }).scrollIntoViewIfNeeded();
    const scrollPosBefore = await page.evaluate(() => window.scrollY);
    expect(scrollPosBefore).toBeGreaterThan(50);

    // 依次切换全部一级标签页
    await page.getByRole("button", { name: "公共歌单" }).click();
    await expect(page.getByRole("button", { name: "公共歌单" })).toHaveAttribute("aria-current", "page");

    await page.getByRole("button", { name: "我的歌单" }).click();
    await expect(page.getByRole("button", { name: "我的歌单" })).toHaveAttribute("aria-current", "page");

    await page.getByRole("button", { name: "房间成员" }).click();
    await expect(page.getByRole("button", { name: "房间成员" })).toHaveAttribute("aria-current", "page");

    await page.getByRole("button", { name: "房间设置" }).click();
    await expect(page.getByRole("button", { name: "房间设置" })).toHaveAttribute("aria-current", "page");

    // 切回「搜索歌曲」
    await page.getByRole("button", { name: "搜索歌曲" }).click();
    await expect(page.getByRole("button", { name: "搜索歌曲" })).toHaveAttribute("aria-current", "page");

    // 现场完全保留：搜索关键词、候选列表、加载更多按钮
    await expect(page.getByRole("searchbox", { name: "搜索歌曲" })).toHaveValue("测试歌曲");
    await expect(page.getByText("找到 30 首候选歌曲")).toBeVisible();
    await expect(page.getByRole("button", { name: "加载更多" })).toBeVisible();

    // 滚动位置恢复
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(scrollPosBefore, 1);

    // 离开房间返回房间列表
    await page.getByRole("link", { name: "返回房间列表" }).click();
    await expect(page).toHaveURL("/rooms");

    // 重新进入房间
    await page.getByRole("link", { name: "进入房间：测试音乐间" }).click();
    await expect(page).toHaveURL(`/rooms/${roomId}`);

    // 默认依然是搜索歌曲页，但现场已清空
    await expect(page.getByRole("button", { name: "搜索歌曲" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("searchbox", { name: "搜索歌曲" })).toHaveValue("");
    await expect(page.getByText("搜索并存入个人歌单")).toBeVisible();
    await expect(page.getByText("找到 30 首候选歌曲")).toHaveCount(0);
  });

  test("公共歌单页彻底移除全网点歌按钮与抽屉，保留筛选、同步、播放指示与随机换歌", async ({ page }) => {
    await setupRoom(page, "owner");

    const publicView: PublicPlaylistView = {
      playlist: { id: "pl-public-1", name: "songroom-测试音乐间-公共" },
      snapshot: {
        version: 1,
        syncedAt: Date.now() - 5000,
        trackCount: 1,
        tracks: [
          { position: 0, songId: "s-1", name: "稻香", artists: ["周杰伦"], album: "魔杰座", requesters: ["房主小林"] }
        ]
      },
      lastRefreshError: null,
      operation: null,
      allowedActions: ["refreshPublicPlaylist", "replacePublicPlaylist"],
      disabledReason: null,
      version: 1
    };
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: publicView }));

    await page.goto(`/rooms/${roomId}`);

    // 切换到「公共歌单」
    await page.getByRole("button", { name: "公共歌单" }).click();

    // 验证公共歌单功能健全
    await expect(page.getByRole("button", { name: "定位到正在播放" })).toBeVisible();
    await expect(page.getByRole("button", { name: "同步歌单" })).toBeVisible();
    await expect(page.getByRole("button", { name: "展开搜索筛选" })).toBeVisible();
    await expect(page.getByRole("button", { name: "随机换一组" })).toBeVisible();

    // 验证彻底不存在全网点歌主按钮与抽屉面板
    await expect(page.getByRole("button", { name: /网易云点歌|全网点歌|\+ 点歌/ })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "网易云点歌" })).toHaveCount(0);
  });
});
