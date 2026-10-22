# 02：全站深色模式主题系统支持与三态切换

**What to build:** 实现点歌台全站深色模式，包含深度声学深灰蓝（Slate/Zinc + Indigo）色板体系、三态偏好管理（跟随系统/浅色/深色）、顶部导航栏循环切换控件、HTML head 防闪烁内联脚本以及全站所有组件与弹窗的暗色适配。

**Blocked by:** 无，规格与 ADR 已确认。

Status: ready-for-agent

规格：[随机点歌弹窗 Checkbox 居左与全站深色模式规格](../spec.md) 及 [ADR 0004](../../docs/adr/0004-dark-mode-theme-system.md)。

## 验收清单

- [ ] 在 `index.html` 的 `<head>` 注入防闪烁内联脚本，根据 `localStorage` 或系统媒体查询在 DOM 渲染前设置根元素 `data-theme`。
- [ ] 在 `styles.css` 中基于 `[data-theme="dark"]` 实现完整的深度声学深灰蓝色彩变量体系（背景、文字、边框、强调色、阴影与状态色）。
- [ ] 全站关键组件与界面完成暗色视觉适配：
  - 登录/注册表单与输入框、错误横幅；
  - 全局顶部导航栏、品牌 Logo 与用户操作区；
  - 房间列表、房间创建/加入弹窗；
  - 房间工作台 Tab 切换、搜索栏、歌曲列表项、正在播放指示器与点歌人胶囊；
  - 随机点歌预览弹窗、危险操作弹窗（解散/退出房间）及各类状态 Banner。
- [ ] 全局导航栏右侧实现单个循环切换图标按钮，支持 `system` (💻) → `light` (☀️) → `dark` (🌙) 循环切换，并具备明确的 `title` 与 `aria-label` 提示。
- [ ] 切换结果持久化至当前浏览器 `localStorage`（键名 `songroom_theme_preference`）。
- [ ] 当偏好为 `system` 时，实时监听系统 `prefers-color-scheme` 媒体查询变化并无缝响应。
- [ ] 颜色对比度符合 WCAG AA 级标准，Axe-core 无障碍扫描无违规。
- [ ] 覆盖三态流转、持久化、实时系统监听的单元与集成测试，以及全页面 E2E 验证。

## Comments

- 决策已沉淀至 `docs/adr/0004-dark-mode-theme-system.md`，确定采用深度冷灰蓝（非纯黑 AMOLED）色板与单按钮循环三态切换方案。
