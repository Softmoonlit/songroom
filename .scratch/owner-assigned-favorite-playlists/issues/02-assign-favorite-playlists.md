# 02: 房主在房间成员页分配、更换与解除收藏歌单

**What to build:** 让房主能够在房间成员列表中为每位成员（包括自身和室友）统一管理点歌来源：拉取房主已授权账号下的网易云收藏歌单（排除自建歌单），支持为成员分配新歌单、更换已分配歌单或解除分配；支持多位成员共享绑定同一份收藏歌单，并保证室友端无法篡改分配。

**Blocked by:** 01/下线全网搜索与个人歌单自建/删除，收敛一级导航

**Status:** resolved

- [x] 调整 `personal_playlist_binding` 数据结构，移除 `target_unique` 索引，允许多个成员绑定同一个网易云收藏歌单。
- [x] 新增房主专属候选接口，分页拉取网易云歌单并严格过滤为收藏歌单（`subscribed === true && creatorId !== accountId && status === 0`），排除自建歌单。
- [x] 新增房主专属的分配、更换与解除分配持久命令与 HTTP 接口，非房主调用严格返回 403 Forbidden。
- [x] 「房间成员」列表中，房主在未分配成员行看到「分配歌单」按钮，在已分配成员行看到「更换歌单」与「解除分配」操作，不显示歌单名称文本。
- [x] 点击分配/更换弹出模态框展示收藏歌单卡片（封面、歌名、曲目数、原作者），选中确认后完成绑定并写回本地快照；若无收藏歌单显示友好空状态引导。
- [x] 室友打开「房间成员」列表保持纯只读，不显示任何分配、更换或解除操作按钮。
- [x] 单元与集成测试覆盖候选过滤、权限拦截、多成员同绑、解绑与更换操作幂等性。

## Comments

### 实现提交
- **数据库结构与迁移 0029**：
  - 更新 `personal_playlist_binding`，移除 `target_unique` 全局唯一索引，改为 `(room_id, member_id)` 唯一索引，允许不同成员分配绑定相同的收藏歌单。
  - 移除已废弃的 `creation_operation_id` 列，保留与公共歌单的目标冲突隔离触发器。
  - 彻底 DROP TABLE 废弃的 `personal_playlist_creation`、`personal_song_addition`、`personal_song_mutation`。
- **网易云 Worker 与协议扩展**：
  - 更新 `apps/songroom/src/netease/protocol.ts` 与 `apps/songroom/src/netease/worker.cts`，提取 `creatorNickname`，支持收藏歌单详情解析与自建歌单过滤。
- **后端命令与接口**：
  - 在 `apps/songroom/src/operations/personal-playlists.ts` 中实现 `getCandidates`、`assign`、`unassign`。
  - 候选严格过滤 `subscribed === true && creatorId !== accountId && status === 0`，分配时拉取歌单完整快照及曲目，更换歌单时代次 `generation` 递增。
  - 在 `apps/songroom/src/http/personal-playlists.ts` 暴露候选查询与分配/解除端点，非房主一律返回 403 Forbidden。
  - 成员列表在 `apps/songroom/src/rooms/rooms.ts` 中为房主赋予 `assignPersonalPlaylist` 动作。
- **前端交互与样式**：
  - 新增 `apps/songroom/src/client/AssignFavoritePlaylistDialog.tsx`，展示收藏歌单卡片（封面、名称、曲目数、作者昵称）、单选交互及空状态引导。
  - 在 `apps/songroom/src/client/RoomWorkspace.tsx` 的「房间成员」面板集成「分配歌单」、「更换歌单」和二次确认「解除分配」操作；室友视图完全只读。
  - 在 `apps/songroom/src/client/styles.css` 添加卡片网格、选中态与操作按钮样式。

### 验证结果
- `pnpm typecheck`：通过，前后端类型完全匹配。
- `pnpm test`：51 个测试文件共 543 个测试全部 PASS（涵盖候选过滤、权限校验、多对一绑定、生命周期解绑、数据库迁移与集成接口）。
- `pnpm build`：Vite 前端构建与服务端 TypeScript 编译成功。

### 剩余事项
- 推进工单 03：未分配状态端到端联调与异常分支适配。
