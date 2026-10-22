# 随机点歌弹窗 Checkbox 居左与全站深色模式规格

本文档规范随机点歌弹窗中复选框垂直居左统一对齐，以及点歌台全站“跟随系统/浅色/深色”三态深色模式的视觉与交互规则。

---

## 一、随机点歌弹窗 Checkbox 统一居左对齐

### 1. 问题现状
随机点歌弹窗中，每个成员行（`.random-member-item`）的 Checkbox 位于最左侧，而弹窗头部的“全选”（`.random-select-all-label`）被弹性盒布局推到了最右侧，垂直方向上视线割裂，不符合常规表单从左至右统一对齐的视觉流线。

### 2. 界面排版规格
1. **标题与全选分离**：
   - 顶部区域保留 `参与成员：` 标题文本；
   - 标题正下方提供独立的“全选”行，样式与下方的成员选择卡片对齐或作为分组首行，使得全选 Checkbox 与每个成员的 Checkbox 在同一垂直对齐线上；
2. **交互规则保持不变**：
   - 全选 Checkbox 仍仅操作具备个人歌单的可选成员；
   - 完整支持未选、半选（`indeterminate`）与全选状态；
   - 半选点击变为全选可选成员，全选点击取消全部勾选；
   - 每次打开弹窗默认全不选，未选择时禁用“生成预览”按钮；
   - 支持键盘 Tab 导航与空格键切换选择。

---

## 二、全站深色模式系统（Dark Mode Theme System）

### 1. 三态偏好模型
- **模式枚举**：`'system' | 'light' | 'dark'`，定义客户端持久化偏好。
- **默认偏好**：新设备首次访问默认为 `'system'`（跟随操作系统）。
- **生效主题（Resolved Theme）**：
  - 若偏好为 `'light'`，有效主题为 `'light'`；
  - 若偏好为 `'dark'`，有效主题为 `'dark'`；
  - 若偏好为 `'system'`，当 `window.matchMedia('(prefers-color-scheme: dark)').matches` 为真时有效主题为 `'dark'`，否则为 `'light'`。
- **持久化键值**：保存在当前浏览器 `localStorage.getItem('songroom_theme_preference')`，值为 `'system' | 'light' | 'dark'`。

### 2. 防闪烁（Anti-FOUT）机制
在 `apps/songroom/dist/client/index.html`（源码位于 `apps/songroom/index.html`）的 `<head>` 内、所有外部 CSS 之前，注入一段精简同步内联脚本：
```javascript
(function() {
  try {
    var pref = localStorage.getItem('songroom_theme_preference') || 'system';
    var isDark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  } catch (e) {}
})();
```
确保浏览器解析 HTML 时立即挂载正确的 `data-theme`，避免白屏跳变黑屏或黑屏跳变白屏。

### 3. 色板体系（深度声学深灰蓝 Slate/Zinc + Indigo）
在 `styles.css` 中，为 `[data-theme="dark"]` 覆盖色彩变量：
- **背景层**：
  - `--bg-app`: `#0b0f19`（最底层画布）
  - `--bg-surface`: `#151d30`（卡片表面、列表项）
  - `--bg-surface-elevated`: `#1e293b`（弹窗、下拉悬浮层、气泡）
  - `--bg-subtle`: `#131b2e`（内嵌分组、次级背景）
  - `--bg-muted`: `#1e293b`
- **文字层**：
  - `--text-main`: `#f1f5f9`
  - `--text-muted`: `#cbd5e1`
  - `--text-dim`: `#94a3b8`
  - `--text-inverse`: `#0f172a`
- **边框层**：
  - `--border-subtle`: `#1e293b`
  - `--border-medium`: `#334155`
  - `--border-focus`: `#818cf8`
- **强调色**：
  - `--primary`: `#6366f1`
  - `--primary-hover`: `#818cf8`
  - `--primary-active`: `#4f46e5`
  - `--primary-light`: `rgba(99, 102, 241, 0.15)`
  - `--primary-border`: `rgba(99, 102, 241, 0.35)`
- **阴影与微光**：
  - 适配深色微光阴影（带轻微冷蓝边框和柔和暗影），确保层级区分明朗；
- **组件针对性适配**：
  - 登录/注册表单与输入框背景、边框及占位符对比度；
  - 顶部导航栏、Tab 标签切换指示器；
  - 房间列表卡片、公共歌单歌曲列表、点歌人胶囊、正在播放指示器；
  - 弹窗蒙层（Overlay）及弹窗容器（`.invite-modal`、`.random-replacement-modal`）；
  - 骨架屏加载动画与错误/警告横幅色彩适配。

### 4. 切换控件（Theme Toggle Button）
- **位置**：全局顶部导航栏右侧（在未登录时位于品牌标题右侧，已登录时位于用户信息/登出按钮旁）；
- **形态**：精简圆角轻质图标按钮（IconButton），展示对应状态图标：
  - `system`: 💻 电脑图标（Monitor/Laptop）
  - `light`: ☀️ 太阳图标（Sun）
  - `dark`: 🌙 月亮图标（Moon）
- **点击交互**：点击依次循环切换：`system → light → dark → system`；
- **提示与可访问性**：
  - `title` 与 `aria-label` 动态表明当前状态与下一个目标状态（例如：“当前：跟随系统 (暗色) - 点击切换为浅色模式”）；
  - 支持键盘聚焦与回车/空格触发；
  - 当处于 `system` 状态时，实时监听 `window.matchMedia`，系统发生变化时自动更新视觉表现。

---

## 三、点歌台与我的歌单顶部按钮排列与响应式

### 1. 顶部操作区按钮排布顺序（从左至右）
1. **点歌台（公共歌单）**：
   - `[随机点歌]`（主按钮 `primary-button`，高亮，房主可见，排在最左侧首位）；
   - `[搜索]`（次要按钮 `secondary-button`，展开/折叠歌单内搜索）；
   - `[定位到正在播放]`（次要按钮，指示定位）；
   - `[同步歌单]`（次要按钮，拉取云端数据）。
   - *权限说明*：无随机点歌权限时（如室友），首位自然顺延为 `[搜索]` → `[定位到正在播放]` → `[同步歌单]`。
2. **我的歌单（个人歌单）**：
   - `[搜索]`（次要按钮）；
   - `[同步歌单]`（次要按钮）。

### 2. 移动端小屏响应式适配（<= 480px / 窄屏）
- 保持单行横向排布，不换行折叠；
- `随机点歌` 保持完整按钮文字与图标；
- `定位到正在播放` 精简为“定位”（或仅保留定位图标）；
- `同步歌单` 在极端窄屏下精简为旋转图标（保留无障碍 `aria-label`）；
- 保证在 320px、390px 窄屏视口下一行完整排开，无横向滚动条，无溢出。
