import { expect, test } from "@playwright/test";

test("注册后恢复房间列表、管理账号并退出当前设备", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const email = `browser-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("账号称呼").fill("浏览器测试称呼");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill("correct horse battery staple");
  await page.getByRole("button", { name: "注册并进入房间列表" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.getByRole("heading", { name: "我的房间", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "账号设置", exact: true })).toBeVisible();
  await page.getByLabel("称呼").fill("新的浏览器称呼");
  await page.getByRole("button", { name: "保存称呼" }).click();
  await expect(page.getByRole("status")).toContainText("账号称呼已更新");
  await page.getByRole("button", { name: "退出当前设备" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "SongRoom 点歌台" })).toBeVisible();
});
