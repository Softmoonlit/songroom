import { expect, test, type Page } from "@playwright/test";

const code = "Abcde_1234";
const roomId = "0195cf0d-6a80-7000-8000-000000000021";
const applicationId = "0195cf0d-6a80-7000-8000-000000000022";
const room = { id: roomId, name: "邀请音乐间" };
const application = { id: applicationId, room, nickname: "é", status: "pending", disabledReasons: {} };

async function mockSession(page: Page) {
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: {
    session: { id: "invite-session", expiresAt: "2099-01-01T00:00:00Z" },
    user: { id: "invite-user", name: "申请人", email: "invite@example.com", emailVerified: false }
  } }));
  await page.route("**/api/rooms", route => route.fulfill({ json: { rooms: [] } }));
  await page.route("**/api/join-applications", route => route.fulfill({ json: { applications: [] } }));
}

for (const mode of ["登录", "注册"] as const) {
  test(`fragment 邀请在${mode}前不上送，认证后回跳且焦点进入申请`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    let authenticated = false;
    const requests: { url: string; body: string | null; referer: string | undefined }[] = [];
    page.on("request", request => requests.push({ url: request.url(), body: request.postData(), referer: request.headers().referer }));
    await page.route("**/api/auth/get-session", route => route.fulfill({ json: authenticated ? {
      session: { id: "invite-session", expiresAt: "2099-01-01T00:00:00Z" },
      user: { id: "invite-user", name: "申请人", email: "invite@example.com", emailVerified: false }
    } : null }));
    await page.route("**/api/auth/sign-*/email", route => {
      authenticated = true;
      return route.fulfill({ json: { user: { id: "invite-user" } } });
    });
    await page.route("**/api/invites/inspect", route => {
      expect(authenticated).toBe(true);
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ code });
      return route.fulfill({ json: { room, application: null, isMember: false } });
    });
    await page.goto(`/join#${code}`);
    await expect(page).toHaveURL(/\/login$/);
    expect(requests.some(request => request.body?.includes(code))).toBe(false);
    if (mode === "注册") {
      await page.getByRole("link", { name: "注册账号", exact: true }).click();
      await page.getByLabel("账号称呼").fill("新申请人");
    }
    await page.getByLabel("邮箱").fill("invite@example.com");
    await page.getByLabel("密码").fill("correct horse battery staple");
    await page.getByRole("button", { name: mode === "注册" ? "注册并继续申请" : "登录并继续申请", exact: true }).click();
    await expect(page).toHaveURL(/\/join$/);
    await expect(page.getByRole("heading", { name: "申请加入邀请音乐间" })).toBeVisible();
    await expect(page.getByLabel("拟用房间昵称")).toBeFocused();
    expect(requests.every(request => !request.url.includes(code) && !request.referer?.includes(code))).toBe(true);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, history.state]))).not.toContain(code);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("手工邀请码校验、昵称规范化、申请独立待处理页与列表撤回", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockSession(page);
  let pending = false;
  let withdrawn = false;
  let inspections = 0;
  let submissions = 0;
  const pendingApplication = { ...application, allowedActions: ["withdrawApplication"] };
  await page.route("**/api/invites/inspect", route => {
    inspections += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ code });
    return route.fulfill({ json: { room, application: null, isMember: false } });
  });
  await page.route("**/api/join-applications", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { applications: pending ? [pendingApplication] : [] } });
    submissions += 1;
    expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), code, nickname: "é" });
    pending = true;
    return route.fulfill({ json: pendingApplication });
  });
  await page.route(`**/api/join-applications/${applicationId}`, route => route.fulfill({ json: withdrawn
    ? { ...pendingApplication, status: "withdrawn", allowedActions: [] } : pendingApplication }));
  await page.route(`**/api/join-applications/${applicationId}/withdraw`, route => {
    expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    pending = false;
    withdrawn = true;
    return route.fulfill({ json: { ...pendingApplication, status: "withdrawn", allowedActions: [] } });
  });
  await page.goto("/join");
  await expect(page.getByLabel("邀请码", { exact: true })).toBeFocused();
  await page.getByLabel("邀请码", { exact: true }).fill("bad");
  await page.getByRole("button", { name: "查看邀请" }).click();
  await expect(page.getByRole("alert")).toContainText("10");
  expect(inspections).toBe(0);
  await page.getByLabel("邀请码", { exact: true }).fill(code);
  await page.getByRole("button", { name: "查看邀请" }).click();
  await expect(page.getByLabel("拟用房间昵称")).toBeFocused();
  await page.getByLabel("拟用房间昵称").fill("abcdefghijklmn");
  await page.getByRole("button", { name: "提交加入申请" }).click();
  await expect(page.getByRole("alert")).toContainText("12");
  expect(submissions).toBe(0);
  await page.getByLabel("拟用房间昵称").fill(" e\u0301 ");
  await page.getByRole("button", { name: "提交加入申请" }).click();
  await expect(page).toHaveURL(new RegExp(`/application/${applicationId}$`));
  await expect(page.getByRole("status")).toContainText("等待房主审批");
  await expect(page.getByText("拟用昵称：é", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "房间导航" })).toHaveCount(0);
  await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "待处理加入申请" })).toBeVisible();
  await page.getByRole("link", { name: "查看申请：邀请音乐间" }).click();
  await page.getByRole("button", { name: "撤回申请", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已撤回");
  await expect(page.getByRole("button", { name: "撤回申请", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
  await expect(page.getByRole("link", { name: "查看申请：邀请音乐间" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

async function ownerRoom(page: Page, allowedActions = ["copyInvite", "resetInvite"]) {
  await mockSession(page);
  await page.route(`**/api/rooms/${roomId}`, route => route.fulfill({ json: { room: { ...room, role: "owner", nickname: "房主" }, version: 1, pendingCount: 2, allowedActions: ["renameRoom", "renameNickname", "reviewApplications", "readInvite"], disabledReasons: {} } }));
  await page.route(`**/api/rooms/${roomId}/members`, route => route.fulfill({ json: { members: [], allowedActions: ["renameNickname", "reviewApplications", "readInvite"], disabledReasons: {} } }));
  await page.route(`**/api/rooms/${roomId}/invite`, route => route.fulfill({ json: { code, generation: 1, version: 1, pendingCount: 2, allowedActions, disabledReasons: {} } }));
}

for (const copySucceeds of [true, false]) {
  test(`房主成员页复制邀请链接${copySucceeds ? "成功" : "失败"}有可访问反馈，不展示完整链接`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await ownerRoom(page);
    let copied = "";
    await page.exposeFunction("copyInvitation", (text: string) => { copied = text; });
    await page.addInitScript(success => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => {
        if (!success) throw new Error("raw clipboard failure");
        await (window as unknown as { copyInvitation: (value: string) => Promise<void> }).copyInvitation(text);
      } } });
    }, copySucceeds);
    const inviteReads: string[] = [];
    page.on("request", request => { if (request.url().endsWith("/invite")) inviteReads.push(request.url()); });
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByRole("heading", { name: "公共歌单", exact: true })).toBeVisible();
    expect(inviteReads).toHaveLength(0);
    await page.getByRole("button", { name: "房间设置", exact: true }).click();
    await expect(page.getByRole("button", { name: "复制邀请链接" })).toHaveCount(0);
    expect(inviteReads).toHaveLength(0);
    await page.getByRole("button", { name: "房间成员", exact: true }).click();
    await expect(page.getByText(code, { exact: true })).toBeVisible();
    const copy = page.getByRole("button", { name: "复制邀请链接" });
    await copy.focus();
    await page.keyboard.press("Enter");
    if (copySucceeds) {
      await expect(page.getByRole("status")).toContainText("邀请链接已复制");
      expect(copied).toBe(`http://127.0.0.1:3210/join#${code}`);
    } else {
      await expect(page.getByRole("alert")).toContainText("复制失败");
      expect(copied).toBe("");
    }
    await expect(page.getByText(`http://127.0.0.1:3210/join#${code}`, { exact: true })).toHaveCount(0);
    await expect(page.getByText("raw clipboard failure", { exact: true })).toHaveCount(0);
    await expect(copy).toBeFocused();
    if (copySucceeds) await page.screenshot({ path: test.info().outputPath("owner-invite-320.png"), fullPage: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("320px 重置邀请对话框覆盖导航并捕获键盘，版本冲突留框展示新影响并重新确认", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await ownerRoom(page);
  let latest = { code, generation: 1, version: 1, pendingCount: 2, allowedActions: ["copyInvite", "resetInvite"], disabledReasons: {} };
  const commands: { version: number; idempotencyKey: string }[] = [];
  await page.route(`**/api/rooms/${roomId}/invite`, route => route.fulfill({ json: latest }));
  await page.route(`**/api/rooms/${roomId}/invite/reset`, route => {
    const command = route.request().postDataJSON() as { version: number; idempotencyKey: string };
    commands.push(command);
    if (commands.length === 1) {
      expect(command.version).toBe(1);
      latest = { ...latest, version: 2, pendingCount: 3 };
      return route.fulfill({ status: 409, json: { error: { code: "INVITE_VERSION_CONFLICT" } } });
    }
    expect(command.version).toBe(2);
    expect(command.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    latest = { ...latest, code: "NewCode_12", generation: 2, version: 3, pendingCount: 0 };
    return route.fulfill({ json: latest });
  });
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  const reset = page.getByRole("button", { name: "重置邀请", exact: true });
  await reset.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("2 份待处理申请");
  await expect(dialog.getByRole("button", { name: "保留当前邀请" })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("reset-dialog-320.png") });
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  // The overlay must be the top element even above the fixed mobile navigation.
  expect(await page.getByRole("button", { name: "公共歌单", exact: true, includeHidden: true }).evaluate(element => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.classList.contains("invite-dialog-overlay");
  })).toBe(true);
  await dialog.getByRole("button", { name: "确认重置邀请" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("3 份待处理申请");
  await expect(dialog.getByRole("alert")).toContainText("重新确认");
  expect(commands).toHaveLength(1);
  await dialog.getByRole("button", { name: "确认重置邀请" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("NewCode_12", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("邀请已重置");
  await expect(reset).toBeFocused();
  await reset.press("Enter");
  await expect(dialog).toContainText("0 份待处理申请");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reset).toBeFocused();
  expect(commands).toHaveLength(2);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("完整应用：房主建房邀请，注册与登录回跳申请、撤回、重置取消且不授房间权限", async ({ page, browser }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const suffix = `${Date.now()}-${test.info().workerIndex}`;
  const guestEmail = `invite-guest-${suffix}@example.com`;
  const password = "correct horse battery staple";
  await page.goto("/register");
  await page.getByLabel("账号称呼").fill("邀请房主");
  await page.getByLabel("邮箱").fill(`invite-owner-${suffix}@example.com`);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "注册并进入房间列表" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await page.getByRole("button", { name: "开始扫码绑定" }).click();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await page.getByRole("button", { name: "确认绑定此网易云账号" }).click();
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "我的房间", exact: true }).click();
  await page.getByRole("link", { name: "创建房间", exact: true }).click();
  await page.getByLabel("房间名称").fill("完整邀请房间");
  await page.getByLabel("我的房间昵称").fill("房主");
  await page.getByRole("checkbox", { name: "确认使用此网易云账号创建房间" }).check();
  await page.getByRole("button", { name: "创建并进入房间" }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
  const createdRoomUrl = page.url();
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  const invitation = page.getByRole("region", { name: "房间邀请" });
  const actualCode = (await invitation.locator("dd").textContent())!;
  expect(actualCode).toMatch(/^[A-Za-z0-9_-]{10}$/);

  const guestContext = await browser.newContext({ viewport: { width: 320, height: 800 } });
  try {
    const guest = await guestContext.newPage();
    const guestRequests: { url: string; body: string | null; referer: string | undefined }[] = [];
    guest.on("request", request => guestRequests.push({ url: request.url(), body: request.postData(), referer: request.headers().referer }));
    await guest.goto(`/join#${actualCode}`);
    await expect(guest).toHaveURL(/\/login$/);
    expect(guestRequests.some(request => request.body?.includes(actualCode))).toBe(false);
    await guest.getByRole("link", { name: "注册账号", exact: true }).click();
    await guest.getByLabel("账号称呼").fill("受邀账号");
    await guest.getByLabel("邮箱").fill(guestEmail);
    await guest.getByLabel("密码").fill(password);
    await guest.getByRole("button", { name: "注册并继续申请" }).click();
    await expect(guest).toHaveURL(/\/join$/);
    await expect(guest.getByLabel("拟用房间昵称")).toBeFocused();
    await guest.screenshot({ path: test.info().outputPath("join-form-320.png"), fullPage: true });
    await guest.getByLabel("拟用房间昵称").fill(" e\u0301 ");
    await guest.getByRole("button", { name: "提交加入申请" }).click();
    await expect(guest).toHaveURL(/\/application\/[0-9a-f-]{36}$/);
    await expect(guest.getByText("拟用昵称：é", { exact: true })).toBeVisible();
    await expect(guest.getByRole("status")).toHaveText("等待房主审批");
    await guest.getByRole("link", { name: "返回房间列表", exact: true }).click();
    await expect(guest.getByRole("link", { name: "查看申请：完整邀请房间" })).toBeVisible();
    await expect(guest.getByRole("link", { name: "进入房间：完整邀请房间" })).toHaveCount(0);
    await guest.goto(createdRoomUrl);
    await expect(guest.getByRole("alert")).toHaveText("房间不可访问，请返回房间列表。");
    await expect(guest.getByRole("navigation", { name: "房间导航" })).toHaveCount(0);
    await guest.getByRole("link", { name: "返回房间列表", exact: true }).click();
    await guest.getByRole("link", { name: "查看申请：完整邀请房间" }).click();
    await guest.getByRole("button", { name: "撤回申请", exact: true }).click();
    await expect(guest.getByRole("status")).toHaveText("申请已撤回");
    await guest.getByRole("link", { name: "账号设置", exact: true }).click();
    await guest.getByRole("button", { name: "退出当前设备" }).click();
    await expect(guest).toHaveURL(/\/$/);
    await guest.goto(`/join#${actualCode}`);
    await expect(guest).toHaveURL(/\/login$/);
    await guest.getByLabel("邮箱").fill(guestEmail);
    await guest.getByLabel("密码").fill(password);
    await guest.getByRole("button", { name: "登录并继续申请" }).click();
    await expect(guest.getByLabel("拟用房间昵称")).toBeFocused();
    await guest.getByLabel("拟用房间昵称").fill("再次申请");
    await guest.getByRole("button", { name: "提交加入申请" }).click();
    await expect(guest.getByRole("status")).toHaveText("等待房主审批");
    const secondApplicationUrl = guest.url();
    await page.getByRole("button", { name: "重置邀请", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("1 份待处理申请");
    await dialog.getByRole("button", { name: "确认重置邀请" }).click();
    await expect(dialog).toHaveCount(0);
    await guest.reload();
    await expect(guest.getByRole("status")).toHaveText("邀请已重置，申请已取消");
    await expect(guest.getByRole("button", { name: "撤回申请", exact: true })).toHaveCount(0);
    await guest.goto(`/join#${actualCode}`);
    await expect(guest.getByRole("alert")).toContainText("邀请已重置");
    await guest.goto(secondApplicationUrl);
    await guest.getByRole("link", { name: "返回房间列表", exact: true }).click();
    await expect(guest.getByRole("link", { name: "查看申请：完整邀请房间" })).toHaveCount(0);
    expect(guestRequests.every(request => !request.url.includes(actualCode) && !request.referer?.includes(actualCode))).toBe(true);
    expect(await guest.evaluate(() => JSON.stringify([localStorage, sessionStorage, history.state]))).not.toContain(actualCode);
    await expect.poll(() => guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "房间成员", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "查看成员：房主" })).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test("格式错误的邀请 fragment 明确提示且不上送，可以用键盘修正邀请码", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockSession(page);
  let inspections = 0;
  await page.route("**/api/invites/inspect", route => {
    inspections += 1;
    expect(route.request().postDataJSON()).toEqual({ code });
    return route.fulfill({ json: { room, application: null, isMember: false } });
  });
  await page.goto("/join#bad");
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.getByRole("alert")).toContainText("10");
  expect(inspections).toBe(0);
  const codeInput = page.getByLabel("邀请码", { exact: true });
  await expect(codeInput).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("拟用房间昵称")).toBeFocused();
});

for (const [errorCode, message] of [
  ["INVITE_INVALID", "邀请码无效"],
  ["INVITE_RESET", "邀请已重置"],
  ["ACCOUNT_APPLICATION_LIMIT", "3 份待处理申请"],
  ["ROOM_APPLICATION_LIMIT", "10 份待处理申请"],
  ["APPLICATION_PENDING", "你已有这个房间的待处理申请"],
  ["ALREADY_MEMBER", "已经是这个房间的成员"]
]) {
  test(`申请服务拒绝 ${errorCode} 时显示明确反馈并隐藏原始消息`, async ({ page }) => {
    await mockSession(page);
    await page.route("**/api/invites/inspect", route => route.fulfill({ json: { room, application: null, isMember: false } }));
    await page.route("**/api/join-applications", route => route.fulfill({ status: 409, json: { error: { code: errorCode, message: "raw secret response" } } }));
    await page.goto(`/join#${code}`);
    await page.getByLabel("拟用房间昵称").fill("申请人");
    await page.getByRole("button", { name: "提交加入申请" }).click();
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByText("raw secret response")).toHaveCount(0);
    await expect(page).toHaveURL(/\/join$/);
  });
}

for (const existingMember of [true, false]) {
  test(`检查邀请显示${existingMember ? "已经是成员" : "已有待处理申请"}，不出现重复申请表`, async ({ page }) => {
    await mockSession(page);
    await page.route("**/api/invites/inspect", route => route.fulfill({ json: { room, isMember: existingMember, application: existingMember ? null : { ...application, allowedActions: ["withdrawApplication"] } } }));
    await page.goto(`/join#${code}`);
    await expect(page.getByRole("status")).toContainText(existingMember ? "已经是这个房间的成员" : "已有这个房间的待处理申请");
    await expect(page.getByRole("button", { name: "提交加入申请" })).toHaveCount(0);
    if (!existingMember) await expect(page.getByRole("link", { name: "查看原申请" })).toHaveAttribute("href", `/application/${applicationId}`);
  });
}

test("服务端 allowedActions 决定邀请和撤回按钮，普通成员不读取邀请", async ({ page }) => {
  await ownerRoom(page, []);
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await expect(page.getByText(code, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制邀请链接" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重置邀请", exact: true })).toHaveCount(0);
  await page.route(`**/api/join-applications/${applicationId}`, route => route.fulfill({ json: { ...application, allowedActions: [] } }));
  await page.goto(`/application/${applicationId}`);
  await expect(page.getByRole("status")).toHaveText("等待房主审批");
  await expect(page.getByRole("button", { name: "撤回申请", exact: true })).toHaveCount(0);
  await page.route(`**/api/rooms/${roomId}`, route => route.fulfill({ json: { room: { ...room, role: "roommate", nickname: "室友" }, version: 1, pendingCount: null, allowedActions: ["renameNickname"], disabledReasons: {} } }));
  await page.route(`**/api/rooms/${roomId}/members`, route => route.fulfill({ json: { members: [], allowedActions: ["renameNickname"], disabledReasons: {} } }));
  let inviteRead = false;
  await page.route(`**/api/rooms/${roomId}/invite`, route => { inviteRead = true; return route.fulfill({ status: 404, json: { error: { code: "INVITE_FORBIDDEN" } } }); });
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "房间成员", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "房间邀请" })).toHaveCount(0);
  expect(inviteRead).toBe(false);
});

for (const errorCode of ["APPLICATION_UNAVAILABLE", "SESSION_REQUIRED"]) {
  test(`申请页面 ${errorCode} 不展示缓存申请与房间内容`, async ({ page }) => {
    await mockSession(page);
    await page.route(`**/api/join-applications/${applicationId}`, route => route.fulfill({ status: errorCode === "SESSION_REQUIRED" ? 401 : 404, json: { error: { code: errorCode } } }));
    await page.goto(`/application/${applicationId}`);
    await expect(page.getByRole("alert")).toContainText(errorCode === "SESSION_REQUIRED" ? "会话已失效" : "申请不可查看");
    await expect(page.getByRole("button", { name: "撤回申请", exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "房间导航" })).toHaveCount(0);
    if (errorCode === "SESSION_REQUIRED") await expect(page.getByRole("link", { name: "重新登录", exact: true })).toBeVisible();
  });
}

test("申请响应丢失后重试复用命令，昵称含控制字符不能提交", async ({ page }) => {
  await mockSession(page);
  await page.route("**/api/invites/inspect", route => route.fulfill({ json: { room, application: null, isMember: false } }));
  const submitted: unknown[] = [];
  await page.route("**/api/join-applications", route => {
    submitted.push(route.request().postDataJSON());
    return submitted.length === 1 ? route.abort("failed") : route.fulfill({ json: { ...application, allowedActions: ["withdrawApplication"] } });
  });
  await page.route(`**/api/join-applications/${applicationId}`, route => route.fulfill({ json: { ...application, allowedActions: ["withdrawApplication"] } }));
  await page.goto(`/join#${code}`);
  await page.getByLabel("拟用房间昵称").fill("含\u0001控制");
  await page.getByRole("button", { name: "提交加入申请" }).click();
  await expect(page.getByRole("alert")).toContainText("控制字符");
  expect(submitted).toHaveLength(0);
  await page.getByLabel("拟用房间昵称").fill("é");
  await page.getByRole("button", { name: "提交加入申请" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法");
  await page.getByRole("button", { name: "提交加入申请" }).click();
  await expect(page.getByRole("status")).toHaveText("等待房主审批");
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
});
