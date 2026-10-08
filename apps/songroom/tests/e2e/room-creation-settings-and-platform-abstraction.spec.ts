import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { neteaseBindingView } from "../../src/shared/netease-contracts.js";
import { roomCreateView, roomMembersView, roomShellView } from "../../src/shared/room-contracts.js";

const roomId = "0195cf0d-6a80-7000-8000-000000000088";
const authId = "0195cf0d-6a80-7000-8000-000000000089";
const neteaseIdentity = { accountId: "987654321", nickname: "云村音乐达人" };

async function setupMocks(page: Page, role: "owner" | "roommate" = "owner") {
  const isOwner = role === "owner";
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "test-session-id", expiresAt: "2099-01-01T00:00:00Z" },
        user: {
          id: isOwner ? "user-owner" : "user-roommate",
          name: isOwner ? "房主用户" : "室友用户",
          email: "user@example.com",
          emailVerified: false
        }
      }
    })
  );

  await page.route("**/api/netease/binding", route =>
    route.fulfill({
      json: neteaseBindingView.parse({
        binding: {
          id: authId,
          identity: neteaseIdentity,
          status: "active"
        },
        allowedActions: ["revoke"]
      })
    })
  );

  await page.route("**/api/public-playlist-cleanups", route =>
    route.fulfill({
      json: { cleanups: [], allowedActions: [], disabledReasons: {} }
    })
  );

  await page.route("**/api/rooms/create-view", route =>
    route.fulfill({
      json: roomCreateView.parse({
        authorization: {
          id: authId,
          identity: neteaseIdentity
        },
        allowedActions: ["createRoom"],
        disabledReason: null
      })
    })
  );

  const allowedActions = isOwner
    ? (["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"] as const)
    : (["renameNickname", "leaveRoom"] as const);

  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: roomShellView.parse({
        room: {
          id: roomId,
          name: "声学实验室",
          role,
          nickname: isOwner ? "声学房主" : "声学室友"
        },
        version: 1,
        pendingCount: 0,
        allowedActions: [...allowedActions],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY" }
      })
    })
  );

  await page.route(`**/api/rooms/${roomId}/members`, route =>
    route.fulfill({
      json: roomMembersView.parse({
        version: 1,
        members: [
          {
            id: "0195cf0d-6a80-7000-8000-000000000091",
            nickname: "声学房主",
            role: "owner",
            isSelf: isOwner,
            allowedActions: isOwner ? ["renameNickname"] : [],
            disabledReasons: {}
          }
        ],
        allowedActions: [...allowedActions],
        disabledReasons: {}
      })
    })
  );
}

test.describe("Ticket 08: 房间创建与设置模块化及多平台授权抽象", () => {
  test("账号设置页重构为“音乐平台授权”列表，卡片化展示已绑定平台并预留未来扩展位", async ({ page }) => {
    await setupMocks(page, "owner");
    await page.goto("/account");

    // 1. 音乐平台授权专区标题与说明
    await expect(page.getByRole("heading", { name: "音乐平台授权" })).toBeVisible();
    await expect(page.getByText("绑定音乐平台账号作为房间点歌与公共歌单的同步播放源。")).toBeVisible();

    // 2. 已绑定的网易云音乐卡片
    await expect(page.getByRole("heading", { name: "网易云账号" })).toBeVisible();
    await expect(page.getByText("已授权", { exact: true })).toBeVisible();
    await expect(page.getByText(neteaseIdentity.nickname)).toBeVisible();
    await expect(page.getByText(neteaseIdentity.accountId, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "退出网易云授权" })).toBeVisible();

    // 3. 预留未来扩展平台卡片（QQ 音乐、汽水音乐、酷狗音乐）
    for (const name of ["QQ 音乐", "汽水音乐", "酷狗音乐"]) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
    const comingSoonBadges = page.getByText("即将支持", { exact: true });
    await expect(comingSoonBadges).toHaveCount(3);

    const pendingButtons = page.getByRole("button", { name: "敬请期待" });
    await expect(pendingButtons).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(pendingButtons.nth(i)).toBeDisabled();
    }
  });

  test("创建房间页重构为“选择房间播放源账号”单选卡片，移除二次勾选并使用 placeholder 降噪", async ({ page }) => {
    await setupMocks(page, "owner");
    await page.route("**/api/rooms", async route => {
      const data = route.request().postDataJSON();
      expect(data.name).toBe("阳光宿舍");
      expect(data.nickname).toBe("阿光");
      expect(data.authorizationId).toBe(authId);
      await route.fulfill({
        status: 200,
        json: { id: roomId, name: "阳光宿舍", role: "owner", nickname: "阿光" }
      });
    });

    await page.goto("/rooms/new");

    // 1. 播放源单选卡片专区
    await expect(page.getByRole("heading", { name: "选择房间播放源账号" })).toBeVisible();
    const neteaseRadio = page.getByRole("radio", { name: /网易云音乐/ });
    await expect(neteaseRadio).toBeVisible();
    await expect(neteaseRadio).toBeChecked();
    await expect(page.getByText(neteaseIdentity.nickname)).toBeVisible();
    await expect(page.getByText(neteaseIdentity.accountId, { exact: true })).toBeVisible();

    // 预留扩展单选位存在且禁用
    const qqRadio = page.getByRole("radio", { name: /QQ 音乐/ });
    await expect(qqRadio).toBeDisabled();

    // 2. 彻底移除多余的二次强制勾选复选框
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByText("确认使用此网易云账号创建房间")).toHaveCount(0);

    // 3. 消除常识长句说教，输入框采用 placeholder 指引
    await expect(page.getByText("1 到 16 个字符，房间名称可以重复。")).toHaveCount(0);
    await expect(page.getByText("1 到 12 个字符，只用于这个房间。")).toHaveCount(0);
    await expect(page.getByText("建房不会创建网易云歌单。")).toHaveCount(0);

    const nameInput = page.getByLabel("房间名称");
    const nicknameInput = page.getByLabel("我的房间昵称");
    await expect(nameInput).toHaveAttribute("placeholder", "输入房间名称（1 到 16 个字符）");
    await expect(nicknameInput).toHaveAttribute("placeholder", "输入你在房间内的昵称（1 到 12 个字符）");

    // 4. 输入并提交建房
    await nameInput.fill("阳光宿舍");
    await nicknameInput.fill("阿光");
    const submitBtn = page.getByRole("button", { name: "创建并进入房间" });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  });

  test("房间设置页实施模块化三区且消除与侧栏重复的只读信息表格（房主视角）", async ({ page }) => {
    await setupMocks(page, "owner");
    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("button", { name: "房间设置" }).click();
    await expect(page.getByRole("heading", { name: "房间设置", exact: true })).toBeVisible();

    // 1. 分区 1: 基本信息
    await expect(page.getByRole("heading", { name: "基本信息", exact: true })).toBeVisible();
    await expect(page.getByLabel("房间名称", { exact: true })).toBeVisible();
    await expect(page.getByLabel("我的房间昵称", { exact: true })).toBeVisible();

    // 2. 分区 2: 关联平台账号
    await expect(page.getByRole("heading", { name: "关联平台账号", exact: true })).toBeVisible();
    await expect(page.getByText("主播放源", { exact: true })).toBeVisible();
    await expect(page.getByText("使用房主（本人）授权")).toBeVisible();
    const accountLink = page.getByRole("link", { name: "账号设置" });
    await expect(accountLink).toBeVisible();
    await expect(accountLink).toHaveAttribute("href", "/account");

    // 3. 彻底消除与侧栏重复的只读表格镜像陈列
    const settingsPane = page.getByRole("region", { name: "房间设置" });
    await expect(settingsPane.locator("dl.netease-identity")).toHaveCount(0);

    // 4. 分区 3: 独立红框隔离危险区域 (房主显示删除房间，不显示退出房间)
    const dangerZone = settingsPane.locator(".danger-zone-card");
    await expect(dangerZone).toBeVisible();
    await expect(dangerZone.getByRole("button", { name: "删除房间" })).toBeVisible();
    await expect(dangerZone.getByRole("button", { name: "退出房间" })).toHaveCount(0);
  });

  test("房间设置页室友视角：仅展示昵称修改与退出房间危险操作", async ({ page }) => {
    await setupMocks(page, "roommate");
    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("button", { name: "房间设置" }).click();
    const settingsPane = page.getByRole("region", { name: "房间设置" });

    // 室友不显示修改房间名称
    await expect(settingsPane.getByRole("button", { name: "保存房间名称" })).toHaveCount(0);
    await expect(settingsPane.getByLabel("我的房间昵称", { exact: true })).toBeVisible();

    // 关联平台账号提示使用房主授权
    await expect(settingsPane.getByText("使用房主授权")).toBeVisible();

    // 危险区域仅显示退出房间，不显示删除房间
    const dangerZone = settingsPane.locator(".danger-zone-card");
    await expect(dangerZone).toBeVisible();
    await expect(dangerZone.getByRole("button", { name: "退出房间" })).toBeVisible();
    await expect(dangerZone.getByRole("button", { name: "删除房间" })).toHaveCount(0);
  });

  test("各端视口无横向滚动溢出与 Axe 无障碍扫描", async ({ page }) => {
    for (const width of [320, 900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await setupMocks(page, "owner");

      // 1. 账号设置页
      await page.goto("/account");
      let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      let clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

      // 2. 创建房间页
      await page.goto("/rooms/new");
      scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

      // 3. 房间设置页
      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "房间设置" }).click();
      scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    }

    // Axe 无障碍检查
    await setupMocks(page, "owner");
    await page.goto("/rooms/new");
    const axeResults = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(axeResults.violations).toEqual([]);
  });
});
