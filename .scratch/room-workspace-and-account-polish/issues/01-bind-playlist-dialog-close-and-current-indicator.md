# 01 - 修复更换歌单弹窗关闭按钮尺寸并支持高亮展示当前绑定歌单

**Status:** resolved
**Blocked by:** none

## What it delivers

更换/绑定个人歌单弹窗右上角的关闭按钮恢复为规范的 32px × 32px 方形图标按钮，悬浮与点击状态正常；向弹窗传入当前房间已绑定的歌单 ID，在候选歌单列表项中显示「当前绑定」中性标签，并且打开弹窗时默认高亮选中当前歌单。

## Acceptance criteria

- [x] 弹窗右上角关闭按钮样式规范为标准方形图标（`32px × 32px`），具备与全站一致的 hover/focus 状态，不再被伸展拉长
- [x] `BindPersonalPlaylistDialog` 组件支持接收 `currentPlaylistId` 属性
- [x] 打开更换歌单弹窗时，如果存在 `currentPlaylistId`，候选列表中匹配该 ID 的项右侧展示「当前绑定」胶囊标签，且默认处于选中状态
- [x] 用户可以直观看到当前绑定的歌单，也可以点击其他候选歌单进行改选并提交更换
- [x] 界面交互符合无障碍规范，测试覆盖弹窗的展示与选中行为

## Comments

### 实现与验收记录
1. **弹窗头部结构与关闭按钮**：
   - 将 `BindPersonalPlaylistDialog.tsx` 弹窗头部重构为标准的 `invite-modal-header`，关闭按钮使用 `.dialog-close-btn`，固定为 `32px × 32px` 标准方形图标并增加 hover 背景过渡；
2. **当前绑定歌单标记与默认选中**：
   - `BindPersonalPlaylistDialogProps` 增加 `currentPlaylistId?: string | null` 属性；
   - 在弹窗打开且存在 `currentPlaylistId` 时，`selectedId` 默认初始化为 `currentPlaylistId`；
   - 候选歌单列表项的标题行在匹配当前 ID 时展示 `.current-bound-pill`（「当前绑定」）标签；
3. **验证结果**：
   - `PersonalPlaylistPane` 完整向弹窗传递 `playlist?.id`；
   - TypeScript 类型检查通过，`tests/e2e/member-self-bound-playlists.spec.ts` 端到端与无障碍扫描全部通过。
