# 01: 成员端自选候选与自主绑定点歌来源

**What to build:** 任何房间成员（房主与室友）在「我的歌单」中独立管理点歌来源：未绑定网易云时显示引导文案与「前往账号设置」链接；已绑定网易云但未绑定歌单时，显示「绑定歌单」按钮，唤起候选弹窗展示本人的「我喜欢」/自建（含私密）/收藏歌单；选定后提交自主绑定，服务端记录 `binding.accountId` 为成员自身账号 ID 并拉取曲目快照；已绑定歌单后展示歌曲列表快照，操作收敛为「手动刷新」（使用本人授权拉取）与「更换歌单」（重新挑选并直接覆盖）；移除原房主代分配接口与无用的解绑接口。

**Blocked by:** None (can start immediately)

**Status:** resolved

## Acceptance criteria

- [x] 未绑定网易云账号的成员访问「我的歌单」时，界面展示引导文案与「前往账号设置」按钮，点击可导航至 `/account`
- [x] 已绑定网易云但未在当前房间配置歌单的成员，在「我的歌单」展示空状态与「绑定歌单」按钮
- [x] 点击「绑定歌单」唤起候选弹窗，调用 `GET /api/rooms/:roomId/personal-playlist/candidates` 获取当前成员本人网易云账号下的「我喜欢」、自建（含私密）与收藏歌单候选
- [x] 选中某个候选歌单并确认后，调用 `POST /api/rooms/:roomId/personal-playlist/bind` 成功创建绑定，`personal_playlist_binding.accountId` 记录为成员本人的网易云账号 ID
- [x] 绑定成功后即刻拉取并展示当前歌单的歌曲快照（包含歌名、歌手、专辑与曲目数），并展示「手动刷新」与「更换歌单」按钮
- [x] 点击「手动刷新」调用 `POST /api/rooms/:roomId/personal-playlist/refresh`，使用成员自身凭证同步最新歌曲快照
- [x] 点击「更换歌单」重新打开候选弹窗，选定新歌单后成功覆盖原绑定，无需先执行解绑
- [x] 页面彻底移除“解除绑定/解除分配”按钮
- [x] 移除旧的房主代分配接口（`.../assign` 与 `.../unassign`）及查看他人歌单接口，调用返回 404
- [x] 编写并通过 HTTP 路由与领域操作层集成测试

## Comments

### 实现说明
1. **领域与契约**：在 `personal-playlist-contracts.ts` 中新增 `bindPersonalPlaylistCommand`；在 `PersonalPlaylists` 中实现 `bind` 与去中心化 `getCandidates` / `refresh`，以调用者自身的网易云凭证读取曲目与候选，`personal_playlist_binding.accountId` 记录为成员本人的账号 ID。
2. **HTTP 路由与废弃清理**：在 `personal-playlists.ts` 中注册 `POST /api/rooms/:roomId/personal-playlist/bind`，彻底移除旧的 `assign`、`unassign` 以及他人歌单只读查看接口（请求均返回 404）。
3. **前端交互组件**：
   - 新建 `BindPersonalPlaylistDialog.tsx`，支持「绑定个人歌单」与「更换个人歌单」两种交互模式，按我喜欢、自建、收藏分组渲染；
   - 更新 `PersonalPlaylistPane.tsx`，当未绑定网易云时显示引导前往 `/account`；未配置歌单时展示「绑定歌单」；已绑定时提供「手动刷新」与「更换歌单」，不提供解绑按钮。
4. **测试验证**：
   - `src/operations/personal-playlists.test.ts`（18 个测试全部通过）；
   - `src/http/personal-playlists.test.ts`（13 个测试全部通过）；
   - 全量回归测试 51 个文件共 571 个测试全部通过；客户端与服务端生产构建构建无报错。

