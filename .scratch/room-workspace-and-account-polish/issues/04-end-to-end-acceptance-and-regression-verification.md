# 04 - 全量端到端自动化测试回归与生产部署验收

**Status:** resolved
**Blocked by:** 01-bind-playlist-dialog-close-and-current-indicator.md, 02-personal-playlist-sync-post-fix-and-toast.md, 03-member-role-colors-and-account-logout-cleanup.md

## What it delivers

更新 Playwright E2E 测试断言以覆盖所有的交互与视觉修复；在真实浏览器中验证更换歌单弹窗关闭按钮尺寸与当前绑定高亮徽章、我的歌单同步真实 POST 与 Toast 提示、成员卡片色彩层次、账号设置页不含退出按钮；通过全量后端单元/集成测试与 E2E 浏览器测试，验证零回归。

## Acceptance criteria

- [x] 更新 `apps/songroom/tests/e2e/member-self-bound-playlists.spec.ts` 及其它相关测试，验证弹窗关闭按钮尺寸、当前绑定标签与默认选中
- [x] 验证「我的歌单」页面点击「同步歌单」时触发真实 POST 调用并弹出「歌单已同步」Toast
- [x] 验证房间成员列表角色胶囊为中性底色、「（我）」为蓝色文字高亮
- [x] 验证账号设置页面无退出按钮，通过右上角头像下拉菜单可正常退出
- [x] 全量 574+ 单元与集成测试、192+ E2E 测试全部通过，零失败
- [x] TypeScript 类型检查与 Vite 生产编译零错误、零警告

## Comments

### 实现与验收记录
1. **端到端测试断言补齐**：
   - 在 `tests/e2e/member-self-bound-playlists.spec.ts` 中针对更换歌单弹窗补充了尺寸断言（`closeBox.width` 与 `closeBox.height` 均为 32px）、当前绑定标签（`dialog.getByText("当前绑定")`）与默认选中（`aria-checked="true"`）核验；
   - 验证点击「同步歌单」时真实触发后端接口并在前台弹出 Toast `歌单已同步`；
   - 验证账号设置页无退出设备按钮，全站登出由右上角用户菜单触发；
2. **全量测试结果**：
   - 单元与集成测试：51 个测试文件，574 个测试用例全部通过；
   - 端到端测试：18 个 Playwright 测试文件，192 个测试用例全部通过（覆盖无障碍 Axe 扫描及响应式视口）；
   - 前端打包与后端编译构建零错误、零警告。
