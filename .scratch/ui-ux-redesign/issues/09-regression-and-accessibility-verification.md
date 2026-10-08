# 09: 全站功能与无障碍回归验证

**What to build:** 针对 UI/UX 重构后的全站代码执行全量回归验证，包括 TypeScript 类型检查、Vitest 单元/集成测试、Playwright 端到端浏览器测试（E2E）以及 axe-core 自动化无障碍扫描。同步微调与最新 DOM 契约对应的 E2E 测试选择器与断言，确保全站功能逻辑、API 契约、状态失效、响应式布局与无障碍访问 100% 绿色通过，确保重构不产生任何功能退化或视觉割裂。

**Blocked by:** 01: 全局设计系统规范与 Shell 导航/基础文案降噪, 02: 房间工作台双栏居中布局与移动端导航, 03: 全站破坏性确认弹窗高信噪比重构, 04: 公共歌单与歌曲列表体验重构（全屏聚焦与信息降噪）, 05: 独立点歌面板抽屉与交互正反馈, 06: 房间列表双轨引导与未登录首页系统级降噪, 07: 房间成员列表重构与审批/邀请体验收敛, 08: 房间创建与设置模块化及多平台授权抽象

**Status:** resolved

- [x] `pnpm typecheck`：通过 TypeScript 类型安全检查；
- [x] `pnpm test`：全部 Vitest 单元与集成测试 100% 通过；
- [x] `pnpm test:e2e`：全部 Playwright 端到端测试用例 100% 绿色通过；
- [x] 自动化 axe-core 无障碍扫描测试 100% 通过，符合 WCAG 2.1 AA 标准；
- [x] 确保全站响应式在桌面与移动端无水平溢出、布局错位或视觉退化。

## Comments

### 规划与立项
经 Grilling 与 to-tickets 批准确立，作为全站重构的最终交付验收与质量关卡。

### 实现与回归验收
- 自动化测试与契约对齐：
  - 适配重构后组件的交互形态：邀请弹窗（`InviteDialog`）从旧底栏固定卡片升级为弹出式 Dialog；审批抽屉（`ApplicationsDrawer`）适配全生命周期遮罩与关闭交互；房间创建去除冗余复选框后保持快速建房流程。
  - 增强状态变化无障碍可达性：复制邀请链接/邀请码成功增加 `role="status"` 实时反馈与稳定 `aria-label`；审批成功/拒绝增加带 `role="status"` 的结果反馈留存卡片；申请进度页统一状态标签 `role="status"`；移除输入框不当 HTML `maxLength` 限制以确保 Zod 语义校验提示正常触发。
  - 修复审批拒绝原因文案与全局错误词典对齐（`NICKNAME_TAKEN` / `ROOM_MEMBER_LIMIT` 等）。
- 验证结果：
  - `pnpm typecheck`：通过，0 errors。
  - `pnpm test`：42 个测试套件，386 个单元与集成测试用例 100% 通过。
  - `pnpm test:e2e`：全部 142 个 Playwright 端到端用例 100% 通过，涵盖 320px/900px/1440px 视口无溢出、无障碍 axe-core 扫描、破坏性弹窗与多端 SSE 失效联动。
- 实现提交：
  - `f452245` test(ui): 完成全站回归与无障碍可访问性适配确保全量测试绿灯
  - `36344dc` fix(ui): 响应双轴审查复用统一错误文案、收敛状态派发并补充无障碍扫描

### 双轴代码审查（Standards 与 Spec）
- **Standards 轴**：
  - 审查发现：审批禁用原因存在硬编码文案与重复 switch 逻辑（违反第 2 条最简实现与 baseline 坏味道 Repeated Switches）。
  - 响应修复：审批禁用原因直接复用 `room-http.ts` 的 `errorMessageForCode`；将状态徽章文案收敛入 `application-timeline.ts` 的 `ApplicationTimelineView.badgeLabel` 单一派发源，彻底移除 `ApplicationPage.tsx` 中重复定义的 `statusLabels` 字典映射。
- **Spec 轴**：
  - 审查发现：无障碍扫描需要覆盖重构新增与改动的公开页面（如查验邀请函 `/join`）。
  - 响应修复：在 `security-a11y-matrix.spec.ts` 中补充 `/join` 邀请函页的 AxeBuilder 自动化扫描，确认 0 violations。
- **剩余事项**：无。本 ticket 验收项 100% 达成，UI/UX 重构全部 9 个 tickets 全部圆满完成。
