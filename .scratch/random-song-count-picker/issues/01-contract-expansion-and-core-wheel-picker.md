# 01: 契约放宽与滚轮选择器核心贯通

**What to build:** 允许房主在随机点歌弹窗中选择 10 到 50 首之间的任意正整数（默认 20 首），并顺利生成预览和确认换歌。从前后端契约校验、服务端领域抽选、到界面上将原有的 5/10/15/20 单选按钮替换为垂直滚动的滚轮列表（基于 CSS scroll-snap），打通整条垂直链路。既有测试中使用硬编码 5 或 10 首的用例同步迁移，确保 API 和集成测试全绿。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `randomReplacementPreviewCommand` 契约将 `count` 字段校验调整为 `z.number().int().min(10).max(50).default(20)`，低于 10、高于 50 或非整数时返回 400 校验错误，缺省时默认为 20。
- [x] 服务端 `StoredRandomPreview` 的 `targetCount` 调整为 `number`，兼容 10~50 的任意整数，并保持与公平抽选算法（均分、余数随机、去重、打散）正确联动。
- [x] `RandomReplacementDialog` 移除原有 `COUNT_OPTIONS = [5, 10, 15, 20]` 按钮组，默认首数设为 20，接入包含 10 到 50 个连续整数条目的垂直滚轮容器（启用 CSS `scroll-snap-type: y mandatory`）。
- [x] 弹窗重新打开时，首数选择器重置为默认 20 首，所选成员集合保持全不选。
- [x] 选中成员并选择非 5 倍数（如 23 首）或任意合法首数后，点击“生成预览”能成功返回对应数量（或候选不足时的全部候选）的歌曲预览，并能正常提交确认替换公共歌单。
- [x] 迁移并更新既有 HTTP API 测试和抽选单元/集成测试中受影响的硬编码首数断言，测试全部通过。

## Comments

### 实现与验证记录
1. **契约与服务端**：
   - 更新 `apps/songroom/src/shared/public-playlist-contracts.ts`，`randomReplacementPreviewCommand.count` 调整为 `z.number().int().min(10).max(50).default(20)`。
   - 更新 `apps/songroom/src/operations/public-random-preview.ts` 和 `random-selector.ts` 中 `targetCount` 类型为 `number`。
2. **客户端与滚轮组件**：
   - 新增 `apps/songroom/src/client/WheelPicker.tsx`，实现 10~50 的垂直滚轮桶，支持 CSS scroll-snap 吸附对齐、中心指示与无障碍 spinbutton。
   - 更新 `apps/songroom/src/client/RandomReplacementDialog.tsx`，清理旧的 4 档按钮组，默认首数设为 20，关窗后稳定复位。
   - 在 `apps/songroom/src/client/styles.css` 中补齐滚轮选择器布局、渐隐蒙层及焦点样式。
3. **测试验证**：
   - HTTP 接口测试：覆盖合法首数（23、缺省默认 20）以及非法首数（7、9、51、23.5）的拒绝响应，全部通过。
   - E2E 验证：`tests/e2e/random-replacement.spec.ts` 17 项端到端用例全部绿灯通过（含多视口与 Axe 无障碍合规）。
   - 类型检查：`pnpm typecheck` 零错误。
