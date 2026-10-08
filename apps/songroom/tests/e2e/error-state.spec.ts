import { expect, test } from "@playwright/test";

test("健康状态读取失败时显示错误并支持重试", async ({ page }) => {
  let available = false;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const isExpectedResourceError =
      message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)" &&
      message.location().url === new URL("/api/status", page.url()).href;
    if (!isExpectedResourceError) consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: available ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify({ status: available ? "ready" : "starting", service: "songroom", schemaVersion: 1 })
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "暂时无法连接服务" })).toBeVisible();
  await expect(page.getByText("暂不可用").first()).toBeVisible();
  const retryButton = page.getByRole("button", { name: "重新读取状态" });
  await expect(retryButton).toBeVisible();

  available = true;
  await retryButton.click();
  await expect(page.getByRole("heading", { name: "应用已准备就绪" })).toBeVisible();
  await expect(page.getByTitle("服务状态：运行正常")).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
