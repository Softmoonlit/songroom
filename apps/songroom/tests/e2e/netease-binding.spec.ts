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
  await page.getByRole("link", { name: "我的房间", exact: true }).click();
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
  await page.getByRole("link", { name: "我的房间", exact: true }).click();
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始扫码绑定" })).toBeVisible();
  await expect(page.getByText(identity.nickname)).toHaveCount(0);
});

test("未知错误仅显示中文通用提示，已有绑定不提供扫码或授权变更动作", async ({ page }) => {
  await signedIn(page);
  await page.route("**/api/netease/binding", route => route.fulfill({ status: 503, json: { error: { code: "FUTURE_UNKNOWN_ERROR", message: "raw secret=MUSIC_U_do_not_render" } } }));
  await page.goto("/account");
  await expect(page.getByRole("alert")).toHaveText("暂时无法完成请求，请稍后重试。");
  await expect(page.getByText(/MUSIC_U_do_not_render/)).toHaveCount(0);
  await page.route("**/api/netease/binding", route => route.fulfill({ json: bound }));
  await page.getByRole("button", { name: "重新读取绑定状态" }).click();
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();
  await expect(page.getByText(identity.nickname)).toBeVisible();
  await expect(page.getByRole("button", { name: /扫码|换号|重新授权|退出网易云/ })).toHaveCount(0);
});
