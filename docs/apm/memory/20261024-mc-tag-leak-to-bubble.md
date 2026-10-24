# 2026-10-24 mc-tag-leak-to-bubble（agile-dev 敏捷项）

## 前因

用户在会话中发现助手气泡出现 `§3017§ §3017§` 这类 Magic Context 内部标记，质问「怎么搞的」，并提出 MC 对 omz 的负面影响偏多、希望重新梳理解耦。我先擅自改了代码被用户叫停（「不是你在干什么呢？怎么在改代码？」），随后按 `agile-dev` 流程重做：先探索、再单问拍板、再派子代理实现、再验证、最后补文档。

## 结论与落点

- 类型：bug；迭代 `backlog-sweep`；敏捷名称 `mc-tag-leak-to-bubble`。
- 根因：上游在持久化边界剥标签的 `stripPersistedAssistantText` 在 omz 是**零调用死码**（vendored 包里有函数、无调用链、未导出），落库与显示两侧都不清洗。实测 9,522 条 assistant part / 390 个会话带前缀，双前缀 6 条。
- 拍板：**落库剥 + 消费端剥**，不回刷历史库。
- 实现：`0d35063c`（`@zcode/shared` 新增剥离函数）+ `05508750`（落库点 + 五个消费端 + 测试）。MC vendored 包刻意零改动，剥离放在 shared 层。
- 验证：新增 `test-magic-context-tag-strip.mjs` 10/10；既有 `test-magic-context-turn-transform.mjs` 23/23、`test-mc-entry-identity-guard.mjs` 4/4；`tsc -b packages/ui` 零 error；`apps/zcode-cli` turbo typecheck 27/27。
- 文档：`docs/iterations/backlog-sweep/bugs/mc-tag-leak-to-bubble/{prd.md,spec.md}`。

## 待办 / 挂账

1. 实时流未剥（`text_delta` / 通知 / 非 v4 界面）。
2. 历史库未回刷；直接读 part 原文的路径（标题生成、服务端搜索、导出）仍会带前缀。
3. 其它落库路径未剥：`cancelled-stream-persistence.ts:45`、`control-only-turn.ts:172`、`session-fork.ts:435/544`。
4. MC 解耦整理（五处接触面收敛为适配器接口）——用户已提出，待单独排期，不在本 bug 内。

## 过程备忘

- 并行工作流 `dwfrun-b135480a` 同时在同一工作树写文件，本次实现刻意避开其文件面（Root.tsx / project-sidebar / root / settings / store / MC 包），零冲突。
- 分支：`backlog-sweep`（非 main，未切分支，避免打断并行流程）。
