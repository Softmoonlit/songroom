import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test.describe("深色模式主题系统 E2E", () => {
  test("顶栏主题切换按钮具备三态循环流转、持久化与防闪烁属性", async ({ page }) => {
    await page.goto("/");
    const themeBtn = page.locator(".theme-toggle-btn");
    await expect(themeBtn).toBeVisible();

    // 1. 初始未设置：默认为跟随系统
    const initialPref = await page.evaluate(() => localStorage.getItem("songroom_theme_preference"));
    expect(initialPref).toBeNull();
    await expect(themeBtn).toHaveAttribute("title", /当前：跟随系统/);

    // 2. 第一次点击：system -> light
    await themeBtn.click();
    await expect(themeBtn).toHaveAttribute("title", "当前：浅色模式 - 点击切换为深色模式");
    const lightAttr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const lightStorage = await page.evaluate(() => localStorage.getItem("songroom_theme_preference"));
    expect(lightAttr).toBe("light");
    expect(lightStorage).toBe("light");

    // 3. 第二次点击：light -> dark
    await themeBtn.click();
    await expect(themeBtn).toHaveAttribute("title", "当前：深色模式 - 点击切换为跟随系统");
    const darkAttr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const darkStorage = await page.evaluate(() => localStorage.getItem("songroom_theme_preference"));
    expect(darkAttr).toBe("dark");
    expect(darkStorage).toBe("dark");

    // 验证深色模式下背景变量生效
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // #0b0f19 -> rgb(11, 15, 25)
    expect(bodyBg).toBe("rgb(11, 15, 25)");

    // 4. 刷新页面验证持久化与 head 防闪烁脚本
    await page.reload();
    const reloadedAttr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(reloadedAttr).toBe("dark");
    await expect(page.locator(".theme-toggle-btn")).toHaveAttribute("title", "当前：深色模式 - 点击切换为跟随系统");

    // 5. 第三次点击：dark -> system
    await page.locator(".theme-toggle-btn").click();
    await expect(page.locator(".theme-toggle-btn")).toHaveAttribute("title", /当前：跟随系统/);
    const systemStorage = await page.evaluate(() => localStorage.getItem("songroom_theme_preference"));
    expect(systemStorage).toBe("system");
  });

  test("深色模式在移动端 (320px) 稳定显示无溢出与横向滚动", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/");

    // 切换到深色模式
    const themeBtn = page.locator(".theme-toggle-btn");
    await themeBtn.click(); // to light
    await themeBtn.click(); // to dark
    await expect(themeBtn).toHaveAttribute("title", /当前：深色模式/);

    // 页面无横向滚动溢出
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("深色模式下主要页面 axe-core 无障碍合规性分析", async ({ page }) => {
    await page.goto("/");
    // 切换至深色模式
    await page.evaluate(() => {
      localStorage.setItem("songroom_theme_preference", "dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.reload();

    const homeScan = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(homeScan.violations).toEqual([]);

    await page.goto("/login");
    const loginScan = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(loginScan.violations).toEqual([]);

    await page.goto("/register");
    const registerScan = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(registerScan.violations).toEqual([]);
  });
});
