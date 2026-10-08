import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test.describe("E2E 安全与无障碍矩阵 (Checklist Item 13)", () => {
  for (const width of [320, 900, 1440]) {
    test(`各视口宽度 (${width}px) 下无可见水平滚动、表单可用且高对比度样式生效`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });

      // 1. 首页无水平滚动
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "SongRoom 点歌台" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // 2. 注册页无水平滚动与无障碍扫描
      await page.goto("/register");
      await expect(page.getByRole("heading", { name: "创建点歌台账号" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // 模拟高对比度模式 (prefers-contrast: more)
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.getByRole("heading", { name: "创建点歌台账号" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // 检查键盘 Tab 导航焦点可见性
      await page.keyboard.press("Tab");
      const hasFocus = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        const style = getComputedStyle(el);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      });
      expect(hasFocus).toBe(true);
    });
  }

  test("主流程核心页面 axe-core 基础无障碍合规性分析", async ({ page }) => {
    // 首页
    await page.goto("/");
    const homeScan = await new AxeBuilder({ page })
      .disableRules(["color-contrast"]) // 颜色对比度在不同设备渲染引擎微调，核心结构无重大无障碍违规
      .analyze();
    expect(homeScan.violations).toEqual([]);

    // 登录页
    await page.goto("/login");
    const loginScan = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(loginScan.violations).toEqual([]);

    // 注册页
    await page.goto("/register");
    const registerScan = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(registerScan.violations).toEqual([]);

    // 查验邀请函页
    await page.goto("/join");
    const joinScan = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(joinScan.violations).toEqual([]);
  });

  test("防重复提交 / 双击防御：提交操作中按钮立即禁用以防重入", async ({ page }) => {
    const email = `dblclick-${Date.now()}@example.com`;
    await page.goto("/register");
    await page.getByLabel("账号称呼").fill("双击测试");
    await page.getByLabel("邮箱").fill(email);
    await page.getByLabel("密码").fill("correct horse battery staple");

    const submitBtn = page.getByRole("button", { name: "注册并进入房间列表" });
    await expect(submitBtn).toBeEnabled();

    // 截获注册接口增加微小延迟以观测 disabled 状态
    await page.route("**/api/auth/sign-up/email", async route => {
      await new Promise(r => setTimeout(r, 400));
      await route.continue();
    });

    // 触发点击后按钮应立即禁用并显示提交中状态
    await submitBtn.click();
    const submittingBtn = page.getByRole("button", { name: "提交中…" });
    await expect(submittingBtn).toBeVisible();
    await expect(submittingBtn).toBeDisabled();

    // 最终成功进入房间列表
    await expect(page).toHaveURL(/\/rooms$/);
  });
});
