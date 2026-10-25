---
date: 2026-10-25
dependency: iterations/bugfix-batch-20261025/prd.md
---

# mc-tag-leak-to-bubble Bug PRD

## 背景

magic-context（下称 MC）要求模型每条回复以 `§N§ ` 打头作为自标注。上游在持久化边界把该标注剥掉；omz 移植时保留了打标却没有接剥离，于是标签原样落库并渲染到气泡。主线升级到上游 v3.16.2 后修过一次；整体回滚到 v1.0.20 后发现该缺陷在回滚基线中同样存在，需要单独迁回。

## 现象描述

- assistant 回复正文以 `§3017§` 之类标记开头，直接显示在气泡里；同一会话内还可能叠加成两段。
- 复制回复、会话列表预览、会话内搜索、CLI 恢复会话的 transcript 都带这串标记。
- 用户消息不受影响（不会被打标）。

## 复现步骤

1. 在 v1.0.20 上开任意会话，让模型正常回复。
2. 观察气泡首行；点复制粘贴到编辑器；看侧栏会话预览；在会话内搜索正文。

## 预期行为

`§N§` 只在 MC 内部作为锚点使用，任何用户可见文本（气泡、复制、预览、搜索、transcript）都不应出现。

## 实际行为

`stripPersistedAssistantText` 在 v1.0.20 的 MC 包内只有定义、零调用点（`apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/tag-content-primitives.ts:95`）；落库写入点 `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts` 直接写 `state.modelResponse` 原文。

## 影响范围

所有 assistant 文本的落库与消费路径：气泡正文、复制、会话预览、会话内搜索、CLI transcript。用户输入、工具结果、slash 命令不受影响。

## 验收标准

1. 新回复落库后正文不含 `§N§`。
2. 历史消息（库里已带标记的）在气泡、复制、预览、搜索、transcript 中均不显示标记。
3. 用户消息复制保持原样（不做剥离）。
4. `test:magic-context-tag-strip` 10/10 通过。

## 回归测试要点

- 剥离只作用于 assistant 文本，不得套到用户输入/工具参数上。
- `§5.1`、`99 files` 这类合法文本不得被误删（正则精度守卫）。
- MC 打标语义不变：`test:magic-context`（turn-transform）23/23。
