import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { v7 } from "uuid";
import type {
  FavoritePlaylistCandidatesView,
  PersonalPlaylistView
} from "../../src/shared/personal-playlist-contracts.js";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";
import type { RoomMembersView } from "../../src/shared/room-contracts.js";

const roomId = v7();
const ownerMemberId = v7();
const roommateMemberId = v7();

const personalPlaylistEndpoint = `**/api/rooms/${roomId}/personal-playlist`;
const refreshEndpoint = `**/api/rooms/${roomId}/personal-playlist/refresh`;
const publicPlaylistEndpoint = `**/api/rooms/${roomId}/public-playlist`;
const membersEndpoint = `**/api/rooms/${roomId}/members`;
const candidatesEndpoint = `**/api/rooms/${roomId}/personal-playlist/candidates`;

function createMembersView(ownerHasPlaylist = false, roommateHasPlaylist = false): RoomMembersView {
  return {
    version: 1,
    members: [
      {
        id: ownerMemberId,
        nickname: "房主小林",
        role: "owner",
        isSelf: true,
        hasPersonalPlaylist: ownerHasPlaylist,
        allowedActions: [
          "renameNickname",
          "assignPersonalPlaylist",
          ...(ownerHasPlaylist ? (["unassignPersonalPlaylist"] as const) : [])
        ],
        disabledReasons: {}
      },
      {
        id: roommateMemberId,
        nickname: "室友小明",
        role: "roommate",
        isSelf: false,
        hasPersonalPlaylist: roommateHasPlaylist,
        allowedActions: [
          "removeMember",
          "assignPersonalPlaylist",
          ...(roommateHasPlaylist ? (["unassignPersonalPlaylist"] as const) : [])
        ],
        disabledReasons: {}
      }
    ],
    allowedActions: ["reviewApplications", "readInvite"],
    disabledReasons: {}
  };
}

const mockCandidates: FavoritePlaylistCandidatesView = {
  candidates: [
    {
      id: "fav-pl-jay",
      name: "周杰伦精选集",
      trackCount: 30,
      coverImgUrl: null,
      creatorNickname: "音乐达人"
    },
    {
      id: "fav-pl-eason",
      name: "陈奕迅经典粤语",
      trackCount: 25,
      coverImgUrl: null,
      creatorNickname: "粤语歌迷"
    }
  ],
  version: 1
};

const boundPersonalView: PersonalPlaylistView = {
  playlist: { id: "fav-pl-jay", name: "周杰伦精选集" },
  operation: null,
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

const emptyPersonalView: PersonalPlaylistView = {
  playlist: null,
  snapshot: null,
  lastRefreshError: null,
  allowedActions: [],
  disabledReason: null,
  version: 1
};

async function setupBaseRoom(page: Page, isOwner = true) {
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
        room: {
          id: roomId,
          name: "音乐试听间",
          role: isOwner ? "owner" : "roommate",
          nickname: isOwner ? "房主小林" : "室友小明"
        },
        version: 1,
        pendingCount: 0,
        allowedActions: isOwner
          ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"]
          : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner
          ? {}
          : { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY" }
      }
    })
  );

  const publicView: PublicPlaylistView = {
    playlist: { id: "cloud-pub-01", name: "songroom-测试-公共" },
    operation: null,
    snapshot: {
      version: 1,
      syncedAt: Date.now() - 30000,
      trackCount: 1,
      tracks: [
        { position: 0, songId: "track-pub", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: ["房主小林"] }
      ]
    },
    lastRefreshError: null,
    allowedActions: ["refreshPublicPlaylist", "requestSong"],
    disabledReason: null,
    version: 1
  };
  await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: publicView }));
  await page.route(`${publicPlaylistEndpoint}/refresh`, route => route.fulfill({ json: publicView }));
  await page.route("**/api/events*", route => route.abort());
}

test.describe("房主分配收藏歌单完整链路与状态适配 (Ticket 03)", () => {
  test("1. 未分配状态：房主与室友展示差异化文案，房主可通过【前往分配】引导快速拉起自身分配弹窗", async ({ page }) => {
    // 房主端
    await setupBaseRoom(page, true);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonalView }));
    await page.route(membersEndpoint, route => route.fulfill({ json: createMembersView(false, false) }));
    await page.route(candidatesEndpoint, route => route.fulfill({ json: mockCandidates }));

    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "点歌台", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "房间导航" });
    await nav.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
    await expect(page.getByText("你尚未为自己分配歌单")).toBeVisible();
    const goToAssignBtn = page.getByRole("button", { name: "前往分配" });
    await expect(goToAssignBtn).toBeVisible();

    await goToAssignBtn.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByText("为“房主小林”分配歌单")).toBeVisible();

    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "房间成员" })).toHaveAttribute("aria-current", "page");

    // 室友端
    await setupBaseRoom(page, false);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonalView }));
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "点歌台", exact: true })).toBeVisible();
    const roommateNav = page.getByRole("navigation", { name: "房间导航" });
    await roommateNav.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
    await expect(page.getByText("房主尚未为你分配歌单，请联系房主分配。")).toBeVisible();
    await expect(page.getByRole("button", { name: "前往分配" })).toHaveCount(0);
  });

  test("2. 完整分配流程：房主在成员列表中为室友选择候选收藏歌单，提交后更新为已分配，并展示【更换歌单】与【解除分配】", async ({ page }) => {
    await setupBaseRoom(page, true);
    let roommateAssigned = false;

    await page.route(membersEndpoint, route => {
      route.fulfill({ json: createMembersView(true, roommateAssigned) });
    });
    await page.route(candidatesEndpoint, route => route.fulfill({ json: mockCandidates }));
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundPersonalView }));

    let assignedPlaylistId: string | null = null;
    await page.route(`**/api/rooms/${roomId}/members/${roommateMemberId}/personal-playlist/assign`, async route => {
      const body = route.request().postDataJSON();
      assignedPlaylistId = body?.playlistId ?? null;
      roommateAssigned = true;
      route.fulfill({ json: boundPersonalView });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "房间成员" }).click();

    const assignBtn = page.getByRole("button", { name: "为室友小明分配歌单" });
    await expect(assignBtn).toBeVisible();
    await assignBtn.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("为“室友小明”分配歌单")).toBeVisible();
    await expect(dialog.getByText("周杰伦精选集")).toBeVisible();
    await expect(dialog.getByText("陈奕迅经典粤语")).toBeVisible();

    // 选中周杰伦精选集
    await dialog.getByText("周杰伦精选集").click();
    const confirmBtn = dialog.getByRole("button", { name: "确认分配" });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    await expect(dialog).toHaveCount(0);
    expect(assignedPlaylistId).toBe("fav-pl-jay");

    // 分配后操作按钮更新
    await expect(page.getByRole("button", { name: "为室友小明更换歌单" })).toBeVisible();
    await expect(page.getByRole("button", { name: "解除室友小明的歌单分配" })).toBeVisible();
  });

  test("3. 歌单外部失效感知：当外部歌单失效（TARGET_PERMISSION）时，展示失效横幅并禁用点歌，保留最后成功快照", async ({ page }) => {
    await setupBaseRoom(page, true);
    const invalidatedView: PersonalPlaylistView = {
      ...boundPersonalView,
      lastRefreshError: "TARGET_PERMISSION",
      disabledReason: "TARGET_BLOCKED"
    };

    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: invalidatedView }));
    await page.route(refreshEndpoint, route => route.fulfill({ json: invalidatedView }));

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单" }).click();

    await expect(page.getByRole("heading", { name: "我的歌单" })).toBeVisible();
    // 依然展示最后一次快照的歌曲
    await expect(page.getByText("稻香", { exact: true })).toBeVisible();
    await expect(page.getByText("夜曲", { exact: true })).toBeVisible();

    // 展示失效横幅
    await expect(page.getByText("该歌单已在外部失效（被作者删除或已被房主取消收藏），已保留最后一次成功快照。当前无法继续点歌。")).toBeVisible();

    // 点歌按钮被明确禁用
    const reqBtn = page.getByRole("button", { name: "点播《稻香》到点歌台" });
    await expect(reqBtn).toBeDisabled();
    await expect(reqBtn).toHaveAttribute("title", "歌单已在外部失效，无法点歌");
  });

  test("4. 解除分配流程：二次确认弹窗展示警示与中性标签，确认后成员恢复未分配状态，公共歌单与标签不被清除", async ({ page }) => {
    await setupBaseRoom(page, true);
    let roommateAssigned = true;

    await page.route(membersEndpoint, route => {
      route.fulfill({ json: createMembersView(true, roommateAssigned) });
    });

    let unassignedCalled = false;
    await page.route(`**/api/rooms/${roomId}/members/${roommateMemberId}/personal-playlist/unassign`, route => {
      unassignedCalled = true;
      roommateAssigned = false;
      route.fulfill({ json: emptyPersonalView });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "房间成员" }).click();

    const unassignBtn = page.getByRole("button", { name: "解除室友小明的歌单分配" });
    await expect(unassignBtn).toBeVisible();
    await unassignBtn.click();

    // 二次确认弹窗
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("解除“室友小明”的歌单分配？")).toBeVisible();
    await expect(dialog.getByText("恢复为未分配状态")).toBeVisible();
    await expect(dialog.getByText("保留已点歌曲")).toBeVisible();

    // 确认解除
    await dialog.getByRole("button", { name: "确认解除" }).click();
    await expect(dialog).toHaveCount(0);
    expect(unassignedCalled).toBe(true);

    // 恢复为未分配状态按钮
    await expect(page.getByRole("button", { name: "为室友小明分配歌单" })).toBeVisible();
  });

  for (const width of [320, 900, 1440]) {
    test(`5. ${width}px 下未分配页面与分配弹窗无横向滚动溢出并通过 Axe 检查`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setupBaseRoom(page, true);
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonalView }));
      await page.route(membersEndpoint, route => route.fulfill({ json: createMembersView(false, false) }));
      await page.route(candidatesEndpoint, route => route.fulfill({ json: mockCandidates }));

      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "我的歌单" }).click();

      await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      let axeResults = await new AxeBuilder({ page })
        .include(".room-workspace")
        .disableRules(["color-contrast"])
        .analyze();
      expect(axeResults.violations).toEqual([]);

      // 前往分配拉起弹窗
      await page.getByRole("button", { name: "前往分配" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      axeResults = await new AxeBuilder({ page })
        .include(".candidate-playlist-dialog")
        .disableRules(["color-contrast"])
        .analyze();
      expect(axeResults.violations).toEqual([]);
    });
  }
});
