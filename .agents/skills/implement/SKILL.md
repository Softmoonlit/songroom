---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

交付前必须同步更新相关本地 Issue：按实际完成情况勾选验收项、更新 `Status:`，并在 `## Comments` 下记录实现提交、实际验证结果和剩余事项。状态遵循 `docs/agents/triage-labels.md`：尚需评审或验证存在未解决事项时使用 `need-review`；所需验证与评审完成后使用 `resolved`。不能只在聊天中报告完成而保留旧状态。

Commit your work to the current branch.
