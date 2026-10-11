# 移动端排版收敛与歌单列表搜索筛选

Status: resolved

## Problem Statement

用户在移动端使用点歌台访问房间公共歌单时面临以下体验与功能痛点：
1. **移动端首屏纵向空间严重浪费**：移动端页面上半部分的排版不合理，返回链接、房间名称、身份标签、公共歌单大标题以及操作按钮均采用自占一行的纵向排布，导致右侧大面积空白，整体占据了超过三分之一的屏幕高度。而在移动端界面下，歌单列表才是最核心的内容，过高的头部使得用户进入后首屏几乎看不到几首歌。
2. **移动端表头缺少点歌人说明**：电脑端歌单表头清晰标有“点歌人”独立列，而移动端为避免挤压将点歌人折叠到歌名/歌手下方，但表头只写着“歌曲与歌手”，导致用户在移动端产生“点歌人信息丢失了”的误解与困惑。
3. **缺乏歌单内快速检索与点歌人定位手段**：当公共歌单歌曲较多时，用户只能通过上下滑动长列表来找歌；虽然已有向网易云曲库点歌的曲库搜索抽屉，但缺乏对当前歌单快照的本地快速检索（按歌名、歌手过滤），也无法快速筛选出某个特定室友点过的所有歌曲。
4. **房间标题视觉层级不够突出**：当前房间标题格式为“房间 · 343”，分隔符不够直观，且前缀与房间名称大小相同，未能突出房间名称这一核心识别标识。

## Solution

1. **移动端头部紧凑双行重构**：
   - 将移动端上半部分收敛为紧凑的双行布局：第一行整合返回操作、房间标题与身份元信息标签；第二行整合歌曲数量徽标与核心操作按钮组（+ 点歌、定位到正在播放、同步歌单、展开搜索筛选）。
   - 在移动端视觉上隐藏重复的“公共歌单”巨大标题（底部导航栏已高亮指示当前处于公共歌单 Tab），将垂直占用高度压缩 70% 左右，首屏立即露出更多歌曲列表项。
2. **房间标题视觉层级规范化**：
   - 将“房间 · 343”统一升级为“房间：343”，采用较小字号与次要颜色渲染前缀“房间：”，高亮突出加粗大字号的房间名称。该视觉层级规范跨端同步应用至桌面端左侧边栏。
3. **移动端表头明确“歌曲 / 点歌人”信息**：
   - 移动端列表表头文案更新为“歌曲 / 点歌人”，明确告知该列包含歌名、歌手以及点歌人标签；列表项内继续保持在歌名下方紧凑展示点歌人胶囊徽标，兼顾小屏幕横向宽度与信息完整性。
4. **歌单列表即时搜索与点歌人下拉筛选**：
   - 在歌单工具栏新增放大镜图标按钮，点击可在列表表头上方平滑展开/收起搜索与筛选栏。
   - 提供纯文本搜索框，输入时前端即时匹配歌曲名称与歌手名称（不检索专辑名，不带冗余自动补全下拉）。
   - 提供轻量下拉选择器（Select / Dropdown），动态聚合当前歌单中所有出现过的点歌人昵称，支持按点歌人快速过滤。
   - 搜索与筛选为复合 AND 过滤关系，展示匹配统计与一键清空按钮；筛选结果中的歌曲序号严格保持其在网易云歌单中的物理绝对序号不变。
5. **点歌写入与播放排序语义维持现状**：
   - 明确遵循系统核心原则，点歌维持现有的网易云原生单次写入逻辑（新歌默认入单在首部），不引入脆弱的两阶段全量重排；播放安排继续由“下一首播放”按钮提供单曲插队支持。

## User Stories

1. As a mobile room member, I want the upper portion of the public playlist page to be compact and space-efficient, so that I can see more song items immediately on the first screen without excessive scrolling.
2. As a mobile room member, I want the room context and my role/nickname to be neatly aligned on a single row, so that the right side of the screen is not left blank.
3. As a room member on both mobile and desktop, I want the room title to display as "房间：343" with the room name visually prominent and the prefix subdued, so that I can clearly identify which room I am in.
4. As a desktop room member, I want the desktop workspace to retain its spacious layout and primary page heading, so that the wide screen remains comfortable and well-structured.
5. As a mobile room member, I want the playlist table header to clearly state "歌曲 / 点歌人", so that I immediately understand where requester information is displayed.
6. As a mobile room member, I want the requester tags to remain displayed as compact badges below the song and artist lines, so that song titles and artist names are not truncated by narrow columns.
7. As a room member, I want to toggle a search bar using a search icon in the playlist toolbar, so that the search bar does not take up vertical screen space when I do not need it.
8. As a room member, I want to type a song title or artist name into the search bar, so that the song list instantly filters down to matching songs in real time without network delay.
9. As a room member, I want the search input not to match album names, so that search results remain strictly relevant to the song or artist I am looking for.
10. As a room member, I want to filter songs by requester using a dropdown containing all unique requesters from the current playlist, so that I can view all songs requested by a specific roommate.
11. As a room member, I want to combine text search and requester dropdown filtering, so that I can find a specific song requested by a specific person.
12. As a room member, I want to see the count of matching songs when filtering is active (e.g. "筛选出 6 首 / 共 45 首"), so that I have clear feedback on the filter result.
13. As a room member, I want a single-click clear button to reset both search and requester filters, so that I can quickly return to the full playlist.
14. As a room member, I want filtered song items to retain their original absolute playlist position numbers (e.g. #3, #15), so that I know where each song physically sits in the upstream cloud playlist.
15. As a room member, I want to see a clear empty state message when no songs match my search or filter criteria, so that I know why the list is empty.
16. As a room member, I want the "Play Next" button on filtered songs to still work against the current playback indicator, so that searching does not disable song scheduling.
17. As a screen reader user, I want the search toggle, search input, requester filter, and room context to have accessible labels and proper roles, so that I can navigate and operate the playlist easily.
18. As a mobile room member, I want the bottom navigation bar and page layout to prevent horizontal overflow across all viewports, so that the page remains clean and touch-friendly.

## Implementation Decisions

### 1. 移动端头部布局收敛与视觉层级
- **移动端特定样式重构**：在 `@media (max-width: 768px)` 视口下，重塑房间上下文与歌单工具栏的布局流。
- **第一行（房间上下文）**：左侧放置返回导航与房间标题，右侧放置成员身份与昵称徽标。使用 Flexbox 双端对齐（`justify-content: space-between`），消除右侧空白。
- **标题视觉层级组件化**：将房间标题由普通的文本拼接抽象为带层级标记的结构：`<span class="room-prefix">房间：</span><span class="room-name">{name}</span>`，CSS 将 `room-prefix` 设为 `font-size: var(--font-xs)`、颜色次要（`var(--text-muted)`），`room-name` 设为粗体大字号。该层级结构在桌面端侧边栏与移动端头部同步生效。
- **移动端标题去重**：移动端视口下，将 `<h1>公共歌单</h1>` 在视觉上隐藏（或使用屏幕阅读器可见类 `.sr-only`），依靠常驻底部的“公共歌单”高亮导航传达当前页面语义；桌面端保留该大标题。
- **第二行（歌单工具栏）**：左侧展示包含歌曲总数的徽标（及筛选状态下的匹配数）；右侧横向排列操作按钮组，包含 `+ 点歌`、`定位到正在播放`、`同步歌单` 以及 `搜索筛选` 图标按钮。

### 2. 移动端表头文案明确化
- 在移动端表头样式中，第二列表头文案统一为“歌曲 / 点歌人”（桌面端仍保持“歌曲与歌手”、“点歌人”两列独立）。
- 歌曲条目中的点歌人徽标继续沿用紫色胶囊（`requester-capsule`）样式，置于歌曲名与歌手下方，确保在 360px~412px 屏幕上拥有充足的可点击区域和文本空间。

### 3. 歌单列表即时搜索与点歌人筛选机制
- **客户端纯内存过滤**：由于公共歌单快照（`snapshot.tracks`）已缓存在前端 TanStack Query 状态中，搜索与筛选完全在客户端内存中执行，无需发起任何后端 HTTP 请求。
- **状态管理**：
  - `isSearchOpen: boolean`（控制搜索筛选栏展开/收起）；
  - `searchQuery: string`（当前输入的歌名/歌手搜索词，去掉首尾空格并小写处理）；
  - `selectedRequester: string`（当前选中的点歌人，空字符串或 `"all"` 表示全部）。
- **过滤算法**：
  - 仅对歌曲名（`track.name`）和歌手名列表（`track.artists`）进行不区分大小写包含匹配（排除 `track.album`）；
  - 点歌人匹配：若选中特定点歌人，则要求 `track.requesters.includes(selectedRequester)`；
  - 两者为逻辑与（AND）关系。
- **动态点歌人集合聚合**：
  - 自动从当前快照的全部歌曲中计算出唯一的点歌人列表：`Array.from(new Set(tracks.flatMap(t => t.requesters))).sort()`；
  - 仅在有歌曲包含点歌人时在下拉菜单中显示对应选项，并提供“全部点歌人”默认项。
- **虚拟化列表集成**：
  - 将过滤后的歌曲列表（`filteredTracks`）传递给虚拟滚动容器（`useWindowVirtualizer`）；
  - 列表项的序号继续渲染 `track.position + 1`，反映网易云物理绝对序号；
  - 当过滤结果为空时，虚拟列表渲染友好的空状态卡片：“未找到匹配的歌曲”。

### 4. 架构与稳定性基线保持
- 严格维持网易云原生 `trackAdd` 写入语义，不执行自动重排到末尾的两阶段写操作，维护系统“一个业务意图至多发送一次写操作”的长效架构设计。

## Testing Decisions

### 良好测试的标准
- **外部行为黑盒验证**：仅通过 Playwright E2E 针对真实 DOM 呈现与用户交互进行验证，不测试组件内部状态变量或实现细节。
- **跨视口验证**：在移动端视口（390px × 820px）和桌面端视口（1440px × 820px）分别验证排版契约与功能完整性。

### 测试模块与范围
1. **移动端紧凑头部测试**：
   - 验证在 390px 视口下，房间标题前缀与名称符合新规范；
   - 验证移动端头部不再纵向大面积留白，歌曲数与操作按钮同排或紧凑双排呈现；
   - 验证表头文字在移动端显示为“歌曲 / 点歌人”；
   - 验证列表项正确渲染点歌人胶囊。
2. **歌单列表搜索测试**：
   - 验证点击搜索图标可展开搜索栏；
   - 验证输入歌名或歌手名称后，列表项即时过滤；
   - 验证输入专辑名称不触发过滤；
   - 验证过滤后每首歌的序号仍保持其绝对原始序号；
   - 验证输入不匹配关键词时展示空状态提示；
   - 验证一键清除或收起后完整列表恢复。
3. **点歌人筛选测试**：
   - 验证下拉菜单正确填充快照中存在的全部点歌人选项；
   - 验证选择特定点歌人后，列表中仅保留该点歌人标记的歌曲；
   - 验证组合输入文本搜索和点歌人选择时的复合过滤行为。
4. **现有功能回归测试**：
   - 验证“定位到正在播放”与“下一首播放”在过滤视图与无过滤视图下均不受影响。

### 代码库既有参考（Prior Art）
- `apps/songroom/tests/e2e/room-experience.spec.ts`（多视口布局、虚拟列表及下一首播放定位测试）
- `apps/songroom/tests/e2e/song-search-and-request.spec.ts`（曲库搜索与点歌交互测试）

## Out of Scope

1. **服务端两阶段调序写**：点歌入单自动移至末尾被明确排除，点歌维持网易云默认首部添加。
2. **多重排序算法**：不提供按拼音、时长或专辑的前端表格排序切换。
3. **搜索历史持久化**：歌单内搜索与筛选为纯会话即时过滤，切页或刷新时不写入 LocalStorage 或 URL 参数。
4. **复杂高级筛选器**：不提供音质、时长区间或发行年份筛选。

## Further Notes

- 该特性属于纯前端体验与交互增强，不涉及数据库 Schema 迁移、后端 API 协议变更或网易云上游 Worker 变动。
- 实施时需注意虚拟化列表 `useWindowVirtualizer` 在过滤导致歌曲数量大幅减少时的尺寸动态重新计算与测量。
