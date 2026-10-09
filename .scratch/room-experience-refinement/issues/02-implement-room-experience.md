# 实现房间体验修订

Type: implementation
Status: need-review

## 范围

用户已确认[完整规格](../spec.md)，实施全站降噪、两端整页滚动、歌单名称同步、播放指示与定位、受限“下一首播放”及直接搜索每页 20 首和加载更多。不提供拖动或任意位置排序。

## 验收清单

- [x] 全站信息层级、移除信息按钮与昵称去重复。
- [x] 手机和桌面单一窗口滚动、虚拟列表与位置恢复。
- [x] 歌单名称同步且旧读取不覆盖新绑定。
- [x] 播放记录同账号合并、30 秒可见更新、手动同步与空/失败禁用状态。
- [x] 下一首播放的成员权限、冲突、集合保持、幂等及只读恢复。
- [x] 直接搜索 20 首分页、追加去重、失败重试及新轮隔离。
- [x] 受审 vendor 来源、完整性与真实请求层离线契约验证。
- [x] 类型、构建、相关服务与浏览器测试通过。
- [ ] 专用歌单真实接口语义与更新延迟验收（待在线网易云真实凭据验证）。
- [x] 代码审查完成，记录实际验证和剩余事项。

## Comments

### 后端播放与持久下一首实现

已接入 `GET /api/rooms/:roomId/public-playlist/playback`、`POST /api/rooms/:roomId/public-playlist/playback/refresh`、`POST /api/rooms/:roomId/public-playlist/play-next` 和按成员定域的操作查询接口。共享契约导出 `playbackView`、`playNextCommand`、`playNextResponse`、`playNextOperationView`。播放记录按真实账号共享并缓存 30 秒，绑定授权 id/generation 隔离；歌单无匹配时返回 `songId: null`，读取失败清除可用指示。下一首操作持久保存点击歌曲、锚点、原顺序、目标顺序、绑定 generation 和恢复轮次，发送边界只允许一次 `trackOrder`，未知结果只读确认并按 5 秒、30 秒、2 分钟补查；成员退出、房间删除、授权撤销和重新授权均接入旧结果隔离与恢复路径。

统一快照提交现在在有效绑定范围内保存网易云最新歌单名称，并用单调 `lastReadStartedAt` 拒绝旧读回覆盖较新结果或新授权。新增 schema 21 migration 和 `public_play_next` 业务表。

### 搜索分页、Vendor 完整性与全栈验证收敛

1. **直接搜索分页与限流保障**：搜索分页每页 20 首，去重追加，支持失败保留当前结果并明确重试；修复了 `song-search.test.ts` 中上游账号调度启动间隔（1000ms）导致 `expect.poll` 边界超时的等待设置。
2. **Vendor 完整性与离线契约**：补充了 vendor 模块 `record_recent_song` 与 `song_order_update`，更新了 `integrity.json` 和 `SOURCE.md`。修复了 `tests/netease/offline-adapter.ts` 循环请求头写入非 Latin-1 字符导致中文搜索词丢失的问题（改为 Base64 编码传递），`vendor-contract.test.ts` 28 项离线契约全部绿灯。
3. **前端体验与端到端适配**：
   - 窗口虚拟列表、桌面/手机单一窗口滚动、切页滚动恢复。
   - 播放状态指示、定位与“下一首播放”禁用及确认交互。
   - 全站信息降噪与无障碍合规。
   - 适配了 E2E 测试对 schemaVersion 21、公共歌单表头/胶囊文案及同步计数。
4. **验证结果**：
   - `pnpm --filter @songroom/app typecheck`：通过。
   - `pnpm --filter @songroom/app build`：通过。
   - `pnpm --filter @songroom/app test`：43 个测试文件，407 项测试全部通过。
   - `pnpm --filter @songroom/app exec playwright test`：149 项端到端浏览器测试在 320px/390px/900px/1440px 视口下全部通过。

### Code Review 审查整改收敛

1. **Spec 轴与时序保护**：
   - 修复了 `public-playlists.ts` 中歌单 status 异常分支下调用 `#recordRefreshError` 遗漏 `readStartedAt` 的问题，确保旧的异常返回受到单调时钟保护，不能覆盖较新的成功快照状态。
   - 复核并保留了 `song-search.ts` 中整页重复（`additions.length === 0`）终止分页的设计，防止上游空翻页造成空转与无谓请求。
2. **Standards 轴与领域表达**：
   - 重构了 `public-play-next.ts` 顶层关键辅助函数命名：`terminal` -> `isTerminalOperation`、`sent` -> `hasPassedWriteBoundary`、`same` -> `sameTrackOrder`、`delays` -> `CONFIRMATION_DELAYS_MS`。
   - 清理了 `public-play-next.ts` 中 `#awaitConfirmation` 计算当前轮次的冗余三元表达式。
3. **回归验证**：
   - `typecheck`、`build`、全部 43 个测试文件（407 项）、149 项 Playwright E2E 浏览器测试全部保持 100% 通过。

### 剩余事项

- 专用歌单真实网易云接口能力及延迟需在具备有效在线网易云账号的环境下进行真实上游验证。
- 状态保持为 `need-review`，等待在线验收与人工审查。
