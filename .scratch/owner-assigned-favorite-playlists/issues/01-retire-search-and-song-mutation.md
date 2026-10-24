# 01: 下线全网搜索与个人歌单自建/删除，收敛一级导航

**What to build:** 从房间中彻底移除全网搜索歌曲与直接点歌能力，下线搜索独立页面，将房间一级导航收敛为「点歌台」、「我的歌单」、「房间成员」、「房间设置」四个标签页，并默认激活「点歌台」；同时从「我的歌单」和后台中清理专用歌单自建弹窗、单首删除接口及成员/删房时的云端歌单清理任务，消除多余的非核心路径。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 房间一级导航展示为「点歌台」、「我的歌单」、「房间成员」、「房间设置」4 个标签页，移除「搜索歌曲」标签页。
- [x] 每次进入房间默认展示「点歌台」，不记忆上一次停留的标签页。
- [x] 移除 `SongSearchPane` 及 `/api/rooms/:roomId/song-search` 后端接口，点歌台不展示全网搜索点歌入口或抽屉。
- [x] 从「我的歌单」中移除自建专用歌单弹窗，移除歌曲行上的单首删除按钮。
- [x] 下线服务端专用个人歌单创建（`createPersonalPlaylist`）与单首删除（`personal_song_mutation`）接口与持久操作。
- [x] 成员退出房间或房主删除房间时，不再向网易云生成或执行任何个人歌单清理任务（Cleanup Task）。
- [x] 单元与集成测试回归通过，无废弃接口引用错误。

## Comments

### 实现说明
1. **收敛 4 标签页导航与默认点歌台**：在 `RoomWorkspace.tsx` 中移除 `search` 选项卡，恢复为 `public`（点歌台）、`personal`（我的歌单）、`members`（房间成员）、`settings`（房间设置）4 项，默认激活 `public`；移除历史搜索状态及跨 tab 搜索参数留存。
2. **彻底下线全网搜索**：删除 `SongSearchPane.tsx`、`song-search-messages.ts`、`src/operations/song-search.ts`、`src/http/song-search.ts` 及其相关 contracts 与测试，并在 CSS 中剔除搜索废弃样式。
3. **个人歌单转为只读呈现**：在 `PersonalPlaylistPane.tsx` 中移除「创建专用个人歌单」弹窗与操作、移除单首删除按钮；保留单曲点播至点歌台能力与手动刷新能力。
4. **服务端下线自建与修改路由**：下线 `/api/rooms/:roomId/personal-playlist/create` 与 `/songs/remove` HTTP 端点；从 `PersonalPlaylists` 中移除创建与增删歌曲的调度注册与操作处理。
5. **退房与删房生命周期清理**：在 `personal-playlist-lifecycle.ts` 中彻底停用针对个人歌单生成网易云清理任务（Cleanup Task）；成员退出或房间删除时仅本地清理绑定与快照，绝不向网易云发起个人歌单删除请求。
6. **删除确认弹窗与契约净化**：从 `roomDeletionView` 契约和实现中彻底移除 `personalPlaylistCount` 和 `pendingPersonalPlaylistCount` 废弃字段，同步更新弹窗文案明确个人收藏歌单仅在本地解绑。

### 验证结果
- `pnpm typecheck`：通过（客户端、服务端与测试代码无类型错误）。
- `pnpm test`：51 个测试套件，543 个用例全部通过（涵盖房间生命周期、成员退房、异常处置、安全矩阵等）。
- Playwright E2E：`owner-personal-playlist.spec.ts`、`room-deletion.spec.ts`、`destructive-dialogs.spec.ts` 共 20 个测试全部通过（包含 320px/900px/1440px 视口无横向溢出及 Axe 无障碍审查）。
- Code Review：Standards 与 Spec 双轴审查通过，无死代码残留或兼容垫片。
