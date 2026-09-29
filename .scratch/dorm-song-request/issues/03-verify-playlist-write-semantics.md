# 验证点歌歌单写入语义

Type: prototype
Status: resolved
Assignee: Codex
Blocked by: 01

## Question

在房主真实网易云账号和专用测试歌单上，Enhanced 能否可靠实现“新歌加入第一位、已有歌曲移到第一位、房主删除/清空/任意排序”，并在合理歌单规模、连续操作和接口失败时得到可校验的最终云端状态？

原型必须查清排序请求的完整参数语义、歌曲数量限制、重复 ID 行为、写后读取延迟、登录失效和频率限制，并把可复现步骤与结果作为票据资产链接，而不是构建正式产品。

## Answer

### 已证实

- Enhanced `4.40.1` 在房主真实账号的专用隐私测试歌单上可以实现新歌置顶、已有歌曲置顶、指定删除、清空和任意排序；200 首完整反转与间隔 1 秒的 10 次连续完整排序均精确收敛。
- 单首新歌通过 `playlist_tracks(add)` 原生加入第一位；多首批量加入则会把请求序列反向后放到歌单首部。为获得确定顺序，新增后仍须提交完整目标序列并回读。
- `song_order_update` 只有提交完整唯一 ID 序列时才可靠。只提交子集会返回 `200` 但不改变顺序；重复 ID 会返回 `200` 并被云端去重。因此不能把响应码当作成功判据。
- 对已有歌曲再次调用添加接口返回 `502`，云端保持单一副本。点歌必须先根据最新快照区分新增与已有：新增执行“添加 + 完整排序”，已有只执行完整排序。
- 19 次带精确预期的写后读取都在第一次读取时看到目标状态。从写响应返回到完整回读校验的延迟为 194-528 ms，中位数 384 ms，P95 528 ms；本次没有观察到陈旧读取。
- 无效 Cookie 写入返回 `301` 且没有改变歌单；无效歌单返回 `404`。`301` 必须停止写入并要求房主重新扫码。
- 网易云网页自身以 `trackCount + size > 10000` 判定“歌单已满”，平台歌单上限为 10000 首；本原型实际验证的稳定规模为 200 首。
- 实验结束后独立回读专用测试歌单，`trackCount` 与 `trackIds` 长度均为 0。

### 未证实

- 大于 200 首、尤其接近 10000 首时，完整排序请求的大小、延迟与稳定性没有实测。
- 没有在真实主账号上主动压测至限流，因此 `playlist_tracks` 与 `song_order_update` 的精确限流阈值未知。每秒一次是本次连续测试通过的保守工作点，不是平台阈值。
- Cookie 的自然过期时长以及不同失效原因是否都返回 `301` 未验证。
- 并发写入的覆盖顺序未验证，留给“决定并发与失败一致性”处理。

### 不可依赖

- 不能只凭接口 `200` 判断写入成功，必须回读完整 `trackIds` 并与本地目标序列逐项比较。
- 不能把重复添加视为幂等成功；实测为 `502`。
- 不能承诺固定限流阈值。公开案例显示约 200 次连续创建歌单后出现 `405 操作过于频繁` 并持续约两天，说明限制可能按操作动态变化。

MVP 因此必须按房间串行写入；每次基于完整云端快照计算唯一目标序列；写后读取直到精确匹配或超时；遇到 `301`、`404`、`405`、`-462` 或其他风控错误时停止盲目重试并进入对应恢复流程。首版只能把 200 首视为已验证规模。

## Evidence

- 原型资产：分支 `prototype/verify-playlist-write-semantics`，提交 `0f8ed954403c466721df145bd1bc15719f8000f2`，入口 `prototypes/verify-playlist-write-semantics/README.md`，脱敏原始结果 `results.json`。
- Enhanced [`song_order_update.js`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/a8c781fd64faab17fedfd46e0615a2609307f163/module/song_order_update.js) 与 [`playlist_tracks.js`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/a8c781fd64faab17fedfd46e0615a2609307f163/module/playlist_tracks.js)。
- 网易云音乐[网页模板](https://music.163.com/member)中的 10000 首歌单满额判断。
- Enhanced [Issue 158](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/issues/158) 的操作频繁案例。
