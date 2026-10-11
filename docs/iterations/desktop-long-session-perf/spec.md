---
date: 2026-10-05
---

# 桌面端长会话性能优化 技术规格（SPEC）

> r1 审查（cache/sc-review-r1.md：P0×10/P1×16/P2×9）与 r2 审查（cache/sc-review-r2.md：32/35 闭合，仍开放 P0-4/P0-5/P0-10 + 新 P1×3）均已 doc-fix；本版为 r3 送审稿。

## 设计目标

需求来源：`docs/iterations/desktop-long-session-perf/prd.md`（用户已拍板：范围含 P0 数据层 + P1 渲染层 + P2 内存护栏 + 性能度量基建；成功指标口径 = 相对基线改善，基线须在改动前留存）。

本 SPEC 基于三轮共 8 个探索子代理报告 + r1/r2 两轮审查修正。关键现状结论：

1. 协议层（zcode-protocol-v4）本身是窗口化 + 增量 delta，设计正确；病根在 renderer 实现与宽屏 `loadAllOlder` 全量灌入。
2. renderer 侧对「已发布快照不可变」**无实质依赖者**：所有消费点只在同一 render 周期内读 rows，无跨帧 row 缓存、无快照 diff、无 freeze。真正的约束是 React 引用失效语义——全仓约 15 处 `useMemo/useEffect` 以 `[snapshot?.rows.window]` / `[snapshot]` 为依赖（`SessionPane.tsx:643/670/678/740/746/754/962/1132/1691/1697/3757`、`useTreemappingConversationMessage.ts:97`、`usePendingCommandRecovery.ts:36` 等），window 引用不换则这些 memo 全部静默不更新。
3. `apply.ts` 头部「已发布快照不可篡改」是服务端冷恢复的隔离边界约定，不是 renderer 契约；数据流严格单向（server → renderer，`ConversationTransport` 无 publish 方法）。
4. 度量现状为零：无 PerformanceObserver/longtask、`sampleNow()` 返回 boolean（非数据）、dev 下 performance timeline 每 10s 被清空（`performanceTimelineCleanup.ts`）、`[memory]` 日志 60s 采样 + 门控对分钟级窗口太粗。`registry.collect()` 存在（`packages/shared/src/memoryDiagnostics.ts:168/184`），可作免门控取数出口。
5. 造数：`conversationTransportDelayE2E` 只延迟真实 command/ACK，不能伪造 delta 帧；主会话权威数据在 SQLite（无 jsonl 可重放）→ 基线走真实长会话（workspace + sessionId 参数化）。
6. 测试基建现实（r2 实跑验证）：`npx tsx --test` 下 `packages/services/test/*` 可过，而 `packages/ui` 模块因 `@/` 别名导入（如 `conversationProjectionStore.ts:22-25`、`ui/src/lib/memoryDiagnostics.ts:9`）**无法在 Node 下 import**——`conversationTurnNavigatorHelpers.ts` 仅因 type-only import 被剥离而可加载。任何 ui 侧测试的前置是「被测模块传递依赖链零 `@/`」。

## 总体方案

四个正交工作面，按「度量先行 → 低风险渲染热点 → 数据层主干 → 内存护栏 → 终验」推进：

### A. 度量基建（phase-perf-probe / phase-baseline）

**页面内探针 + CDP 取数**（不用 CDP Tracing domain——trace JSON 体积大且解析复杂；页面内 `PerformanceObserver('longtask')` 已聚合好，evaluate 取回即可）：

- 新增 `packages/ui/src/lib/perfProbe.ts`（dev-only，`import.meta.env.DEV` 门控；`packages/web` dev 下同样会挂载，无害——探针无副作用，如需收窄可加 renderer 环境判定）：
  - `PerformanceObserver({ type: "longtask" })` → **自持环形缓冲**（不用 performance.mark/measure——dev 下每 10s 被 `performanceTimelineCleanup` 清空）；
  - `sampleMemory()`：调用新增的 `collectRendererMemorySample()`（不经写盘门控的纯读出口：`uiMemoryDiagnosticsRegistry.collect()` + `performance.memory`），**注意不能暴露 `sampleNow()`——它只返回 boolean**；`MemorySample.role` 为必填联合类型，固定填 `"renderer"`；
  - `reset()`：清空当前段并开启新段（分段语义：reset 开窗）；`dump()`：**返回 JSON 字符串**（CDP `Runtime.evaluate` 以字符串取回），每段含 `{ startedAt, longtasks: [{start, duration}], memory }`；
  - 挂 `window.__zcodePerfProbe`（仿 `commandAckObservability.ts` 的 window 调试面范式）；`App.tsx:141` 附近加一行 `useEffect(() => startPerfProbe(), [])`。
- 新增 `scripts/dev/long-session-perf-sample.mjs`（CDP 采样脚本，骨架抄 `.cu-shots/cdp-verify-historian.mjs` 的 `call/pending/sleep` 封装——`.cu-shots` 在仓库外不入库）。

**dev 实例启动契约**（r1 P0-1 修正——`omz/.vscode/start-electron.mjs` 硬编码 `--inspect-brk=9231` 且不透传 argv，`packages/desktop/scripts/dev.mjs` 同样只 `spawn(electron, ["."])`，**都不能用**）：

1. 采样脚本**自行组装启动**：先确保 renderer dev server 可用（探测 `http://localhost:5174`，不通则报错并提示用户先起 vite dev（如 `.vscode/tasks.json` 的 `zcode: prepare desktop debug` 任务，其职责是起 vite+tsup watch），脚本不负责起构建）；然后 `spawn(electronExecutable, [".", "--open-workspace", workspacePath], { cwd: "packages/desktop", env: { ...process.env, ELECTRON_RENDERER_URL: "http://localhost:5174" } })`——**不带 `--inspect-brk`**（无调试器会挂起首行）；workspace 参数直传 electron 可执行文件（`desktopDeepLinkUrl.ts:9/:224-249` 已支持 `--open-workspace <path>` 与 `=` 两种形态）。
2. **单实例锁探测**：spawn 前先 `fetch("http://127.0.0.1:9229/json/version")`——可达则**不 spawn**，改为向既有实例转发深链（再起一个带 `--open-workspace` 的进程会经 second-instance 通道转给已有实例后自行退出，脚本等待 9229 target 列表出现/变化即可）；不可达且 spawn 后进程秒退（`app.quit()` 锁让位），脚本按失败处理并提示。
3. 脚本驱动采样窗口：流式窗口（打开正在输出/手动触发长输出的会话）+ 滚动窗口（`Input.dispatchMouseEvent` 滚轮或 evaluate 派发 scroll）；调用序列 = `reset()` → 驱动动作 → `dump()`（字符串取回）分段收集 → 输出 JSON 报告到 `docs/iterations/desktop-long-session-perf/`（workspace docs，不入 omz 仓库）。
4. 9229 端口独占：e2e（Chromedriver）与 dev 会抢端口，采样期要求独占 dev 实例（`ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT` 不设）。

基线：用真实长会话（参数化 workspace + sessionId + 行数断言），改动前采集 `baseline-before.json` 并回填 PRD 阈值（「下降一个数量级」的判定线）。

### B. P1 渲染层热点（phase-render-hot）

1. **liveNowMs 彻底下线**（r1 P0-4 + r2 P0-4/N3 补全）：`ConversationTimeline.tsx:409-416` 的 `renderUnits` useMemo deps 去掉 `liveNowMs`，并**删除** `liveNowMs` state（`:408`）、`RUNNING_WORK_DURATION_TICK_MS` 每秒 interval effect（`:562-575`）与 `buildConversationTurnRenderUnits` 的 `nowMs` 实参传递——不删除则每秒仍整棵 `ConversationTimeline` 重渲染，直接违反 PRD 验收「秒级 tick 不引起会话级重算」。
   数据源硬约束：`ConversationTurnWorkSegment` 接口（`conversationTurnWorkSegments.ts:19-28`，现仅 `workStatus?: {state, durationMs?}`）**扩展 `startedAt?: number`**，取值与 `resolveSegmentDurationMs`（`conversationTurnWorkSegments.ts:96-132`）的分支**逐分支同源**：有 `fact`（guide 段命中 `header.workSegments`）→ `fact.startedAt`；无 `fact` 且 `segmentCount === 1`（普通单段 turn）→ `header.startedAt`（`:56/:60` 分支，注意不是 `triggerRow.createdAt`）；无 `fact` 且多段（旧 guide 数据）→ `triggerRow?.createdAt ?? header?.startedAt`（`:125` 兜底链）。`workSegments` 是 optional（`rows.ts:82-84`），普通单段 turn 不命中 `fact`——只取 `header.workSegments[].startedAt` 会恒 undefined 致空时长。
   新抽 **memo 化 `WorkingDurationText` 子组件**消费 `startedAt`，内部 `setInterval`（仅 `state === "running"` 时启动）现算展示时长；`startedAt` 缺失时回退静态 `durationMs`（烘焙值）。`ConversationShareReadonlyTimeline.tsx:789` 是第二消费点（不传 `nowMs`，不受影响，不动）。
2. **滚动 O(N) 消除**（r1 P0-2 修正量化单位）：`conversationTurnNavigatorHelpers.ts:227` 的 `new Map(items.map(...))` 改为**新增可选参数 `itemByUnitIndex?: Map`**，缺省时函数内自建（保持纯函数向后兼容、可单测）；组件侧在 `ConversationTurnNavigator.tsx` 用独立 `useMemo([items])` 构造后传入。`activeUnitIndex`（`:76-85`）的触发量化**写死为** `Math.floor(scrollOffsetPx / DEFAULT_ROW_HEIGHT_ESTIMATE_PX /* =72, timelineRowHeightCache.ts:11 */)`（主时间线行高量级；不是 rail 的 10px——那是 rail 自身行高，与主滚动偏移单位不匹配）。deps（量化值）与函数体（Map 传入）同处一个 useMemo，一并声明。
3. **reflow 消除**（r1 P0-3 + r2 补范围说明）：注册点在 **`ConversationRowView.tsx:130-148` 的 `RowShell`**（`data-row-id` 的真实产地，当前 10 个调用点；非 RowShell 的另 6 处 `data-row-id` 不在 `syncTurnNavigatorViewport` 的 `turnNavigatorQueryRowIdsRef` 路径上——该路径只关心 query 行，query 行全部经 RowShell 渲染）。RowShell 挂 ref callback 写入模块级 `rowElementRegistry: Map<rowId, HTMLElement>`（卸载注销；ref callback 写成幂等 delete+set，兼容 StrictMode 双挂载）；registry 为模块级单例，随 session 切换清空（与 `timelineRowHeightCache` 同款生命周期）。`syncTurnNavigatorViewport`（`ConversationTimeline.tsx:906-940`）的 `querySelectorAll("[data-row-id]")` 改查 registry（仍需 `getBoundingClientRect` 取位置，但免去全容器 DOM 扫描）。
4. **摘要截断前置**（r1 P0-5 + r2 P0-5 改为流式折叠等价方案）：`buildPreviewText`（`conversationTurnNavigatorHelpers.ts:119-135`）改为**流式折叠 + 计数**：按空行分段（扫描中遇空白段边界即切换），段内对字符做与旧 `replace(/\s+/gu," ")` **逐字节等价**的流式折叠（连续空白折叠为单空格），累计输出达到 `maxChars - 3` 预算即停止扫描（不再读后续字符）；段数达 2 段上限同停；最终若发生截断，按旧规则 `trimEnd() + "..."` 补点。折叠运算是前缀单调的（任意前缀的折叠结果可由流式状态导出），因此对任意输入（maxChars 为有限非负整数时）输出与旧「全文清洗→取前 2 段→截断」**逐字节一致**；扫描量以遇到第一个非空白码元或 emit 预算用尽为界，含长空白串的输入扫描量可达输入全长——逐字节等价的必要代价。`truncatePreview`/`normalizePreviewParagraphs` 的常量口径（220/2 段，`:99-100`）不变。

### C. P0 数据层（phase-delta-apply / phase-turn-directory）

#### C1. renderer 可变累加器 + copy-on-notify + renderUnits 增量重建（phase-delta-apply）

- `conversationProjectionStore.ts:722` 的 `applyConversationDeltas(current, deltas)` 改为 store 内持有可变累加器：`createMutableConversationSnapshotAccumulator`（`apply.ts:24-35`，**构造器**）+ `applyConversationDeltasMutable`（`apply.ts:213`，**批量可变应用入口**；单条为 `applyConversationDeltaMutable:153`）——不新写 delta 分派逻辑（r2 N4 修正；服务端先例 `product-projection.ts:1039/1085`）：
  - **copy-on-notify 三层换引用**（硬约束）：通知时产出新的 `window` 数组 + 新 `rows` 对象 + 新 `snapshot` 外壳，**发布外壳副本而非 accumulator 本体**。理由（r1 P1-1 修正）：`setState` 本来每帧就换 `state` 外壳（`:387-390`），getSnapshot 契约不是主要威胁；**真正的硬约束是约 15 处 `[snapshot?.rows.window]` memo 依赖引用变化才失效**——window/rows/snapshot 三层不换，下游静默不更新；只换 window 漏 `[snapshot]` effect（`usePendingCommandRecovery.ts:36`），只换 snapshot 漏全部 `[rows.window]` memo。
  - **读本体禁令**（r2 N5 扩面）：copy-on-notify 之后，store 内**所有**读 snapshot 的后续步骤——`logSubagentProjectionTransition`（`:725`，改为 apply 前抓取 `previousIds` 快照）、`reconcileOptimistic`（`:754`→`:1294`）、`reconcileAcceptedInputProjection`（`:755`→`:1319`）、`observeModelTransition`（`:756`→`:760-770`）——必须读**发布后的外壳副本**，不得读 accumulator 本体（否则读到「已发布但仍在变」的对象）。
  - **统一 rebuild 入口**：snapshot 帧整体替换（`:666-671`）、`loadOlder`（`:1013-1017`）、`loadAllOlder`（`:1124`、`:1155`）四处强制 `rebuildAccumulator(nextSnapshot)`——`mergeOlderRows` 返回新数组后 `rowIndexById` 全部失效，漏 rebuild = **静默内容错乱**；
  - `seq` 推进显式写 `accumulator.snapshot.seq = frame.toSeq`（服务端先例同款）；`firstRowId` 必须同步进新 rows 对象（`hasOlderRows`（`:227-232`）读 `window[0].rowId` 与 `firstRowId`）；`totalCount` 另行同步（滚动条估计与 debug 日志依赖，`ConversationTimeline.tsx:4524`）；
  - **`state.updated` 键集合封闭不变量**（r1 P1-12）：`Object.assign(snapshot, delta.patch)`（`apply.ts:200`）的正确性前提是 `statePatchSchema`（`delta.ts:39-61`）的键集合不含 `rows`/`seq`/`logEpoch`——T-AP1 加断言固化；风险表加行。
- **renderUnits 增量重建**（把「每 delta 帧全量重建」降到 O(dirty)；r1 P0-6/P0-7 补全定义）：
  - store 通知时附带 `lastMutation`：本帧变更行的 `rowId → turnId` 映射（`row.delta` 不带 turnId，由 store 从 accumulator 命中行的 `row.turnId` 解析）；
  - **失效键定义**：`dirtyTurns = 本帧变更行的 turnId ∪ { 上一帧最后一个 unit 的 turnId }`（新 turn 追加或末位 turn 被 `shouldKeepRenderUnit` 过滤时，前一末轮的 `isLastTurn` 翻转、末段 `assistantHistoryDefaultOpen` 改写，必须重算——`conversationTurnRenderUnits.ts:279/388-436`）；**缓存键 = `turnId 字符串化 + "|" + isLastTurn + "|" + sessionPhase`**（r2 统一：缓存键的 turnKey 即 turnId 的字符串形式，与 dirty 集合同源，不存在第二套键；`resolveTurnRunning` 读 `options.sessionPhase`，`:199-220`）；`nowMs` **不入缓存键**（计时改由 B-1 的局部 tick 承担，且构建器不再接收 `nowMs` 实参）；
  - **共享增量构建器**：增量构建逻辑抽为 **`@/`-free 纯模块**（见 Step 5 可测性下沉）导出的纯函数（带显式缓存句柄），**`ConversationTimeline` 与 `SessionPane` 共用**——`SessionPane.tsx:641-644` 的 `shareRenderUnits` 与 `:668-678` 的 `shareItems`/`eligibleShareItems` 及相关 effect 是第二份每帧全量构建（hook 无条件执行，非分享态也在跑），不治理则 PRD 旗舰指标（长任务降一个数量级）不可达；**写死方案：SessionPane 的 `rows.window` 派生 useMemo 全部改走同一增量缓存**（非分享态共享缓存结果，不另建分支）；
  - 等价性测试钉死「增量 ≡ 全量」（T-AP4，含三类必测场景：追加新 turn 致 isLastTurn 翻转、末位 turn 被过滤、sessionPhase 迁移）。

> 说明：copy-on-notify 后每通知帧仍有一次 O(N) 外壳拷贝（引用拷贝，微秒级）；渐近收益主力是 renderUnits 增量化（原来每帧 O(N) 的 materializeDraftUnit 多次 filter/Set 才是大头）。若基线数据表明外壳拷贝仍是瓶颈，备选升级为双缓冲（两份 window 交替、通知零拷贝），本期不做。

#### C2. turn 目录窄投影 + loadAllOlder 拆分（phase-turn-directory）

新增只读 v4 方法 `v4/conversation/turnDirectory`（独立方法而非给 rowsRange 加 mode——同族方法形状一致是既有约定；照 `rowsRange`/`plans` 样板）。

**契约**（`packages/shared/src/zcode-protocol-v4/transport.ts`；r1 P0-8/P0-9 补硬定义）：

- params：`{ sessionId, clientMode, limit?, beforeQueryRowId? }`（**`sessionId` 照 `v4ConversationRowsRangeParamsSchema`（`transport.ts:504-523`）的字段形状**；`clientMode` 照 `rowsRange`（`:507`）参与 delivery profile 映射，见下）；
- result：`{ entries: TurnDirectoryEntry[], realUserQueryTotal: number, atSeq, atRevision, atLogEpoch, hasMore }`；
- `TurnDirectoryEntry = { turnId, queryRowId, queryPreview, assistantPreview, assistantPreviewKind: "empty" | "running" | "text" }`——**不用 `turnKey`**（避免与 `turnId`/`productTurnId` 三义；游标直接用 `queryRowId`）；
- **entries 按 `queryRowId` 升序**（与 rail 自上而下时间序一致，与 `getRowsRange` 同向；注意同族 `getPlans` 是降序（`conversation-topic-publisher.ts:474`），不要照抄它的方向）；
- **游标语义**：`beforeQueryRowId` = 返回 `queryRowId` 严格小于该值的更早条目；**`hasMore` = 更早方向仍存在条目**；
- **`realUserQueryTotal`** = 服务端从全量投影行现算的 realUser query 权威总数（替代客户端「翻页探测后 reduce」的判定）；
- **`assistantPreviewKind` 三态判定**（r1 P1-3 + r2 边缘补）：turn 内存在 assistantText 行 → `"text"`；否则 `turnHeader.state === "running"` → `"running"`；否则（含无 header 兜底路径）→ `"empty"`。i18n 文案不下发（客户端填 `chat.turnNavigator.*`）；
- `PROTOCOL_V4_LIMITS` 新增 `turnDirectoryMaxEntries`。

**服务端**（`conversation-topic-publisher.ts` 新增 `getTurnDirectory()`，照 `getPlans():464` 形状）：从全量投影行**现算派生**（不在 ProductProjection 维护第二份目录结构）：`turnHeaderRowSchema` 定边界 + `kind === "userInput" && origin === "realUser"` 挑 query 项 + `kind === "assistantText"` 出概要；**走 `filterConversationRowsForProfile` 过滤**（照 `getRowsRange():441-444`，当前为 no-op 但保留边界，防 `replayable` 档泄漏）；gateway handler 照 `rowsRange():1559` 三段式（`readyFlights` → `hasLiveConversation` → `ensureColdReadyPublisher`/`hydratePublisher`），**冷恢复自动可用，transcript-hydration 不改**。只读三要素照旧：无状态、超时重发安全、带 `atLogEpoch + atRevision`。**代际分工**（r1 P1-6）：客户端以 result 的 `atRevision` 做陈旧读丢弃、以 store 的 `turnNavigatorDirectoryRevision` 做 UI 重查触发，二者不互相替代。

**摘要口径统一**：把 renderer 的 `buildPreviewText`/`normalizePreviewParagraphs`/`truncatePreview`（220 字符/2 段落口径，含 B-4 的流式折叠改造）提取到 `@zcode/shared`（`previewText.ts`，**并更新 `zcode-protocol-v4/index.ts` 桶导出**——该包经 `package.json` exports 桶导出，不加导出 renderer 引用不到）；renderer 原三函数**删除并改为从 `@zcode/shared` 引入**；`buildAssistantPreview` 依赖 UI 类型（renderUnit），**留在 renderer** 不提取。sessions-index 的 120 字符口径不动（属另一产品面）。

**host 四件套 + renderer transport 三件**（新增方法的固定改动面，共 13 个文件）：
- `zcodeAgent.ts`（接口 + params 类型）、`zcodeAgentService.ts`（**跟 `rowsRange` 支**：`readTrustedZCodeAgentV4Connection` + `getReadOnlyClient`，不跟 `plans` 的裸透传——r1 P1-5）、`zcodeAgentConnectionScope.ts`（转发，照 `:736` 的 rowsRange 转发）、`workspaceConnectionRegistry.ts` Pick 窄面；
- `transport.ts` / `agentConversationTransport.ts`（含 `:61` Pick 联合）/ `replaceableConversationTransport.ts`；
- 加上契约三件（`transport.ts` schema、`core.ts` 限额、`index.ts` 桶导出）与服务端三件（publisher/gateway/server switch）。

**store 拆双路径**：
- 宽屏自动触发（`shouldHydrateConversationTurnNavigatorDirectory`（`conversationTurnNavigatorHelpers.ts:69,77-89`）+ `ConversationTimeline.tsx:607-677` effect）改为**目录查询**；该判定函数签名相应扩展（目录模式下输入改为 `realUserQueryTotal`/目录 hasMore，`loadingOlder` 字段更名或新增 `loadingDirectory` 态字段），rail 隐藏条件同步；
- **`realUserQueryCount < 2` 判定**（r1 P0-9）：直接读目录 result 的 `realUserQueryTotal`，`< 2` 时返回 `not-enough-queries` 终态并写 `turnNavigatorHydrationTerminal`（与现状 `conversationProjectionStore.ts:1118-1153` 语义等价，但不再依赖翻页探测）；
- 失效挂现有 `turnNavigatorDirectoryRevision`（`shouldInvalidateTurnNavigatorDirectory` 命中 append/upsert/removed 三类帧自增，`:124-131/:745-751`）；**重查去抖写死 250ms trailing**（revision 变更后合并一次目录查询；服务端现算 O(总行数) 成本已接受——CLI 内存本持有全量，风险表记一行）；
- `loadAllOlder` 保留为「正文补齐」路径（**分享模式 `SessionPane.tsx:3456-3465` 依赖全量正文语义，不能删**；`realUserQueryCount` 探测页不合并的既有行为保留在正文路径）。

**跳转闭环**（目录看得见、点得动；r1 P1-8 补参数）：`scrollToQuery`（`ConversationTimeline.tsx:1275-1303`）改为 **async 函数**，目标不在已加载窗口时循环 `rowsRange`（单页 limit=200 即 `rowsRangeMaxLimit`，**最大 50 页**）拉取到包含 anchor rowId 为止（loading 态；到达页数上限仍未命中 → 放弃并 toast 提示）；拉取页**合并进 window**（用户主动跳转的成本，与「探测页不合并」不同）；完成后**改查 `rowElementRegistry`**（B-3 的注册表）定位 DOM 滚动。锚点窗口原语（服务端 `rowsWindowAround`）列为后续可选优化。

**active 定位降级**（r1 P1-16 补两分支）：`resolveConversationTurnNavigatorActiveUnitIndex`（`conversationTurnNavigatorHelpers.ts:217-268`）现有两条依赖路径——主循环（`:233-248`，扫 `virtualItems`）与 `topVirtualIndex` 兜底链（`:254-267`）。降级规则：**已加载区间**沿用主循环；**未加载区间**（目录项存在、unit 不存在）按目录项 `queryRowId` 与当前窗口首行 rowId 比较（目录项 rowId < 首行 rowId → 活动条目在上方未加载区，取第一个未加载目录项高亮）；混合态（视口跨加载边界）以已加载侧优先。列入 T-TD4 混合态用例。

### D. P2 内存护栏（phase-memory-guard）

- `shikiHighlighter.ts` 的 `tokensCache`（`:60`，未导出）加 LRU：上限 500，**命中处（`:137-148`）`delete` + `set` 刷新序**（当前命中不重排）；**异步写入点（`:176`）在 set 后重查上限再淘汰一次**（防异步并发超限竞态）；同文件 `:61` 的 `subscribers` Map 一并加护栏（订阅退订对称，计数有界）。`highlighterCache` 本身有界不动。T-MG1 断言改经 `uiMemoryDiagnosticsRegistry` 观测（`shiki.tokensCache` 计数 ≤ 上限且最近命中项仍在）。

## 最终项目结构

新增：

```
packages/ui/src/lib/perfProbe.ts                     # dev-only 页面内探针（longtask 缓冲 + 内存采样出口 + 分段 dump）
packages/ui/src/v4/conversationProjectionCore.ts     # @/-free 下沉模块：mergeOlderRows/accumulator 应用包装/增量构建器（可测性）
packages/shared/src/zcode-protocol-v4/previewText.ts # 摘要工具共享提取（先例：rows.ts → toolDisplay.ts）
packages/shared/test/apply.test.ts                   # 等价性测试（放 test/ 不进 tsc emit，先例 packages/services/test/）
scripts/dev/long-session-perf-sample.mjs             # CDP 采样脚本（dev 工具，先例 scripts/dev/zcode-stdio-tap.mjs）
docs/iterations/desktop-long-session-perf/baseline-before.json   # 基线（workspace docs，不入 omz 仓库）
docs/iterations/desktop-long-session-perf/baseline-after.json    # 终验对比
```

修改（关键落点，行号为当前基线）：

```
packages/ui/src/App.tsx                                # +1 行接入 startPerfProbe
packages/ui/src/lib/memoryDiagnostics.ts               # 抽出 collectRendererMemorySample()（role 固定 "renderer"）
packages/ui/src/lib/shikiHighlighter.ts                # tokensCache LRU + subscribers 护栏 + 异步竞态
packages/ui/src/v4/conversationProjectionStore.ts      # accumulator + copy-on-notify + rebuild 入口 + 目录状态 + loadAllOlder 拆分（纯逻辑下沉 conversationProjectionCore 并 re-export）
packages/ui/src/v4/ConversationTimeline.tsx            # liveNowMs 下线 + renderUnits 增量缓存 + 跳转拉取（async + registry）
packages/ui/src/v4/ConversationTurnGroup.tsx           # WorkingDurationText 计时子组件
packages/ui/src/v4/ConversationRowView.tsx             # RowShell ref 注册 rowElementRegistry
packages/ui/src/v4/ConversationTurnNavigator.tsx       # items 合并数据源 + active 量化（主行高）
packages/ui/src/v4/conversationTurnNavigatorHelpers.ts # Map 可选参数 + 流式折叠 + 目录项类型 + shouldHydrate 签名扩展
packages/ui/src/v4/conversationTurnWorkSegments.ts     # segment 扩展 startedAt（fact 同源链）
packages/ui/src/v4/SessionPane.tsx                     # shareRenderUnits/shareItems 改共享增量缓存
packages/shared/src/zcode-protocol-v4/transport.ts     # V4_METHODS.turnDirectory + schema
packages/shared/src/zcode-protocol-v4/core.ts          # PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries
packages/shared/src/zcode-protocol-v4/index.ts         # 桶导出 previewText 与新 schema
apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts  # getTurnDirectory()
apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts                   # handler
apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts                          # switch case
packages/services/src/zcode-agent/zcodeAgent.ts|zcodeAgentService.ts|zcodeAgentConnectionScope.ts  # host 四件套（含 workspaceConnectionRegistry.ts Pick）
packages/ui/src/v4/transport.ts|agentConversationTransport.ts|replaceableConversationTransport.ts  # transport 三件
```

不动（明确排除）：`apply.ts` 两个实现本体、`transcript-hydration.ts`、`product-projection.ts`（目录现算）、`getWireSnapshotForProfile` 的 60 行窗口、`.vscode/*.mjs`（采样脚本不依赖它们）、`logger.ts`、`conversationTransportDelayE2E.ts`、`packages/desktop/src/main/index.ts`（9229 已自动开）、`ConversationTurnRow.tsx`（纯 props 透传，无 DOM）、nm 仓库。**分享链路的 `conversationRowsRangeV4` Pick 面**（`conversationShareService.ts:182/2391`、`conversationShareAttachmentService.ts:7`）不动、不新增 turnDirectory 引用（分享走正文路径）。

## 变更点清单

| # | 变更 | 类型 | 对应 PRD 需求 |
|---|------|------|--------------|
| 1 | 页面内性能探针 + CDP 采样脚本（含 dev 启动契约）+ 基线 | 新增 | 核心需求 1 |
| 2 | liveNowMs 彻底下线（含 startedAt 数据源与 interval 删除） | 修改 | 核心需求 4 |
| 3 | 滚动路径 O(N)/reflow 消除（RowShell 注册） | 修改 | 核心需求 5 |
| 4 | 摘要流式折叠（逐字节等价 + 扫描有界） | 修改 | 核心需求 4/5（渲染层） |
| 5 | renderer accumulator + copy-on-notify + 统一 rebuild | 修改 | 核心需求 2 |
| 6 | renderUnits 增量重建（dirty 定义完整，Timeline/SessionPane 共用） | 修改 | 核心需求 2 |
| 7 | v4 turnDirectory 方法全链（13 文件，契约含排序/游标/realUserQueryTotal） | 新增 | 核心需求 3 |
| 8 | loadAllOlder 拆双路径 + 失效挂 revision + 重查去抖 250ms | 修改 | 核心需求 3 |
| 9 | 跳转拉取闭环（循环 rowsRange 到 anchor，上限 50 页，async + registry） | 新增 | 核心需求 3/7 |
| 10 | tokensCache LRU + subscribers 护栏 + 异步竞态 | 修改 | 核心需求 6 |

## 详细实现步骤

（`qa: manual_user` = CDP 采样/桌面实机验证，不阻塞自动门禁）

- Step 0 — phase-turn-directory — blocking: yes — qa: auto：前置验证——两文件（`transport.ts`、`conversationProjectionStore.ts`）首行已带 `eslint-disable max-lines` 豁免；确认**未豁免**的改动文件（`conversationTurnNavigatorHelpers.ts`（约 333 行）、`ConversationRowView.tsx`、`conversationTurnWorkSegments.ts` 等）新增代码后不超 400 有效行，超则拆文件。
- Step 1 — phase-perf-probe — blocking: yes — qa: auto：`memoryDiagnostics.ts` 抽出 `collectRendererMemorySample(): MemorySample` 纯读函数（复用 `uiMemoryDiagnosticsRegistry.collect()` + `readRendererHeapSnapshot`，不经写盘门控；`role` 固定 `"renderer"`）。
- Step 2 — phase-perf-probe — blocking: yes — qa: auto：新增 `packages/ui/src/lib/perfProbe.ts`（longtask 自持环形缓冲 + `sampleMemory()` + `reset()` 清空开新段 + `dump()` 返回 JSON 字符串），挂 `window.__zcodePerfProbe`，`App.tsx` 一行接入，`import.meta.env.DEV` 门控。
- Step 3 — phase-perf-probe — blocking: yes — qa: manual_user：新增 `scripts/dev/long-session-perf-sample.mjs`，按「dev 实例启动契约」实现（探测 5174 → 自行 spawn electron 带 `--open-workspace`（无 `--inspect-brk`）→ 9229 单实例探测/复用 → `reset()`/驱动动作/`dump()` 分段取数 → JSON 报告）。
- Step 4 — phase-baseline — blocking: yes — qa: manual_user：真实长会话采集改动前基线 → `baseline-before.json`，回填 PRD 阈值判定线。
- Step 5 — phase-testability — blocking: yes — qa: auto：可测性前置（**硬 gate：被测模块传递依赖链零 `@/` 导入**）——(a) 运行方式 `npx tsx --test <file>`，新测试只用相对路径或 `@zcode/*` 导入；(b) **方案写死为下沉**（不引入 loader）：`conversationProjectionStore.ts` 的 `mergeOlderRows`、accumulator 应用包装、`conversationTurnRenderUnits.ts` 的增量构建器纯逻辑**下沉到新 `packages/ui/src/v4/conversationProjectionCore.ts`（`@/`-free 模块）**，原文件 re-export；`previewText.ts`/apply 侧本就 `@/`-free；(c) 自检：`npx tsx -e "import('./packages/ui/src/v4/conversationProjectionCore.ts')"` 成功 + `npx tsx --test` 跑通 T-AP1 样例。（既有 `packages/ui/test/nonCliAcpRetirement.test.ts` 的 `@/` 红是存量问题，不在本期修。）
- Step 6 — phase-render-hot — blocking: yes — qa: auto：liveNowMs 彻底下线——`ConversationTurnWorkSegment` 扩展 `startedAt`（取值链 `fact?.startedAt ?? triggerRow?.createdAt ?? header?.startedAt`，与 `resolveSegmentDurationMs` 同源）+ 新抽 memo 化 `WorkingDurationText`（仅 running 时 setInterval；`startedAt` 缺失回退静态 `durationMs`）+ 删除 `liveNowMs` state/`RUNNING_WORK_DURATION_TICK_MS` interval effect/`nowMs` 实参。
- Step 7 — phase-render-hot — blocking: yes — qa: auto：滚动 O(N) 消除——helpers 纯函数加可选参数 `itemByUnitIndex`（缺省自建，向后兼容）+ 组件侧 `useMemo([items])` 构造 + active 量化写死 `Math.floor(scrollOffsetPx / 72)`（`DEFAULT_ROW_HEIGHT_ESTIMATE_PX`）。
- Step 8 — phase-render-hot — blocking: yes — qa: auto：reflow 消除——`ConversationRowView.tsx` RowShell ref callback（幂等 delete+set，StrictMode 安全）注册模块级 `rowElementRegistry`（session 切换清空），`syncTurnNavigatorViewport` 改查 registry。
- Step 9 — phase-render-hot — blocking: no — qa: manual_user：P1 后中期采样对比（验证单项收益，决定后续优先级）。
- Step 10 — phase-delta-apply — blocking: yes — qa: auto：新增 `packages/shared/test/apply.test.ts` 等价性测试（随机 delta 序列含 append/upsert/delta/state.updated/removed；**断言 `statePatchSchema` 键集合不含 `rows`/`seq`/`logEpoch`**）。
- Step 11 — phase-delta-apply — blocking: yes — qa: auto：store 引入 accumulator（`createMutableConversationSnapshotAccumulator` + `applyConversationDeltasMutable`，不新写分派逻辑）+ copy-on-notify 三层换引用（发布外壳副本；`logSubagentProjectionTransition`/`reconcileOptimistic`/`reconcileAcceptedInputProjection`/`observeModelTransition` 一律读外壳）+ 统一 `rebuildAccumulator` 四处调用 + `firstRowId`/`totalCount` 同步。
- Step 12 — phase-delta-apply — blocking: yes — qa: auto：renderUnits 增量重建（纯逻辑下沉 `conversationProjectionCore.ts`）——`lastMutation`（rowId→turnId，store 从 accumulator 命中行解析）+ 失效键（dirtyTurns ∪ 上一帧末轮 turnId；缓存键 `turnId + "|" + isLastTurn + "|" + sessionPhase`；构建器不再收 `nowMs`）+ **Timeline 与 SessionPane（`shareRenderUnits`/`shareItems`/`:668-678`）全部改走共享增量缓存**+ T-AP4 三类场景。
- Step 13 — phase-turn-directory — blocking: yes — qa: auto：摘要工具提取到 `@zcode/shared`（`previewText.ts` 流式折叠实现 + `index.ts` 桶导出），renderer 原三函数删除改 import，`buildAssistantPreview` 留 renderer，T-TD1 按四类边界语料验收。
- Step 14 — phase-turn-directory — blocking: yes — qa: auto：契约层——`V4_METHODS.turnDirectory` + params（`sessionId`/`clientMode`/`beforeQueryRowId`）+ result（含 `realUserQueryTotal`）+ entries 升序/游标/hasMore 硬定义 + `PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries`。
- Step 15 — phase-turn-directory — blocking: yes — qa: auto：服务端 `getTurnDirectory()`（照 `getPlans` 形状 + profile 过滤照 `getRowsRange`）+ `realUserQueryTotal` 现算 + `assistantPreviewKind` 三态判定（无 header 兜底=empty）+ gateway handler 三段式 + `server.ts` case。
- Step 16 — phase-turn-directory — blocking: yes — qa: auto：host 四件套（**跟 rowsRange 支**：trusted connection + scope 转发 + Pick 窄面）+ renderer transport 三件。
- Step 17 — phase-turn-directory — blocking: yes — qa: auto：store 目录状态 + `<2` 判定读 `realUserQueryTotal` + 失效挂 revision（append/upsert/removed 三类帧）+ 250ms trailing 重查去抖 + `shouldHydrateConversationTurnNavigatorDirectory` 签名扩展（`loadingDirectory` 态 + rail 隐藏条件）+ `loadAllOlder` 保留为正文/分享路径。
- Step 18 — phase-turn-directory — blocking: yes — qa: auto：`ConversationTurnNavigator` items 数据源合并（目录 + 已加载去重）+ active 定位降级两分支（已加载主循环 / 未加载 rowId 比较 / 混合态已加载优先）。
- Step 19 — phase-turn-directory — blocking: yes — qa: manual_user：跳转闭环——`scrollToQuery` 改 async，未加载目标时循环 `rowsRange`（limit=200、上限 50 页、到顶未命中 toast 放弃、拉取页合并进 window），完成后经 `rowElementRegistry` 定位滚动；实机验证目录点击、hover 摘要、分享流程、上滚分页。
- Step 20 — phase-memory-guard — blocking: no — qa: auto：`tokensCache` LRU（上限 500、命中 `delete`+`set`、异步 set 后重查淘汰）+ `subscribers` 对称护栏；T-MG1 经 registry 观测验收。
- Step 21 — phase-verify — blocking: yes — qa: manual_user：改动后终验采样 → `baseline-after.json` + 对比结论回填验收记录；门禁全绿（typecheck / lint 零新增 / architecture:check --changed）。

## 测试策略

门禁：根 `pnpm typecheck`、`pnpm lint`（零新增违例）、`pnpm architecture:check --changed`。仓库无统一 test 入口（AGENTS.md 约定），新增 `.test.ts` 按 `node:test` + `node:assert/strict` 先例（`packages/ui/test/`、`packages/services/test/`），`*.test.*` 豁免 max-lines；**运行方式与 `@/` 禁令见 Step 5 可测性前置**（knip 不在 pre-push 门禁，`scripts/dev` 新文件是否登记 `knip.json` 为可选项非阻塞）。

### 测试用例

- T-PA1 — blocking: yes — perfProbe：注入长任务（同步 busy loop）后 `dump()` 字符串能解析出 longtask 条目；`reset()` 清空开新段（→ Step 2）。
- T-PA2 — blocking: yes — `collectRendererMemorySample()`：向 `uiMemoryDiagnosticsRegistry` 注入 7 个假 provider 后返回全部 7 类计数 + heap 字段 + `role === "renderer"`（→ Step 1/5）。
- T-AP1 — blocking: yes — 等价性：随机 delta 序列（append/upsert/delta/state.updated/removed 混合）下 `applyConversationDeltasMutable` 与 `applyConversationDeltas` 产出深相等；**附 `statePatchSchema` 键集合封闭断言**（不含 `rows`/`seq`/`logEpoch`）（→ Step 10）。
- T-AP2 — blocking: yes — accumulator 在 `mergeOlderRows` 后 rebuild：后续 `row.delta` 写入正确位置（依赖 Step 5 下沉导出）（→ Step 11）。
- T-AP3 — blocking: yes — copy-on-notify 引用换新口径（按 full/E-1 收窄）：**有行变更帧三层全换**（window/rows/snapshot）；**纯 `state.updated` 帧只换 snapshot 外壳，window/rows/lastMutation 引用不变**；通知间引用稳定（→ Step 11）。
- T-AP4 — blocking: yes — renderUnits 增量重建 ≡ 全量重建，必测三类场景：追加新 turn 致 isLastTurn 翻转、末位 turn 被过滤、sessionPhase 迁移（→ Step 12）。
- T-TD1 — blocking: yes — 摘要工具提取后：**固定四类边界语料**（超长空白前缀段、段间多空白、截断边界落在空白串内、纯空白输入）上新旧实现**逐字节一致**（maxChars 为有限非负整数时）；扫描量以遇到第一个非空白码元或 emit 预算用尽为界——无长空白串语料 ≤ `2*maxChars+64`，含长空白串语料 ≤ 输入长度（→ Step 13）。
- T-TD2 — blocking: yes — `getTurnDirectory`：query 过滤（`origin === "realUser"`）、**entries 按 queryRowId 升序**、`beforeQueryRowId` 游标与 `hasMore` 语义、`realUserQueryTotal` 正确、`assistantPreviewKind` 三态各一例（含无 header→empty）（→ Step 15）。
- T-TD3 — blocking: yes — 目录失效：`shouldInvalidateTurnNavigatorDirectory` 命中的**三类帧（append/upsert/removed）各一例**触发 revision 自增并去抖重查（→ Step 17）。
- T-TD4 — blocking: yes — 目录 + 已加载 items 合并无重复、顺序稳定；**active 降级三态**（已加载/未加载/混合态跨边界）判定正确（→ Step 18）。
- T-MG1 — blocking: no — `tokensCache` 注入 N>500 条后经 `uiMemoryDiagnosticsRegistry` 观测计数 ≤500 且最近命中项仍在（→ Step 20）。

## 风险与回滚方案

| 风险 | 等级 | 缓解 | 回滚 |
|------|------|------|------|
| accumulator 索引失效导致静默内容错乱（mergeOlderRows 后忘 rebuild） | 高 | 统一 `rebuildAccumulator` 入口 + 四处强制调用 + T-AP2 | revert Step 11 单 commit，apply 路径回到不可变版 |
| `state.updated` 的 patch 键集合若未来引入 `rows`/`seq`/`logEpoch` 将破坏 accumulator | 中 | T-AP1 键集合封闭断言固化；风险表登记 | 同上 |
| copy-on-notify 收益不达预期（外壳拷贝仍是每帧 O(N)） | 中 | renderUnits 增量化（Step 12，含 SessionPane 第二份）才是渐近收益主力；基线数据验证；备选双缓冲 | Step 11/12 独立 commit，可单独回退 |
| 跳转拉取最坏情况慢（远距离 anchor 多页 rowsRange） | 中 | loading 态 + 50 页上限 + 到顶 toast 放弃 + 基线会话实测 | 目录路径整体开关：宽屏触发回落旧 loadAllOlder 路径（Step 17 保留旧路径为 fallback） |
| 目录重查高频（revision 抖动）成为新 RPC 热点 | 低 | 250ms trailing 去抖；服务端现算 O(总行数) 成本已接受（CLI 持全量） | — |
| 冷/热轮边界差异（transcript-hydration 已知限制）致目录条目与 live 不完全一致 | 低 | 既有已知差异（内容不丢），PRD 接受；文档记录 | — |
| `useSyncExternalStore` 契约 + 下游 memo 失效（发布 accumulator 本体 / 三层引用漏换 / store 后续步骤读本体） | 高 | SPEC 钉死「发布外壳副本 + 三层换引用 + reconcile 系列读外壳」+ T-AP3 | 同 revert Step 11 |
| 基线采集受 single-instance 锁/9229 端口冲突/5174 未启动干扰 | 低 | 启动契约三探测（5174/9229/秒退判定）+ 文档写明独占 dev 实例 | — |
| 生产包无法采指标 | 已接受 | PRD 风险项：基线与验收均在 dev build 下采 | — |

## Context Bundle

```yaml
iteration_name: desktop-long-session-perf
requirement_path: docs/iterations/desktop-long-session-perf/prd.md
spec_path: docs/iterations/desktop-long-session-perf/spec.md
explore_summary: >
  根因（8 子代理 + r1/r2 审查交叉验证）：宽屏≥864px 自动 loadAllOlder 全量灌入 + rows.window 无上限；
  renderer 每条 delta 不可变 O(N) 拷贝；liveNowMs 每秒 tick（durationMs 为构建期烘焙值，解耦须扩
  segment.startedAt 且取值链与 resolveSegmentDurationMs 同源 fact 解析，普通 turn 走 header.startedAt）；
  滚动每帧 O(N) Map（量化用主行高 72 非 rail 行高 10）+ 强制 reflow（注册点 ConversationRowView RowShell，
  10 处；query 行全经 RowShell）；SessionPane 尚有第二份全量 renderUnits（shareRenderUnits/shareItems）；
  tokensCache 无淘汰。renderer 不可变性无实质依赖者（copy-on-notify 三层换引用，真正理由是 ~15 处
  [rows.window] memo 失效语义；store 后续 reconcile 系列须读外壳副本）。度量为零基础；dev 启动须自组
  spawn（.vscode 脚本硬编码 --inspect-brk 不透传 argv）。测试基建：tsx 下 services 可跑、ui 因 @/ 别名
  不可 import——可测性硬 gate=被测模块传递依赖零 @/，方案=纯逻辑下沉 conversationProjectionCore.ts。
  turnDirectory 契约：entries 升序 / beforeQueryRowId 游标 / realUserQueryTotal 权威计数 / 三态
  assistantPreviewKind（无 header 兜底=empty）/ host 跟 rowsRange 支。
impact_files:
  - packages/ui/src/v4/conversationProjectionStore.ts
  - packages/ui/src/v4/conversationProjectionCore.ts (新, @/-free 下沉)
  - packages/ui/src/v4/ConversationTimeline.tsx
  - packages/ui/src/v4/ConversationRowView.tsx
  - packages/ui/src/v4/ConversationTurnNavigator.tsx
  - packages/ui/src/v4/conversationTurnNavigatorHelpers.ts
  - packages/ui/src/v4/conversationTurnWorkSegments.ts
  - packages/ui/src/v4/SessionPane.tsx
  - packages/ui/src/lib/perfProbe.ts (新)
  - packages/shared/src/zcode-protocol-v4/{transport,core,index}.ts
  - packages/shared/src/zcode-protocol-v4/previewText.ts (新)
  - packages/shared/test/apply.test.ts (新)
  - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/{conversation-topic-publisher,v4-gateway}.ts
  - packages/services/src/zcode-agent/zcodeAgent{,Service,ConnectionScope}.ts
  - scripts/dev/long-session-perf-sample.mjs (新)
constraints:
  - 门禁：pnpm typecheck / lint (oxlint max-lines 400) / architecture:check --changed；无统一 test 入口
  - 测试运行 npx tsx --test；硬 gate=被测模块传递依赖零 @/（Step 5 下沉方案）；禁 @/ 别名
  - apply.ts「已发布快照不可篡改」是服务端边界约定，renderer 改可变须发布外壳副本且 store 后续步骤读外壳
  - loadAllOlder 不能删（分享链路依赖全量正文语义）；分享 Pick 面不引入 turnDirectory
  - 只读 v4 方法三要素：无状态、超时重发安全、带 atLogEpoch+atRevision；host 跟 rowsRange 支（trusted）
  - i18n 文案不下发（assistantPreviewKind 枚举）
  - 探针 dev-only；生产 renderer 日志 no-op（验收在 dev build）
blocking_steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21]
```
