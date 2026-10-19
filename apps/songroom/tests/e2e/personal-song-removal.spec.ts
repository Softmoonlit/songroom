import { expect, test, type Page } from "@playwright/test";
import { v7 } from "uuid";
import { AxeBuilder } from "@axe-core/playwright";
import type { PersonalSongOperationView } from "../../src/shared/personal-playlist-contracts.js";

const roomId = v7();
const track = { position: 0, songId: "song-1", name: "晴天", artists: ["周杰伦"], album: "叶惠美" };

async function setup(page: Page, role: "owner" | "roommate" = "roommate") {
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: {
    session: { id: "session-removal", userId: "user-removal", expiresAt: "2099-01-01T00:00:00Z" },
    user: { id: "user-removal", name: "测试成员", email: "member@example.com", emailVerified: false }
  } }));
  await page.route(`**/api/rooms/${roomId}`, route => route.fulfill({ json: {
    room: { id: roomId, name: "测试房间", role, nickname: "测试成员" }, version: 1,
    pendingCount: 0, allowedActions: ["renameNickname"], disabledReasons: {}
  } }));
  await page.route("**/api/events", route => route.fulfill({
    headers: { "content-type": "text/event-stream" }, body: ": heartbeat\n\n"
  }));
  await page.route(`**/api/rooms/${roomId}/public-playlist`, route => route.fulfill({ json: {
    playlist: null, snapshot: null, operation: null, lastRefreshError: null,
    allowedActions: [], disabledReason: null, version: 1
  } }));
}

function personalView(tracks: typeof track[], songOperation: PersonalSongOperationView | null = null) {
  return {
    songOperation,
    playlist: { id: "personal-1", name: "songroom-测试房间-测试成员" },
    snapshot: { version: 1, syncedAt: Date.now(), trackCount: tracks.length, tracks },
    operation: null, lastRefreshError: null,
    allowedActions: ["refreshPersonalPlaylist", "removePersonalSong"], disabledReason: null, version: 1
  };
}

test("没有公共歌单也能删除本人歌曲，仅在云端确认后更新列表", async ({ page }) => {
  await setup(page);
  let removed = false;
  let removeRequests = 0;
  let songOperation: PersonalSongOperationView | null = null;
  const operationId = v7();
  await page.route(`**/api/rooms/${roomId}/personal-playlist`, route =>
    route.fulfill({ json: personalView(removed ? [] : [track], songOperation) }));
  await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route =>
    route.fulfill({ json: personalView(removed ? [] : [track], songOperation) }));
  await page.route(`**/api/rooms/${roomId}/personal-playlist/songs/remove`, route => {
    removeRequests += 1;
    expect(route.request().postDataJSON()).toMatchObject({ songId: "song-1" });
    removed = true;
    songOperation = {
      id: operationId, roomId, songId: track.songId, name: track.name,
      artists: track.artists, album: track.album, action: "remove", status: "succeeded",
      songConfirmed: true, errorCode: null, step: "succeeded", version: 1
    };
    return route.fulfill({ json: { replay: false, operation: songOperation } });
  });
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "我的歌单", exact: true }).click();
  await page.getByRole("button", { name: "从个人歌单删除《晴天》", exact: true }).click();
  await expect(page.getByText("《晴天》已从个人歌单删除", { exact: true })).toBeVisible();
  await expect(page.getByText("歌单内暂无歌曲", { exact: true })).toBeVisible();
  expect(removeRequests).toBe(1);
});

test("删除结果待确认时保留歌曲、禁止重复提交，刷新后仍能继续确认", async ({ page }) => {
  await setup(page, "owner");
  let removeRequests = 0;
  let operation: PersonalSongOperationView | null = null;
  const view = () => ({
    ...personalView(operation?.status === "succeeded" ? [] : [track], operation),
    allowedActions: operation && operation.status !== "succeeded"
      ? ["refreshPersonalPlaylist"] : ["refreshPersonalPlaylist", "removePersonalSong"]
  });
  await page.route(`**/api/rooms/${roomId}/personal-playlist`, route => route.fulfill({ json: view() }));
  await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: view() }));
  await page.route(`**/api/rooms/${roomId}/personal-playlist/songs/remove`, route => {
    removeRequests += 1;
    operation = {
      id: v7(), roomId, songId: track.songId, name: track.name,
      artists: track.artists, album: track.album, action: "remove", status: "queued",
      songConfirmed: false, errorCode: null, step: "ready", version: 1
    };
    return route.fulfill({ status: 202, json: { replay: false, operation } });
  });
  await page.goto(`/rooms/${roomId}`);
  const personalTab = page.getByRole("button", { name: "我的歌单", exact: true });
  await personalTab.click();
  const removeButton = page.getByRole("button", { name: "从个人歌单删除《晴天》", exact: true });
  await removeButton.click();
  await expect(page.getByText("《晴天》删除已排队。", { exact: true })).toBeVisible();
  operation = { ...operation!, status: "awaitingConfirmation", step: "unknown", errorCode: "NETWORK_ERROR", version: 2 };
  await expect(page.getByText("《晴天》删除结果待确认，请勿重复删除。可同步歌单继续确认。", { exact: true })).toBeVisible();
  await expect(removeButton).toBeDisabled();
  await expect(page.getByText("晴天", { exact: true })).toBeVisible();
  await expect(page.getByText("《晴天》已从个人歌单删除", { exact: true })).toHaveCount(0);

  await page.reload();
  await personalTab.click();
  await expect(page.getByText("《晴天》删除结果待确认，请勿重复删除。可同步歌单继续确认。", { exact: true })).toBeVisible();
  await expect(removeButton).toBeDisabled();
  operation = { ...operation!, status: "succeeded", step: "succeeded", songConfirmed: true, errorCode: null, version: 3 };
  await page.getByRole("button", { name: "同步个人歌单", exact: true }).click();
  await expect(page.getByText("《晴天》已从个人歌单删除", { exact: true })).toBeVisible();
  await expect(page.getByText("歌单内暂无歌曲", { exact: true })).toBeVisible();
  expect(removeRequests).toBe(1);
});

for (const width of [320, 390, 1440]) {
  test(`${width}px 单首删除和点歌按钮可达，无横向溢出且通过无障碍检查`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(page);
    const view = personalView([track]);
    await page.route(`**/api/rooms/${roomId}/personal-playlist`, route => route.fulfill({ json: view }));
    await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: view }));
    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await expect(page.getByRole("button", { name: "从个人歌单删除《晴天》", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "点播《晴天》到公共歌单", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    const axe = await new AxeBuilder({ page }).include(".room-workspace").disableRules(["color-contrast"]).analyze();
    expect(axe.violations).toEqual([]);
  });
}

test("明确拒绝删除时保留歌曲并显示失败，不提示删除成功", async ({ page }) => {
  await setup(page);
  const view = personalView([track]);
  await page.route(`**/api/rooms/${roomId}/personal-playlist`, route => route.fulfill({ json: view }));
  await page.route(`**/api/rooms/${roomId}/personal-playlist/refresh`, route => route.fulfill({ json: view }));
  await page.route(`**/api/rooms/${roomId}/personal-playlist/songs/remove`, route => route.fulfill({
    status: 409, json: { error: { code: "CONCURRENT_OPERATION_LIMIT_EXCEEDED" } }
  }));
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "我的歌单", exact: true }).click();
  await page.getByRole("button", { name: "从个人歌单删除《晴天》", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("你在此房间已有未完成的写入操作");
  await expect(page.getByText("晴天", { exact: true })).toBeVisible();
  await expect(page.getByText("《晴天》已从个人歌单删除", { exact: true })).toHaveCount(0);
});
