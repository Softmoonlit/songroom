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

test("房主进入房间设置，点击删除房间弹窗展示高信噪比核心风险、关键危险标签与全部成员专用歌单清理说明", async ({ page }) => {
  await setupMocks(page, "owner", { hasPublicPlaylist: true });

  await page.route(`**/api/rooms/${roomId}/deletion`, route =>
    route.fulfill({
      json: {
        room: { id: roomId, name: "测试音乐间" },
        version: 3,
        memberCount: 2,
        pendingApplicationCount: 1,
        personalPlaylistCount: 2,
        pendingPersonalPlaylistCount: 0,
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

  await expect(page.getByText("全部成员的 2 份专用个人歌单（包含房主）将启动网易云删除清理。")).toBeVisible();
  await expect(page.getByText("本地删除立即生效，云端清理失败会保留待处理任务；不影响其他房间或原有外部歌单。")).toBeVisible();

  // 废除统计行、调试聚合版本号与长篇排比列表
  await expect(page.getByText(/当前成员/)).toHaveCount(0);
  await expect(page.getByText(/待处理申请/)).toHaveCount(0);
  await expect(page.getByText(/聚合版本/)).toHaveCount(0);
  await expect(page.locator(".leave-consequences")).toHaveCount(0);
});

test("仅有房主个人歌单而无公共歌单，删除前仍显示清理范围及失败后的处理说明", async ({ page }) => {
  await setupMocks(page, "owner", { hasPublicPlaylist: false });
  await page.route(`**/api/rooms/${roomId}/deletion`, route => route.fulfill({
    json: {
      room: { id: roomId, name: "测试音乐间" },
      version: 1,
      memberCount: 1,
      pendingApplicationCount: 0,
      personalPlaylistCount: 1,
      pendingPersonalPlaylistCount: 0,
      publicPlaylist: null,
      allowedActions: ["deleteRoom"],
      disabledReasons: {}
    }
  }));
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间设置" }).click();
  await expect(page.getByText("永久解散并删除此房间，所有成员将立即失去访问权限，同时启动点歌台及全部成员专用个人歌单清理。")).toBeVisible();
  await page.getByRole("button", { name: "删除房间" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("云端歌单清理", { exact: true })).toBeVisible();
  await expect(dialog.getByText("全部成员的 1 份专用个人歌单（包含房主）将启动网易云删除清理。")).toBeVisible();
  await expect(dialog.getByText("本地删除立即生效，云端清理失败会保留待处理任务；不影响其他房间或原有外部歌单。")).toBeVisible();
  await expect(dialog.getByText(/专用点歌台/)).toHaveCount(0);
});

test("只有未知在途个人歌单创建时，删除确认说明可能产生云端资源并在晚到后清理", async ({ page }) => {
  await setupMocks(page, "owner", { hasPublicPlaylist: false });
  await page.route(`**/api/rooms/${roomId}/deletion`, route => route.fulfill({
    json: {
      room: { id: roomId, name: "测试音乐间" },
      version: 1,
      memberCount: 2,
      pendingApplicationCount: 0,
      personalPlaylistCount: 0,
      pendingPersonalPlaylistCount: 2,
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
  await expect(dialog.getByText("云端歌单清理", { exact: true })).toBeVisible();
  await expect(dialog.getByText("另有 2 个在途个人歌单创建可能产生云端资源，晚到结果确认后会继续清理。")).toBeVisible();
  await expect(dialog.getByText(/份专用个人歌单|专用点歌台/)).toHaveCount(0);
  await expect(dialog.getByText("本地删除立即生效，云端清理失败会保留待处理任务；不影响其他房间或原有外部歌单。")).toBeVisible();
});

test("房间没有已知云端歌单或在途创建时，删除确认不显示云端清理提示", async ({ page }) => {
  await setupMocks(page, "owner", { hasPublicPlaylist: false });
  await page.route(`**/api/rooms/${roomId}/deletion`, route => route.fulfill({
    json: {
      room: { id: roomId, name: "测试音乐间" },
      version: 1,
      memberCount: 1,
      pendingApplicationCount: 0,
      personalPlaylistCount: 0,
      pendingPersonalPlaylistCount: 0,
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
          personalPlaylistCount: 0,
          pendingPersonalPlaylistCount: 0,
          publicPlaylist: { id: "pl-cloud-1", name: "songroom-测试音乐间-公共" },
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
          personalPlaylistCount: 2,
          pendingPersonalPlaylistCount: 0,
          publicPlaylist: { id: "pl-cloud-1", name: "songroom-测试音乐间-公共" },
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

  // 第一次提交，发生 409
  await page.getByRole("button", { name: "确认永久删除" }).click();

  // 检查冲突错误提示
  await expect(page.getByText("房间状态或成员信息已变化，请核对最新影响范围后再试。")).toBeVisible();

  await expect(page.getByText("全部成员的 2 份专用个人歌单（包含房主）将启动网易云删除清理。")).toBeVisible();

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
        personalPlaylistCount: 0,
        pendingPersonalPlaylistCount: 0,
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

  // 房间列表主视图不再展示底层公共歌单清理进度（彻底移出并归入账号高级设置）
  await expect(page.getByRole("heading", { name: "点歌台清理" })).toHaveCount(0);

  // 移步账号设置，在高级设置中查看独立的公共歌单待清理状态与下一步
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "点歌台清理" })).toBeVisible();
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
        personalPlaylistCount: 0,
        pendingPersonalPlaylistCount: 0,
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
