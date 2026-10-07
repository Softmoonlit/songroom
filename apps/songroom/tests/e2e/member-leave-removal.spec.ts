import { expect, test, type Page } from "@playwright/test";

const roomId = "0195cf0d-6a80-7000-8000-000000000051";
const ownerMemberId = "0195cf0d-6a80-7000-8000-000000000052";
const roommateMemberId = "0195cf0d-6a80-7000-8000-000000000053";

async function setupMocks(page: Page, role: "owner" | "roommate") {
  const isOwner = role === "owner";
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
    name: "音乐交流间",
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
        pendingCount: 0,
        allowedActions: isOwner
          ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite"]
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
        snapshot: { version: 1, syncedAt: Date.now(), trackCount: 1, tracks: [{ position: 0, songId: "s-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", requesters: ["房主阿林", "室友小张"] }] },
        lastRefreshError: null,
        operation: null,
        allowedActions: ["refreshPublicPlaylist", "requestSong"],
        disabledReason: null,
        version: 1
      }
    })
  );

  let members = [
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
      disabledReasons: isOwner ? { renameNickname: "SELF_ONLY" } : {}
    }
  ];

  await page.route(`**/api/rooms/${roomId}/members`, route =>
    route.fulfill({
      json: {
        version: 1,
        members,
        allowedActions: isOwner
          ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite"]
          : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY" }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/invite`, route =>
    route.fulfill({
      json: {
        code: "Code_12345",
        generation: 1,
        version: 1,
        pendingCount: 0,
        allowedActions: ["copyInvite", "resetInvite"],
        disabledReasons: {}
      }
    })
  );
}

test("室友进入房间设置，点击退出房间显示二次确认并成功返回房间列表", async ({ page }) => {
  await setupMocks(page, "roommate");

  let leaveCalled = false;
  await page.route(`**/api/rooms/${roomId}/leave`, async route => {
    leaveCalled = true;
    const body = route.request().postDataJSON();
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    return route.fulfill({ json: { ok: true, roomId } });
  });

  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间设置" }).click();

  // 查看设置页面中的“退出房间”按钮
  const leaveBtn = page.getByRole("button", { name: "退出房间" });
  await expect(leaveBtn).toBeVisible();
  await leaveBtn.click();

  // 二次确认对话框打开，检查文案及影响范围
  await expect(page.getByRole("heading", { name: "退出房间？" })).toBeVisible();
  await expect(page.getByText("确定要退出房间“音乐交流间”吗？")).toBeVisible();
  await expect(page.getByText("退出后立即撤销你在该房间的所有访问与操作权限")).toBeVisible();
  await expect(page.getByText("释放你的昵称“室友小张”，供其他人使用")).toBeVisible();
  await expect(page.getByText("清除你在当前公共歌单上的全部点歌人标签")).toBeVisible();
  await expect(page.getByText("公共歌单中的已有歌曲及其他成员的点歌人标签仍将保留")).toBeVisible();
  // 严禁包含个人资源或个人歌单清理文案
  await expect(page.getByText(/个人歌单|个人资源/)).toHaveCount(0);

  // 点击确认退出
  await page.getByRole("button", { name: "确认退出" }).click();

  // 验证调用了 leave API 并返回房间列表
  expect(leaveCalled).toBe(true);
  await expect(page).toHaveURL("/rooms");
});

test("房主进入成员列表，点击室友显示移除成员按钮及二次确认，完成后该成员从列表中消失", async ({ page }) => {
  await setupMocks(page, "owner");

  let removeCalled = false;
  await page.route(`**/api/rooms/${roomId}/members`, route =>
    route.fulfill({
      json: {
        version: removeCalled ? 2 : 1,
        members: removeCalled
          ? [
              {
                id: ownerMemberId,
                nickname: "房主阿林",
                role: "owner",
                isSelf: true,
                allowedActions: ["renameNickname"],
                disabledReasons: {}
              }
            ]
          : [
              {
                id: ownerMemberId,
                nickname: "房主阿林",
                role: "owner",
                isSelf: true,
                allowedActions: ["renameNickname"],
                disabledReasons: {}
              },
              {
                id: roommateMemberId,
                nickname: "室友小张",
                role: "roommate",
                isSelf: false,
                allowedActions: ["removeMember"],
                disabledReasons: { renameNickname: "SELF_ONLY" }
              }
            ],
        allowedActions: ["renameRoom", "renameNickname", "reviewApplications", "readInvite"],
        disabledReasons: {}
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/members/${roommateMemberId}/remove`, async route => {
    removeCalled = true;
    const body = route.request().postDataJSON();
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.version).toBe(1);
    return route.fulfill({
      json: {
        version: 2,
        members: [
          {
            id: ownerMemberId,
            nickname: "房主阿林",
            role: "owner",
            isSelf: true,
            allowedActions: ["renameNickname"],
            disabledReasons: {}
          }
        ],
        allowedActions: ["renameRoom", "renameNickname", "reviewApplications", "readInvite"],
        disabledReasons: {}
      }
    });
  });

  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员" }).click();

  // 点击室友小张进入成员详情
  await page.getByRole("button", { name: "查看成员：室友小张" }).click();
  await expect(page.getByText("角色室友")).toBeVisible();

  // 点击“移除成员”
  const removeBtn = page.getByRole("button", { name: "移除成员" });
  await expect(removeBtn).toBeVisible();
  await removeBtn.click();

  // 二次确认对话框打开，检查文案及影响范围
  await expect(page.getByRole("heading", { name: "移除成员“室友小张”？" })).toBeVisible();
  await expect(page.getByText("确定要将“室友小张”移出房间吗？")).toBeVisible();
  await expect(page.getByText("立即撤销该成员在当前房间的所有访问与操作权限")).toBeVisible();
  await expect(page.getByText("释放昵称“室友小张”，供新成员使用")).toBeVisible();
  await expect(page.getByText("清除该成员在当前公共歌单上的全部点歌人标签")).toBeVisible();
  await expect(page.getByText("公共歌单中的已有歌曲及其他成员的点歌人标签仍将保留")).toBeVisible();
  // 严禁包含个人资源或个人歌单清理文案
  await expect(page.getByText(/个人歌单|个人资源/)).toHaveCount(0);

  // 点击确认移除
  await page.getByRole("button", { name: "确认移除" }).click();

  // 验证调用了 remove API 并回到成员列表，且列表中不再有室友小张
  expect(removeCalled).toBe(true);
  await expect(page.getByRole("button", { name: "查看成员：房主阿林" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看成员：室友小张" })).toHaveCount(0);
});

test("房主查看自己不显示“移除成员”按钮；房间设置中房主不显示“退出房间”按钮", async ({ page }) => {
  await setupMocks(page, "owner");

  await page.goto(`/rooms/${roomId}`);

  // 检查房间设置：房主不显示退出房间按钮
  await page.getByRole("button", { name: "房间设置" }).click();
  await expect(page.getByRole("button", { name: "退出房间" })).toHaveCount(0);

  // 检查房间成员：房主查看自己不显示移除成员按钮
  await page.getByRole("button", { name: "房间成员" }).click();
  await page.getByRole("button", { name: "查看成员：房主阿林" }).click();
  await expect(page.getByRole("button", { name: "移除成员" })).toHaveCount(0);
});

test("房主移除成员时发生版本冲突，显示错误提示并保持对话框交互状态", async ({ page }) => {
  await setupMocks(page, "owner");

  await page.route(`**/api/rooms/${roomId}/members/${roommateMemberId}/remove`, route =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "ROOM_VERSION_CONFLICT",
          message: "房间状态或成员信息已变化，请核对最新影响范围后再试。"
        }
      }
    })
  );

  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员" }).click();
  await page.getByRole("button", { name: "查看成员：室友小张" }).click();
  await page.getByRole("button", { name: "移除成员" }).click();

  await page.getByRole("button", { name: "确认移除" }).click();

  // 错误提示展示在对话框中
  await expect(page.getByRole("alert")).toHaveText("房间状态或成员信息已变化，请核对最新影响范围后再试。");
});
