import { test, expect, type Page } from "@playwright/test";

const testSession = {
  session: { id: "test-session-123", expiresAt: new Date(Date.now() + 86400000).toISOString() },
  user: { id: "owner-user", name: "房主", email: "owner@example.com", emailVerified: true }
};

async function setupMocks(page: Page, cleanupsList: any[] = []) {
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({ json: testSession })
  );

  await page.route("**/api/status", route =>
    route.fulfill({
      json: {
        status: "ready",
        database: "connected",
        mode: "development",
        timestamp: new Date().toISOString()
      }
    })
  );

  await page.route("**/api/rooms", route =>
    route.fulfill({
      json: {
        rooms: [],
        allowedActions: ["openCreateRoom", "openJoin"],
        disabledReasons: {}
      }
    })
  );

  await page.route("**/api/join-applications", route =>
    route.fulfill({ json: { applications: [] } })
  );

  await page.route("**/api/cleanups/public-playlists", route =>
    route.fulfill({ json: { cleanups: cleanupsList } })
  );

  await page.route("**/api/netease/binding", route =>
    route.fulfill({
      json: {
        bound: true,
        authorizationStatus: "active",
        identity: { accountId: "cloud-owner-1", nickname: "网易房主" },
        allowedActions: ["revoke"]
      }
    })
  );
}

test.describe("公共歌单清理状态展示与账号上下文 (ticket 18)", () => {
  test("公共歌单清理彻底移出房间列表视图并归入账号高级设置，清晰区分 5 种清理状态及下一步", async ({ page }) => {
    const mockCleanups = [
      {
        id: "0195cf0d-6a80-7000-8000-000000000001",
        accountId: "cloud-owner-1",
        playlistId: "pl-wait-auth",
        status: "waitingAuthorization",
        lastErrorCode: "AUTH_UNAVAILABLE",
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        id: "0195cf0d-6a80-7000-8000-000000000002",
        accountId: "cloud-owner-1",
        playlistId: "pl-confirming",
        status: "awaitingConfirmation",
        lastErrorCode: "DEADLINE",
        version: 2,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        id: "0195cf0d-6a80-7000-8000-000000000003",
        accountId: "cloud-owner-1",
        playlistId: "pl-official-client",
        status: "needsAdministrator",
        lastErrorCode: "TARGET_PERMISSION",
        version: 3,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        id: "0195cf0d-6a80-7000-8000-000000000004",
        accountId: "cloud-owner-1",
        playlistId: "pl-admin-needed",
        status: "needsAdministrator",
        lastErrorCode: "ACCOUNT_PAUSED",
        version: 4,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        id: "0195cf0d-6a80-7000-8000-000000000005",
        accountId: "cloud-owner-1",
        playlistId: "pl-done",
        status: "succeeded",
        lastErrorCode: null,
        version: 5,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    await setupMocks(page, mockCleanups);
    // 1. 房间列表主视图彻底移出公共歌单清理
    await page.goto("/rooms");
    await expect(page.getByRole("heading", { name: "公共歌单清理" })).toHaveCount(0);

    // 2. 归入账号高级设置中展示
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "公共歌单清理" })).toBeVisible();

    // 1. 等待重新授权
    await expect(page.getByText("网易云歌单 ID：pl-wait-auth")).toBeVisible();
    await expect(page.getByText("等待重新授权")).toBeVisible();
    await expect(page.getByText("原网易云账号授权已失效，请前往账号设置重新授权以继续云端清理。")).toBeVisible();

    // 2. 结果待确认
    await expect(page.getByText("网易云歌单 ID：pl-confirming")).toBeVisible();
    await expect(page.getByText("结果待确认")).toBeVisible();
    await expect(page.getByText("删除请求已发出，系统正在核查云端状态，无需重复操作。")).toBeVisible();

    // 3. 需官方客户端处理
    await expect(page.getByText("网易云歌单 ID：pl-official-client")).toBeVisible();
    await expect(page.getByText("需官方客户端处理")).toBeVisible();
    await expect(page.getByText("网易云已拒绝删除该歌单，请在原账号网易云官方客户端手工删除该歌单，后续由系统管理员核验完成。")).toBeVisible();

    // 4. 需管理员处理
    await expect(page.getByText("网易云歌单 ID：pl-admin-needed")).toBeVisible();
    await expect(page.getByText("需管理员处理")).toBeVisible();
    await expect(page.getByText("删除被上游拒绝或遇到异常，请联系系统管理员核查。")).toBeVisible();

    // 5. 已完成删除
    await expect(page.getByText("网易云歌单 ID：pl-done")).toBeVisible();
    await expect(page.getByText("已完成删除")).toBeVisible();
    await expect(page.getByText("专用公共歌单已在网易云成功删除，清理已完成。")).toBeVisible();

    // 验证不暴露敏感内部证据和凭据
    await expect(page.getByText("MUSIC_U")).toHaveCount(0);
    await expect(page.getByText("cookie=")).toHaveCount(0);
    await expect(page.getByText("TARGET_PERMISSION")).toHaveCount(0);
  });

  test("在账号设置（账号授权上下文）中同步展示公共歌单清理摘要", async ({ page }) => {
    const mockCleanups = [
      {
        id: "0195cf0d-6a80-7000-8000-000000000001",
        accountId: "cloud-owner-1",
        playlistId: "pl-account-ctx",
        status: "waitingAuthorization",
        lastErrorCode: "AUTH_UNAVAILABLE",
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    await setupMocks(page, mockCleanups);
    await page.goto("/account");

    await expect(page.getByRole("heading", { name: "账号设置", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "网易云账号" })).toBeVisible();

    // 账号设置中也展示公共歌单清理摘要
    await expect(page.getByRole("heading", { name: "公共歌单清理" })).toBeVisible();
    await expect(page.getByText("网易云歌单 ID：pl-account-ctx")).toBeVisible();
    await expect(page.getByText("等待重新授权")).toBeVisible();
  });

  test("在 320px、900px、1440px 视口下清理卡片正常展示且无横向溢出", async ({ page }) => {
    const mockCleanups = [
      {
        id: "0195cf0d-6a80-7000-8000-000000000001",
        accountId: "cloud-owner-1",
        playlistId: "pl-responsive",
        status: "awaitingConfirmation",
        lastErrorCode: "DEADLINE",
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    await setupMocks(page, mockCleanups);

    for (const width of [320, 900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/account");

      await expect(page.getByRole("heading", { name: "公共歌单清理" })).toBeVisible();
      await expect(page.getByText("网易云歌单 ID：pl-responsive")).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    }
  });
});
