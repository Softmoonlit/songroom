import { expect, test, type Page } from "@playwright/test";

const roomId = "0195cf0d-6a80-7000-8000-000000000061";
const ownerMemberId = "0195cf0d-6a80-7000-8000-000000000062";
const roommateMemberId = "0195cf0d-6a80-7000-8000-000000000063";

async function setupMocks(page: Page, role: "owner" | "roommate", options?: { hasPublicPlaylist?: boolean }) {
  const isOwner = role === "owner";
  const hasPublicPlaylist = options?.hasPublicPlaylist ?? true;

  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "test-session", expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: isOwner ? "user-owner" : "user-roommate", name: isOwner ? "房主用户" : "室友用户", email: "test@example.com", emailVerified: false }
      }
    })
  );

  const roomState = {
    id: roomId,
    name: "测试音乐间",
    role,
    nickname: isOwner ? "房主小王" : "室友小李"
  };

  let roomList = [{ ...roomState, version: 1, allowedActions: ["enterRoom"], disabledReasons: {} }];

  await page.route("**/api/rooms", route =>
    route.fulfill({
      json: {
        rooms: roomList,
        allowedActions: ["openCreateRoom", "openJoin"],
        disabledReasons: {}
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: {
        room: roomState,
        version: 1,
        pendingCount: 0,
        allowedActions: isOwner
          ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"]
          : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY", deleteRoom: "OWNER_ONLY" }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/public-playlist`, route =>
    route.fulfill({
      json: {
        playlist: hasPublicPlaylist ? { id: "pl-cloud-1", name: "songroom-测试音乐间-公共" } : null,
        invalidatedTarget: null,
        snapshot: null,
        lastRefreshError: null,
        operation: null,
        allowedActions: ["createPublicPlaylist"],
        disabledReason: null,
        version: 1
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/members`, route =>
    route.fulfill({
      json: {
        version: 1,
        members: [
          { id: ownerMemberId, nickname: "房主小王", role: "owner", isSelf: isOwner, allowedActions: isOwner ? ["renameNickname"] : [], disabledReasons: {} },
          { id: roommateMemberId, nickname: "室友小李", role: "roommate", isSelf: !isOwner, allowedActions: [], disabledReasons: {} }
        ],
        allowedActions: isOwner ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"] : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY", deleteRoom: "OWNER_ONLY" }
      }
    })
  );

  await page.route("**/api/join-applications", route =>
    route.fulfill({ json: { applications: [] } })
  );

  let cleanups: any[] = [];
  await page.route("**/api/cleanups/public-playlists", route =>
    route.fulfill({ json: { cleanups } })
  );

  return {
    setCleanups: (newCleanups: any[]) => { cleanups = newCleanups; },
    setRoomList: (newList: any[]) => { roomList = newList; }
  };
}

test("室友进入房间设置，仅显示退出房间，不显示删除房间按钮", async ({ page }) => {
  await setupMocks(page, "roommate");
  await page.goto(`/rooms/${roomId}`);

  await page.getByRole("button", { name: "房间设置" }).click();
  await expect(page.getByRole("button", { name: "退出房间" })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除房间" })).toHaveCount(0);
});

test("房主进入房间设置，点击删除房间弹窗展示最新影响范围、聚合版本与专用公共歌单清理说明", async ({ page }) => {
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
          name: "songroom-测试音乐间-公共",
          willCleanUp: true
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
  await expect(page.getByText("确定要永久删除房间“测试音乐间”吗？此操作不可撤销。")).toBeVisible();

  // 检查影响范围信息
  await expect(page.getByText("当前成员：2 人")).toBeVisible();
  await expect(page.getByText("待处理申请：1 份")).toBeVisible();
  await expect(page.getByText("专用歌单“songroom-测试音乐间-公共”（ID: pl-cloud-1），将启动网易云删除清理")).toBeVisible();
  await expect(page.getByText("聚合版本：v3")).toBeVisible();

  // 检查操作后果说明
  await expect(page.getByText("本地立即永久删除房间，所有设备与成员马上失去访问")).toBeVisible();
  await expect(page.getByText("彻底清除全部成员关系、昵称、邀请码及待审批申请")).toBeVisible();
  await expect(page.getByText("彻底清除全部点歌人标签及公共歌单绑定引用")).toBeVisible();
  await expect(page.getByText("仅为该房间创建的专用公共歌单启动云端删除，不影响其他房间与账号")).toBeVisible();
  await expect(page.getByText("房间不提供恢复入口，所有数据不可撤销")).toBeVisible();
});

test("房主提交删除发生版本冲突时，展示错误提示并重新核对最新版本影响范围", async ({ page }) => {
  await setupMocks(page, "owner", { hasPublicPlaylist: true });

  let deletionFetchCount = 0;
  await page.route(`**/api/rooms/${roomId}/deletion`, route => {
    deletionFetchCount++;
    if (deletionFetchCount === 1) {
      return route.fulfill({
        json: {
          room: { id: roomId, name: "测试音乐间" },
          version: 1,
          memberCount: 2,
          pendingApplicationCount: 0,
          publicPlaylist: { id: "pl-cloud-1", name: "songroom-测试音乐间-公共", willCleanUp: true },
          allowedActions: ["deleteRoom"],
          disabledReasons: {}
        }
      });
    } else {
      return route.fulfill({
        json: {
          room: { id: roomId, name: "测试音乐间" },
          version: 2,
          memberCount: 3,
          pendingApplicationCount: 0,
          publicPlaylist: { id: "pl-cloud-1", name: "songroom-测试音乐间-公共", willCleanUp: true },
          allowedActions: ["deleteRoom"],
          disabledReasons: {}
        }
      });
    }
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

  await expect(page.getByText("当前成员：2 人")).toBeVisible();
  await expect(page.getByText("聚合版本：v1")).toBeVisible();

  // 第一次提交，发生 409
  await page.getByRole("button", { name: "确认永久删除" }).click();

  // 检查冲突错误提示
  await expect(page.getByText("房间状态或成员信息已变化，请核对最新影响范围后再试。")).toBeVisible();

  // 检查自动重新拉取后刷新了成员数和聚合版本
  await expect(page.getByText("当前成员：3 人")).toBeVisible();
  await expect(page.getByText("聚合版本：v2")).toBeVisible();

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

  // 显示独立的公共歌单清理区域（与房间物理分离，明确标明房间不可恢复）
  await expect(page.getByRole("heading", { name: "公共歌单清理" })).toBeVisible();
  await expect(page.getByText("网易云歌单 ID：pl-cloud-1")).toBeVisible();
  await expect(page.getByText("等待重新授权")).toBeVisible();
  await expect(page.getByText("原网易云账号授权已失效，请前往账号设置重新授权以继续云端清理。")).toBeVisible();
  // 确认清理中不把房间显示为可恢复，没有任何进入房间的入口
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
