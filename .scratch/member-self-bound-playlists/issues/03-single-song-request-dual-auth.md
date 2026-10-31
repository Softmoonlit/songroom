# 03: 逐首点歌双授权核验与点歌人标签贯通

**What to build:** 成员在「我的歌单」中点击单曲「点歌」到公共歌单：服务端执行双授权强核验，校验点歌成员自身网易云授权 active 且匹配绑定账号，校验房主授权 active；若点歌成员自身授权失效，明确拦截并提示先重新授权，不凭旧快照放行；校验通过后，上游调度器使用房主凭据向公共歌单添加歌曲，并在点歌台公共歌单中打上点歌成员当前昵称的点歌人标签；覆盖完整 HTTP 链路与异常回滚测试。

**Blocked by:** 01: 成员端自选候选与自主绑定点歌来源

**Status:** resolved

## Acceptance criteria

- [x] 成员在「我的歌单」点击单曲「点歌」，调用 `POST /api/rooms/:roomId/song-requests`
- [x] 来源校验：要求点歌成员在当前房间已绑定个人歌单，且歌曲存在于该个人歌单快照中
- [x] 点歌人授权校验：校验点歌成员自身的网易云授权状态为 `active` 且 `accountId` 与 `personal_playlist_binding.accountId` 严格一致；若点歌成员授权为 `waitingAuthorization` 或凭据失效，返回明确的授权失效错误，拦截点歌
- [x] 房主授权校验：校验房主网易云授权状态为 `active`；若房主授权失效，返回房主未授权错误
- [x] 调度写入执行：上游调度器使用**房主网易云凭据**调用网易云 `playlist_tracks` 接口将歌曲添加到公共歌单
- [x] 点歌人标签：公共歌单读回核验成功后，在点歌台将该歌曲打上点歌成员当前昵称的去重标签（`requesterTag`）
- [x] 若歌曲已在公共歌单中，不重复添加云端条目，正确追加或保留点歌成员的点歌人标签
- [x] 编写并通过 HTTP 路由与操作层集成测试，覆盖双授权通过、点歌人授权失效、房主授权失效与异常回滚分支

## Comments

### 实现说明
1. **双授权强核验与安全隔离**：
   - 在 `PublicPlaylists.requestSong` 中，严格先校验点歌成员自身的网易云授权有效性（`status === 'active'` 且与 `personal_playlist_binding.accountId` 严格一致）；接着校验目标房间房主的网易云授权（`status === 'active'` 且解密有效）；
   - 在调度执行阶段（`#claimSongRequest` 与 `#executeSongRequest`）：
     - 来源实时核验：使用点歌成员本人的网易云凭据调用 `playlistDetail` 读取来源歌单与歌曲存在性；
     - 公共目标写入：使用房间房主的网易云凭据调用 `trackAdd` 写入公共歌单；
     - 写后读回与确认：使用房主凭据读回公共歌单最新快照。
2. **点歌人标签与去重**：
   - 歌曲确认存在于公共歌单后（无论是新增还是原本已存在），在事务中将该歌曲打上点歌成员当前昵称的 `requesterTag`；
   - 公共已有歌曲时，不重复调用 `trackAdd`，幂等追加/保留成员点歌标签。
3. **测试覆盖**：
   - `src/operations/public-song-requests.test.ts`（26 个测试全部通过）；
   - `src/http/public-song-requests-http.test.ts`（2 个 HTTP 集成测试全部通过）；
   - `src/operations/security-upstream-matrix.test.ts`、`public-playlist-replacement.test.ts`、`member-leave-removal.test.ts`、`public-playlists-reconfiguration.test.ts` 等关联矩阵测试全部适配通过；
   - 全仓库 51 个测试套件共 572 个测试全部通过；客户端与服务端生产构建零错误。

