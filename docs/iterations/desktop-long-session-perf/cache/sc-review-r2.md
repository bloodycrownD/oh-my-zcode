---
round: r2
role: judge (readonly)
date: 2026-10-05
prd: docs/iterations/desktop-long-session-perf/prd.md
spec: docs/iterations/desktop-long-session-perf/spec.md
verdict: No-Go
counts: { P0: 3, P1: 3, P2: 12 }
baseline: r1 (cache/sc-review-r1.md：P0×10 / P1×16 / P2×9)
---

# SPEC 检查报告 r2（judge / readonly）

结论前置：**No-Go**。r1 的 35 条 must-fix 已闭合 32 条（10 P0 中 7 条、16 P1 全部、9 P2 全部）；
**3 条 P0 仍开放**，全部集中在「渲染层计时文案数据源」与「blocking 测试可执行性」两个工作面，
且分别落在 blocking Step 6/12 与 Step 5/10~12 上 → 按现 SPEC 编码，Step 6 会产出功能回归、
Step 10~12 的 blocking 用例跑不起来。另新增 3 条 P1（其中 2 条是 r1 修订引入的新落点缺陷）。

本轮所有判为「仍开放 P0」「新引入 P0/P1」的条目，judge 均已亲自 Read/实跑代码核实（标 ✔），
并给出可执行的修改建议。行号漂移但实质成立的一律降级为 P2（见第五节）。

---

## 一、逐条核对 r1 的 35 条 must-fix

### 1.1 已修复项摘要表（32 条）

| r1 编号 | 问题摘要 | r2 闭合位置 | 核实 |
|---|---|---|---|
| P0-1 | dev 实例启动路径不存在 | spec.md:36-41「dev 实例启动契约」+ Step 3 | ✔ `desktopDeepLinkUrl.ts:9` `OPEN_WORKSPACE_ARG`；`.vscode/tasks.json:59` 任务名 `zcode: prepare desktop debug` 存在 |
| P0-2 | active 定位量化单位错配 | spec.md:48（B-2 改 `DEFAULT_ROW_HEIGHT_ESTIMATE_PX`，并声明 deps 与函数体同一 useMemo） | ✔ `timelineRowHeightCache.ts:11 = 72` |
| P0-3 | reflow 注册点无挂载点 | spec.md:49（B-3 落 `ConversationRowView.tsx:141` RowShell）+ Step 8 | ✔ `ConversationRowView.tsx:130-148`；且 `ConversationTimeline.tsx:911-919` 只取 `turnNavigatorQueryRowIdsRef`（realUser query，全部经 RowShell `:1040/:1187` 渲染）→ 非 RowShell 的 6 处 `data-row-id` 不在该路径（见 N6） |
| P0-6 | renderUnits dirty 集合不完整 | spec.md:62-66（失效键 ∪ 上一帧末轮；缓存键含 `isLastTurn`+`sessionPhase`；`nowMs` 不入键；三类必测场景） | ✔ `conversationTurnRenderUnits.ts:279/374-386/388-436` |
| P0-7 | SessionPane 第二份全量 renderUnits | spec.md:65 + 修改清单 `:134` + Step 12 | ✔ `SessionPane.tsx:641-644` |
| P0-8 | turnDirectory 排序/游标/turnKey 缺定义 | spec.md:76-83（升序、`beforeQueryRowId` 严格小于、`hasMore` 更早方向、删 `turnKey`、`realUserQueryTotal`、`clientMode`） | ✔ 与 `transport.ts:504-524`（rowsRange「rowId 升序」+「beforeRowId 方向是否还有更早的行」）同向同义 |
| P0-9 | `<2` 判定不可推导 | spec.md:81/96（`realUserQueryTotal` 服务端现算）+ Step 17 | ✔ `conversation-topic-publisher.ts:439-455` 数据源为投影全量行，可现算 |
| P1-1 | copy-on-notify 理由写错 | spec.md:57（改为「换 window 引用是下游 memo 失效的必要条件」） | ✔ `conversationProjectionStore.ts:733-752` |
| P1-2 | 缺 `index.ts` 桶导出 / 文件数对不上 | spec.md:137/157（「13 文件」= 4+3+3+3，与清单自洽） | ✔ `zcode-protocol-v4/index.ts` 桶导出 |
| P1-3 | `assistantPreviewKind` 三态缺判定 | spec.md:82 | ✔（边缘分歧见 N15） |
| P1-4 | 目录未与 delivery profile 对齐 | spec.md:85（走 `filterConversationRowsForProfile`，照 `getRowsRange`） | ✔ `conversation-topic-publisher.ts:441-444` vs `:464-474` |
| P1-5 | host 四件套未指定跟哪一支 | spec.md:90/182（跟 rowsRange 支） | ✔ `zcodeAgentService.ts:5259-5273`（trusted+只读 client）vs `:5276-5283` |
| P1-6 | wire/store 两套 revision 代际 | spec.md:85 | ✔ |
| P1-7 | 宽屏触发函数签名/loading 态 | spec.md:95/132/183（函数进清单、`loadingDirectory`、rail 隐藏条件） | ✔ `conversationTurnNavigatorHelpers.ts:77-89`；`ConversationTimeline.tsx:607-677`（残余见 N11） |
| P1-8 | 跳转闭环缺上限/终态/合并策略 | spec.md:100（limit=200、上限 50 页、toast 放弃、合并进 window） | ✔ `core.ts:76 rowsRangeMaxLimit: 200`；`transport.ts:509 beforeRowId` |
| P1-9 | 目录现算成本与去抖未评估 | spec.md:97（250ms trailing）+ 风险表 `:215` | ✔ `conversationProjectionStore.ts:747-751` |
| P1-10 | `reset()/dump()` 语义与返回通道 | spec.md:32（reset 开新段、dump 返回 JSON 字符串） | ✔ |
| P1-11 | `apply.test.ts` 落 `src/` 会被 emit | spec.md:115（改 `packages/shared/test/`） | ✔ `packages/services/test/` 先例存在 |
| P1-12 | `state.updated` 键集合封闭不变量 | spec.md:60 + T-AP1 断言 + 风险表 `:212` | ✔ `delta.ts:39-61` 键集合确不含 `rows`/`seq`/`logEpoch` |
| P1-13 | LRU 插入点/`subscribers`/观测方式 | spec.md:106 + T-MG1 | ✔ `shikiHighlighter.ts:60/61/137-193`（残余见 N13） |
| P1-14 | T-TD3 判据只写 removed | spec.md:203（三类帧各一例） | ✔ `conversationProjectionStore.ts:747-751` |
| P1-15 | Map 参数破坏纯函数签名 | spec.md:48/173（可选参数、缺省自建） | ✔ `conversationTurnNavigatorHelpers.ts:217-268` |
| P1-16 | active 降级只写一条分支 | spec.md:102（两分支 + 混合态已加载优先）+ T-TD4 | ✔ `conversationTurnNavigatorHelpers.ts:233-248/254-267` |
| P2-1 | `hasOlderRows`/`totalCount` 措辞 | spec.md:59（`firstRowId` 进 rows、`totalCount` 另行同步） | ✔ `conversationProjectionStore.ts:1303-1308` 读 `rows.window` |
| P2-2 | Step 0 范围 | spec.md:166（收窄为未豁免文件） | ✔ |
| P2-3 | knip 登记 | spec.md:191（降为可选项非阻塞） | ✔ |
| P2-4 | B-4 行号 906-937 | spec.md:49（906-940） | ✔ `ConversationTimeline.tsx:906-940` |
| P2-5 | `MemorySample.role` 必填 | spec.md:31/167（固定 `"renderer"`） | ✔ |
| P2-6 | 探针在 web dev 也会挂 | spec.md:29（无害，已写明） | ✔ |
| P2-7 | 变更点 4 映射错 | spec.md:154（核心需求 4/5） | ✔ |
| P2-8 | 摘要工具提取后原三函数去留 | spec.md:87（删除改 import、`buildAssistantPreview` 留 renderer） | ✔ `conversationTurnNavigatorHelpers.ts:137-167` 依赖 UI 类型 |
| P2-9 | 分享 Pick 面 | spec.md:145（不动清单点名） | ✔ |

### 1.2 仍开放项（3 条，均为 P0）

| r1 编号 | 状态 | 一句话 |
|---|---|---|
| P0-4 | **仍开放** | `startedAt` 数据源只覆盖 guide 段，普通单段 running turn 仍无数据源；且 `liveNowMs` 根级 tick 未要求删除 |
| P0-5 | **仍开放** | B-4 的「分段内前缀截断」在数学上无法与 T-TD1「逐字节一致」同时满足 |
| P0-10 | **仍开放** | Step 5 只给「导出 seam」，未解除 `@/` 传递依赖 → 5 条 blocking 用例在本 SPEC 自定 harness 下不可执行 |

### 1.3 修复引入的新问题

| 新编号 | 严重度 | 说明 |
|---|---|---|
| N3 | P1 | B-1 删了 memo 依赖却没要求删 `liveNowMs` state 与 `:562-575` 的 setInterval → 每秒仍整棵 `ConversationTimeline` 重渲染，与 PRD 渲染层验收项直接冲突 |
| N4 | P1 | C1 把可变累加器的落点写成 `apply.ts:24-35`（只是构造器），真正的可变 apply 入口是 `:153/:213` |
| N5 | P1 | copy-on-notify 的 `next` 消费点只点名 `logSubagentProjectionTransition`，漏 `reconcileOptimistic`/`reconcileAcceptedInputProjection`/`observeModelTransition` |

（另新增 12 条 P2，见第五节 N6~N15 与行号/措辞类。）

---

## 二、剩余 P0（3 条，must-fix）

### P0-4（仍开放）`startedAt` 数据源只覆盖 guide 段；普通单段 running turn 仍无计时数据源，且根级 tick 未下线

- **问题**：SPEC B-1（spec.md:47）把 `ConversationTurnWorkSegment` 扩 `startedAt?: number`，来源写死为「由 `buildConversationTurnWorkSegments` 从 `header.workSegments[].startedAt` 填充」。但 `workSegments` 是 **optional 且普通轮缺省**；普通单段 turn 的 `durationMs` 走的是完全另一条分支（`segmentCount === 1` → `resolveConversationTurnWorkDurationMs(header, {nowMs}, isRunning)` → `nowMs - header.startedAt`），根本不读 `workSegments[].startedAt`。→ 对绝大多数没有 guide 的普通轮，新增的 `segment.startedAt` 恒为 `undefined`，`WorkingDurationText` 无数据源；而 `AssistantHistoryStatus` 的 running 分支是 `formatConversationWorkDuration(segment.workStatus?.durationMs) ?? ""`，duration 缺失时直接渲染成「工作中 」（空时长）——这正是 r1 P0-4 描述的回归，只是换了个触发条件。
- **证据**（✔ 已核实）：
  - `packages/shared/src/zcode-protocol-v4/rows.ts:82-84`「普通 turn 缺省以保持旧 snapshot 兼容；一旦出现 guide，CLI 负责完整投影首段与后续段」+ `workSegments: z.array(turnWorkSegmentSchema).optional()`。
  - `packages/ui/src/v4/conversationTurnWorkSegments.ts:105-115`（`fact` 只在 `header.workSegments` 里找）、`:116-122`（`segmentCount === 1` → 回落到 `resolveConversationTurnWorkDurationMs`）、`:49-63`（该函数 running 时返回 `nowMs - header.startedAt`）、`:125-129`（旧 guide 快照回退用 `triggerRow.createdAt ?? header.startedAt`）。
  - `packages/ui/src/v4/conversationTurnRenderUnits.ts:298-305`（turn 级 `workStatus` 同源，仅用于 running 判定，不显示时长）。
  - `packages/ui/src/v4/ConversationTurnGroup.tsx:573-585`（running → `chat.history.workingFor`，`duration: durationLabel ?? ""`）。
- **修改建议**（B-1 与 Step 6 补硬约束）：
  1. `startedAt` 的取值必须复用 `resolveSegmentDurationMs` 已有的同一套 `fact` 解析，定义为
     `segment.startedAt = fact?.startedAt ?? options.triggerRow?.createdAt ?? options.header?.startedAt`
     （即 `:105-110` 的 `fact` 与 `:125` 的回退同源），**不得只写 `header.workSegments[].startedAt`**；
  2. 同时钉死 `buildConversationTurnRenderUnits` 调用点**不再传 `nowMs`**（否则删了 deps 却留 body 里的 `nowMs: liveNowMs` → stale closure，lint 抓不到）：`spec.md:172` 追加「`ConversationTimeline.tsx:411-414` 的 `nowMs: liveNowMs` 一并删除，`liveNowMs` state（`:408`）与 `:562-575` 的 `setInterval` 整段删除，计时唯一来源为 `WorkingDurationText` 自身 tick」；
  3. `WorkingDurationText` 的回退文案钉死：`startedAt === undefined` 时保持现状烘焙 `durationMs` 的静态展示（不渲染空 duration 的 `workingFor`）。

### P0-5（仍开放）B-4 的「分段内前缀截断」无法满足 T-TD1 的「逐字节一致」

- **问题**：B-4（spec.md:50）描述的算法是「按空行分段后，每段只清洗其前 `maxChars` 长度的前缀（`slice` 后再 `replace`），累计达到上限即停止处理后续段落」，并断言「输出语义与现状一致」。这与现状「先整体折叠空白 → 取前 2 段 → join → `slice(0, max-3).trimEnd() + "..."`」不等价，至少三类反例：
  - **(a) 长空白前缀**：段 raw 前 220 字符大部分是空白时，`slice(raw,220)` 再折叠得到的有效字符 < 现状，输出偏短且内容不同；
  - **(b) 截断边界落在空白串内**：现状先折叠，空白串塌成 1 个空格后才截断；新算法先按 raw 切 220 再折叠，边界处会多出一个空格并多吃 1 个有效字符，与 `truncatePreview` 的 `slice(max-3).trimEnd()+"..."` 不一致；
  - **(c) `...` 补点规则**：现状只在 `text.length > maxChars` 时补 `...`；新算法不再持有全量长度，「累计达到上限即停止」无法判定该不该补点。
  T-TD1 仍是 `blocking: yes` 的「≤220 截断输出逐字节一致」，Step 13 也按此验收 → 实施者按 B-4 写、按 T-TD1 跑，必红。
- **证据**（✔ 已核实）：`packages/ui/src/v4/conversationTurnNavigatorHelpers.ts:102-109`（`trim → split(/\n\s*\n/u) → 每段 replace(/\s+/gu," ").trim() → filter → slice(0,2)`）、`:111-117`（`truncatePreview`：`length<=max` 原样返回，否则 `slice(0, max-3).trimEnd() + "..."`，总长恰为 max）、`:119-135`（`buildPreviewText`：先 normalize 后 truncate）。
- **修改建议**（二选一，写死到 B-4 + Step 13）：
  - **推荐（保持 T-TD1）**：把算法改写为「**流式折叠 + 计数**」：按字符流推进，逐字符折叠空白并累计输出长度，边折叠边判断是否已越过 `maxChars-3`；只有当输入流确实还有剩余字符时才补 `...`。该写法与现状逐字节等价（折叠是前缀单调的），且扫描量天然有界（读到 `maxChars` 即停），正好满足 B-4 的原始收益目标。T-TD1 语料必须固定包含：超长空白前缀段、段间多空白、截断边界正好落在空白串内、纯空白变体。
  - **或（接受行为变化）**：T-TD1 改为「输出长度 ≤220 且不以空白结尾 + 对不含病态空白变体的语料与旧实现一致」，并在 PRD「非功能需求」加一条例外说明。
  无论选哪条，都要删掉 B-4 中「slice 后再 replace」「累计达到上限即停止」这种与等价性冲突的表述。

### P0-10（仍开放）Step 5 的「导出 seam」不解除 `@/` 传递依赖，5 条 blocking 用例仍不可执行

- **问题**：Step 5（spec.md:171）只要求「为被测对象提供导出 seam」+「新测试不用 `@/` 别名」。但把函数从模块里 export 出来并不能让该模块在 Node 下可 import——只要它的**传递依赖链**里有一个 `@/` 导入就会 `ERR_MODULE_NOT_FOUND`。r1 P0-10 的第 (3) 条要求（「把纯逻辑下沉到无 `@/` 依赖的模块」）在 SPEC 里只落到了 `previewText.ts` 与 apply 侧，store 与 renderUnits 侧没有。
- **证据**（✔ 本轮实跑核实）：
  - `node_modules/.bin/tsx --test packages/services/test/importedClaudeRecovery.test.ts` → `# pass 2 # fail 0`（precedent 可用，该包 `src` 无 `@/`）。
  - `node_modules/.bin/tsx --test packages/ui/test/nonCliAcpRetirement.test.ts` → `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`（`# pass 0 # fail 1`），坐实 SPEC 的「不用 `@/` 别名」硬约束。
  - `tsx -e "import('./packages/ui/src/v4/conversationTurnRenderUnits.ts')"` → `FAIL ERR_MODULE_NOT_FOUND`（`:12-20` 的 `@/v4/workflowLaunchTurn.js`、`@/v4/conversationTurnWorkSegments.js` 为值导入，后者再链到 `@/v4/conversationCuaGroups.js`）。
  - `tsx -e "import('./packages/ui/src/v4/conversationTurnNavigatorHelpers.ts')"` → `LOADED exports=7`（唯一 import 是 `import type`，被剥离）→ T-TD4 可跑。
  - `packages/ui/src/v4/conversationProjectionStore.ts:22-25` 四个 `@/` 导入（`@/logger.js`、`@/v4/…`、`@/lib/memoryDiagnostics.js`）；`packages/ui/src/lib/memoryDiagnostics.ts:9` `@/logger.js`。
  - 结论：在 SPEC 自定的 harness 下，**T-PA2、T-AP2、T-AP3、T-TD3、T-AP4 不可执行**（均 `blocking: yes`）；可执行的只有 T-AP1（`packages/shared/test/`）、T-TD2（bootstrap 只用 `@zcode/*` + 相对路径）、T-TD4（helpers）。
- **修改建议**（Step 5 增补为硬 gate）：
  1. 明确「**被测模块的传递依赖链必须零 `@/`**」为前置条件，并给出两条落地路径任选其一写死：
     - **(a) 下沉**：把 `mergeOlderRows` + accumulator 装配抽到一个只 import `@zcode/shared` 的新模块（如 `packages/ui/src/v4/conversationProjectionAccumulator.ts`），增量构建器同理抽到 `@/`-free 模块；测试只覆盖下沉后的纯函数，T-AP2/T-AP3 改为断言下沉模块的行为；
     - **(b) 加解析器**：新增一个 Node loader 把 `@/` 映射到 `packages/ui/src/`，在 `tsx --import ./scripts/dev/ui-alias-loader.mjs --test` 下运行（顺带能让既有的 `packages/ui/test/nonCliAcpRetirement.test.ts` 变绿）。
  2. 在 Step 5 末尾加一条可执行性自检命令（`tsx --test <file>` 必须 `# fail 0`），否则 Step 10~12、17 的 blocking 步骤没有判定依据。

---

## 三、剩余 P1（3 条，应修）

| # | 问题 | 证据 | 修改建议 |
|---|---|---|---|
| N3（新） | B-1 只让 `renderUnits` useMemo 去掉 `liveNowMs` 依赖，**没要求删除 `liveNowMs` state 与每秒 `setInterval`**。`setLiveNowMs` 每秒仍在 `ConversationTimeline` 根触发一次 state 更新 → memo 虽不重算，但整棵会话组件仍每秒重渲染，直接违背 PRD 验收「秒级 tick 不引起会话级重算」。 | `packages/ui/src/v4/ConversationTimeline.tsx:408`（state）、`:412`（`nowMs: liveNowMs`）、`:415`（deps）、`:562-575`（`setInterval(RUNNING_WORK_DURATION_TICK_MS)`，`hasRunningUnit` 时每秒）；`prd.md:78` 验收项 | Step 6 补：「删 `:562-575` 整段 effect + `:408` state + `:412` 的 `nowMs` 实参；计时唯一来源为 `WorkingDurationText` 内部 tick」，并在 Step 9 的中期采样里加「root 组件 render 次数不随停留时长线性增长」 |
| N4（新） | C1（spec.md:56）称「store 内持有 `createMutableConversationSnapshotAccumulator`（复用 `apply.ts:24-35`，**不新写 apply 逻辑**）」。但 `apply.ts:24-35` 只是 accumulator 构造器；真正的可变 apply 入口是 `applyConversationDeltaMutable`（`:153`）与 `applyConversationDeltasMutable`（`:213`）。按现文字实施者会自己重写一整套 delta switch，与「不新写 apply 逻辑」自相矛盾。 | `packages/shared/src/zcode-protocol-v4/apply.ts:24-35`（构造器）、`:153-210`（mutable 单条）、`:213-218`（mutable 批量）；服务端先例 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:1039/1085` | C1 与 Step 11 把落点改为 `applyConversationDeltasMutable`（`apply.ts:213`）+ `createMutableConversationSnapshotAccumulator`（`apply.ts:24`）成对使用，并写明「delta 分派语义一律来自 apply.ts，renderer 侧不得新增分支」 |
| N5（新） | copy-on-notify 只点名 `logSubagentProjectionTransition`（`:725`）改用 `previousIds`，但同一个 `next` 快照还有三个消费点：`reconcileOptimistic(next)`、`reconcileAcceptedInputProjection(next)`、`observeModelTransition(next, …)`。若它们拿到的是会被后续 `applyConversationDeltaMutable` 继续 mutate 的 accumulator 本体，就是读了一个「已发布但仍在变」的对象。 | `packages/ui/src/v4/conversationProjectionStore.ts:722-756`（`next` 的全部消费点）、`:1294-1317`、`:1319-1325`、`:760-770` | Step 11 补：「先构造发布外壳副本 `published`，`setState({snapshot: published})`，随后 `logSubagentProjectionTransition / reconcileOptimistic / reconcileAcceptedInputProjection / observeModelTransition` 一律只读 `published`，不得读 `accumulator.snapshot`」；T-AP3 增断言「通知后继续 apply 下一帧，已发布外壳内容不变」 |

---

## 四、剩余 P2（12 条，可选）

| # | 问题 | 证据 | 修改建议 |
|---|---|---|---|
| N6 | B-3/Step 8 称 RowShell 是「`data-row-id` 的真实产地，14 个调用点」，实测 RowShell 只有 **10** 个调用点；另有 6 处非 RowShell 的 `data-row-id`。它们不参与 `syncTurnNavigatorViewport`（被 `turnNavigatorQueryRowIdsRef` 过滤，query 行全部经 RowShell 渲染），但 SPEC 未说明，实施者会担心漏注册。 | ✔ `ConversationRowView.tsx` RowShell 调用点 `:152/1040/1187/1490/1583/1602/1862/1903/1925/2021`；非 RowShell：`ConversationTurnGroup.tsx:181/240/298`、`ConversationRowView.tsx:1678/1693`、`ConversationAgentToolCallRow.tsx:71`；过滤见 `ConversationTimeline.tsx:913` | B-3 补一句「registry 只需覆盖 RowShell；cuaGroup/exploreGroup/timelineMarker/agentToolCall 的 `data-row-id` 不在 `turnNavigatorQueryRowIdsRef` 内，`syncTurnNavigatorViewport` 本就跳过」；调用点数改为 10 |
| N7 | 模块级 `rowElementRegistry: Map` 未说明共享范围与时序：`ConversationShareReadonlyTimeline` 也渲染 `ConversationRowView`（同 rowId 空间），且 ref callback 在 StrictMode/并发渲染下会双调用。 | `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` 复用 row 视图；`ConversationRowView.tsx:130-148` | Step 8 补「registry 以 `rowId` 为键、写入幂等（`ref` 收到 null 时按 rowId 删除，不比较节点）；分享只读时间线与主时间线不同时挂载，若同时挂载需按容器前缀分桶」 |
| N8 | turnDirectory params 首项仍是中文占位符「会话定位」，未写实际字段名。 | spec.md:76 vs `packages/shared/src/zcode-protocol-v4/transport.ts:505`（`sessionId: z.string()`）、`:528-532`（plans 用 `sessionId: z.string().min(1)`） | 写成 `sessionId: z.string()`（或与 plans 一致 `.min(1)`），与其余契约段风格统一 |
| N9 | 缓存键写 `turnKey`、dirty 集合写 `turnId`，两个口径未统一说明（unit 同时有 `key` 与 `turnId`）。 | spec.md:64；`conversationTurnRenderUnits.ts`（unit 同时导出 `key` 与 `turnId`） | 统一为「`turnId` 为失效集合元素、`unit.key` 为缓存键」，一句话写死 |
| N10 | B-2 仍留「**或**等价地按主 `virtualRows[0].start` 边界变化触发」的二选一，未拍板。 | spec.md:48 | 二选一写死（推荐 `Math.floor(scrollOffsetPx / 72)`，与 `ConversationTimeline.tsx:1705` 的 `scrollOffsetPx` 同源，改动最小） |
| N11 | C2 写「`loadingOlder` 字段更名**或**新增 `loadingDirectory` 态字段」仍是二选一；且 `ConversationTurnNavigator` 的 `isHydratingDirectory` prop 来源未在清单里点名。 | spec.md:95；`packages/ui/src/v4/ConversationTurnNavigator.tsx:140`（`aria-busy={isHydratingDirectory}`） | 拍板「新增 `loadingDirectory`，不改 `loadingOlder`」，并在 Step 17 点名 `ConversationTurnNavigator` 的 prop 接线 |
| N12 | SessionPane 短路只点名 `shareRenderUnits`，其下游 `shareItems`/`eligibleShareItems` 与 `:668-678` 的 effect 也需一并条件化，否则非分享态仍在做 O(N) 派生。 | `packages/ui/src/v4/SessionPane.tsx:641-644`、`:645-663`、`:668-678` | Step 12 补「`shareItems`/`eligibleShareItems`/`eligibleShareRowIds` 一并按 `shareActive` 短路或复用同一增量缓存」 |
| N13 | shiki LRU 与 `:176` 的异步写入存在竞态：`tokensCache.set` 发生在 tokenize 回调里，回调触发时可能已超上限，且可能淘汰正被 `subscribers` 持有的 key。 | `packages/ui/src/v6/../lib/shikiHighlighter.ts:151-193`（`:176` set、`:151-154` 订阅、`:184/193` 退订） | Step 20 补「`set` 后立即执行一次 `evictIfOverCap()`；淘汰时跳过 `subscribers.has(key)` 的在订 key；上限判定在写入点而非只在读取点」 |
| N14 | Step 19 未说明 `scrollToQuery` 需改造：现为同步 fire-and-forget，内部用 `querySelector` 找行。 | `packages/ui/src/v4/ConversationTimeline.tsx:1275-1303`（`scrollMountedQuery` 用 `element.querySelector('[data-row-id=…]')`）、`:1306-1307` | Step 19 补「`scrollToQuery` 改 async：先查 `rowElementRegistry`，未命中再走分页拉取；拉取期间置 loading 态，失败 toast」 |
| N15 | `assistantPreviewKind` 服务端规则只看 `turnHeader.state === "running"`，renderer 现状是 `resolveTurnRunning`（无 header 时按 `sessionPhase` + 运行中的 work 行兜底）。冷恢复缺 header 的尾窗下两边会给出不同 kind（目录 `empty` vs rail `running`），与「hover 摘要文本不变」有边缘冲突。 | `packages/ui/src/v4/conversationTurnRenderUnits.ts:199-220` vs spec.md:82；`packages/ui/src/v4/conversationTurnNavigatorHelpers.ts:144-166` | C2 补「服务端 kind 判定与 `resolveTurnRunning` 对齐：无 header 时按 running work 行兜底」，或在 T-TD2 显式声明该边缘差异可接受 |
| N16 | 行号微漂移（实质成立，不影响实施）：B-1 写 `renderUnits useMemo` 在 `ConversationTimeline.tsx:408-416`，实际 `:409-416`；Step 0 写 `conversationTurnNavigatorHelpers.ts` 332 行，实际 333 行；`sessionPhase`/`isLastTurn` 引用 `conversationTurnRenderUnits.ts:199-220/:279` 均正确。 | `ConversationTimeline.tsx:409-416`；`conversationTurnNavigatorHelpers.ts:1-333` | 可不改；若要精确一并校正 |
| N17 | 「不与代码冲突但需在 Step 3 补一句」：SPEC 说采样脚本「不通则报错并提示用户先跑 `zcode: prepare desktop debug` 任务」，该任务确实存在，但它只做构建/tsup，**不起 vite dev server**（`ELECTRON_RENDERER_URL=5174` 需要 vite 在跑），提示语可能误导。 | ✔ `.vscode/tasks.json:59` label 存在；`:72/:100` 为 `dependsOn` 关系 | Step 3 补「若 5174 不通，提示用户启动 packages/web 的 vite dev server（而非仅 prepare desktop debug）」 |

---

## 五、Go / No-Go

**No-Go**：3 条 P0 仍开放——(1) P0-4 `startedAt` 只覆盖 guide 段，普通单段 running turn 的「工作中 N 秒」在 Step 6 落地后仍会退化为空时长文案，且根级每秒 tick 未下线，直接撞 PRD 渲染层验收项；(2) P0-5 B-4 的截断算法与 T-TD1 的「逐字节一致」在数学上不可兼得，Step 13 必红；(3) P0-10 Step 5 的 seam 方案不解除 `@/` 传递依赖，T-PA2/T-AP2/T-AP3/T-AP4/T-TD3 五条 blocking 用例在 SPEC 自定 harness 下跑不起来，Step 10~12/17 的 blocking 判定失去依据。三条 P0 分别落在 blocking Step 6 / Step 13 / Step 5+10~12，按现 SPEC 编码仍会返工。r1 的 16 条 P1 与 9 条 P2 已全部闭合，方向与代码事实核对一致，无新增 P0；补齐上述 3 条 P0 + 3 条 P1（N3/N4/N5）后可进 r3 复审。
