---
round: r1
date: 2026-10-05
scope: phase-delta-apply / phase-memory-guard 取证
repo: D:\Dev\Js\oh-my-zcode\omz
docs:
  - docs/iterations/desktop-long-session-perf/prd.md
  - docs/iterations/desktop-long-session-perf/spec.md
files_read:
  - packages/shared/src/zcode-protocol-v4/apply.ts
  - packages/shared/src/zcode-protocol-v4/delta.ts
  - packages/shared/src/zcode-protocol-v4/snapshot.ts
  - packages/shared/src/zcode-protocol-v4/core.ts
  - packages/shared/src/zcode-protocol-v4/index.ts
  - packages/shared/tsconfig.json
  - packages/ui/src/v4/conversationProjectionStore.ts
  - packages/ui/src/v4/useConversationProjection.ts
  - packages/ui/src/v4/usePendingCommandRecovery.ts
  - packages/ui/src/v4/useTreemappingConversationMessage.ts
  - packages/ui/src/v4/pendingCommandRegistry.ts
  - packages/ui/src/v4/SessionPane.tsx
  - packages/ui/src/v4/ConversationTimeline.tsx
  - packages/ui/src/v4/conversationTurnRenderUnits.ts
  - packages/ui/src/v4/conversationTurnWorkSegments.ts
  - packages/ui/src/v4/conversationTimelineLiveTail.ts
  - packages/ui/src/v4/ConversationTurnGroup.tsx
  - packages/ui/src/lib/shikiHighlighter.ts
  - packages/ui/src/lib/memoryDiagnostics.ts
  - packages/ui/test/nonCliAcpRetirement.test.ts
  - packages/ui/tsconfig.json
  - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts
  - .oxlintrc.json
  - package.json
---

# SPEC phase-delta-apply / phase-memory-guard 取证包（r1）

只陈述代码事实，不下结论、不给 Go/No-Go。

---

## 1）SPEC 该章节写了什么（逐条摘要 + 章节定位）

### 1.1 总体方案 C1（spec.md:48-60）

| # | SPEC 断言 | 定位 |
|---|---|---|
| C1-a | `conversationProjectionStore.ts:722` 的 `applyConversationDeltas(current, deltas)` 改为 store 内持有 `createMutableConversationSnapshotAccumulator`（复用 `apply.ts:24-35`，不新写 apply 逻辑） | spec.md:50 |
| C1-b | copy-on-notify 三层换引用为**硬约束**：通知时产出新 `window` 数组 + 新 `rows` 对象 + 新 `snapshot` 外壳；**发布外壳副本而非 accumulator 本体**，理由是 `state.updated` 的 `Object.assign` 会原地改 `accumulator.snapshot` 顶层，直接发布会违反 `useSyncExternalStore` 的 getSnapshot 稳定契约 | spec.md:51 |
| C1-c | 统一 rebuild 入口，4 处强制 `rebuildAccumulator(nextSnapshot)`：snapshot 帧整体替换（`:666-671`）、`loadOlder`（`:1013-1017`）、`loadAllOlder`（`:1124`、`:1155`）；理由是 `mergeOlderRows` 返回新数组后 `rowIndexById` 全部失效，漏 rebuild = **静默内容错乱** | spec.md:52 |
| C1-d | `seq` 推进显式写 `accumulator.snapshot.seq = frame.toSeq`；`totalCount/firstRowId` 同步进新 rows 对象（`hasOlderRows` 依赖） | spec.md:53 |
| C1-e | `logSubagentProjectionTransition`（`:725`，唯一 snapshot 前后对比处）改为 apply 前抓取 `previousIds`，避免诊断能力退化 | spec.md:54 |
| C1-f | renderUnits 增量重建：store 通知时附带本次变更的 turnId/rowId 集合（`lastMutation`）；`ConversationTimeline` 维护 turnKey → built units 缓存（Map），只对 dirty turn 重算 `materializeDraftUnit`，未变 turn 复用缓存输出（输出仍为新数组，引用变化一次，计算量 O(dirty)） | spec.md:55-57 |
| C1-g | 说明段：copy-on-notify 后每通知帧仍有一次 O(N) 外壳拷贝，真正的渐近收益来自 renderUnits 增量化（每帧 O(N) 的 materializeDraftUnit 多次 filter/Set 才是大头）；备选双缓冲本期不做 | spec.md:60 |

### 1.2 Step 9 / 10 / 11（spec.md:144-146）

- Step 9 — phase-delta-apply — qa:auto：新增 `apply.test.ts` 等价性测试（随机 delta 序列下 `applyConversationDeltasMutable` ≡ `applyConversationDeltas`，含 `row.removed`/`state.updated` 边界）。
- Step 10 — phase-delta-apply — qa:auto：store 引入 accumulator + copy-on-notify 三层换引用 + 统一 `rebuildAccumulator` 四处调用 + `logSubagentProjectionTransition` 改 previousIds 快照。
- Step 11 — phase-delta-apply — qa:auto：renderUnits 增量重建（`lastMutation` 附带变更集 + turnKey 缓存 + 等价性测试）。

### 1.3 Step 19（spec.md:154）

- Step 19 — phase-memory-guard — blocking:no — qa:auto：`tokensCache` LRU（上限 500，命中刷新）。

### 1.4 T-AP1..T-AP4 / T-MG1（spec.md:165-173）

- T-AP1：等价性——随机 delta 序列（append/upsert/delta/state.updated/removed 混合）下 mutable 与 immutable 产出深相等（→ Step 9）。
- T-AP2：accumulator 在 `mergeOlderRows` 后 rebuild：后续 `row.delta` 写入正确位置（→ Step 10）。
- T-AP3：copy-on-notify 三层引用全换（window/rows/snapshot），通知间引用稳定（→ Step 10）。
- T-AP4：renderUnits 增量重建 ≡ 全量重建（同输入深相等）（→ Step 11）。
- T-MG1：`tokensCache` 超 500 条时淘汰最久未命中（→ Step 19）。

### 1.5 风险表相关行（spec.md:179-186）

- R-1（高）：accumulator 索引失效导致静默内容错乱（mergeOlderRows 后忘 rebuild）→ 缓解=统一 rebuild 入口 + 四处强制调用 + T-AP2；回滚=revert Step 10。
- R-2（中）：copy-on-notify 收益不达预期 → 缓解=Step 11 才是渐近收益主力。
- R-5（高）：`useSyncExternalStore` 契约违反（发布 accumulator 本体）→ 缓解=SPEC 钉死「发布外壳副本」+ T-AP3。
- R-6（中）：max-lines 门禁实际口径不明（transport.ts 等已超 400）→ Step 0 前置验证。

### 1.6 其他相关约束（spec.md:114 / :216-217）

- 「不动（明确排除）」：`apply.ts` 两个实现本体。
- 约束：`apply.ts`「已发布快照不可篡改」是服务端边界约定，renderer 改可变须发布外壳副本。

---

## 2）代码对应事实

### 2.1 apply.ts（全文 219 行）

| 符号 | 位置 | 事实 |
|---|---|---|
| `MutableConversationSnapshotAccumulator` | apply.ts:19-22 | `{ snapshot: ConversationSnapshot; rowIndexById: Map<number, number> }` |
| `createMutableConversationSnapshotAccumulator` | apply.ts:24-35 | 拷贝 window 数组（`[...snapshot.rows.window]`）；新建 snapshot 壳（`{...snapshot, rows: {...snapshot.rows, window}}`）；`rowIndexById` 由 window 逐项建。**浅拷贝**：非 rows 的顶层值（queue/subagents/backgroundWorks/workflowRuns/…）与入参 snapshot 共享引用 |
| `applyConversationDelta`（不可变版） | apply.ts:68-135 | 每个 op 都返回**新** snapshot：`row.appended` 新 window 数组 + `totalCount+1` + `firstRowId ?? row.rowId`(:80)；`row.upserted` 用 `findIndex`，未命中 return 原 snapshot（no-op）(:84-89)；`row.removed` 用 `filter(rowId < fromRowId)`，并在 `removesEntireActiveBranch` 时把 totalCount 清 0、firstRowId 置 null(:91-109)；`row.delta` findIndex + `appendToRow`(:111-118)；`state.updated` = `{...snapshot, ...delta.patch}`（顶层展开，键级整体替换，无深合并）(:119-121)；`workflowRun.*` 转调 workflow-runs-delta.ts 纯函数 |
| `applyConversationDeltas` | apply.ts:138-147 | 顺序 fold，每次产出新对象 |
| `applyConversationDeltaMutable`（可变版） | apply.ts:153-210 | 原地改：`row.appended` `rowIndexById.set(rowId, window.length)` + `push` + `totalCount += 1` + `firstRowId ??=`(:159-164)；`row.upserted` 从 map 取 index，undefined 直接 return(:165-170)；`row.removed` 原地紧凑化（writeIndex）后 `rowIndexById.clear()` + 全量重建索引(:171-189，O(N))；`row.delta` 从 map 取 index，并对 `target === undefined` 二次防御(:190-197)；**`state.updated` 用 `Object.assign(snapshot, delta.patch)`（apply.ts:200）——原地改 accumulator.snapshot 的顶层键**；`workflowRun.*` 赋新容器 |
| `applyConversationDeltasMutable` | apply.ts:213-218 | 顺序原地 fold |

补充事实（与 SPEC 判定相关）：

- **export 面已就绪**：`packages/shared/src/zcode-protocol-v4/index.ts:33` 有 `export * from "./apply.js";` → renderer 可直接 `import { createMutableConversationSnapshotAccumulator, applyConversationDeltasMutable } from "@zcode/shared/zcode-protocol-v4"`，无需改 apply.ts。SPEC「不动 apply.ts 两个实现本体」可成立。
- **`state.updated` 的 patch 键集合封闭且不含 `rows`/`seq`/`logEpoch`**：`statePatchSchema`（delta.ts:39-61）只含 revision/control/sharedContextImport/availability/inputRouting/meta/config/modelTransition/usage/queue/pendingInteractions/pendingCommands/backgroundWorks/subagents/workflowRuns/goal/plan/workspaceHookAdmission。故 `Object.assign` 不可能覆盖 window/seq。SPEC 未引用这条不变量，但 accumulator 的正确性依赖它。
- **服务端已有同款先例**：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
  - `beginHydrationReplay()` :1020-1025 —— `this.hydrationAccumulator = createMutableConversationSnapshotAccumulator(this.snapshot); this.snapshot = acc.snapshot; this.rowIndexById = acc.rowIndexById;`（原地接管，仅在未发布候选上）
  - `applyHydrationEvent` :1027-1030 → `applyEventInternal(event, false)`
  - `applyEventInternal` :1084-1094 —— 有 accumulator 走 `applyConversationDeltasMutable(...)` + `this.snapshot.seq = event.sequenceNumber`；否则走不可变 `applyConversationDeltas` + `updateRowIndexAfterImmutableApply(...)`
  - `completeHydrationReplay()` :1036-1042 清 accumulator 后才由 publisher adopt
  → SPEC 的隔离边界叙事与服务端现状一致；`seq` 显式推进（product-projection.ts:1086）与 C1-d 写法一致。

### 2.2 conversationProjectionStore.ts（实际 1384 行）

| SPEC 引用 | 代码事实 | 判定 |
|---|---|---|
| `:722` apply 调用点 | applyFrame 内 :722 `const applied = applyConversationDeltas(current, frame.payload.deltas);` | 行号命中 |
| `:666-671` snapshot 帧替换 | :657 `if (frame.payload.kind === "snapshot")`；:659-664 `logSubagentProjectionTransition(...)`；:666-671 `this.setState({ snapshot: frame.payload.snapshot, planDirectoryRevision: +1, turnNavigatorDirectoryRevision: +1 })` | 命中 |
| `:1013-1017` loadOlder | :1013 `mergeOlderRows(current.rows.window, result.rows)`；:1015-1017 `setState({ snapshot: { ...current, rows: { ...current.rows, window } } })` | 命中 |
| `:1124`、`:1155` loadAllOlder | :1124（`preserveIncompleteLeadingTurn` 分支）+ :1127-1130 setState；:1155（主分支）+ :1158-1161 setState | 命中，恰好 4 处 rebuild 点与 SPEC 一致 |
| `mergeOlderRows` `:255-263` | :255-263，**模块私有（未 export）**；返回 `[...older, ...window]` → 既有行索引整体右移 | 命中；且为未导出的私有函数（影响 T-AP2 可测性，见 S-08） |
| `:725` logSubagentProjectionTransition | :725 `logSubagentProjectionTransition(this.topic, current, next, "deltas")`；另一处调用在 :659（snapshot 分支） | 命中（deltas 路径唯一） |
| `:194-221` 函数本体 | :194-221，比较 `previous?.subagents?.running` 与 `next.subagents?.running` 的 childSessionId 序列，**相同则直接 return 不记日志** | 命中 |
| `:369-390` setState 结构 | `getState()` :369-371 直接 `return this.state`；`setState` :387-390 `this.state = {...this.state, ...patch}` 然后遍历 listeners | 命中（区间含 getState + setState 两块） |
| `hasOlderRows` 依赖 totalCount/firstRowId | :227-232 —— 判据是 `window[0].rowId > snapshot.rows.firstRowId`，**不读 totalCount** | 部分不精确，见 S-05 |

其他关键代码事实：

- **delta 路径完整序列**（applyFrame :699-757）：
  - :702 迟到/重复丢弃 `frame.toSeq <= current.seq`
  - :706 断档判定 `!current || frame.fromSeq !== current.seq` → 重订阅/同源恢复
  - :722 apply → :724 `const next = { ...applied, seq: frame.toSeq };`
  - :726-732 计算 `removedFromRowId`
  - :733-752 setState：`snapshot: next` + `sessionPlans` 过滤(:737-741) + `planDirectoryRevision`(:742-744) + `turnNavigatorDirectoryRevision`(:747-751)【SPEC 引用的 `:747-751` 命中】
  - :753-757 `subscriptionHasAppliedBase = true` / `reconcileOptimistic` / `reconcileAcceptedInputProjection` / `observeModelTransition`
- **state 上没有任何 mutation 元数据**：`ConversationStoreState`（:107-132）与 `INITIAL_STATE`（:141-153）都没有 `lastMutation` 或等价字段；`frame.payload.deltas` 在 :722 用完即弃。C1-f 描述的 `lastMutation` 是**全新字段**，需同时改 `ConversationStoreState` 接口、初始值，以及 `useConversationProjection.ts:5-16` 的 `CLOSED_STATE`（该常量是全字段字面量，缺字段会编译报错）。
- **`setState` 每次换 state 外壳，但不换 snapshot**：`this.state = {...this.state, ...patch}`。若某次 patch 不含 `snapshot`，`getState()` 返回的对象引用会变而 `state.snapshot` 引用不变。
- **文件已带 max-lines 文件级豁免**：conversationProjectionStore.ts:1 `/* eslint-disable max-lines -- projection/base/recovery/optimistic 必须共享一个原子 store 状态机 ... */`。文件 1384 行远超 `.oxlintrc.json:6` 的 400。
- **`countProjectionRows`** :1328-1330（内存诊断 `projection.rows` 计数器，:272-278）。

### 2.3 useConversationProjection.ts（26 行）

- :19-26 `useSyncExternalStore(subscribe, () => store?.getState() ?? CLOSED_STATE, () => CLOSED_STATE)`。
- 注释 :18 明说「row 级 selector 在组件内再做」→ **订阅粒度是整个 store state**，任何 `setState`（含 `loadingOlder` 翻转、`plansLoading`、`sessionPlans` 变更）都会触发全量 re-render。
- :5-16 `CLOSED_STATE` 是显式全字段字面量，与 `ConversationStoreState` 强耦合。

### 2.4 renderUnits 链

| 断言 | 代码事实 |
|---|---|
| `ConversationTimeline.tsx:408-416` renderUnits useMemo deps | :408 `const [liveNowMs, setLiveNowMs] = useState(() => Date.now())`；:409-416 `useMemo(() => buildConversationTurnRenderUnits(rows, { nowMs: liveNowMs, sessionPhase }), [liveNowMs, rows, sessionPhase])`。**行号与 deps 全部命中** |
| liveNowMs 每秒 tick | :562-575 effect（deps `[hasRunningUnit]`）→ :569 立即 `setLiveNowMs(Date.now())`，:570-572 `setInterval(..., RUNNING_WORK_DURATION_TICK_MS)`；:97 `RUNNING_WORK_DURATION_TICK_MS = 1000` |
| turn 分组是否独立 | `conversationTurnRenderUnits.ts:438-481` `buildConversationTurnRenderUnits`：单次遍历按 `row.turnId` 用 `unitByTurnId` Map（:443-454）分组，`getOrCreateUnit` 按首次出现顺序 push → **turn 内分组与其它 turn 完全解耦，无模块级可变状态** |
| 有无全局状态跨 turn | **存在 4 类跨 turn / 全局输入**（见 S-04）：①`materializeDraftUnit(draft, index, total, options)` :232 → :279 `isLastTurn = index === total - 1`；②`normalizeRenderUnitPosition(unit, index, total, options)` :388-436 → :394 再次按 index/total 改写 `isLastTurn` 与**最后一个 workSegment 的 `assistantHistoryDefaultOpen`**（:408-421，且 :422-429 在无变化时返回原 unit 避免多余分配）；③`resolveTurnRunning` :199-220 读 `options.sessionPhase`（全局）；④`resolveConversationTurnWorkDurationMs`（conversationTurnWorkSegments.ts:49-63）与 `resolveSegmentDurationMs`（同文件 :96-132）在 running 且缺 `activeMs/endedAt` 时吃 `options.nowMs` |
| 「materializeDraftUnit 多次 filter/Set 才是大头」 | `materializeDraftUnit` :232-358 单 turn 内约 8 次 `filter`（:243/244/245/246/255/259/290/307）+ 2 次 `new Set`（:256/:306）+ `buildConversationTurnWorkSegments` 内再 4 次 filter + 1 次 `new Set`（:148-152）；外层 `normalizeRenderUnitPosition` 对每个 unit 的 workSegments 做一次 `.map`。量级判断与代码结构相符 |
| 「工作中 N 秒」文案的真实数据来源 | `ConversationTurnGroup.tsx:565-609` `AssistantHistoryStatus` → :573-577 `formatConversationWorkDuration(segment.workStatus?.durationMs, ...)` → :582 `intl.formatMessage({id:"chat.history.workingFor"}, {duration})`。**durationMs 是在 renderUnits 构建期由 `resolveSegmentDurationMs(..., nowMs)` 烘进 `workSegments[].workStatus` 的，不是组件内现算** |

### 2.5 shikiHighlighter.ts（198 行）— phase-memory-guard

| 断言 | 代码事实 |
|---|---|
| `tokensCache` 落点 | :60 `const tokensCache = new Map<string, TokenizedCode>();` —— 模块级私有常量，**未 export** |
| `highlighterCache` 本身有界 | :56-59 `Map<string, Promise<HighlighterGeneric>>`，:86-103 key = `${theme}:${language}`，实际有界（语言×主题对） |
| 写入点 | :176 `tokensCache.set(tokensCacheKey, tokenized)`（在 `getHighlighter(...).then` 内，异步） |
| 命中点 | :139-148 `tokensCache.get(...)` → 命中即 `queueMicrotask(() => callback(cached))`；**命中路径当前没有重排 Map 顺序**（LRU「命中刷新」需新增 `delete` + `set`，SPEC 未指明落点行） |
| key 构造 | :81-85 `getCodeTokensCacheKey` = `${theme}:${language}:${code.length}:${前100字符}:${后100字符}` —— **有损 key**（长度+首尾各100字符相同即碰撞）。这是既有行为，LRU 化不改变它 |
| 可观测面 | :64-67 `uiMemoryDiagnosticsRegistry.register("shiki", () => ({ tokensCache: tokensCache.size, highlighters: highlighterCache.size }))` —— 这是 T-MG1 唯一可断言的出口 |
| 未被护栏覆盖的相邻结构 | :61 `const subscribers = new Map<string, Set<...>>()` —— 第二个无界 Map；成功路径 :184、失败路径 :193 都会 `delete`，SPEC 未提及 |
| PRD 指标口径 | PRD 成功指标 3「`shiki.tokensCache` 等计数保持在上限内」→ 与 :65 的 `tokensCache` 字段名一致 |

补充：全仓 `uiMemoryDiagnosticsRegistry.register` 共 **7 处**（useZCodeTaskService.ts:36、sidePaneTerminalSessionRegistry.ts:57、ToolLayout.tsx:18、taskQueryCacheStore.ts:1014、zcodeSessionStore.ts:51、shikiHighlighter.ts:64、conversationProjectionStore.ts:272）→ T-PA2「全部 7 类已注册计数器」数量核对通过。

### 2.6 下游消费者抽查（copy-on-notify 的真实约束面）

| 位置 | 事实 | 对 copy-on-notify 的含义 |
|---|---|---|
| SessionPane.tsx:642-643 | `useMemo(() => buildConversationTurnRenderUnits(snapshot?.rows.window ?? []), [snapshot?.rows.window])` | **pane 内还有第二份全量 renderUnits 构建**，不经过 ConversationTimeline。C1-f 的增量方案只落在 ConversationTimeline，pane 这份仍是每帧 O(N)。见 S-07 |
| SessionPane.tsx:670 / :678 | `new Map((snapshot?.rows.window ?? []).map(...))`，deps 含 `snapshot?.rows.window` | 每帧重建 Map |
| SessionPane.tsx:746 / :754 | 同上模式（分享选择相关） | 每帧重建 |
| SessionPane.tsx:1690-1691 | `buildWorkflowGraphByToolCallId(snapshot?.rows.window)` on `[snapshot?.rows.window]` | 每帧全量工作流图重建 |
| SessionPane.tsx:1696-1697 | `buildWorkflowDraftByToolCallId(...)` 同上 | 同上 |
| SessionPane.tsx:3756-3757 | `resolveMcpUnavailableNotice(snapshot?.rows.window)` on `[snapshot?.rows.window]` | 同上 |
| SessionPane.tsx:855 / :962 / :985 / :1120 / :1132 | 非 memo 的每次渲染直接扫描 `snapshot?.rows.window` | 每帧扫描 |
| SessionPane.tsx:3456-3465 | 分享激活时 `handleLoadAllOlder()` 的 effect，deps `[handleLoadAllOlder, sessionId, shareActive, snapshot]` | SPEC「分享模式依赖全量正文语义，loadAllOlder 不能删」的落点命中；注意该 effect 以 **`snapshot` 整体对象**为 dep |
| SessionPane.tsx:3511-3514 / :4521 | `timelineSnapshot = (!isDraft && (lease===null\|\|sessionLeaseReady) && snapshot?.sessionId===sessionId) ? snapshot : null`；:4521 `rows={timelineSnapshot?.rows.window ?? []}` | rows prop 每帧换新数组（今天如此，改后仍如此） |
| usePendingCommandRecovery.ts:36 | `useEffect(() => { if (snapshot) pendingCommandRegistry.reconcileSnapshot(snapshot); }, [snapshot])` | 已按整份 snapshot 每帧触发；`pendingCommandRegistry.reconcileSnapshot`（pendingCommandRegistry.ts:229-250）只遍历 `queue.items` + `rows.window` 建 Set，**不持有 snapshot/row 引用** → 无跨帧缓存依赖，改动中性 |
| useTreemappingConversationMessage.ts:95-97 | `const state = useConversationProjection(lease); const rows = state.snapshot?.rows.window; return useMemo(() => rows ? buildTreemappingMessageFromRows(rows) : null, [rows]);` | 行号命中；每帧全量重建 |
| 全仓 `Object.freeze` | `packages/ui/src` + `packages/shared/src` 内 freeze 命中点全部与 snapshot 无关（feedbackSubmissionJob、runtimeEnv、workspace-hook-digest、conversationShareSelectionStore、composerSubmissionConfig） | SPEC「无 freeze」成立 |
| `packages/ui/src` 全量 `rows.window` 消费面 | 另有 app-shell/PlanDetailSidePane.tsx:43、WorkflowWorkspaceSidePane.tsx:141-142、WorkflowRunSidePane.tsx:130-141 | 三层换引用可覆盖（都是 render 内读），无跨帧持有 |

### 2.7 门禁与测试基建（影响 Step 0 / T-AP* 可测性）

| 事实 | 位置 |
|---|---|
| max-lines 400，skipBlankLines/skipComments | `.oxlintrc.json:6` |
| `**/*.test.ts(x)` / `**/*.spec.ts(x)` 关闭 max-lines | `.oxlintrc.json:8-16` → SPEC「`*.test.ts` 豁免 max-lines」成立 |
| 根 `lint` = `oxlint`；根 `typecheck` = `tsc -b … packages/shared packages/ui …` | `package.json:38` / `:29` |
| **根 package.json 无 `test` 脚本** | `package.json`（`verify:pre-push` = lint + architecture:check --changed，:19）→ SPEC「仓库无统一 test 入口」成立 |
| 现有测试仅 4 个文件 | `packages/ui/test/nonCliAcpRetirement.test.ts`、`packages/services/test/{nonCliAcpRetirement,providerConfigMigration,importedClaudeRecovery}.test.ts` |
| 现有测试全部用**相对路径**导入（`../../shared/src/validationAppSettings.js`、`../src/lib/...`），无 `@/`、无 vitest | `packages/ui/test/nonCliAcpRetirement.test.ts:3-15` |
| `@/*` 只是 TS paths 映射，无运行时解析器 | `packages/ui/tsconfig.json:12-13` |
| `packages/ui/tsconfig.json:20` include 只含 `src/**` → `packages/ui/test/` **不进 tsc -b** | 同上 |
| `packages/shared/tsconfig.json:9` include `["src"]` → SPEC 计划的 `packages/shared/src/zcode-protocol-v4/apply.test.ts` **会被 tsc 编译并 emit 进 dist/** | 同上；见 S-09 |
| `apply.ts` 的 import 全为相对路径（`./delta.js` `./snapshot.js` `./rows.js` `./core.js` `./workflow-runs-delta.js`），无 `@/`、无 UI 依赖 | apply.ts:5-9 → T-AP1 可在纯 node 环境跑；见 S-08 |
| `conversationProjectionStore.ts` 依赖 `@/logger.js`、`@/lib/memoryDiagnostics.js`、`@zcode/shared/zcode-protocol-v4` | conversationProjectionStore.ts:22-25 → T-AP2/T-AP3 在现有 node:test 基建下无法直接 import；见 S-08 |
| `shikiHighlighter.ts` 依赖 `@/logger.js`、`@/lib/memoryDiagnostics.js` | shikiHighlighter.ts:3-4 → T-MG1 同上；见 S-08 |
| `conversationProjectionStore.ts` 实际 1384 行（SPEC Step 0 写「~1300 行」、PRD 写「1300+ 行」） | 文件实测 |

---

## 3）可疑点清单

### S-01（高）renderUnits 增量重建的 dirty 集合定义不完整 —— 新 turn / 非末轮变化会漏失效

- 证据：`materializeDraftUnit` conversationTurnRenderUnits.ts:279 `const isLastTurn = index === total - 1;`；`normalizeRenderUnitPosition` :394 同样按 `index/total` 重算，并在 :408-421 改写**最后一个 workSegment 的 `assistantHistoryDefaultOpen`**。
- 问题：SPEC C1-f 只说「store 通知时附带本次变更的 turnId/rowId 集合」，只对 dirty turn 重算。但当一个新 turn 出现（`row.appended` 带新 turnId 的 turnHeader/userInput）时，**前一个原末轮的 `isLastTurn` 由 true 翻成 false**，其 `assistantHistoryDefaultOpen` 与末段 `workStatus` 呈现也随之改变，而它不在「本次变更的 turnId 集合」里。此外 `shouldKeepRenderUnit`（:374-386）会过滤掉空 turn，某 turn 从「保留」变「被过滤」时末位归属同样变化。
- 影响：T-AP4「增量 ≡ 全量」会红。

### S-02（高）「workingFor 文案改局部 tick」缺少数据来源方案

- 证据：`ConversationTurnGroup.tsx:573-577` 读的是 `segment.workStatus?.durationMs`，该值在 renderUnits 构建期由 `resolveSegmentDurationMs({..., nowMs})`（conversationTurnWorkSegments.ts:113-114, :182）算出并烘进 `workSegments[].workStatus`。
- 问题：SPEC C-B1（spec.md:41）要求「renderUnits useMemo deps 去掉 liveNowMs；『工作中 N 秒』文案改为 ConversationTurnGroup 内部局部 tick（独立 state + ref，只重渲染计时文本所在小组件）」。若 deps 去掉 `liveNowMs`，运行中 turn 的 `durationMs` 将永久冻结在构建那一刻；组件内的局部 tick state 只能重渲染，**无法凭空得到新的 durationMs**，除非 group 改为从 `header.startedAt` / `header.workSegments[].startedAt` 自行现算。SPEC 未写这条路径。
- 影响：Step 5 实施时会出现「文案不刷新」的功能回归；PRD 核心需求 4 的验收（60 秒 tick 不引起会话级重算）与「工作中 N 秒」正确性同时受影响。

### S-03（中）copy-on-notify 的理由表述不精确 —— 真正的杀手是 memo dep 失效，不是 getSnapshot 稳定契约

- 证据：SPEC C1-b（spec.md:51）称直接发布会「违反 `useSyncExternalStore` 的 getSnapshot 稳定契约」。
- 代码事实：`setState`（conversationProjectionStore.ts:387-390）每次都换 `this.state` 外壳，所以 `getState()` 的返回值引用**每帧都变**，useSyncExternalStore 的 Object.is 比较不会因此短路。真正会出问题的是：若 `snapshot.rows.window` 数组被原地 push 而引用不变，则全仓约 15 处 `[snapshot?.rows.window]` 依赖（SessionPane.tsx:643/678/740/754/962/1132/1691/1697/3757、useTreemappingConversationMessage.ts:97 等）**不会失效**，UI 读到旧数组 → 静默不更新。
- 影响：结论不变（三层换引用仍然必需），但 SPEC 给实施者的理由指向错误的失败模式，可能导致实现时只换 snapshot 外壳而漏换 window 数组（这恰恰是三层里最关键的一层）。

### S-04（中）增量缓存还需把 `sessionPhase` / `nowMs` 纳入失效键，SPEC 未提

- 证据：`resolveTurnRunning`（conversationTurnRenderUnits.ts:199-220）读 `options.sessionPhase`；`resolveConversationTurnWorkDurationMs` / `resolveSegmentDurationMs`（conversationTurnWorkSegments.ts:49-63, :96-132）读 `options.nowMs`。
- 问题：turnKey → units 的 Map 若只用 turnId 作键，`sessionPhase` 变化（如会话进入 `completedSuccess`）会让所有无 header 的运行中 turn 的 `isRunning` 判定翻转，而缓存命中旧值。
- 影响：T-AP4 的等价性前提需要 SPEC 补齐失效键定义。

### S-05（低）`hasOlderRows` 依赖描述不准确

- 证据：SPEC C1-d（spec.md:53）称「`totalCount/firstRowId` 同步进新 rows 对象（`hasOlderRows` 依赖）」。
- 代码事实：`hasOlderRows`（:227-232）只读 `snapshot.rows.window[0]` 与 `snapshot.rows.firstRowId`，**完全不读 totalCount**。`totalCount` 的消费者是 `ConversationTimeline.tsx:4524 totalCount={...}`（滚动条估计）以及 `conversationProjectionStore.ts:1067`（debug 日志）。
- 影响：表述误差，不影响方案；但若实施时只同步 firstRowId 而漏 totalCount，滚动条会失准。

### S-06（中）`logSubagentProjectionTransition` 改 previousIds 的必要性，取决于 accumulator 是否被发布为 state.snapshot——SPEC 的理由链缺一环

- 证据：函数体 :194-221 只比较 `subagents.running` 的 childSessionId 序列；`state.updated`（apply.ts:200）用 `Object.assign` **整键替换** `snapshot.subagents`，不会原地改已发布对象。
- 分析：只要 store 严格执行「发布外壳副本」（C1-b），`this.state.snapshot`（上一帧发布的外壳副本）与 `accumulator.snapshot` 是两个不同对象，上一帧的 `subagents` 引用不会被本帧污染，`current` 直接传入即可工作。SPEC 要求的「apply 前抓取 previousIds」在 copy-on-notify 下是**冗余但无害**的；反之若实施时为省一次拷贝而发布 accumulator 本体，则 previousIds 快照是必需的。SPEC 把两者并列写成硬约束，没有说明二者的依赖关系。
- 影响：Step 10 可能出现多余代码，或反过来掩盖「发布了本体」的实现缺陷。

### S-07（中）C1 的 renderUnits 增量化只覆盖 ConversationTimeline，遗漏 pane 内第二份全量构建

- 证据：`SessionPane.tsx:642-643` 独立调用 `buildConversationTurnRenderUnits(snapshot?.rows.window ?? [])`。
- 问题：SPEC「修改落点」清单（spec.md:99）只给 `ConversationTimeline.tsx` 加「renderUnits 增量缓存」，`SessionPane.tsx` 未列入修改清单，也未列入「不动」清单。若 pane 这份保持全量，每帧仍有一遍 O(N) 分组 + materialize，与 C1-f 的收益目标（spec.md:60「materializeDraftUnit 多次 filter/Set 才是大头」）部分抵消。
- 影响：收益打折；Step 11 的等价性测试若只覆盖 timeline 侧，会漏掉这条路径。

### S-08（中）T-AP2 / T-AP3 / T-AP4 / T-MG1 在现有测试基建下不可直接落地

- 证据：
  - 现有 4 个测试全部相对路径导入，无 `@/` 别名、无 vitest、无运行时 alias 解析器（`packages/ui/test/nonCliAcpRetirement.test.ts:3-15`；`@/*` 仅存在于 `packages/ui/tsconfig.json:12-13`）。
  - T-AP2 需要触达 `mergeOlderRows` —— 该函数**未 export**（conversationProjectionStore.ts:255），唯一可达路径是 `loadOlder()`（:987-1026），而它要求 `hasOlderRows` 为真、transport `rowsRange` 可 mock、`result.atLogEpoch` 相等、窗口首行 rowId 未变（:990-1012）。
  - T-AP3 需要实例化 `ConversationProjectionStore`（构造函数 :334-367 需要 `ConversationTransport`，并立即注册 `onAssemblyFault` 回调），而该文件 import `@/logger.js`、`@/lib/memoryDiagnostics.js`（:22-25）。
  - T-MG1 需要观察 `tokensCache` 淘汰；该 Map 未 export（shikiHighlighter.ts:60），唯一出口是 `uiMemoryDiagnosticsRegistry.collect()`，而 shikiHighlighter.ts:3-4 也 import `@/logger.js`。
  - T-AP4 的增量构建器按 SPEC 落在 `ConversationTimeline.tsx`（TSX + `@/` + React）。
- 对比：T-AP1 可测——`apply.ts` 的 import 全是相对路径且无 UI 依赖。
- 影响：4 条 blocking:yes 测试用例需要 SPEC 补一条「测试运行方式 + 模块可测性」前置（导出 seam / 提取纯模块到无别名路径 / 引入 loader），当前 Step 9-11 与测试策略章节未覆盖。

### S-09（低）`apply.test.ts` 放 `packages/shared/src/` 会被编译进产物

- 证据：`packages/shared/tsconfig.json:9` `"include": ["src"]`，`outDir: "dist"`, `rootDir: "src"`。SPEC「最终项目结构」（spec.md:86）把等价性测试定为 `packages/shared/src/zcode-protocol-v4/apply.test.ts`。
- 问题：该文件会进入 tsc -b 与 dist 打包；仓库现有测试一律放 `packages/<pkg>/test/`（`packages/ui/test/`、`packages/services/test/`），src 内无 `.test.ts` 先例。
- 影响：打包污染 + 与既有先例不一致。

### S-10（低）Step 0 的 max-lines 疑点对该文件已基本消解

- 证据：`conversationProjectionStore.ts:1` 已有文件级 `/* eslint-disable max-lines -- … */`，文件 1384 行；`.oxlintrc.json:6` 上限 400。
- 事实：Step 0（spec.md:135）问「conversationProjectionStore.ts（~1300 行）当前是否真实通过 pnpm lint，据此决定新增代码是否需要拆文件」。实测该文件带豁免注释，且 SPEC 的「不动/修改」清单也未把该文件列入需拆分项。
- 影响：Step 0 的结论范围应缩到「transport.ts 等未豁免文件」，否则会误导出一次不必要的拆分。

### S-11（低）`state.updated` 的封闭键集合是 accumulator 正确性的隐含前提，SPEC 未固化

- 证据：`statePatchSchema`（delta.ts:39-61）不含 `rows` / `seq` / `logEpoch`。
- 问题：若将来 patch 开放 `rows` 键，`Object.assign(snapshot, patch)`（apply.ts:200）会整体替换 accumulator 的 rows 对象，而 `rowIndexById` 仍指向旧数组 → 静默错乱（正是 S-01 风险表 R-1 的同类）。SPEC 风险表没有这一条。
- 影响：护栏缺失。

### S-12（低）`row.delta` 的 dirty turn 归属未在 SPEC 中给出可执行方案

- 证据：`ConversationDelta` 的 `row.delta` 只带 `rowId` + `path` + `append`（delta.ts:102-107），**不带 turnId**。
- 问题：C1-f 要求 store 在通知时产出「变更的 turnId 集合」，但 `row.delta` 的 turnId 需由 store 另行解析（可用 `rowIndexById` 取 index 后读 `window[index].turnId`，O(1) 可行）。SPEC 未写明这条解析路径，实施者可能误以为 delta 自带 turnId。
- 影响：可实现但 SPEC 表述不完整。

### S-13（低）T-MG1「命中刷新」在当前代码结构下没有对应落点

- 证据：命中路径 shikiHighlighter.ts:139-148 只 `get` 不重排；写入路径 :176 在异步 `then` 内。
- 问题：SPEC Step 19 只写「上限 500，命中刷新」，未指明 Map 排序维护的插入点（:140 命中处需 `delete`+`set`），也未说明与 :61 `subscribers` 的交互。
- 影响：实施细节缺失，影响 T-MG1「淘汰最久未命中」的可断言方式（需能观测淘汰事件或至少最终 size 与内容顺序）。

---

## 4）无法核实项

1. **PRD/SPEC 描述的服务端行为**：`conversation-topic-publisher.ts` 的 `getPlans():464`、`rowsRange():1559`、`getWireSnapshotForProfile` 的 60 行窗口、`transcript-hydration.ts` —— 未读（属 phase-turn-directory 范围，非本轮指定取证对象）。
2. **`transport.ts` 是否超 400 行 / Step 0 结论** —— 未读全文，仅知 index.ts:34 导出。
3. **架构约束 `architecture:check --changed` 的具体规则**（例如是否禁止 ui 引入新的 shared 符号）—— 未读 `architecture:*` 配置。
4. **oxlint 是否真的把 `/* eslint-disable max-lines */` 当作文件级豁免**（vs 需要 `oxlint-disable`）—— 未实际执行 `pnpm lint`；S-10 只基于文件内容与现有 1384 行的既存状态推断。
5. **实际渲染/性能收益**（外壳拷贝是否仍是瓶颈、renderUnits 占比）—— 需 Step 4 基线数据，本轮无运行时数据。
6. **`packages/ui/test/` 未进 tsc -b** 这一点对新增 ui 测试的类型检查覆盖率影响 —— 未验证是否有其它机制补上。
7. **`.cu-shots/cdp-verify-historian.mjs` 与 `performanceTimelineCleanup.ts`**（phase-perf-probe 相关，SPEC 引用）—— 未读。
8. **T-AP1「随机 delta 序列」的种子/规模约定** —— SPEC 未给，实现细节。
