import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { v7 } from "uuid";
import type { PersonalPlaylistCandidatesView, PersonalPlaylistView } from "../../src/shared/personal-playlist-contracts.js";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";

const roomId = v7();
const ownerMemberId = v7();
const roommateMemberId = v7();

const personalPlaylistEndpoint = `**/api/rooms/${roomId}/personal-playlist`;
const candidatesEndpoint = `**/api/rooms/${roomId}/personal-playlist/candidates`;
const bindEndpoint = `**/api/rooms/${roomId}/personal-playlist/bind`;
const unbindEndpoint = `**/api/rooms/${roomId}/personal-playlist/unbind`;
const memberPersonalPlaylistEndpoint = `**/api/rooms/${roomId}/members/${ownerMemberId}/personal-playlist`;
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
        allowedActions: isOwner ? ["reviewApplications", "inviteRoommate"] : [],
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
  allowedActions: ["bindPersonalPlaylist"],
  disabledReason: null,
  version: 1
};

const roommateEmptyPersonalView: PersonalPlaylistView = {
  playlist: null,
  snapshot: null,
  lastRefreshError: null,
  allowedActions: [],
  disabledReason: null,
  version: 1
};

const boundCreatedPersonalView: PersonalPlaylistView = {
  playlist: {
    id: "pl-created-fav",
    name: "房主我喜欢的音乐",
    type: "ownerCreated",
    writeable: true
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
  allowedActions: ["bindPersonalPlaylist", "unbindPersonalPlaylist", "refreshPersonalPlaylist"],
  disabledReason: null,
  version: 2
};

const mockCandidates: PersonalPlaylistCandidatesView = {
  candidates: [
    { id: "pl-created-fav", name: "房主我喜欢的音乐", type: "ownerCreated", writeable: true },
    { id: "pl-sub-rock", name: "摇滚名人堂精选", type: "ownerSubscribed", writeable: false }
  ],
  allowedActions: ["bindPersonalPlaylist"],
  disabledReason: null
};

test.describe("房主个人歌单与第二期四入口导航 (Ticket 24)", () => {
  for (const width of [320, 900, 1440]) {
    test(`${width}px 房间一级导航原子升级为四入口，无横向溢出，Axe 无障碍通过`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setupRoom(page, true);
      await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundCreatedPersonalView }));

      await page.goto(`/rooms/${roomId}`);

      const nav = page.getByRole("navigation", { name: "房间导航" });
      await expect(nav.getByRole("button")).toHaveText(["公共歌单", "我的歌单", "房间成员", "房间设置"]);

      // 切换到我的歌单
      await nav.getByRole("button", { name: "我的歌单" }).click();
      await expect(nav.getByRole("button", { name: "我的歌单" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "房主我喜欢的音乐" })).toBeVisible();
      await expect(page.getByText("自建歌单")).toBeVisible();
      await expect(page.getByText("可维护")).toBeVisible();
      await expect(page.getByText("共 2 首歌曲")).toBeVisible();
      await expect(page.getByText("稻香")).toBeVisible();
      await expect(page.getByText("夜曲")).toBeVisible();

      // 无横向滚动溢出
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(noOverflow).toBe(true);

      // Axe 无障碍审计
      const axeResults = await new AxeBuilder({ page })
        .include(".room-workspace")
        .disableRules(["color-contrast"])
        .analyze();
      expect(axeResults.violations).toEqual([]);
    });
  }

  test("房主未配置个人歌单时展示引导，点击绑定可选择自建或收藏歌单并成功建立绑定", async ({ page }) => {
    await setupRoom(page, true);

    let currentView = { ...emptyPersonalView };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: currentView }));
    await page.route(candidatesEndpoint, route => route.fulfill({ json: mockCandidates }));

    let boundPayload: any = null;
    await page.route(bindEndpoint, async route => {
      boundPayload = route.request().postDataJSON();
      currentView = { ...boundCreatedPersonalView };
      await route.fulfill({ json: currentView });
    });

    await page.goto(`/rooms/${roomId}`);
    const nav = page.getByRole("navigation", { name: "房间导航" });
    await nav.getByRole("button", { name: "我的歌单" }).click();

    // 未配置状态
    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
    await expect(page.getByText(/绑定网易云已创建或收藏的歌单作为个人歌单来源/)).toBeVisible();
    const bindBtn = page.getByRole("button", { name: "绑定个人歌单" });
    await expect(bindBtn).toBeVisible();

    // 打开绑定弹窗
    await bindBtn.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByText("房主我喜欢的音乐")).toBeVisible();
    await expect(page.getByText("摇滚名人堂精选")).toBeVisible();

    // 选中自建歌单并确认绑定
    await page.getByText("房主我喜欢的音乐").click();
    await page.getByRole("button", { name: "确认绑定" }).click();

    // 验证调用参数
    expect(boundPayload).toMatchObject({ playlistId: "pl-created-fav" });

    // 弹窗关闭，呈现歌单详情与歌曲
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "房主我喜欢的音乐" })).toBeVisible();
    await expect(page.getByText("共 2 首歌曲")).toBeVisible();
  });

  test("房主可解绑个人歌单，弹窗展示关键无害风险标签（不删除云端、仅解绑当前房间）", async ({ page }) => {
    await setupRoom(page, true);

    let currentView = { ...boundCreatedPersonalView };
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: currentView }));

    let unbindCalled = false;
    await page.route(unbindEndpoint, async route => {
      unbindCalled = true;
      currentView = { ...emptyPersonalView };
      await route.fulfill({ json: currentView });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单" }).click();

    await expect(page.getByRole("heading", { name: "房主我喜欢的音乐" })).toBeVisible();
    const unbindBtn = page.getByRole("button", { name: "解除绑定" });
    await expect(unbindBtn).toBeVisible();
    await unbindBtn.click();

    // 二次确认弹窗
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("不删除云端歌单")).toBeVisible();
    await expect(dialog.getByText("仅解绑当前房间")).toBeVisible();

    // 确认解绑
    await dialog.getByRole("button", { name: "确认解绑" }).click();
    expect(unbindCalled).toBe(true);

    // 回到未配置状态
    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
  });

  test("室友查看我的歌单未配置且无绑定按钮；在成员详情中只读查看房主歌单快照，不暴露维护操作", async ({ page }) => {
    await setupRoom(page, false);

    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: roommateEmptyPersonalView }));
    await page.route(memberPersonalPlaylistEndpoint, route => route.fulfill({ json: boundCreatedPersonalView }));

    await page.goto(`/rooms/${roomId}`);
    const nav = page.getByRole("navigation", { name: "房间导航" });

    // 1. 室友在我的歌单 tab：未配置且无绑定按钮
    await nav.getByRole("button", { name: "我的歌单" }).click();
    await expect(page.getByRole("heading", { name: "尚未配置个人歌单" })).toBeVisible();
    await expect(page.getByRole("button", { name: "绑定个人歌单" })).toHaveCount(0);

    // 2. 室友在房间成员 tab 查看房主详情
    await nav.getByRole("button", { name: "房间成员" }).click();
    await page.getByRole("button", { name: "查看成员：房主小林" }).click();

    await expect(page.getByRole("heading", { name: "房主小林" })).toBeVisible();
    // 展示个人歌单只读信息
    await expect(page.getByText("房主我喜欢的音乐")).toBeVisible();
    await expect(page.getByText("自建（可维护）")).toBeVisible();
    await expect(page.getByText("2 首")).toBeVisible();
    await expect(page.getByText("稻香")).toBeVisible();

    // 严禁暴露房主维护或点歌来源动作
    await expect(page.getByRole("button", { name: /绑定|解绑|更换|点歌/ })).toHaveCount(0);
  });

  test("第一期直接搜索公共点歌回归：未配置个人歌单时不阻塞搜索点歌", async ({ page }) => {
    await setupRoom(page, false);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: roommateEmptyPersonalView }));

    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "公共歌单", exact: true })).toBeVisible();

    // 点歌按钮存在且可点击
    const songRequestBtn = page.getByRole("button", { name: "点歌" });
    await expect(songRequestBtn).toBeVisible();
    await songRequestBtn.click();

    // 点歌抽屉正常滑出，无阻塞提示
    await expect(page.getByRole("dialog", { name: "点歌" })).toBeVisible();
    await expect(page.getByPlaceholder("输入歌名或歌手直接点歌…")).toBeVisible();
  });
});
