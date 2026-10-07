import { expect, test, type Page } from "@playwright/test";

test("多端可见页面通过 SSE 失效自动更新，不需手动刷新，且键盘焦点与 320px 布局稳定", async ({ page, browser }) => {
  const suffix = `${Date.now()}-${test.info().workerIndex}`;

  async function register(target: Page, label: string) {
    await target.goto("/register");
    await target.getByLabel("账号称呼").fill(label);
    await target.getByLabel("邮箱").fill(`sse-${label === "房主" ? "owner" : "guest"}-${suffix}@example.com`);
    await target.getByLabel("密码").fill("correct horse battery staple");
    await target.getByRole("button", { name: "注册并进入房间列表" }).click();
    await expect(target).toHaveURL(/\/rooms$/);
  }

  // 1. 房主登录并建房
  await register(page, "房主");
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await page.getByRole("button", { name: "开始扫码绑定" }).click();
  await expect(page.getByRole("img", { name: "网易云授权二维码" })).toBeVisible();
  await page.getByRole("button", { name: "检查扫码状态" }).click();
  await page.getByRole("button", { name: "确认绑定此网易云账号" }).click();
  await expect(page.getByText("已绑定网易云账号", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "我的房间", exact: true }).click();
  await page.getByRole("link", { name: "创建房间", exact: true }).click();
  await page.getByLabel("房间名称").fill("SSE测试音乐间");
  await page.getByLabel("我的房间昵称").fill("房主小王");
  await page.getByRole("checkbox", { name: "确认使用此网易云账号创建房间" }).check();
  await page.getByRole("button", { name: "创建并进入房间" }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
  const roomUrl = page.url();

  // 获取邀请码
  await page.getByRole("button", { name: "房间成员", exact: true }).click();
  const inviteCode = (await page.getByRole("region", { name: "房间邀请" }).locator("dd").textContent())!;

  // 2. 模拟第二台设备：创建独立的浏览器上下文（320px 窄屏），以房主同账号在另一设备打开
  const ownerClient2Context = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const ownerClient2 = await ownerClient2Context.newPage();
  await ownerClient2.goto("/login");
  await ownerClient2.getByLabel("邮箱").fill(`sse-owner-${suffix}@example.com`);
  await ownerClient2.getByLabel("密码").fill("correct horse battery staple");
  await ownerClient2.getByRole("button", { name: "登录" }).click();
  await expect(ownerClient2).toHaveURL(/\/rooms$/);
  await ownerClient2.goto(roomUrl);
  await expect(ownerClient2.getByRole("heading", { level: 1 })).toHaveText("SSE测试音乐间");

  // 3. 验证同账号多端改名自动失效并更新：
  // 设备 1 改名
  await page.getByRole("button", { name: "房间设置", exact: true }).click();
  const nameInput = page.getByLabel("房间名称", { exact: true });
  await nameInput.fill("SSE新房名");
  await page.getByRole("button", { name: "保存房间名称", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SSE新房名");

  // 设备 2 绝对不调用 reload()，通过 SSE 失效事件自动更新页面标题
  await expect(ownerClient2.getByRole("heading", { level: 1 })).toHaveText("SSE新房名");

  // 4. 模拟申请人设备：独立账号在 Context 3 中提交申请
  const guestContext = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const guest = await guestContext.newPage();
  await register(guest, "室友");
  await guest.goto(`/join#${inviteCode}`);
  await guest.getByLabel("拟用房间昵称").fill("室友阿强");
  await guest.getByRole("button", { name: "提交加入申请" }).click();
  await expect(guest.getByRole("status")).toHaveText("等待房主审批");

  // 房主设备 2（320px 窄屏）绝对不调用 reload()，待审批角标自动出现并显示为 1
  await expect(ownerClient2.getByLabel("待审批申请：1份")).toBeVisible();
  await expect(ownerClient2.getByLabel("待审批申请：1份")).toHaveText("1");
  // 验证 320px 下角标不挤压导航按钮，无横向溢出
  await expect.poll(() => ownerClient2.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // 5. 焦点保护验证：房主设备 1 在输入框中输入文字并保持焦点
  await page.getByRole("button", { name: "房间设置", exact: true }).click();
  const editInput = page.getByLabel("房间名称", { exact: true });
  await editInput.focus();
  await editInput.fill("打字中未提交的新名称");
  await expect(editInput).toBeFocused();

  // 房主在设备 2 审批申请
  await ownerClient2.getByRole("button", { name: "房间成员", exact: true }).click();
  await ownerClient2.getByRole("button", { name: "审批加入申请", exact: true }).click();
  await ownerClient2.getByRole("button", { name: "批准：室友阿强", exact: true }).click();
  await expect(ownerClient2.getByRole("status")).toContainText("已批准：室友阿强");

  // 申请人页面绝对不调用 reload()，通过 SSE 失效自动更新为「申请已获批」
  await expect(guest.getByRole("status")).toHaveText("申请已获批");
  await expect(guest.getByRole("link", { name: "返回房间列表", exact: true })).toBeVisible();

  // 房主设备 1 在后台接收到失效并重新拉取数据后，输入框的键盘焦点依然保持，没有被夺走
  await expect(editInput).toBeFocused();
  await expect(editInput).toHaveValue("打字中未提交的新名称");

  // 6. 公共歌单失效与更新：设备 2 打开公共歌单，设备 1 提交创建，设备 2 自动收到失效拉取最新状态
  await ownerClient2.getByRole("button", { name: "公共歌单", exact: true }).click();
  await expect(ownerClient2.getByRole("heading", { name: "尚未创建公共歌单" })).toBeVisible();

  await page.getByRole("button", { name: "公共歌单", exact: true }).click();
  await page.getByRole("button", { name: "创建公共歌单", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/已排队|正在创建|已创建并绑定/);

  // 设备 2 绝对不调用 reload()，通过 SSE 失效事件自动感知创建操作或完成绑定
  await expect(ownerClient2.getByRole("status")).toContainText(/已排队|正在创建|已创建并绑定/);

  await ownerClient2Context.close();
  await guestContext.close();
});
