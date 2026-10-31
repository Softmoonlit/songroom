# 02 - 修复我的歌单同步接口 POST 调用、补齐反馈 Toast 并统一文案

**Status:** ready-for-agent
**Blocked by:** none

## What it delivers

解决我的歌单页面点击「同步歌单」时由于缺少请求体导致的客户端向服务器发出 GET 请求并收到 404 静默失败的问题；恢复同步中的旋转动画与 Toast 交互反馈；将操作按钮与无障碍文案从「手动刷新」统一为「同步歌单」。

## Acceptance criteria

- [ ] `PersonalPlaylistPane` 中的 `refreshMutation` 底层调用显式传递空对象 `{}`，确保向后端发送标准的 `POST /api/rooms/:roomId/personal-playlist/refresh`
- [ ] 同步过程中按钮处于 disabled 状态，图标持续旋转，文案显示「正在同步…」
- [ ] 同步成功后，歌曲列表更新，且屏幕右下角弹出 Toast 成功提示「歌单已同步」
- [ ] 同步失败时（如网络超时或凭据失效），弹出 Toast 错误提示具体原因，不出现静默失败
- [ ] 操作按钮名称与 `aria-label` 统一为「同步歌单」，与点歌台公共歌单心智和文案保持完全一致

## Comments

### Notes
- 核心修改位于 `apps/songroom/src/client/PersonalPlaylistPane.tsx`
- 确保 `request` 调用携带正确的方法/请求体
