import { expect, test, type Page } from "@playwright/test";
import { neteaseBindingView, qrFlowView } from "../../src/shared/netease-contracts.js";

// HTTP mocks cover browser UI states only; server authorization and adapter behavior
// are covered by the application HTTP tests, not this suite.
const flowId = "0195cf0d-6a80-7000-8000-000000000001";
const bindingId = "0195cf0d-6a80-7000-8000-000000000002";
const qrImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=";
const identity = { accountId: "12345678", nickname: "服务器核实的音乐昵称" };
const unbound = neteaseBindingView.parse({ binding: null, allowedActions: ["startQr"] });
const bound = neteaseBindingView.parse({ binding: { id: bindingId, identity, status: "active" }, allowedActions: [] });
function waitingFlow(id = flowId) {
  return qrFlowView.parse({ id, expiresAt: new Date(Date.now() + 300_000).toISOString(), status: "waiting", qrImage, identity: null, allowedActions: ["check"] });
}
async function signedIn(page: Page) {
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: {
    session: { id: "ui-session-one", expiresAt: "2099-01-01T00:00:00.000Z" },
    user: { id: "ui-user", name: "UI 用户", email: "ui@example.com", emailVerified: false }
  } }));
  await page.route("**/api/netease/binding", route => route.fulfill({ json: unbound }));
}

test("键盘扫码、检查服务器身份并确认绑定，320px 不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await signedIn(page);
  await page.route("**/api/netease/qr-flows", async route => {
    expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    await route.fulfill({ json: waitingFlow() });
  });
  await page.route(`**/api/netease/qr-flows/${flowId}/check`, route => route.fulfill({ json: qrFlowView.parse({ ...waitingFlow(), status: "awaitingConfirmation", qrImage: null, identity, allowedActions: ["confirm"] }) }));
  await page.route(`**/api/netease/qr-flows/${flowId}/confirm`, async route => {
    expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    await route.fulfill({ json: bound });
  });
  await page.goto("/account");
  const start = page.getByRole("button", { name: "开始扫码绑定" });
  await expect(start).toBeVisible();
  await start.focus();
  await expect(start).toBeFocused();
  await expect(start).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await expect(page.getByText(identity.nickname)).toBeVisible();
  await expect(page.getByText(identity.accountId, { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toHaveCount(0);
  await page.getByRole("button", { name: "确认绑定此网易云账号" }).click();
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /扫码|换号|重新授权|退出网易云/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("替代扫码后晚到的旧身份不会覆盖新流程，离开后二维码丢弃", async ({ page }) => {
  await signedIn(page);
  const replacementId = "0195cf0d-6a80-7000-8000-000000000003";
  let starts = 0;
  await page.route("**/api/netease/qr-flows", route => route.fulfill({ json: waitingFlow(++starts === 1 ? flowId : replacementId) }));
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
  await page.route(`**/api/netease/qr-flows/${flowId}/check`, async route => {
    await checkGate;
    await route.fulfill({ json: qrFlowView.parse({ ...waitingFlow(), status: "awaitingConfirmation", identity, qrImage: null, allowedActions: ["confirm"] }) }).catch(() => undefined);
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "开始扫码绑定" }).click();
  const checking = page.waitForRequest(`**/api/netease/qr-flows/${flowId}/check`);
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await checking;
  await page.getByRole("button", { name: "重新扫码（替代当前流程）" }).click();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  releaseCheck();
  // A subsequent UI interaction observes the new flow after the old response settles.
  await page.route(`**/api/netease/qr-flows/${replacementId}/check`, route => route.fulfill({ json: qrFlowView.parse({ ...waitingFlow(replacementId), status: "scanned" }) }));
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已扫码" })).toBeVisible();
  await expect(page.getByText(identity.nickname)).toHaveCount(0);
  await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始扫码绑定" })).toBeVisible();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }))).not.toContain("data:image");
});

test("扫码过期后清除二维码，用稳定中文错误且允许重新扫码", async ({ page }) => {
  await signedIn(page);
  await page.route("**/api/netease/qr-flows", route => route.fulfill({ json: waitingFlow() }));
  await page.route(`**/api/netease/qr-flows/${flowId}/check`, route => route.fulfill({ status: 410, json: { error: { code: "QR_FLOW_EXPIRED", message: "raw cookie=MUSIC_U_sensitive upstream payload" } } }));
  await page.goto("/account");
  await page.getByRole("button", { name: "开始扫码绑定" }).click();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await expect(page.getByRole("alert")).toHaveText("二维码已过期，请重新开始扫码。");
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始扫码绑定" })).toBeEnabled();
  await expect(page.getByText(/MUSIC_U_sensitive/)).toHaveCount(0);
});

test("会话更新销毁临时二维码，旧会话检查响应不能恢复身份", async ({ page }) => {
  await signedIn(page);
  let sessionReads = 0;
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: {
    session: { id: ++sessionReads === 1 ? "first-session" : "replacement-session", expiresAt: "2099-01-01T00:00:00.000Z" },
    user: { id: "ui-user", name: "UI 用户", email: "ui@example.com", emailVerified: false }
  } }));
  await page.route("**/api/auth/update-user", route => route.fulfill({ json: { status: true } }));
  await page.route("**/api/netease/qr-flows", route => route.fulfill({ json: waitingFlow() }));
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
  await page.route(`**/api/netease/qr-flows/${flowId}/check`, async route => {
    await checkGate;
    await route.fulfill({ json: qrFlowView.parse({ ...waitingFlow(), status: "awaitingConfirmation", identity, qrImage: null, allowedActions: ["confirm"] }) }).catch(() => undefined);
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "开始扫码绑定" }).click();
  const checking = page.waitForRequest(`**/api/netease/qr-flows/${flowId}/check`);
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await checking;
  await page.getByRole("button", { name: "保存称呼" }).click();
  await expect(page.getByRole("button", { name: "开始扫码绑定" })).toBeVisible();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toHaveCount(0);
  releaseCheck();
  await page.getByRole("link", { name: "返回房间列表", exact: true }).click();
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始扫码绑定" })).toBeVisible();
  await expect(page.getByText(identity.nickname)).toHaveCount(0);
});

test("退出授权 -> 房间显示等待授权 -> 扫不同账号被拒 -> 扫同一账号恢复 -> 房间恢复正常 完整闭环", async ({ page }) => {
  const boundActive = neteaseBindingView.parse({ binding: { id: bindingId, identity, status: "active" }, allowedActions: ["revoke"] });
  const waitingAuth = neteaseBindingView.parse({ binding: { id: bindingId, identity, status: "waitingAuthorization" }, allowedActions: ["startQr"] });
  let currentBinding = boundActive;
  let roomAuthStatus: "waitingAuthorization" | undefined = undefined;

  await signedIn(page);
  await page.route("**/api/netease/binding", route => route.fulfill({ json: currentBinding }));
  await page.route("**/api/rooms", route => route.fulfill({ json: {
    rooms: [{
      id: "0195cf0d-6a80-7000-8000-000000000099",
      name: "我的宿舍",
      role: "owner",
      nickname: "房主",
      version: 1,
      allowedActions: ["enterRoom"],
      disabledReasons: {},
      ...(roomAuthStatus ? { authorizationStatus: roomAuthStatus } : {})
    }],
    allowedActions: ["openCreateRoom", "openJoin"],
    disabledReasons: {}
  } }));

  // 1. 访问账号设置，看到已绑定状态与退出授权按钮
  await page.goto("/account");
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();
  const revokeBtn = page.getByRole("button", { name: "退出网易云授权" });
  await expect(revokeBtn).toBeVisible();

  // 2. 点击退出授权，弹出二次确认
  await revokeBtn.click();
  await expect(page.getByText("确定要退出网易云授权吗？")).toBeVisible();
  const cancelBtn = page.getByRole("button", { name: "取消" });
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();
  await expect(page.getByText("确定要退出网易云授权吗？")).toHaveCount(0);

  // 再次点击并确认退出授权
  await revokeBtn.click();
  await page.route("**/api/netease/binding/revoke", async route => {
    expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    currentBinding = waitingAuth;
    roomAuthStatus = "waitingAuthorization";
    await route.fulfill({ json: waitingAuth });
  });
  await page.getByRole("button", { name: "确认退出授权" }).click();

  // 退出后显示等待重新授权提示
  await expect(page.getByText("网易云授权已退出，等待重新授权")).toBeVisible();
  await expect(page.getByText("原账号绑定已保留。请使用同一个网易云账号重新扫码恢复授权。")).toBeVisible();

  // 3. 访问房间列表，房间卡片显示等待房主重新授权警告
  await page.goto("/rooms");
  await expect(page.getByText("网易云授权已退出，等待房主重新授权")).toBeVisible();

  // 4. 返回账号设置重新扫码，扫不同账号被拒
  await page.goto("/account");
  const reauthFlow1 = "0195cf0d-6a80-7000-8000-000000000011";
  await page.route("**/api/netease/qr-flows", route => route.fulfill({ json: waitingFlow(reauthFlow1) }));
  await page.route(`**/api/netease/qr-flows/${reauthFlow1}/check`, route => route.fulfill({
    status: 409,
    json: { error: { code: "ACCOUNT_MISMATCH" } }
  }));
  await page.getByRole("button", { name: "重新扫码授权" }).click();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await expect(page.getByRole("alert")).toHaveText("扫码账号与当前绑定不一致，原绑定已保留，请重新扫码。");

  // 原绑定依然是 waitingAuthorization
  await expect(page.getByText("网易云授权已退出，等待重新授权")).toBeVisible();

  // 5. 扫同一账号恢复授权
  const reauthFlow2 = "0195cf0d-6a80-7000-8000-000000000012";
  await page.route("**/api/netease/qr-flows", route => route.fulfill({ json: waitingFlow(reauthFlow2) }));
  await page.route(`**/api/netease/qr-flows/${reauthFlow2}/check`, route => route.fulfill({
    json: qrFlowView.parse({ ...waitingFlow(reauthFlow2), status: "awaitingConfirmation", qrImage: null, identity, allowedActions: ["confirm"] })
  }));
  await page.route(`**/api/netease/qr-flows/${reauthFlow2}/confirm`, async route => {
    expect(route.request().postDataJSON()).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    currentBinding = boundActive;
    roomAuthStatus = undefined;
    await route.fulfill({ json: boundActive });
  });

  await page.getByRole("button", { name: "重新扫码授权" }).click();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await expect(page.getByText("身份已核实，请确认重新授权。")).toBeVisible();
  await page.getByRole("button", { name: "确认重新授权" }).click();

  await expect(page.getByText("已恢复网易云授权。")).toBeVisible();
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();

  // 6. 房间恢复正常
  await page.goto("/rooms");
  await expect(page.getByText("我的宿舍")).toBeVisible();
  await expect(page.getByText("网易云授权已退出，等待房主重新授权")).toHaveCount(0);
});


