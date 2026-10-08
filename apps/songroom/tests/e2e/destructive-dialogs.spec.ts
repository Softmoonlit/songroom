import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const roomId = "0195cf0d-6a80-7000-8000-000000000077";
const ownerMemberId = "0195cf0d-6a80-7000-8000-000000000078";
const roommateMemberId = "0195cf0d-6a80-7000-8000-000000000079";

async function setupDialogMocks(page: Page, role: "owner" | "roommate") {
  const isOwner = role === "owner";
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "test-session", expiresAt: "2099-01-01T00:00:00Z" },
        user: {
          id: isOwner ? "user-owner" : "user-roommate",
          name: isOwner ? "房主用户" : "室友用户",
          email: "test@example.com",
          emailVerified: false
        }
      }
    })
  );

  const roomState = {
    id: roomId,
    name: "测试音乐间",
    role,
    nickname: isOwner ? "房主阿林" : "室友小张"
  };

  await page.route("**/api/rooms", route =>
    route.fulfill({
      json: {
        rooms: [{ ...roomState, version: 1, allowedActions: ["enterRoom"], disabledReasons: {} }],
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
        pendingCount: 2,
        allowedActions: isOwner
          ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"]
          : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY" }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/public-playlist`, route =>
    route.fulfill({
      json: {
        playlist: { id: "pl-1", name: "公共歌单" },
        invalidatedTarget: null,
        snapshot: {
          version: 1,
          syncedAt: Date.now(),
          trackCount: 1,
          tracks: [{ position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: ["房主阿林"] }]
        },
        lastRefreshError: null,
        operation: null,
        allowedActions: ["refreshPublicPlaylist", "requestSong"],
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
          {
            id: ownerMemberId,
            nickname: "房主阿林",
            role: "owner",
            isSelf: isOwner,
            allowedActions: isOwner ? ["renameNickname"] : [],
            disabledReasons: isOwner ? {} : { renameNickname: "SELF_ONLY" }
          },
          {
            id: roommateMemberId,
            nickname: "室友小张",
            role: "roommate",
            isSelf: !isOwner,
            allowedActions: isOwner ? ["removeMember"] : ["renameNickname"],
            disabledReasons: {}
          }
        ],
        allowedActions: isOwner ? ["reviewApplications", "readInvite"] : [],
        disabledReasons: {}
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/invite`, route =>
    route.fulfill({
      json: {
        code: "TESTINV_12",
        generation: 1,
        pendingCount: 2,
        version: 1,
        allowedActions: ["copyInvite", "resetInvite"],
        disabledReasons: {}
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/deletion`, route =>
    route.fulfill({
      json: {
        room: { id: roomId, name: "测试音乐间" },
        version: 1,
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
}

test.describe("Ticket 03: 全站破坏性确认弹窗高信噪比规范", () => {
  test("删除房间确认弹窗：精炼为核心不可逆警告、红色警示标签与明确动作按钮，废除排比列表与版本号", async ({ page }) => {
    await setupDialogMocks(page, "owner");
    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("button", { name: "房间设置" }).click();
    const deleteBtn = page.getByRole("button", { name: "删除房间" });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();

    // 1. 动宾标题
    await expect(dialog.getByRole("heading", { name: "删除房间？", exact: true })).toBeVisible();

    // 2. 核心单句风险描述
    await expect(dialog.getByText("确定要永久删除房间“测试音乐间”吗？此操作不可撤销，所有成员将立即失去访问权限。")).toBeVisible();

    // 3. 关键危险标签与影响说明
    await expect(dialog.getByText("不可撤销", { exact: true })).toBeVisible();
    await expect(dialog.getByText("立即生效", { exact: true })).toBeVisible();
    await expect(dialog.getByText("云端歌单清理", { exact: true })).toBeVisible();
    await expect(dialog.getByText("专用公共歌单“songroom-测试音乐间-公共”将启动网易云删除清理。")).toBeVisible();

    // 4. 彻底废除统计行、排比后果清单与调试聚合版本号
    await expect(dialog.locator(".leave-consequences")).toHaveCount(0);
    await expect(dialog.getByText(/聚合版本/)).toHaveCount(0);
    await expect(dialog.getByText(/当前成员/)).toHaveCount(0);
    await expect(dialog.getByText(/待处理申请/)).toHaveCount(0);

    // 5. 明确操作按钮视觉层级
    const cancelBtn = dialog.getByRole("button", { name: "取消", exact: true });
    const confirmBtn = dialog.getByRole("button", { name: "确认永久删除", exact: true });
    await expect(cancelBtn).toBeVisible();
    await expect(confirmBtn).toBeVisible();
    expect(await confirmBtn.evaluate(el => el.classList.contains("danger-button"))).toBe(true);
    expect(await cancelBtn.evaluate(el => el.classList.contains("secondary-button"))).toBe(true);

    // 6. Axe 无障碍扫描
    const axeResults = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(axeResults.violations).toEqual([]);

    // 7. 取消关闭
    await cancelBtn.click();
    await expect(dialog).toHaveCount(0);
  });

  test("退出房间确认弹窗：精炼为权限撤销与标签清除核心单句、危险标签，废除排比列表", async ({ page }) => {
    await setupDialogMocks(page, "roommate");
    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("button", { name: "房间设置" }).click();
    const leaveBtn = page.getByRole("button", { name: "退出房间" });
    await expect(leaveBtn).toBeVisible();
    await leaveBtn.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();

    // 1. 动宾标题
    await expect(dialog.getByRole("heading", { name: "退出房间？", exact: true })).toBeVisible();

    // 2. 核心单句风险描述
    await expect(
      dialog.getByText("确定要退出房间“测试音乐间”吗？退出后将立即撤销你在该房间的所有访问与操作权限，并清除你的点歌人标签。")
    ).toBeVisible();

    // 3. 关键危险标签
    await expect(dialog.getByText("权限立即撤销", { exact: true })).toBeVisible();
    await expect(dialog.getByText("清除点歌标签", { exact: true })).toBeVisible();
    await expect(dialog.getByText("释放昵称“室友小张”", { exact: true })).toBeVisible();

    // 4. 彻底废除排比后果清单
    await expect(dialog.locator(".leave-consequences")).toHaveCount(0);
    await expect(dialog.getByText(/个人歌单|个人资源/)).toHaveCount(0);

    // 5. 明确操作按钮
    const cancelBtn = dialog.getByRole("button", { name: "取消", exact: true });
    const confirmBtn = dialog.getByRole("button", { name: "确认退出", exact: true });
    await expect(cancelBtn).toBeVisible();
    await expect(confirmBtn).toBeVisible();
    expect(await confirmBtn.evaluate(el => el.classList.contains("danger-button"))).toBe(true);

    await cancelBtn.click();
    await expect(dialog).toHaveCount(0);
  });

  test("移除成员确认弹窗：精炼为移出房间后果核心单句与关键危险标签，废除排比列表", async ({ page }) => {
    await setupDialogMocks(page, "owner");
    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("button", { name: "房间成员" }).click();
    await page.getByRole("button", { name: "查看成员：室友小张" }).click();

    const removeBtn = page.getByRole("button", { name: "移除成员" });
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();

    // 1. 动宾标题
    await expect(dialog.getByRole("heading", { name: "移除成员“室友小张”？", exact: true })).toBeVisible();

    // 2. 核心单句风险描述
    await expect(
      dialog.getByText("确定要将“室友小张”移出房间吗？移出后将立即撤销该成员的所有访问与操作权限，并清除其在公共歌单上的点歌人标签。")
    ).toBeVisible();

    // 3. 关键危险标签
    await expect(dialog.getByText("权限立即撤销", { exact: true })).toBeVisible();
    await expect(dialog.getByText("清除点歌标签", { exact: true })).toBeVisible();
    await expect(dialog.getByText("释放昵称“室友小张”", { exact: true })).toBeVisible();

    // 4. 彻底废除排比后果清单
    await expect(dialog.locator(".leave-consequences")).toHaveCount(0);

    // 5. 明确操作按钮
    const cancelBtn = dialog.getByRole("button", { name: "取消", exact: true });
    const confirmBtn = dialog.getByRole("button", { name: "确认移除", exact: true });
    await expect(cancelBtn).toBeVisible();
    await expect(confirmBtn).toBeVisible();
    expect(await confirmBtn.evaluate(el => el.classList.contains("danger-button"))).toBe(true);

    await cancelBtn.click();
    await expect(dialog).toHaveCount(0);
  });

  test("重置邀请确认弹窗：精炼为旧码失效与取消待处理申请核心单句与危险标签", async ({ page }) => {
    await setupDialogMocks(page, "owner");
    await page.goto(`/rooms/${roomId}`);

    await page.getByRole("button", { name: "房间成员" }).click();
    await page.getByRole("button", { name: "邀请室友" }).click();
    const resetBtn = page.getByRole("button", { name: "重置邀请码" });
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    const dialog = page.getByRole("alertdialog").filter({ hasText: "重置房间邀请？" });
    await expect(dialog).toBeVisible();

    // 1. 动宾标题
    await expect(dialog.getByRole("heading", { name: "重置房间邀请？", exact: true })).toBeVisible();

    // 2. 核心单句风险描述
    await expect(dialog.getByText("旧邀请码和链接将立即失效，并取消 2 份待处理申请。当前成员不受影响。")).toBeVisible();

    // 3. 关键危险标签
    await expect(dialog.getByText("不可撤销", { exact: true })).toBeVisible();
    await expect(dialog.getByText("旧码立即失效", { exact: true })).toBeVisible();
    await expect(dialog.getByText("取消 2 份待处理申请", { exact: true })).toBeVisible();

    // 4. 明确操作按钮
    const cancelBtn = dialog.getByRole("button", { name: "保留当前邀请", exact: true });
    const confirmBtn = dialog.getByRole("button", { name: "确认重置邀请", exact: true });
    await expect(cancelBtn).toBeVisible();
    await expect(confirmBtn).toBeVisible();
    expect(await confirmBtn.evaluate(el => el.classList.contains("danger-button"))).toBe(true);

    await cancelBtn.click();
    await expect(dialog).toHaveCount(0);
  });
});
