import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { v7 } from "uuid";
import type { PersonalPlaylistView } from "../../src/shared/personal-playlist-contracts.js";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";

const roomId = v7();
const ownerMemberId = v7();
const roommateMemberId = v7();

const personalPlaylistEndpoint = `**/api/rooms/${roomId}/personal-playlist`;
const createEndpoint = `**/api/rooms/${roomId}/personal-playlist/create`;
const refreshEndpoint = `**/api/rooms/${roomId}/personal-playlist/refresh`;
const publicPlaylistEndpoint = `**/api/rooms/${roomId}/public-playlist`;

async function setupRoom(page: Page, isOwner = true) {
  const currentUserId = isOwner ? "user-owner" : "user-roommate";
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "session-1", userId: currentUserId, expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: currentUserId, name: isOwner ? "房主" : "室友", email: `${currentUserId}@example.com`, emailVerified: false }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: {
        room: { id: roomId, name: "测试音乐间", role: isOwner ? "owner" : "roommate", nickname: isOwner ? "房主小林" : "室友小明" },
        version: 1,
        pendingCount: 0,
        allowedActions: isOwner ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"] : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY" }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/members`, route =>
    route.fulfill({
      json: {
        version: 1,
        members: [
          {
            id: ownerMemberId,
            nickname: "房主小林",
            role: "owner",
            isSelf: isOwner,
            allowedActions: isOwner ? ["renameNickname"] : [],
            disabledReasons: isOwner ? {} : { renameNickname: "SELF_ONLY" }
          },
          {
            id: roommateMemberId,
            nickname: "室友小明",
            role: "roommate",
            isSelf: !isOwner,
            allowedActions: isOwner ? ["removeMember"] : ["renameNickname"],
            disabledReasons: {}
          }
        ],
        allowedActions: isOwner ? ["reviewApplications", "readInvite"] : [],
        disabledReasons: {}
      }
    })
  );

  const publicView: PublicPlaylistView = {
    playlist: { id: "cloud-pub-01", name: "songroom-测试音乐间-公共" },
    snapshot: {
      version: 1,
      syncedAt: Date.now() - 60000,
      trackCount: 1,
      tracks: [{ position: 0, songId: "pub-s1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: ["房主小林"] }]
    },
    lastRefreshError: null,
    operation: null,
    allowedActions: ["refreshPublicPlaylist", "requestSong"],
    disabledReason: null,
    version: 1
  };
  await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: publicView }));

  await page.route("**/api/events", route =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body: ": heartbeat\n\n"
    })
  );
}

const emptyPersonalView: PersonalPlaylistView = {
  playlist: null,
  snapshot: null,
  lastRefreshError: null,
  allowedActions: ["createPersonalPlaylist"],
  disabledReason: null,
  version: 1
};

const dedicatedPersonalView: PersonalPlaylistView = {
  playlist: {
    id: "pl-dedicated-owner",
    name: "songroom-测试音乐间-房主小林"
  },
  snapshot: {
    version: 1,
    syncedAt: Date.now() - 30000,
    trackCount: 2,
    tracks: [
      { position: 0, songId: "track-1", name: "稻香", artists: ["周杰伦"], album: "魔杰座" },
      { position: 1, songId: "track-2", name: "夜曲", artists: ["周杰伦"], album: "十一月的萧邦" }
    ]
  },
  lastRefreshError: null,
  allowedActions: ["refreshPersonalPlaylist"],
  disabledReason: null,
  version: 2
};

test.describe("统一成员专用个人歌单（工单 01）", () => {
  for (const isOwner of [true, false]) {
    test(`${isOwner ? "房主" : "室友"}主动创建本房间专用个人歌单，不提供旧来源绑定或直接点歌引导`, async ({ page }) => {
      await setupRoom(page, isOwner);
      const createdView: PersonalPlaylistView = {
        ...dedicatedPersonalView,
        playlist: {
          ...dedicatedPersonalView.playlist!,
          id: isOwner ? "pl-dedicated-owner" : "pl-dedicated-roommate",
          name: isOwner ? "songroom-测试音乐间-房主小林" : "songroom-测试音乐间-室友小明"
        }
      };
      let currentView = emptyPersonalView;
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: currentView }));
      await page.route(refreshEndpoint, route => route.fulfill({ json: currentView }));
      let createPayload: unknown;
      await page.route(createEndpoint, async route => {
        createPayload = route.request().postDataJSON();
        currentView = createdView;
        await route.fulfill({ json: currentView });
      });

      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "我的歌单", exact: true }).click();
      await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
      await expect(page.getByText(/不影响你直接搜索点歌/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /绑定个人歌单|更换歌单|解除绑定/ })).toHaveCount(0);
      await page.getByRole("button", { name: "创建专用个人歌单" }).click();
      await expect(page.getByRole("heading", { name: createdView.playlist!.name })).toBeVisible();
      expect(createPayload).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      await expect(page.getByText("专用歌单", { exact: true })).toBeVisible();
      await expect(page.getByText("可维护", { exact: true })).toBeVisible();
      await expect(page.getByText("稻香", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "创建专用个人歌单" })).toHaveCount(0);
    });
  }

  for (const isOwner of [true, false]) {
    test(`${isOwner ? "房主" : "室友"}在房主授权不可用时看到原因，不能创建个人歌单`, async ({ page }) => {
      await setupRoom(page, isOwner);
      await page.route(personalPlaylistEndpoint, route => route.fulfill({
        json: { ...emptyPersonalView, allowedActions: [], disabledReason: "NETEASE_AUTH_REQUIRED" }
      }));
      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "我的歌单", exact: true }).click();
      await expect(page.getByText("房主网易云授权不可用，请等待房主完成授权。")).toBeVisible();
      await expect(page.getByRole("button", { name: /创建专用个人歌单|绑定个人歌单/ })).toHaveCount(0);
    });
  }

  test("创建结果待确认时切页和刷新保留状态，不提供重复创建", async ({ page }) => {
    await setupRoom(page, false);
    let currentView: PersonalPlaylistView = emptyPersonalView;
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: currentView }));
    await page.route(createEndpoint, async route => {
      currentView = {
        ...emptyPersonalView,
        allowedActions: [],
        disabledReason: "OPERATION_PENDING",
        operation: { id: v7(), status: "awaitingConfirmation", step: "sending", errorCode: "DEADLINE", version: 2 }
      };
      await route.fulfill({ json: currentView });
    });
    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await page.getByRole("button", { name: "创建专用个人歌单" }).click();
    const pendingMessage = "创建结果待确认，可能已在网易云创建。请勿重复创建。";
    await expect(page.getByText(pendingMessage)).toBeVisible();
    await expect(page.getByRole("button", { name: "创建专用个人歌单" })).toHaveCount(0);
    await page.getByRole("button", { name: "房间设置" }).click();
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await expect(page.getByText(pendingMessage)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await expect(page.getByText(pendingMessage)).toBeVisible();
    await expect(page.getByText("创建明确失败，请重试。")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "创建专用个人歌单" })).toHaveCount(0);
  });

  test("未知创建结果要求管理员处理，不能当作明确失败重试", async ({ page }) => {
    await setupRoom(page);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({
      json: {
        ...emptyPersonalView,
        allowedActions: [],
        disabledReason: "OPERATION_PENDING",
        operation: { id: v7(), status: "needsAdministrator", step: "unknown", errorCode: "MODULE_ERROR", version: 3 }
      }
    }));
    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await expect(page.getByText("创建结果未知，需要管理员处理。")).toBeVisible();
    await expect(page.getByText("创建明确失败，请重试。")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "创建专用个人歌单" })).toHaveCount(0);
  });

  for (const isOwner of [true, false]) {
    test(`${isOwner ? "房主" : "室友"}查看其他成员专用个人歌单只有只读歌曲，无维护或点歌入口`, async ({ page }) => {
      await setupRoom(page, isOwner);
      const memberId = isOwner ? roommateMemberId : ownerMemberId;
      const nickname = isOwner ? "室友小明" : "房主小林";
      const view: PersonalPlaylistView = {
        ...dedicatedPersonalView,
        playlist: { ...dedicatedPersonalView.playlist!, name: `songroom-测试音乐间-${nickname}` },
        allowedActions: ["refreshPersonalPlaylist"]
      };
      const memberEndpoint = `**/api/rooms/${roomId}/members/${memberId}/personal-playlist`;
      await page.route(memberEndpoint, route => route.fulfill({ json: view }));
      await page.route(`${memberEndpoint}/refresh`, route => route.fulfill({ json: view }));
      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "房间成员" }).click();
      await page.getByRole("button", { name: `查看成员：${nickname}` }).click();
      const detail = page.getByRole("region", { name: "成员详情", exact: true });
      await expect(detail.getByRole("heading", { name: nickname, exact: true })).toBeVisible();
      await expect(detail.getByText(`songroom-测试音乐间-${nickname}`, { exact: true })).toBeVisible();
      await expect(detail.getByText("专用（仅本人可维护）")).toBeVisible();
      await expect(detail.getByText("稻香", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: /创建|绑定|解绑|更换|同步|点歌|添加|删除/ })).toHaveCount(0);
    });
  }

  for (const width of [320, 900, 1440]) {
    test(`${width}px 我的专用歌单复用现有四入口导航，无横向溢出且通过 Axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setupRoom(page);
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: dedicatedPersonalView }));
      await page.route(refreshEndpoint, route => route.fulfill({ json: dedicatedPersonalView }));
      await page.goto(`/rooms/${roomId}`);
      const nav = page.getByRole("navigation", { name: "房间导航" });
      await expect(nav.getByRole("button")).toHaveText(["搜索歌曲", "公共歌单", "我的歌单", "房间成员", "房间设置"]);
      await nav.getByRole("button", { name: "我的歌单" }).click();
      await expect(nav.getByRole("button", { name: "我的歌单" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "songroom-测试音乐间-房主小林" })).toBeVisible();
      await expect(page.getByText("共 2 首歌曲")).toBeVisible();
      await expect(page.getByText("夜曲", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /绑定个人歌单|解除绑定|更换歌单/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const axeResults = await new AxeBuilder({ page })
        .include(".room-workspace")
        .disableRules(["color-contrast"])
        .analyze();
      expect(axeResults.violations).toEqual([]);
    });
  }
});
