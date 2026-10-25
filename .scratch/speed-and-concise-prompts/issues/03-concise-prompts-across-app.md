# Ticket 03: 全站状态提示与错误反馈精炼

Status: resolved

## 目标

全面清理整个网站中冗长、说教式、口语化或拟人化的状态提示文案，统一为干练、精简、专业的提示风格。

## 验收清单

- [x] `room-http.ts` 中的 `errorMessages` 词条全面精简。
- [x] `song-request-messages.ts` 中的点歌状态与错误提示全面精简（去除“遇到了一点小问题”、“小伙伴较多”、“请稍作休息”等）。
- [x] `random-replacement-messages.ts` 中的操作状态（banner）与错误提示全面精简。
- [x] `PublicPlaylistPane.tsx` 与 `PersonalPlaylistPane.tsx` 页面提示精简。
- [x] 同步更新受文案变更影响的测试用例断言，保证测试全绿。

## Comments

### 实现与验证记录
1. 精简 `random-replacement-messages.ts`：排队、移除、添加、打标、失败、终止等标题与描述全面精简降噪。
2. 精简 `song-request-messages.ts`：移除口语化说教，聚焦核心进度与动作。
3. 精简 `RandomReplacementDialog.tsx`：弹窗加载提示由「正在读取成员个人歌单并公平抽选歌曲…」精简为「正在抽选歌曲…」；失效提示精简。
4. `PublicPlaylistPane.tsx` 与 `PersonalPlaylistPane.tsx` 针对操作状态与禁用提示做了精炼修饰。
5. 单元测试与 E2E 测试全绿通过（545 个单元测试，206 个 E2E 测试全部通过）。
