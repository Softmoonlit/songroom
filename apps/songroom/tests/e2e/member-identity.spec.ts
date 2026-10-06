import { expect, test, type Page } from "@playwright/test";

const roomId = "0195cf0d-6a80-7000-8000-000000000031";
const memberId = "0195cf0d-6a80-7000-8000-000000000032";
const applicationId = "0195cf0d-6a80-7000-8000-000000000033";
const ownerActions = ["renameRoom", "renameNickname", "reviewApplications", "readInvite"];
async function workspace(page: Page, role = "owner", count: number | null = 10) {
  const state = { room: { id: roomId, name: "审批音乐间", nickname: "小林", role }, pendingCount: count, version: 1,
    allowedActions: role === "owner" ? ownerActions : ["renameNickname"], disabledReasons: {} };
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: {
    session: { id: "identity-session", expiresAt: "2099-01-01T00:00:00Z" },
    user: { id: "identity-user", name: "账号称呼", email: "private@example.com", emailVerified: false }
  } }));
  await page.route("**/api/rooms", route => route.fulfill({ json: { rooms: [state.room] } }));
  await page.route(`**/api/rooms/${roomId}`, route => route.fulfill({ json: state }));
  await page.route(`**/api/rooms/${roomId}/members`, route => route.fulfill({ json: {
    members: [{ id: memberId, nickname: state.room.nickname, role, isSelf: true, allowedActions: ["renameNickname"], disabledReasons: {} }],
    allowedActions: state.allowedActions.filter(action => action !== "renameRoom"), disabledReasons: {}
  } }));
  await page.route(`**/api/rooms/${roomId}/invite`, route => route.fulfill({ json: {
    code: "Abcde_1234", generation: 1, version: 1, pendingCount: count ?? 0,
    allowedActions: ["copyInvite", "resetInvite"], disabledReasons: {}
  } }));
  await page.route(`**/api/rooms/${roomId}/applications`, route => route.fulfill({ json: {
    applications: [], allowedActions: ["reviewApplications"], disabledReasons: {}
  } }));
  return state;
}

test("房间壳显示当前昵称和9+待审批角标，室友没有审批或邀请", async ({ page }) => {
  await workspace(page);
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByText("当前昵称：小林", { exact: true })).toBeVisible();
  await expect(page.getByLabel("待审批申请：10份")).toHaveText("9+");
  await workspace(page, "roommate", null);
  await page.reload();
  await expect(page.getByText("当前角色：室友", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/待审批申请/)).toHaveCount(0);
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await expect(page.getByRole("button", { name: "审批加入申请" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "房间邀请" })).toHaveCount(0);
});

for (const [decision, status, result] of [
  ["approve", "approved", "已批准：新室友"],
  ["reject", "rejected", "已拒绝：新室友"],
  ["approve", "nickname_conflict", "昵称已被占用：新室友；申请已终结，请申请人重新提交。"]
] as const) {
  test(`房主审批 ${status} 显示明确结果并刷新角标`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const state = await workspace(page, "owner", 1);
    let pending = true;
    await page.route(`**/api/rooms/${roomId}/applications`, route => route.fulfill({ json: {
      applications: pending ? [{ id: applicationId, nickname: "新室友", allowedActions: ["approveApplication", "rejectApplication"], disabledReasons: {} }] : [],
      allowedActions: ["reviewApplications"], disabledReasons: {}
    } }));
    await page.route(`**/api/rooms/${roomId}/applications/${applicationId}/decision`, route => {
      expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), decision });
      pending = false;
      state.pendingCount = 0;
      return route.fulfill({ json: { id: applicationId, room: { id: roomId, name: state.room.name }, nickname: "新室友", status, allowedActions: [], disabledReasons: {} } });
    });
    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: /房间成员/ }).click();
    await page.getByRole("button", { name: "审批加入申请", exact: true }).click();
    await expect(page.getByRole("region", { name: "加入申请审批" })).not.toContainText("private@example.com");
    await page.getByRole("button", { name: `${decision === "approve" ? "批准" : "拒绝"}：新室友`, exact: true }).click();
    await expect(page.getByRole("status")).toContainText(result);
    await expect(page.getByLabel(/待审批申请/)).toHaveCount(0);
    await expect(page.getByText("暂无待处理申请", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("设置修改房名和本人昵称，输入规范化后壳及成员同步更新", async ({ page }) => {
  const state = await workspace(page, "owner", 0);
  for (const [path, field, value] of [["name", "name", "新音乐间"], ["nickname", "nickname", "é"]] as const) {
    await page.route(`**/api/rooms/${roomId}/${path}`, route => {
      expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), [field]: value });
      state.room[field] = value;
      return route.fulfill({ json: state });
    });
  }
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间设置", exact: true }).click();
  await page.getByLabel("房间名称", { exact: true }).fill(" 新音乐间 ");
  await page.getByRole("button", { name: "保存房间名称", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新音乐间", exact: true })).toBeVisible();
  await page.getByLabel("我的房间昵称", { exact: true }).fill(" e\u0301 ");
  await page.getByRole("button", { name: "保存我的昵称", exact: true }).click();
  await expect(page.getByText("当前昵称：é", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await page.getByRole("button", { name: "查看成员：é", exact: true }).click();
  await expect(page.getByRole("region", { name: "成员详情" })).toContainText("é");
});

for (const [status, text] of [["approved", "申请已获批"], ["rejected", "房主已拒绝申请"], ["nickname_conflict", "拟用昵称已被占用，申请已终结，请重新提交"]] as const) {
  test(`申请人看到 ${status} 明确状态，获批才显示进入房间`, async ({ page }) => {
    await workspace(page, "roommate", null);
    await page.route(`**/api/join-applications/${applicationId}`, route => route.fulfill({ json: {
      id: applicationId, room: { id: roomId, name: "审批音乐间" }, nickname: "小林", status, allowedActions: [], disabledReasons: {}
    } }));
    await page.goto(`/application/${applicationId}`);
    await expect(page.getByRole("status")).toHaveText(text);
    if (status === "approved") {
      await expect(page.getByRole("link", { name: "进入获批房间", exact: true })).toHaveAttribute("href", `/rooms/${roomId}`);
      await expect(page.getByRole("link", { name: "使用当前邀请码重新申请" })).toHaveCount(0);
    } else {
      await expect(page.getByRole("link", { name: "进入获批房间" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "使用当前邀请码重新申请" })).toBeVisible();
    }
  });
}

for (const count of [0, 1, 9]) {
  test(`房主待审批角标${count}份按约显示`, async ({ page }) => {
    await workspace(page, "owner", count);
    await page.goto(`/rooms/${roomId}`);
    if (count === 0) await expect(page.getByLabel(/待审批申请/)).toHaveCount(0);
    else await expect(page.getByLabel(`待审批申请：${count}份`)).toHaveText(String(count));
  });
}

test("审批容量不足仅提供拒绝并展示中文禁用原因", async ({ page }) => {
  await workspace(page, "owner", 1);
  await page.route(`**/api/rooms/${roomId}/applications`, route => route.fulfill({ json: {
    applications: [{ id: applicationId, nickname: "新室友", allowedActions: ["rejectApplication"], disabledReasons: { approveApplication: "ROOM_MEMBER_LIMIT" } }],
    allowedActions: ["reviewApplications"], disabledReasons: {}
  } }));
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await page.getByRole("button", { name: "审批加入申请", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准：新室友" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "拒绝：新室友" })).toBeVisible();
  await expect(page.getByText("这个房间已有 10 名成员，暂时不能批准加入。", { exact: true })).toBeVisible();
});

test("室友只改本人昵称，竞态冲突保留输入并显示服务端中文反馈", async ({ page }) => {
  await workspace(page, "roommate", null);
  await page.route(`**/api/rooms/${roomId}/nickname`, route => route.fulfill({ status: 409, json: { error: { code: "NICKNAME_TAKEN", message: "raw secret" } } }));
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存房间名称" })).toHaveCount(0);
  await page.getByLabel("我的房间昵称", { exact: true }).fill("新室友");
  await page.getByRole("button", { name: "保存我的昵称", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("这个房间昵称已被使用，请换一个昵称。");
  await expect(page.getByLabel("我的房间昵称", { exact: true })).toHaveValue("新室友");
  await expect(page.getByText("当前昵称：小林", { exact: true })).toBeVisible();
  await expect(page.getByText("raw secret")).toHaveCount(0);
});

test("邀请重置后刷新待审批角标和打开的审批列表", async ({ page }) => {
  const state = await workspace(page, "owner", 2);
  let reset = false;
  await page.route(`**/api/rooms/${roomId}/applications`, route => route.fulfill({ json: {
    applications: reset ? [] : [{ id: applicationId, nickname: "新室友", allowedActions: ["approveApplication", "rejectApplication"], disabledReasons: {} }],
    allowedActions: ["reviewApplications"], disabledReasons: {}
  } }));
  await page.route(`**/api/rooms/${roomId}/invite/reset`, route => {
    reset = true;
    state.pendingCount = 0;
    return route.fulfill({ json: { code: "NewCode_12", generation: 2, version: 2, pendingCount: 0, allowedActions: ["copyInvite", "resetInvite"], disabledReasons: {} } });
  });
  await page.route(`**/api/rooms/${roomId}/invite`, route => route.fulfill({ json: { code: reset ? "NewCode_12" : "Abcde_1234", generation: reset ? 2 : 1, version: reset ? 2 : 1, pendingCount: reset ? 0 : 2, allowedActions: ["copyInvite", "resetInvite"], disabledReasons: {} } }));
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  await page.getByRole("button", { name: "审批加入申请", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准：新室友" })).toBeVisible();
  await page.getByRole("button", { name: "重置邀请", exact: true }).click();
  await page.getByRole("button", { name: "确认重置邀请", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByLabel(/待审批申请/)).toHaveCount(0);
  await expect(page.getByText("暂无待处理申请", { exact: true })).toBeVisible();
});

test("完整应用：房主审批后室友无需网易云绑定进入房间并修改本人昵称", async ({ page, browser }) => {
  const suffix = `${Date.now()}-${test.info().workerIndex}`;
  async function register(target: Page, label: string) {
    await target.goto("/register");
    await target.getByLabel("账号称呼").fill(label);
    await target.getByLabel("邮箱").fill(`approval-${label === "房主账号" ? "owner" : "guest"}-${suffix}@example.com`);
    await target.getByLabel("密码").fill("correct horse battery staple");
    await target.getByRole("button", { name: "注册并进入房间列表" }).click();
    await expect(target).toHaveURL(/\/rooms$/);
  }
  await register(page, "房主账号");
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await page.getByRole("button", { name: "开始扫码绑定" }).click();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await page.getByRole("button", { name: "确认绑定此网易云账号" }).click();
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "我的房间", exact: true }).click();
  await page.getByRole("link", { name: "创建房间", exact: true }).click();
  await page.getByLabel("房间名称").fill("真实审批音乐间");
  await page.getByLabel("我的房间昵称").fill("房主昵称");
  await page.getByRole("checkbox", { name: "确认使用此网易云账号创建房间" }).check();
  await page.getByRole("button", { name: "创建并进入房间" }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
  const actualRoomUrl = page.url();
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  const code = (await page.getByRole("region", { name: "房间邀请" }).locator("dd").textContent())!;
  const guestContext = await browser.newContext({ viewport: { width: 320, height: 800 } });
  try {
    const guest = await guestContext.newPage();
    await register(guest, "室友账号");
    await guest.goto(`/join#${code}`);
    await guest.getByLabel("拟用房间昵称").fill("室友昵称");
    await guest.getByRole("button", { name: "提交加入申请" }).click();
    await expect(guest.getByRole("status")).toHaveText("等待房主审批");
    await page.reload();
    await expect(page.getByLabel("待审批申请：1份")).toHaveText("1");
    await page.getByRole("button", { name: "房间成员", exact: true }).click();
    await page.getByRole("button", { name: "审批加入申请", exact: true }).click();
    await page.getByRole("button", { name: "批准：室友昵称", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已批准：室友昵称");
    await expect(page.getByRole("button", { name: "查看成员：室友昵称", exact: true })).toBeVisible();
    await guest.reload();
    await expect(guest.getByRole("status")).toHaveText("申请已获批");
    await guest.getByRole("link", { name: "返回房间列表", exact: true }).click();
    await guest.getByRole("link", { name: "进入房间：真实审批音乐间", exact: true }).click();
    await expect(guest).toHaveURL(actualRoomUrl);
    await expect(guest.getByText("当前昵称：室友昵称", { exact: true })).toBeVisible();
    await expect(guest.getByRole("heading", { name: "尚未创建公共歌单" })).toBeVisible();
    const binding = await guest.request.get("/api/netease/binding");
    expect((await binding.json()).binding).toBeNull();
    await guest.getByRole("button", { name: "房间成员", exact: true }).click();
    await expect(guest.getByRole("region", { name: "房间邀请" })).toHaveCount(0);
    await expect(guest.getByRole("button", { name: "审批加入申请" })).toHaveCount(0);
    await guest.getByRole("button", { name: "查看成员：房主昵称", exact: true }).click();
    await expect(guest.getByRole("button", { name: "保存我的昵称" })).toHaveCount(0);
    await guest.getByRole("button", { name: "返回成员列表", exact: true }).click();
    await guest.getByRole("button", { name: "查看成员：室友昵称", exact: true }).click();
    await guest.getByRole("region", { name: "成员详情", exact: true }).getByLabel("我的房间昵称", { exact: true }).fill("新昵称");
    await guest.getByRole("button", { name: "保存我的昵称", exact: true }).click();
    await expect(guest.getByText("当前昵称：新昵称", { exact: true })).toBeVisible();
    await expect(guest.getByRole("heading", { name: "新昵称", exact: true })).toBeVisible();
    await guest.getByRole("button", { name: "房间设置", exact: true }).click();
    await expect(guest.getByRole("button", { name: "保存房间名称" })).toHaveCount(0);
    await expect(guest.getByRole("region", { name: "房间设置", exact: true }).getByLabel("我的房间昵称", { exact: true })).toHaveValue("新昵称");
    await expect.poll(() => guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await guestContext.close();
  }
});
