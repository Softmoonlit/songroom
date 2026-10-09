import { expect, test, type Page } from "@playwright/test";
import {
  roomListView,
  roomSummary,
  type RoomListItem,
  type PublicPlaylistCleanupItem
} from "../../src/shared/room-contracts.js";

const ownerRoom = roomSummary.parse({
  id: "0195cf0d-6a80-7000-8000-000000000001",
  name: "快乐寝室",
  role: "owner",
  nickname: "小明"
});

const roommateRoom = roomSummary.parse({
  id: "0195cf0d-6a80-7000-8000-000000000002",
  name: "隔壁宿舍",
  role: "roommate",
  nickname: "阿强"
});

async function setupRoomsMocks(
  page: Page,
  rooms: RoomListItem[] = [],
  cleanups: PublicPlaylistCleanupItem[] = []
) {
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "test-session-06", expiresAt: "2099-01-01T00:00:00.000Z" },
        user: { id: "test-user-06", name: "测试用户", email: "test-user-06@example.com", emailVerified: false }
      }
    })
  );

  await page.route("**/api/rooms", route =>
    route.fulfill({
      json: roomListView.parse({
        rooms,
        allowedActions: ["openCreateRoom", "openJoin"],
        disabledReasons: {}
      })
    })
  );

  await page.route("**/api/join-applications", route =>
    route.fulfill({ json: { applications: [] } })
  );

  await page.route("**/api/cleanups/public-playlists", route =>
    route.fulfill({ json: { cleanups } })
  );

  await page.route("**/api/netease/binding", route =>
    route.fulfill({
      json: {
        bound: false,
        authorizationStatus: "none",
        identity: null,
        allowedActions: []
      }
    })
  );
}

test.describe("Ticket 06: 未登录首页系统级降噪与现代 Hero 呈现", () => {
  test("未登录首页彻底去除大号服务状态看板与临时字样，突出协作点歌产品价值", async ({ page }) => {
    await page.goto("/");

    // 1. 验证干净大气的现代 Hero 呈现
    await expect(page.getByRole("heading", { name: "SongRoom 点歌台" })).toBeVisible();
    await expect(page.getByText("和室友一起点歌")).toBeVisible();
    await expect(page.getByText("专为宿舍打造的共享音乐点歌台")).toHaveCount(0);

    // 2. 彻底移除旧版技术性/临时文本
    await expect(page.getByText("功能正在交付")).toHaveCount(0);
    await expect(page.getByText("账号与房间功能正在交付")).toHaveCount(0);

    // 3. 彻底移除大号运维看板（服务状态、应用已准备就绪等）
    await expect(page.locator(".status-card")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "应用已准备就绪" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "服务状态" })).toHaveCount(0);

    // 4. 紧凑登录卡片与注册引导正常可见
    const authCard = page.locator(".auth-card");
    await expect(authCard).toBeVisible();
    await expect(authCard.getByRole("button", { name: "登录" })).toBeVisible();
    await expect(authCard.getByRole("link", { name: "立即注册" })).toBeVisible();

    // 5. 优雅页脚
    await expect(page.locator(".app-footer")).toContainText("宿舍音乐共享与协作点歌");
  });
});

test.describe("Ticket 06: 房间列表整合工具栏与双轨 Onboarding 指引", () => {
  test("空房间列表展示双轨 Onboarding 卡片，消除室友免绑音乐账号顾虑", async ({ page }) => {
    await setupRoomsMocks(page, []);
    await page.goto("/rooms");

    // 1. 整合工具栏呈现
    const toolbar = page.getByRole("toolbar", { name: "房间操作" });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole("link", { name: "创建房间" })).toBeVisible();
    await expect(toolbar.getByRole("link", { name: "输入邀请码加入" })).toBeVisible();

    // 2. 空状态标题
    await expect(page.getByRole("heading", { name: "还没有房间" })).toBeVisible();

    // 3. 房主轨行动卡片与一键授权引导
    const ownerTrack = page.locator(".onboarding-card.owner-track");
    await expect(ownerTrack).toBeVisible();
    await expect(ownerTrack.getByText("我是房主")).toBeVisible();
    await expect(ownerTrack.getByRole("heading", { name: "创建新房间" })).toBeVisible();
    await expect(ownerTrack.getByRole("link", { name: "创建我的房间" })).toBeVisible();
    await expect(ownerTrack.getByRole("link", { name: "前往账号设置授权" })).toBeVisible();

    // 4. 室友轨行动卡片，明确标示无需绑定音乐账号
    const roommateTrack = page.locator(".onboarding-card.roommate-track");
    await expect(roommateTrack).toBeVisible();
    await expect(roommateTrack.getByText("我是室友")).toBeVisible();
    await expect(roommateTrack.getByText("无需绑定音乐账号")).toBeVisible();
    await expect(roommateTrack.getByRole("heading", { name: "加入已有房间" })).toBeVisible();
    await expect(roommateTrack.getByRole("link", { name: "加入已有房间" })).toBeVisible();

    // 5. 消除旧版生硬错误提示
    await expect(page.getByText("绑定网易云账号后可以创建自己的房间。")).toHaveCount(0);

    // 6. 验证公共歌单清理不出现在房间列表中
    await expect(page.getByRole("heading", { name: "公共歌单清理" })).toHaveCount(0);
  });

  test("房间列表卡片清晰标示房主与室友角色身份徽标及状态", async ({ page }) => {
    const rooms: RoomListItem[] = [
      {
        ...ownerRoom,
        version: 1,
        allowedActions: ["enterRoom"],
        disabledReasons: {},
        authorizationStatus: "waitingAuthorization"
      },
      {
        ...roommateRoom,
        version: 1,
        allowedActions: ["enterRoom"],
        disabledReasons: {},
        authorizationStatus: "active"
      }
    ];

    await setupRoomsMocks(page, rooms);
    await page.goto("/rooms");

    // 1. 房主卡片：标示房主身份徽标与昵称
    const ownerCard = page.locator(".room-list-card").filter({ hasText: "快乐寝室" });
    await expect(ownerCard).toBeVisible();
    await expect(ownerCard.locator(".role-badge.role-owner")).toHaveText("房主");
    await expect(ownerCard.locator(".room-card-nickname")).toContainText("小明");
    // 授权退出提示与状态徽标
    await expect(ownerCard.locator(".status-badge.warning")).toHaveText("授权失效");
    await expect(ownerCard.getByText("网易云授权已退出，等待房主重新授权")).toBeVisible();
    await expect(ownerCard.getByRole("link", { name: "进入房间：快乐寝室" })).toBeVisible();

    // 2. 室友卡片：标示室友身份徽标与昵称，以及正常运行状态徽标
    const roommateCard = page.locator(".room-list-card").filter({ hasText: "隔壁宿舍" });
    await expect(roommateCard).toBeVisible();
    await expect(roommateCard.locator(".role-badge.role-roommate")).toHaveText("室友");
    await expect(roommateCard.locator(".room-card-nickname")).toContainText("阿强");
    await expect(roommateCard.locator(".status-badge.success")).toHaveCount(0);
    await expect(roommateCard.locator(".status-badge.warning")).toHaveCount(0);
    await expect(roommateCard.getByRole("link", { name: "进入房间：隔壁宿舍" })).toBeVisible();
  });

  test("已删除房间专用歌单清理进度（PublicPlaylistCleanups）彻底移出房间列表视图并归入账号高级设置", async ({ page }) => {
    const mockCleanups: PublicPlaylistCleanupItem[] = [
      {
        id: "0195cf0d-6a80-7000-8000-000000000099",
        accountId: "test-cloud-account",
        playlistId: "pl-clean-test",
        status: "waitingAuthorization",
        lastErrorCode: null,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    await setupRoomsMocks(page, [
      {
        ...ownerRoom,
        version: 1,
        allowedActions: ["enterRoom"],
        disabledReasons: {}
      }
    ], mockCleanups);

    // 1. 访问房间列表：主视图中绝不展示底层清理进度
    await page.goto("/rooms");
    await expect(page.getByRole("heading", { name: "公共歌单清理" })).toHaveCount(0);
    await expect(page.getByText("pl-clean-test")).toHaveCount(0);

    // 2. 前往账号设置：在高级设置中展示公共歌单清理
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "账号设置", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "公共歌单清理" })).toBeVisible();
    await expect(page.getByText("网易云歌单 ID：pl-clean-test")).toBeVisible();
    await expect(page.getByText("等待重新授权")).toBeVisible();
  });
});
