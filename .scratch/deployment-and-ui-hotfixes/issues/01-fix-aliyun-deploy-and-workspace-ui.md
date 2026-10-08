# 01: 生产部署依赖同步与房间工作台体验缺陷修复

**What to build:** 
1. 修复全局 CSS `[hidden]` 强制隐藏规则，杜绝 `.room-settings-pane` 穿透至公共歌单与房间成员底部；
2. 移除房间设置中 GitHub 风格的“危险区域”标题与警示长句，重塑为“解散房间”或“退出房间”的平实生活化布局；
3. 纠正房间成员“审批申请”按钮的样式类名（修复为 `secondary-button applications-trigger-btn`）并补充 CSS 规则，调整无待审批时的文案为“申请记录”；
4. 优化公共歌单只读刷新异常提示文案，隔离写操作专用状态指引；
5. 纠正 `docs/operations.md` 中本地构建同步方案的依赖路径与符号链接重建命令。

**Blocked by:** none

**Status:** resolved

- [x] 全局 CSS 补充 `[hidden] { display: none !important; }`，修复房间设置穿透泄漏；
- [x] 房间设置移除“危险区域”大标题及冗余警示语，改用生活化卡片分区；
- [x] 房间成员页审批按钮样式规范化并优化文案；
- [x] 公共歌单只读静默刷新错误文案解耦；
- [x] 运维文档同步发布方案路径与软链接修正；
- [x] 全量测试通过并同步生产验证。

## Comments

### 立项分析
针对用户反馈的阿里云部署网易云模块异常、Tab 穿透泄漏房间设置、“危险区域”生硬文案以及成员页审批申请按钮样式逻辑异常等 4 项问题完成全面技术溯源，确立闭环修复方案。

### 实现与线上验证结果
1. **显隐穿透与布局修复**：
   - 在 `styles.css` 根部加入 `[hidden] { display: none !important; }`，彻底根除了 Class 优先级覆盖导致的 Tab 底部穿透泄露问题；
   - 验证：在公共歌单和房间成员标签页下，房间设置区域均已严格不可见。
2. **房间设置文案重塑**：
   - 在 `RoomWorkspace.tsx` 移除了极客平台风格的“危险区域”大标题及冗余常识长句，根据角色自然收敛为“解散房间”与“退出房间”，保留优雅红框隔离及二次确认弹窗防误触保护。
3. **成员页审批入口修复**：
   - 纠正类名为 `secondary-button applications-trigger-btn`，补充胶囊边框、内边距与对齐样式；
   - 无待处理申请时文案明确显示为“申请记录”，保留 `aria-label="审批加入申请"` 保持无障碍与 E2E 测试兼容。
4. **只读静默刷新错误文案解耦**：
   - 在 `PublicPlaylistPane.tsx` 建立专用只读刷新文案映射，针对 `MODULE_ERROR` 提示“网易云服务暂时响应异常，请稍后刷新重试”，不再向只读用户展示写操作专用的“请查看操作的确认状态”。
5. **部署脚本与生产环境修复**：
   - 纠正 `docs/operations.md` 方案 A 中的依赖硬链接路径为 `packages/vendor/netease-cloud-music-api-enhanced/node_modules`，并在同步后显式重建 `dist/netease/vendor/node_modules` 符号链接；
   - 同步更新部署至阿里云生产环境，验证健康检查返回 `200`，子进程加载网易云 request 模块通过，线上服务状态正常。
6. **自动化回归测试**：
   - `pnpm typecheck` 检查通过；
   - 全量 Vitest 单元测试通过；
   - 相关 Playwright E2E 测试（含响应式视口、Axe-core 无障碍扫描与交互流程）全部绿灯通过。
