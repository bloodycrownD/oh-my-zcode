# spec 缺陷①②③锚点核验证据包（bugfix-batch-20261009）

- 取证代理：evidence（只读取证，未改动任何仓库文件）
- 仓库根：`D:\Dev\Js\oh-my-zcode\omz`
- 待核对文档：`docs/iterations/bugfix-batch-20261009/spec.md`
- 核验方式：逐锚点 Read 原文 + findstr 关键词交叉验证
- 核验日期：2026-10-09

## 总览

- 核对锚点合计 **18 个**：命中 **18**，行号偏移 **0**，失效 **0**
- 与 spec 冲突：**0 项**（补充「延伸核对」见各节末尾，均为 spec 未列但影响修复判断的事实）

---

## 缺陷①：编辑重发 + 模型侧闭环（7/7 命中）

| # | spec 锚点 | spec 描述 | 核验结果 | 实际代码摘要 |
|---|---|---|---|---|
| 1 | `packages/shared/src/zcode-protocol-v4/command.ts:131-137` | editUserQuery 无 modelSelection；对照 sendText :93 有 | **命中** | `:131-137` editUserQuery = `z.object({ target, newText, attachments?, workspaceMode?(["preserve","rewind"])? })`，无 modelSelection；对照 `:93 sendText` 内确有 `modelSelection: modelSelectionSchema.optional()` |
| 2 | `bootstrap/src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts:337-379` | intent 重建；:357 复用 intent.modelSelection | **命中** | `:337-379` `startCanonicalIntent()`；`:346` `inputIntentMetadataFromCanonical(envelope, {...})` 重建 intent；`:357` `modelSelection: editTarget.intent.modelSelection`（直接复用旧 intent 快照，无 payload 覆盖入口） |
| 3 | `core/src/runtime/methods/turn-model.ts:47-50` | 非 execution scope 写回 sessionModelSelection + persist | **命中** | `:47` `if (modelExecution?.selectionScope !== "execution") {` → `:49` `runtime.setSessionModelSelection(appliedSelection)` → `:50` `await persistRuntimeModelSelection(runtime, appliedSelection)`（即 intent 继承的快照也会被静默写回+持久化） |
| 4 | `bootstrap/src/app/process-provider-registry-runtime.ts:82-86` | 默认模型进程启动读一次 | **命中** | `:82` `new NodeModelSelectionConfigRepository({ personalRepository })`；`:86` `const configuredDefaultModelSelection = await modelSelectionConfigRepository.read()`；结果经 `:87-96` freeze 进返回对象，此后无 onDidChange 订阅 |
| 5 | `packages/ui/src/prompt-editor/ChatPromptEditor.tsx:211-217` | onSubmit 用 getMarkdown() ?? latestTextRef 回退 | **命中** | `:211-217` `handleSubmit`；`:214` `onSubmit(resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current)`（Lexical API 可得时提交 getMarkdown()，否则回退 latestTextRef） |
| 6a | `bootstrap/.../session-flow.ts:396-407`（waitForSessionIdle 判据） | 空闲轮询判据 | **命中** | `:396-407` 函数体；判据在 `:398-401` while 条件：`record.activeAbortController !== undefined \|\| record.app.runtime?.getActiveForegroundExecutionId?.() !== undefined` |
| 6b | `bootstrap/.../session-flow.ts:419-427`（preemptActiveTurnAndWait 判据，spec 称不一致） | 抢占触发判据 | **命中，且实测不一致成立** | 函数实际跨 `:410-438`；`:419` `const bootstrapAbortController = record.activeAbortController`；`:423-426` `record.app.runtime?.stopActiveForegroundExecution?.({...})`；`:427` 判据 `if (bootstrapAbortController \|\| runtimeStop?.kind === "stopped")`——**未调用 getActiveForegroundExecutionId**，仅依赖 stop 返回值 |
| 7 | `core/src/runtime/methods/turn.ts:97-100` | intent.modelSelection ?? getSessionModelSelection 冻结注释 | **命中** | `:97-99` 注释「在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮」；`:100` `const admittedModelSelection = options?.intent?.modelSelection ?? this.getSessionModelSelection()` |

**延伸核对（spec 未列、影响 1e）**：
- `session-flow.ts:419-422` 注释自述「background notification 的 model-only turn 由 Core runtime command 独立持有 foreground authority，**不会创建 Bootstrap activeAbortController**」——即 :419 线索天然为空档，唯一补偿是 :423 stopActiveForegroundExecution 的返回值；若其返回非 "stopped" kind（如 noop/undefined），:427 判据为 false，跳过 pause/abort，直接落 `:436 waitForSessionIdle` 轮询至 `:403` 抛 `V4SessionIdleTimeoutError`。两个判据形状（轮询查询 vs stop 返回值）确实不对称，spec 1e「补 `runtime.getActiveForegroundExecutionId() !== undefined` 对齐 :396-407」的修复指向真实存在。
- `fork-edit-retry.ts:5` 附近确有「retryTurn 故意重发原文」注释（spec「现状约束」引述），1c 仅针对 editUserQuery 路径，不触碰该语义。
- `turn-model.ts:47-61` 非 execution 分支除写回外还 emitModelSelected（diff 时）；1d 收窄条件时需连本块一并考虑。

---

## 缺陷②：切会话跳顶（5/5 命中）

| # | spec 锚点 | spec 描述 | 核验结果 | 实际代码摘要 |
|---|---|---|---|---|
| 1 | `packages/ui/src/v4/ConversationTimeline.tsx:1587-1655` | sessionKey effect；:1589 heightCacheRef.clear | **命中** | `:1587-1655` sessionKey `useLayoutEffect`（依赖含 sessionKey）；`:1589` `heightCacheRef.current?.clear()`（注释：rowId 跨会话可重复，切会话必须清空） |
| 2 | `ConversationTimeline.tsx:1071-1090` | scrollToBottom = element.scrollTop = scrollHeight | **命中** | `:1071-1090` `scrollToBottom` useCallback；`:1077` `element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight`（仅草稿空态钳 0，真实会话恒用 scrollHeight；:1070 注释要求 instant 禁止 smooth） |
| 3 | `ConversationTimeline.tsx:1778-1811` | 底部锚定 effect 依赖 totalSize | **命中** | `:1778-1811` 底部锚定 `useLayoutEffect`；依赖数组 `:1800-1811` 含 `totalSize`（:1810），并在 `:1794-1799` 按 following 判定 `stickToBottom` 时调 scrollToBottom |
| 4 | `packages/ui/src/v4/timelineRowHeightCache.ts` | DEFAULT_ROW_HEIGHT_ESTIMATE_PX=72、clear()、LRU 4000 | **命中** | `:11` `DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72`；`:14` `MAX_ROW_HEIGHT_CACHE_ENTRIES = 4000`（`:35-39` 按 Map 插入序淘汰最旧）；`:56-58` `clear()`；`:47-53` `estimate()` 回落估计值 |
| 5 | `packages/shared/src/zcode-protocol-v4/core.ts:75` | snapshotTailWindowRows=60 | **命中** | `:75` `snapshotTailWindowRows: 60,` |

**延伸核对（spec 未列）**：
- `ConversationTimeline.tsx:1657-1669` 另有一个「首批 rows 到达后重落地」的 useLayoutEffect（pendingDetachedScrollRestoreRef），2a 落点延迟 guard 需与之共存，避免双 restore 竞争。
- `:1596-1597` prepend 锚定基线也在同一 sessionKey effect 内按 sessionKey 重置，2b 缓存键加 sessionKey 前缀与既有分区思路同向。

---

## 缺陷③：前台子智能体手动关闭（6/6 命中）

| # | spec 锚点 | spec 描述 | 核验结果 | 实际代码摘要 |
|---|---|---|---|---|
| 1 | `packages/ui/src/v4/conversationStatusPanelModel.ts:334-344` | controlWork 未命中则无 controlWorkId | **命中** | `:334-344` runningSubagentWorks 映射；`:337` `subagentControlByChildSessionId.get(subagent.childSessionId)`；`:338` `if (!controlWork) return subagent`——直接返回原始 subagent，**无 controlWorkId、无回退 agentId** |
| 2 | `core/src/subagent/runner.ts:382-436` | 前台 run() catch 无 isTerminalRuntimeTask 早退 | **命中** | `:382-436` catch：`:389-397` registry.update 直接置 `status: "failed"`；`:398-412` emitSubagentEvent(SubagentStopped, `status: "failed"`)——catch 开头（:383-388 仅 watchdog.stop/artifact 写入）**无任何 isTerminalRuntimeTask / killed 判定**，终态会被覆写成 failed |
| 3 | `runner.ts:547-566` | stopTask 存在且不检查 isBackgrounded | **命中** | `:547-566` stopTask：`:554-555` get+type 校验；`:556` `if (isTerminalRuntimeTask(task)) return task`（仅已终态早退）；`:558` createBackgroundStoppedTask → `:560-565` abort——**全函数无 isBackgrounded 判断**，前台 local_agent 也可停（3a/3b 链路可用的前提成立） |
| 4 | `runner.ts:1170-1186` | 同步完成输出对象无 childSessionId | **命中** | `:1170-1186` `const output: AgentCompletedOutput = { status, agentId, agentType, description, prompt, content, totalToolUseCount, totalDurationMs, totalTokens?, usage? }`——**无 childSessionId 字段** |
| 5 | `runner.ts:806` | childSessionId = createSessionId("subagent_"+agentId) | **命中** | `:806` `const childSessionId = createSessionId(\`subagent_${agentId}\`)`（lifecycle 内已生成；:406 SubagentStopped 事件已在携带） |
| 6 | `packages/ui/src/app-shell/SubagentDirectorySidePane.tsx` | 无取消通道/未传 onCancelBackgroundWork | **命中** | 全文 211 行；findstr `onCancelBackgroundWork/onCancel/cancelBackgroundWork/cancellable` **零命中**；主组件 props 仅 `{ tab, onOpenSubagentSession }`（:104-110）；DirectoryRow props 仅 `{ item, onOpen }`（:64-70），行内仅一个打开按钮（:74-100），无停止入口 |

**延伸核对（spec 未列，证明 3c「透传已有 handler」成立）**：
- `SessionPane.tsx:1546-1558` 已有 `handleCancelBackgroundWork`（`dispatchCommand("cancelBackgroundWork", { workId }, sessionId)`，readOnly 场景不下发）。
- `SessionPane.tsx:1625` 与 `:3572` 两处均以 `onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}` 透传：:3572 的接收方为 `<ConversationStatusPanel>`（:3519 起）。即取消通道在主面板链路已闭环，唯 SubagentDirectorySidePane 独占缺失，spec 3c 论断与实测一致。
- `:3531` `runningSubagents={subagents.running}` 即供给 conversationStatusPanelModel 的 `input.runningSubagents`，3a 回退所需字段（subagent.agentId）来源存在。

---

## 与 spec 冲突/偏移清单

- **失效锚点**：无（18/18 全部命中）。
- **行号偏移**：无。所有引用范围均精确覆盖所述代码；三个「延伸发现」均为 spec 未引用的邻域事实，非偏移。
- **与 spec 描述冲突**：无。
- **需执行方注意的非冲突性补充**（不影响 spec 结论，但影响改动面）：
  1. `runner.ts:556` 已存在 `isTerminalRuntimeTask(task)` 早退（stopTask 内），3b 是在 catch（:382-436 前台路径）补同类早退——注意 stopTask 的该早退防止的是「重复停」，catch 需要的是「防终态覆写」，语义不同、不可直接照搬代码。
  2. `turn-model.ts:49-60` 非 execution 分支是「写回 + persist + emitModelSelected」三连；1d 收窄时连同 emit 条件一起评估，仅去掉写回会残留事件面不一致。
  3. `session-flow.ts` preemptActiveTurnAndWait 函数体实为 `:410-438`，spec 引用的 `:419-427` 只覆盖函数头到触发判据行（:427 是判据本体），语义引用准确。
  4. `ConversationTimeline.tsx:1657-1669` 存在第二批 rows 到达后的二次 restore，2a 新增 guard 需与之共存。
  5. `fork-edit-retry.ts:337-379` 中 intent 重建是 `inputIntentMetadataFromCanonical` 调用（:346-364）整块字段复制，1c 注入 `payload.modelSelection ?? 原快照` 时落在 :357 单一字段即可。

## 结论

spec 缺陷①②③引用的全部 18 个 file:line 锚点**逐一命中、零失效、零偏移**；spec 对三处关键缺失的断言（editUserQuery 无 modelSelection 字段、preempt 判据与 waitForSessionIdle 不对称、runner catch 无终态早退、runner:1170-1186 无 childSessionId、目录页无取消通道）均与代码实证一致，可直接作为修复依据。
