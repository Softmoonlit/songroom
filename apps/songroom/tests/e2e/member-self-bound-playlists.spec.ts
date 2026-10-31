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
const bindEndpoint = `**/api/rooms/${roomId}/personal-playlist/bind`;
const candidatesEndpoint = `**/api/rooms/${roomId}/personal-playlist/candidates`;
const publicPlaylistEndpoint = `**/api/rooms/${roomId}/public-playlist`;
const membersEndpoint = `**/api/rooms/${roomId}/members`;

function createMembersView(ownerHasPlaylist = true, roommateHasPlaylist = true): RoomMembersView {
  return {
    version: 1,
    members: [
      {
        id: ownerMemberId,
        nickname: "房主小林",
        role: "owner",
        isSelf: true,
        hasPersonalPlaylist: ownerHasPlaylist,
        authStatus: "active",
        canSelect: ownerHasPlaylist,
        disabledReason: ownerHasPlaylist ? null : "NO_PLAYLIST",
        allowedActions: ["renameNickname"],
        disabledReasons: {}
      },
      {
        id: roommateMemberId,
        nickname: "室友小明",
        role: "roommate",
        isSelf: false,
        hasPersonalPlaylist: roommateHasPlaylist,
        authStatus: "active",
        canSelect: roommateHasPlaylist,
        disabledReason: roommateHasPlaylist ? null : "NO_PLAYLIST",
        allowedActions: ["removeMember"],
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
      id: "pl-fav",
      sourceType: "favorite",
      name: "周杰伦精选集",
      trackCount: 30,
      coverImgUrl: null,
      creatorNickname: "音乐达人"
    },
    {
      id: "pl-created",
      sourceType: "created",
      name: "我喜欢的粤语歌",
      trackCount: 15,
      coverImgUrl: null,
      creatorNickname: "房主小林"
    },
    {
      id: "pl-special",
      sourceType: "liked",
      name: "我喜欢的音乐",
      trackCount: 100,
      coverImgUrl: null,
      creatorNickname: "房主小林"
    }
  ],
  version: 1
};

const boundPersonalView: PersonalPlaylistView = {
  playlist: { id: "pl-fav", name: "周杰伦精选集" },
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
  operation: null,
  lastRefreshError: null,
  allowedActions: [],
  disabledReason: null,
  version: 1
};

const unauthenticatedPersonalView: PersonalPlaylistView = {
  playlist: null,
  snapshot: null,
  operation: null,
  lastRefreshError: null,
  allowedActions: [],
  disabledReason: "NETEASE_AUTH_REQUIRED",
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
  await page.route(membersEndpoint, route => route.fulfill({ json: createMembersView(true, true) }));
  await page.route(candidatesEndpoint, route => route.fulfill({ json: mockCandidates }));
}

test.describe("ADR 0006: 成员自主绑定个人歌单", () => {
  test("未绑定个人歌单时，展示绑定引导与「绑定歌单」按钮，点击弹出候选弹窗", async ({ page }) => {
    await setupBaseRoom(page, false);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: emptyPersonalView }));

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "尚未绑定个人歌单" })).toBeVisible();
    await expect(page.getByText("从你的网易云歌单中挑选一份作为当前房间的点歌来源。")).toBeVisible();

    const bindBtn = page.getByRole("button", { name: "绑定歌单" });
    await expect(bindBtn).toBeVisible();

    await bindBtn.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "绑定个人歌单" })).toBeVisible();
    await expect(dialog.getByText("周杰伦精选集")).toBeVisible();
    await expect(dialog.getByText("我喜欢的粤语歌")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /我喜欢的音乐/ })).toBeVisible();

    // 关闭弹窗
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("在绑定弹窗中选择歌单并成功绑定", async ({ page }) => {
    await setupBaseRoom(page, false);
    let isBound = false;
    await page.route(personalPlaylistEndpoint, route =>
      route.fulfill({ json: isBound ? boundPersonalView : emptyPersonalView })
    );

    let bindPayload: any = null;
    await page.route(bindEndpoint, async route => {
      bindPayload = route.request().postDataJSON();
      isBound = true;
      await route.fulfill({ json: boundPersonalView });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await page.getByRole("button", { name: "绑定歌单" }).click();

    // 选中周杰伦精选集
    await page.getByText("周杰伦精选集").click();
    await page.getByRole("button", { name: "确认绑定" }).click();

    await expect.poll(() => bindPayload).toMatchObject({
      playlistId: "pl-fav"
    });

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "我的歌单" })).toBeVisible();
    await expect(page.getByText("稻香")).toBeVisible();
  });

  test("已绑定歌单展示歌曲、同步歌单与「更换歌单」按钮，可更换绑定", async ({ page }) => {
    await setupBaseRoom(page, true);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundPersonalView }));

    let refreshCalled = false;
    await page.route(refreshEndpoint, async route => {
      refreshCalled = true;
      await route.fulfill({ json: boundPersonalView });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "我的歌单" })).toBeVisible();
    await expect(page.getByText("稻香")).toBeVisible();
    await expect(page.getByText("夜曲")).toBeVisible();

    // 同步歌单
    await page.getByRole("button", { name: "同步歌单" }).click();
    await expect.poll(() => refreshCalled).toBe(true);
    await expect(page.getByText("歌单已同步")).toBeVisible();

    // 更换歌单
    const changeBtn = page.getByRole("button", { name: "更换歌单" });
    await expect(changeBtn).toBeVisible();
    await changeBtn.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "更换个人歌单" })).toBeVisible();

    // 验证关闭按钮为 32px 方形
    const closeBtn = dialog.getByRole("button", { name: "关闭" });
    await expect(closeBtn).toBeVisible();
    const closeBox = await closeBtn.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.width).toBeCloseTo(32, 1);
    expect(closeBox!.height).toBeCloseTo(32, 1);

    // 验证当前绑定的歌单展示「当前绑定」标签且默认选中
    await expect(dialog.getByText("当前绑定")).toBeVisible();
    const currentCard = dialog.getByRole("radio", { name: /周杰伦精选集/ });
    await expect(currentCard).toHaveAttribute("aria-checked", "true");

    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("点播歌曲到公共歌单触发点歌调用", async ({ page }) => {
    await setupBaseRoom(page, false);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundPersonalView }));

    let requestCalled = false;
    await page.route(`**/api/rooms/${roomId}/song-requests`, async route => {
      requestCalled = true;
      await route.fulfill({
        json: {
          id: v7(),
          songId: "track-1",
          status: "succeeded"
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();

    const songBtn = page.getByRole("button", { name: "点播《稻香》到点歌台" });
    await expect(songBtn).toBeVisible();
    await songBtn.click();

    await expect.poll(() => requestCalled).toBe(true);
  });

  test("未授权网易云账号时展示前往全局账号设置授权的提示", async ({ page }) => {
    await setupBaseRoom(page, false);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: unauthenticatedPersonalView }));

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();

    await expect(page.getByRole("heading", { name: "尚未绑定网易云账号" })).toBeVisible();
    await expect(page.getByText("请先绑定网易云账号，绑定后可在此选择点歌来源歌单。")).toBeVisible();
    const accountLink = page.getByRole("link", { name: "前往账号设置" });
    await expect(accountLink).toBeVisible();
    await expect(accountLink).toHaveAttribute("href", "/account");
  });

  test("房间成员列表紧凑展示昵称与角色标签，不展示他人歌单信息与操作按钮", async ({ page }) => {
    await setupBaseRoom(page, true);
    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("button", { name: "房间成员", exact: true }).click();
    await expect(page.getByRole("heading", { name: "房间成员", exact: true })).toBeVisible();

    const memberList = page.getByRole("list");
    // 房主与室友
    await expect(memberList.getByText("房主小林")).toBeVisible();
    await expect(memberList.getByText("室友小明")).toBeVisible();
    await expect(memberList.getByText("房主", { exact: true })).toBeVisible();
    await expect(memberList.getByText("室友", { exact: true })).toBeVisible();

    // 不包含他人歌单与废弃按钮
    await expect(page.getByRole("button", { name: /分配歌单|更换歌单|解除分配|查看歌单/ })).toHaveCount(0);
    await expect(page.getByText(/绑定的歌单|个人歌单来源/)).toHaveCount(0);
  });

  test("我的歌单界面通过 axe 无障碍审查", async ({ page }) => {
    await setupBaseRoom(page, true);
    await page.route(personalPlaylistEndpoint, route => route.fulfill({ json: boundPersonalView }));

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的歌单", exact: true })).toBeVisible();

    const accessibilityScanResults = await new AxeBuilder({ page })
      .include(".room-workspace")
      .analyze();
    expect(accessibilityScanResults.violations).toEqual([]);
  });
});
