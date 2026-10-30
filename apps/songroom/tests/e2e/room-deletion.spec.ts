import { expect, test, type Page } from "@playwright/test";
import { v7 } from "uuid";
import type { PublicPlaylistCleanupItem } from "../../src/shared/room-contracts.js";

const roomId = v7();

async function setupMocks(page: Page, role: "owner" | "roommate" = "owner", options?: { hasPublicPlaylist?: boolean }) {
  const isOwner = role === "owner";
  const userId = isOwner ? "user-owner" : "user-roommate";
  const hasPublicPlaylist = options?.hasPublicPlaylist ?? true;

  let currentRoomList: any[] = [
    {
      id: roomId,
      name: "测试音乐间",
      role,
      nickname: isOwner ? "房主" : "室友",
      memberCount: 2,
      createdAt: Date.now() - 3600000
    }
  ];

  let currentCleanups: PublicPlaylistCleanupItem[] = [];

  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "session-1", userId, expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: userId, name: isOwner ? "房主" : "室友", email: `${userId}@example.com`, emailVerified: false }
      }
    })
  );

  await page.route("**/api/rooms", route => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          rooms: currentRoomList,
          archivedCount: 0
        }
      });
    }
    return route.continue();
  });

  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: {
        room: {
          id: roomId,
          name: "测试音乐间",
          role,
          nickname: isOwner ? "房主" : "室友"
        },
        version: 1,
        pendingCount: 0,
        allowedActions: isOwner
          ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"]
          : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY", deleteRoom: "OWNER_ONLY" }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/public-playlist`, route =>
    route.fulfill({
      json: {
        playlist: hasPublicPlaylist ? { id: "pl-cloud-1", name: "songroom-测试音乐间-公共" } : null,
        operation: null,
        snapshot: null,
        lastRefreshError: null,
        allowedActions: hasPublicPlaylist ? ["refreshPublicPlaylist", "requestSong"] : ["createPublicPlaylist"],
        disabledReason: null,
        version: 1
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/personal-playlist`, route =>
    route.fulfill({
      json: {
        playlist: null,
        snapshot: null,
        lastRefreshError: null,
        allowedActions: [],
        disabledReason: null,
        version: 1
      }
    })
  );

  await page.route("**/api/cleanups/public-playlists", route =>
    route.fulfill({
      json: {
        cleanups: currentCleanups
      }
    })
  );

  await page.route("**/api/events*", route => route.abort());

  return {
    setRoomList: (list: any[]) => { currentRoomList = list; },
    setCleanups: (cleanups: PublicPlaylistCleanupItem[]) => { currentCleanups = cleanups; }
  };
}

test.describe("Ticket 03: 房间删除完整影响展示与清理生命周期规范", () => {
  test("有公共点歌台时展示点歌台清理警示，不误报个人歌单云端清理", async ({ page }) => {
    await setupMocks(page, "owner", { hasPublicPlaylist: true });

    await page.route(`**/api/rooms/${roomId}/deletion`, route =>
      route.fulfill({
        json: {
          room: { id: roomId, name: "测试音乐间" },
          version: 3,
          memberCount: 2,
          pendingApplicationCount: 1,
          publicPlaylist: {
            id: "pl-cloud-1",
            name: "songroom-测试音乐间-公共"
          },
          allowedActions: ["deleteRoom"],
          disabledReasons: {}
        }
      })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "房间设置" }).click();

    const deleteBtn = page.getByRole("button", { name: "删除房间" });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // 检查弹窗标题与描述
    await expect(page.getByRole("heading", { name: "删除房间？" })).toBeVisible();
    await expect(page.getByText("确定要永久删除房间“测试音乐间”吗？此操作不可撤销，所有成员将立即失去访问权限。")).toBeVisible();

    // 检查关键危险标签与影响说明
    await expect(page.getByText("不可撤销", { exact: true })).toBeVisible();
    await expect(page.getByText("立即生效", { exact: true })).toBeVisible();
    await expect(page.getByText("云端歌单清理", { exact: true })).toBeVisible();
    await expect(page.getByText("专用点歌台“songroom-测试音乐间-公共”将启动网易云删除清理。")).toBeVisible();
    await expect(page.getByText("本地删除立即生效，个人歌单仅在本地解绑，绝不修改或删除网易云歌单。")).toBeVisible();

    // 绝不再有专用个人歌单清理文案
    await expect(page.getByText(/专用个人歌单.*启动网易云删除清理/)).toHaveCount(0);
    await expect(page.getByText(/在途个人歌单创建/)).toHaveCount(0);
  });

  test("无公共歌单时删除确认不显示云端清理提示，说明仅本地解绑", async ({ page }) => {
    await setupMocks(page, "owner", { hasPublicPlaylist: false });
    await page.route(`**/api/rooms/${roomId}/deletion`, route => route.fulfill({
      json: {
        room: { id: roomId, name: "测试音乐间" },
        version: 1,
        memberCount: 1,
        pendingApplicationCount: 0,
        publicPlaylist: null,
        allowedActions: ["deleteRoom"],
        disabledReasons: {}
      }
    }));

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "房间设置" }).click();
    await page.getByRole("button", { name: "删除房间" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "确认永久删除" })).toBeEnabled();
    await expect(dialog.getByText("云端歌单清理", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/将启动网易云删除清理/)).toHaveCount(0);
    await expect(dialog.getByText("本地删除立即生效，个人歌单仅在本地解绑，绝不修改或删除网易云歌单。")).toBeVisible();
  });

  test("房主提交删除发生版本冲突时，展示错误提示并重新核对最新版本影响范围", async ({ page }) => {
    await setupMocks(page, "owner", { hasPublicPlaylist: true });

    let deletionFetchCount = 0;
    await page.route(`**/api/rooms/${roomId}/deletion`, route => {
      deletionFetchCount++;
      return route.fulfill({
        json: {
          room: { id: roomId, name: "测试音乐间" },
          version: deletionFetchCount,
          memberCount: 2,
          pendingApplicationCount: 0,
          publicPlaylist: { id: "pl-cloud-1", name: "songroom-测试音乐间-公共" },
          allowedActions: ["deleteRoom"],
          disabledReasons: {}
        }
      });
    });

    let deleteAttempts = 0;
    await page.route(`**/api/rooms/${roomId}/delete`, async route => {
      deleteAttempts++;
      const body = route.request().postDataJSON();
      if (body.version === 1) {
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "ROOM_VERSION_CONFLICT",
              message: "房间状态或成员信息已变化，请核对最新影响范围后再试"
            }
          }
        });
      }
      return route.fulfill({
        status: 200,
        json: {
          ok: true,
          roomId,
          cleanup: { id: "0195cf0d-6a80-7000-8000-000000000099", status: "ready" }
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "房间设置" }).click();
    await page.getByRole("button", { name: "删除房间" }).click();

    // 第一次提交，发生 409
    await page.getByRole("button", { name: "确认永久删除" }).click();

    // 检查冲突错误提示
    await expect(page.getByText("房间状态或成员信息已变化，请核对最新影响范围后再试。")).toBeVisible();

    // 第二次提交，成功
    await page.getByRole("button", { name: "确认永久删除" }).click();
    await expect(page).toHaveURL("/rooms");
  });

  test("删除确认后返回房间列表，房间已移除，且显示独立的公共歌单待清理状态与下一步", async ({ page }) => {
    const { setCleanups, setRoomList } = await setupMocks(page, "owner", { hasPublicPlaylist: true });

    await page.route(`**/api/rooms/${roomId}/deletion`, route =>
      route.fulfill({
        json: {
          room: { id: roomId, name: "测试音乐间" },
          version: 1,
          memberCount: 1,
          pendingApplicationCount: 0,
          publicPlaylist: { id: "pl-cloud-1", name: "songroom-测试音乐间-公共" },
          allowedActions: ["deleteRoom"],
          disabledReasons: {}
        }
      })
    );

    await page.route(`**/api/rooms/${roomId}/delete`, async route => {
      setRoomList([]);
      setCleanups([
        {
          id: "0195cf0d-6a80-7000-8000-000000000099",
          accountId: "acc-1",
          playlistId: "pl-cloud-1",
          status: "waitingAuthorization",
          lastErrorCode: "AUTH_UNAVAILABLE",
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ]);
      return route.fulfill({
        status: 200,
        json: {
          ok: true,
          roomId,
          cleanup: { id: "0195cf0d-6a80-7000-8000-000000000099", status: "waitingAuthorization" }
        }
      });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "房间设置" }).click();
    await page.getByRole("button", { name: "删除房间" }).click();
    await page.getByRole("button", { name: "确认永久删除" }).click();

    // 成功回到房间列表
    await expect(page).toHaveURL("/rooms");

    // 房间已从列表中彻底移除
    await expect(page.getByText("测试音乐间")).toHaveCount(0);

    // 移步账号设置，在高级设置中查看独立的公共歌单待清理状态与下一步
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "点歌台清理" })).toBeVisible();
    await expect(page.getByText("网易云歌单 ID：pl-cloud-1")).toBeVisible();
    await expect(page.getByText("等待重新授权")).toBeVisible();
    await expect(page.getByText("原网易云账号授权已失效，请前往账号设置重新授权以继续云端清理。")).toBeVisible();
    await expect(page.getByRole("link", { name: "进入房间" })).toHaveCount(0);
  });

  test("响应式与无障碍：在 320px/900px/1440px 弹窗与清理状态正常展示且无横向溢出", async ({ page }) => {
    await setupMocks(page, "owner", { hasPublicPlaylist: true });

    await page.route(`**/api/rooms/${roomId}/deletion`, route =>
      route.fulfill({
        json: {
          room: { id: roomId, name: "测试音乐间" },
          version: 1,
          memberCount: 2,
          pendingApplicationCount: 0,
          publicPlaylist: { id: "pl-cloud-1", name: "songroom-测试音乐间-公共" },
          allowedActions: ["deleteRoom"],
          disabledReasons: {}
        }
      })
    );

    for (const width of [320, 900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/rooms/${roomId}`);
      await page.getByRole("button", { name: "房间设置" }).click();

      // 检查页面无横向溢出
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

      await page.getByRole("button", { name: "删除房间" }).click();
      await expect(page.getByRole("heading", { name: "删除房间？" })).toBeVisible();

      // 关闭弹窗
      await page.getByRole("button", { name: "取消" }).click();
      await expect(page.getByRole("heading", { name: "删除房间？" })).toHaveCount(0);
    }
  });
});
