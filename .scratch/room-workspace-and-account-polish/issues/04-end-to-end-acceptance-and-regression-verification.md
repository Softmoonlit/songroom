# 04 - 全量端到端自动化测试回归与生产部署验收

**Status:** ready-for-agent
**Blocked by:** 01-bind-playlist-dialog-close-and-current-indicator.md, 02-personal-playlist-sync-post-fix-and-toast.md, 03-member-role-colors-and-account-logout-cleanup.md

## What it delivers

更新 Playwright E2E 测试断言以覆盖所有的交互与视觉修复；在真实浏览器中验证更换歌单弹窗关闭按钮尺寸与当前绑定高亮徽章、我的歌单同步真实 POST 与 Toast 提示、成员卡片色彩层次、账号设置页不含退出按钮；通过全量后端单元/集成测试与 E2E 浏览器测试，验证零回归。

## Acceptance criteria

- [ ] 更新 `apps/songroom/tests/e2e/member-self-bound-playlists.spec.ts` 及其它相关测试，验证弹窗关闭按钮尺寸、当前绑定标签与默认选中
- [ ] 验证「我的歌单」页面点击「同步歌单」时触发真实 POST 调用并弹出「歌单已同步」Toast
- [ ] 验证房间成员列表角色胶囊为中性底色、「（我）」为蓝色文字高亮
- [ ] 验证账号设置页面无退出按钮，通过右上角头像下拉菜单可正常退出
- [ ] 全量 574+ 单元与集成测试、192+ E2E 测试全部通过，零失败
- [ ] TypeScript 类型检查与 Vite 生产编译零错误、零警告

## Comments

### Notes
- 验证所有视口与无障碍扫描
