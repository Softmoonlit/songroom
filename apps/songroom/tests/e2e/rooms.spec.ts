import { expect, test, type Page } from "@playwright/test";
import { publicPlaylistView } from "../../src/shared/public-playlist-contracts.js";
import {
  roomCreateView,
  roomListView,
  roomMembersView,
  roomShellView,
  roomSummary
} from "../../src/shared/room-contracts.js";

// HTTP fixtures cover browser presentation; complete application tests cover permissions and capacity.
const roomId = "0195cf0d-6a80-7000-8000-000000000011";
const otherRoomId = "0195cf0d-6a80-7000-8000-000000000012";
const authorizationId = "0195cf0d-6a80-7000-8000-000000000013";
const memberId = "0195cf0d-6a80-7000-8000-000000000014";
const room = roomSummary.parse({ id: roomId, name: "晚间音乐", role: "owner", nickname: "小林" });
const ownerActions = ["renameRoom", "renameNickname", "reviewApplications", "readInvite"];
const memberListActions = ["renameNickname", "reviewApplications", "readInvite"];
const identity = { accountId: "12345678", nickname: "已绑定音乐账号" };
const createView = roomCreateView.parse({
  authorization: { id: authorizationId, identity },
  allowedActions: ["createRoom"],
  disabledReason: null
});
async function signedIn(page: Page) {
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "room-ui-session", expiresAt: "2099-01-01T00:00:00.000Z" },
        user: { id: "room-ui-user", name: "房间测试账号", email: "room-ui@example.com", emailVerified: false }
      }
    })
  );
  await page.route("**/api/rooms", route => route.fulfill({ json: roomListView.parse({ rooms: [{ ...room, version: 1, allowedActions: ["enterRoom"], disabledReasons: {} }], allowedActions: ["openCreateRoom", "openJoin"], disabledReasons: {} }) }));
  await page.route("**/api/rooms/create-view", route => route.fulfill({ json: createView }));
  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({ json: roomShellView.parse({ room, version: 1, pendingCount: 0, allowedActions: ownerActions, disabledReasons: {} }) })
  );
  await page.route(`**/api/rooms/${roomId}/public-playlist`, route =>
    route.fulfill({ json: publicPlaylistView.parse({ playlist: null, operation: null, allowedActions: ["createPublicPlaylist"], disabledReason: null, version: 1 }) })
  );
  await page.route(`**/api/rooms/${roomId}/members`, route =>
    route.fulfill({
      json: roomMembersView.parse({
        version: 1,
        members: [{ id: memberId, nickname: "小林", role: "owner", isSelf: true, allowedActions: ["renameNickname"], disabledReasons: {} }], allowedActions: memberListActions, disabledReasons: {}
      })
    })
  );
  await page.route(`**/api/rooms/${roomId}/invite`, route =>
    route.fulfill({
      json: {
        code: "InviteCode",
        generation: 1,
        version: 1,
        pendingCount: 0,
        allowedActions: ["copyInvite", "resetInvite"], disabledReasons: {}
      }
    })
  );
}

test("确认本地网易云身份后建房，进入公共歌单而不创建云端歌单", async ({ page }) => {
  await signedIn(page);
  await page.route("**/api/rooms", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { rooms: [], allowedActions: ["openCreateRoom", "openJoin"], disabledReasons: {} } });
    expect(route.request().postDataJSON()).toEqual({
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      authorizationId,
      name: "晚间音乐",
      nickname: "小林"
    });
    await route.fulfill({ status: 200, json: room });
  });
  await page.goto("/rooms");
  await expect(page.getByRole("heading", { name: "还没有房间" })).toBeVisible();
  await page.getByRole("link", { name: "创建房间", exact: true }).click();
  await expect(page.getByText(identity.nickname, { exact: true })).toBeVisible();
  await expect(page.getByText(identity.accountId, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "选择房间播放源账号" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /网易云/ })).toBeChecked();
  await page.getByLabel("房间名称").fill(" 晚间音乐 ");
  await page.getByLabel("我的房间昵称").fill(" 小林 ");
  await expect(page.getByRole("button", { name: "创建并进入房间" })).toBeEnabled();
  await page.getByRole("button", { name: "创建并进入房间" }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  await expect(page.getByRole("heading", { name: "公共歌单", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "尚未创建公共歌单" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "房间导航" }).getByRole("button")).toHaveText([
    "公共歌单",
    "房间成员",
    "房间设置"
  ]);
  await expect(page.getByRole("button", { name: /点歌|新建歌单|搜索|排序|清空/ })).toHaveCount(0);
  await expect(page.getByText("我的歌单", { exact: true })).toHaveCount(0);
});

for (const width of [320, 900, 1440]) {
  test(`${width}px 三入口保持独立成员详情和滚动，重按回顶，离开房间清除状态`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signedIn(page);
    const members = Array.from({ length: 10 }, (_, index) => ({
      id: `0195cf0d-6a80-7000-8000-${String(index + 100).padStart(12, "0")}`,
      nickname: `室友${index + 1}`,
      role: "roommate",
      isSelf: false, allowedActions: [], disabledReasons: {}
    }));
    await page.route(`**/api/rooms/${roomId}/members`, route =>
      route.fulfill({ json: roomMembersView.parse({ version: 1, members, allowedActions: memberListActions, disabledReasons: {} }) })
    );
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: room.name, exact: true })).toBeVisible();
    await expect(page.getByText("当前角色：房主", { exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "房间导航" });
    await expect(nav.getByRole("button")).toHaveText(["公共歌单", "房间成员", "房间设置"]);
    await expect(nav.getByRole("button", { name: "公共歌单" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("button", { name: "房间成员" }).click();
    await expect(page.getByRole("button", { name: "查看成员：室友1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看成员：室友1", exact: true }).click();
    await expect(page.getByRole("heading", { name: "室友1", exact: true })).toBeVisible();
    await expect(page.getByText("室友", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "成员详情" })).not.toContainText("room-ui@example.com");
    await expect(page.getByRole("region", { name: "成员详情" })).not.toContainText("房间测试账号");
    await nav.getByRole("button", { name: "房间设置" }).click();
    await expect(page.getByRole("heading", { name: "房间设置", exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "房间成员" }).click();
    await expect(page.getByRole("heading", { name: "室友1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回成员列表" }).click();
    await page.getByRole("button", { name: "查看成员：室友10" }).scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(100);
    await expect(nav).toBeInViewport();
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    if (width === 320) expect(box!.y + box!.height).toBeCloseTo(800, 0);
    else expect(box!.x).toBeLessThan(200);
    await nav.getByRole("button", { name: "房间设置" }).click();
    await nav.getByRole("button", { name: "房间成员" }).click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(before, 0);
    await nav.getByRole("button", { name: "房间成员" }).click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.getByRole("button", { name: "查看成员：室友1", exact: true }).click();
    await nav.getByRole("button", { name: "房间成员" }).click();
    await expect(page.getByRole("heading", { name: "室友1", exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
    await page.getByRole("link", { name: `进入房间：${room.name}` }).click();
    await expect(nav.getByRole("button", { name: "公共歌单" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("button", { name: "房间成员" }).click();
    await expect(page.getByRole("heading", { name: "房间成员", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "室友1", exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
}

test("完整应用：注册扫码绑定后创建同名房间，身份规范化、容量与账号隔离", async ({ page, browser }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  async function register(target: Page, suffix: string) {
    await target.goto("/register");
    await target.getByLabel("账号称呼").fill(`建房账号${suffix}`);
    await target
      .getByLabel("邮箱")
      .fill(`rooms-${suffix === "房主" ? "owner" : "other"}-${Date.now()}@example.com`);
    await target.getByLabel("密码").fill("correct horse battery staple");
    await target.getByRole("button", { name: "注册并进入房间列表" }).click();
    await expect(target).toHaveURL(/\/rooms$/);
  }
  await register(page, "房主");
  await page.getByRole("link", { name: "创建房间", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建并进入房间" })).toHaveCount(0);
  await page.getByRole("link", { name: "前往账号设置" }).click();
  await page.getByRole("button", { name: "开始扫码绑定" }).click();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await page.getByRole("button", { name: "确认绑定此网易云账号" }).click();
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();
  const createdUrls: string[] = [];
  for (const nickname of [" 林 ", " e\u0301 ", "第三个昵称"]) {
    await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
    await page.getByRole("link", { name: "创建房间", exact: true }).click();
    await page.getByLabel("房间名称").fill(" 同名宿舍 ");
    await page.getByLabel("我的房间昵称").fill(nickname);
    await page.getByRole("button", { name: "创建并进入房间" }).click();
    await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
    createdUrls.push(page.url());
    await expect(page.getByRole("heading", { name: "尚未创建公共歌单" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "房间导航" });
    await nav.getByRole("button", { name: "房间成员" }).click();
    await page
      .getByRole("button", { name: `查看成员：${nickname.trim().normalize("NFC")}`, exact: true })
      .click();
    await expect(page.getByRole("region", { name: "成员详情" })).toContainText(
      nickname === " e\u0301 " ? "é" : nickname.trim()
    );
    await expect(page.getByRole("region", { name: "成员详情" })).not.toContainText("@example.com");
  }
  expect(new Set(createdUrls).size).toBe(3);
  await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "同名宿舍", exact: true })).toHaveCount(3);
  await page.getByRole("link", { name: "创建房间", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建并进入房间" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("3");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    await register(otherPage, "其他账号");
    await expect(otherPage.getByRole("heading", { name: "还没有房间" })).toBeVisible();
    await expect(otherPage.getByRole("heading", { name: "同名宿舍", exact: true })).toHaveCount(0);
    await otherPage.goto(createdUrls[0]!);
    await expect(otherPage.getByRole("alert")).toHaveText("房间不可访问，请返回房间列表。");
    await expect(otherPage.getByRole("navigation", { name: "房间导航" })).toHaveCount(0);
  } finally {
    await otherContext.close();
  }
});

test("窄屏虚拟键盘仅在输入聚焦且 visualViewport 缩小时隐藏底栏", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await signedIn(page);
  await page.goto(`/rooms/${roomId}`);
  const nav = page.getByRole("navigation", { name: "房间导航" });
  await expect(nav).toBeVisible();
  // Chromium desktop has no OS keyboard. Simulate its public viewport events and an editable
  // control without introducing an unimplemented search/form into the delivered room UI.
  await page.getByRole("region", { name: "公共歌单", exact: true }).evaluate(element => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "键盘测试输入");
    element.append(input);
  });
  const input = page.getByRole("textbox", { name: "键盘测试输入" });
  await input.focus();
  await expect(nav).toBeVisible();
  async function viewportHeight(height: number) {
    await page.evaluate(value => {
      Object.defineProperty(window.visualViewport!, "height", { configurable: true, value });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    }, height);
  }
  await viewportHeight(700);
  await expect(nav).toBeVisible();
  await page.evaluate(() => Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 }));
  await viewportHeight(420);
  await expect(nav).toBeHidden();
  await input.evaluate(element => (element as HTMLInputElement).blur());
  await expect(nav).toBeVisible();
  await input.focus();
  await expect(nav).toBeHidden();
  await page.evaluate(() => Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 }));
  await viewportHeight(800);
  await expect(nav).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("从成员详情离开并进入另一房间，不继承详情、角色或滚动", async ({ page }) => {
  await signedIn(page);
  const other = roomSummary.parse({
    id: otherRoomId,
    name: "另一间宿舍",
    role: "roommate",
    nickname: "室友昵称"
  });
  await page.route("**/api/rooms", route =>
    route.fulfill({ json: roomListView.parse({ rooms: [room, other].map(summary => ({ ...summary, version: 1, allowedActions: ["enterRoom"], disabledReasons: {} })), allowedActions: ["openCreateRoom", "openJoin"], disabledReasons: {} }) })
  );
  await page.route(`**/api/rooms/${otherRoomId}`, route =>
    route.fulfill({ json: roomShellView.parse({ room: other, version: 1, pendingCount: null, allowedActions: ["renameNickname"], disabledReasons: {} }) })
  );
  await page.route(`**/api/rooms/${otherRoomId}/members`, route =>
    route.fulfill({
      json: roomMembersView.parse({
        version: 1,
        members: [{ id: memberId, nickname: "室友昵称", role: "roommate", isSelf: true, allowedActions: ["renameNickname"], disabledReasons: {} }], allowedActions: ["renameNickname"], disabledReasons: {}
      })
    })
  );
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await page.getByRole("button", { name: "查看成员：小林", exact: true }).click();
  await expect(page.getByRole("region", { name: "成员详情" })).toBeVisible();
  await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
  await page.getByRole("link", { name: `进入房间：${other.name}` }).click();
  await expect(page.getByText("当前角色：室友", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "公共歌单", exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "房间成员", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "成员详情" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看成员：室友昵称" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("离开建房页后，晚到的建房成功不会跳转回旧房间", async ({ page }) => {
  await signedIn(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let finishDelivery!: () => void;
  const delivered = new Promise<void>(resolve => {
    finishDelivery = resolve;
  });
  await page.route("**/api/rooms", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { rooms: [{ ...room, version: 1, allowedActions: ["enterRoom"], disabledReasons: {} }], allowedActions: ["openCreateRoom", "openJoin"], disabledReasons: {} } });
    await gate;
    await route.fulfill({ status: 200, json: room }).catch(() => undefined);
    finishDelivery();
  });
  await page.goto("/rooms/new");
  await page.getByLabel("房间名称").fill("晚间音乐");
  await page.getByLabel("我的房间昵称").fill("小林");
  const sending = page.waitForRequest(
    request => request.url().endsWith("/api/rooms") && request.method() === "POST"
  );
  await page.getByRole("button", { name: "创建并进入房间" }).click();
  await sending;
  await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
  release();
  await delivered;
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.getByRole("heading", { name: "房间测试账号 的房间" })).toBeVisible();
});

test("建房输入越界不提交，授权失效后撤销身份确认并展示稳定中文提示", async ({ page }) => {
  await signedIn(page);
  let posts = 0;
  let authorizationRemoved = false;
  await page.route("**/api/rooms/create-view", route =>
    route.fulfill({
      json: authorizationRemoved
        ? roomCreateView.parse({
            authorization: null,
            allowedActions: [],
            disabledReason: "NETEASE_AUTH_REQUIRED"
          })
        : createView
    })
  );
  await page.route("**/api/rooms", route => {
    posts += 1;
    authorizationRemoved = true;
    return route.fulfill({
      status: 409,
      json: { error: { code: "NETEASE_AUTH_REQUIRED", message: "raw MUSIC_U_sensitive" } }
    });
  });
  await page.goto("/rooms/new");
  await page.getByLabel("房间名称").fill("abcdefghijklmnopq");
  await page.getByLabel("我的房间昵称").fill("小林");
  await expect(page.getByRole("radio", { name: /网易云/ })).toBeChecked();
  await page.getByRole("button", { name: "创建并进入房间" }).click();
  await expect(page.getByRole("alert")).toContainText("16");
  expect(posts).toBe(0);
  await page.getByLabel("房间名称").fill("晚间音乐");
  await page.getByRole("button", { name: "创建并进入房间" }).click();
  await expect(page.getByRole("alert")).toHaveText("请先在账号设置中绑定有效的网易云账号。");
  await expect(page.getByRole("radio", { name: /网易云/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "创建并进入房间" })).toBeDisabled();
  await expect(page.getByText("raw MUSIC_U_sensitive")).toHaveCount(0);
  await page.getByRole("button", { name: "重新读取网易云身份" }).click();
  await expect(page.getByRole("button", { name: "创建并进入房间" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "前往账号设置" })).toBeVisible();
  expect(posts).toBe(1);
});

for (const width of [320, 900, 1440]) {
  test(`${width}px 成员详情返回上下文吸顶且可以回到成员列表`, async ({ page }) => {
    await page.setViewportSize({ width, height: 300 });
    await signedIn(page);
    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "房间成员", exact: true }).click();
    await page.getByRole("button", { name: "查看成员：小林", exact: true }).click();
    const context = page.getByRole("navigation", { name: "成员详情导航" });
    await expect(context).toBeVisible();
    await expect(context).toContainText("小林");
    await context.evaluate(element => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + 30, behavior: "instant" });
    });
    await expect.poll(async () => (await context.boundingBox())?.y).toBe(0);
    await expect(context).toBeInViewport();
    await context.getByRole("button", { name: "返回成员列表" }).click();
    await expect(page.getByRole("heading", { name: "房间成员", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "成员详情" })).toHaveCount(0);
  });
}


for (const allowed of [false, true]) {
  test(`房间列表由 allowedActions ${allowed ? "显示" : "隐藏"}创建、加入和进入入口`, async ({ page }) => {
    await signedIn(page);
    await page.route("**/api/rooms", route => route.fulfill({ json: roomListView.parse({
      rooms: [{ ...room, version: 1, allowedActions: allowed ? ["enterRoom"] : [], disabledReasons: {} }],
      allowedActions: allowed ? ["openCreateRoom", "openJoin"] : [], disabledReasons: {}
    }) }));
    await page.goto("/rooms");
    await expect(page.getByRole("heading", { name: room.name, exact: true })).toBeVisible();
    for (const name of ["创建房间", "输入邀请码加入", `进入房间：${room.name}`]) {
      const link = page.getByRole("link", { name, exact: true });
      if (allowed) await expect(link).toBeVisible();
      else await expect(link).toHaveCount(0);
    }
  });
}

test("Ticket 02: 房间工作台双栏吸附居中布局与移动端紧凑顶部/底栏自适应", async ({ page }) => {
  await signedIn(page);

  // 1. 桌面 1440px 宽屏：弹性双栏、吸附侧栏、居中工作区
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/rooms/${roomId}`);

  const workspace = page.locator(".room-workspace");
  await expect(workspace).toBeVisible();

  const desktopLayout = await workspace.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return {
      display: style.display,
      paddingLeft: style.paddingLeft,
      flexDirection: style.flexDirection,
    };
  });
  expect(desktopLayout.display).toBe("flex");
  expect(desktopLayout.paddingLeft).not.toBe("242px");
  expect(desktopLayout.flexDirection).toBe("row");

  const sidebar = page.locator(".room-context");
  const sidebarStyles = await sidebar.evaluate((el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      position: style.position,
      width: rect.width,
    };
  });
  expect(sidebarStyles.position).toBe("sticky");
  expect(sidebarStyles.width).toBeGreaterThanOrEqual(220);
  expect(sidebarStyles.width).toBeLessThanOrEqual(245);

  // 紧凑展示房间名、角色/昵称胶囊以及垂直导航项
  await expect(sidebar.getByRole("heading", { name: room.name, exact: true })).toBeVisible();
  const identityMeta = sidebar.locator(".room-identity-meta");
  await expect(identityMeta).toBeVisible();
  await expect(identityMeta.getByText("当前角色：房主", { exact: true })).toBeVisible();
  await expect(identityMeta.getByText("当前昵称：小林", { exact: true })).toBeVisible();

  const nav = sidebar.locator(".room-navigation");
  await expect(nav).toBeVisible();
  const navDisplay = await nav.evaluate((el) => window.getComputedStyle(el).flexDirection);
  expect(navDisplay).toBe("column");

  // 右侧主工作区内部容器限定最大宽度并自动外边距居中
  const content = page.locator(".room-page-content");
  await expect(content).toBeVisible();
  const contentMetrics = await content.evaluate((el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const parentRect = el.parentElement!.getBoundingClientRect();
    const remainingRightAreaStart = parentRect.left + 230 + 40; // sidebar + gap
    const remainingRightAreaEnd = parentRect.right;
    const remainingRightAreaCenter = (remainingRightAreaStart + remainingRightAreaEnd) / 2;
    const contentCenter = (rect.left + rect.right) / 2;
    return {
      maxWidth: style.maxWidth,
      minWidth: style.minWidth,
      renderedWidth: rect.width,
      contentCenter,
      remainingRightAreaCenter,
    };
  });
  expect(contentMetrics.maxWidth).toBe("860px");
  expect(contentMetrics.minWidth).toBe("0px");
  expect(contentMetrics.renderedWidth).toBeCloseTo(860, 1);
  expect(Math.abs(contentMetrics.contentCenter - contentMetrics.remainingRightAreaCenter)).toBeLessThan(15);

  // 视口无横向溢出
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // 2. 移动端 320px 窄屏：折叠为单列、紧凑顶部房间条、第一视口直达内容、底部固定导航
  await page.setViewportSize({ width: 320, height: 800 });

  const mobileLayout = await workspace.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return {
      flexDirection: style.flexDirection,
    };
  });
  expect(mobileLayout.flexDirection).toBe("column");

  const mobileSidebarPos = await sidebar.evaluate((el) => window.getComputedStyle(el).position);
  expect(mobileSidebarPos).toBe("static");

  // 顶部紧凑信息不遮挡第一视口：主标题位于顶部附近
  const contentHeading = page.getByRole("heading", { name: "公共歌单", exact: true });
  await expect(contentHeading).toBeVisible();
  const headingBox = await contentHeading.boundingBox();
  expect(headingBox).not.toBeNull();
  expect(headingBox!.y).toBeLessThan(250);

  // 底部固定导航栏
  const mobileNavStyles = await nav.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return {
      position: style.position,
      bottom: style.bottom,
    };
  });
  expect(mobileNavStyles.position).toBe("fixed");
  expect(mobileNavStyles.bottom).toBe("0px");

  // 3. 移动端输入聚焦与软键盘展开时不破坏工作台布局与视口滚动
  await page.getByRole("region", { name: "公共歌单", exact: true }).evaluate((el) => {
    const testInput = document.createElement("input");
    testInput.setAttribute("aria-label", "工作台软键盘适配测试输入");
    el.prepend(testInput);
  });
  const mobileInput = page.getByRole("textbox", { name: "工作台软键盘适配测试输入" });
  await mobileInput.focus();

  // 模拟手机软键盘弹出：visualViewport 与 innerHeight 缩减至 420px
  await page.evaluate(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 420 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(nav).toBeHidden();

  // 验证输入元素仍在可视视口范围内且无水平溢出
  await mobileInput.scrollIntoViewIfNeeded();
  const inputRect = await mobileInput.evaluate((el) => el.getBoundingClientRect());
  expect(inputRect.top).toBeGreaterThanOrEqual(0);
  expect(inputRect.bottom).toBeLessThanOrEqual(420);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // 软键盘收起：恢复视口高度与失焦
  await mobileInput.evaluate((el) => el.blur());
  await page.evaluate(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 800 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(nav).toBeVisible();

  // 移动端视口无横向溢出
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

