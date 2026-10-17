import { expect, test, type Page } from "@playwright/test";
import { v7 } from "uuid";
import type { PublicPlaylistView } from "../../src/shared/public-playlist-contracts.js";

const roomId = v7();
const operationId = v7();
const root = `/api/rooms/${roomId}`;
const tracks = Array.from({ length: 500 }, (_, position) => ({
  position, songId: String(position + 1), name: `歌曲 ${position + 1}`, artists: [position === 1 ? "特别歌手" : "歌手"], album: "专用专辑名", requesters: position === 0 ? ["小林"] : []
}));
const view: PublicPlaylistView = {
  playlist: { id: "playlist-1", name: "云端新名称" },
  snapshot: { version: 7, syncedAt: 1700000000000, trackCount: tracks.length, tracks },
  operation: null, lastRefreshError: null, version: 1,
  allowedActions: ["refreshPublicPlaylist", "requestSong"], disabledReason: "PUBLIC_PLAYLIST_EXISTS"
};
async function setup(page: Page, playbackSong: string | null = "401") {
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: {
    session: { id: "ui-session", userId: "ui-user", expiresAt: "2099-01-01T00:00:00Z" },
    user: { id: "ui-user", name: "账号称呼", email: "ui@example.com", emailVerified: false }
  } }));
  await page.route(`**${root}`, route => route.fulfill({ json: {
    room: { id: roomId, name: "343", role: "owner", nickname: "房主" },
    version: 1, pendingCount: 0, allowedActions: ["renameRoom", "renameNickname"], disabledReasons: {}
  } }));
  await page.route(`**${root}/public-playlist`, route => route.fulfill({ json: view }));
  await page.route(`**${root}/public-playlist/refresh`, route => route.fulfill({ json: view }));
  await page.route(`**${root}/public-playlist/playback`, route => route.fulfill({ json: { songId: playbackSong, checkedAt: Date.now(), errorCode: null } }));
  await page.route(`**${root}/public-playlist/playback/refresh`, route => route.fulfill({ json: { songId: playbackSong, checkedAt: Date.now(), errorCode: null } }));
}

for (const width of [320, 390, 1440]) {
  test(`${width}px: 窗口虚拟列表、播放定位、切页恢复及云端名称详情`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await setup(page);
    await page.goto(`/rooms/${roomId}`);
    const heading = page.getByRole("heading", { name: "公共歌单", exact: true });
    await expect(heading).toBeAttached();
    const headingBox = await heading.boundingBox();
    if (width <= 768) {
      expect(headingBox!.width).toBeLessThanOrEqual(1);
    } else {
      expect(headingBox!.width).toBeGreaterThan(10);
    }
    await expect(page.locator(".tracks-header-col.col-title")).toHaveText("歌曲与歌手");
    await expect(page.locator(".tracks-header-col.col-requester")).toBeVisible();
    await expect(page.getByText("房间：343", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "歌单技术信息" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "云端新名称" })).toHaveCount(0);
    await expect(page.locator(".requester-capsule")).toHaveText("小林");
    await expect(page.locator(".track-item")).toHaveCount(await page.locator(".track-item").count());
    expect(await page.locator(".track-item").count()).toBeLessThan(50);
    await expect(page.locator(".playlist-tracks-container")).toHaveCSS("overflow-y", "visible");
    await page.getByRole("button", { name: "定位到正在播放" }).click();
    const target = page.locator('[data-song-id="401"]');
    await expect(target).toBeInViewport();
    await expect(target.locator(".playback-indicator")).toBeVisible();
    await expect(page.getByRole("button", { name: /^下一首播放：/ })).toHaveCount(0);
    await expect(page.getByText("播放安排", { exact: true })).toHaveCount(0);
    const bounds = await target.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThan(740);
    const scroll = await page.evaluate(() => scrollY);
    await page.getByRole("button", { name: "房间设置", exact: true }).click();
    await expect(page.getByText("云端新名称", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "公共歌单", exact: true }).click();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(scroll, -1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [320, 390]) {
  test(`${width}px: 点歌人独立列对齐，多人长昵称换行且不挤出视口`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await setup(page);
    const requesters = ["这是一个比较长的室友昵称", "VeryLongRequesterNameWithoutSpaces", "小林"];
    await page.route(`**${root}/public-playlist`, route => route.fulfill({ json: {
      ...view,
      snapshot: { ...view.snapshot!, tracks: [{ ...tracks[0], name: "这是一首名字很长需要省略展示的歌曲", requesters }, ...tracks.slice(1)] }
    } }));
    await page.goto(`/rooms/${roomId}`);
    const track = page.locator('[data-song-id="1"]');
    await expect(track.locator(".requester-capsule")).toHaveText(requesters);
    const info = await track.locator(".track-info").boundingBox();
    const requesterColumn = await track.locator(".track-requesters-side").boundingBox();
    const header = await page.locator(".tracks-header-col.col-requester").boundingBox();
    expect(requesterColumn!.x).toBeGreaterThan(info!.x + info!.width);
    expect(requesterColumn!.x).toBeCloseTo(header!.x, 0);
    expect(requesterColumn!.x + requesterColumn!.width).toBeLessThanOrEqual(width);
    for (const tag of await track.locator(".requester-capsule").all()) {
      const bounds = await tag.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(requesterColumn!.x + requesterColumn!.width + 1);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("不展示下一首按钮，已有未确认命令仍可同键查询和恢复", async ({ page }) => {
  await setup(page, "1");
  const savedCommand = { idempotencyKey: v7(), songId: "4", anchorSongId: "1", snapshotVersion: 7 };
  await page.addInitScript(({ key, command }) => {
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ command, operationId: null }));
  }, { key: `songroom:play-next:ui-session:${roomId}`, command: savedCommand });
  const commands: unknown[] = [];
  await page.route(`**${root}/public-playlist/play-next`, async route => {
    const command = route.request().postDataJSON();
    commands.push(command);
    if (commands.length === 1) return route.abort("failed");
    return route.fulfill({ json: { replay: true, operation: {
      id: operationId, roomId, songId: command.songId, anchorSongId: command.anchorSongId,
      status: "awaitingConfirmation", step: "unknown", errorCode: null, version: 2
    } } });
  });
  await page.route(`**${root}/public-playlist/play-next/${operationId}`, route => route.fulfill({ json: {
    id: operationId, roomId, songId: "4", anchorSongId: "1", status: "awaitingConfirmation", step: "unknown", errorCode: null, version: 2
  } }));
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole("button", { name: /^下一首播放：/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查询下一首播放结果" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ 点歌", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "查询下一首播放结果" }).click();
  await expect(page.getByText(/提交结果待确认/)).toBeVisible();
  await page.getByRole("button", { name: "查询下一首播放结果" }).click();
  await expect(page.getByText(/下一首播放结果待确认/)).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(savedCommand);
  expect(commands[0]).toEqual(savedCommand);
  await page.reload();
  await expect(page.getByText(/下一首播放结果待确认/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^下一首播放：/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ 点歌", exact: true })).toBeDisabled();
  expect(commands).toHaveLength(2);
});

test("无锚点与播放读取失败保留禁用定位；手动同步同时刷新播放", async ({ page }) => {
  await setup(page, null);
  let playbackRefreshes = 0;
  await page.route(`**${root}/public-playlist/playback/refresh`, route => {
    playbackRefreshes++;
    return route.fulfill({ json: { songId: null, checkedAt: Date.now(), errorCode: "NETWORK_ERROR" } });
  });
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole("button", { name: "定位到正在播放" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^下一首播放：/ })).toHaveCount(0);
  await page.getByRole("button", { name: "同步歌单", exact: true }).click();
  await expect(page.getByText("播放指示读取失败")).toBeVisible();
  expect(playbackRefreshes).toBe(1);
  await expect(page.locator(".playback-indicator")).toHaveCount(0);
  await expect(page.getByText("歌曲 1", { exact: true })).toBeVisible();
});

test("只在公共页可见时轮询，返回立即读播放，减少动态效果时图标静止", async ({ page }) => {
  await setup(page, "1");
  let reads = 0;
  await page.route(`**${root}/public-playlist/playback`, route => {
    reads++;
    return route.fulfill({ json: { songId: "1", checkedAt: Date.now(), errorCode: null } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto(`/rooms/${roomId}`);
  await expect(page.locator(".playback-indicator")).toBeVisible();
  await expect(page.locator(".playback-indicator i").first()).toHaveCSS("animation-name", "none");
  const initial = reads;
  await page.clock.fastForward(30_100);
  await expect.poll(() => reads).toBe(initial + 1);
  await page.getByRole("button", { name: "房间设置", exact: true }).click();
  await page.clock.fastForward(60_100);
  expect(reads).toBe(initial + 1);
  await page.getByRole("button", { name: "公共歌单", exact: true }).click();
  await expect.poll(() => reads).toBe(initial + 2);
});

test("歌单即时搜索与点歌人下拉筛选、保持绝对序号及复合过滤", async ({ page }) => {
  await setup(page, "401");
  await page.goto(`/rooms/${roomId}`);

  // 初始不展开搜索栏
  await expect(page.getByRole("search", { name: "歌单内搜索与筛选" })).toHaveCount(0);

  // 点击展开搜索栏
  const searchToggle = page.getByRole("button", { name: "展开搜索筛选" });
  await searchToggle.click();
  await expect(page.getByRole("search", { name: "歌单内搜索与筛选" })).toBeVisible();

  // 1. 搜索歌曲名称
  const searchInput = page.getByPlaceholder("搜索歌名或歌手…");
  await searchInput.fill("歌曲 500");
  const filteredItem = page.locator('[data-song-id="500"]');
  await expect(filteredItem).toBeVisible();
  // 保持网易云绝对物理序号 #500
  await expect(filteredItem.locator(".track-index")).toHaveText("500");
  await expect(page.getByText(/筛选出 1 \/ 共 500 首/)).toBeVisible();

  // 2. 仅按歌手匹配，专辑名称不匹配
  await searchInput.fill("特别歌手");
  await expect(page.locator('[data-song-id="2"]')).toBeVisible();
  await expect(page.getByText(/筛选出 1 \/ 共 500 首/)).toBeVisible();

  await searchInput.fill("专用专辑名");
  await expect(page.getByText("未找到匹配的歌曲")).toBeVisible();

  // 3. 筛选后仍保持绝对序号，不展示下一首播放入口
  await searchInput.fill("歌曲 402");
  await expect(page.locator('[data-song-id="402"]')).toBeVisible();
  await expect(page.locator('[data-song-id="402"] .track-index')).toHaveText("402");
  await expect(page.getByRole("button", { name: /^下一首播放：/ })).toHaveCount(0);

  await searchInput.fill("歌曲 403");
  await expect(page.locator('[data-song-id="403"]')).toBeVisible();
  await expect(page.locator('[data-song-id="403"] .track-index')).toHaveText("403");

  // 4. 清空搜索
  await page.getByRole("button", { name: "清空搜索词" }).click();
  await expect(searchInput).toHaveValue("");
  await expect(page.getByText("500 首歌曲")).toBeVisible();

  // 5. 点歌人下拉筛选
  const select = page.getByRole("combobox", { name: "按点歌人筛选" });
  await expect(select.locator("option")).toHaveText(["全部点歌人", "小林"]);
  await select.selectOption("小林");
  await expect(page.locator('[data-song-id="1"]')).toBeVisible();
  await expect(page.locator(".track-item")).toHaveCount(1);
  await expect(page.getByText(/筛选出 1 \/ 共 500 首/)).toBeVisible();

  // 6. 复合过滤：小林 + 不匹配的搜索词 -> 空状态
  await searchInput.fill("不存在的歌");
  await expect(page.getByText("未找到匹配的歌曲")).toBeVisible();
  await expect(page.getByRole("button", { name: "清除筛选条件" })).toBeVisible();

  // 7. 点击清除筛选条件
  await page.getByRole("button", { name: "清除筛选条件" }).click();
  await expect(page.getByText("500 首歌曲")).toBeVisible();
  await expect(page.locator('[data-song-id="1"]')).toBeVisible();

  // 8. 320px 与 390px 视口下展开搜索筛选栏均无横向溢出
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }

  // 9. 减弱动态效果（prefers-reduced-motion）下搜索栏动画被禁用
  await page.emulateMedia({ reducedMotion: "reduce" });
  const filterBar = page.getByRole("search", { name: "歌单内搜索与筛选" });
  await expect(filterBar).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // 10. 收起搜索栏
  await page.getByRole("button", { name: "收起搜索筛选" }).click();
  await expect(page.getByRole("search", { name: "歌单内搜索与筛选" })).toHaveCount(0);
});
