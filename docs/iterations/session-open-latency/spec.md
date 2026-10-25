---
date: 2026-10-25
dependency:
  - iterations/optimization-triage-20261025/research.md
---

# session-open-latency 技术规格（SPEC）

## 设计目标

把冷开与中途切换压到 **1s / 800ms 级**，且不靠「看起来快了」。

现有链路的瓶颈不是传输（尾窗 60 行 + 游标分页早已就绪），而是三件事被绑死：

> 为了显示 60 行，先把全部消息读进来、全量合成事件、建完整投影；还要先把 runtime 激活（全量 hydrate 历史 + eager 初始化 context）。

根治方向是把这三件事解绑，但**首诊推翻了我最初的分法**：`totalCount`/`firstRowId`/`queryRowId` 是**行**事实，不是消息事实，消息 id 索引产不出它们。因此正确的三分是：

| 关注点 | 需要什么 | 权威来源（本 spec 划定） |
|---|---|---|
| **显示窗口** | active 分支后缀的 N 条消息 → 尾部行 | 分支感知的分页正文读 |
| **全序事实** | 行数 / 首行 / turn 目录 / 真实 user query 数 | **turn 级行清单（row manifest）** |
| **运行时历史** | 发送时才需要完整历史 | 首次发送前一次性全量水化 |

### 需求来源

用户口述与拍板（见 `docs/apm/memory/20261025-session-open-latency-b1.md`）：

> 之前那个会话加载慢的问题还记得吗？

> 那就按 B1 做，切换会话也要快。

> （追问现状）现在基线变了，还能照旧做吗？

> 都修吧，根治。如果需要决定的地方，通通按照根治的思路做决定。

需求路径：`docs/iterations/optimization-triage-20261025/research.md` §1 + 上述口述。

### 对既有调研的勘误（本 spec 以此为准）

1. **`readSessionContextUsage` 不重复读 messages**：`server-operations.ts:1848` 是 `persistedMessages ?? readSessionMessages(...)`，冷路径传的是合并源 messages。它真正重复的是 eventStore、session 行，以及 `record.app.runtime.getProjection()`（`:1855`，view-only 下不可用）。
2. **「hydratePublisher 是 projection-only」不成立**：`loadPersistedEvents` 在无 record 时直接返回空事件（`v4-bridge.ts:1753-1765`），仓内**不存在**「只投影不激活 runtime」的分支。唯二的「只激活、不建 publisher」先例是 `ensureHostRecordForJournalRead`（`v4-gateway.ts:1958-1961`）与 `attachmentBegin`（`:2039-2042`）。
3. **`openTiming.snapshotRowCount` 是投影全量行数**（`v4-gateway.ts:1481`），不是下发的 60 行。
4. **`v4-bridge.ts` 在 `bootstrap/src/zcode-protocol/`，不在 `-v4/`**。
5. **`baseTimestampMs` 已存在**于 `SynthesizeOptions`（`transcript-hydration.ts:88`），不需要在 `context` 里再加一个，否则两个来源。

### 本 spec 的决策立场（已获授权，不再回问）

| 分叉 | 决定 | 理由 |
|---|---|---|
| 行序权威放哪 | **turn 级行清单（row manifest）**：每个 turn 记录 `{turnId, messageIds, rowCount}`，`rowId` 由「前序 turn 行数累加」**确定性推导**，不再全局自增 | 保留全局自增则只物化尾窗时 rowId 从 1 起，`hasOlderRows`（`window[0].rowId > firstRowId`）恒为 false，翻页根本不存在；而让消息索引直接产出行数又不可能（行是投影产物）。manifest 是唯一同时满足「不读正文」与「与全量投影逐值一致」的形态 |
| `session.revert` 裁断能否用窗口近似 | **不能，必须全序** | 只喂尾窗时 `selectActiveConversationBranch`（`contracts/src/rewind/index.ts:165-204`）会因 `targetIndex < 0` **复活已回滚分支**、因 `cutIndex < 0` **整段清空**。全序只需 id 序，成本极低 |
| `totalCount` 能否改成估算 | **不能**，改由 manifest 给精确值 | UI 同时用它估滚动条高度与判 `totalCount > rows.length`（`ConversationTimeline.tsx:1776,1815`），估算会让两者互相矛盾 |
| 排序规则 | **复刻 `messages.ts:230` 的权威序** `order by sequence is null, sequence, time_created, rowid` | `sequence` 是 rewind/upsert 语义列，与 `time_created` 不同序；另起一套必然与全量读不一致 |
| 是否做 view-only 首屏 | **做** | 冷开 7.6s 里 `session.resume_completed` 占 2.7s，只做投影窗口化拿不回这一段 |
| 运行时历史何时全量 | **首次发送前**，且 `historyMode` 取 `"none"` 而非 `"tail"` | `messageHistory.init()`（`message-history.ts:163-164`）会把 `entries` 清空，tail 水化的产物必然被抹掉，做 tail 是纯浪费 |
| 协议兼容 | `sessionActionAvailability` / `commandAck.reasonCode` 的扩张是 additive；**`openTiming` 不是** | `conversationOpenTimingSchema` 是 `.strict()`（`transport.ts:149`），加键会让旧客户端整帧解析失败 → 新分段放 ack **顶层**新键，不动 `openTiming` |
| **runtime 何时被激活**（首轮漏掉，会死锁） | **ACK 后后台预激活 + send 类命令 await**：view-ready ACK 后立刻 fire-and-forget 启动 runtime 激活；`sendText` 类命令 `await runtimeReadyFlights`（自动触发一次激活），其它命令在 runtime 未就绪时回 `runtimeNotReady`。**composer 不禁用**（可输入，只在发送前显示「正在加载运行环境…」） | 若 composer 禁用 + 所有命令都拒，就没有任何路径能升到 runtime-ready，会话永久停在 view-only。**注意 `runtimeReadyMs` 的写入点不在订阅专有路径上**：今天它写在 `ensureColdReadyPublisher` 里，而该函数被订阅、`rowsRange`、`turnDirectory`、`plans` 等**所有冷会话读入口**复用，「激活的唯一生产点是冷订阅」不成立 |
| manifest 粒度 | **turn 级行清单 + 一次 O(turns) 窄读供 preview** | 目录项要求 `queryPreview`/`assistantPreview`/`previewKind`（`publisher.ts:588-599`、`transport.ts:560-568`）且一个 turn 可以有多条 steer query 各成一项，纯 `{row_count, query_row_id}` 表达不了；preview 只需按 id 点查该 turn 的 query 与末条 assistant 消息文本前缀，不读全量 parts |
| `totalCount` 在 delta 侧怎么维护 | **`row.removed` 增加 `totalCount`/`firstRowId`**（`delta.ts:100` 非 strict，additive），权威值随裁断一起下发 | `apply.ts:92-93` 的 `removed` 数的是**客户端窗口内**被删行；窗口只有 60 行时 rewind 到 rowId 3000 只能减 60，manifest 却是 20000 → 客户端 totalCount 与权威值立刻分叉 |

## 根因

### RC1 — 冷订阅把「看」与「跑」绑死

`ensureColdReadyPublisher`（`v4-gateway.ts:2926-2949`）里 `await coldResume.ensureResumed()`（`:2935`）排在 `hydratePublisher()`（`:2940`）之前，且 `hydratePublisher` 的输入 `persistedMessages` 正是 resume 的产物。resume 的代价构成（`core/src/runtime/methods/resume.ts:59-309`）**全部非惰性**：

| 步骤 | 位置 | 代价 |
|---|---|---|
| 全量 messages（复用入参） | `:91-95` | 上游已读库一次 |
| `hydrateReadFileStateFromSession` 全量扫 | `:137-146` | O(messages) |
| **`ensureContextInitialized`（eager）** | `:147` | MCP 启动、skill 发现、MEMORY.md 读盘建索引 |
| **`hydrateMessageHistoryFromSession`（全量）** | `:148-156` | O(active × parts)，user part 逐个 `await` artifact I/O（`session-history-hydrator.ts:101,156,222-245`） |
| `restoreWorkspaceCheckpointEntries` / `FileRewindEntries` | `:178-179` | eventStore 全读两遍 |
| `runSessionStartHooks("resume")` | `:240-244` | 用户 hook 脚本，串行不可预估 |

**没有现成懒加载开关**：`ResumeSessionOptions` 只有 4 字段（`core/src/runtime/types.ts:268-279`）。但 `ensureContextInitialized` 带 `contextInitialized` 守卫（`context.ts:37`），turn 起点本来就会调（`turn.ts:201`），所以惰性化基础已具备。

### RC2 — 「全序」与「全量正文」耦合，且全序的对象被搞错了

所有全序量都由全量投影现算：

| 全序量 | 现在怎么算 | 真正需要的信息 |
|---|---|---|
| `totalCount` / `firstRowId` | 全量**行**现算（`conversation-topic-publisher.ts:366-367`） | 每 turn 的行数（manifest） |
| `hasOlderRows` | 前端比较 `window[0].rowId > firstRowId`（`conversationProjectionStore.ts:275-280`，**不用 totalCount**） | 同上 |
| `getTurnDirectory` | 单趟全扫（`publisher.ts:538-618`），条目键是 **`queryRowId`** | `{turnId, 首末 rowId, 是否 user query}` |
| `realUserQueryTotal` | 全量行现算，注释明确「不受游标与 limit 影响」（`:610-612`） | user query 计数 |
| `session.revert` 裁断 | 全量**消息** `findIndex`（`contracts/src/rewind/index.ts:165-204`） | message id 序 |
| `durableTurnByMessageId` / hook 归属 | 全量 message→turn 映射（`cold-event-merge.ts:545-573,580-634`） | messageId → turnId |

**两类事实被混为一谈**：行事实（rowCount / queryRowId）与消息事实（id 序 / 分支归属）。消息索引能服务后者，服务不了前者——这是首轮 P0 的核心，也是本 spec 引入 manifest 的原因。

### RC3 — `rows/range` 反向触发完整冷开

`v4-gateway.ts:1608-1624` 的 `rowsRange` 在冷会话上会先走 `readyFlights → hasLiveConversation → ensureColdReadyPublisher`，即**翻一页就把整条冷开链路再走一遍**。同时 `getRowsRange` 的数据源是 `projection.getSnapshot().rows.window`（`publisher.ts:480-497`）——只物化尾窗时，更早的行**根本不存在**，`hasMore` 无从谈起。

### RC4 — turn 身份由「窗口内序号」推导

`synthesizeEventsFromMessages`：`turnNumber` 从 0 累加、turnId 为 `hydrate-turn-${n}`（`transcript-hydration.ts:1379,1663-1665`）；时间基准取 `messages[0].info.time.created`（`:1349`，`SynthesizeOptions.baseTimestampMs` 已存在但冷路径**没传**）；模型基线靠「上一个 ModelSelected 变化」推导（`:1397-1414`）。窗口化后编号漂移、时间戳平移、产生虚假 `ModelSelected`；窗首若为 assistant 还会凭空多一个 model-only preface 轮（`:1620-1659`）。

## 不变式

| ID | 不变式 |
|---|---|
| **IS1** | **投影身份确定性（live 与 cold 同一规则）**：`turnId`、`rowId`、`row.createdAt`、`ModelSelected` 序列在任意物化顺序 / 任意窗口起点 / **任意路径（live 或 cold）** 下必须逐值一致。**前提是废除全局 `nextRowId++`**：rowId base 在每个 turn **起始时**由 manifest 给出（= 前序 active turn 的 `row_count` 累加），live 与 cold 走同一函数。这样 rewind 后新 turn 复用被截 turn 的 base，**不再产生空洞**（现状 `:5141` 的 `nextRowId++` 永不回退正是空洞来源）。`createdAtSeq` 由 `event.sequenceNumber` 派生（`:5150`），窗口化后全局序号不同，**不参与比较** |
| **IS2** | 分支裁断、文件摘要、用量统计永远基于**全序**信息（正文可窗口，id 必须全序）；窗口 = **active 分支的后缀**，不是原始序后缀 |
| **IS3** | 命令只能在 **runtime-ready** 之后执行；view-ready 只放行读与翻页，但 **send 类命令是激活触发器**（见决策表） |
| **IS4** | `hasLiveConversation` 三态（live / viewOnly / absent），且 `v4-gateway.ts` 内**不得残留 `sessionExists` 直判**：`:705,1099,2002,2039,2065,2111,2164,2208,2828,2996,3307` 11 处须逐个归位。**实现方式**：保留同步的 `conversationState`（只判 live / notLive，它本身必须调 `host.sessionExists`），viewOnly vs absent 由视图水化结果落一个 gateway 侧 `viewReadySessions` 集合承担（absent 只能由一次异步 store 读得知，同步函数判不出来） |
| **IS5** | `totalCount` / `firstRowId` / `realUserQueryTotal` / `turnDirectory` 与每个 turn 的 rowId base **只来自 manifest 两张表**，禁止由 `rows.window` 现算、禁止为此读全量 parts。**范围与 IS1 一致**：manifest 对 live 与冷投影**都是权威**（rowId base 与计数同源），因此 live 也不能再用全局 `nextRowId++` |
| **IS6** | `rows/range` 必须能在**未物化**的页上工作（按需物化），且不重复触发冷开 |
| **IS7** | 运行时历史未全量水化前禁止发 turn；闸门必须在 `ensureContextInitialized` **之后** |
| **IS8** | `openTiming` 不改（`.strict()`）；新分段放 ack 顶层新键 |

## 总体方案

六阶段，顺序有硬依赖：**manifest 先行**（IS5 的唯一来源）→ 分页物化 → 拆看/跑 → 懒历史 → 门禁。

### phase-0-baseline

- 在同基线（HEAD 含 v1.0.27 补丁）实测三路径（冷开 5k 消息会话 / 冷开小会话 / 热切换 / 深翻页到底），落 `docs/iterations/session-open-latency/baseline.json`。
- **验收基准（2026-10-25 cr-func 矫正，以后以此为准）**：「冷开 ≤1s」判的是 **renderer 侧 `uiViewReadyMs`**（= `connect 入口 → snapshot 应用完成`，renderer 单调时钟）；要覆盖到首绘再加 `paintAfterApplyMs`（2×`requestAnimationFrame`，`uiViewReadyMs + paintAfterApplyMs` 才是体感总量）。两者由 `conversationProjectionStore` 回填进 `__zcodeV4ConversationOpensE2E` 的 ACK 样本。
  - **`openPhases` 降级为分解项**：`viewReadyMs` 是 **CLI 进程内**的视图就绪段（起点 `subscribeReserved`、终点 ACK 组装），**不含** `openTiming.cliBootstrapMs`（冷开新 spawn CLI）、`hostPrepareMs`、`cliRequestMs`、ACK 后的首帧传输、`rendererSnapshotApplyMs` 与 React commit + paint，冷开下系统性偏短，**不得**再用它判 ≤1s。
- **口径三条硬约束**（写进 schema / 脚本 / 验收三处）：①`viewReadyMs` = CLI 内部视图就绪段，不含上述任一段；②各段**嵌套不可相加**（`viewReadyMs ⊇ initialFrameEncodeMs`，`viewReadyMs ⊃ mergeMs + rehydrateMs`，阶段 0 里它**还** ⊇ runtime 激活本体）；③`manifestMs` / `materializeMs` 本阶段恒缺席，热切换下 `mergeMs` / `rehydrateMs` 也会缺席——**缺席 ≠ 0**，禁止补 0 求「各段之和」。
- **`runtimeReadyMs` 口径钉死为「激活本体耗时」**（`coldResume.ensureResumed` 的耗时），**不是**「从 ACK 起算」：阶段 0 激活在 ACK **之前**（按 ACK 起算会是负数），阶段 8 拆开后激活在 ACK **之后**（按 ACK 起算会掺入等待）。只有本体耗时能跨阶段比较。
- **分段观测通道（IS8）**：不动 `openTiming`（`.strict()`）。新增 ack 顶层键 `openPhases: { viewReadyMs, manifestMs, materializeMs, mergeMs, rehydrateMs }`——**不含 `runtimeReadyMs`**（view-only 的激活发生在 ACK 之后，ACK 帧里不可能有该值；它由 `conversation/runtimeReady` query 提供）；`mergeMs`/`rehydrateMs` 的产生点在 `performHydration`（`:2989-3185`）内部，由 gateway 侧变量回传，锚点不是 `:1443-1445`。
- **runtimeReady 的观测通道（二选一已定：走 query）**：view-only 下 runtime 激活发生在 ACK 之后，故新增 `conversation/runtimeReady` query 回传该值，Step 14 从它读。已知代价：该 query 要穿 5 层管道——`transport.ts:335` V4_METHODS → `server.ts:507` case → gateway → `zcodeAgent.ts:880` → `zcodeAgentService.ts:4719` → `zcodeAgentConnectionScope.ts:736` → `agentConversationTransport.ts:337`；这 7 处都要改，列进 Step 1。（**不再并列「写 `session.resume_completed` 日志字段」方案**——两套通道并存会出现双源不一致。）
- 采集脚本：`scripts/dev/long-session-perf-sample.mjs` 原本只消费 `window.__zcodePerfProbe`（`:291-308,685-693`）；`--out` **是既有参数，直接复用**（不要新增第二个输出选项），需补的是 ack 顶层键、`runtimeReady` query 与 renderer 侧 `uiViewReadyMs`/`paintAfterApplyMs` 的采集，示例：`--out docs/iterations/session-open-latency/baseline.json`。

### phase-row-manifest（IS2 + IS5）

**新增两张持久结构**（adapters 新迁移）：

```
session_turn_manifest:                     -- turn 级：出全序计数与 rowId base
{ session_id, branch_generation, ordinal, turn_id,
  first_message_id, last_message_id, message_ids_json,
  row_count, row_count_source,             -- 'live' | 'cold'
  projection_schema_version }

session_turn_query_manifest:               -- query 级：出目录条目（只登记 origin === "realUser"）
{ session_id, branch_generation, turn_id, query_ordinal_in_turn,
  query_message_id, query_row_id, row_count,
  query_preview, assistant_preview, assistant_preview_kind }   -- 终态时算好落盘
```

**query 表只登记 `origin === "realUser"` 的消息**——`rows.ts:111-118` 还有 5 种 origin，全登记会让 `realUserQueryTotal` 多计。

**为什么必须是两张表**：目录粒度是 **realUser query 行**，同一 turn 的多条 steer 各自成条（`publisher.ts:534-535`）；每条 entry 需要 `queryPreview`/`assistantPreview`/`assistantPreviewKind` 三个**正文派生**字段（`:584-601`、`transport.ts:560-568`），其中 `assistantPreview` 是整个 turn 所有 assistantText 行的折叠（前 2 段 / 220 字，`previewText.ts:27-29,184-186`），`assistantPreviewKind` 还要看 `turnHeader.state === "running"`。这些**只能在终态时算好落盘**，留给冷开窄读去猜必然与全量物化不一致（T-SL7 会红）。

- **写入时机**：每个 turn **终态**时写入 turn 行与全部 query 行。终态写入点不止一个——`onTurnComplete`（`product-projection.ts:2184-2202`）**和 `onTurnError`（`:2300,2305,2328`）**都会终结 turn 并写 header，两处都要挂。live 写入置 `row_count_source='live'`；**冷路径物化出来的 turn 同样回写**（`'cold'`）。
- **计数口径（必须先定，否则快路径永远命中重建）**：同一 turn 在 live 与 cold 两条路径下行数未必相同（cold 走 `synthesizeEventsFromMessages` + `mergeColdConversationEvents`，含 durable 事件压制、`session_entry` 合成的 goal verification、由 checkpoint 反推的 fileChanges）。**统一以 cold 规则为准**；`manifestFallback` 不是常态。
- **一致性校验**：冷开读取时对已物化窗口内的 turn 比对行数；不一致**不整表重建**，而是做一次 O(turns) 的**账目修正**（改该行 `row_count` + 平移后续 turn 的 base，不重读正文），并置 `manifestAdjusted: true`。只有 `projection_schema_version` 不匹配或「消息索引里存在 manifest 未登记的 turn」才做整表重建 / 就地补写。
- **读取**：冷开时一次读两张表（行数与 turn 数同阶）。`totalCount = Σ row_count`、`firstRowId = 1`（**空 active 分支时 `totalCount = 0`、`firstRowId = null`**——注意 `snapshot.ts:504` 的 `totalCount` 是 `z.number()` **不可空**，只有 `:506` 的 `firstRowId` 可空，对齐 `publisher.ts:367` 与 `apply.test.ts:514-527` 的 `totalCount=0 / firstRowId=null` 契约）、`realUserQueryTotal = count(query_row_manifest)`、turn 的 rowId base 由前序累加得出、`turnDirectory` 直接读 query 表（含三个 preview，无需窄读）。
- **rowId 推导（live 与 cold 同一函数）**：`rowId(turn i) base = 1 + Σ_{j<i} active(row_count_j)`，在 **turn 起始时**求值。这要求**废除跨 turn 的全局 `nextRowId++`**（`product-projection.ts:437,5140-5152`）；rewind 后新 turn 复用被截 turn 的 base，因此不再产生空洞——这是 T-SL7/T-SL11 能成立的前提。
- **rewind 处理**：manifest 按 `branch_generation` 键控；截断到整 turn 边界时直接过滤掉被截 turn（不重算）；截在 turn 中间时只重算该边界 turn。**写入方需要 branch_generation 状态**：`product-projection` 目前只在 `onRewindTriggered` 里读该值（`:1800,1830`）从不保存，须新增字段，并把「rewind 时截断/复制 manifest」列进 Step 2。
- **manifest 缺失**（老会话、gen 不匹配、schema 版本不匹配）：降级为一次全量物化并**顺带重建 manifest**，之后自动进入快路径；降级必须打点（`manifestFallback: true`），否则「没生效」会被误读成「优化无效」。
- **消息索引** `listSessionMessageIndex(sessionId)`：`select id, sequence, time_created, rowid from message order by sequence is null, sequence, time_created, rowid`——**message 表没有 role 列**（role 在 `data` JSON 里，`rows.ts:29-36` + `codecs.ts:82-88`），本查询也**不读 `data`**；part 侧权威序是 `messages.ts:240`（`order by message_id, sequence is null, sequence, time_created, id`），两段查询都要复刻。
- **`durableTurnByMessageId` 的数据源**：manifest 的 `message_ids_json` 给出 `messageId → turnId`，替代 `cold-event-merge.ts:506-544` 的全量扫描。**`durableTurnByRuntimeAnchor`（`:552-573`）需要 `message.info.anchor.turnId` 的 runtime 锚，manifest 没有这一列**——该场景改用索引查询 `select json_extract(data,'$.anchor.turnId') from message where session_id=?`（O(turns) 级，不解析正文），不再二选一。
- **`selectActiveConversationBranch` 输入放宽**：改为「id 序 + 可选正文映射」，全量与索引两条路径共用同一函数（不写第二份规则）。

### phase-paged-materialization（IS1 + IS2 + IS6）

- **`readSessionMessagesTail` 必须是分支感知的**：签名 `readActiveBranchTail({ sessionId, activeMessageIds, limitBefore })`——先用 manifest + 索引算出 active 序列，再按**消息区间**读正文（message + part 两段查询，避免 N+1）。原设计的「按 `time_created desc` 取 N 条再裁断」对 revert 过的会话会得到空历史或复活旧分支。
- **窗口按整 turn 对齐**（toolCall ↔ result 不跨窗），且用**双约束的显式常量**：新增 `PROTOCOL_V4_LIMITS.coldWindowTurns = 8` **与** `coldWindowMaxRows = 400`（取 `min`；单 turn 是 turn 上界、行数是硬上界——单个超大 turn（几百个 toolCall）否则会让「窗口化」失效）。`core.ts:75-76` 既有 `snapshotTailWindowRows: 60` / `rowsRangeMaxLimit: 200` 同级。
- **注入非零起点上下文**（RC4）：`synthesizeEventsFromMessages` 增加 `context: { initialTurnNumber, initialModelKey, preface }`，并**复用已存在的** `SynthesizeOptions.baseTimestampMs`（`transcript-hydration.ts:88`）——冷路径现在没传，补上传即可。不得新增第二个时间基准字段。
- **`getRowsRange` 的 `hasMore` 必须改口径**：现在是 `eligible.length > rows.length`（`publisher.ts:486-497`），`eligible` 来自当前投影窗口——按需物化后若只物化本页，`eligible.length == rows.length` 会让 `hasMore` 恒 false，而客户端硬依赖它（`conversationProjectionStore.ts:1260` 的 `if (!result.hasMore) break;`）。改为**与 manifest 的 `firstRowId` 比较**（本页首行 rowId > `firstRowId` 即还有更早；**不能写死 `> 1`**，live rewind 后 `firstRowId > 1`）。
- **IS6 的执行缝必须指名**：`getRowsRange` 是 **publisher 的同步方法**（`publisher.ts:476-498`），publisher 构造只有 `sessionId/logEpoch/options`（`:285-291`），**没有 store、不能异步**。因此按需物化只能在 **gateway 侧**完成：`rowsRange` 入口先按 manifest 定位缺哪几个 turn → 异步读正文 → 用临时投影合成页 → 再交给 publisher 编码；publisher 侧只把 `hasMore` 改成按 manifest 判定。这一点必须写进 Step 7，否则实现会卡在「同步方法里没法 await」。
- **按需物化的结果不驻留投影窗口**：只进本次返回页。理由：`apply.ts` 的 accumulator 与 `rowIndexById` / `turnHeaderRowIdByTurnId` 都是追加假设，前插需要重写存储；不驻留则每次翻页重合成（一页 ≤200 行的成本可接受）。此决定写进 IS6 的验收。
- **分页物化**：`getRowsRange` 遇到未物化区间时，由 manifest 定位「这一页属于哪些 turn」→ 读这些 turn 的正文 → 用 `rowId = base(turn) + 页内序` 物化 → 结果必须与全量物化逐值一致（IS1 的硬验收）。
- **必须保持全量的四处**（窗口只裁正文，不裁索引）：`session.revert` 裁断、`buildColdFileChangeSummaries`（按 active 分支全量 messageId 过滤）、`readSessionContextUsage`、`listSessionSubagents`。
- **`sharedContextImport` 不能靠窗口 find**：`cold-event-merge.ts:84-90` 现在在 active 分支里 `find` 那条 `shared_context` user message，窗口化后会静默消失。改为由 manifest/索引给出该 messageId。

### phase-view-runtime-split（IS3 + IS4）

**激活触发点（首轮整篇缺失，不补就是死锁）**：

- view-ready ACK 发出后**立刻后台预激活** runtime（fire-and-forget，`runtimeReadyFlights` 记录在途 flight），这样多数情况下用户看到历史时 runtime 已在就绪路上。`runtimeReadyMs` 的**写入点**是激活本体（今天在 `ensureColdReadyPublisher` 里量 `ensureResumed`），拆分后只换写入位置，读数口径仍是「激活本体耗时」。
- **`sendText` 类命令是激活触发器**：`handleCommand` 对 send 类命令 `await runtimeReadyFlights`（若尚未启动则当场启动），其余命令在 runtime 未就绪时回 `{status:"rejected", reasonCode:"runtimeNotReady"}`。**例外：`sessionId` 为空的新建会话（`createSession`，`v4-gateway.ts:2493-2499`）不受此门限制**，否则会把新建会话一起拒掉。
- **composer 不禁用**：只在发送前显示「正在加载运行环境…」；禁用会直接掐掉唯一的激活入口。
- `queryCommands` **不属于** runtime-ready 门槛：`v4-gateway.ts:2580-2590` 只 await 已存在的 flight、不会创建，也不会因 view-only 失败。

**其余改动**：

- **拆两张水位表**（`v4-gateway.ts:2926-2949`）：`viewReadyFlights` / `runtimeReadyFlights`。`readyFlights` 的实际引用是 `get` 12 处 + `size`/`delete`/`clear` 6 处（`:622,1433,1610,1635,1658,1968,1999,2062,2108,2161,2432,2435,2584,2808,2859,2931,2942,2945`），逐个归位：读/翻页 → view-ready；send 类命令与所有 `requireRecord` → runtime-ready。
- **`hasLiveConversation` 三态化**（IS4），并清理 11 处 `sessionExists` 直判。最高风险是幽灵 runtime 前科（`:1951-1957` 记录的事故：误判 cold 而二次 resume → 重复 `SessionResumed` → 双写账本 → transcript 定格）。
- **拆 `activateSessionForResume`**（`server-operations.ts:1409-1516`）：`materializeSessionShell()`（store 读 session + mode + `createRecord` → `sessions.set`）+ `activateRuntime()`（`app.resume` + `activatePausedTargetAfterResume` + 写 `SessionResumed`）。分界点是 `:1490` 与 `:1491` 之间。
  - `createRecord` 传 `resume:false` 的后果已查明，**不是空态而是默认模型**：`resolveInitialRegistrySelection` 走默认分支（`runtime-config.ts:288-296`，`:278` 的 invalid-selection 丢弃只在 `resume:true` 生效），`initialModelSelection` 取默认（`:70-72`），`create-app.ts:573` 的 `prepareResume` 整段跳过；而 `getSessionConfigSeed` **优先读 record**（`:1487-1489`），所以首屏会显示**错误的默认模型**而不是空态。对策：首屏 model 显式取 `derivePersistedSessionMode` + 尾部 assistant 的 modelId，并在 `getSessionConfigSeed` 里对 view-only 态**优先于 record**；取不到就显示空态。`derivePersistedSessionMode` 另需一个「最后一条带 mode 的 assistant」专用查询（`:3293-3297` 的倒扫若尾窗内没有会落 build 默认值，`:1471-1475` 记录过同类事故）。
- **`loadPersistedEvents` 的 store-only 变体**：**不得调用 `resolveConversationBackingRecord`**（它是 `:1753` 的前置闸门，无 record 直接返回空事件），签名不含 record；`synthesized` 由 `merged.usedDurableTranscript` 决定，否则 `performHydration:3033-3039` 会走「保留健康 live publisher」早退，首屏是空 transcript。
- **协议 additive（IS8）**：`sessionActionAvailabilitySchema`（`snapshot.ts:149-166`）加 `sessionRuntime: "live" | "viewOnly"`（schema 上 `.default("live")`）；**注入缝必须是 gateway 构造 publisher 时传入的 provider**——帧在 publisher 内编码后经 `emitReservedTopicFrame → emitWireFrame`（`v4-gateway.ts:3359-3367`）出站，网关拿不到可改的 snapshot 对象，事后注入不可行。`commandAck.reasonCode` 新增取值 `runtimeNotReady`（自由字符串，无需改 schema）。
- **`stop` 不需要新增维度**：`sessionControlSchema` 已有 `canStop` / `stopState` / `stopTargetKind`（`snapshot.ts:126-139`），`SessionPane.tsx:3070` 已在用。view-only 时下发 `canStop:false, stopState:"idle"` 即可。（首轮我误写为「不存在」，属三态纪律问题。）
- **UI**：`SessionPane` 的 `readOnly` **不能用**——`SessionPane.tsx:3395` 是 `readOnly ? null : <ConversationComposer/>`（`:3464` 的 bottom dock 同款），复用就没有 composer 可禁用。新增独立 `viewOnly` prop：**只禁 edit/fork/retry/rewind**；**composer 保持可用**（这正是唯一激活入口，禁用会复现死锁），发送时显示 placeholder「正在加载运行环境…」。`ConversationComposer` 需要一个**外部 placeholder 入参**（现在 `:342-374` 的 props 没有该字段，`:1436/:2049` 是内部 intl 计算）。
- **激活后升级**：`hydratePublisher(sessionId, undefined, true)` **是 no-op**——`:2962` 的 `if (existing && hydratedSessions.has(sessionId)) return` 在 `forceRebuild` 判断之前。正确写法：`hydratedSessions.delete(sessionId)` → `hydratePublisher(sessionId, undefined, true)`（先例 `:943-944`）。并断言升级后 `rows.window` 换成全量投影，`revision`/`seq` 对客户端呈现为「继续」而非跳变（客户端按 `logEpoch` 丢弃陈旧读，`conversationProjectionStore.ts:1152-1160`）。
- **首屏的产品降级（拍板，清单必须完整）**：store-only 路径没有 record，因此首屏缺四类东西，激活后补齐：①fileChanges 卡片摘要（`v4-bridge.ts:1813-1826`）；②usage 种子（`:1830-1833` → `server-operations.ts:1840-1866`）；③`workflowRuns` 的 journal 回放（`:1776-1780`）；④`config.thoughtLevels` / `permissionGrant` 种子（`getSessionConfigSeed` 无 record 返回 null，`:1485-1511`）。**另外三个读面必须显式降级而不是抛 `sessionNotFound`**：`getConversationFileChanges`（`:1643-1648`）、`attachmentPreviewSource`（`:1636-1642`）、`listDynamicWorkflowRunEvents`（`:1652-1659`）——返回空结果或 `fault.*.viewOnly`，UI 挂到 `sessionRuntime` 上显示「激活后可查看」。写进 UI 验收，不得当回归。

### phase-lazy-history（IS7）

- `ResumeSessionOptions` 加 `historyMode: "full" | "none"`，默认 `"full"`（行为不变）；view-only 用 `"none"`。
- **不做 tail 水化**：`messageHistory.init()`（`context.ts:287` → `message-history.ts:163-164`）会清空 `entries`，tail 的产物必被抹掉。resume 阶段只保留 readFileState 与索引派生的标量（`turnNumber`、`latestAssistantMessageId/TurnId`、`mainTurnCacheHitAggregate`）。
- **`ensureContextInitialized` 移到 turn 起点**（`turn.ts:201` 已在调，删掉 `resume.ts:147` 的 eager 调用）。
- **发送闸门钉在 `ensureContextInitialized` 之后**：`turn.ts:194-203` 是 init，闸门必须落在 `:203` 与 `:205` 之间再全量水化，否则历史被清空。
- `runSessionStartHooks("resume")` 保持在激活时（语义是「会话被打开」）。
- `discardPersistedPendingSteerInputs`（`resume.ts:220`）、`syncPersistedSessionTitleForResume`（`:215`）等以全量 messages 为输入的步骤，改为用索引/manifest 提供的标量，并逐个列在 Step 12 的核对表里。

### phase-gates

`bootstrap/scripts/test-cold-open-window.mjs` 承载 T-SL1~T-SL13；新增 `test:v4-perf` 挂载。T-SL8/T-SL9 需要 gateway 级夹具（`V4GatewayHost` 有 30+ 成员，多为 optional），而现有 bootstrap 测试只直接 `new ConversationTopicPublisher`（`test-turn-directory.mjs:52-72`、`test-publisher-buffer-clamp.mjs:26-52`）——**夹具建设单列预算**，或把这两条降级为「publisher + 抽出纯函数闸门」的用例。

## 最终项目结构

```
apps/zcode-cli/packages/adapters/src/storage/session-store/
  repositories/messages.ts                                 改（索引读 + 分支感知尾窗读，复刻权威序）
  repositories/turn-manifest.ts                            新增（**两张表**读写：turn 级 + query 级）
  migrations/<next>_session_turn_manifest.ts               新增（含两张表 DDL）
apps/zcode-cli/packages/contracts/src/rewind/index.ts      改（裁断输入放宽为 id 序 + 可选正文）
apps/zcode-cli/packages/core/src/runtime/
  methods/resume.ts                                        改（historyMode + 挪 eager context init）
  methods/turn.ts                                          改（init 之后的全量水化闸门）
  types.ts                                                 改（ResumeSessionOptions）
apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/
  session-row-manifest.ts                                  新增（manifest → totalCount/turnDirectory/rowId base）
  session-conversation-index.ts                            新增（id 序 + messageId→turnId）
  cold-session-resume.ts                                   改（mode 参数）
  cold-event-merge.ts                                      改（索引入参 + 窗口只裁正文）
  transcript-hydration.ts                                  改（注入 initialTurnNumber/initialModelKey/preface；复用 baseTimestampMs）
  v4-gateway.ts                                            改（双水位 + 三态 + 分段 + rows/range 不复触发冷开）
  product-projection.ts                                    改（**废除跨 turn 的全局 `nextRowId++`**，base 取 manifest）
  conversation-topic-publisher.ts                          改（全序量改走 manifest；getRowsRange 支持未物化页）
apps/zcode-cli/packages/bootstrap/src/zcode-protocol/
  v4-bridge.ts                                             改（store-only loadPersistedEvents，不含 record 闸门）
  server-operations.ts                                     改（materialize / activate 拆分）
packages/shared/src/zcode-protocol-v4/
  snapshot.ts                                              改（additive: sessionRuntime）
  delta.ts                                                 改（row.removed 带 totalCount/firstRowId）
  apply.ts                                                 改（两份实现同步读权威值）
  core.ts                                                  改（coldWindowTurns / coldWindowMaxRows）
packages/ui/src/v4/
  SessionPane.tsx                                          改（新增 viewOnly prop，非 readOnly）
  ConversationComposer.tsx                                 改（**加外部 placeholder 入参；不得传 disabled**）
  conversationProjectionStore.ts                           改（viewOnly 态 + 日志）
apps/zcode-cli/packages/bootstrap/scripts/
  test-cold-open-window.mjs                                新增
```

**不动的**：`format-proof` 的裁决表（本树没有 `formal-proof-consistency` 黄金测试，`model.ts:104-121` 也不建模 `sessionActionAvailabilitySchema` 的键，加字段不会造成两处不一致）；`openTiming`（`.strict()`）。

## 变更点清单

| # | 不变式 | 文件 | 改动 |
|---|---|---|---|
| 1 | IS8 | ack 顶层 + `transport.ts` | 新增 `openPhases` 顶层键（**不动 `.strict()` 的 `openTiming`**） |
| 2 | IS8 | `scripts/dev/long-session-perf-sample.mjs` | **复用既有 `--out`**（不新增输出选项）；补 ack 顶层键、`runtimeReady` query 与 renderer 侧 `uiViewReadyMs`/`paintAfterApplyMs` 采集 |
| 3 | IS2/IS5 | `adapters/.../repositories/turn-manifest.ts` + 新迁移 | **两张表**读写（`session_turn_manifest` + `session_turn_query_manifest`，后者**只登记 `origin === "realUser"`**），按 `branch_generation` 键控；空分支 `totalCount=0` / `firstRowId=null` |
| 4 | IS5 | `bootstrap/.../session-row-manifest.ts`（新） | `totalCount`/`firstRowId`/`realUserQueryTotal`/`turnDirectory`/rowId base 唯一来源；空分支 `totalCount=0` / `firstRowId=null` |
| 4b | IS5 | `packages/shared/.../delta.ts` | `row.removed` 增加 `totalCount`/`firstRowId`（additive，非 strict） |
| 4c | IS5 | `packages/shared/src/zcode-protocol-v4/apply.ts:91-110` + `applyConversationDeltaMutable:171-189`（**同一文件**） | **两份实现同步**读权威 `totalCount`/`firstRowId`，不再用「窗口内 removed 累减」；`packages/shared/test/apply.test.ts` 同步 |
| 5 | IS5 | `conversation-topic-publisher.ts:346-376,538-618` | 全序量改走 manifest，不再全量行现算 |
| 6 | IS1 | `product-projection.ts:437,5140-5152`、`shared/.../apply.ts:101-103` | **废除跨 turn 的全局 `nextRowId++`**：turn 起始 base 由 manifest 给出（live 与 cold 同一函数），rewind 后新 turn 复用被截 turn 的 base、不再有空洞；`apply.ts:101-103` 的旧注释与 `apply.test.ts` 同步更新 |
| 7 | IS2 | `messages.ts` | 新增 `listSessionMessageIndex`（**复刻** `order by sequence is null, sequence, time_created, rowid`；**message 表无 role 列**，不读 `data`）；part 侧同样复刻 `:240` 的序 |
| 7b | IS2 | `contracts/src/interfaces/session-store.port.ts:1068` | 新增 `listSessionMessageIndex` / `readActiveBranchTail` / manifest 读写的端口声明 |
| 8 | IS2 | `contracts/src/rewind/index.ts:165-204` | 裁断输入放宽为「id 序 + 可选正文映射」 |
| 9 | IS2 | `cold-event-merge.ts:545-634,84-90` | `messageId→turnId` 改走 manifest；`sharedContextImport` 改由索引给 id |
| 10 | IS1/IS2 | `messages.ts` | 新增 `readActiveBranchTail({sessionId, activeMessageIds, limitBefore})`（分支感知 + 两段查询） |
| 11 | IS1 | `transcript-hydration.ts:1349,1379,1397-1414,1620-1659,1663-1665` | 注入 `initialTurnNumber`/`initialModelKey`/`preface`；复用 `baseTimestampMs` |
| 12 | IS1 | `core.ts:75-76` | 新增 `coldWindowTurns = 8` |
| 13 | IS3 | `v4-gateway.ts:2926-2949` + 18 处 `readyFlights` | 拆 `viewReadyFlights` / `runtimeReadyFlights` |
| 14 | IS4 | `v4-gateway.ts:3306-3308` + 11 处 `sessionExists` | `conversationState` 只判 live/notLive（自身保留 `host.sessionExists`），新增 `viewReadySessions` 承担 viewOnly vs absent；11 处直判逐个归位 |
| 15 | IS3 | `server-operations.ts:1490-1498` | `materializeSessionShell` / `activateRuntime` 拆分；首屏 model 空态 |
| 16 | IS3 | `v4-bridge.ts:1738-1871` | store-only 变体（**不调 `resolveConversationBackingRecord`**） |
| 17 | IS6 | `v4-gateway.ts:1608-1624`（gateway 侧异步物化）+ `publisher.ts:476-498`（只改 `hasMore` 口径） | 按需物化在 gateway 完成（publisher 的 `getRowsRange` 是同步方法、无 store）；冷路径不复触发完整冷开 |
| 18 | IS3/IS8 | `snapshot.ts:149-166` + `getWireSnapshotForProfile` | additive `sessionRuntime`（schema 上 `.default("live")`，**在网关边界注入**，不污染 `computeAvailability` 的纯函数性）；`canStop:false` 表示 view-only（**不新增 stop 维度**） |
| 19 | IS3 | `SessionPane.tsx:220,457,3395,3464`、`ConversationComposer.tsx:342-374` | 新增 `viewOnly`（只禁 edit/fork/retry/rewind）；**composer 保持可用**（唯一激活入口）+ 新增外部 placeholder 入参 |
| 20 | IS3 | `v4-gateway.ts:2962` | 升级前 `hydratedSessions.delete()`（`forceRebuild` 现被早退挡住） |
| 21 | IS7 | `core/src/runtime/types.ts:268-279`、`resume.ts:147-156`、`turn.ts:194-205` | `historyMode:"none"`；eager context init 移到 turn；闸门在 init 之后 |
| 22 | IS1 | `bootstrap/scripts/test-cold-open-window.mjs`（新） | 身份一致性 + 翻页 + 视图降级回归 |

## 详细实现步骤

- Step 1 — phase-0-baseline — blocking: yes — qa: auto：ack 顶层 `openPhases` + `conversation/runtimeReady` 通道；采集脚本升级；同基线跑四路径 ×3，落 `baseline.json`。
- Step 2 — phase-row-manifest — blocking: yes — qa: auto：**两张表**结构（query 表只登记 `origin === "realUser"`）+ 迁移 + 终态写入（`onTurnComplete` 与 `onTurnError` 两处都挂，调用方挂在 `v4-gateway.ts:967` 的 ingest）；`projection_schema_version` / `row_count_source`；`branch_generation` 状态字段与 rewind 时的 manifest 截断/复制；空分支 `totalCount=0`/`firstRowId=null`；账目修正 + `manifestAdjusted` 打点。
- Step 3 — phase-row-manifest — blocking: yes — qa: auto：`listSessionMessageIndex`（复刻权威序）；`selectActiveConversationBranch` 输入放宽，**双路等价测试**（全量 vs 索引，覆盖 target 不在窗 / cut 不在窗 / `keptMessageIDs` 缺失）。
- Step 4 — phase-row-manifest — blocking: yes — qa: auto：`session-row-manifest.ts`；`totalCount`/`firstRowId`/`turnDirectory`/`realUserQueryTotal` 改由它提供；**废除跨 turn 的全局 `nextRowId++`**，turn 起始 base 由 manifest 给出（live 与 cold 同一函数）。
- Step 5 — phase-paged-materialization — blocking: yes — qa: auto：`readActiveBranchTail`（分支感知 + 两段查询）；`coldWindowTurns` 常量；对 5k 消息会话测读放大比。
- Step 6 — phase-paged-materialization — blocking: yes — qa: auto：合成器注入非零起点上下文（复用 `baseTimestampMs`）；断言窗口化 vs 全量 `turnId`/`createdAt`/`ModelSelected` 逐值相等。
- Step 7 — phase-paged-materialization — blocking: yes — qa: auto：按需物化的执行缝落在 **gateway 侧**（`rowsRange` 入口按 manifest 定位缺失 turn → 异步读正文 → 临时投影合成页 → 交 publisher 编码）；publisher 侧只把 `hasMore` 改成按 manifest 的 `firstRowId` 判定；断言与全量物化逐值相等。
- Step 8 — phase-view-runtime-split — blocking: yes — qa: auto：双水位表 + 18 处归位；**激活触发点**（ACK 后后台预激活 + send 类命令 await `runtimeReadyFlights`，composer 不禁用）；`conversationState`（live/notLive）+ `viewReadySessions`（viewOnly/absent）+ 11 处 `sessionExists` 归位。
- Step 9 — phase-view-runtime-split — blocking: yes — qa: auto：`materializeSessionShell`/`activateRuntime` 拆分；`derivePersistedSessionMode` 专用查询；store-only `loadPersistedEvents`（绕开 record 闸门）。
- Step 10 — phase-view-runtime-split — blocking: yes — qa: auto：协议 additive（`sessionRuntime` + `runtimeNotReady`）；UI `viewOnly` + **composer 保持可用（不得传 `disabled`）**+ `canStop:false`。
- Step 11 — phase-view-runtime-split — blocking: yes — qa: auto：`rowsRange` 冷路径不复触发冷开；升级路径改 `hydratedSessions.delete()` 先删。
- Step 12 — phase-lazy-history — blocking: yes — qa: auto：`historyMode`；eager context init 移到 turn；发送闸门在 init **之后**；逐个核对 `resume.ts` 里以全量 messages 为输入的剩余步骤（`turnNumber`/`latestAssistant*`/`mainTurnCacheHitAggregate`/`discardPersistedPendingSteerInputs`/`syncPersistedSessionTitleForResume`）。
- Step 13 — phase-gates — blocking: yes — qa: auto：`test-cold-open-window.mjs` 覆盖 IS1 逐值一致、IS2 两种事故防护、IS6 翻页不漏、IS7 历史完整。
- Step 14 — phase-gates — blocking: no — qa: manual_user：真机四路径 ×3，**验收基准读 renderer 侧 `uiViewReadyMs`（要做首绘再叠加 `paintAfterApplyMs`）**；`openPhases` 只作分解项（`viewReadyMs` 是 CLI 进程内段，不含 host/CLI spawn/RPC/渲染，且各段嵌套不可相加）；**`runtimeReadyMs` 从 `conversation/runtimeReady` query 读**（`openPhases` 是 ACK 帧，不含激活耗时；口径是激活本体耗时，不是从 ACK 起算），对照 `baseline.json` 判 ≤1s / ≤800ms；同时记录「首发送 → 首 token」以暴露 eager init 后移的成本。

## 测试策略

### 测试用例

- T-SL1 — blocking: yes — **IS2 排序复刻**：`listSessionMessageIndex` 的 id 序与 `messages()` 全量读**同序前缀逐条相等**（含 `sequence` 非空、`sequence` 为 NULL、rewind 后空洞三种）。
- T-SL2 — blocking: yes — **IS2 裁断双路等价**：`selectActiveConversationBranch` 在全量与索引输入下结果相同（target 不在窗 / cut 不在窗 / `keptMessageIDs` 缺失）。
- T-SL3 — blocking: yes — **IS2 复活防护**：revert target 落在窗口之外时**不得**返回已回滚分支。
- T-SL4 — blocking: yes — **IS2 清空防护**：cut 在窗口外且无 kept 时**不得**返回空历史。
- T-SL5 — blocking: yes — **IS1 身份一致**：窗口化合成 vs 全量合成，`turnId` 序列、`createdAt`、`ModelSelected` 序列逐值相等。
- T-SL6 — blocking: yes — **IS1 preface 不虚增**：窗首为 assistant 时不额外产生 model-only 轮。
- T-SL7 — blocking: yes — **IS5 manifest 一致**：同一会话「冷开（manifest 快路径）」与「全量物化」的 `totalCount`/`firstRowId`/`turnDirectory`/`realUserQueryTotal` 逐值相等。
- T-SL8 — blocking: yes — **IS5 降级打点**：manifest 缺失/`branch_generation` 不匹配时走全量并置 `manifestFallback: true`。
- T-SL9 — blocking: yes — **IS6 翻页不漏**：`hasOlderRows` 为真时连续 `loadOlder` 到顶（`hasMore` 必须按 manifest 首行判定，**不得**用 `eligible.length > rows.length`，否则按需物化后恒 false），行集合与全量一致；全程**不触发第二次冷开**；深翻页后 `rowId` 仍与全量物化一致。
- T-SL10 — blocking: yes — **IS3 命令闸门 + 激活触发**：①view-only 且 runtime 未就绪时，**非 send 类** `handleCommand` 回 `{status:"rejected", reasonCode:"runtimeNotReady"}`（不是 `executionFailed`）；②**send 类命令不回拒**——它 `await runtimeReadyFlights` 并成功起轮（这是唯一激活入口，也是防死锁的核心断言）；③`queryCommands` 正常返回（不计入 runtime-ready 门槛）。
- T-SL16 — blocking: yes — **IS3 不锁死**：进 view-only 会话后不做任何等待，直接发一条消息，会话必须在超时内升到 runtime-ready 并起轮；且 **`conversation/runtimeReady` query 返回非空 `runtimeReadyMs`**（激活触发点存在性的直接证据）。**不得读 `openPhases.runtimeReadyMs`**——那是 ACK 帧字段，而 view-only 的激活发生在 ACK 之后，该键不可能有值。
- T-SL11 — blocking: yes — **IS3 幽灵 runtime 防护 + rowId 衔接**：view-only 会话激活后**不产生第二条 `SessionResumed`**；`hydratedSessions.delete()` 后重建的投影 `revision`/`seq` 对客户端呈现为「继续」，**且升级后全量投影的 rowId 与 view-only 期下发的 rowId 逐值相等**（否则翻页锚点与会话头部会跳）。
- T-SL12 — blocking: yes — **IS4 三态**：`conversationState()` 对 live / notLive 返回预期，`viewReadySessions` 对 viewOnly / absent 返回预期（**组合**断言，同步函数判不出 absent）；源码守卫断言「`conversationState` 函数体**之外**」不存在 `host.sessionExists` 直判（函数体自身必须调它，守卫须排除）。
- T-SL13 — blocking: yes — **IS7 历史完整**：`historyMode:"none"` 下首次发送后，provider 收到的历史与 `"full"` 逐字节相等；且 tail 水化产物不会被 `messageHistory.init()` 清空（本设计下不存在 tail 水化）。
- T-SL14 — blocking: yes — **IS3 首屏降级**：view-only 首屏无 usage / 无 fileChanges 摘要为**预期**；激活后两者补齐。
- T-SL15 — blocking: no — qa: manual_user：真机性能验收（Step 14）。

夹具：T-SL1-8 为纯函数 / 可控 store 单测；T-SL10/11 需要 gateway 级夹具（`V4GatewayHost` 30+ optional 成员），**若夹具成本超预算，降级为 publisher + 抽出纯函数闸门的用例**，并在 Step 13 前确认；T-SL12 为源码守卫（剥离注释后判定）。

## 风险与回滚方案

### 风险

1. **manifest 与投影规则必须严格同构**：`row_count` 是投影的副产物，若投影规则变了而 manifest 未失效，`rowId` 会整体漂移，症状是「翻页错位」而非报错。缓解：manifest 记录投影版本号，版本不匹配即走降级全量。
2. **幽灵 runtime 前科（最高）**：`v4-gateway.ts:1951-1957` 记录过误判 cold 而二次 resume 的事故。三态化后任何残留二态判定都会重演。缓解：IS4 集中 + 源码守卫 + T-SL11/T-SL12。
3. **`sessions.set` 早于 resume 的窗口变宽**：`server-operations.ts:1490` 先入 map，`:1491` 才 resume。拆分后窗口更长，命令侧误等 view-ready 会「对着空历史发 prompt」。缓解：IS3 + T-SL10。
4. **eager context 后移改变首轮体感**：MCP/skill/MEMORY.md 的成本从「打开会话」移到「第一次发送」。这是有意取舍，Step 14 必须同时记录「首发送 → 首 token」，不许把成本藏起来。
5. **`rowId` 语义变更是全仓最贵的改动**：**两份同构实现**都要改——不可变 `apply.ts:91-110` 与可变 `applyConversationDeltaMutable`（`:171-189`，同文件）。两件事必须同时做到：①**废除全局 `nextRowId++`**（否则 rewind 后 live 有空洞、cold 紧凑，两条路径永远对不齐，T-SL7/T-SL11 必红）；②`totalCount` 在 delta 侧仍无解（`removed` 数的是窗口内被删行），因此 `row.removed` 必须携带权威 `totalCount`/`firstRowId`。空 active 分支 `totalCount=0` / `firstRowId=null`，对齐 `apply.test.ts:514-527` 的既有契约。
6. **`openTiming` 的 `.strict()`**：新分段只能放 ack 顶层；若坚持放 `openTiming`，旧客户端整帧解析失败。IS8 已定。
7. **改动面横跨 adapters/contracts/core/bootstrap/shared/ui**：`rowId` 与 manifest 的改动必须按 Step 顺序，且 Step 4 之前不得合并任何依赖 manifest 的 UI 改动。
8. **性能验收在 dev build**（`perfProbe` 与 `__zcodeV4ConversationOpensE2E` 的 renderer 出口都是 dev-only）。验收基准是 renderer 侧 `uiViewReadyMs`（+ `paintAfterApplyMs`）；生产侧只有 CLI 内部分解项（`openPhases`），**不得**拿它判总时长。验收口径必须写明数据来源。
9. **窗口化不会自动消掉的剩余全量读**：每个 subagent child 各全量读一次（`server-operations.ts:1715-1717`）、`buildColdFileChangeSummaries` 8 并发逐 messageId 读 artifact（`cold-file-change-summaries.ts:231-262`）、`restoreWorkspaceCheckpointEntries`/`FileRewindEntries` 各读一遍 eventStore。这些单列，不计入本 spec 收益。
10. **`openTiming.snapshotRowCount` 语义会漂移**（该字段在 `openTiming` 里，**不在** `openPhases`）：`v4-gateway.ts:1481` 今天取的是**投影全量行数**，窗口化后会变成「物化窗口行数」。phase-0 基线对照必须注明这一点，否则会被误读成「优化无效」。
11. **既有测试会碎，须列入回归范围**：`test-turn-directory.mjs:83-90` 用白盒直接改 `rows.totalCount/firstRowId` 并靠全量行喂 `getTurnDirectory`，manifest 成为权威后必须重写该夹具。
12. **本 spec 推翻了前次的 B3 排除**：`docs/apm/memory/20261025-session-open-latency-b1.md:24` 明确记过「B3（首帧不等全量）被排除」。本次依据是后来的「都修吧，根治」兜底授权（`:33`），属**推翻前次决策**，不是「已获授权」——按三态纪律如实登记。

### 回滚

按 phase 独立提交、独立 revert，**逆序回滚**：

- phase-row-manifest **不建议回滚**（它是 IS2/IS5 的防复发基础；回滚会同时撤销 T-SL3/T-SL4 的保护）；
- phase-paged-materialization 回滚 = 恢复全量正文读取，manifest 保留（正确性不受影响，只损失性能）；
- phase-view-runtime-split 回滚 = **必须先回三态再回单表**（否则出现不可达分支）；
- phase-lazy-history 回滚 = `historyMode` 默认 `"full"` 即回现状（字段保留）。
