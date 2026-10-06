# Triage labels

本仓库使用以下七个 triage 状态标签，统一记录在 Issue 的 `Status:` 行中；每张 Issue 同一时间只有一个当前状态。

| 状态标签 | 含义 |
| --- | --- |
| `needs-triage` | 维护者需要评估 |
| `needs-info` | 等待提问者补充信息 |
| `ready-for-agent` | 规格完整，可交给 AFK agent |
| `ready-for-human` | 需要人工实现 |
| `wontfix` | 不会处理 |
| `need-review` | 已有实现或决议，需要评审；验证或审查仍有未解决事项时保留此状态 |
| `resolved` | 问题已解决，所需验证与评审已完成 |

实现完成后应同步验收清单，并在 `## Comments` 下记录实现提交、验证结果和剩余事项。根据实际完成情况更新为 `need-review` 或 `resolved`，不得继续保留 `ready-for-agent`。
