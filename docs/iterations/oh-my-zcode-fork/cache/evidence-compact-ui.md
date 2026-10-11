---
轮次: 1
取证域: B — Phase 2b（压缩移除 + UI 配置面 + 用量显示）
被审文档: docs/iterations/oh-my-zcode-fork/spec.md
对照代码库: D:\Dev\Js\oh-my-zcode\.reference\ZCode
git HEAD: 29628c9acdb81b703bbd4080c207a0e7ce5e276e
日期: 2026-10-03
取证方式: 主代理手工取证（子代理三次网络失败后的失败处理回退；rg 定点核对，覆盖度见「未核实项」）
---

# 取证域 B 证据包：压缩移除 / UI 配置面 / 用量显示

## 0. 计数汇总

| 判定 | 条数 |
|---|---|
| 一致 | 18 |
| 不一致（差异/清单缺口） | 5 |
| 无法核实（本轮未覆盖） | 4 |

---

## 1. 断言核对表

### 1.1 压缩产生侧文件清单

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| B1 | 全量删除清单 | `core/src/compact/` 整目录（policy/prompt/manual/microcompact/rounds + index） | 一致 | 目录实含 6 文件：index/manual/microcompact/policy/prompt/rounds.ts |
| B2 | 全量删除清单 | `runtime/methods/{compact,compact-active,compact-active-helpers,compact-persistence,microcompact}.ts` 删 | **不一致（清单缺口）** | methods 下实含 **8** 个 compact 文件，spec 漏列 2 个：`compact-log-context.ts`（唯一消费者 `compact.ts:34`，应随删）；`context-usage-log-compact.ts`（消费者 `context-usage.ts:19` 的 `compactContextUsageSnapshot`——**context-usage.ts 属 D-13 保留面**，此处 compact 意为"精简快照"而非上下文压缩，**必须保留并列入防误删清单**） |
| B3 | 全量删除清单 | `runtime/helpers/{compact,compact-selection,compact-preservation,compact-post-reminders,compact-media}.ts` 删 | 一致 | helpers 下恰好 5 个 compact 文件，逐一命中 |
| B4 | Step 25 | `runCompactSummaryModelRequest` 更名保留、historian 复用 | 一致（前提成立） | 全部消费者仅 `compact-active.ts:62,412`（将被删）；该函数当前无 compact 之外的用户，"更名保留"即为其唯一存活理由，与 Step 20/25 的依赖关系自洽 |
| B5 | 同步删除清单 | SessionEventType 压缩枚举 6 成员 | 一致 | `session.events.ts:87 SessionCompacted`、`:158 CompactStarted`、`:159 CompactCompleted`、`:160 CompactFailed`、`:161 CompactBoundary`、`:162 MicrocompactBoundary`；payload 侧 `:210/:219/:631/:1179/:1235/:1238` |

### 1.2 contracts/src/compact 删除波及面（R11 核对点）

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| B6 | 同步删除清单 | contracts/src/compact 整目录删；消费方已覆盖 | **不一致（8 个消费文件漏列）** | `contracts/src/compact/index.ts` 导出 30+ 符号（CompactTrigger/Phase/Reason/Status/TimelineStatus/Display/FailureReason、compactTimelinePayloadSchema、compactPreservedSegmentSchema、compactBoundaryPayloadSchema、microcompactBoundaryPayloadSchema、CompactSummaryPayload、parseCompactBoundaryPayload、isCompactBoundaryItem、buildPostCompactItems、getItemsAfterLastCompactBoundary、annotateBoundaryWithPreservedSegment 等）。全仓消费者中 spec 明确列出的只覆盖一部分，**漏列**：`core/src/agent/read-file-state-hydrator.ts`、`core/src/runtime/methods/rewind-message.ts`、`core/src/runtime/methods/turn-loop-state.ts`、`core/src/runtime/internal-turn-methods.ts`、`core/src/runtime/helpers/conversation.ts`、`contracts/src/interfaces/session-store.port.ts`、`bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`、`bootstrap/src/zcode-protocol-v4/projection-rows.ts`（spec 仅以"投影层压缩分支"概括后两者） |

### 1.3 `part.type:"compaction"` 全部读写点

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| B7 | 同步删除清单 | compaction part 的全部读写点已覆盖 | **不一致（约 10 个文件漏列）** | 全仓 20 个文件含 `"compaction"` 字面量。spec 已列/间接覆盖：compact-session、session-history-hydrator、compact-persistence、zcode-session-visible-content、transcript-hydration、local-ttft-compaction、cold-event-merge、event-normalizer（推断）、localTtft（Phase 1 已删）。**漏列**：`adapters/src/storage/session-store/{sqlite-session-store.ts,codecs.ts}`（part 类型 union/编解码，属**编辑**非删除）、`dynamic-workflow/src/engine/types.ts`、`bootstrap/src/zcode-protocol/{session-mapper.ts,message-mapper.ts}`、`core/src/session-context/parts.ts`、`core/src/runtime/helpers/{steering.ts,rewind.ts}`、`core/src/runtime/methods/session-fork.ts`、`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`、`packages/shared/src/{conversation-message-projection-policy.ts,zcode-protocol-legacy-types.ts}` |

### 1.4 v4 协议契约行号

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| B8 | 同步删除清单 | rows.ts:332-340 / command.ts:150 / input-intent.ts:44-45 / fork.ts:27 / snapshot.ts:44/57/153/194 | 一致 | `rows.ts:334 type: z.literal("compact")`（区间 331-340 ✓）、`command.ts:150 compact: z.object({})`、`input-intent.ts:45 kind: z.enum([...,"compact"])`、`fork.ts:27 "guard.compactOperationLock"`、`snapshot.ts:44/57 "compact"`、`:153 compact: actionAvailabilitySchema` |
| B9 | R11 | `queueItemSchema` 继承 `conversationInputIntentSchema`；`expectedHeldQueueItemIds` 互斥 | 一致 | `snapshot.ts:209 queueItemSchema = conversationInputIntentSchema.extend({...})`（kind 枚举收窄的直接落点）；`command.ts:95/:142 expectedHeldQueueItemIds` |

### 1.5 UI 清单

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| B10 | UI 清理 | contextUsage.tsx:224/254-255 死 prop；display.tsx re-export；V4ComposerToolbar 透传 | 一致 | `:224 getContextCompressionCommand`、`:254-255` 两 prop；`display.tsx:48`；`V4ComposerToolbar.tsx:361/:381/:1020-1021` |
| B11 | UI 清理 | i18n 计数：contextCompaction 9 / contextOptimization 6 / chat.compact 3 | **部分一致** | zh-CN 实测：`contextCompaction` **8** 处、`contextOptimization` **5** 处（en-US 未测）；TUI `compacting/compacted/compactFailed` 3 处 ✓。计数小幅漂移，不改变"全删"结论 |
| B12 | 防误删甄别 | `formatCompactTokenNumber`/`formatCompactTokenCount` 是数字缩写 | 一致（且比 spec 更广） | 命中 6 文件：`contextUsage.tsx`、`ai-elements/context.tsx`、`tui/app-input-status.tsx`、`lib/tokenNumberFormat.ts`、`settings/model-provider-section/StartPlanCard.tsx`、`settings/usage-stats/usageStatsUiParts.tsx`——后两个设置页文件是 spec 未提及的防误删点 |
| B13 | D-13 | `autoCompactThresholdTokens` UI 零消费 | 一致 | 全仓仅 3 处：`shared/zcode-protocol-v4/snapshot.ts`（schema）、`bootstrap/.../product-projection.ts`（填充）、`bootstrap/.../zcode-protocol/v4-bridge.ts`——零 UI 消费者 |

### 1.6 UI 配置面（D-12）

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| B14 | D-12 | 插件 userConfig UI 存在但零使用者 | 一致 | 全仓 `plugin.json` 零 `userConfig` 声明（rg -l 无命中） |
| B15 | D-12 | 设置分区注册表 + 三 groupId | 一致 | `settingsPageConfig.ts:34 SettingsSectionGroupId = "basics"|"agentCapabilities"|"dataAndStats"`、`:42 groupId` 字段 |
| B16 | D-12 | patch 函数族 + atomicWriteJson 范式 | 一致 | `file-config.adapter.ts:222 updateUiLocaleInFileConfig`、`:240 updatePluginEnabledInFileConfig`、`:298 updatePluginOptionsInFileConfig`、`:598 atomicWriteJson` |
| B17 | D-12 | live push 仿制路径四锚点 | 一致（1 处行号待核） | `shared/zcode-protocol/index.ts:3604 workspaceUpdateInteractionPreferences`、`bootstrap/zcode-protocol/server.ts:628` case 分发、`zcodeAgentService.ts:1468` RPC 调用（spec 写的 `:3399 syncAppRuntimePreferences` 本轮未核行号，符号存在）、`app-runtime-preferences.ts:11 .strict()` |
| B18 | D-12 | config.json 无 watcher | 一致 | `config-factory.ts` 全文零 watch 命中 |
| B19 | D-13 | product-projection 的 usage.contextWindow 数据源 | 一致 | `product-projection.ts:242`（SessionUsageState["contextWindow"] 投影）、`:473-475` 状态注释 |

---

## 2. 可疑点清单（域 B）

1. **【高】删除清单文件缺口**（B2/B6/B7）：spec 三张清单合计漏列约 18 个受影响文件（8 个 contracts/compact 消费者 + 10 个 compaction part 读写点 + 2 个 methods 文件）。其中 `context-usage-log-compact.ts` 是**反向缺口**（被误当作删除面，实际必须保留）；`dynamic-workflow/src/engine/types.ts` 与 `zcodeTaskServiceAdapter.ts` 是 spec 完全未意识到的两个包（dynamic-workflow、services）的波及点。
2. **【中】`sqlite-session-store.ts`/`codecs.ts` 属"编辑"而非"删除"**：compaction part 类型在持久层编解码 union 中，需要从类型联合与 codec 分支中摘除——这类编辑型改动 spec 的清单体例（整删/修改二分）没有为它们设立条目。
3. **【低】i18n 计数漂移**（B11）：8/5 vs 9/6，不影响结论。
4. **【低】`zcodeAgentService.ts:3399` 行号未复核**（B17）。

## 3. 未核实项（域 B）

- SessionEventType 六枚举的**全部**消费点（event-reducer / TUI / projection 之外的散点）未做穷举——本轮仅核对了枚举定义与 spec 已列消费者；judge 可按需抽查。
- `SettingsPage.tsx:1649-1950` if/else 链、`useSettingService.ts:145-171` live 分支、`settingsNavigation.ts` 白名单——沿用上轮 UI 探索报告，本轮未重读。
- `goal-compact.ts` / `slash-commands.ts` 等产生侧文件——沿用上轮探索报告（其行号在域 A 包中部分交叉验证），本轮未重读。
- desktop 侧 compaction 引用（域 A 包已声明 desktop main 无压缩语义命中）。
