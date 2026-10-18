# 24: 绑定并查看房主个人歌单

**What to build:** 在第一期已上线架构上，让房主把当前网易云账号已有的自建或收藏普通歌单绑定为可选个人来源，并在多个自建房间查看同一权威快照。

**Blocked by:** 09/读取并刷新权威公共歌单快照、23/执行第一期真实上线验收

**Status:** resolved

- [x] 第二期升级后房间一级导航原子加入“我的歌单”，形成“公共歌单”“我的歌单”“房间成员”“房间设置”最终四入口；不保留第一期三入口兼容分支。
- [x] 房主从当前核实网易云账号的完整实际清单选择目标，服务端确认目标由本人创建或已收藏，不能仅凭任意可读歌单 ID 绑定。
- [x] 本人创建的普通歌单保存为可维护来源，已收藏他人普通歌单保存为只读来源；read model 和命令权限根据服务端能力计算。
- [x] 绑定只建立 SongRoom 关联，不创建、复制、改名、排序或迁移云端歌曲；收藏来源不会被写入。
- [x] 同一房主已有或收藏歌单可绑定到其多个自建房间，并引用同一真实账号加云端歌单 ID 的规范化快照；每个房间权限和绑定代次独立。
- [x] 房主可在单个房间解除或更换绑定，不影响其他房间对同一目标的绑定，不删除自建歌单、不取消收藏也不删除作者歌单。
- [x] “我的歌单”先展示最近快照并显式刷新，支持手动刷新、同步时间、读取失败保留旧快照和 10,000 首虚拟列表，不持续轮询。
- [x] 未配置个人歌单时直接公共点歌继续可用，不将个人歌单展示为阻塞任务或自动创建云端资源。
- [x] 其他成员只能从成员详情按第二期权限查看该歌单，不获得房主的维护或点歌来源资格；浏览器不能替换归属成员。
- [x] 自动化覆盖自建、收藏、任意公开 ID 拒绝、跨房间共享快照、单房间解绑、收藏关系变化及第一期公共点歌回归。

## Comments

### 实现提交
1. **数据库与迁移层**：
   - 增加迁移 `0021_personal_playlist.sql`，建立 `personal_playlist_binding` 表，约束 `(room_id, member_id)` 唯一索引、代次 `generation > 0`、绑定类型 CHECK (`ownerCreated`, `ownerSubscribed`) 与级联清理；跨房间共享快照并复用 `(account_id, playlist_id)`。
   - `schema_version` 推进到 22。
2. **命令与业务操作层 (`PersonalPlaylists`)**：
   - 使用统一的命令幂等基础设施 `prepareCommand`、`readCommandResource`、`recordCommandResource` 处理 `bind` 与 `unbind`，支持防重放与摘要冲突拦截。
   - `candidates` 读取本人创建 (`creatorId === accountId`) 或已收藏 (`subscribed === true`) 歌单，区分可维护与只读属性。
   - 拒绝任意公开 ID 绑定，绑定只建立 SongRoom 关联不写云端。
   - 严格校验 `playlistDetail` 歌曲数据完整性与 ID 一致性，防截断；核对绑定代次与授权状态；对收藏来源检测取消收藏失效，触发 `TARGET_PERMISSION` 错误并保留快照。
   - 提供账号级与成员级 `read` 与并发合并的 `refresh` 操作，房间内 SSE 通知。
3. **HTTP 接口层**：
   - 注册 `/api/rooms/:roomId/personal-playlist`、`candidates`、`bind`、`unbind`、`refresh` 及成员详情只读路由 `/api/rooms/:roomId/members/:memberId/personal-playlist` 与 `refresh`。
4. **客户端与导航层**：
   - 原子升级房间导航至“公共歌单”、“我的歌单”、“房间成员”、“房间设置”最终四入口，废除兼容分支。
   - 新增 `PersonalPlaylistPane`：支持未配置引导、候选弹窗、万首级虚拟列表、进入显式刷新、手动同步、解绑二次确认弹窗（标注无害提示：不删除云端歌单、仅解绑当前房间）。
   - 成员详情集成 `MemberPersonalPlaylistSection` 提供只读歌单快照展示，严禁暴露维护与点歌动作。

### 验证结果
- `pnpm typecheck`：全工程类型检查通过。
- `pnpm test`：45 个测试文件、425 个单元与集成测试全部通过，覆盖自建、收藏、权限拦截、任意公开 ID 拒绝、跨房间共享快照、单房间解绑、收藏关系变化、歌曲截断拒绝与幂等防重。
- `pnpm test:e2e`：162 个 Playwright E2E 测试全部通过（含 `owner-personal-playlist.spec.ts` 与 320px/900px/1440px 响应式无横向溢出及 Axe 无障碍审计）。
- 两轴 Code Review（Standards & Spec）问题已全数修正与闭环。

### 剩余事项
- 无。第二期 Ticket 24 验收完毕。

