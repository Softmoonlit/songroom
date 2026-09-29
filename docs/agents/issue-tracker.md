# Issue tracker：本地 Markdown

本仓库的 Issue 和 spec 存放在 `.scratch/` 中。

## 约定

- 每个 feature 使用一个目录：`.scratch/<feature-slug>/`
- spec 文件为 `.scratch/<feature-slug>/spec.md`
- 实现 Issue 按 ticket 分文件存放于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- ticket 编号从 `01` 开始，不能使用合并的 tickets 文件
- triage 状态记录在 Issue 文件顶部附近的 `Status:` 行中
- 评论和对话历史追加在文件底部的 `## Comments` 标题下

## 发布 Issue

当技能要求“发布到 Issue tracker”时，在 `.scratch/<feature-slug>/` 下创建文件；必要时先创建目录。

## 获取 Issue

当技能要求“获取相关 ticket”时，读取用户提供的文件路径或 Issue 编号对应的文件。
