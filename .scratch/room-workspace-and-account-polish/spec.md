# 房间工作区与账号体验细节打磨规范

Status: ready-for-agent

## Problem Statement

在 ADR 0006「成员自主绑定个人歌单」功能上线后，通过真实设备与生产环境体验，发现了若干破坏用户心智统一性、引起操作误解及视觉混淆的细节缺陷：
1. **更换个人歌单弹窗关闭按钮异形且缺乏当前状态感知**：关闭按钮 `X` 缺少独立尺寸样式约束被拉长变形；同时弹窗未标识当前房间正在使用的歌单，打开时默认选空，用户无法获知现状与对比。
2. **我的歌单同步逻辑静默失败且文案割裂**：底层调用缺少请求体导致触发了 GET 404 静默失败，用户点击后不转圈且无反馈；同时点歌台文案为「同步歌单」，我的歌单文案为「手动刷新」，概念割裂。
3. **房间成员角色标签与自身视角色彩混淆**：「房主」使用了蓝色品牌色，「室友」使用了灰白底色，造成角色层级不平等的观感；而「（我）」也使用了蓝色文字，导致蓝色既代表自身视角又代表房主角色，认知混乱。
4. **账号设置页登出入口冗余且产生误导**：页面底部的「退出当前设备」容易给用户造成“存在多端会话管理能力”的误解，且与全站右上角头像菜单中已有的「退出登录」功能完全重复。

## Solution

1. **更换个人歌单弹窗优化**：
   - 修复 `.dialog-close-btn` 样式为标准 `32px × 32px` 圆角方形图标按钮，配合标准悬浮态；
   - 弹窗接收当前房间已绑定的 `currentPlaylistId`；在候选列表项中为当前绑定的歌单高亮标注「当前绑定」中性胶囊标签，并在打开时默认高亮选中该项。
2. **我的歌单同步逻辑与文案统一**：
   - 将 `PersonalPlaylistPane` 中的 `refreshMutation` 请求体明确传入 `{}`，向后端发起标准 `POST /api/rooms/:roomId/personal-playlist/refresh`；
   - 增加 `onError` 异常处理与成功后的 `setToast` 提示；
   - 将按钮文案统一为「同步歌单」（Pending 态为「正在同步…」），同步完成后弹出 Toast 提示「歌单已同步」，与点歌台公共歌单完全对齐。
3. **房间成员角色色彩重构**：
   - 房主与室友角色作为客观身份属性，在卡片左侧统一采用同等层级的中性背景胶囊（`.status-pill.role-owner` 与 `.status-pill.role-roommate` 采用相同的灰白/深灰底色与文字层级）；
   - 品牌蓝色专属赋予「（我）」标记（`.member-self-tag`），彻底解耦身份属性与自身主观视角。
4. **账号设置页登出入口清理**：
   - 直接移除账号设置页底部的「退出当前设备」区块及相关样式；
   - 全站账号登出入口严格收敛于右上角用户头像下拉菜单的「退出登录」。

## User Stories

1. 作为房间成员，当我在「我的歌单」中点击「更换歌单」唤起弹窗时，我希望弹窗右上角的关闭按钮是整洁规整的圆形/方形图标，而不是被错误拉长的长条按钮，以便获得一致的视觉体验。
2. 作为房间成员，在更换个人歌单弹窗中，我希望在候选列表中清晰看到当前房间正在使用的歌单旁边打着「当前绑定」标签，并且该歌单默认处于选中状态，以便我清楚知道当前生效的是哪一份歌单。
3. 作为房间成员，在更换个人歌单弹窗中，当我不想更换时，我希望可以直观看到当前绑定状态并直接点击取消或右上角关闭按钮退出。
4. 作为房间成员，当我在网易云官方客户端更新了自己的个人歌单后，回到 SongRoom「我的歌单」页面，我希望操作按钮文案明确叫「同步歌单」，与点歌台的文案和心智保持一致。
5. 作为房间成员，在「我的歌单」点击「同步歌单」按钮时，我希望图标持续平滑旋转并显示「正在同步…」，以便我明确获知系统正在向网易云拉取最新曲目快照。
6. 作为房间成员，当「同步歌单」顺利完成后，我希望页面不仅更新歌曲列表，而且在右下角弹出「歌单已同步」的成功提示，以便获得明确的正向反馈。
7. 作为房间成员，当「同步歌单」因网络异常或网易云接口超时失败时，我希望页面弹出包含明确错误原因的 Toast，而不是毫无动静地静默失败。
8. 作为普通室友，在查看「房间成员」列表时，我希望「房主」与「室友」的角色胶囊具备统一的视觉底色与排版规范，不产生“室友被降级”或“主次不分”的压迫感。
9. 作为房间成员，在「房间成员」列表中，我希望「（我）」标记独占鲜明的蓝色高亮，而其他角色标签不借用这个蓝色，以便我一眼就能迅速定位到自己的卡片。
10. 作为登录用户，在访问全局「账号设置」页面时，我希望页面专注展示修改密码、网易云账号授权以及孤立歌单清理等核心功能，不出现容易误导为多端管理的「退出当前设备」冗余按钮。
11. 作为登录用户，当我想退出登录时，在任意页面的右上角点击我的头像唤起下拉菜单，点击「退出登录」即可安全退出系统。

## Implementation Decisions

- **组件接口与状态**：
  - `BindPersonalPlaylistDialog` 增加 `currentPlaylistId?: string | null` 属性；
  - `BindPersonalPlaylistDialog` 在打开且存在 `currentPlaylistId` 时，将 `selectedId` 默认初始化为 `currentPlaylistId`；
  - 候选列表项中判断 `candidate.id === currentPlaylistId`，如果匹配则在右侧渲染 `<span className="current-bound-pill">当前绑定</span>`。
- **CSS 规范与视觉对齐**：
  - 新增 `.dialog-close-btn` 样式，与现有 `.invite-modal-close` 保持一致（`width: 32px; height: 32px; border-radius: var(--radius-md); display: inline-flex; align-items: center; justify-content: center`）；
  - 调整 `.status-pill.role-owner` 与 `.status-pill.role-roommate`，两者共用中性背景 `var(--bg-subtle)`、边框 `var(--border-subtle)` 与文字颜色 `var(--text-muted)`，字体粗细保持一致；
  - `.member-self-tag` 保持 `color: var(--primary); font-weight: 600`。
  - 删除 `.account-logout` 与账号设置页内的登出按钮相关样式。
- **数据流与异步调用**：
  - `PersonalPlaylistPane` 中的 `refreshMutation.mutationFn` 调用 `request(..., {}, undefined, "POST")` 或传入非空对象作为参数，确保发起的是 `POST`；
  - 注册 `onSuccess` 触发 `setToast({ id: uuidv7(), message: "歌单已同步", type: "success" })`；
  - 注册 `onError` 触发 `setToast({ id: uuidv7(), message: errorMessage(failure), type: "error" })`；
  - 按钮文案与 `aria-label` 从「手动刷新」改为「同步歌单」。
- **页面收口**：
  - 在 `App.tsx` 的 `AccountSettings` 组件中移除底部的 `div.account-logout` 区块。

## Testing Decisions

- **测试接缝**：
  - 单元与集成测试：校验 `PersonalPlaylistPane` 与 `BindPersonalPlaylistDialog` 的状态与属性流转；
  - Playwright E2E 测试：在真实浏览器中验证弹窗关闭按钮尺寸与交互、当前绑定标签展示、同步歌单 POST 调用及 Toast 弹出、成员卡片角色与高亮颜色、账号设置页不含退出按钮。
- **回归保证**：全量执行现有 574 个单元/集成测试与 192 个 Playwright E2E 测试，保证零回归。

## Out of Scope

- 多设备会话管理或主动踢出其他设备的功能开发；
- 个人歌单在线直接加歌/删歌功能（维持只读与网易云客户端增删规则）；
- 增加额外的个人歌单解绑接口。
