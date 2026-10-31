# 02 - 修复我的歌单同步接口 POST 调用、补齐反馈 Toast 并统一文案

**Status:** resolved
**Blocked by:** none

## What it delivers

解决我的歌单页面点击「同步歌单」时由于缺少请求体导致的客户端向服务器发出 GET 请求并收到 404 静默失败的问题；恢复同步中的旋转动画与 Toast 交互反馈；将操作按钮与无障碍文案从「手动刷新」统一为「同步歌单」。

## Acceptance criteria

- [x] `PersonalPlaylistPane` 中的 `refreshMutation` 底层调用显式传递空对象 `{}`，确保向后端发送标准的 `POST /api/rooms/:roomId/personal-playlist/refresh`
- [x] 同步过程中按钮处于 disabled 状态，图标持续旋转，文案显示「正在同步…」
- [x] 同步成功后，歌曲列表更新，且屏幕右下角弹出 Toast 成功提示「歌单已同步」
- [x] 同步失败时（如网络超时或凭据失效），弹出 Toast 错误提示具体原因，不出现静默失败
- [x] 操作按钮名称与 `aria-label` 统一为「同步歌单」，与点歌台公共歌单心智和文案保持完全一致

## Comments

### 实现与验收记录
1. **POST 请求与错误处理修复**：
   - 在 `PersonalPlaylistPane.tsx` 的 `refreshMutation.mutationFn` 中显式传递请求体 `{}`，向后端正确发起 `POST /api/rooms/:roomId/personal-playlist/refresh`；
   - 增加 `onError` 捕获异常并通过 Toast 提示具体错误原因，杜绝静默失败；
   - 成功后触发 `setToast({ id: uuidv7(), message: "歌单已同步", type: "success" })`；
2. **文案心智统一**：
   - 按钮显示文案、悬浮 `title` 以及 `aria-label` 统一为「同步歌单」（Pending 状态为「正在同步…」）；
3. **测试验证**：
   - `tests/e2e/member-self-bound-playlists.spec.ts` 补充了点击「同步歌单」后验证 Toast「歌单已同步」的断言，7 项测试全部通过。
