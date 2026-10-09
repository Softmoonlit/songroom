# 02: 创建房间页 2 列栅格体系重构

**What to build:** 在创建房间页面 (`RoomCreatePage`) 内部全面重构为严密的 2 列栅格布局。将选择房间播放源卡片列表重构为 2 列等宽选择磁贴（网易云已授权卡片在左 50%，QQ 音乐即将支持占位卡片在右 50%），保持卡片等高拉伸与严整对称，保留左侧 Radio 控件可访问性；将下方的“房间名称”与“我的房间昵称”输入字段在桌面端并排为 2 列网格；底部保留稳固的全宽主按钮。彻底消除 1080p 宽屏下右侧大面积空旷与字段上下过度拉扯的问题；在 `<= 700px` 小屏下自适应折叠为单列。

**Blocked by:** 01: 全站账号与成员身份键值框双列紧凑栅格重构

**Status:** resolved

- [x] `.playback-source-list` 采用 2 列等宽网格布局，网易云卡片与 QQ 音乐占位卡片左右并排平铺；
- [x] 播放源卡片通过 `align-items: stretch` 保持严格等高，占位平台的提示信息自然居中对齐；
- [x] 网易云卡片内部嵌套的 `.netease-identity` 与卡片宽度协调，账号详情紧凑呈现；
- [x] 房间基础信息表单新增双列栅格包裹，在宽屏下“房间名称”占左半边、“我的房间昵称”占右半边；
- [x] 底部主操作按钮（“创建并进入房间”）维持全宽稳固呈现；
- [x] 严格遵循全站 `@media (max-width: 700px)` 断点，小屏下磁贴与输入字段平滑降级为单列纵向排列；
- [x] 保持无账号绑定时的全宽警示引导与收口阻断逻辑不变；
- [x] 现有建房相关的端到端与单元测试全部通过。

## Comments

### 实现与验证
1. **播放源平台双列磁贴**：
   - 将 `.playback-source-list` 从单列 flex 升级为 `display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;`。
   - 磁贴卡片增加 `height: 100%` 与 `box-sizing: border-box`，确保网易云卡片与 QQ 音乐占位卡片严格等高，且占位文案微调行高和边距，视觉自然平衡。
2. **房间基础信息双列栅格**：
   - 在 `RoomCreatePage.tsx` 中使用 `<div className="room-create-fields">` 包裹“房间名称”与“我的房间昵称”输入字段。
   - 在 `styles.css` 中定义 `.room-create-fields` 为 2 列网格（`gap: 16px`），与上方平台磁贴网格形成垂直严格对齐的 2-Column 网格节奏。
3. **响应式断点控制**：
   - 统一对齐 `@media (max-width: 700px)`，在 `<= 700px` 时平台磁贴和输入字段均平滑降级为单列（`1fr`）。
4. **测试与回归**：
   - 运行 `pnpm typecheck` 零报错通过。
   - 运行相关 Playwright E2E（`room-creation-settings-and-platform-abstraction.spec.ts` 5 个用例全绿；`rooms.spec.ts` 15 个用例全绿）。
5. **剩余事项**：
   - 无，工单顺利交付。
