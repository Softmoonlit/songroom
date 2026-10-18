# 25: 创建并查看室友个人歌单

**What to build:** 让当前室友按需在房主网易云账号下创建一份仅属于自己和当前房间的专用个人歌单，并让房间成员从成员详情只读查看。

**Blocked by:** 06/审批成员并管理房间身份、08/有界且公平地执行上游操作、11/恢复未知歌曲写入而不重发、12/处理公共歌单创建结果未知、23/执行第一期真实上线验收、24/绑定并查看房主个人歌单

**Status:** need-review

- [x] 室友获批时不自动创建个人歌单；只有该室友可在“我的歌单”明确发起创建，且不要求绑定自己的网易云账号。
- [x] 创建始终使用目标房间房主的当前有效授权，名称采用规格格式；后续房间或成员改名不自动改云端名称。
- [x] 室友只能专用新建，不能绑定已有歌单、收藏歌单、任意公开 ID，不能与其他成员或房间共用该专用目标。
- [x] 同一当前成员在当前房间至多一个个人绑定；并发创建复用持久操作、幂等、调度和未知创建规则，不产生重复云端歌单。
- [x] 正常返回具体 ID 后自动建立带专用创建证据的新绑定；已获 ID 未关联按当前成员和房间状态恢复，未知 ID 不按名称猜测或再次创建。
- [x] 归属室友在 ticket 24 已建立的“我的歌单”入口查看该专用来源，read model 将其标记为可维护；房主及其他成员只能从“房间成员”的成员详情查看只读内容，不能添加、删除或逐首点歌，实际单首维护由 ticket 26 实现。房主从全体成员来源随机换歌的额外权限按[后续规格](../../public-playlist-lifecycle/spec.md)实现，不开放普通逐首取歌或编辑权限。
- [x] 专用个人歌单不与公共歌单共用、不会自动汇总到公共目标；没有公共歌单时仍可独立创建和查看，维护操作由后续 ticket 提供。
- [x] 页面按需读取权威快照，显示同步时间与失败状态，并复用规范化目标、完整读取和虚拟列表规则。
- [x] 创建或同步过程中成员撤权、房间删除、授权代次变化和晚到响应不能恢复成员或绑定，必要时只转最小个人资源清理。
- [x] HTTP、SQLite 与浏览器测试覆盖本人创建、房主/他人越权、无房主授权、并发创建、未知结果、成员撤权和成员详情只读。

## Comments

### 实现提交
1. **数据库与迁移层**：
   - 增加迁移 `0022_roommate_personal_playlist.sql`，支持 `operation.kind = 'createPersonalPlaylist'`；更新 `personal_playlist_binding` 绑定类型枚举增加 `roommateDedicated` 并关联 `creation_operation_id`；新建持久化步骤记录表 `personal_playlist_creation`（记录 `step`、`playlist_id`、`before_playlists`、`after_playlists`、`sent_at`、`recovered` 等完整证据）；推进 `schema_version` 至 23。
2. **命令与持久操作层 (`PersonalPlaylists`)**：
   - 接入上游调度器 `scheduler.register("createPersonalPlaylist", ...)`，实现两阶段写操作与崩溃恢复（`ready` -> `verified` 保存 before 清单 -> `sending` 写入上游 -> `confirming` 取得 ID 建立专用绑定）。
   - 命名格式严格遵守规格 `songroom-${room.name}-${member.nickname}`。
   - 实现命令防重与幂等（`prepareCommand`、`readCommandResource`、`recordCommandResource`），同一成员同一房间未完成写操作互斥（409 `OPERATION_PENDING`）。
   - 校验房主授权有效性与风控状态，未授权拒绝（409 `NETEASE_AUTH_REQUIRED` / 423 `ACCOUNT_PAUSED`）；房主发起创建专用个人歌单被 403 拒绝（`ROOMMATE_ONLY`）；房主禁止绑定室友专用个人歌单（422 `TARGET_PERMISSION`）。
   - 异常处理：上游超时或未知错误记录 before/after 清单进入 `needsAdministrator` (step: `unknown`)；已获 ID 崩溃重启恢复关联（step: `confirming`, `recovered: true`）；成员撤权或房间删除时安全转入最小个人资源清理任务。
   - 集成 `AbnormalOperationsService`，管理员核查未知创建支持室友专用歌单创建核实（证据歧义保持暂停，证据唯一且业务有效恢复绑定，业务已结束安全转入歌单清理任务）。
   - 支持房主重新授权（`onReauthorized`）自动唤醒因授权失效挂起的个人歌单创建操作。
3. **HTTP 接口层**：
   - 增加 `POST /api/rooms/:roomId/personal-playlist/create` 端点，支持室友受理返回 202 并携带 operation 进行中状态。
4. **客户端层**：
   - 在 `PersonalPlaylistPane` 中根据 `allowedActions` 区分房主（绑定已有歌单）与室友（创建专用个人歌单 `songroom-房间名-昵称`）；展示排队、创建中、待确认等 operation 友好状态提示及 disabledReason；室友个人歌单标识来源属性为“专用（可维护）”；成员详情中保持只读展示。

### 验证结果
- `pnpm typecheck`：全工程类型检查通过。
- `pnpm test`：46 个测试文件、440 个测试全部通过（覆盖本人创建、房主/他人越权拒绝、无房主授权拦截、并发创建互斥、幂等防重、未知结果管理端核查、成员详情只读与状态提示）。
- 本地 Code Review 工具审查两轴通过，并已完善明确失败区分、授权代次一致性校验与资源清理所有者保留。

### 剩余事项
- 提交代码并由用户/上层复核。

