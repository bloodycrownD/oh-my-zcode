---
date: 2026-10-24
dependency: iterations/backlog-sweep/spec.md
---

# mc-tag-leak-to-bubble Bug PRD

## 背景

Magic Context（下称 MC）以 turn transform 端口接入 omz，其提示词要求模型「每条回复的文本以恰好 `§N§` 加一个空格开头」（`apps/zcode-cli/packages/magic-context/src/core/agents/magic-context-prompt.ts:190-191`，中文镜像 `bootstrap/src/app/magic-context-prompt-section-zh-cn.ts:156-158`），这是给下一轮上下文打标签用的内部约定。上游在持久化边界会把该前缀剥掉（`.reference/magic-context/packages/plugin/src/hooks/magic-context/text-complete.ts:27-35` 调用 `tag-content-primitives.ts:95-104` 的 `stripPersistedAssistantText`），因此上游宿主的界面从未出现过这串标记。

omz 移植 MC 时把 `stripPersistedAssistantText` 一起搬进了 vendored 包，但**从未接入任何调用链**（全仓零调用点、包入口也未导出），落库与显示两侧都不做清洗。

## 现象描述

助手气泡正文开头原样显示 MC 的内部标记，用户看到例如：

```
§3017§ §3017§ 直接回答：没有完全没开发的上游面了
```

多数回复是单标记，少数是同号重复（模型自己写了一个、MC transform 的 `prependTag` 又打了一个）。

## 复现步骤

1. 任意会话开启 MC（`ctx_reduce` 可调用即会注入 SELF_TAG 段）。
2. 正常提问，阅读助手回复。
3. 重复若干轮后出现 `§N§` 前缀；对已含前缀的条目，MC 再打标不会消掉模型自己写的那一个，偶发出现 `§N§ §N§` 同号重复。

## 预期行为

气泡正文、复制出去的内容、会话列表预览、会话内查找、CLI transcript 里都不出现 MC 的内部标记；数据库里新产生的助手正文也不应再带该前缀。

## 实际行为

- 显示：`packages/ui/src/v4/ConversationRowView.tsx` 的 `visibleText` 直接取行原文，无清洗。
- 复制：复制按钮的 `text={copyText ?? row.text}` 亦为原文（`ConversationRowView.tsx:203-232 / :1657-1663`）。
- 预览/查找/transcript：`sessions-index-projection.ts:28-40`、`conversationFindIndex.ts:58-64`、`session-transcript.ts:82-96` 同样复用原文。
- 落库：`core/src/runtime/methods/turn-model-step.ts:495-510` → `message-persistence.ts:354-371` 直写原文。

实测影响（只读查询 `~/.omz/cli/db/db.sqlite`）：assistant 文本 part 以 `§N§ ` 开头 **9,522 条，覆盖 390 个会话（总会话 636）**，时间自 2026-10-09 起；双前缀 **6 条 / 4 个会话**。user 文本 part 零命中。

## 影响范围

- 用户可见：所有历史会话的助手正文、复制内容、会话预览、查找结果、CLI transcript。
- 不影响：用户自己输入的内容（user part 无该前缀，且用户气泡刻意不剥，避免吃掉用户正文里的「§5 节」这类合法引用）。
- 不影响：MC 自身的 `§` 打标体系（存储层的 `§N§` 是 MC 的身份/缓存锚，本次只剥模型抄进正文的可见前缀）。

## 验收标准

1. `§3017§ §3017§ 直接回答` → `直接回答`；`§42§ Hello` → `Hello`；畸形 hybrid `§15298">§ hello` → `hello`；悬空 `§103012$ hi` → `hi`。
2. 合法前导数字不被误剥：`99 files`、`2024 roadmap`、`1. do this now` 原样保留。
3. `stripMagicContextTagPrefix` 只剥开头，正文中间的 `§12§` 保留（供局部调用）。
4. 新产生的助手正文落库前已剥（core 落库点用同一函数）。
5. 气泡、复制、会话预览、查找、CLI transcript 五处消费端均剥。

## 回归测试要点

- `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-tag-strip.mjs`（10 个用例，含上述全部断言 + 五个落点的源码形状断言）。
- 既有 MC 套件不得回归：`test-magic-context-turn-transform.mjs`（23/23）、`test-mc-entry-identity-guard.mjs`（4/4）。
- 类型检查：`pnpm exec tsc -b packages/ui` 零 error；`apps/zcode-cli` 的 turbo typecheck 27/27。
