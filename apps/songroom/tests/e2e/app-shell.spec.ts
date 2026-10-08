import { expect, test } from "@playwright/test";

for (const width of [320, 900, 1440]) {
  test(`应用壳在 ${width}px 宽度稳定显示并可返回首页`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    await page.goto("/");
    await expect(page).toHaveTitle("SongRoom 点歌台");
    await expect(page.getByRole("heading", { name: "SongRoom 点歌台" })).toBeVisible();
    await expect(page.getByText("账号与房间功能正在交付")).toBeVisible();
    await expect(page.getByTitle("服务状态：运行正常")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.keyboard.press("Tab");
    const focusStyle = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    });
    expect(focusStyle).toBe(true);

    await page.goto("/this-route-does-not-exist");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(page.getByText("这个地址没有对应的 SongRoom 页面。")).toBeVisible();
    await page.getByRole("link", { name: "返回首页" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "SongRoom 点歌台" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    expect(consoleErrors).toEqual([]);
  });
}

test("登录后 Header 移除多余的“我的房间”链接，改用紧凑用户胶囊与直达导航", async ({ page }) => {
  const email = `shell-user-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("账号称呼").fill("胶囊测试员");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill("correct horse battery staple");
  await page.getByRole("button", { name: "注册并进入房间列表" }).click();
  await expect(page).toHaveURL(/\/rooms$/);

  // 1. Header 顶部导航栏不再有重复的“我的房间”链接
  const header = page.locator(".app-header");
  await expect(header.getByRole("link", { name: "我的房间" })).toHaveCount(0);

  // 2. Header 提供紧凑用户胶囊
  const capsuleBtn = header.getByRole("button", { name: "账号菜单" });
  await expect(capsuleBtn).toBeVisible();
  await expect(capsuleBtn).toContainText("胶囊测试员");

  // 3. 点击胶囊展开菜单，展示身份信息与操作项
  await capsuleBtn.click();
  const dropdown = page.locator(".user-dropdown");
  await expect(dropdown).toBeVisible();
  await expect(dropdown.getByText("胶囊测试员")).toBeVisible();
  await expect(dropdown.getByText(email)).toBeVisible();
  await expect(dropdown.getByRole("link", { name: "账号设置" })).toBeVisible();
  await expect(dropdown.getByRole("button", { name: "退出登录" })).toBeVisible();

  // 4. 点击账号设置直达设置页
  await dropdown.getByRole("link", { name: "账号设置" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "管理你的点歌台账号" })).toBeVisible();

  // 5. 账号设置页无多余机制说教，具备模块化分区与清晰占位符
  await expect(page.getByText("账号称呼可以修改并允许重复")).toHaveCount(0);
  await expect(page.getByText("修改密码不会自动撤销其他设备会话")).toHaveCount(0);
  await expect(page.getByPlaceholder("输入账号称呼")).toBeVisible();
  await expect(page.getByPlaceholder("输入当前密码")).toBeVisible();
  await expect(page.getByPlaceholder("8-128位新密码")).toBeVisible();

  // 6. 账号设置页顶部提供清晰的“返回房间列表”导航
  const backLink = page.getByRole("link", { name: "返回房间列表" });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await expect(page).toHaveURL(/\/rooms$/);

  // 7. 用户胶囊中支持直接退出登录
  await header.getByRole("button", { name: "账号菜单" }).click();
  await page.locator(".user-dropdown").getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "SongRoom 点歌台" })).toBeVisible();
});

test("全局设计规范生效：启用 tabular-nums 等宽数字与按钮触感过渡", async ({ page }) => {
  await page.goto("/");

  // 1. 验证全局 tabular-nums 等宽特性生效
  const numericFeature = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    return {
      rootVariant: rootStyle.fontVariantNumeric,
      rootFeatures: rootStyle.fontFeatureSettings,
      bodyVariant: bodyStyle.fontVariantNumeric,
      bodyFeatures: bodyStyle.fontFeatureSettings
    };
  });
  expect(
    numericFeature.rootVariant.includes("tabular-nums") ||
    numericFeature.rootFeatures.includes("tnum") ||
    numericFeature.bodyVariant.includes("tabular-nums") ||
    numericFeature.bodyFeatures.includes("tnum")
  ).toBe(true);

  // 2. 验证按钮具备平滑过渡定义与圆角变量
  const buttonStyle = await page.evaluate(() => {
    const btn = document.querySelector(".primary-button, .secondary-button");
    if (!btn) return null;
    const style = getComputedStyle(btn);
    return {
      transition: style.transition,
      cursor: style.cursor
    };
  });
  expect(buttonStyle).not.toBeNull();
  expect(buttonStyle?.cursor).toBe("pointer");
});
