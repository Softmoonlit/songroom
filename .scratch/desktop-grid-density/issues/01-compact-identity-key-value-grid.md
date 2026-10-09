# 01: 全站账号与成员身份键值框双列紧凑栅格重构

**What to build:** 优化全站通用的网易云账号及房间成员身份展示键值框 (`.netease-identity`)，将其从单列纵向堆叠重塑为双列并排的紧凑 Key-Value 网格（昵称在左 50%，账号 ID 或角色标签在右 50%）。消除在桌面端大宽度卡片内文本过短、下方与右侧大面积灰色背景留白的问题，同时将视觉纵向高度缩减约 50%，在账号设置页、扫码流程与成员详情页中提供一致、饱满的信息呈现。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `.netease-identity` 默认样式采用 2 列网格布局 (`repeat(2, minmax(0, 1fr))`)，键名与数值保持清晰可读；
- [x] 账号设置页 (`/account`) 的网易云已授权卡片和扫码确认流程中，网易云昵称与账号 ID 呈左右对称双列呈现；
- [x] 房间工作区 (`/rooms/:roomId`) 成员详情面板中，成员昵称与角色呈左右对称双列呈现；
- [x] 在小屏（`<= 560px`）或极窄容器中，键值网格能安全自适应或平滑折叠，无文字溢出或截断；
- [x] 现有测试（含无障碍与页面查询）全部绿灯。

## Comments

### 实现与验证
1. **双列紧凑 Key-Value 栅格重构**：
   - 在 `styles.css` 中将 `.netease-identity` 默认网格列宽设定为 `grid-template-columns: repeat(2, minmax(0, 1fr))`，文本行距与边距紧凑微调至 `padding: 12px 14px`。
   - 统一加强 `<dd>` 数据文本视觉层级（`font-weight: 600`，`color: var(--text-main)`），保持键名（`<dt>`）与数据值清晰对应。
   - 响应式处理：在 `@media (max-width: 560px)` 下平滑折叠为单列（`grid-template-columns: 1fr`），防止超小屏横向文字拥挤。
2. **测试与回归**：
   - 运行 `pnpm typecheck` 通过。
   - 运行 `pnpm --filter @songroom/app vitest run src/client/`（6 测试文件，24 测试用例全部通过）。
   - 运行相关 Playwright E2E（`room-creation-settings-and-platform-abstraction.spec.ts` 5 个用例全部通过，含 Axe-core 无障碍合规扫描；`member-identity.spec.ts` 16 个用例全部通过）。
3. **剩余事项**：
   - 无，工单顺利交付，解除了工单 02 与工单 03 的前置阻塞。
