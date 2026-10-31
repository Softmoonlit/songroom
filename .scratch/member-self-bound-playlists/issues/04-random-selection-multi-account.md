# 04: 随机点歌多成员独立账号抽选与异常置灰

**What to build:** 房主在公共歌单发起「随机点歌」：抽选弹窗中展示房间所有成员，已绑定且授权正常的成员可勾选，未绑定个人歌单或授权失效的成员复选框自动置灰禁用并标注“未绑定歌单”或“授权失效”原因；预览执行时并发使用各个勾选成员自身的网易云凭据拉取最新歌曲快照，任一勾选成员歌单读取失败则整次抽选严格报错，不凭旧快照掩盖异常；抽选算法按成员尽量均分、全局去重并整组洗牌；确认替换时使用房主网易云授权对公共歌单批量清空并批量添加新歌曲，并按各歌曲最终来源成员正确写入点歌人标签。

**Blocked by:** 01: 成员端自选候选与自主绑定点歌来源, 03: 逐首点歌双授权核验与点歌人标签贯通

**Status:** resolved

## Acceptance criteria

- [x] 随机点歌可选成员列表中，每个成员附带字段：`hasPersonalPlaylist: boolean`, `authStatus: "active" | "waitingAuthorization" | "unbound"`, `canSelect: boolean`, `disabledReason: "NO_PLAYLIST" | "AUTH_INVALID" | null`
- [x] 「随机点歌」弹窗（`RandomReplacementDialog`）中，当成员 `canSelect === false` 时，复选框处于 disabled 状态，右侧分别展示灰色 `未绑定歌单` 或琥珀色 `授权失效` 状态标签
- [x] 随机选歌预览接口（`POST /api/rooms/:roomId/random-preview`）拒绝包含 `canSelect === false` 的成员
- [x] 随机预览执行时，使用各个勾选成员各自的网易云凭据拉取最新歌单曲目；调度器支持多账号并发执行只读内存任务
- [x] 若任一勾选成员的歌单临时读取失败（网络超时、频控或不可读），整次预览抛出 502 并明确指出失败成员与错误原因，绝不凭旧快照伪造结果
- [x] 抽选算法保持成员尽量均分、余数随机、跨成员去重并整组洗牌，不区分新旧歌曲
- [x] 确认替换（`POST /api/rooms/:roomId/random-replacement`）使用**房主网易云授权**批量清空当前公共歌单并批量添加本轮歌曲
- [x] 公共歌单批量替换成功后，清空旧标签，按本轮抽选最终来源成员为每首歌曲正确写入点歌人标签
- [x] 编写并通过多账号并发读取、异常置灰与批量替换集成测试

## Comments

### 实现说明
1. **成员列表契约与抽选资格判定**：
   - 在 `room-contracts.ts` 中为 `roomMember` 补充 `authStatus`（`active` | `waitingAuthorization` | `unbound`）、`canSelect: boolean` 与 `disabledReason`（`NO_PLAYLIST` | `AUTH_INVALID` | `null`）；
   - 在 `Rooms.readMembers` 中结合 `personalPlaylistBinding` 与各成员的 `neteaseAuthorization` 进行多维度校验计算，提供统一权威判定。
2. **随机点歌弹窗置灰与状态展示**：
   - `RandomReplacementDialog.tsx` 中 `eligibleMembers` 严格根据 `canSelect` 过滤全选与候选成员；
   - 对 `canSelect === false` 的成员，复选框置为 `disabled`，右侧根据 `disabledReason` 分别展示灰色 `未绑定歌单`（`NO_PLAYLIST`）或琥珀色 `授权失效`（`AUTH_INVALID`）标签；
   - `styles.css` 中增加对应的设计风格样式。
3. **预览执行与并发安全**：
   - `PublicRandomPreview.generate` 中强制拦截 `canSelect === false` 的成员请求（分别以 400 `MEMBER_PLAYLIST_NOT_CONFIGURED` 或 `MEMBER_AUTH_INVALID` 拒绝）；
   - 调度器多账号并发拉取各成员最新快照（`maxActive === 3`），任何成员歌单读取失败则直接 502 抛出明确异常，绝不凭旧快照伪造结果；
   - 确认替换由房主凭据执行批量清空与添加，并在事务中按歌曲最终来源成员写入点歌人标签。
4. **验证结果**：
   - `src/http/rooms.test.ts` 中补充覆盖了成员列表 `canSelect` 与 `disabledReason` 状态流转集成测试；
   - `src/operations/public-random-preview.test.ts` 中补充覆盖了预览接口对未配置歌单或授权失效成员的拦截测试；
   - 全仓库 51 个测试套件 574 个测试通过，生产构建顺利通过。

