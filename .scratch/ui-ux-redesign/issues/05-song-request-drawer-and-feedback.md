# 05: 独立点歌面板抽屉与交互正反馈

**What to build:** 移除常驻在歌单正上方容易误解为“歌单内过滤”的直接搜索框，在操作栏提供显眼的「+ 点歌」入口，点击后呼出专用的网易云全网点歌抽屉/面板。抽屉内集成单曲关键词搜索、候选列表浏览、单曲点入本房间操作；点歌提交伴随加载动效，成功后弹出 Toast 提示并自动收起面板，在公共歌单中平滑高亮新入单歌曲；遇到限流或排队时提供温和情感化提示，彻底消除心智模型混淆与冷冰冰的报错体验。

**Blocked by:** 04: 公共歌单与歌曲列表体验重构（全屏聚焦与信息降噪）

**Status:** resolved

- [x] 歌单上方移除常驻搜索框，改为右上角醒目的「+ 点歌」主操作按钮；
- [x] 构建专用的全网点歌抽屉/面板，提供独立的搜索输入与候选单曲列表；
- [x] 点歌按钮具备微加载指示，提交成功后弹出轻量 Toast 提示；
- [x] 点歌成功后自动收起抽屉，并在公共歌单列表中平滑高亮展示新入单歌曲；
- [x] 遇到风控、限流或排队时提供人性化温和提示，替代冷冰冰的系统错误代码；
- [x] 歌单列表表头为未来本地过滤搜索预留清晰的空间边界；
- [x] 基础单元测试与编译检查通过。

## Comments

### 规划与立项
经 Grilling 与 to-tickets 批准确立，彻底解耦全网点歌与歌单内检索，提升点歌即时正反馈。

### 实现提交与双轴审查收口
1. **实现提交 (`b39a722`)**:
   - 移除常驻歌单上方的直接搜索框，在 `playlist-header-right` 和空歌单卡片中提供显眼的「+ 点歌」主操作按钮；
   - 构建专用 `SongRequestDrawer` 抽屉面板，集成独立单曲搜索、网易云全网候选单曲列表、键盘选歌与提交；
   - 点歌提交具备微加载动画（`RotateCw` 旋转指示器），点歌成功后自动弹出轻量高信噪比 `Toast` 提示并收起抽屉；
   - 歌曲列表中新入单歌曲呈现平滑脉冲高亮（`track-item-highlighted`），并平滑滚动聚焦至新歌曲；
   - 新增 `song-request-messages.ts`，遇到风控（`RATE_LIMITED` / `ACCOUNT_PAUSED`）、队列满（`UPSTREAM_QUEUE_FULL`）、写入冲突锁定（`TARGET_BLOCKED`）与网络延迟时展示温和情感化提示，替代冷冰冰的底层错误码；
   - 歌单表头（`playlist-tracks-header-bar`）提供清晰的列标题边界（#、歌曲与歌手、点歌人），为未来歌单内过滤搜索预留清晰空间边界；
   - 编写 `song-request-messages.test.ts` 单元测试与更新 `song-search-and-request.spec.ts` 端到端交互测试（覆盖 320px、900px、1440px 视口无溢出与全流程）。
2. **双轴审查收口 (`9d9f1a3`)**:
   - 修复 Standards 审查：移除了 `SongRequestDrawer` 中使用 `setTimeout` 规避聚焦竞态的 hack，改为挂载确切聚焦；清理了 `playlist-filter-slot` 这一推测性抽象的占位符；提取 `openSongRequestDrawer` 与 `handleSongRequestSucceeded` 消除代码重复；
   - 修复 Spec 审查：修复了 `awaitingConfirmation` 状态下清空 `activeOperationId` 导致后续终态成功 Toast 丢失的隐患，保留轮询至 `succeeded` 终态；将 `getFriendlyOperationStatusMessage` 连接到真实生产代码，为 `queued` 与 `processing` 异步排队阶段提供温和进度反馈；增强了搜索与状态查询网络错误捕获提示。

### 验证结果
- **类型检查**: `pnpm --filter @songroom/app typecheck`（tsc 全项目通过，零错误）。
- **单元测试**: `pnpm --filter @songroom/app test`（38 个测试文件、373 项测试全部通过，包括新增的 `song-request-messages.test.ts`）。
- **E2E 测试**: `pnpm --filter @songroom/app test:e2e`（133 项 Playwright 测试全量通过，涵盖 320px/900px/1440px 响应式无横向滚动溢出、抽屉开合、点歌微加载、Toast 提示、平滑高亮以及排队风控温和提示）。
- **剩余事项**: 无。
