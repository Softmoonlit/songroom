import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { v7 } from "uuid";
import type { PersonalPlaylistView } from "../../src/shared/personal-playlist-contracts.js";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";

const roomId = v7();
const ownerMemberId = v7();
const roommateMemberId = v7();

const personalPlaylistEndpoint = `**/api/rooms/${roomId}/personal-playlist`;
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
            hasPersonalPlaylist: true,
            allowedActions: isOwner ? ["renameNickname"] : [],
            disabledReasons: isOwner ? {} : { renameNickname: "SELF_ONLY" }
          },
          {
            id: roommateMemberId,
            nickname: "室友小明",
            role: "roommate",
            isSelf: !isOwner,
            hasPersonalPlaylist: true,
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
    operation: null,
    snapshot: {
      version: 1,
      syncedAt: Date.now() - 30000,
      trackCount: 1,
      tracks: [{ position: 0, songId: "track-pub", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: ["房主小林"] }]
    },
    lastRefreshError: null,
    allowedActions: isOwner ? ["refreshPublicPlaylist", "requestSong"] : ["requestSong"],
    disabledReason: null,
    version: 1
  };
  await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: publicView }));
  await page.route(`${publicPlaylistEndpoint}/refresh`, route => route.fulfill({ json: publicView }));
  await page.route("**/api/events*", route => route.abort());
}

const emptyPersonalView: PersonalPlaylistView = {
  playlist: null,
  snapshot: null,
  lastRefreshError: null,
  allowedActions: [],
  disabledReason: null,
  version: 1
};

const boundPersonalView: PersonalPlaylistView = {
  playlist: { id: "pl-fav-01", name: "周杰伦精选集" },
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

test.describe("个人歌单下线自建与删除，收敛为4导航默认点歌台（工单 01）", () => {
  for (const isOwner of [true, false]) {
    test(`${isOwner ? "房主" : "室友"}进入房间默认展示点歌台，4项一级导航无搜索歌曲`, async ({ page }) => {
      await setupRoom(page, isOwner);
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundPersonalView }));
      await page.goto(`/rooms/${roomId}`);

      const nav = page.getByRole("navigation", { name: "房间导航" });
      await expect(nav.getByRole("button")).toHaveText(["点歌台", "我的歌单", "房间成员", "房间设置"]);
      await expect(nav.getByRole("button", { name: "点歌台" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "点歌台", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "搜索歌曲" })).toHaveCount(0);
    });
  }

  test("房主未配置个人歌单时展示分配提示与【前往分配】按钮，点击跳转至成员列表并拉起分配弹窗", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonalView }));
    await page.route(`**/api/rooms/${roomId}/members`, route =>
      route.fulfill({
        json: {
          version: 1,
          members: [
            {
              id: ownerMemberId,
              nickname: "房主小林",
              role: "owner",
              isSelf: true,
              hasPersonalPlaylist: false,
              allowedActions: ["renameNickname", "assignPersonalPlaylist"],
              disabledReasons: {}
            },
            {
              id: roommateMemberId,
              nickname: "室友小明",
              role: "roommate",
              isSelf: false,
              hasPersonalPlaylist: true,
              allowedActions: ["removeMember", "assignPersonalPlaylist", "unassignPersonalPlaylist"],
              disabledReasons: {}
            }
          ],
          allowedActions: ["reviewApplications", "readInvite"],
          disabledReasons: {}
        }
      })
    );

    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "点歌台", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "房间导航" });
    await nav.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
    await expect(page.getByText("你尚未为自己分配歌单")).toBeVisible();
    const assignBtn = page.getByRole("button", { name: "前往分配" });
    await expect(assignBtn).toBeVisible();

    await assignBtn.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByText("为“房主小林”分配歌单")).toBeVisible();

    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "房间成员" })).toHaveAttribute("aria-current", "page");
  });

  test("室友未配置个人歌单时展示分配提示，不提供创建专用歌单或分配按钮", async ({ page }) => {
    await setupRoom(page, false);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonalView }));
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "点歌台", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "房间导航" });
    await nav.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
    await expect(page.getByText("房主尚未为你分配歌单，请联系房主分配。")).toBeVisible();
    await expect(page.getByRole("button", { name: /创建专用个人歌单|绑定个人歌单|前往分配/ })).toHaveCount(0);
  });

  test("外部歌单失效（TARGET_PERMISSION）时，展示外部失效横幅并禁用点歌", async ({ page }) => {
    await setupRoom(page, true);
    const invalidatedView: PersonalPlaylistView = {
      ...boundPersonalView,
      lastRefreshError: "TARGET_PERMISSION",
      disabledReason: "TARGET_BLOCKED"
    };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: invalidatedView }));
    await page.route(refreshEndpoint, route => route.fulfill({ json: invalidatedView }));

    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "点歌台", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "房间导航" });
    await nav.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "我的歌单", exact: true })).toBeVisible();
    await expect(page.getByText("稻香", { exact: true })).toBeVisible();
    await expect(page.getByText("该歌单已在外部失效（被删除、取消收藏或失去读取权限），已保留最后一次成功快照。当前无法继续点歌。")).toBeVisible();
    const requestSongBtn = page.getByRole("button", { name: "点播《稻香》到点歌台" });
    await expect(requestSongBtn).toBeDisabled();
    await expect(requestSongBtn).toHaveAttribute("title", "歌单已在外部失效，无法点歌");
  });

  for (const isOwner of [true, false]) {
    test(`${isOwner ? "房主" : "室友"}已绑定歌单展示歌曲，有点歌到点歌台按钮但无单首删除按钮`, async ({ page }) => {
      await setupRoom(page, isOwner);
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundPersonalView }));
      let refreshCalls = 0;
      await page.route(refreshEndpoint, route => {
        refreshCalls += 1;
        return route.fulfill({ json: boundPersonalView });
      });
      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "我的歌单", exact: true }).click();

      await expect(page.getByRole("heading", { name: "我的歌单", exact: true })).toBeVisible();
      await expect(page.getByText("稻香", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "点播《稻香》到点歌台" })).toBeVisible();
      await expect(page.getByRole("button", { name: /从个人歌单删除/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "创建专用个人歌单" })).toHaveCount(0);
      expect(refreshCalls).toBe(0);
      await page.getByRole("button", { name: "同步歌单", exact: true }).click();
      await expect.poll(() => refreshCalls).toBe(1);
    });
  }

  for (const isOwner of [true, false]) {
    test(`${isOwner ? "房主" : "室友"}查看其他成员歌单仅只读展示歌曲，无点歌或维护按钮`, async ({ page }) => {
      await setupRoom(page, isOwner);
      const memberId = isOwner ? roommateMemberId : ownerMemberId;
      const nickname = isOwner ? "室友小明" : "房主小林";
      const memberView: PersonalPlaylistView = {
        ...boundPersonalView,
        playlist: { id: "pl-other-fav", name: `${nickname}的收藏` },
        allowedActions: []
      };
      const memberEndpoint = `**/api/rooms/${roomId}/members/${memberId}/personal-playlist`;
      await page.route(memberEndpoint, route => route.fulfill({ json: memberView }));
      await page.route(`${memberEndpoint}/refresh`, route => route.fulfill({ json: memberView }));

      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "房间成员" }).click();
      const viewOtherPlaylist = page.getByRole("button", { name: `查看${nickname}的歌单`, exact: true });
      await expect(viewOtherPlaylist).toBeVisible();
      await viewOtherPlaylist.click();

      const detail = page.getByRole("region", { name: "成员详情", exact: true });
      await expect(detail.getByRole("heading", { name: nickname, exact: true })).toBeVisible();
      await expect(detail.getByText(`${nickname}的收藏`, { exact: true })).toBeVisible();
      await expect(detail.getByText("稻香", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: /点歌|删除|创建|绑定|解绑/ })).toHaveCount(0);
    });
  }

  for (const width of [320, 900, 1440]) {
    test(`${width}px 4入口导航与我的歌单无横向溢出并通过 Axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setupRoom(page);
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundPersonalView }));
      await page.route(refreshEndpoint, route => route.fulfill({ json: boundPersonalView }));
      await page.goto(`/rooms/${roomId}`);

      const nav = page.getByRole("navigation", { name: "房间导航" });
      await expect(nav.getByRole("button")).toHaveText(["点歌台", "我的歌单", "房间成员", "房间设置"]);
      await nav.getByRole("button", { name: "我的歌单" }).click();
      await expect(nav.getByRole("button", { name: "我的歌单" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "我的歌单", exact: true })).toBeVisible();
      await expect(page.getByLabel("共 2 首歌曲", { exact: true })).toBeVisible();
      await expect(page.getByText("夜曲", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /创建|删除/ })).toHaveCount(0);

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const axeResults = await new AxeBuilder({ page })
        .include(".room-workspace")
        .disableRules(["color-contrast"])
        .analyze();
      expect(axeResults.violations).toEqual([]);
    });
  }
});
