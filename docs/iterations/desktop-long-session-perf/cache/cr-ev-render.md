---
head_sha: d11a97c2ac736e53a12dc2eb7055a5a98b84dc06
base_sha: ba7c240343aa36b6f97ef78f4b67104fb675b9a5
date: 2026-10-05
scope: 渲染层与目录 UI（ConversationTimeline / ConversationTurnGroup / ConversationTurnNavigator / ConversationRowView / conversationTurnNavigatorHelpers / conversationTurnNavigatorDirectory / SessionPane / i18n / 新测试）
spec_ref: docs/iterations/desktop-long-session-perf/spec.md（总体方案 B + Step 6/7/8/18/19 + T-TD4）
role: evidence-only（只取证，不下结论、不给评级）
---

# 取证包：渲染层与目录 UI

## 0. 取证方法与命令留痕

- 差异范围：`git diff --stat ba7c240 d11a97c -- <scope>` → 11 文件 / +1536 / -208。
- 单测实跑：`npx tsx --test packages/ui/test/conversationTurnNavigatorDirectory.test.ts packages/ui/test/conversationTurnNavigatorHelpers.test.ts` → **16 pass / 0 fail**。
- 全仓 `nowMs` / `liveNowMs` / `RUNNING_WORK_DURATION_TICK_MS` 残留检索：`packages/ui/src` 下无任何 `liveNowMs` 与 `RUNNING_WORK_DURATION_TICK_MS`；`nowMs` 仅剩 `BotsDialog.tsx`、`useCodingPlanQuotaResetUi.ts`、`settings/model-provider-section/utils.tsx` 三处**与本模块无关**的存量用法，以及三处注释（`conversationTurnRenderUnits.ts:87`、`conversationTurnWorkSegments.ts:62/64/133`）。

---

## 1. spec 声明 vs 代码现状（逐条）

### 1.1 liveNowMs 彻底下线（spec Step 6 / B-1）

| spec 声明 | 代码现状（file:line） | 事实判定 |
|---|---|---|
| 删除 `liveNowMs` state（`:408`） | `ConversationTimeline.tsx:472-483` 的 `renderUnits` useMemo 直接调 `conversationTurnRenderUnitsCache.build`；全仓无 `liveNowMs` state | 已删 |
| 删除每秒 interval effect（`:562-575`） | 原 effect 在 diff 中整块删除（`hasRunningUnit` 与 `RUNNING_WORK_DURATION_TICK_MS` 常量 `:105` 亦删） | 已删 |
| 删除 `buildConversationTurnRenderUnits` 的 `nowMs` 实参 | `BuildConversationTurnRenderUnitsOptions`（`conversationTurnRenderUnitsDraft.ts:80-87`）现在**只剩** `sessionPhase` 与 `scopeKey`；`conversationTurnRenderUnits.ts:262-265` 全量版签名亦无 options.nowMs | 已删 |
| 计时下沉到 `WorkingDurationText`（memo 子组件，仅 running 起 interval） | `ConversationTurnGroup.tsx:566-606`：`memo(function WorkingDurationText)`，`live = state === "running" && startedAt !== undefined`，`useEffect(..., [live, startedAt])` 起 1000ms interval，返回 `clearInterval` cleanup | 已落地 |
| `ConversationTurnWorkSegment` 扩展 `startedAt`，取值与 `resolveSegmentDurationMs` 逐分支同源 | `conversationTurnWorkSegments.ts:28-32`（字段）、`:136-152`（`resolveSegmentStartedAt`）；分支：有 fact → `fact.startedAt`；无 fact 且 `segmentCount === 1` → `header.startedAt`；无 fact 且多段 → `triggerRow?.createdAt ?? header?.startedAt`。与同文件 `:108-135` 的 `resolveSegmentDurationMs` 分支一一对齐 | 已落地 |
| `resolveConversationTurnWorkDurationMs` 去掉 `options.nowMs` / `isRunning` 参数 | `conversationTurnWorkSegments.ts:54-66` 签名收敛为 `(header)`；唯一调用点 `conversationTurnRenderUnitsDraft.ts:400` 同步更新 | 已落地 |
| 第二消费点 `ConversationShareReadonlyTimeline.tsx:789` 不受影响、不动 | 该文件 `:1084` 仍调 `buildConversationTurnRenderUnits(rows)`（无 options）；`:789` 仍读 `segment.workStatus?.durationMs`——**注意**：构建器已不再为 running 段烘焙 durationMs（`resolveSegmentDurationMs` 删了 nowMs 外推分支，`:131-133` 注释明示），故分享只读面上「工作中 N 秒」在 running 且缺 `activeMs/endedAt` 时会退化为空 duration | 事实记录，见可疑点 S-07 |
| `workingFor` 文案在 duration 缺失时的表现 | `ConversationTurnGroup.tsx:600-602` `state === "running"` 分支仍用 `label ?? ""` 兜底（与 base 同） | 与旧行为一致 |

### 1.2 滚动 O(N) 消除（spec Step 7 / B-2）

| spec 声明 | 代码现状 | 事实判定 |
|---|---|---|
| helpers 纯函数新增可选参数 `itemByUnitIndex?: Map`，缺省自建、向后兼容可单测 | `conversationTurnNavigatorHelpers.ts:36-45`（接口字段 + 注释）、`:271-272`（`options.itemByUnitIndex ?? new Map(...)`） | 已落地 |
| 组件侧 `useMemo([items])` 构造后传入 | `ConversationTurnNavigator.tsx:125-128` `loadedItemByUnitIndex`，`:134-145` 传入 | 已落地（且刻意**只喂已加载 items**，见 1.4） |
| active 触发量化**写死** `Math.floor(scrollOffsetPx / DEFAULT_ROW_HEIGHT_ESTIMATE_PX /* =72 */)`，deps 用量化值 | `ConversationTurnNavigator.tsx:132-133` 引入 `DEFAULT_ROW_HEIGHT_ESTIMATE_PX`（`timelineRowHeightCache.ts:11` 确认为 `72`），`:139` 把量化值还原成 `scrollRowBucket * 72` 再喂入，`:144` deps 只含 `scrollRowBucket` 不含 `scrollOffsetPx` | 已落地 |
| deps（量化值）与函数体（Map 传入）同处一个 useMemo | `:134-145` 同一 useMemo | 已落地 |
| （额外）`normalizedPositions` 可选参数 + `normalizeConversationTurnNavigatorQueryPositions` 导出 | `conversationTurnNavigatorHelpers.ts:53-56 / 66-69 / 315-345` | 已实现，但**生产零消费**（见可疑点 S-08） |

### 1.3 reflow 消除（spec Step 8 / B-3）

| spec 声明 | 代码现状 | 事实判定 |
|---|---|---|
| 注册点在 `ConversationRowView.tsx` 的 `RowShell`（`data-row-id` 真实产地） | `ConversationRowView.tsx:158-176` `RowShell` 挂 `ref={handleRowRef}`；全仓 `<RowShell` 调用点 10 处（`:187/1075/1217/1222/1333/1525/1596/1618/1637/1897/1938/1960/2056`） | 已落地 |
| ref callback 幂等 delete+set，兼容 StrictMode 双挂载 | `:140-144` `registerRowElement`：`rowElements.delete(rowId)` 后条件 set | 已落地 |
| 模块级单例 registry，卸载注销 | `:130` `const rowElements = new Map<number, HTMLElement>()`；`:138` 以 `ReadonlyMap` 导出；卸载由 ref callback 收到 `null` 走 delete | 已落地 |
| session 切换清空（与 `timelineRowHeightCache` 同生命周期） | `ConversationRowView.tsx:146-156` `clearRowElementRegistry()`；调用点唯一：`ConversationTimeline.tsx:1608-1613`（`sessionKey` 的 `useLayoutEffect` 内，`rowElementRegistrySessionRef` 判重） | 已落地，但清理策略是**只剪 `isConnected === false`**，非全量 clear（设计说明见 `:146-151`） |
| `syncTurnNavigatorViewport` 改查 registry | `ConversationTimeline.tsx:969-1004`，`:977-983` 由 `element.querySelectorAll("[data-row-id]")` 改为遍历 `turnNavigatorQueryRowIdsRef.current` + `rowElementRegistry.get(rowId)` | 已落地 |

### 1.4 items 合并（spec Step 18）

| spec 声明 | 代码现状 | 事实判定 |
|---|---|---|
| items = 目录 + 已加载去重合并 | `ConversationTurnNavigator.tsx:108-121` `mergeTurnNavigatorItems(directoryEntries ?? [], loadedItems, windowFirstRowId, {...})` | 已落地 |
| 去重键 = queryRowId，**已加载侧优先** | `conversationTurnNavigatorDirectory.ts:126-131`：`loadedByRowId.get(...)` 命中则 `push({...loaded, isDirectoryFallback:false})` | 已落地 |
| 落在已加载窗口范围之内却无对应 item 的目录项**直接丢弃** | `:133` `if (windowFirstRowId !== undefined && entry.queryRowId >= windowFirstRowId) continue;` | 已落地 |
| 目录未收录的已加载项不能丢 | `:137-143` 第二轮补齐 | 已落地 |
| 输出按 rowId 升序、稳定 | `:146` `merged.slice().sort((l,r)=>l.rowId-r.rowId)`（`slice()` 避免改传入数组；`Array#sort` 在 V8 为稳定排序） | 已落地 |
| 降级 item：`key` 走目录口径、`unitIndex` 取目录序、`assistantPreviewKind` 直传三态、running/empty 文案由客户端 i18n 填 | `:70-97`：`key = ${turnId}:query:${queryRowId}`；`unitIndex` 由调用方传 `merged.length`；三态分支填 `options.assistantRunningPreview / assistantEmptyPreview` | 已落地 |
| active 三态：已加载主循环 / 未加载取第一个未加载目录项 / 混合态已加载优先 | `conversationTurnNavigatorDirectory.ts:190-203` `resolveTurnNavigatorActiveItemIndex`；组件侧 `ConversationTurnNavigator.tsx:158-171` | 已落地 |
| T-TD4：合并无重复、顺序稳定 + active 三态 | `packages/ui/test/conversationTurnNavigatorDirectory.test.ts` 6 个用例，实跑全绿 | 已落地 |

补充事实：`loadedItems` 与 `activeUnitIndex` 计算**刻意与合并 items 解耦**（`ConversationTurnNavigator.tsx:98-106 / 125-145`），并新增 `mergedByLoadedUnitIndex`（`:146-156`）把 unitIndex 映射到合并后下标——避免了降级项占位 `unitIndex` 撞键。

### 1.5 跳转闭环（spec Step 19）

| spec 声明 | 代码现状 | 事实判定 |
|---|---|---|
| `scrollToQuery` 改 **async** | `ConversationTimeline.tsx:1354-1507`（`async (target, behavior = "auto") => {...}`） | 已落地 |
| 单页 limit=200（`rowsRangeMaxLimit`），**最大 50 页** | `:115-116` `JUMP_LOAD_PAGE_LIMIT = PROTOCOL_V4_LIMITS.rowsRangeMaxLimit`（`core.ts:76` = 200）、`JUMP_LOAD_MAX_PAGES = 50` | 已落地 |
| 到顶/未命中 → 放弃并 **toast 提示** | `:1444-1456` `logger.warn` + `toast(intl.formatMessage({id:"chat.turnNavigator.jumpTargetUnavailable"}), {variant:"warning", dedupeKey:"turn-navigator-jump-unavailable"})`；i18n key 双语已加（`en-US.ts:2010`、`zh-CN.ts:1886`） | 已落地 |
| 完成后改查 `rowElementRegistry` 定位 DOM | `:1368-1376` `registered?.isConnected === true ? registered : element.querySelector(...)`（注册表优先 + 选择器兜底） | 已落地 |
| 补拉页合并进 window（走 `loadOlder` 而非探测页） | `:1413-1417` 调 `loadOlderRef.current.onLoadOlder(JUMP_LOAD_PAGE_LIMIT)`；`SessionPane.tsx:3467-3473` `handleLoadOlder(limit?)` → `lease.store.loadOlder(limit)`；`conversationProjectionStore.ts:1115/1141-1151` 确认 `mergeOlderRows` 前插合并 | 已落地 |
| loading 态 | `:572` `turnNavigatorJumpLoading` state + `:1917` `data-jump-loading` 属性；`:1403` 无条件置位、`:1504-1506` `finally` 中 `if (!isStaleJump()) setTurnNavigatorJumpLoading(false)` | 部分落地（见可疑点 S-05：该 state 无任何消费方） |
| （实现额外）rowId 反查 unitIndex | `:1346-1352` `findUnitIndexByRowId` 扫 `unitsRef.current` 的 `visibleUserInputs`；`:1459-1466` 解析失败则 warn 放弃 | 已落地 |
| （实现额外）防重入序号失效 | `:571` `turnNavigatorJumpSeqRef`；`:1357-1359` 每次跳转自增并生成 `isStaleJump()`；循环内 `:1412 / 1422 / 1444` 与对齐帧 `:1491` 逐点检查；`sessionKey` 变更 cleanup `:1532-1542` 自增作废在途跳转 | 已落地 |

### 1.6 SessionPane 接线（spec Step 12/17/18/19 渲染侧）

| spec 声明 | 代码现状 | 事实判定 |
|---|---|---|
| `shareRenderUnits` 改走共享增量缓存（非分享态也在跑的那份） | `SessionPane.tsx:654-667` `conversationTurnRenderUnitsCache.build(snapshot?.rows.window ?? [], {sessionPhase, scopeKey}, state.lastMutation?.turnIdByRowId)` | 已落地 |
| phase 口径与 Timeline 双向对齐（同一不变量） | `SessionPane.tsx:589-600` `isDraft` + `sessionRenderPhase = isDraft ? undefined : snapshot?.control.phase`；`:4658` `sessionPhase={sessionRenderPhase}`；`:663` 同一变量喂 `shareRenderUnits` | 已落地（单一来源，两处引用同一变量） |
| `turnDirectoryView` 门控 + `hasMore`/`realUserQueryTotal` 仅在 `loaded` 后下发 | `SessionPane.tsx:3496-3511`：`loaded` / `entryCount` / `realUserQueryTotal: loaded ? … : undefined` / `hasMore: loaded ? … : undefined`，useMemo 依赖逐字段列出 | 已落地（注释 `:3483-3495` 明写「留 undefined 否则首查被 `total<2` 挡死 + store 重查要求 loaded → 闭环自锁」） |
| `handleLoadOlder` 加 limit 形参 | `SessionPane.tsx:3467-3473` | 已落地 |
| `onLoadAllOlder` → `onLoadTurnDirectory`，`loadingOlder` → `loadingDirectory`，新增 `turnDirectoryEntries` | `SessionPane.tsx:4601-4609`；`ConversationTimeline.tsx:312-336` props 契约 | 已落地 |
| 目录首查门控改走 `shouldHydrateConversationTurnNavigatorDirectory` 新签名 | `ConversationTimeline.tsx:666-740`（deps 中 `rows`/`totalCount` 已移除，改 `turnDirectory`） | 已落地 |
| rail 显隐与左 48px gutter 同源 | `ConversationTimeline.tsx:1862-1866` `turnNavigatorRailHidden` + `turnNavigatorOccupiesLeftGutter`；`:1890` `hideTurnNavigator \|\| turnNavigatorRailHidden` 时不渲染 rail；`:1939-1940` gutter class | 已落地（语义变化见 S-06） |
| `loadAllOlder` 保留为正文/分享路径 | `SessionPane.tsx:3513-3532`（分享 hydration effect 仍用它），Timeline 侧已无任何 `onLoadAllOlder` 调用 | 已落地 |

---

## 2. diff 变更点清单（scope 内）

| 文件 | 变更点 |
|---|---|
| `ConversationTimeline.tsx`（+358/-…） | ① props：`lastMutation` / `onLoadOlder(limit?)` / `onLoadTurnDirectory` / `loadingDirectory` / `turnDirectory` / `turnDirectoryEntries`，删 `onLoadAllOlder`；② `renderUnits` 换共享增量缓存（deps 加 `lastMutation`）；③ 删 `hasRunningUnit` + `liveNowMs` + interval；④ 新增 `waitForNextFrame()`（rAF + 64ms setTimeout 双保险）；⑤ hydration effect 换目录查询；⑥ `syncTurnNavigatorViewport` 改查 registry；⑦ 新增 `findUnitIndexByRowId`；⑧ `scrollToQuery` 改 async + 补拉循环 + toast + 序号防重入 + `finally` 清 loading；⑨ `sessionKey` cleanup 作废在途跳转 + 清 registry；⑩ rail 显隐 / gutter 同源；⑪ `data-jump-loading` |
| `ConversationTurnGroup.tsx`（+66） | 抽出 `WorkingDurationText`（memo + 自持 interval），`AssistantHistoryStatus` 改为薄壳；删 `open` 参数透传（原 `AssistantHistoryStatus` 的 `open` 仅用于 data 属性，已保留在壳上） |
| `ConversationTurnNavigator.tsx`（+125） | props 增 `directoryEntries` / `windowFirstRowId` / `onJumpToQuery` 目标增 `isDirectoryFallback`；i18n 三段文案提到组件顶层；`loadedItems` / `items`(合并) / `loadedItemByUnitIndex` 三个 memo；量化 72；`itemIndexes` 由 `firstByUnitIndex` 改 `mergedByLoadedUnitIndex`；active 三态；`data-directory-fallback` 属性 |
| `ConversationRowView.tsx`（+35） | 模块级 `rowElements` + `rowElementRegistry`(ReadonlyMap) + `registerRowElement` + `clearRowElementRegistry`；`RowShell` 挂 ref callback |
| `conversationTurnNavigatorHelpers.ts`（+203） | item 类型权威源搬到目录模块并 type-only 回导；摘要三件套下沉 `@zcode/shared`（本地实现删除）；`itemByUnitIndex` / `normalizedPositions` 可选参；`ConversationTurnNavigatorDirectoryView` 新类型；`shouldHydrateConversationTurnNavigatorDirectory` 签名重写（`loadingOlder`→`loadingDirectory`，加 `realUserQueryTotal` / `directoryHasMore`）；新增 `shouldHideConversationTurnNavigatorRail`；新增 `normalizeConversationTurnNavigatorQueryPositions` |
| `conversationTurnNavigatorDirectory.ts`（新 204） | 零导入纯模块：`ConversationTurnNavigatorItem` / `…DirectoryEntry` / `…MergedItem` 类型 + `buildTurnNavigatorDirectoryFallbackItem` + `mergeTurnNavigatorItems` + `classifyTurnNavigatorActiveScope` + `resolveTurnNavigatorActiveItemIndex` |
| `SessionPane.tsx`（+91） | `isDraft` 上移；`sessionRenderPhase` 单一 phase 源；`shareRenderUnits` 走共享缓存；`handleLoadOlder(limit?)`；`handleLoadTurnDirectory`；`turnDirectoryView` 窄面；Timeline props 换目录通道；`sessionPhase={sessionRenderPhase}` |
| `i18n/locales/{en-US,zh-CN}.ts` | 各 +1 行 `chat.turnNavigator.jumpTargetUnavailable`（对称，见 §3.5） |
| `test/conversationTurnNavigatorDirectory.test.ts`（新 249） | 6 用例：合并去重/顺序稳定/窗口内丢弃/降级 item 口径/active 三态/边界 |
| `test/conversationTurnNavigatorHelpers.test.ts`（新 411） | 10 用例：Map 传/不传等价 ×2、空 items、量化桶内稳定、量化偏差 ≤ 一行、normalizedPositions 等价、目录门控 ×4 |

---

## 3. 可疑点（file:line + 事实，不含评级）

> 编号 S-xx 供后续评审引用。每条只陈述可核验事实与「若…则…」的条件链，不做严重度判断。

### S-01 `rowElementRegistry` 是模块级单例，但 `ConversationTimeline` 可多实例并存（跨 pane 撞号）

- 事实：`ConversationRowView.tsx:130` 单例 `rowElements`，`:138` 以 `ReadonlyMap` 导出，无 session/pane 维度。
- 事实：`ConversationTimeline` 的挂载点不止一处——`SessionPane.tsx:4583`，而 `SessionPane` 被 `V4ChatPane.tsx:126`、`SelectionSideChatPane.tsx:37`、`SubagentSessionSidePane.tsx:41`、`WorkflowActorSessionSidePane.tsx:94`、`WorkbenchPane.tsx:548` 同时/先后挂载；`AnimatedSidePanePanel.tsx:1108/1123/1163` 在 side pane 可见时挂载，`workspaceSidePane.ts:541-551` 的 `shouldMountSidePaneContent` 还允许 browser/bash 类 tab 后台常驻。
- 事实：注释自认 rowId 跨会话可重复（`ConversationTimeline.tsx:1608-1609`、`SessionPane.tsx` 相邻注释、`timelineRowHeightCache` 同款生命周期）。
- 条件链：若 pane A 与 pane B 同时挂载且都渲染 rowId=N 的行，`registerRowElement` 的 `delete+set`（`ConversationRowView.tsx:142-143`）会让后挂载者覆盖前者；`clearRowElementRegistry`（`:152-156`）只剪 `isConnected === false`，**另一 pane 仍挂载的行 isConnected 为 true，不会被剪**。此时 `syncTurnNavigatorViewport`（`ConversationTimeline.tsx:977-983`）与 `scrollToQuery`（`:1371-1375`）拿到的 `HTMLElement` 可能属于另一个 pane，`getBoundingClientRect` 得到的是别处坐标 → activeQueryRowId / 滚动落点失真。

### S-02 `scrollToQuery` 跨 `await` 期间切会话：`element` / `rowsRef` 已捕获但只有序号一道闸

- 事实：`:1397` `const element = scrollRef.current` 在任何 `await` 之前捕获；`:1405` `isRowLoaded()` 读 `rowsRef.current`；`:1413` `loader = loadOlderRef.current` 每次迭代重取（这点是好的）。
- 事实：作废手段只有 `turnNavigatorJumpSeqRef`（`:1357-1359`），由 `sessionKey` 的 effect cleanup（`:1532-1542`）自增。
- 条件链：`sessionKey` 变更 → cleanup 在 commit 后执行 → 序号自增 → 后续 `isStaleJump()` 为真并 `return`。**但** cleanup 与 `await` 恢复的相对顺序取决于微任务/帧边界；若某次 `await loader.onLoadOlder(...)`（`:1417`）已把请求发出，会话切换不会取消 store 侧的 `rowsRange` 请求（`conversationProjectionStore.ts:1125-1151` 只在 `closed` 或 `logEpoch` 不匹配时丢弃）。该请求本身幂等（按 `beforeRowId` 游标 + `mergeOlderRows` 前插），风险面在于「新会话的行被并进旧 store 的 snapshot」这一路径是否可达——取决于 `lease` 切换时旧 store 是否已 `close()`（`:1481/1482` 有 `this.closed` 判定）。**未取证到 lease 关闭时机，不下结论。**

### S-03 `setTurnNavigatorJumpLoading(false)` 在 stale 分支被跳过 → 切会话后 `data-jump-loading` 可能永久 "true"

- 事实：`:1504-1506`
  ```
  } finally {
    if (!isStaleJump()) setTurnNavigatorJumpLoading(false);
  }
  ```
- 事实：`turnNavigatorJumpLoading` 是 `useState`（`:572`），`ConversationTimelineImpl` 是 `memo` 组件但**没有 `key`**（`SessionPane.tsx:4583` 无 key），`sessionKey` 变化不会重挂载该实例。
- 条件链：跳转在途 → 用户切会话 → `sessionKey` cleanup（`:1532-1542`）把序号作废 → `finally` 因 `isStaleJump()` 为真而**不**清零 → 新会话继承 `turnNavigatorJumpLoading === true`，此后既无新的跳转来清（`:1403` 只置位不清），也无 sessionKey 相关的重置 effect。该 state 目前唯一消费点是 `:1917` 的 `data-jump-loading` 属性。

### S-04 目录降级项的 `unitIndex` 是**排序前**的插入序号，与最终 rail 下标可能不一致

- 事实：`conversationTurnNavigatorDirectory.ts:134`
  ```
  merged.push(buildTurnNavigatorDirectoryFallbackItem(entry, merged.length, options));
  ```
  即 `unitIndex` 取的是 push 那一刻的 `merged.length`；而 `:146` 之后才对整个 `merged` 按 `rowId` 升序 `sort`。
- 事实：`:128-131` 的「目录项命中已加载侧」分支同样会把已加载 item push 进 `merged`，其后 `:137-143` 又追加目录未收录的已加载项——这三类 push 交错时，插入序与最终 rowId 序不一致。
- 事实：`Array#sort` 稳定，故相等 rowId 相对序不变，但**不同 rowId 的降级项 unitIndex 会被重排**。
- 影响面（事实）：`unitIndex` 的消费点为 `ConversationTurnNavigator.tsx:253` `data-unit-index` 属性、`:266` `onJumpToQuery` 实参、以及 `:152` `mergedByLoadedUnitIndex` 的 key。`mergedByLoadedUnitIndex` 只收 `!isDirectoryFallback` 的项（`:152`），故不与降级项撞键；`onJumpToQuery` 的 `unitIndex` 在 Timeline 侧被 `:1459` `findUnitIndexByRowId` 覆盖。故实际渲染与跳转不受影响，**但 `data-unit-index` 与 `data-item-index`（`:252`）在降级项上会不一致**，DOM 断言若按 `data-unit-index` 定位会踩坑。
- 现有测试的覆盖边界（事实）：`conversationTurnNavigatorDirectory.test.ts:137-140` 断言降级项 `unitIndex === [0,1,2]`，但该用例的入参本身就是「全部目录项、windowFirstRowId=40、无已加载项」的纯升序场景，**未覆盖交错 push 后的 reindex**。

### S-05 `turnNavigatorJumpLoading` 与 `data-jump-loading` 无生产消费方

- 事实：全仓检索 `data-jump-loading` / `jump-loading`（`packages/ui/src`、`scripts/`、`apps/`）**零命中**，仅 `ConversationTimeline.tsx:1917` 一处写入。
- 事实：spec Step 19 要求「loading 态」，当前实现只有 DOM 属性，无 UI 反馈（无 spinner / 禁用点击）。
- 相邻事实：`aria-busy={isHydratingDirectory}`（`ConversationTurnNavigator.tsx:209`）仍指向目录查询态，不反映跳转补拉。

### S-06 左 gutter 占用条件从「已加载 query ≥ 2」放宽为「目录存在且未隐藏」，窄视口下可能白占 48px

- 事实：旧条件 `turnNavigatorQueryRowIds.size >= 2`（diff 中被替换）；新条件 `ConversationTimeline.tsx:1865-1866`
  ```
  turnNavigatorQueryRowIds.size >= 2 || (Boolean(turnDirectory) && !turnNavigatorRailHidden)
  ```
- 事实：`turnDirectory` 由 `SessionPane.tsx:4606` **无条件传入**（`turnDirectoryView` useMemo 恒返回对象），故 `Boolean(turnDirectory)` 在接入后恒为 true，只要 `shouldHideConversationTurnNavigatorRail` 返回 false 就占 gutter。
- 事实：而 rail 组件自身在 `items.length < 2` 时 `return null`（`ConversationTurnNavigator.tsx:202-204`），且 rail 整体由 CSS `@min-[864px]/conversation:` 控制显隐（`:213`）。
- 条件链：`turnDirectory.loaded === false`（未取过目录）时 `shouldHideConversationTurnNavigatorRail` 恒返回 false（`conversationTurnNavigatorHelpers.ts:165-166`）→ gutter 被占用；但此时 `items` 可能只有 0–1 条 → rail 渲染 null → `--markdown-table-layout-left-inset:48px`（`:1939-1940`）生效而 rail 不存在，左侧 48px 让位白占。

### S-07 构建器不再为 running 段烘焙 durationMs，分享只读面的「工作中 N 秒」退化为空串

- 事实：`conversationTurnWorkSegments.ts:120-135`，`resolveSegmentDurationMs` 的两条 running 外推分支（`fact && segmentRunning && nowMs !== undefined`、`startedAt && segmentRunning && nowMs !== undefined`）已删除，`:131-133` 注释明示「运行中且缺 endedAt 的段不给 durationMs」。
- 事实：第二消费点 `ConversationShareReadonlyTimeline.tsx:789` 仍按 `state === "running"` 分支渲染 `chat.history.workingFor {duration}`，其 `duration` 唯一来源就是 `segment.workStatus?.durationMs`（`:789`），且该文件未接 `WorkingDurationText`（未 import，`:65` 只 import `formatConversationWorkDuration`）。
- 条件链：分享只读会话正在 running、turnHeader 缺 `activeMs`/`endedAt`、`fact` 缺 `activeMs`/`endedAt` 时 → `duration === undefined` → 渲染 `workingFor` 且 `duration: ""` → 中文显示「工作中 」（尾部空格），英文 "Working for "。
- spec 原文（Step 6）称该点「不传 `nowMs`，不受影响，不动」——但 base 版本同样不传 `nowMs`，**该退化在 base 就已存在**（base 的 `resolveConversationTurnWorkSegments` 走 `options.nowMs === undefined` 分支同样返回 undefined）。因此这是**存量缺陷被本轮延续**，不是本轮引入的回归。

### S-08 `normalizedPositions` 可选参数与 `classifyTurnNavigatorActiveScope` 均无生产消费方（死代码）

- 事实：`normalizeConversationTurnNavigatorQueryPositions`（`conversationTurnNavigatorHelpers.ts:319`）与 `ResolveConversationTurnNavigatorActiveQueryRowIdOptions.normalizedPositions`（`:66-69`）在 `packages/ui/src` 内**只被同文件 `:343` 的 fallback 引用**，无外部调用方；`syncTurnNavigatorViewport`（`ConversationTimeline.tsx:989-993`）仍传原始 `positions` 让函数内每次 `map().sort()`。
- 事实：`classifyTurnNavigatorActiveScope`（`conversationTurnNavigatorDirectory.ts:170`）在 `packages/ui/src` 内**零引用**，只被 `conversationTurnNavigatorDirectory.test.ts:182/192/216` 调用；其注释自称「只用于判定与日志/测试，不参与渲染」——即无任何日志消费点。
- 影响：spec B-2 只要求 `itemByUnitIndex`（已接线）；这两项是超出 spec 的额外 API 面，未接线即等同死代码（`knip` 不在 pre-push 门禁，见 spec 测试策略段）。

### S-09 `turnNavigatorOccupiesLeftGutter` 与 `hideTurnNavigator` 不同源

- 事实：`:1890` rail 渲染条件是 `hideTurnNavigator || turnNavigatorRailHidden`；`:1865-1866` gutter 条件**不含 `hideTurnNavigator`**。
- 事实：`hideTurnNavigator={shareActive && shareInSelectionStage}`（`SessionPane.tsx:4610`）——分享选择态下 rail 被隐藏，但 48px gutter 仍被占用。
- 事实：base 版本同样不含（diff 显示该行只改了判定表达式，未引入 `hideTurnNavigator`），属**存量**不一致。

### S-10 i18n 双语 key 对称性

- 事实：`en-US.ts:2010` `"chat.turnNavigator.jumpTargetUnavailable": "This question is too far back to load right now"`；`zh-CN.ts:1886` `"chat.turnNavigator.jumpTargetUnavailable": "这条提问太靠前了，暂未能加载到对应内容"`。
- 事实：`packages/ui/src/i18n/locales` 目录下**只有 en-US.ts 与 zh-CN.ts 两个文件**，无第三语言需要同步。
- 事实：消费点唯一（`ConversationTimeline.tsx:1450`），用 `intl.formatMessage({id})` 无插值参数，两侧文案均不含占位符 → 对称性成立。
- 对称性检查方法：`git diff` 两侧各 +1 行，行数与位置一一对应。

### S-11 测试对 DOM 行为的覆盖缺口（组件层无法 Node 测试的部分）

- 事实：`packages/ui/package.json` 与根 `package.json` 中**无 jsdom / happy-dom / @testing-library / vitest 依赖**（检索零命中）；`packages/ui/test/` 现有 6 个测试文件全部是 `node:test` + 纯模块断言。
- 因此以下已实现行为**零自动化覆盖**，全部落在 spec Step 19 的 `qa: manual_user`：
  | 未覆盖行为 | 代码位置 |
  |---|---|
  | RowShell ref 注册 / StrictMode 双挂载幂等 / 卸载注销 | `ConversationRowView.tsx:140-176` |
  | `clearRowElementRegistry` 的 `isConnected` 剪枝语义 + 多 pane 并存（S-01） | `ConversationRowView.tsx:146-156` |
  | `WorkingDurationText` 的 interval 启停 / 卸载清理 / `startedAt` 缺失回退 | `ConversationTurnGroup.tsx:574-606` |
  | `scrollToQuery` 整条 async 补拉闭环（分页上限、无进展 break、toast、防重入、切会话作废） | `ConversationTimeline.tsx:1354-1507` |
  | `waitForNextFrame` 的 rAF/setTimeout 双保险 | `ConversationTimeline.tsx:147-161` |
  | rail 渲染门控 / gutter class / `data-directory-fallback` / `data-jump-loading` | `ConversationTimeline.tsx:1862-1866, 1890, 1939-1940, 1917` |
  | `turnDirectoryView` 窄面「未取过必须留 undefined」的**接线**（helper 层已测，SessionPane 构造处未测） | `SessionPane.tsx:3496-3511` |
  | 量化 72 在组件接线层的 deps 正确性（helper 层已测边界，组件层未测） | `ConversationTurnNavigator.tsx:132-145` |
- 已有覆盖的边界（事实）：helper 层对量化只测了「桶内稳定 / 跨桶才变 / 偏差 ≤ 一行」（`conversationTurnNavigatorHelpers.test.ts:137/194`），未测「真实 virtualItems.start 序列下的 active 结果与量化前逐项一致」。

### S-12 `ConversationTurnNavigator.tsx` 依赖数组项数异常（仅格式事实）

- 事实：`:114-120` 的 `items` useMemo deps 数组被格式化为 6 行单项，`:125-128`/`:134-145` 为单行——风格不一致，lint 未报（无 lint 输出留痕，本次未跑 lint）。
- 未跑门禁的事实：本次取证**未执行** `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed`（只跑了 `npx tsx --test` 两个新增测试文件）。行数事实已核：`conversationTurnNavigatorHelpers.ts` 387 行、ConversationTurnNavigator.tsx 330 行、conversationTurnNavigatorDirectory.ts 204 行、ConversationRowView.tsx 2142 行（首行 `oxlint-disable eslint(max-lines)`）、ConversationTimeline.tsx 2147 行（首行已豁免）、ConversationTurnGroup.tsx 1499 行（首行 `/* eslint-disable max-lines */`）——未豁免的两个文件（helpers 387 / Navigator 330）均 < 400。

---

## 4. 接缝核对（渲染层 ↔ 数据层）

| 接缝 | 渲染层读 | 数据层写 | 双向一致性 |
|---|---|---|---|
| `scopeKey` | `ConversationTimeline.tsx:479` `scopeKey: sessionKey`（`SessionPane.tsx:4591` 传 `sessionId ?? "draft"`）；`SessionPane.tsx:663` `scopeKey: sessionId ?? "draft"` | `conversationTurnRenderUnits.ts:177-186`：`nextScopeKey !== scopeKey \|\| sessionPhase !== cachedSessionPhase` → 整表 clear + `lastUnitTurnId = null` | ✅ 两侧字面量都是 `sessionId ?? "draft"`，同一 session 同一 phase |
| `sessionPhase` | `ConversationTimeline.tsx:479` ← props `sessionPhase` ← `SessionPane.tsx:4658` `sessionRenderPhase`；`SessionPane.tsx:663` 同一变量 | 同上（`:179` 参与 clear 判定） | ✅ 单一来源 `SessionPane.tsx:600`，两侧引用同一变量，无二次推导 |
| `lastMutation` | `ConversationTimeline.tsx:480` `lastMutation?.turnIdByRowId`（props `lastMutation` ← `SessionPane.tsx:4592` `timelineSnapshot ? state.lastMutation : undefined`）；`SessionPane.tsx:664` `state.lastMutation?.turnIdByRowId`（**无 timelineSnapshot 门控**） | `conversationProjectionCore.ts:178-183` 类型定义；`:190-224` `collectMutationTurnIds`（apply 前采集）；`conversationProjectionStore.ts:752/859` 发布；`:1150 / 1267 / 1302 / 775` 在 snapshot 整体替换、loadOlder、loadAllOlder 等路径写 `lastMutation: undefined` | ⚠️ **口径不对称**：`ConversationTimeline` 侧有 `timelineSnapshot ? … : undefined` 门控（快照未就绪时退化全量重建），`SessionPane.shareRenderUnits` 侧无条件传。两者对**同一帧的同一份 rows** 而言，`timelineSnapshot` 为 null 时 Timeline 侧拿到 `undefined` → 全量重建并**回写缓存**（`cacheByTurnId` 的 `keepByPhase`/`unitByKey` 被覆盖），而 shareRenderUnits 侧可能刚用增量结果写入同一缓存。**待核**：`timelineSnapshot` 为 null 的帧（`SessionPane.tsx:3577-3580`：非 draft 且 `(lease === null \|\| !sessionLeaseReady)` 或 `snapshot?.sessionId !== sessionId`）是否与 `snapshot?.rows.window` 非空的帧重叠——若重叠，同一 scopeKey 下两个 build 会交替以不同 dirty 集写入共享缓存（`build` 内部 `:199/224` 用 `isDirty` 决定是否读缓存，且 `:244-246` 会清理不在 `draftByTurnId` 里的轮）。**本次只取证到此，未下结论。** |
| `turnDirectory.entries`（目录态本体） | `SessionPane.tsx:4608` `turnDirectoryEntries={state.turnDirectory.entries}` → `ConversationTimeline.tsx:1902` `directoryEntries` → `ConversationTurnNavigator.tsx:110` `mergeTurnNavigatorItems` | `conversationProjectionStore.ts:1454-1464` 一次性 setState 提交全量 entries；`:184-192` `EMPTY_TURN_DIRECTORY_STATE` 默认 `entries: []`；`:1406-1416` `< 2` 终态写 `entries: []` + `loaded: true` | ✅ 数组整体替换、无原地 mutate；`:1430` `entries.unshift(...result.entries)` 只在提交前操作局部数组 |
| `turnDirectory` 窄面（显隐/水位裁决） | `SessionPane.tsx:3496-3511` 构造 → `ConversationTimeline.tsx:673-678` 喂 `shouldHydrateConversationTurnNavigatorDirectory`、`:1862` 喂 `shouldHideConversationTurnNavigatorRail` | `shouldHydrate…`（`conversationTurnNavigatorHelpers.ts:129-155`）+ `shouldHide…`（`:164-167`）为纯函数，只读入参 | ✅ 语义已对齐（`loaded=false` → 两个 total/hasMore 留 undefined；helper 层 4 个门控用例覆盖） |
| `loadingDirectory` | `ConversationTimeline.tsx:672` 作为 hydration 在途闸门；`:1897` 传 `isHydratingDirectory` → `:209` `aria-busy` | `conversationProjectionStore.ts:1376 / 1482` 置位/清零；`:1346-1350` 单飞（`turnDirectoryQueryInFlight`） | ✅ 语义对应（单飞期间返回 `stale`，helper 侧 `stale → attempt.status = "idle"` 允许重试，见 `ConversationTimeline.tsx:710-712`） |
| `turnNavigatorDirectoryRevision` | `ConversationTimeline.tsx:686` 组进 `hydrationKey`（`sessionKey:logEpoch:revision`），`:738` 进 deps | `conversationProjectionCore.ts:55-71` `shouldInvalidateTurnNavigatorDirectory` / `nextTurnNavigatorDirectoryRevision`；`conversationProjectionStore.ts` 应用；`:1497-1506` `scheduleTurnDirectoryRequery`（250ms trailing，**要求 `loaded === true`**） | ✅ 双向：revision 变更既作废组件 terminal key，又触发 store 重查 |
| `realUserQueryTotal` | `SessionPane.tsx:3500-3502` 仅 `loaded` 后下发 | `conversationProjectionStore.ts:1403` 每页覆盖、`:1406` `< 2` 判终态、`:1457` 提交 | ✅ |
| `rowId` 反查 | `ConversationTimeline.tsx:1346-1352` `findUnitIndexByRowId` 扫 `unit.visibleUserInputs` | 行由 `rows.window` 提供（`conversationProjectionStore` accumulator） | ✅ `visibleUserInputs` 与 `buildConversationTurnNavigatorItems`（`conversationTurnNavigatorHelpers.ts:228`）取的是同一字段 |
| `rowsRange` 补拉合并语义 | `ConversationTimeline.tsx:1417` `onLoadOlder(200)` | `conversationProjectionStore.ts:1115` 默认 `snapshotTailWindowRows`(60) 但接受 limit 覆盖；`:1141` `mergeOlderRows` 前插 | ✅ 用户主动跳转走合并路径（与 `loadTurnDirectory` 的「不并入窗口」`:1338` 明确分离） |

---

## 5. 可疑点索引（便于评审逐条引用）

| 编号 | 一句话 | 主位置 |
|---|---|---|
| S-01 | registry 模块级单例 + 多 pane 并存 → rowId 撞号、`isConnected` 剪枝剪不掉别家 pane | `ConversationRowView.tsx:130-156` |
| S-02 | `scrollToQuery` 跨 await 切会话只有序号一道闸，`element` 已提前捕获 | `ConversationTimeline.tsx:1397-1417` |
| S-03 | `finally` 因 stale 跳过清零 → `data-jump-loading` 跨会话粘 true | `ConversationTimeline.tsx:1504-1506` |
| S-04 | 降级项 `unitIndex` 取排序前插入序，与 `data-item-index` 可能不一致；测试未覆盖交错 push | `conversationTurnNavigatorDirectory.ts:134/146` |
| S-05 | `turnNavigatorJumpLoading` / `data-jump-loading` 无生产消费方，spec 的 loading 态未接 UI | `ConversationTimeline.tsx:572/1917` |
| S-06 | gutter 条件用 `Boolean(turnDirectory)`（恒真）+ 未隐藏 → rail 为 null 时白占 48px | `ConversationTimeline.tsx:1865-1866` |
| S-07 | 构建器不再烘焙 running durationMs，分享只读面「工作中」退化空串（存量延续） | `ConversationShareReadonlyTimeline.tsx:789` |
| S-08 | `normalizedPositions` 与 `classifyTurnNavigatorActiveScope` 生产零消费（死代码） | `conversationTurnNavigatorHelpers.ts:66/319`、`conversationTurnNavigatorDirectory.ts:170` |
| S-09 | gutter 条件不含 `hideTurnNavigator`（存量） | `ConversationTimeline.tsx:1865 vs 1890` |
| S-10 | i18n 双语 key 对称（**已核对通过**，非缺陷，仅留痕） | `en-US.ts:2010` / `zh-CN.ts:1886` |
| S-11 | 组件/DOM 层零自动化覆盖（仓库无 DOM 测试基建），8 项行为仅靠 manual_user | `packages/ui/package.json`（无 jsdom 等） |
| S-12 | deps 数组格式不一致；本轮未跑 typecheck/lint/architecture 门禁 | `ConversationTurnNavigator.tsx:114-120` |

**可疑点计数：11 条实质可疑（S-01…S-09、S-11、S-12）+ 1 条已核对通过项（S-10）。**