import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { v7 } from "uuid";
import type {
  PublicPlaylistView,
  RandomReplacementOperationView,
  RandomReplacementPreviewView,
  RandomReplacementResponse
} from "../../src/shared/public-playlist-contracts.js";

const roomId = v7();
const ownerMemberId = v7();
const roommateMemberId = v7();

const publicPlaylistEndpoint = `**/api/rooms/${roomId}/public-playlist`;
const randomPreviewEndpoint = `**/api/rooms/${roomId}/public-playlist/random-preview`;
const randomReplacementEndpoint = `**/api/rooms/${roomId}/public-playlist/random-replacement`;
const replacementOperationEndpoint = `**/api/rooms/${roomId}/public-playlist/random-replacement/*`;

async function setupRoom(page: Page, isOwner = true) {
  const currentUserId = isOwner ? "user-owner" : "user-roommate";
  await page.route("**/api/auth/get-session", route =>
    route.fulfill({
      json: {
        session: { id: "session-1", userId: currentUserId, expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: currentUserId, name: isOwner ? "房主" : "室友", email: `${currentUserId}@example.com`, emailVerified: false }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}`, route =>
    route.fulfill({
      json: {
        room: { id: roomId, name: "测试音乐间", role: isOwner ? "owner" : "roommate", nickname: isOwner ? "房主小林" : "室友小明" },
        version: 1,
        pendingCount: 0,
        allowedActions: isOwner ? ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"] : ["renameNickname", "leaveRoom"],
        disabledReasons: isOwner ? {} : { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY" }
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/members`, route =>
    route.fulfill({
      json: {
        version: 1,
        members: [
          {
            id: ownerMemberId,
            nickname: "房主小林",
            role: "owner",
            isSelf: isOwner,
            allowedActions: isOwner ? ["renameNickname"] : [],
            disabledReasons: isOwner ? {} : { renameNickname: "SELF_ONLY" }
          },
          {
            id: roommateMemberId,
            nickname: "室友小明",
            role: "roommate",
            isSelf: !isOwner,
            allowedActions: isOwner ? ["removeMember"] : ["renameNickname"],
            disabledReasons: {}
          }
        ],
        allowedActions: isOwner ? ["reviewApplications", "inviteRoommate"] : [],
        disabledReasons: {}
      }
    })
  );

  await page.route(`**/api/rooms/${roomId}/public-playlist/playback`, route =>
    route.fulfill({
      json: {
        songId: null,
        checkedAt: Date.now(),
        errorCode: null
      }
    })
  );

  await page.route("**/api/events", route =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body: ": heartbeat\n\n"
    })
  );
}

const initialPublicView: PublicPlaylistView = {
  playlist: { id: "cloud-pub-01", name: "songroom-测试音乐间-公共" },
  snapshot: {
    version: 1,
    syncedAt: Date.now() - 60000,
    trackCount: 2,
    tracks: [
      { position: 0, songId: "pub-s1", name: "七里香", artists: ["周杰伦"], album: "七里香", requesters: ["房主小林"] },
      { position: 1, songId: "pub-s2", name: "红豆", artists: ["王菲"], album: "唱游", requesters: ["室友小明"] }
    ]
  },
  lastRefreshError: null,
  operation: null,
  allowedActions: ["refreshPublicPlaylist", "requestSong", "replacePublicPlaylist"],
  disabledReason: null,
  version: 1
};

const roommatePublicView: PublicPlaylistView = {
  ...initialPublicView,
  allowedActions: ["refreshPublicPlaylist", "requestSong"]
};

const previewId10 = v7();
const previewId5 = v7();

const mockPreview10: RandomReplacementPreviewView = {
  previewId: previewId10,
  roomId,
  targetCount: 10,
  actualCount: 10,
  tracks: [
    { songId: "new-s1", name: "青花瓷", artists: ["周杰伦"], album: "我很忙", sourceMemberId: ownerMemberId, sourceMemberNickname: "房主小林", isNew: true },
    { songId: "new-s2", name: "夜曲", artists: ["周杰伦"], album: "十一月的萧邦", sourceMemberId: ownerMemberId, sourceMemberNickname: "房主小林", isNew: true },
    { songId: "new-s3", name: "晴天", artists: ["周杰伦"], album: "叶惠美", sourceMemberId: ownerMemberId, sourceMemberNickname: "房主小林", isNew: true },
    { songId: "new-s4", name: "简单爱", artists: ["周杰伦"], album: "范特西", sourceMemberId: ownerMemberId, sourceMemberNickname: "房主小林", isNew: true },
    { songId: "new-s5", name: "稻香", artists: ["周杰伦"], album: "魔杰座", sourceMemberId: ownerMemberId, sourceMemberNickname: "房主小林", isNew: true },
    { songId: "new-s6", name: "流年", artists: ["王菲"], album: "王菲", sourceMemberId: roommateMemberId, sourceMemberNickname: "室友小明", isNew: true },
    { songId: "new-s7", name: "人间", artists: ["王菲"], album: "王菲", sourceMemberId: roommateMemberId, sourceMemberNickname: "室友小明", isNew: true },
    { songId: "new-s8", name: "匆匆那年", artists: ["王菲"], album: "匆匆那年", sourceMemberId: roommateMemberId, sourceMemberNickname: "室友小明", isNew: true },
    { songId: "new-s9", name: "笑忘书", artists: ["王菲"], album: "寓言", sourceMemberId: roommateMemberId, sourceMemberNickname: "室友小明", isNew: true },
    { songId: "pub-s2", name: "红豆", artists: ["王菲"], album: "唱游", sourceMemberId: roommateMemberId, sourceMemberNickname: "室友小明", isNew: false }
  ],
  memberContributions: [
    { memberId: ownerMemberId, nickname: "房主小林", count: 5 },
    { memberId: roommateMemberId, nickname: "室友小明", count: 5 }
  ],
  oldTrackCount: 2,
  oldTracksWithRequesterCount: 2,
  createdAt: Date.now(),
  expiresAt: Date.now() + 600000
};

const mockPreview5: RandomReplacementPreviewView = {
  ...mockPreview10,
  previewId: previewId5,
  targetCount: 5,
  actualCount: 5,
  tracks: mockPreview10.tracks.slice(0, 5),
  memberContributions: [
    { memberId: ownerMemberId, nickname: "房主小林", count: 3 },
    { memberId: roommateMemberId, nickname: "室友小明", count: 2 }
  ]
};

test.describe("公共歌单随机换歌与完整验收 (Ticket 04)", () => {
  test("权限边界：房主端展示「随机换一组」；室友端隐藏换歌按钮且接口拒绝越权", async ({ page }) => {
    // 1. 房主视角
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.goto(`/rooms/${roomId}`);

    const ownerReplaceBtn = page.getByRole("button", { name: "随机换一组" });
    await expect(ownerReplaceBtn).toBeVisible();

    // 2. 室友视角
    await setupRoom(page, false);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: roommatePublicView }));
    await page.route(randomPreviewEndpoint, route =>
      route.fulfill({
        status: 403,
        json: { error: { code: "OWNER_ONLY", message: "只有房主可以操作随机换歌预览" } }
      })
    );
    await page.goto(`/rooms/${roomId}`);

    const roommateReplaceBtn = page.getByRole("button", { name: "随机换一组" });
    await expect(roommateReplaceBtn).toHaveCount(0);
  });

  test("打开换歌弹窗，默认 10 首预览，切换首数及重新抽选", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));

    let requestedCount = 0;
    await page.route(randomPreviewEndpoint, async route => {
      const body = route.request().postDataJSON() as { count: number };
      requestedCount = body.count;
      if (body.count === 5) {
        await route.fulfill({ json: mockPreview5 });
      } else {
        await route.fulfill({ json: mockPreview10 });
      }
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    // 弹窗可见，默认选中 10 首
    const modal = page.locator(".random-replacement-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByRole("radio", { name: "10首 (默认)" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "10首 (默认)" })).toHaveClass(/active/);
    expect(requestedCount).toBe(10);

    // 验证统计与贡献
    await expect(modal.getByText("本次抽选：10 首")).toBeVisible();
    await expect(modal.getByText("将替换公共歌单全部 2 首旧歌曲")).toBeVisible();
    await expect(modal.getByText("房主小林：5 首")).toBeVisible();
    await expect(modal.getByText("室友小明：5 首")).toBeVisible();

    // 切换为 5 首
    await page.getByRole("radio", { name: "5首", exact: true }).click();
    await expect(modal.getByText("本次抽选：5 首")).toBeVisible();
    await expect(modal.getByText("房主小林：3 首")).toBeVisible();
    await expect(modal.getByText("室友小明：2 首")).toBeVisible();
    expect(requestedCount).toBe(5);

    // 点击重新抽选
    await modal.getByRole("button", { name: "重新抽选预览" }).click();
    await expect(modal.getByText("本次抽选：5 首")).toBeVisible();
  });

  test("预览内容详尽展示：歌曲信息、来源成员、新歌标识与替换提示", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    await expect(modal).toBeVisible();

    // 检查歌曲清单
    const trackItems = modal.locator(".preview-track-item");
    await expect(trackItems).toHaveCount(10);
    await expect(trackItems.first()).toContainText("青花瓷");
    await expect(trackItems.first()).toContainText("周杰伦");
    await expect(trackItems.first()).toContainText("房主小林");
    await expect(trackItems.first().locator(".track-badge.is-new")).toBeVisible();

    // 检查保留旧歌（非新歌）
    const lastTrack = trackItems.nth(9);
    await expect(lastTrack).toContainText("红豆");
    await expect(lastTrack.locator(".track-badge.is-new")).toHaveCount(0);

    // 检查确认提示文案（要求官方客户端重新载入并播放全部）
    await expect(modal.locator(".random-confirm-guidance")).toContainText(
      "换歌完成后，请在网易云官方客户端重新载入该歌单并点击「播放全部」以开始播放新列表"
    );
  });

  test("取消/退出预览不发换歌写请求，歌单快照保持不变", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));

    let replacementCalled = false;
    await page.route(randomReplacementEndpoint, route => {
      replacementCalled = true;
      return route.fulfill({ status: 500 });
    });

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    await expect(modal).toBeVisible();

    // 点击取消
    await modal.getByRole("button", { name: "取消" }).click();
    await expect(modal).not.toBeVisible();

    expect(replacementCalled).toBe(false);
    // 歌单原有歌曲保持不变
    await expect(page.locator(".track-name", { hasText: "七里香" })).toBeVisible();
    await expect(page.locator(".track-name", { hasText: "红豆" })).toBeVisible();
  });

  test("候选异常反馈：暂无新歌 (NO_NEW_SONGS) 与空候选 (EMPTY_CANDIDATES)", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));

    let errorToReturn = "NO_NEW_SONGS";
    await page.route(randomPreviewEndpoint, route =>
      route.fulfill({
        status: 409,
        json: { error: { code: errorToReturn, message: "暂无新歌曲可换" } }
      })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    await expect(modal.locator(".error-banner")).toContainText(
      "暂无新歌曲可换。所有成员候选歌曲均已存在于当前公共歌单中。"
    );

    // 切换为空候选错误
    errorToReturn = "EMPTY_CANDIDATES";
    await modal.getByRole("button", { name: "重试" }).click();
    await expect(modal.locator(".error-banner")).toContainText(
      "暂无可用的候选歌曲。请确保房间内有成员配置了个人歌单且包含歌曲。"
    );
  });

  test("完整确认与持久操作推进：展示步骤进度、成功提示与点歌人标签及筛选", async ({ page }) => {
    await setupRoom(page, true);
    let publicView = { ...initialPublicView };
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: publicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));

    const operationId = v7();
    let currentOpStatus: RandomReplacementOperationView = {
      id: operationId,
      roomId,
      status: "queued",
      step: "ready",
      targetCount: 10,
      targetSongIds: mockPreview10.tracks.map(t => t.songId),
      addedSongIds: [],
      removedSongIds: [],
      tagConfirmed: false,
      currentAction: null,
      currentSongId: null,
      errorCode: null,
      version: 1
    };

    await page.route(randomReplacementEndpoint, route => {
      const response: RandomReplacementResponse = {
        replay: false,
        operation: currentOpStatus
      };
      return route.fulfill({ json: response });
    });

    await page.route(`**/api/rooms/${roomId}/public-playlist/random-replacement/${operationId}`, route =>
      route.fulfill({ json: currentOpStatus })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    await expect(modal).toBeVisible();

    // 点击确认替换
    await modal.getByRole("button", { name: "确认替换" }).click();
    await expect(modal).not.toBeVisible();

    // 页面显示排队卡片
    const statusBanner = page.locator(".replacement-status-banner");
    await expect(statusBanner).toBeVisible();
    await expect(statusBanner).toContainText("换歌操作已排队");

    // 模拟推进：正在添加新歌
    currentOpStatus = {
      ...currentOpStatus,
      status: "processing",
      step: "sending",
      currentAction: "add",
      addedSongIds: ["new-s1", "new-s2", "new-s3"],
      version: 2
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(statusBanner).toContainText("正在添加新歌曲到公共歌单（已添加 3 / 10 首）…");

    // 模拟推进：正在移除旧歌
    currentOpStatus = {
      ...currentOpStatus,
      status: "processing",
      step: "sending",
      currentAction: "remove",
      addedSongIds: mockPreview10.tracks.map(t => t.songId),
      removedSongIds: ["pub-s1"],
      version: 3
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(statusBanner).toContainText("正在从公共歌单移除旧歌曲（已移除 1 首）…");

    // 模拟推进：正在记录点歌人标签
    currentOpStatus = {
      ...currentOpStatus,
      status: "processing",
      step: "tagging",
      version: 4
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(statusBanner).toContainText("正在记录各歌曲的点歌人标签…");

    // 模拟成功：更新公共歌单快照，附带各来源成员的点歌人标签
    publicView = {
      ...initialPublicView,
      snapshot: {
        version: 2,
        syncedAt: Date.now(),
        trackCount: 10,
        tracks: mockPreview10.tracks.map((t, idx) => ({
          position: idx,
          songId: t.songId,
          name: t.name,
          artists: t.artists,
          album: t.album,
          requesters: [t.sourceMemberNickname]
        }))
      }
    };
    currentOpStatus = {
      ...currentOpStatus,
      status: "succeeded",
      step: "succeeded",
      version: 5
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    // 验证成功 Toast
    const toast = page.locator(".songroom-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("换歌成功！已更新公共歌单。请在网易云官方客户端重新载入歌单并点击「播放全部」");

    // 状态卡片消失，歌单列表更新为新歌且带有来源成员点歌人标签
    await expect(statusBanner).toHaveCount(0);
    await expect(page.getByText("青花瓷")).toBeVisible();
    const requesterCapsules = page.locator(".requester-capsule");
    await expect(requesterCapsules.filter({ hasText: "房主小林" }).first()).toBeVisible();
    await expect(requesterCapsules.filter({ hasText: "室友小明" }).first()).toBeVisible();

    // 验证点歌人筛选中出现来源成员
    await page.getByRole("button", { name: "展开搜索筛选" }).click();
    const requesterSelect = page.locator(".playlist-requester-select");
    await expect(requesterSelect).toBeVisible();
    await expect(requesterSelect.getByRole("option", { name: "房主小林" })).toBeAttached();
    await expect(requesterSelect.getByRole("option", { name: "室友小明" })).toBeAttached();

    // 筛选「室友小明」
    await requesterSelect.selectOption("室友小明");
    await expect(page.getByText("流年")).toBeVisible();
    await expect(page.getByText("青花瓷")).toHaveCount(0);
  });

  test("部分完成与失败展示：清晰展示已确认的添加与移除进度", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));

    const operationId = v7();
    const failedOp: RandomReplacementOperationView = {
      id: operationId,
      roomId,
      status: "failed",
      step: "stopped",
      targetCount: 10,
      targetSongIds: mockPreview10.tracks.map(t => t.songId),
      addedSongIds: ["new-s1", "new-s2"],
      removedSongIds: ["pub-s1"],
      tagConfirmed: false,
      currentAction: null,
      currentSongId: null,
      errorCode: "NETWORK_ERROR",
      version: 3
    };

    await page.route(randomReplacementEndpoint, route =>
      route.fulfill({ json: { replay: false, operation: failedOp } })
    );
    await page.route(`**/api/rooms/${roomId}/public-playlist/random-replacement/${operationId}`, route =>
      route.fulfill({ json: failedOp })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();
    await page.getByRole("button", { name: "确认替换" }).click();

    const statusBanner = page.locator(".replacement-status-banner");
    await expect(statusBanner).toBeVisible();
    await expect(statusBanner).toContainText("换歌未完成");
    await expect(statusBanner).toContainText("网络连接失败，请稍后重试。（云端已确认：添加 2 首，移除 1 首）");

    // 点击关闭按钮可清除失败卡片，允许重新发起换歌
    await statusBanner.locator(".status-dismiss-btn").click();
    await expect(statusBanner).toHaveCount(0);
    await expect(page.getByRole("button", { name: "随机换一组" })).toBeEnabled();
  });

  test("切页与刷新恢复：切到「我的歌单」后返回，或刷新页面后，自动恢复操作状态", async ({ page }) => {
    const operationId = v7();
    const ongoingOp: RandomReplacementOperationView = {
      id: operationId,
      roomId,
      status: "processing",
      step: "sending",
      targetCount: 10,
      targetSongIds: mockPreview10.tracks.map(t => t.songId),
      addedSongIds: ["new-s1", "new-s2", "new-s3", "new-s4"],
      removedSongIds: [],
      tagConfirmed: false,
      currentAction: "add",
      currentSongId: "new-s5",
      errorCode: null,
      version: 2
    };

    const viewWithOp: PublicPlaylistView = {
      ...initialPublicView,
      operation: {
        id: ongoingOp.id,
        kind: "replacePublicPlaylist",
        status: ongoingOp.status,
        step: ongoingOp.step,
        errorCode: ongoingOp.errorCode,
        version: ongoingOp.version
      }
    };

    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: viewWithOp }));
    await page.route(`**/api/rooms/${roomId}/public-playlist/random-replacement/${ongoingOp.id}`, route =>
      route.fulfill({ json: ongoingOp })
    );
    await page.route(`**/api/rooms/${roomId}/personal-playlist`, route =>
      route.fulfill({
        json: {
          playlist: null,
          snapshot: null,
          lastRefreshError: null,
          allowedActions: ["createPersonalPlaylist"],
          disabledReason: null,
          version: 1
        }
      })
    );

    await page.goto(`/rooms/${roomId}`);

    // 页面初次载入即可见恢复的操作状态
    const statusBanner = page.locator(".replacement-status-banner");
    await expect(statusBanner).toBeVisible();
    await expect(statusBanner).toContainText("正在添加新歌曲到公共歌单（已添加 4 / 10 首）…");

    // 切换到「我的歌单」
    await page.getByRole("button", { name: "我的歌单" }).click();
    await expect(statusBanner).not.toBeVisible();

    // 切回「公共歌单」
    await page.getByRole("button", { name: "公共歌单" }).click();
    await expect(statusBanner).toBeVisible();
    await expect(statusBanner).toContainText("正在添加新歌曲到公共歌单（已添加 4 / 10 首）…");

    // 刷新页面
    await page.reload();
    await expect(page.locator(".replacement-status-banner")).toBeVisible();
    await expect(page.locator(".replacement-status-banner")).toContainText(
      "正在添加新歌曲到公共歌单（已添加 4 / 10 首）…"
    );
  });

  test("预览失效保护：公共歌单或成员来源变更时要求重新预览", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));
    await page.route(randomReplacementEndpoint, route =>
      route.fulfill({
        status: 409,
        json: { error: { code: "PREVIEW_INVALIDATED", message: "公共歌单配置已变更，请重新预览" } }
      })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    await page.getByRole("button", { name: "确认替换" }).click();

    await expect(modal.locator(".error-banner")).toContainText(
      "公共歌单或成员来源已变更，当前预览已失效，请重新生成预览。"
    );
  });

  test("网络错误重试时复用相同幂等键，避免重复创建操作", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));

    const capturedKeys: string[] = [];
    const operationId = v7();
    let attempt = 0;
    await page.route(randomReplacementEndpoint, async route => {
      const body = route.request().postDataJSON() as { idempotencyKey: string; previewId: string };
      capturedKeys.push(body.idempotencyKey);
      attempt++;
      if (attempt === 1) {
        await route.fulfill({
          status: 500,
          json: { error: { code: "NETWORK_ERROR", message: "网络连接失败" } }
        });
      } else {
        await route.fulfill({
          json: {
            replay: true,
            operation: {
              id: operationId,
              roomId,
              status: "queued",
              step: "ready",
              targetCount: 10,
              targetSongIds: mockPreview10.tracks.map(t => t.songId),
              addedSongIds: [],
              removedSongIds: [],
              tagConfirmed: false,
              currentAction: null,
              currentSongId: null,
              errorCode: null,
              version: 1
            }
          }
        });
      }
    });

    await page.route(`**/api/rooms/${roomId}/public-playlist/random-replacement/${operationId}`, route =>
      route.fulfill({
        json: {
          id: operationId,
          roomId,
          status: "queued",
          step: "ready",
          targetCount: 10,
          targetSongIds: mockPreview10.tracks.map(t => t.songId),
          addedSongIds: [],
          removedSongIds: [],
          tagConfirmed: false,
          currentAction: null,
          currentSongId: null,
          errorCode: null,
          version: 1
        }
      })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    // 第一次提交（网络失败）
    await modal.getByRole("button", { name: "确认替换" }).click();
    await expect(modal.locator(".error-banner")).toContainText("网络连接失败，请稍后重试。");

    // 第二次点击确认替换，验证幂等键保持一致
    await modal.getByRole("button", { name: "确认替换" }).click();
    await expect(modal).not.toBeVisible();

    expect(capturedKeys).toHaveLength(2);
    expect(capturedKeys[0]).toBe(capturedKeys[1]);
  });

  test("已配置来源读取失败整次不换，并给出温和重试提示", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route =>
      route.fulfill({
        status: 502,
        json: { error: { code: "MODULE_ERROR", message: "网易云服务响应异常" } }
      })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    await expect(modal.locator(".error-banner")).toContainText("网易云服务响应异常，请稍后重试。");
  });

  test("并发写冲突防御：歌单正在执行写操作或用户有未完成写操作时展示友好提示", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));
    await page.route(randomReplacementEndpoint, route =>
      route.fulfill({
        status: 409,
        json: { error: { code: "PLAYLIST_CONFLICT", message: "歌单冲突" } }
      })
    );

    await page.goto(`/rooms/${roomId}`);
    await page.getByRole("button", { name: "随机换一组" }).click();

    const modal = page.locator(".random-replacement-modal");
    await page.getByRole("button", { name: "确认替换" }).click();

    await expect(modal.locator(".error-banner")).toContainText(
      "当前公共歌单正在执行其他写入操作，请稍候再试。"
    );
  });

  test("多视口响应式与 Axe 无障碍扫描", async ({ page }) => {
    await setupRoom(page, true);
    await page.route(publicPlaylistEndpoint, route => route.fulfill({ json: initialPublicView }));
    await page.route(randomPreviewEndpoint, route => route.fulfill({ json: mockPreview10 }));

    for (const viewport of [
      { width: 320, height: 600 },
      { width: 390, height: 844 },
      { width: 1440, height: 900 }
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/rooms/${roomId}`);

      // 验证页面无横向滚动条
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

      // 打开弹窗验证弹窗内无障碍与无横向滚动条
      await page.getByRole("button", { name: "随机换一组" }).click();
      const modal = page.locator(".random-replacement-modal");
      await expect(modal).toBeVisible();

      const modalScrollWidth = await modal.evaluate(el => el.scrollWidth);
      const modalClientWidth = await modal.evaluate(el => el.clientWidth);
      expect(modalScrollWidth).toBeLessThanOrEqual(modalClientWidth + 1);

      const axeResults = await new AxeBuilder({ page })
        .include(".random-replacement-modal")
        .analyze();
      expect(axeResults.violations).toEqual([]);

      await modal.getByRole("button", { name: "取消" }).click();
      await expect(modal).not.toBeVisible();
    }
  });
});
