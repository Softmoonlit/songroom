# 02: 房间成员列表布局重排与他人歌单隐私收敛

**What to build:** 重构「房间成员」列表界面与信息架构：左侧信息区将头像、昵称、（我）标记与角色胶囊（房主/室友）紧凑排列在同一信息组内；右侧彻底移除成员卡片上的“分配歌单”、“更换歌单”、“解除分配”以及“查看歌单”按钮；彻底移除他人歌单曲目下钻详情页面（`MemberPersonalPlaylistSection`）及后端读取接口，室友绑定的私密曲库不对全房间公开；房主对其他室友仅保留必要的“移除成员”管理操作。

**Blocked by:** 01: 成员端自选候选与自主绑定点歌来源

**Status:** resolved

## Acceptance criteria

- [x] 房间成员卡片左侧紧凑聚合展示：成员头像、昵称、本人的“（我）”标记，以及“房主”/“室友”角色胶囊（`status-pill role-owner` / `role-roommate`）
- [x] 房间成员卡片彻底移除原有的“分配歌单”、“更换歌单”和“解除分配”按钮
- [x] 房间成员卡片彻底移除原有的“查看歌单”按钮，点击成员不展开他人歌单曲目
- [x] 彻底删除前端 `MemberPersonalPlaylistSection` 组件及所有相关状态与弹窗引用
- [x] 普通室友视角的成员列表，右侧无任何操作按钮
- [x] 房主视角的成员列表，仅在其他室友行右侧保留“移除成员”危险操作按钮；房主自身行无操作按钮
- [x] 后端彻底移除他人个人歌单读取接口（`GET /api/rooms/:roomId/members/:memberId/personal-playlist`），调用返回 404
- [x] 编写并通过界面渲染与回归测试

## Comments

### 实现说明
1. **成员卡片信息布局重排**：
   - 在 `RoomWorkspace.tsx` 的 `member-card-left` 中将头像、昵称、（我）标签以及角色胶囊（`status-pill role-owner` / `role-roommate`）紧凑排列在同一组内，角色标签不再孤立放置在右侧；
   - 彻底移除原卡片上的“分配歌单”、“更换歌单”、“解除分配”以及“查看歌单”按钮。
2. **操作收敛与隐私保护**：
   - 彻底删除 `MemberPersonalPlaylistSection` 组件与下钻导航逻辑，室友绑定的私密曲库不对全房间公开；
   - 普通室友视角右侧无任何按钮；
   - 房主视角仅在其他室友卡片右侧提供“移除成员”危险操作按钮（点击唤起二次确认弹窗），房主自身卡片无操作按钮。
3. **彻底清理废弃组件与契约**：
   - 删除废弃的 `AssignFavoritePlaylistDialog.tsx` 文件；
   - 清理 `room-contracts.ts` 中的 `assignPersonalPlaylist` 与 `unassignPersonalPlaylist` 动作定义；
   - 清理 `rooms.ts` 中的冗余权限分配逻辑与 `guideAssignSelf`。
4. **测试验证**：
   - 编写 `src/http/rooms.test.ts` 中针对房主与室友双视角权限边界及歌单下钻接口 404 的回归测试；
   - 全仓库 51 个测试套件共 572 个测试全部通过；客户端与服务端生产构建零错误。

