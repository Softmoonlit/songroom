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
    await expect(page.getByText("运行正常").first()).toBeVisible();
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
