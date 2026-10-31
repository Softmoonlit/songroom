# 03 - 重构成员列表角色与自身高亮色彩规范，清理账号设置冗余登出按钮

**Status:** ready-for-agent
**Blocked by:** none

## What it delivers

重构房间成员列表的角色视觉表达：房主与室友角色采用同层级中性胶囊背景，不再将蓝色赋予房主，将品牌蓝色专用在「（我）」文字高亮上，消除自身视角与身份角色的色彩冲突；同时彻底移除账号设置页底部的冗余登出按钮，全站登出入口收敛于右上角用户菜单。

## Acceptance criteria

- [ ] 房间成员卡片中，`.status-pill.role-owner` 与 `.status-pill.role-roommate` 统一采用相同层级的中性背景、边框与字色，不再给房主特殊蓝色
- [ ] 房间成员卡片中，当前登录用户的「（我）」标记（`.member-self-tag`）独占品牌蓝色高亮，主观视角定位清晰
- [ ] 账号设置页面底部的「退出当前设备」区块及其 CSS 样式完全移除
- [ ] 全站账号登出入口统一且仅保留在全局导航栏右上角用户头像下拉菜单中的「退出登录」

## Comments

### Notes
- 核心修改涉及 `apps/songroom/src/client/styles.css` 与 `apps/songroom/src/client/App.tsx`
