# CR 取证包 · renderer 数据层（DATA 模块）

- head_sha: `d11a97c`（base `ba7c240`）
- 取证日期: 2026-10-05
- 仓库: `D:\Dev\worktree\desktop-long-session-perf`
- 模块范围: renderer 数据层（projection store / 下沉 core / renderUnits 装配 / workSegments / hook / 测试）
- Spec 对照: `docs/iterations/desktop-long-session-perf/spec.md` — 「总体方案 C1」（:57-71）、Step 5(:175) / Step 11(:181) / Step 12(:182) / Step 17(:187)、T-AP2(:202) / T-AP3(:203) / T-AP4(:204) / T-TD3(:207)
- 定位: **只取证，不下结论、不给评级。** 下列条目均为「文件:行 + 事实」，评级与 must-fix 判断留给主代理。

---

## 0. 取证方法与度量

- 行数口径：`total` = 物理行；`effective` = 非空且非注释行（oxlint `max-lines` 近似计数，配置见 `.oxlintrc.json` `{"max":400,"skipBlankLines":true,"skipComments":true}`，测试文件 `**/*.test.ts` 豁免）。

| 文件 | total | effective |
|---|---|---|
| `packages/ui/src/v4/conversationProjectionStore.ts` | 1711 | ~1305 |
| `packages/ui/src/v4/conversationTurnRenderUnitsDraft.ts` | 512 | 397 |
| `packages/ui/src/v4/conversationTurnRenderUnits.ts` | 286 | 209 |
| `packages/ui/src/v4/conversationTurnWorkSegments.ts` | 253 | 218 |
| `packages/ui/src/v4/conversationProjectionCore.ts` | 271 | 150 |
| `packages/ui/test/conversationProjectionCore.test.ts` | 796 | ~666 |

---

## 1. Spec 声明 vs 代码现状（逐条）

### 1.1 C1 / Step 11 — copy-on-notify 三层换引用 + 读本体禁令

| spec 声明 | 代码现状（file:line） | 判定 |
|---|---|---|
| 发布**外壳副本**而非 accumulator 本体 | `conversationProjectionCore.ts:162-169` `publishConversationShell`：`{...snapshot, rows:{...rows, window:[...window]}}` | 符合 |
| 三层引用（window/rows/snapshot）必须全换 | 同上，`window`/`rows`/`snapshot` 三层各建新对象 | 符合 |
| `firstRowId`/`totalCount` 随发布带出 | `core:167` `rows = {...snapshot.rows, window}` 保留两字段；`store:1145-1151 / 1263-1266 / 1298-1301` 的 rebuild 入参同样 `{...current.rows, window}` 不丢两字段 | 符合（依赖 apply 侧维护，测试 `test:221-236` 固化） |
| `seq` 显式推进 | `core:257` `accumulator.snapshot.seq = toSeq` | 符合 |
| `logSubagentProjectionTransition` 读外壳 | `store:771`（snapshot 分支传 `next`）、`store:841`（delta 分支传 `current` = 上一帧发布的外壳） | 符合 |
| `reconcileOptimistic` 读外壳 | `store:784`、`store:882` 均传 `next` | 符合 |
| `reconcileAcceptedInputProjection` 读外壳 | `store:785`、`store:883` 均传 `next` | 符合 |
| `observeModelTransition` 读外壳 | `store:789`、`store:884` 均传 `next` | 符合 |
| 统一 `rebuildAccumulator` 入口 + 四处强制调用 | 入口 `store:726-731`；调用点 5 处：`:750`（accumulator 缺失兜底重建）、`:770`（snapshot 帧）、`:1145`（loadOlder）、`:1263`（loadAllOlder not-enough 分支）、`:1298`（loadAllOlder hydrated 分支）。spec 所列四处（snapshot / loadOlder / loadAllOlder ×2）在 `:770/:1145/:1263/:1298` 齐备，另加 `:750` 一处防御性重建 | 符合（比 spec 多一处兜底） |
| 不新写 delta 分派逻辑 | `core:256` 直接调 `applyConversationDeltasMutable`（apply.ts） | 符合 |

### 1.2 Step 5 — 可测性下沉（`@/`-free）

| spec 声明 | 代码现状 | 判定 |
|---|---|---|
| `mergeOlderRows` 下沉 | `core:137-145`；store `:296` import、`:304` `export { mergeOlderRows }` re-export | 符合 |
| accumulator 应用包装下沉 | `core:233-270` `createConversationProjectionAccumulator`；store `:294/:299/:305` import + re-export 类型 | 符合 |
| 增量构建器纯逻辑下沉 | `core:20-27` 从 `./conversationTurnRenderUnits.js` re-export；`core:38` 导出共享句柄 | 符合（见 §4 关于 core 顶层副作用的记录） |
| 被测模块传递依赖链零 `@/` | 实测传递链：`core → conversationTurnRenderUnits → conversationTurnRenderUnitsDraft → {workflowLaunchTurn, conversationTurnWorkSegments, conversationTurnFlowItems} → conversationCuaGroups → {../lib/toolCallTree, toolCallRowAdapter} → ../lib/toolError → taskChatMessageTypes`。逐文件扫描 import 面：**零 `@/`**。必要配套改动：`conversationTurnWorkSegments.ts:10-12` 由 `@/v4/conversationCuaGroups.js` / `@/v4/conversationTurnFlowItems.js` 改为相对路径 | 符合 |
| 外部包导入只用 `@zcode/*` | 链上外部导入仅 `@zcode/shared/zcode-protocol-v4`（多数）与 `@zcode/shared`（`toolCallRowAdapter.ts:4`，ui 的 `package.json` 声明 `"@zcode/shared": "workspace:*"`） | 符合 |

### 1.3 Step 12 — renderUnits 增量重建

| spec 声明 | 代码现状 | 判定 |
|---|---|---|
| store 通知附带 `lastMutation`（rowId→turnId，从 accumulator 命中行解析） | `core:190-224` `collectMutationTurnIds`；`core:178-183` `ConversationProjectionLastMutation`；`store:153` state 字段 | 符合 |
| **必须在 apply 前采集** | `core:255` 在 `:256` `applyConversationDeltasMutable` **之前**调用 `collectMutationTurnIds` | 符合（`row.removed` 必须在 apply 前取，注释 `core:186-189` 说明） |
| 失效键 = 本帧变更轮 ∪ 上一帧末轮 | `conversationTurnRenderUnits.ts:136-144` `collectDirtyTurnIds`；锚点 `lastUnitTurnId` 由 `:247` 每帧末尾更新 | 符合 |
| 缓存键 = `turnId + "\|" + isLastTurn + "\|" + sessionPhase`（turnId 提升为外层 Map 键） | `:93-98` `renderUnitCacheKey(isLastTurn, sessionPhase)` 生成内层两段；外层键为 `cacheByTurnId: Map<string, TurnCacheEntry>`（`:169`、`:124-134`） | 符合（逻辑等价的三段式，turnId 作外层键） |
| 构建器不再收 `nowMs` | `BuildConversationTurnRenderUnitsOptions`（Draft:80-87）只有 `sessionPhase`/`scopeKey`；`buildConversationTurnWorkSegments`（workSegments:157-166）签名已去掉 `nowMs`；`resolveConversationTurnWorkDurationMs`（workSegments:53）签名去掉 `options`/`isRunning` | 符合 |
| phase 变化整表作废（键不够，还需 reset） | `renderUnits:179-186` `nextScopeKey !== scopeKey \|\| sessionPhase !== cachedSessionPhase` → `cacheByTurnId.clear()` + `lastUnitTurnId = null` | 符合 |
| SessionPane `shareRenderUnits` / `shareItems` 全改走共享缓存 | `SessionPane.tsx:659-667` `shareRenderUnits = useMemo(... conversationTurnRenderUnitsCache.build(snapshot?.rows.window ?? [], {sessionPhase: sessionRenderPhase, scopeKey: sessionId ?? "draft"}, state.lastMutation?.turnIdByRowId), [snapshot?.rows.window, sessionRenderPhase, sessionId, state.lastMutation])`；`shareItems:668-682` / `eligibleShareItems:683-690` 全部从 `shareRenderUnits` 派生 | 符合（无分支，非分享态也走同一缓存） |
| Timeline 也走同一缓存 | `ConversationTimeline.tsx:475-483` | 符合 |
| 缓存有界 | 外层 `:244-246` 每帧剔除不在窗口内的 turn；内层 `:239` `setBoundedPartition` 上限 8 | 见 §3 S1（内层只有一半受界） |

### 1.4 Step 17 — store 目录态

| spec 声明 | 代码现状 | 判定 |
|---|---|---|
| 目录状态 | `store:135` `turnNavigatorDirectoryRevision`、`:143` `turnDirectory`、`:145` `loadingDirectory`、`:169-182` `ConversationTurnDirectoryState`、`:184-192` 空态 | 符合 |
| `<2` 判定读 `realUserQueryTotal` | `store:1406-1428`：首屏即判 `realUserQueryTotal < 2` → 写 `turnDirectory`（`loaded:true`）+ `turnDirectoryHydrationTerminal = {status:"not-enough-queries", logEpoch, directoryRevision}`，**不再翻页探测** | 符合 |
| 失效挂 revision（append/upsert/removed 三类帧） | `core:55-63` `shouldInvalidateTurnNavigatorDirectory`（snapshot → true；`row.removed` → true；`row.appended/upserted` 且 `kind==="userInput" && origin==="realUser"` → true）；`core:66-71` `nextTurnNavigatorDirectoryRevision`；delta 分支接线 `store:851-855 / 870-878`，snapshot 分支接线 `store:778-780` | 符合 |
| 未失效时不换引用（避免下游无谓失效） | `store:870-872` 三元展开，相等则不带字段；`core:70` 原值透传 | 符合 |
| 250ms trailing 重查去抖（写死） | `core:80` `TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS = 250`；`core:107-130` `createTrailingDebouncer`（可注入时钟面）；`store:1497-1506` `scheduleTurnDirectoryRequery` 懒建 + `schedule()` | 符合 |
| 终态分离（目录路径 vs 正文路径） | 两个独立字段：`turnNavigatorHydrationTerminal`（`store:368-373`，正文/分享全量补齐）与 `turnDirectoryHydrationTerminal`（`store:381-386`，目录条目），`store:374-380` 注明刻意不共用 | 符合 |
| `<2` 的 loaded 门控（未取过时不得当成 0） | `SessionPane.tsx:3496-3511` `turnDirectoryView`：`loaded === false` 时 `realUserQueryTotal`/`hasMore` 一律 `undefined`；判定函数 `conversationTurnNavigatorHelpers.ts:106-122` 声明该语义 | 符合 |
| 翻页上限 50 页 | `store:195` `TURN_DIRECTORY_MAX_PAGES = 50`；`store:1451` 到顶以已取部分提交 | 符合 |
| 陈旧读双闸（atLogEpoch + atRevision） | `store:1386-1392`（epoch 不符整批弃）、`store:1393-1402`（跨页 `atRevision` 不一致整批弃） | 符合 |
| 目录条目不并入窗口 | `store:1454-1464` 只写 `turnDirectory` 字段，不改 `snapshot.rows.window` | 符合 |
| `loadAllOlder` 保留为正文/分享路径 | `store:1169-1324` 原样保留（`SessionPane.tsx:3513-3521` `handleLoadAllOlder` 仍供分享链路） | 符合 |
| `shouldHydrateConversationTurnNavigatorDirectory` 签名扩展（`loadingDirectory` 态） | `ConversationTimeline.tsx:317-327` 新 props `onLoadTurnDirectory` / `loadingDirectory` / `turnDirectory`；`:730-740` effect deps 含 `loadingDirectory`、`turnDirectory`、`turnNavigatorDirectoryRevision`；`:686` hydrationKey 含 revision | 符合 |

### 1.5 T-AP2 / T-AP3 / T-AP4 / T-TD3 测试对应

| 用例 | 代码现状 | 判定 |
|---|---|---|
| T-AP2 accumulator mergeOlderRows 后 rebuild | `test:174-219`：合并后 rebuild → delta 落位正确，并与不可变 `applyConversationDeltas` 逐字节相等（`:198`）；`:215-218` 反证「漏 rebuild」场景 | 覆盖 |
| T-AP3 三层引用全换 + 通知间引用稳定 | `test:263-304`：`notStrictEqual` 三层 ×2 帧 + 已发布外壳不被写穿 + seq 推进 + 与不可变实现等价；`test:306-316` publish 纯只读 | 覆盖 |
| T-AP4 三类必测场景 | 场景一（追加致 isLastTurn 翻转）`test:416-440`；场景二（末位被过滤）`test:442-474` + 补 `test:476-486`；场景三（sessionPhase 迁移）`test:500-516`；另附退化/隔离/有界/60 步定种子模糊 | 覆盖（**但只覆盖 core 层，不覆盖 store 接线**，见 §3 S12） |
| T-TD3 三类帧各一例 + 去抖重查合并 | `test:703-713`（append/upsert/removed 各一例 + revision 自增）、`:715-719`（snapshot）、`:721-728`（无关帧不失效）、`:730-737`（同帧多类只自增一次）、`:739-741`（写死 250ms）、`:743-777`（假时钟下 3 次 schedule 合并为 1 次）、`:779-795`（cancel） | 覆盖（**纯函数层；store 侧 revision 自增/loaded 闸门/查询分页无用例**，见 §3 S12） |

---

## 2. Diff 变更点清单（BASE `ba7c240` → HEAD `d11a97c`，本模块）

### 2.1 新增文件

- `packages/ui/src/v4/conversationProjectionCore.ts`（271 行，新）
  - `shouldInvalidateTurnNavigatorDirectory` / `nextTurnNavigatorDirectoryRevision`（从 store 迁入）
  - `TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS` / `TrailingDebounceTimers` / `TrailingDebouncer` / `createTrailingDebouncer`（新）
  - `mergeOlderRows`（从 store 迁入）
  - `publishConversationShell` / `collectMutationTurnIds` / `ConversationProjectionLastMutation` / `ConversationProjectionAccumulator` / `createConversationProjectionAccumulator`（新）
  - `conversationTurnRenderUnitsCache` 模块级共享句柄（`:38`）+ renderUnits 构建器 re-export（`:20-27`）
- `packages/ui/src/v4/conversationTurnRenderUnitsDraft.ts`（512 行，新）：单轮物化层，从原 `conversationTurnRenderUnits.ts` 拆出——`ConversationTurnRenderUnit` / `DraftTurnRenderUnit` / `DraftVisibility` 类型、`resolveDraftVisibility` / `shouldKeepDraftUnit` / `resolveTurnRunning` / `shouldForceOpenAbnormalHistory` / `materializeDraftUnit` / `normalizeRenderUnitPosition`
- `packages/ui/test/conversationProjectionCore.test.ts`（796 行，新）：T-AP2 / T-AP3 / T-AP4 / T-TD3

### 2.2 修改文件

- `conversationProjectionStore.ts`（+447/-?，17 个 hunk）
  - 移除本地 `applyConversationDeltas` 依赖、移除本地 `mergeOlderRows`（`:149` diff 删除）与本地 `shouldInvalidateTurnNavigatorDirectory`
  - `:290-305` 改为从 `@/v4/conversationProjectionCore.js` import 并 re-export
  - state 新增 `turnDirectory` / `loadingDirectory` / `lastMutation`（`:135/:143/:145/:153`），`INITIAL_STATE` 同步（`:206-212`）
  - 类字段新增：`turnDirectoryHydrationTerminal`（`:381`）、`turnDirectoryDebouncer`（`:388`）、`turnDirectoryQueryInFlight`（`:390`）、`turnDirectoryQueryPending`（`:391`）、`accumulator`（`:401`）
  - 新增 `rebuildAccumulator`（`:726-731`）、`applyFrameDeltas`（`:742-753`）
  - `applyFrame` snapshot 分支改走 rebuild+publish（`:770`），三步读 `next`；delta 分支改走 accumulator（`:836-840`），revision 递增与 `scheduleTurnDirectoryRequery` 接线（`:851-878`）
  - `loadOlder`（`:1144-1151`）与 `loadAllOlder` 两处（`:1261-1268` / `:1296-1303`）改走 rebuild+publish 并清 `lastMutation`
  - 新增 `loadTurnDirectory`（`:1340-1488`）、`scheduleTurnDirectoryRequery`（`:1497-1506`）
  - `close()` 新增 `turnDirectoryDebouncer?.cancel(); turnDirectoryDebouncer = null;`（`:1674-1675`）与 `this.accumulator = null;`（`:1682`）
- `conversationTurnRenderUnits.ts`（679 行重构，286 行现存）：多轮装配层——`groupConversationRowsIntoDraftTurns`、`renderUnitCacheKey`、`TurnCacheEntry`、`MAX_PARTITIONS_PER_TURN` / `setBoundedPartition`、`entryFor`、`collectDirtyTurnIds`、`ConversationTurnRenderUnitsCache` / `createConversationTurnRenderUnitsCache`、`buildConversationTurnRenderUnits`（全量退化形态，与增量共用同一实现路径）
- `conversationTurnWorkSegments.ts`（+90）：`ConversationTurnWorkSegment` 增 `startedAt?`（`:25-30`）；新增 `resolveSegmentWorkFact` / `resolveSegmentStartedAt`；`resolveSegmentDurationMs` 与 `resolveConversationTurnWorkDurationMs` 去 `nowMs`；三处 `@/v4/*` import 改相对路径（`:10-12`）
- `useConversationProjection.ts`（+18）：`CLOSED_STATE` 补 `turnDirectory`（新增 `CLOSED_TURN_DIRECTORY` 常量，`:6-16`）与 `loadingDirectory: false`
- 接缝侧（不在本模块范围，仅记录）：`ConversationTimeline.tsx`（+358）、`SessionPane.tsx`（+91）、`ConversationTurnGroup.tsx`（+66）、`conversationTurnNavigatorHelpers.ts`（+203）、`conversationTurnNavigatorDirectory.ts`（新 204）、`ConversationTurnNavigator.tsx`（+125）、`ConversationRowView.tsx`（+35）

---

## 3. 可疑点（file:line + 事实，不含评级）

**S1 · 内层分区只有一半受界（新点，非「理论残留」）**
`conversationTurnRenderUnits.ts:107-108` 把 `MAX_PARTITIONS_PER_TURN = 8` 描述为「单轮内层分区的上界」，`:114` 注释称「超限时先淘汰最久未用的分区，防止长期会话里 phase 抖动把缓存撑爆」。实际：`unitByKey` 走 `setBoundedPartition`（`:239`），而 `keepByPhase` 走**裸 `.set`**（`:212`），未经上界函数。当前不可爆的原因是 `:179-186` 的 phase 迁移整表 clear（keepByPhase 键只随 `renderUnitCacheKey(false, sessionPhase)` 生成，`:196`），即两条路径的实际分区数都 ≤2；有界函数与其常量目前是空转的防御。

**S2 · `row.upserted` 改挂 turnId 时旧轮不进脏集（失效集定义缺口）**
`core:198-202`：`row.appended`/`row.upserted` 分支只 `set(delta.row.rowId, delta.row.turnId)`，注释明确写「upsert 可能把行改挂到别的 turn 上，取新行的 turnId 才是本帧的落点」。但旧 turnId 未被记入 `turnIdByRowId`，因此 `renderUnits:136-144` 的脏集不含旧轮 → 旧轮命中缓存条目、`materializeDraftUnit` 的产物里仍留着已被改挂走的那一行。对比同文件 `row.removed` 分支（`:209-217`）专门逐行记被裁行的 turnId 以覆盖「被裁一半的轮」。spec:67 的字面定义是「本帧变更行的 turnId」，实现严格照字面执行，缺口在定义层而非实现层。

**S3 · `row.removed` 分支对整窗线性扫描**
`core:212-215`：每个 `row.removed` delta 遍历整个 `window` 收集 turnId。单帧含 m 条 removed 时为 O(窗宽 × m)。窗口尾窗 + 批量裁剪帧（rewind / 分支裁剪）下是一次额外的 O(N) 扫描，且发生在 accumulator apply 之前（每帧固定多一趟）。

**S4 · 纯 `state.updated` 帧也换 window 引用**
`core:166` 无条件 `[...snapshot.rows.window]`。含零行变更的帧（纯 state/usage/control patch）同样产出新 window 数组 → `store:859` 写入新 `lastMutation` 对象 → `SessionPane.tsx:666` / `ConversationTimeline.tsx:482` 的 useMemo deps（`[snapshot?.rows.window, ...]` / `[rows, ...]`）每帧失效 → core:151-156 注释点名的「约 15 处 `[snapshot?.rows.window]` memo」（core:151-153）全部重算。spec:71 接受了「每通知帧仍有一次 O(N) 外壳拷贝（引用拷贝）」，但**引用换新导致下游 memo 无法跳过**这一层代价在该说明里未单独记。

**S5 · `store:858-859` 存在不可达分支 + 注释与实现不符**
`...(lastMutation ? { lastMutation } : { lastMutation: undefined })`，配注释「累加器刚重建过就没有 lastMutation」。但 `applyFrameDeltas`（`:742-753`）无论走 `:750` 的重建兜底还是复用，都必定先执行 `applyDeltas`（`core:254-262` 无条件 `lastMutation = {...}`），`:752` 的 `accumulator.lastMutation()` 必非 null。该分支与其注释、以及 `core:243` 注释「未 apply 过 delta 帧时为 null」在当前调用图下都不可达。

**S6 · `ConversationProjectionLastMutation.seq` 无消费方**
`core:178-183` 声明 `seq` 字段并注明「与同帧发布的 snapshot.seq 对齐，便于消费方断言同代」；`core:260` 赋值。全仓检索（`src/` + `test/`）显示消费方只读 `.turnIdByRowId`（`SessionPane.tsx:664`、`ConversationTimeline.tsx:480`）与对象引用本身（deps），**无任何一处读 `.seq` 或做同代断言**。

**S7 · `mergeOlderRows` 注释的顺序保证与实现/测试不一致**
`core:133-136` 注释声明「顺序键 = rowId 升序（全序保证）」；实现 `core:141-144` 只做 `fetched.filter(rowId < first)` + `[...older, ...window]`，**不排序**，保留 fetched 原序。测试 `test:67-74` 明确断言乱序输入按原序输出（`[3,1]` → `[3,1,5,6]`）。结果数组是否全局升序完全依赖调用方 `rowsRange` 的升序契约（`store:1141` 单页、`store:1228/1251` 翻页 reverse-flat 拼接）。

**S8 · core 对同一模块重复 import / re-export**
`core:16` `import { createConversationTurnRenderUnitsCache } from "./conversationTurnRenderUnits.js"`，`core:20-27` 又以 `export { createConversationTurnRenderUnits, createConversationTurnRenderUnitsCache, ... } from "./conversationTurnRenderUnits.js"` 再声明一次。功能无害，事实记录。

**S9 · close 与在途目录查询的交错**
`store:1657-1709` `close()`：`:1674-1675` cancel 去抖器并置 null、`:1682` 清 accumulator、`:1685` setState closed。若 `loadTurnDirectory` 在 close 前已在途，`finally`（`:1480-1487`）因 `this.closed` 跳过 `setState({loadingDirectory:false})`，`turnDirectory.loaded` / `entries` / `realUserQueryTotal` 停留在旧值，`turnDirectoryQueryInFlight` 只在该 finally 里复位；close 自身不 await 也不显式复位。兜住它的是 `useConversationProjection.ts` 在 lease 为空时回落 `CLOSED_STATE`（`:27-35` 含 `turnDirectory: CLOSED_TURN_DIRECTORY`）。

**S10 · 目录查询失败路径不清目录态（陈旧读双闸之外的第三态）**
`store:1475-1479` catch：只 `logger.warn` + 返回 `retryable-failure`，**不写** `turnDirectoryHydrationTerminal`、**不清** `turnDirectory`（`entries`/`realUserQueryTotal`/`atRevision` 保留上一次成功值），`loadingDirectory` 由 finally 复位。配合 `SessionPane.tsx:3500-3503` 的 `loaded` 门控（`loaded===true` 时照常下发旧 `realUserQueryTotal`/`hasMore`），会出现「旧目录仍判 loaded=true + revision 已自增」的组合，rail 在下一次成功查询前继续显示旧条目。`loadOlder`（`store:1152-1156`）与 `loadAllOlder`（`store:1316-1320`）的错误路径同样不触碰目录态——这是三条路径共有的行为面，spec 侧未见对应条款。

**S11 · 目录重查无退避，pending 补跑可形成紧循环**
`store:1346-1350` 在途时置 `turnDirectoryQueryPending = true` 并立即返回 `stale()`；`store:1483-1486` finally 中立即 `void this.loadTurnDirectory()` 补跑。补跑命中同一 revision 且上一轮失败时，终态未写 → 再次发查询。约束只有 250ms trailing 去抖（`:1497-1506`，仅对 revision 变更生效）与在途合并，**失败重试本身无退避、无次数上限**；对比 plan 目录路径 `store:1514-1548` 是同款 pending 结构。

**S12 · 测试覆盖只到 core 层，store 侧接线无用例**
- Step 11 的四处 `rebuildAccumulator` 接线（`store:770/1145/1263/1298`）与 `:750` 兜底：T-AP2 只在 core 层用「手工 merge + 手工 new accumulator」模拟（`test:183-195`），**没有一条用例驱动 store**。
- Step 17 的 store 集成全部未覆盖：`store:851-878` 的 revision 自增接线与 `scheduleTurnDirectoryRequery` 的 `turnDirectory.loaded` 闸门（`:1498`）、`loadTurnDirectory` 的 `<2` 首屏终态（`:1406-1428`）、`atRevision` 跨页 pin 丢弃（`:1393-1402`）、`atLogEpoch` 陈旧读丢弃（`:1386-1392`）、50 页上限（`:1451`）、终态分离（`turnNavigatorHydrationTerminal` vs `turnDirectoryHydrationTerminal`，`:368-386`）均无用例。T-TD3 只测纯谓词 + 去抖器本体。
- 缺口与 spec 的关系：spec 把 T-AP2/T-AP3/T-AP4/T-TD3 都定义为「→ Step 11/12/17」的用例，文字上没要求 store 级集成测试；此处记录的是「Step 11/12/17 中标注为 blocking 且 qa:auto 的 store 接线部分实际无自动化断言」这一事实。

**S13 · 测试断言的实现耦合面**
- 形状断言（对合法等价实现会红）：`test:277-282` 用 `notStrictEqual` 钉死三层引用必换；`test:306-315` 钉死每次 `publish()` 都是新外壳；`test:438/473/485/495/531/544` 用 `strictEqual/notStrictEqual` 钉死 unit 对象是否复用。这三条断言同时也是本轮收益本身（对象复用 = 增量的收益），耦合是有意为之，但它们无法区分「等价且高效」与「等价且低效」的其它实现。
- 缺性能护栏：没有用例注入计数断言「增量路径调用的 `materializeDraftUnit` 次数 = 脏轮数」。`:488-498` 只断言「非末位且未变更的轮复用」，等价性断言（`assertIncrementalEqualsFull`）在**全量与增量都正确**的前提下同样会通过，无法阻止有人把 `isDirty` 恒置 true 而测试仍全绿。
- 模糊用例（`test:560-620`）直接改写传入的 `options.sessionPhase` 对象（`:615`），耦合于「`build` 每次读取 `options.sessionPhase` 而非创建时捕获」这一实现细节（`renderUnits:178`）。
- 文件规模：796 行 / ~666 有效，`.oxlintrc.json` 对 `**/*.test.ts` 关闭 `max-lines`，在 spec:195 声明的豁免范围内。

**S14 · store 规模与职责边界**
`conversationProjectionStore.ts` 1711 行 / ~1305 有效，首行 `/* eslint-disable max-lines -- projection/base/recovery/optimistic 必须共享一个原子 store 状态机，拆分会重新引入跨对象竞态。 */`（`:1`，该豁免在 BASE 已存在）。本轮在其上新增 6 个成员（`turnDirectory`/`loadingDirectory`/`turnNavigatorDirectoryRevision` 三个 state 字段 + `turnDirectoryHydrationTerminal`/`turnDirectoryDebouncer`/`turnDirectoryQueryInFlight`/`turnDirectoryQueryPending` 四个私有字段 + `accumulator`）与一个 149 行方法 `loadTurnDirectory`（`:1340-1488`）。目录状态机与既有 plan 目录状态机（`refreshPlans` `:1514+`、`planQueryInFlight/Pending` `:361-362`）结构同构但完全平行、各自实现 pending/终态/日志；Step 5 的下沉要求只覆盖纯逻辑（core），目录状态机本身没有对应的下沉目标。

**S15 · Draft 文件逼近 max-lines 上限**
`conversationTurnRenderUnitsDraft.ts` 有效行 397 / 上限 400（`.oxlintrc.json` `max-lines: {max:400, skipBlankLines, skipComments}`），仅 3 行余量。同批 `conversationTurnRenderUnits.ts` 209、`conversationTurnWorkSegments.ts` 218、`conversationProjectionCore.ts` 150 均有余量。

**S16 · 共享缓存句柄的一致性靠注释约定，无断言；lease 未就绪窗口会清空缓存**
`core:38` `conversationTurnRenderUnitsCache` 为模块级可变单例，消费方两处：`ConversationTimeline.tsx:477` 与 `SessionPane.tsx:661`。两侧 scopeKey 同为 `sessionId ?? "draft"`（`SessionPane.tsx:663` 与 `ConversationTimeline.tsx` props 传入点 `SessionPane.tsx:4591`），phase 同为 `sessionRenderPhase`（`SessionPane.tsx:600` 定义 → `:663` 自用 + `:4658` 传给 Timeline）；该不变量仅由 `SessionPane.tsx:590-599` / `:656-658` 的注释维护，**无运行时断言、无测试覆盖**（core 测试用的是各自 `createConversationTurnRenderUnitsCache()` 新句柄）。此外 `timelineSnapshot`（`SessionPane.tsx:3577-3580`：lease 未就绪或 `snapshot.sessionId !== sessionId` 时为 null）会让 Timeline 侧以 `rows=[]` + `lastMutation=undefined` 构建（`:4587`/`:4592`），`renderUnits:244-246` 的清理循环随即把整个缓存清空，此后 SessionPane 的 `shareRenderUnits` 必然全量重建——短时 O(N) 抖动，非正确性问题。

**S17 · 归一化产物跨消费方共享同一对象**
`conversationTurnRenderUnitsDraft.ts:498-505`：`normalizeRenderUnitPosition` 在 `isLastTurn` / `assistantHistoryDefaultOpen` / 末段展开态三者均未变时**直接返回入参 unit**（不克隆）。该对象随后被写入缓存（`renderUnits:239`）并在同一帧内同时交给 `ConversationTimeline` 与 `SessionPane.shareRenderUnits` 两个消费方。当前两个消费方都只读（React props），但「renderUnit 产物不可变」只由约定维持，运行时无冻结/断言；缓存条目一旦被任一消费方就地改写，会同时污染另一消费方与后续所有帧。

**S18 · core 顶层副作用把整条 renderUnits 依赖链拉进所有 import 方**
`core:38` 在模块顶层执行 `createConversationTurnRenderUnitsCache()`，而 `core:16` / `core:20-27` 引入 `./conversationTurnRenderUnits.js`。因此任何 `import ... from "@/v4/conversationProjectionCore.js"` 的模块——`conversationProjectionStore.ts:293-302`、`ConversationTimeline.tsx:52`、`SessionPane.tsx:152`、单测——都会连带加载 renderUnits → Draft → workflowLaunchTurn/workSegments/flowItems → conversationCuaGroups → toolCallRowAdapter → `../lib/toolError`、`../lib/toolCallTree` 全链。这是 spec:68「写死方案：SessionPane / Timeline 共用」的必然结果，事实记录（`@/`-free gate 因此从「core 一个模块」扩大到「整条 renderUnits 链」，实测当前仍为零 `@/`，见 §1.2）。

---

## 4. 接缝（Timeline / SessionPane 如何消费；与 render 模块的 phase / scopeKey 约定）

### 4.1 数据流

```
ConversationProjectionStore
  setState({ snapshot: publishShell, lastMutation, turnDirectory, loadingDirectory,
             turnNavigatorDirectoryRevision, ... })     store:456-459
  ↓ useSyncExternalStore（getSnapshot 返回 this.state，引用稳定）
useConversationProjection(lease) → ConversationStoreState              hook:36+
  ↓
SessionPane.tsx
  ├─ shareRenderUnits  = useMemo(cache.build(snapshot?.rows.window ?? [],
  │                        { sessionPhase: sessionRenderPhase, scopeKey: sessionId ?? "draft" },
  │                        state.lastMutation?.turnIdByRowId),
  │                      [snapshot?.rows.window, sessionRenderPhase, sessionId, state.lastMutation])   :659-667
  ├─ shareItems        = buildConversationTurnNavigatorItems(shareRenderUnits, {...i18n})                :668-682
  ├─ eligibleShareItems / eligibleShareRowIds                                                          :683-690
  ├─ turnDirectoryView（loaded 门控窄面）                                                              :3496-3511
  └─ <ConversationTimeline rows={timelineSnapshot?.rows.window ?? []}
                             totalCount={timelineSnapshot?.rows.totalCount ?? 0}
                             sessionKey={sessionId ?? "draft"}
                             lastMutation={timelineSnapshot ? state.lastMutation : undefined}
                             sessionPhase={sessionRenderPhase}
                             loadingDirectory={state.loadingDirectory}
                             turnDirectory={turnDirectoryView}
                             turnDirectoryEntries={state.turnDirectory.entries}
                             turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
                             onLoadTurnDirectory={handleLoadTurnDirectory} />                            :4583-4658
        ↓ ConversationTimeline.tsx
        renderUnits = useMemo(cache.build(rows, { sessionPhase, scopeKey: sessionKey },
                                           lastMutation?.turnIdByRowId),
                              [rows, sessionPhase, sessionKey, lastMutation])                             :475-483
        ├─ virtualizedUnits / liveUnit / liveUnitIndex                                                 :484-487
        ├─ turnNavigatorQueryRowIds                                                                    :488-496
        └─ turnDirectoryEntries → rail items 合并层（与已加载去重）
```

### 4.2 props 形状（数据层相关）

`ConversationTimelineProps` 中由本模块定义的字段：
- `rows: readonly ConversationRow[]`（`:280`）
- `totalCount: number`（`:286`，来自 `rows.totalCount`）
- `sessionKey: string`（`:291`，**必须等于 SessionPane 的 `sessionId ?? "draft"`**，即缓存 scopeKey）
- `lastMutation?: ConversationProjectionLastMutation | undefined`（`:297`，缺省即无失效依据 → 缓存退化为全量）
- `sessionPhase?: SessionPhase`（`:373`）
- `loadingDirectory: boolean`（`:325`）、`turnDirectory?: ConversationTurnNavigatorDirectoryView`（`:327`）、`turnDirectoryEntries`（`:329` 注释）、`turnNavigatorDirectoryRevision`（`:4609` 传入）、`onLoadTurnDirectory`（`:323`）

### 4.3 phase / scopeKey 约定（三处必须同源）

| 消费点 | scopeKey 实参 | sessionPhase 实参 |
|---|---|---|
| `SessionPane.tsx:661-663`（shareRenderUnits） | `sessionId ?? "draft"` | `sessionRenderPhase`（`:600` = `isDraft ? undefined : snapshot?.control.phase`） |
| `ConversationTimeline.tsx:479`（renderUnits） | `sessionKey` prop，传入值 `sessionId ?? "draft"`（`SessionPane.tsx:4591`） | `sessionPhase` prop，传入值 `sessionRenderPhase`（`SessionPane.tsx:4658`） |
| 缓存句柄的作废条件 | `renderUnits:179-186`：`nextScopeKey !== scopeKey \|\| sessionPhase !== cachedSessionPhase` → `cacheByTurnId.clear()` + `lastUnitTurnId = null` | 同左 |

事实：`ConversationShareReadonlyTimeline.tsx:60/1084` 仍走**无缓存的**全量 `buildConversationTurnRenderUnits(rows)`，未接入共享句柄（spec:50 明确「不动」）；因此不存在第三个消费方冲掉共享缓存。

另注：`SessionPane.tsx:1136` 存在另一处名为 `scopeKey` 的局部变量（`${workspaceKey}\u0000${sessionId ?? "draft"}`，用于 assistant PPTX 自动打开门），与本模块缓存句柄的 scopeKey 无关。

### 4.4 构建顺序

`shareRenderUnits`（`:659`）位于 SessionPane 组件体，在子组件 `ConversationTimeline`（`:4583`）渲染之前执行 → 父先填充缓存、子后命中，与 `core:33-36` 注释所述「后一份直接命中前一帧写下的缓存条目」一致；`:246` 的 `lastUnitTurnId` 更新也由父先写。

---

## 5. 已核对为「无问题」的项（留痕，避免重复取证）

- `hasOlderRows`（`store:267-272`）读 `rows.window[0].rowId` 与 `rows.firstRowId`，两字段在 `publishConversationShell`（`core:167`）与三处 rebuild 入参（`store:1147/1265/1300`）中均保留。
- `mergeOlderRows` 返回 `null` 时调用方不换引用：`store:1142`、`store:1259`、`store:1294` 均 early-return / stale。
- `logSubagentProjectionTransition` 在 delta 分支用 `current`（上一帧发布的外壳）作 previous（`store:841`），在 snapshot 分支用 `this.state.snapshot`（`store:771`），两者都不是 accumulator 本体。
- `statePatchSchema` 键集合封闭断言属 T-AP1（`packages/shared/test/apply.test.ts`，不在本模块范围）。
- `turnDirectoryView` 在 `loaded === false` 时下发 `undefined` 的闭环自锁防护，与 `scheduleTurnDirectoryRequery` 的 `loaded` 闸门（`store:1498`）配合形成完整首查路径：`shouldHydrateConversationTurnNavigatorDirectory` 落回 `canLoadOlder` 放行 → store 首查 → `loaded=true` → 之后才允许 revision 触发的去抖重查。