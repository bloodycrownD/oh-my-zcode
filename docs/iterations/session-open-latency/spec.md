---
date: 2026-10-25
dependency:
  - iterations/optimization-triage-20261025/research.md
---

# session-open-latency 技术规格（SPEC）

## 设计目标

把冷开与中途切换压到 **1s / 800ms 级**，且不靠「看起来快了」。冷开的 1s 是**视图侧**（不含 CLI spawn，spawn 单列观察项），判据见下方 phase-0-baseline 的三档表。

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
| **IS1** | **投影身份确定性（live 与 cold 同一规则）**：`turnId`、`rowId`、`row.createdAt`、`ModelSelected` 序列在任意物化顺序 / 任意窗口起点 / **任意路径（live 或 cold）** 下必须逐值一致。**前提是废除全局 `nextRowId++`**：rowId base 在每个 turn **起始时**由 manifest 给出（= 前序 active turn 的 `row_count` 累加），live 与 cold 走同一函数。这样 rewind 后新 turn 复用被截 turn 的 base，**不再产生空洞**（现状 `:5141` 的 `nextRowId++` 永不回退正是空洞来源）。`createdAtSeq` 由 `event.sequenceNumber` 派生（`:5150`），窗口化后全局序号不同，**不参与比较**。**成立条件见下方「IS1 的强制条件」（Step 7 收紧）** |
| **IS2** | 分支裁断、文件摘要、用量统计永远基于**全序**信息（正文可窗口，id 必须全序）；窗口 = **active 分支的后缀**，不是原始序后缀 |
| **IS3** | 命令只能在 **runtime-ready** 之后执行；view-ready 只放行读与翻页，但 **send 类命令是激活触发器**（见决策表） |
| **IS4** | `hasLiveConversation` 三态（live / viewOnly / absent），且 `v4-gateway.ts` 内**不得残留 `sessionExists` 直判**：`:705,1099,2002,2039,2065,2111,2164,2208,2828,2996,3307` 11 处须逐个归位。**实现方式**：保留同步的 `conversationState`（只判 live / notLive，它本身必须调 `host.sessionExists`），viewOnly vs absent 由视图水化结果落一个 gateway 侧 `viewReadySessions` 集合承担（absent 只能由一次异步 store 读得知，同步函数判不出来） |
| **IS5** | `totalCount` / `firstRowId` / `realUserQueryTotal` / `turnDirectory` 与每个 turn 的 rowId base **只来自 manifest 两张表**，禁止由 `rows.window` 现算、禁止为此读全量 parts。**范围与 IS1 一致**：manifest 对 live 与冷投影**都是权威**（rowId base 与计数同源），因此 live 也不能再用全局 `nextRowId++` |
| **IS6** | `rows/range` 必须能在**未物化**的页上工作（按需物化），且不重复触发冷开 |
| **IS7** | 运行时历史未全量水化前禁止发 turn；闸门必须在 `ensureContextInitialized` **之后** |
| **IS8** | `openTiming` 不改（`.strict()`）；新分段放 ack 顶层新键 |

### IS1 的强制条件（Step 7 收紧，必须与表格一起读）

「任意物化顺序 / 任意窗口起点 / 任意路径逐值一致」在窗口化之后**不能无条件成立**。Step 6 给了两处
反例、Step 7 又查出一处，因此 IS1 的准确表述是下面三条条件同时成立时才全量成立：

1. **`rowId` 稳定只在「manifest 可用」时恒真**。manifest 不可用（missing / schemaMismatch /
   inconsistent / readFailed / 老会话）→ 降级全量物化，`rowIdOrigin` 回到 1，**窗口期已下发给客户端的
   rowId 会整体平移一次**。兜底只有三条：①不写坏数据（全量物化永远是对的）；②打点可见
   （`manifestFallback` + `getRowManifestOutcome`）；③客户端的 `logEpoch` 陈旧读丢弃只能挡住跨进程，
   挡不住同进程重排——所以这条**是已知的一次性跳变**，不是「不会发生」。客户端侧唯一的缓解是
   `loadOlder` 的在途游标校验（`current.rows.window[0].rowId !== beforeRowId` → 结果作废），
   它会把跳变变成「这一页白拉」而不是「锚点错位」。
2. **live 与 cold 的逐行 `rowId` 一致只在「无迟到行」时成立**。Step 6 的按 `turnId` 归户让
   `Σ row_count === rows.length` 且两侧**计数**一致，但迟到行（锚在历史轮的 goal verification 等）
   在 live 里物理追加在**尾部**、在 cold 里落在**锚定轮内**：该轮之后每一行的 rowId 两条路径必然分叉，
   append-only 无回填手段。因此翻页读**只认 manifest 的 base（cold 口径）**，不得复用 live 已发出的
   rowId；含迟到行的会话上 IS1 退化为「计数一致 + 逐页自洽」，**不承诺 live 期与冷开期的逐行 rowId 相等**。
3. **`createdAtSeq` 不参与任何比较**（全局序号在窗口化后不同），`row.createdAt` 只由
   `baseTimestampMs`（整条分支首条消息）派生。
4. **窗口 / 页必须同时播种「rowId 起点」与「上一轮模型基线」**（Step 7 补）。`modelChange` marker
   是 TurnStarted 时按「上一轮模型 vs 本轮 config」落的一行，只喂尾部轮时投影没有上一轮 → 切换轮少一行、
   其后 rowId 整体前移。两个播种点是同一个时机（候选投影建好、首次 ingest 之前）。

## 总体方案

六阶段，顺序有硬依赖：**manifest 先行**（IS5 的唯一来源）→ 分页物化 → 拆看/跑 → 懒历史 → 门禁。

### phase-0-baseline

- 在同基线（HEAD 含 v1.0.27 补丁）实测三路径（冷开 5k 消息会话 / 冷开小会话 / 热切换 / 深翻页到底），落 `docs/iterations/session-open-latency/baseline.json`。
- **验收基准（2026-10-25 cr-func 两轮矫正：按场景分三档，以后以此为准）**：验收量是 **renderer 侧 `uiViewReadyMs`**（= `connect 入口 → snapshot 应用完成`，renderer 单调时钟）；要覆盖到首绘再加 `paintAfterApplyMs`（2×`requestAnimationFrame`，`uiViewReadyMs + paintAfterApplyMs` 才是体感总量）。两者由 `conversationProjectionStore` 回填进 `__zcodeV4ConversationOpensE2E` 的 ACK 样本。

  | 场景 | 判据 | 依据 |
  |---|---|---|
  | **冷开**（CLI 未起） | **主判** `uiViewReadyMs − openTiming.hostPrepareMs ≤ 1s`（可算）；**并列分解项** `uiViewReadyMs − openTiming.cliBootstrapMs`（`cliBootstrapMs` 修正后才有值）；总量（含 spawn）作观察项 `≤2.5~3s` | `hostPrepareMs` 量的是 `subscribe 入口 → cliRequest 发起`，**必然覆盖** spawn，且实测两档区分度足够（冷开 1578~1776ms / 热开 runtime-live 2~3ms）。`cliBootstrapMs` 在旧实现下结构性缺席且恒记 `reused`（见下条「判据变更理由」），不能单独承担主判 |
  | **热开**（CLI 已起、会话冷） | `uiViewReadyMs ≤ 800ms` | 同会话 CLI 热时重开实测 0.4–0.7s，800ms 留余量；此时 `cliBootstrapMs` 缺席（`cliProcessState === "reused"`），无需相减。**注意该档必须再按「CLI runtime 是否仍持有该会话」分 regime**：runtime live 133~225ms，未持有则 4~10s（见 baseline `findings.cliRuntimeResidencyDominates`） |
  | **切回**（已打开 / keep-warm） | **不发生 subscribe，`uiViewReadyMs` 没有生产者** → 不适用于该指标；单列「内存态切回」观察项（`SessionDataLayer.acquire` → 首绘 paint，参考 ≤150ms），或在 baseline 里显式标注豁免 | 该量只在 subscribe 路径上产生样本；keep-warm 命中时 `acquire` 直接复用 store（`sessionDataLayer.ts:76-82`），没有 ACK。脚本的判法是**断言切回后 ACK 环里没有该 topic 的新样本**，并采 click→pane 绑定耗时（`--path switchback`） |

  **判据变更理由（2026-10-25 C3，必须保留在 spec 里）**：原冷开判据是 `uiViewReadyMs − openTiming.cliBootstrapMs ≤ 1s`，但**在本树不可计算**——`zcodeAgentService.subscribeConversationV4` 用 `processManager.getExistingClient(params)` 的返回是否非空判 `cliProcessState`，而侧栏任务列表会为渲染列表**预建 client 对象**（进程尚未 spawn）。于是「本次 subscribe 才把进程拉起来」的冷开也被记成 `reused`：spawn 成本（实测 1578~1776ms）落进 `hostPrepareMs`，`cliBootstrapMs` 三次冷开全部缺席。**修法分两半**：①观测层改诚实——判据改为 acquire 前后的**进程事实差**（`startedAt` / `generation` / 在途启动标记，见 `packages/services/src/zcode-agent/cliBootstrapObservation.ts`），`spawned` 的定义是「本次 subscribe 触发或等待了 spawn」；②spec 判据给出可算退路——主判用 `hostPrepareMs`（它本来就覆盖 spawn），`cliBootstrapMs` 修正后作为分解项并列。**两条都要写进终验报告**：主判是否达标 + spawn 分段数值。

**并发 spawn 的既定口径（实测踩到，必须写清）**：若某 workspace 的 spawn 由**另一个并发调用**（例如启动恢复时对同 workspace 另一条会话的 subscribe）在本次 subscribe 进入前几毫秒发起，本次 acquire 记 `reused`（它没有触发 spawn），但它的 `hostPrepareMs` 仍包含等待该次 spawn 完成/就绪的成本（实测 1529ms）。这不是判据漏洞：`reused` 只否定「本次触发」，不否定「本次付出等待」——所以冷开主判必须用 `hostPrepareMs`。采样脚本对 `--path cold` 的处置是：`cliProcessState !== "spawned"` 时置 `verdict = "precondition-violated"` 并退出码 8，**不把含 spawn 等待的样本混进冷开中位数**。

  **把单一「冷开 ≤1s」挂在 `uiViewReadyMs` 上是自设的不可能门槛**：该量含 CLI spawn，而冷启 spawn 一项就超过 1s，按定义不可达；冷开必须减掉 spawn 侧成本才是视图侧口径。减 `cliBootstrapMs` 是精确口径（修正后可用），减 `hostPrepareMs` 是**可算且更宽松**的口径（把 provider 同步 / task meta 读也一并减掉，只会让视图侧数值更小、判据更难通过）。
  - **`openPhases` 降级为分解项**：`viewReadyMs` 是 **CLI 进程内**的视图就绪段（起点 `subscribeReserved`、终点 ACK 组装），**不含** `openTiming.cliBootstrapMs`（冷开新 spawn CLI）、`hostPrepareMs`、`cliRequestMs`、ACK 后的首帧传输、`rendererSnapshotApplyMs` 与 React commit + paint，冷开下系统性偏短，**不得**再用它判 ≤1s。
- **口径硬约束**（写进 schema / 脚本 / 验收三处）：①`viewReadyMs` = CLI 内部视图就绪段，不含上述任一段；②各段**嵌套不可相加**（`viewReadyMs ⊇ initialFrameEncodeMs`，`viewReadyMs ⊃ mergeMs + rehydrateMs`，阶段 0 里它**还** ⊇ runtime 激活本体；`openTiming.hostPrepareMs ⊇ cliBootstrapMs + providerRegistrySyncMs + taskMetaReadMs`，见 `zcodeAgentService.ts:4407-4477`——`hostPrepareMs` 量的是 `subscribe 入口 → cliRequest 发起`，这三段全在它内部，相加即重复计数）；③`manifestMs` / `materializeMs` 本阶段恒缺席，热切换下 `mergeMs` / `rehydrateMs` 也会缺席——**缺席 ≠ 0**，禁止补 0 求「各段之和」；④`cliBootstrapMs` 的语义是「**本次 subscribe 触发或等待进程 spawn 的等待耗时**」，不是「本 workspace 有没有 client 对象」——后者由任务列表预建，与进程生死无关；⑤`paintAfterApplyMs` 缺席时必须带原因（`paint_missing=closed|generation_changed`），没有原因的缺席不得当作「rAF 还没跑」继续等。
- **两个必须写进 baseline 的口径陷阱**（否则数字会被误读）：
  - `uiViewReadyMs` 的起点是 `SessionDataLayer.acquire`，而 acquire 在 `useEffect` 里（`sessionDataLayer.ts:70-89` → `SessionPane.tsx:1811-1816`），**比用户点击晚一个 React commit**——它天然不含「点击 → 提交」那一段，不能当完整点击延迟。
  - 重试代际**只记最后一次**：`conversationProjectionStore.ts:625,688` 的重入不传 `rendererPrepareStartedAt`，起点被重置为最后一次 connect 的时刻。**一次带 runtime recycle 的冷开在 baseline 里会显得很快**，采样时必须能从报告里看出是否发生过重试。
- **`runtimeReadyMs` 口径钉死为「激活本体耗时」**（`coldResume.ensureResumed` 的耗时），**不是**「从 ACK 起算」：阶段 0 激活在 ACK **之前**（按 ACK 起算会是负数），阶段 8 拆开后激活在 ACK **之后**（按 ACK 起算会掺入等待）。只有本体耗时能跨阶段比较。
- **分段观测通道（IS8）**：不动 `openTiming`（`.strict()`）。新增 ack 顶层键 `openPhases: { viewReadyMs, manifestMs, materializeMs, mergeMs, rehydrateMs }`——**不含 `runtimeReadyMs`**（view-only 的激活发生在 ACK 之后，ACK 帧里不可能有该值；它由 `conversation/runtimeReady` query 提供）；`mergeMs`/`rehydrateMs` 的产生点在 `performHydration`（`:2989-3185`）内部，由 gateway 侧变量回传，锚点不是 `:1443-1445`。
- **runtimeReady 的观测通道（二选一已定：走 query）**：view-only 下 runtime 激活发生在 ACK 之后，故新增 `conversation/runtimeReady` query 回传该值，Step 14 从它读。已知代价：该 query 要穿 5 层管道——`transport.ts:335` V4_METHODS → `server.ts:507` case → gateway → `zcodeAgent.ts:880` → `zcodeAgentService.ts:4719` → `zcodeAgentConnectionScope.ts:736` → `agentConversationTransport.ts:337`；这 7 处都要改，列进 Step 1。（**不再并列「写 `session.resume_completed` 日志字段」方案**——两套通道并存会出现双源不一致。）
- 采集脚本：`scripts/dev/long-session-perf-sample.mjs` 原本只消费 `window.__zcodePerfProbe`（`:291-308,685-693`）；`--out` **是既有参数，直接复用**（不要新增第二个输出选项），需补的是 ack 顶层键、`runtimeReady` query 与 renderer 侧 `uiViewReadyMs`/`paintAfterApplyMs` 的采集，示例：`--out docs/iterations/session-open-latency/baseline.json`。
  - **按目标会话取样本（cr-func N2）**：ACK 样本必须按目标 topic 取（topic = `conversation/<sessionId>`），不得取环形缓冲最后一条（那可能是侧 pane / 子代理 topic）。目标来源：`--session <id>` 显式指定优先，缺省取采样时间线所属 pane 的 `data-session-id`（`SessionPane.tsx:3541`）。
  - **缺验收指标必须非零退出（cr-func N2）**：目标样本的 `renderer.uiViewReadyMs` 缺席、观测面未挂载、或没有目标 ACK 时，报告照写并置 `openProbe.acceptance.verdict = "missing"`，退出码 **8**（= 采到但缺验收指标），与跑挂（`4` launch / `5` target / `6` 观测面未挂载 / `7` CDP）、用法错误（`2`）和**驱动动作失败（`9`：点不到任务行 / 等 ACK 超时 / 切回产生了新 ACK / 冷开前置不成立）** 区分；`3` 已被「dev server 不可达」占用，不复用。脚本只判「有没有采到」；三档阈值判定仍以本节表格为准。
  - **脚本必须自足（2026-10-25 C3）**：phase-0 的四路径是靠**外部临时 CDP 脚本**点 `[data-testid="task-item-<sessionId>"]` 驱动的，那份脚本没入库 → 基线不可复核。现要求 `--path cold|warm|reopen|switchback` 做成一等公民：脚本自己打开指定会话 / 切走再重开 / 切走再切回，`--iterations N` 跑 N 轮，并在**每轮采前**调 `__zcodeV4ConversationOpensE2E.reset()`（同时清 ACK 环与 `paintMissing`）。「关闭会话」= 点另一个会话（旧 pane 卸载、store 进 keep-warm），**不新造关闭入口**；warm/reopen 必须等 `SESSION_DATA_LAYER_KEEP_WARM_MS`（30s，`sessionDataLayer.ts:28`）过期，否则不会有新 ACK。
  - **目标选择器不许硬编码产品名（C3）**：旧脚本按 `title === "ZCode"` 找 page target，而本树 `renderer/index.html` 的 title 与 `productName` 都是 `omz`，原样跑必然退出码 5（phase-0 靠临时改 `document.title` 绕过）。判据改为「`type === "page"` 且 URL 指向 renderer」：http(s) 时与 dev server 同端口且两边都是 loopback，或 `file://…/index.html`。
  - **可见性必须固化（C3）**：Chromium 把被遮挡的窗口判 hidden，rAF 降频/夹到 1s（同一次打开的 `paintAfterApplyMs` 实测 93827ms vs 429~461ms）。脚本在**每个采样窗口前**执行 `Emulation.setFocusEmulationEnabled(true)` + `Page.bringToFront` + `Page.setWebLifecycleState("active")`，并在样本里记 `visibility`；采样期仍非 visible 的样本标 `contaminated: true`，判读中位数时必须剔除，而不是让它污染结果。
  - **首绘缺席必须有原因（C3）**：`scheduleOpenPaintSample` 的两个丢弃分支（`closed` / `generation_changed`）过去直接 `return`，基线里 5/9 次 `paintAfterApplyMs` 无声缺席（「重开 3 次全缺」）。现要求在观测面写 `paintMissing[topic] = { reason, at }`，采样报告原样带出 `paintMissing.reason`；新 ACK 覆盖该 topic 时清空（上一代的缺席原因不能算到新一代头上）。因此「`uiViewReadyMs + paintAfterApplyMs` 凑不齐」只会在**有明确原因**时出现。

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

#### Step 2 落地说明（实现后回填，Step 3+ 直接按此接）

| 事项 | 落地形态 | Step 3+ 必须遵守 |
|---|---|---|
| 表与迁移 | `adapters/.../migrations/0023-session-turn-manifest.ts`（`0023_session_turn_manifest`），两张表 + 3 个索引；**不加 session FK**（detached live child 有 turn 但无 session 行，`pragma foreign_keys=on` 会把合法写入挡掉） | 消息索引（Step 3）与 `session-row-manifest.ts`（Step 4）只读这两张表，不得另建缓存表 |
| 写入口 | `contracts` 的 `TurnManifestStorePort`（`session-store.port.ts`，`SessionStorePort.turnManifest?` 可选）；仓储 `repositories/turn-manifest.ts` | 读端经同一个可选端口；缺席 = 降级全量物化，**不得**当成空分支 |
| 写入路径拆分 | `ProductProjection.getTurnManifestEntry(event)` 只**派生**（纯 reducer，无 store），gateway 在 `ingestNormalizedEvent` 与 hydration 的 buffer 补回环里各自 `recordTurnManifest`（detached）。两个终态点（`turn_complete` / `turn_error`）在投影内是同一份「行已定稿」状态，故用事件类型闸门而不是两个调用点 | 不得在投影内直连 store；新增写入点必须同时补这两条 ingest 路径，否则 hydration 窗口内结束的 turn 会缺席 |
| 只登记 realUser | query 行由 `buildTurnManifestEntry`（`turn-manifest-entry.ts`）从同 turn 行派生，`origin !== "realUser"` 只计 `row_count` 不成条 | 目录只读 query 表，不得再扫投影行 |
| preview 口径 | `turnDirectoryPreview` / `turnDirectoryAssistantPreviewKind` 是该口径的**唯一实现**，`getTurnDirectory` 与 manifest 共用（原先 publisher 内的私有实现已外移） | 改 220 字 / 2 段预算只改这一处，否则 T-SL7 必红 |
| query 级 `row_count` | 定义为**分段行数**：从该 query 行（含）到下一个 realUser query 行（不含）或 turn 末尾；turnHeader 不属于任何分段 | 翻页按 `query_row_id + row_count` 定位时按此定义 |
| `projection_schema_version` | 常量在 `bootstrap/.../turn-manifest-entry.ts`（`TURN_MANIFEST_PROJECTION_SCHEMA_VERSION = 1`），仓储只当不透明整数存 | 投影规则一变必须 +1；读端拿 `schemaMismatch` 即整表重建 |
| 代次 | `ProductProjection.branchGeneration` 常驻字段（事件 rewind 时 `max` 进位、`clone/adopt` 一并搬运、`seedBranchGeneration` 只升不降，种子来自 `loadPersistedEvents` 的 `branchGeneration`） | 任何新增的投影 clone/adopt 路径必须搬这个字段（漏搬 = rewind 的 +1 静默丢失） |
| rewind 重写 | `rewriteTurnManifestBranch({ branchGeneration, sourceGeneration, keptTurnIds })`：按给定顺序重排 ordinal、`row_count` 不重算、成功后清掉更早代次；源代次缺任一保留 turn → `applied:false`（目标代次保持缺失） | 读端把 `applied:false` 与 `missing` 同等对待（降级全量物化 + 重建） |
| 空分支 | 完全 rewind 掉的分支在存储里没有行 → 读作 `missing`，由降级路径全量物化（成本本来就是一次空读）；`totalCount=0 / firstRowId=null` 由 `deriveTurnManifestTotals` 统一保证（manifest 快路径与重建路径共用） | 不得为「空分支」另加标记行，也不得把 totalCount 改估算 |
| 账目修正 | `readTurnManifest({ observedRowCounts })` 就地改不一致的 `row_count` 并回 `manifestAdjusted` + `adjustedTurnIds`；幂等（第二次不再修正）；后续 turn 的 base 因累加自动平移 | `manifestAdjusted` 的打点落在 Step 4 的读取调用处（Step 2 无读路径） |

#### Step 3 落地说明（实现后回填，Step 4+ 直接按此接）

| 事项 | 落地形态 | Step 4+ 必须遵守 |
|---|---|---|
| 索引读面 | `adapters/.../repositories/messages.ts` 的 `listSessionMessageIndex({ sessionID })`；端口 `SessionStorePort.listSessionMessageIndex?`（**可选**，缺席 = 降级全量 `messages()`，不得当空会话） | 只吃这一个入口，不另写 SQL；读端不得回退成 `messages()` 除非端口缺席 |
| 读哪些列 | 只 `select id, sequence, time_created, rowid as storage_row_id`（窄行类型 `MessageIndexRow` **没有 data 列**，类型上就退不回正文读）；条目形状 `{ id, sequence, timeCreated, storageRowId }`，`storageRowId` **不是**投影 rowId。实测（`:memory:`，5000 消息 / 20000 part × 1200B）：索引读 **6.8ms** vs `messages()` 全量 **131.7ms**（≈19×），是 Step 5 读放大比的分母基线（不是 phase-0 基线） | 不得 `select *` / 读 `data`（role 在 data JSON 里）；门禁 `test-session-message-index.mjs` A4/A5 是形状守卫 |
| 排序 | 逐字复刻 `messages()` 的 `order by sequence is null, sequence, time_created, rowid`（`sequence is null` 的 0/1 让 NULL 行排在**非空之后**；`time_created`/`rowid` 两个 tiebreaker 不能省）。形状守卫直接比对两段 SQL 的 ORDER BY 子串 | 改序只能同时改两处，否则 A4 红 |
| part 侧 | 本步**不做**：part 权威序（`order by message_id, sequence is null, sequence, time_created, id`）随 Step 5 的两段查询一次落在 `readActiveBranchTail` | Step 5 必须复刻该序，且与 message 段同一事务窗口 |
| 裁断规则 | 唯一实现 `selectActiveConversationBranchIds(orderedMessageIds, options)`（contracts/rewind）；`selectActiveConversationBranch(items, options)` 只做「id 序 → 条目」映射，新增可选 `getMessageId` 访问器（索引条目没有 `info`）。既有 6 个调用点零改动（默认访问器读 `{ info: { id } }`） | **不得**再写第二份分支判断；任何路径（resume / cold / fork / 索引）都规约到 id 核心 |
| 双路等价 | `adapters/scripts/test-session-message-index.mjs`（`test:session-message-index`）覆盖 T-SL1 + T-SL2 的 Step 3 部分：排序复刻（NULL/撞号/同时间/rewind 空洞/跨会话隔离）+ 10 组双路等价（target 在/不在、cut 在/不在、kept 混入不存在的 id、kept+created、只喂窗口） | 新增裁断分支必须补一组双路用例 |
| 未登记 turn 检测 | `readTurnManifest` 新增两个**可选**观察输入：`observedMessageIds`（`listSessionMessageIndex` 的 id）与 `observedTurnIds`（调用方的权威 turn：投影或 durable 事件）。返回新状态 `{ status: "inconsistent", reason }`，reason ∈ `ordinalGap` / `unregisteredTurns` / `messageIndexMismatch` → **整表重建**，且**先于**账目修正 | 读端（Step 4）必须把索引 id 传进 `observedMessageIds`；`observedTurnIds` 是抓「尾部丢轮」的唯一手段——**消息索引没有 turn 维度**，索引只能查「manifest 指向已不存在的消息」 |
| 缺项 vs 修正 | `ordinalGap` 由 manifest 自身判出（写入口的 ordinal 恒连续，空洞 = detached 写入丢失）；`unregisteredTurns` 需要外部 turn 观察；`messageIndexMismatch` 只诊断前 20 条 messageId | `inconsistent` 与 `missing`/`schemaMismatch` 同等对待：降级全量物化 + 重建 manifest（`manifestFallback` 打点带 reason） |
| 性能遗留 | `ProductProjection.getTurnManifestEntry` 的终态派生仍是「从 rows 头扫到本 turn」（O(rows)/次，累计 O(turns×rows)）。实测 5k 行 / 500 轮：整会话累计 20ms、单次平均 40µs（最后一轮最坏 77µs，含 Set 分配），且只在**终态事件**上发生（非终态在入口早退） | 优化**推给 Step 4**：rowId base 的累加本来就需要「turn 序 + 每轮行数」这份状态，届时用一份 `turnIds` 序 + `firstRowIndex` 索引同时服务 base 与 ordinal，并**必须**同步进 `cloneProjection`/`adoptProjection`（漏搬 = base/ordinal 静默漂移）；本步不新增第二份状态 |

#### Step 4 落地说明（实现后回填，Step 5+ 直接按此接）

| 事项 | 落地形态 | Step 5+ 必须遵守 |
|---|---|---|
| 读路径模块 | `bootstrap/.../session-row-manifest.ts`：`deriveSessionRowManifestFacts(snapshot)` 把 manifest 快照翻成 `{ totalCount, firstRowId, realUserQueryTotal, entries, rowIdBaseByTurnId, turnIdByMessageId, turnCount }`；`selectManifestTurnDirectory(facts, params)` 实现目录三条硬定义；`createSessionRowManifestReader({ store })` 收敛 store 读与降级判定 | 只吃这一个模块，不另算全序量；计数**不重算**（仓储的 `deriveTurnManifestTotals` 是唯一实现，读端只透传） |
| 读端调用方 | `v4-gateway.hydrateRowManifest`（`performHydration` 收口处、`hydratedSessions.add` 之前）。传 `observedTurnIds` = 投影 active turn 序、`observedRowCounts` = 投影连续块行数、`fullyMaterialized: true`；`ok` → `publisher.seedRowManifestFacts(facts)`，`fallback` → 回写整代 cold manifest | Step 5 的窗口化物化把 `fullyMaterialized` 改成 `false`（否则「manifest 比窗口长」会被判成不一致）；届时 `observedTurnIds` 只能是窗口内 turn，抓不到尾部丢轮 |
| 降级判定 | 唯一入口 `decideRowManifestAction(outcome)`：`manifest` → use-manifest；`missing` / `schemaMismatch` / `inconsistent` / `portAbsent` / `readFailed` → **同一个动作** `materialize-and-rebuild`。`readFailed` 也归进去是刻意的：重建幂等，而「读不到就当空分支」会让全序归零 | 不得按原因各写一条分支；新增降级原因必须并进同一动作 |
| 回写重建 | `rebuildRowManifestFromProjection`：全量物化的每一轮以 `rowCountSource: "cold"` 逐条 upsert，再 `rewriteTurnManifestBranch({sourceGeneration === branchGeneration, keptTurnIds})` **剪掉**投影里不存在的尾部 ordinal（不剪会「清单比投影长」→ 反复降级死循环）。`missing` 不剪（没有尾部），`readFailed` 不剪（store 状态未知，剪枝是删除） | 窗口化时 `ordinalBase` 必须从 manifest 已有的 turn 数起，且 `keptTurnIds` 必须是**整条分支**（否则剪枝删掉没物化的头部轮次）。store 侧逐出行为由 `test-turn-manifest-store` E5/E6 锁住 |
| rowId base | 唯一公式 `deriveTurnRowIdBase(priorRowCounts, originBase = 1)`（同时被 live 投影与读端使用）。live 侧 `ProductProjection.turnRowIdBase(turnId)` 按「前序 active turn 的连续块行数」求值并缓存，`getTurnManifestRowIdBase` 暴露；`rowIdOrigin` 是全量投影的首行 id（恒 1），Step 5 用 manifest 给冷窗口首轮播种 | 冷窗口必须 seed `rowIdOrigin = manifest base(窗口首轮)`，否则窗口内 rowId 与全量物化整体平移 |
| 废除全局自增 | `nextRowId` 仍是游标，但**截断（row.removed）后回退到 `rowIdOrigin + 剩余行数`**：被截 turn 的 id 被新 turn 复用，id 集合恒为 `origin..origin+rows-1` 的连续前缀，「rewind 后空洞」消失。分配只用游标——`deriveTurnRowIdBase` 与之在 turn 起始处逐值相等（A3 用例校验，`Math.max(base, cursor)` 这类守卫在该不变量下恒为 no-op，故不留） | 不得再引入第二份 rowId 事实；任何改变行结构的路径都必须走 `syncTurnRowIndexAfterDeltas` |
| turn 行序索引 | 投影新增常驻状态 `activeTurnIds`（首现序）+ `turnFirstRowIndexById`（首行下标）+ `turnRowIdBaseById`（turn 起始 base 缓存），三者**全部**同步进 `cloneProjection`/`adoptProjection`；`row.removed` 走 `rebuildTurnRowIndex`（重建 + 游标回退） | 任何新增投影 clone/adopt 路径漏搬 = base/ordinal 静默漂移；Step 3 的 O(rows) 扫描已消除（`getTurnManifestEntry` 改为 O(turns)+O(本轮行数)） |
| publisher 权威化 | `seedRowManifestFacts(facts)` 后 `totalCount`/`firstRowId`（首帧）、`turnDirectory`/`realUserQueryTotal`、`getRowsRange.hasMore` 全部改由 manifest 提供；**第一条 live ingest 即作废基线**（`ingest` 里 `clearRowManifestFacts`），`rehydrate` 同样作废 | 窗口化落地后 publisher 仍是「冷快照基线」语义：一旦有 live 事件就把权威交回投影，不得让旧清单冒充新事实 |
| 消息索引缓存 | `session-conversation-index.ts` 的 `createSessionMessageIndexCache`（会话 × 一份 promise，最多 16 会话 LRU，失败不留毒）。失效点：**任何 live ingest**（`ingestNormalizedEvent` 无条件调 `host.invalidateRowManifestIndex`，覆盖「新消息落库 / rewind 截断」且不会漏事件类型） | 翻页读必须复用这份缓存（一次冷开只付一次 O(messages)）；不得按事件类型白名单失效 |
| 索引观察 | 两趟读：第一趟只带 turn 观察（便宜），通过后才读索引并把 `observedMessageIds` 传进第二趟。索引端口缺席 → `messageIndexChecked: false`（「没查」可见，不当成通过）；空索引是**有效观察**（消息全没了 = mismatch） | 不得为了省一次读而把两趟合并成「先读索引」——老会话第一次冷开没有清单，那 6.8ms 是白付的 |
| 读端一致性校验 | 契约侧的 `unregisteredTurns` 只判「观察到但没登记」；反方向（登记了但投影没有）只在 `fullyMaterialized: true` 时判（`unobservedTurnIds`），因为窗口化下「manifest 比窗口长」是合法状态 | 窗口化路径必须显式传 `fullyMaterialized: false` |
| schema 版本 | `TURN_MANIFEST_PROJECTION_SCHEMA_VERSION` 升到 **2**（rowId 口径变化 → v1 清单里的 `query_row_id` 是带空洞的旧编号，必须整表重建） | 投影规则再变必须继续 +1 |
| 观测 | `openPhases.manifestMs` 由 `performHydration` 写入（读路径耗时；宿主未实现 `readRowManifest` 时**缺席**，缺席 ≠ 0）；`gateway.getRowManifestOutcome(sessionId)` 给测试/诊断读 `{action, reason, detail}` | 不得把这个分段塞进 `openTiming`（`.strict()`，IS8） |

#### Step 5 落地说明（实现后回填，Step 6+ 直接按此接）

| 事项 | 落地形态 | Step 6+ 必须遵守 |
|---|---|---|
| 尾窗读入口 | `adapters/.../repositories/messages.ts` 的 `readActiveBranchTail({ sessionID, activeMessageIds, limitBefore })`；端口 `SessionStorePort.readActiveBranchTail?`（可选，缺席 = 降级全量 `messages()`，不得当空会话） | 只吃这一个入口；`activeMessageIds` 必须是**全序** active 序（`listSessionMessageIndex` + `selectActiveConversationBranchIds` 的产物），传窗口进去就是 T-SL3/T-SL4 的事故形态 |
| 窗口语义 | `limitBefore` = 窗口**首条** id（含），值来自 manifest；游标不在 active 序里（清单与索引不同步）→ 读整条分支（多读，绝不少读）；重复 id 按首现去重（kept 与 cut 后缀会重叠） | 窗口起点只能来自 `selectColdTailWindow(...).limitBefore`，不得自己按 `time_created` 取 N 条 |
| 两段查询 | message 段 `where session_id = ? and id in (...)`、**不带 order by**（顺序由 active 序下标决定，裁断可给出与 DB 序不同的 kept 序）；part 段只对第 1 段真读到的 id 查，`order by message_id, sequence is null, sequence, time_created, id` 逐字复刻 `messages()`；每段按 500 个 id 分块（SQLite 变量上限 999 的一倍余量） | 改 part 序必须与 `messages()` 同时改；`test-active-branch-tail` B2 是形状守卫（含「part 段不得出现 `or`」——只有行集合不变、时延退化的那类回退靠它抓） |
| 读放大（本步唯一可测收益） | 5k 消息 / 20k part × 1200B（`:memory:`，与 Step 3 A 组同形状）：索引 6.6~11.2ms、全量 `messages()` 199~210ms、尾窗（80 条 / 320 part）3.2~7.5ms → **26~66×** | 这是「冷开正文读」的收益上限；端到端时延收益要等 Step 6/7 接线，**不得**把它写成冷开时延，也不得与 phase-0 基线混用 |
| 双约束常量 | `PROTOCOL_V4_LIMITS.coldWindowTurns = 8` + `coldWindowMaxRows = 400`（与既有 `snapshotTailWindowRows` / `rowsRangeMaxLimit` 同级） | 窗口选择统一走 `selectColdTailWindow`，调用方不得另写一份 |
| 窗口选择（纯函数） | `session-row-manifest.ts` 的 `selectColdTailWindow(snapshot, limits?)`：从尾部按**整 turn** 累加，turn 数 ≤ 8、行数 ≤ 400；**至少返回一轮**（单轮自己就超行上限时仍返回它——返回空窗等于首屏空白，行预算是时延约束不是正确性约束）。返回 `{ ordinal, turnId, rowIdBase, turnCount, rowCount, limitBefore, messageIds }` | `ordinal` → Step 6 的 `initialTurnNumber`；`rowIdBase` → `seedRowIdOrigin`；`limitBefore`/`messageIds` → 尾窗读的游标与 identity |
| rowIdOrigin 播种 | `ProductProjection.seedRowIdOrigin(origin)` + `ConversationTopicPublisher` 透传；**只允许在没有任何行时**调用（播种后再改 origin 会让同一逻辑位置算出两个 id，故直接抛错而非静默忽略）。全量物化不调用，默认恒 1 | Step 6/7 在建投影后、首次 ingest 前调用，值取 `rowIdBase`；任何新增的投影 clone/adopt 路径都要搬 `rowIdOrigin`（已在 Step 4 的搬运清单里） |
| 本步**未接线**的三项 | ①`rowIdOrigin` 的生产值 ②降级回写的 `ordinalBase > 0` ③读路径 `fullyMaterialized: false`。三者都只在**窗口真的喂进投影之后**才有意义：窗口化同时改变 turnId 起点（Step 6 的 `initialTurnNumber`）、ordinal 起点（manifest 已有的 turn 数）与 turn 集合（窗口内）；在此之前把 `fullyMaterialized` 改成 false 只会白丢 Step 4 的反向集合校验 | Step 6 接线时：`rebuildRowManifestFromProjection` 的 `keptTurnIds` **必须传整条分支**（manifest 的 turn 序），不能用窗口投影的 `activeTurnIds`——否则剪枝会把没物化的头部真实轮次删掉 |
| T-SL3 / T-SL4 | `test-active-branch-tail` D1/D2：同一份裁断选项下，全序 → 正确分支（非空），窗口 → 原样返回窗口（复活旧分支）/ `kept` 为空（清空历史）；尾窗读只吃全序裁断的结果 | Step 13 的端到端版本（真 store + gateway）仍要覆盖；本步钉住的是「**窗口不得进入裁断**」 |
| 迟到行偏差（Step 4 遗留 new_risk） | manifest 的 `Σ row_count` 只数**连续块**：锚在历史轮的迟到行（goal verification 等）物理追加在尾部、不改该轮 `row_count`（E2），因此 Σ 比投影实际行数少 N。目前无消费者（`rowIdBaseByTurnId` 只在 facts/测试里），本步未接线；但 `rowIdOrigin = rowIdBase` 一旦接上就会让窗口内 rowId **整体前移 N**（全量物化用紧凑游标、计数里含迟到行） | 修法必须在**写侧**（投影），不在读侧：或把迟到行计入物理末块的 `row_count`（Σ 恢复为 rows.length，但该轮行数语义变宽），或给迟到行单独的可计数身份。Step 6 接线窗口**之前**必须先定这一条；在那之前窗口化只对无迟到行的会话成立（**Step 6 已按「按 turnId 归户」落地，见下**） |

#### Step 6 落地说明（实现后回填，Step 7+ 直接按此接）

| 事项 | 落地形态 | Step 7+ 必须遵守 |
|---|---|---|
| 迟到行的写侧修法（Step 5 的 blocking 前置） | 取「**给迟到行可计数身份 = 按 `turnId` 归户**」：投影新增 `turnRowCountById`（随 append 增量维护、`row.removed` 时重建、**clone/adopt 必须搬**），`row_count` / `getTurnRowCounts` / `turnRowIdBase` 三处统一读它。理由：cold 合成器本来就把 goal verification 放在它锚定的那一轮里，归户后 `Σ row_count === rows.length` 且 **live 与 cold 的行数分布一致**（账目修正不再每次冷开都跑）；反过来把迟到行记进「物理末块」会让两边分布永久不同，且 `rowIdBase` 变成 live 专属口径。副作用：`buildTurnManifestEntryFor` 只在该轮「行数 > 连续块长」时才付一次 O(rows) 扫描 | `row_count` 只认 `turnRowCountById`，不得退回连续块口径；新增任何投影 clone/adopt 路径漏搬它 = row_count 静默归零 |
| manifest schema 版本 | `TURN_MANIFEST_PROJECTION_SCHEMA_VERSION` 升到 **3**（`row_count` 口径变化）。v2 清单里迟到行「没有任何 turn 认领」，账目修正补不了 → 必须整表重建 | 下次投影口径变化继续 +1 |
| 冷开计划的唯一入口 | `session-row-manifest.ts` 的 `readColdTailWindowMaterialization(...)`：先 `reader.read()`（两趟 + 索引交叉验证）→ `decideRowManifestAction` 不是 use-manifest 就退全量 → `selectColdTailWindow` → 全序 active id 序（`listSessionMessageIndex` + `selectActiveConversationBranchIds`）→ 正文。索引缓存与 reader 共用（`reader.readMessageIndex`），一次冷开只付一次 O(messages) | 不得另写窗口选择或第二份索引读；`limitBefore` 只能来自 `selectColdTailWindow` |
| 降级原因（**必须与「窗口化没生效」可分**） | 新增 `ColdTailWindowFallbackReason`：`portAbsent` / `missing` / `schemaMismatch` / `inconsistent` / `readFailed` / `emptyBranch` / `noIndexPort` / `indexReadFailed` / `noTailPort` / `noWindowCursor` / **`limitBeforeMissed`** / `emptyTail` / `sharedContextImport`。`limitBeforeMissed` 专指「清单指向的窗口首条消息不在 active 序里」= 清单与索引不同步；此时**读到的是整条分支**，故按全量物化（origin 1 / ordinal 0）而不是按窗口播种 | 新增降级原因必须并进枚举 + 打点；`sharedContextImport` 是过渡门（Step 9 改由 manifest/索引给 messageId 后放开） |
| 观测打点 | bridge：`zcode_protocol.v4.cold_window_applied`（ordinal / rowIdBase / rowCount / turnCount / limitBefore / messageCount）与 `zcode_protocol.v4.cold_window_fallback`（reason + detail）；gateway：`getColdWindowOutcome(sessionId)` → `{ ordinal, rowIdBase, rowCount, turnCount, limitBefore, applied, fallbackReason? }` | 判读顺序：宿主没给窗口 → 看 fallback 的 reason；宿主给了但 `fallbackReason` 有值 → 二次读降级、本次沿用物化前事实 |
| rowIdOrigin 的生产值 | `selectColdTailWindow(...).rowIdBase` → 经 `PersistedEventsLoadResult.coldWindow.rowIdBase` → `publisher.rehydrate(events, { rowIdOrigin })`。**必须走 rehydrate 的入参**：rehydrate 会把 projection 换成（可能两个）候选实例，播种点只能是「候选建好、首次 ingest 之前」；放在 rehydrate 之后会因为投影已有行而抛错（刻意的失败模式，测试 H7 锁住） | 任何新的重物化入口都要把 origin 一起传进去，不得 rehydrate 后再 seed |
| 合成器的非零起点上下文 | `ColdSynthesisContext = { initialTurnNumber, initialModelKey, preface?, baseTimestampMs }`，经 `mergeColdConversationEvents({ synthesis })` 透传给 `synthesizeEventsFromMessages`。`initialTurnNumber` = `window.ordinal`；`initialModelKey` = **窗口前一轮首条消息**的选型 key（一次 `messageWithParts` 单行读）；`baseTimestampMs` = **整条分支**首条消息的 `timeCreated`（不是窗口首条）；**bridge 不传 `preface:false`**（窗口按 manifest 整轮对齐，窗首 assistant 属于某一轮的起点，抑制它会丢一轮并把编号前移） | `preface:false` 只给「不按整轮对齐」的窗口（Step 7 按需物化） |
| `fullyMaterialized: false` 的生产路径 | `hydrateRowManifest` 收 `coldWindow`：窗口化时传 `fullyMaterialized:false`（`observedTurnIds` 仍是窗口投影的 turn 序，`unregisteredTurns` 由它抓冷热身份分歧），`fullyMaterialized:true` 只留给全量物化 | 不得为窗口化保持 true：反向集合校验会把「manifest 比窗口长」判成不一致，每页都降级 |
| `ordinalBase > 0` / `keptTurnIds` | **窗口化路径不重建 manifest**：投影只有尾部若干轮，回写会把头部真实轮次写成 0（`ordinalBase` + 剪枝只能「保留已知的」，补不出没物化的）。因此窗口化二次读降级时**沿用物化前读到的事实**（同批 events 的同一时刻快照）并置 `fallbackReason`；`rebuildRowManifestFromProjection` 新增显式 `keptTurnIds`（窗口化将来放开重建时必须传 `coldWindow.branchTurnIds` = **整条分支**） | 若将来放开窗口化重建，`ordinalBase` = `coldWindow.ordinal` 且 `keptTurnIds` = `branchTurnIds`；`test-turn-manifest-store` E5/E6 的逐出语义是硬约束 |
| 必须保持全量的四处（窗口只裁正文） | ①`session.revert` 裁断（吃全序 id 序）②`buildColdFileChangeSummaries`（按 `coldWindow.activeMessageIds` 全量 messageId）③`readSessionContextUsage`（尾部扫描等价）④`listSessionSubagents`（仍吃 resume 的 `persistedMessages`） | 不得把其中任一改成窗口输入 |
| 锚在窗口外的 goal verification | bridge 在合成前按 `coldWindow.windowMessageIds` 过滤：anchor 在窗口外的 entry **不发**（合成器对「anchor 找不到」会落到时间线末尾，等于给窗口凭空加行）；无 anchor 的仍落尾部（与全量同规则） | Step 7 按需物化那一轮时再发它 |
| T-SL5 / T-SL6（本步钉住的部分） | `test-session-row-manifest` J1/J2/J3：窗口合成 vs 全量合成的 `turnId` / `turnNumber` / `createdAt` / `ModelSelected` 序列逐值相等；窗口投影 + `rowIdOrigin` 播种后每行 `rowId` / `kind` / `createdAt` 与全量投影尾部逐值相等；窗首 assistant 不多一轮 | Step 13 的端到端版本（真 store + gateway + 翻页）仍要覆盖 |
| 已知代价 | ①窗口化后客户端翻页到窗口前沿会拿到空页且 `hasMore:false`（`getRowsRange` 的 `pageFirstRowId === undefined`），Step 7 的按需物化才补齐；②manifest 变得不可用时回到全量物化，全量投影的 rowId 从 1 重排，窗口期的 rowId 会整体平移（客户端翻页锚点跳变）；③`openTiming.snapshotRowCount` 从「投影全量行数」变成「物化窗口行数」（风险 10 已登记） | Step 7 必须先解决 ①，Step 14 判读时要注明 ③ |

#### Step 7 落地说明（实现后回填，Step 8+ 直接按此接）

| 事项 | 落地形态 | Step 8+ 必须遵守 |
|---|---|---|
| 执行缝落在哪（IS6） | `v4-gateway.rowsRange`：`rowPageNeeded`（判「请求区间最低行是否落在**已物化窗口**之下」）→ `host.materializeRowPage(sessionId, plan)`（宿主只读正文 + 合成，返回事件）→ gateway 建**临时** `ProductProjection` 物化 → `publisher.encodeRowsRangePage(rows, params, profile)`。publisher 只有一个 `hasMore` 实现（`getRowsRange` 也走它） | 不得把页物化搬回 publisher（同步方法、无 store）；不得出现第二份 `hasMore` 口径 |
| 页定位（gateway 侧按 manifest） | `session-row-manifest.ts` 的 `selectColdRowPage(facts, { beforeRowId, limit })`：`facts.turns` 给逐轮 ordinal/rowCount/首条消息；页按**整轮**扩边（`toolCall ↔ result` 不跨页）；`rowIdBase` 只取 `facts.rowIdBaseByTurnId`；`limitBefore`/`limitAfter` 由轮的首条消息给 | 页必须是整轮；`rowIdBase` 不得另算；`facts.turns` 是布局，**不复制 messageIds 全表** |
| 页正文读 | `readActiveBranchTail` 新增**可选** `limitAfter`（不含的上界）：翻第 N 页只读页内整轮，成本与「页在会话里的位置」无关。两端游标都找不到时退回「多读」而不是「少读」 | 上界只能来自 manifest；`limitBefore` 不在 active 序 → 整页不物化（`limitBeforeMissed`） |
| 每页一次的账目校验 | 临时投影必须满足：`turnIds.length === plan.turnCount`、`rows.length === plan.rowCount`、首末 rowId `=== [rowIdBase, rowIdBase+rowCount-1]`。任一不符 → **放弃这一页**（退回投影现算 + `getRowPageOutcome().reason = "alignmentMismatch"`），绝不交出平移过的 rowId | 不得为「翻得动」放宽守卫；要修的是写侧的 `row_count`，不是读侧的容忍 |
| 模型基线（本步查出的 IS1 洞） | `modelChange` marker 靠「上一轮模型 vs 本轮 config」判定；只喂尾部轮时投影没有上一轮 → 切换轮少一行、其后 rowId 整体前移。修法 = `ProductProjection.seedTurnModelBaseline`：冷窗口走 `rehydrate(events, { modelBaseline })`，页走临时投影播种；基线值 = 窗口（页）**前一轮首条消息**的选型（`hydrationTurnModelSelectionOfMessage`） | 任何新的重物化入口必须把 `rowIdOrigin` **与**模型基线**一起**传；候选投影可能有两个，两处都要播 |
| 按需物化的结果不驻留 | 页只进本次返回页，publisher 投影不变（前插要重写 `apply.ts` 的追加假设与 `rowIndexById`）。每次翻页重合成是既定代价 | 不得为省它引入「前插存储」；`loadOlder`/`loadAllOlder` 靠游标推进，不需要服务端驻留 |
| `hasMore` | 按 manifest 的 `firstRowId` 判（`pageFirstRowId > firstRowId`），不写死 `> 1`（live rewind 后首行可能不是 1） | 客户端 `if (!result.hasMore) break` 是硬依赖，翻页到顶必须为 false |
| 降级与打点 | 宿主返回 null（端口缺席 / `limitBeforeMissed` / `emptyPage`）→ 退回投影现算；`noOlderRows`（上面本来就没行）**不算降级、不打点**。落点 `getRowPageOutcome(sessionId)` | 新增降级原因必须进该落点的 `reason`，否则「没生效」与「翻页坏了」无法区分 |
| `openPhases` 口径（本步定稿） | ①`manifestAdjusted` **进** `openPhases`（三态：`true` 修正过 / `false` 无偏差 / **缺席** = 没走清单）；②`materializeMs` **仍缺席且不该有**——按需物化发生在 `rows/range` 上（没有 ACK 帧），成本走 `getRowPageOutcome().materializeMs`；③`openTiming.snapshotRowCount` 口径钉死为「**本次物化的投影行数**」（全量物化 = totalCount；窗口化 = 窗口行数），会话总行数只看 `rows.totalCount` | 缺席 ≠ false / 0；不得把 rowsRange 的耗时塞进 ACK |
| 窗口化 + live 之后 | 第一条**改动了行集合**的 live ingest 作废 manifest 事实（Step 4 既定；Step 8 把口径从「任何 ingest」收紧到「行集合变化」，见下方 Step 8 落地说明），页物化随之关闭 → 窗口以上翻页再退回 `hasMore:false`（与 Step 6 的已知代价同形，不写坏数据） | 清单在「行集合没变」期间仍是权威；一旦投影多出清单外的行即作废。但这不等于「live 期清单继续可用于翻页」——本轮之外的历史轮次虽仍在清单里，页物化的正文读仍以「投影与清单同源」为前提，本 spec 不放开 |
| 窗口化二次读降级（无自愈） | 二次判定降级时只沿用物化前事实 + `fallbackReason`，**下次冷开重判**。没有自愈路径，理由：能从窗口投影补的只有尾部轮次，头部轮次的行数补不出来；真要修只能「下次冷开强制全量 + 整表重建」 | 若将来做自愈，入口只能是「标记 suspect → 下一次冷开退全量」，不得从窗口投影回写 |
| T-SL9 本地版（本步钉住） | `test-session-row-manifest` L1-L4 + M1-M8：页定位逐值、有界读、逐页与全量物化逐值相等、到顶 `hasMore:false`、窗口内翻页不碰宿主、全量物化永不物化、翻页不触发第二次冷开（`loadPersistedEvents` / `resumePersistedSession` 各一次）、对齐守卫（轮数 / 行数）、窗首切换轮的模型基线、live 之后清单作废的降级 | Step 13 的端到端版本（真 store + gateway + 翻页）仍要覆盖 |

#### Step 8 落地说明（实现后回填，Step 9+ 直接按此接）

| 事项 | 落地形态 | Step 9+ 必须遵守 |
|---|---|---|
| 双水位表 | `viewReadyFlights`（读/翻页/附件读面：`resolveViewPublisher` 是取 publisher 的唯一入口）与 `runtimeReadyFlights`（激活本体：`ensureRuntimeReady` 是唯一入口）。归位实测：本树只有 **12 处** `readyFlights` 引用（spec 的 18 处是在别的树点数的），逐处归位后 `this.readyFlights` 零残留（源码守卫 E1 钉住） | 不得在读入口重新引入「顺手激活」：读只等视图水位，激活只能来自 ACK 后预激活与 send 类命令 |
| 命令对 runtime 的依赖分档 | `commandRuntimeGate(type)` 纯函数 + 三张显式名单：`trigger-activation`（sendText / sendGoalCommand / resumeGoal / editUserQuery / retryTurn / sendQueuedNow / forkAssistant / createSelectionSideSession / startSavedWorkflow / resumeWorkflowRun）、`record-free`（resolveInteraction / snoozeInteractionAutoResolution / discardSharedContext）、其余 `require-runtime`。协议共 38 个命令，全覆盖由 B1 钉住 | 新增命令必须显式归位：默认落 `require-runtime` 只是安全方向，忘登记会让「点了就跑」的命令在 view-only 会话点不动（B1 会红） |
| 命令闸门的三态动作 | `handleCommand`：触发器 → `await ensureRuntimeReady`（当场启动或加入）；`require-runtime` → 只等已在飞的水位，仍未就绪回 ACK `rejected + reasonCode:"runtimeNotReady"`（可重试，不进 inbox 幂等表）；`record-free` 原样放行。`sessionId === null`（createSession）不受门限 | `runtimeNotReady` 必须保持「可重试」语义；不得改成 `failed`（那是「命令坏了」）或放行（handler 只会抛 sessionNotFound） |
| 激活触发点 | ACK 后的后台预激活 `prewarmRuntimeAfterViewAck`：调用点在 `subscribeReserved` 的帧编码（`publisher.subscribeReserved`）之后、返回帧之前，fire-and-forget、失败只经 `onError` 记账。阶段 8 里它是冗余路径（视图水位内部仍等一次激活），Step 9 才成为首屏唯一的自动激活来源（源码守卫 F1 锁位置） | 把视图水位的激活依赖摘掉时**不要**顺带删掉预激活；它的位置（帧编码之后）决定激活耗时不会串进 `viewReadyMs` / `initialFrameEncodeMs` |
| 命令结果查询 | `queryCommands` 只加入已在飞的水位（视图 + runtime），不创建、不拒；水位失败也不影响查询（结论在 inbox 幂等表里） | 不得把 `queryCommands` 并入 runtime-ready 门槛 |
| 激活失败不驻留 | `runtimeReadyFlights` 成功才驻留（`activated: true`），失败即删条目 → 下一次订阅/发送可重新激活（D1）；`runtimeReadyMs` 只在成功时写（缺席 ≠ 0） | 若将来引入「失败态」展示，不能把条目留在水位表里冒充可加入的 flight |
| IS4 三态 + 唯一原始判定点 | `hasHostRecord` 是**唯一**直接调 `host.sessionExists` 的地方；`conversationState`（live/notLive，含 detached live child）、`viewReadySessions`+`conversationViewState`（viewOnly/absent）、`isRuntimeReady`（live 或一次成功激活）各管一个语义。`CommandInbox.getRevision` 走三态（`absent` 才回 null） | 源码守卫 E1 断言 `this.host.sessionExists` 只出现一次：任何「只想问 record 在不在」的新调用必须走 `hasHostRecord` 并注明理由 |
| **live 之后清单还是不是权威（本步定稿）** | 作废条件从「第一条 live ingest」收紧为「**第一条改动了投影行集合**的 live ingest」：`rowSetSignature` = 行数 + 首行 rowId + 末行 rowId，`ingest` 前后各取一次。理由：激活期的 `SessionResumed` / 标题 / 模式 / 交互应答不增删行，按旧口径会让窗口化翻页在激活那一刻失效（行一行没变），生产里等于按需物化不存在。行数抓追加/截断，首行抓 rewind 后的整体平移，末行抓「同长度但换了分支」 | 不得改成按事件类型白名单（漏列一种就会拿旧清单冒充新事实）；也不得退回无条件作废。新事件的「是否增删行」不在登记表里判定，由签名兜住 |
| Step 9 的 blocking 前置 | `isRuntimeReady` 现在以「record 在册 ⇒ live ⇒ 就绪」为短路，这只在「没有 view-only 路径」时成立。Step 9 的 `materializeSessionShell` 会 `createRecord` 但不 resume，届时必须把这条短路换成「激活结论」集合，否则 view-only 会话误报 `runtimeReady:true`（幽灵 runtime 的入口）。回归锚点：D3（record 不在册仍能判出 ready）+ E1 | Step 9 必须先改 `isRuntimeReady` 再接线 shell，且 D3 不得削弱 |
| 本步钉住的测试 | 新增 `test:view-runtime-split`（16 例）：A1-A3 清单权威口径（不增删行不作废 / 增删行必作废 / 签名的三段）、B1-B2 分档全表、C1-C6 闸门动作、D1-D3 失败不驻留 + record 之外的两条事实、E1/F1 源码守卫。T-SL10/T-SL16 的端到端版本（真 runtime 起轮）仍需 Step 13 覆盖 | 变异探测 13 项全部按预期打红，禁止削弱 |

#### Step 9 落地说明（实现后回填，Step 10+ 直接按此接）

| 事项 | 落地形态 | Step 10+ 必须遵守 |
|---|---|---|
| blocking 前置（先于 shell） | `isRuntimeReady` 不再读 record：唯一数据源是 `runtimeReadySessions`（激活结论集合，写入点是 `ensureRuntimeReady` 成功 + 宿主活性回填）。`conversationState` 同步改口径：`hostRuntimeActive`（`V4GatewayHost.isSessionRuntimeActive`）取代「record 在册」，未实现该探针的旧宿主/测试桩退回 record（那时没有 shell 路径，两种口径等价）。`host.sessionExists` 仍然只有 `hasHostRecord` 一个调用点 | `isRuntimeReady` 不得再出现 `hasHostRecord(` 直判（E1 守卫）；新增语义判定必须走 `hostRuntimeActive`，不要新开一个 record 读取点。`disposeSession`/`dispose` 必须连同结论集合一起清（D5） |
| 外壳 / 激活拆分 | `server-operations.ts`：`materializeSessionShell`（store 读 session + 首屏种子 + `createRecord(resume:false)` + `sessions.set` + `record.runtimeViewOnlyShell = true`）与 `activateRuntime`（`app.resume` + 清标记）。`activateSessionForResume` 保留为「两步一起做」的兼容入口，legacy `session/resume` 与 `resumePersistedSession` 行为不变 | `record.runtimeViewOnlyShell` 是「record 在册 ≠ runtime 在跑」的唯一区分点：建 record 不 resume 就必须打标，resume 成功必须清标；漏标 = 首屏永不自动激活（预激活早退），漏清 = 命令被门永久拒 |
| 两条并发入口 | 拆开后「外壳已在、还没 resume」的窗口从一次同步间隙变成整个激活时长，因此两层各加 per-session 单飞：`context.sessionShellFlights`（`materializeSessionShell`，防双 `createRecord`）与 `runtimeActivationFlights: WeakMap<record, Promise>`（`activateRuntime`，防双 `SessionResumed`） | 任何新的重物化入口（Step 11 的升级路径）也必须经过这两个单飞，不得直接调 `createRecord`/`app.resume` |
| 视图水位（IS3 的 view 半边） | `ensureViewReadyPublisher` → `ensureViewShell`：有 `host.materializeSessionShell` → 经 `ColdSessionResumeCoordinator.ensureShellMaterialized`（独立于 `ensureResumed` 的第二条水位，错误分型与激活一致）只建外壳；没有该端口 → 显式退回 Step 8 的「先激活再建投影」（测试桩/旧宿主行为不变）。视图水位不再产生 `runtimeReadyMs` | 不得在读入口重新接激活；降级分支必须保持「有端口/无端口」两条显式分支（F2），不要把激活塞回 `ensureViewReadyPublisher` |
| 自动激活（防死锁） | `prewarmRuntimeAfterViewAck` 是 Step 9 起**首屏唯一的自动激活来源**（位置仍是帧编码之后、`subscribeReserved` 内）。G1 用手法钉住语义：让 resume 悬在半空，subscribe 必须仍然返回 | 删掉或挪动预激活 = 首屏永不自动激活；D3 覆盖不到这条（只覆盖「激活成功 ⇒ ready」），回归锚点是 G1 + F1 |
| 首屏 model/mode 种子 | 新增 store 端口 `readLatestAssistantSelection`（SQL 一行：`role='assistant' and mode is not null`，按权威序**反序** `limit 1`，不读 parts）。`materializeSessionShell` 用它算 `mode` 与 `record.restoredModelSelection`，并写 `record.viewOnlyConfigSeed`；`getSessionConfigSeed` 在 `runtimeViewOnlyShell` 为真时**先**返回它（`?? null` = 空态），绝不读 runtime 默认模型 | 不得退回「读 record 的当前选择」：`createRecord(resume:false)` 之后那是默认模型。`thoughtLevels`/`planEnabled`/`permissionGrant` 在 view-only 首屏**刻意缺席**（激活后补齐） |
| store-only `loadPersistedEvents` | record 不再是「能不能读持久正文」的闸门：缺席时 `liveEvents=[]`、`sourceEventSeq=0`、不重放 dwf journal、无 artifact reader（`fileChangeSummaries` 缺席）、`contextWindow/usageSeed` 缺席，但 durable transcript 照常合并，`synthesized = merged.usedDurableTranscript`。`viewOnlyShell` 时 usage 种子与容量口径一起留空（首屏降级 ②） | 不得恢复「无 record ⇒ 返回空事件」的早退（那会把持久历史整段丢掉）；usage/fileChanges 在激活后的重新水化里补齐（Step 11 的升级路径） |
| `sharedContextImport` 的窗口兼容 | `cold-event-merge` 的判定抽成 `isSharedContextImportMessage`；窗口正文里找不到、且存在 `v4/shared_context_import` entry 时，按 `activeMessageIds[0]`（该 bundle 与 session 原子落库，它是 active 分支第一条消息）单条读一次（`store.messageWithParts`，O(1)），不再为它退全量。`ColdTailWindowFallbackReason` 的 `sharedContextImport` 已删除 | 论据是「原子提交 ⇒ 消息必为分支首条」；若将来导入消息可能不在首位，必须改由 manifest/索引给出 id，不能回到「窗口内 find」 |
| 本步钉住的测试 | `test:view-runtime-split` 16 → 29 例：D4（外壳在册但 runtime 没跑 ⇒ 未就绪 + `runtimeNotReady`）、D5（`disposeSession` 清结论）、G1（视图水位不等激活 / 预激活接管）、G2（shell→激活单向、不重复 resume）、G3（notFound 分型）、H1/H2（shared_context 窗口兼容 + 无额外 IO）、I1-I4（拆分歧缝、三处首屏降级、激活单飞）、E1/E2/F1/F2 源码守卫。`test:session-message-index` 18 → 21（D1-D3 窄读） | 变异探测 10 项全部按预期打红（含「视图水位等激活 ⇒ G1 超时」这条死锁形态），禁止削弱 |

#### Step 10 落地说明（实现后回填，Step 11+ 直接按此接）

| 事项 | 落地形态 | Step 11+ 必须遵守 |
|---|---|---|
| 协议 additive（IS8） | `sessionActionAvailabilitySchema` 新增 `sessionRuntime: "live" \| "viewOnly"`（schema 上 `.default("live")`，版本偏斜防御：旧快照缺键 = 加入它之前的行为）。`commandAck.reasonCode` 的 `runtimeNotReady` 在 Step 8 已落（自由字符串），本步只补客户端可见的 runtime 态 | 不得把默认值改成 `viewOnly`：那会把所有旧客户端的正常会话判成只读。**不得**用 `openTiming.sessionRuntimeState` 代替它（那个是 `conversationState` 的产物，view-only 仍报 `"cold"`，两处语义已经分叉） |
| 注入缝（唯一一处） | `ConversationTopicPublisherOptions.sessionRuntime` provider（网关构造 publisher 时传入）；publisher 在**帧编码边界**读它，改写两处：`getWireSnapshotForProfile`（快照）与 `encodeDeltasForSubscription`（`state.updated` 补丁）。`computeAvailability` 保持纯函数，恒返回 `live` | 不得把 runtime 状态塞进投影 context（那会让「同一批事件 → 同一份投影」失效）；不得只在快照注入而漏掉补丁（激活前后的帧会自相矛盾）。新增第二处注入点前先问：它是否与这两处同源 |
| view-only 的控制面 | 快照与补丁都压平成 `canStop:false` / `stopState:"idle"`；`phase` / `activeWorks` 等其余字段保持历史事实 | 不得把 `phase` 一起改成 idle：历史尾部停在半个 running 轮是事实，改它会让 UI 的「上次被中断」叙事消失 |
| 网关口径 | `sessionRuntimeAvailability(sessionId)` = `isRuntimeReady` ⇒ live；否则 `viewReadySessions.has` ⇒ viewOnly；其余 ⇒ live（缺席 ≠ viewOnly） | 新判定不得绕过 `isRuntimeReady` / `viewReadySessions` 再造一份 runtime 事实；「还不知道」一律 live（安全方向由命令闸门兜底，不由展示面兜底） |
| UI `viewOnly` | `SessionPane.tsx` 新增独立 `viewOnly` prop，缺省跟随 `snapshot.availability.sessionRuntime`。只禁 edit / fork / retry / 文件回滚；`composer` 保持创建与可用（**不得**传 `disabled`，也不得复用 `readOnly`——那个会连 composer 一起删掉） | 新增任何「写入历史」的入口（rewind 类）都要挂同一个 `viewOnlyActive` 门；composer 是唯一激活入口，禁用它 = 复现死锁 |
| composer placeholder | `ConversationComposer` 新增 `placeholderOverride?: string`，`SessionPane` 传 `intl("chat.placeholder.runtimeLoading")`（zh/en 两份 locale 同步）。只换文案，不换可用性 | 不得为 view-only 另造一套 composer 状态；文案必须走 intl（硬编码会与双语文案分叉） |
| 未知态（首屏降级 ④） | `contextWindow` 缺席 ⇒ `V4ComposerToolbar` 的 `taskUsage` 返回 null（不渲染用量环，**没有**默认 20 万分母）；view-only 种子仍不含 `planEnabled` / `thoughtLevels` / `permissionGrant`；`useDraftConfigControl` 只有 `typeof planEnabled === "boolean"` 才写入草稿，缺席时按已知 `mode === "plan"` 推导或留 `undefined`；`availability.sessionRuntime` 翻回 live 后对**从未表达过**的草稿补一次 `planEnabled` | 不得为了「看起来完整」给这三个字段补默认值：那会把「不知道」固化成一次用户选择（草稿是持久化的），激活后也再没有机会纠正。`thoughtLevels` 的展示来源是模型目录，不是投影 config |
| 激活后升级（首屏 → 全量） | `degradedFirstScreen` 只由 `performHydration` 按**本次 load 的事实**写入：`coldWindow !== undefined`（窗口化）或 `loaded.viewOnlyHydration === true`（store-only / 无 record）。`ensureRuntimeReady` 成功之后 `scheduleProjectionUpgrade`：等首屏 hydration 收口 → **先 `hydratedSessions.delete(sessionId)`** → `hydratePublisher(sessionId, undefined, true, { fullMaterialization: true })`。全程不碰 `createRecord` / `app.resume`（升级只是投影重读，激活仍走 `coldResume.ensureResumed → activateRuntime` 的同一条入口） | `hydratedSessions.delete` 是硬前置：`hydratePublisher` 的早退判定在 `forceRebuild` 之前，不删就是 no-op（spec 原文点名的坑，K3 守卫）。`fullMaterialization` 必须一起传：宿主侧靠它跳过 `planColdWindow`，否则「升级」只是把同一份窗口再物化一遍。降级事实是**唯一**判据——不得改成「有 record 就升级」或「总是升级」（K4） |
| 升级与 manifest 权威 | `publisher.rehydrate()` 第 961 行显式 `clearRowManifestFacts()`（**不**经 `ingest`，所以 `rowSetSignature` 判不到这次行集合变化），随后 `performHydration` 在 rehydrate 之后 `hydrateRowManifest(coldWindow=undefined)`：按全量口径重建/校验清单。定性：**升级本身确实改行集合（窗口 → 全量），但清单作废是显式的、并按全量重新注入**，不依赖签名判定 | 任何新的重物化入口必须同样「显式清事实 → 重算后再注入」；不要以为 rehydrate 不产 delta 就与清单无关 |
| 世界观漂移登记 | `openPhases` 本步**不新增分段**（`materializeMs` 仍缺席），`viewReadyMs` 仍不含激活耗时；`openTiming.sessionRuntimeState` 仍是 `conversationState` 的值（view-only 报 `"cold"`），而协议新字段 `availability.sessionRuntime` 报 `viewOnly`。两份读数不是同一个量 | Step 14 判读必须注明：不得拿 `sessionRuntimeState` 与 `availability.sessionRuntime` 互相校验，也不得把 `viewReadyMs` 直接与 phase-0 baseline 比数值 |
| 本步钉住的测试 | `test:view-runtime-split` 29 → 40 例：J1-J3（快照 / 补丁同一把尺、缺 provider 与缺键都落 live、投影不被污染）、K1（首帧 viewOnly → 激活后 live）、K2（降级首屏 → 全量升级：一次全量读、不二次 resume、totalCount 与窗口一致）、K3（先删水位再 forceRebuild、升级不自己 resume、触发点在激活成功之后）、K4（无降级事实不多读）、K5（rehydrate 显式清清单 + 宿主跳过尾窗）、L1-L3（UI viewOnly 闸门 / composer 占位 / 未知态空态） | 变异探测 15 项全部按预期打红（含「不删 `hydratedSessions`」「不带 `fullMaterialization`」「初始化分支把缺席 planEnabled 写成 false」），禁止削弱 |

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
| 1 | IS8 | ack 顶层 + `transport.ts` | 新增 `openPhases` 顶层键（**不动 `.strict()` 的 `openTiming`**）；Step 7 追加 `manifestAdjusted`（三态，缺席 = 没走清单），`materializeMs` 保持无生产者 |
| 2 | IS8 | `scripts/dev/long-session-perf-sample.mjs` | **复用既有 `--out`**（不新增输出选项）；补 ack 顶层键（含 Step 7 的 `manifestAdjusted` 三态）、`runtimeReady` query 与 renderer 侧 `uiViewReadyMs`/`paintAfterApplyMs` 采集；C3 追加：`--path` 四路径自驱动、每次采前 `reset()`、target 判据去产品名、可见性三步 + `contaminated` 标记、`paint_missing` 原因、主判/并列两套判据 |
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
| 17 | IS6 | `v4-gateway.ts` 的 `rowsRange`（`rowPageNeeded` + `materializeRowsPage` + 临时投影）+ `session-row-manifest.ts` 的 `selectColdRowPage`/`readColdRowPageMaterialization` + `publisher.ts` 的 `encodeRowsRangePage`（`hasMore` 的**唯一**实现，`getRowsRange` 也走它）+ `V4GatewayHost.materializeRowPage`（bridge 实现） | 按需物化在 gateway 完成（publisher 的 `getRowsRange` 是同步方法、无 store）；页不驻留；冷路径不复触发完整冷开 |
| 17b | IS6 | `contracts/.../session-store.port.ts` + `adapters/.../repositories/messages.ts` | `readActiveBranchTail` 新增**可选** `limitAfter`（不含的上界）：翻第 N 页只读页内整轮，成本与页的位置无关；两端游标找不到都退回「多读」 |
| 17c | IS1 | `product-projection.ts`（`seedTurnModelBaseline`）、`conversation-topic-publisher.ts`（`rehydrate({ modelBaseline })`）、`transcript-hydration.ts`（`hydrationTurnModelSelectionOfMessage`/`hydrationModelKeyOfSelection`） | 窗口/页必须同时播种 rowId 起点与上一轮模型基线，否则窗首（页首）恰好是模型切换轮时少一行 marker、其后 rowId 整体前移 |
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
- Step 8 — phase-view-runtime-split — blocking: yes — qa: auto：双水位表 + 逐处归位（本树实测 12 处 `readyFlights`，归位后零残留）；**激活触发点**（ACK 后后台预激活 + send 类命令 await `runtimeReadyFlights`，composer 不禁用）；`conversationState`（live/notLive）+ `viewReadySessions`（viewOnly/absent）+ `host.sessionExists` 直判收敛到 `hasHostRecord` 单点（本树实测 5 处直判）；命令分档 `commandRuntimeGate`；**live 之后清单权威口径定稿**（行集合变化才作废）。本地用例 `test:view-runtime-split`（16 例）；T-SL10/T-SL16 端到端仍留给 Step 13。
- Step 9 — phase-view-runtime-split — blocking: yes — qa: auto：**先改 `isRuntimeReady`**（激活结论集合 + 宿主活性探针，见 Step 8 落地说明的 blocking 前置）再接 shell；`materializeSessionShell`/`activateRuntime` 拆分（+ 两条 per-session 单飞）；首屏 model/mode 改走 `readLatestAssistantSelection` 窄查询（`getSessionConfigSeed` 对 view-only 优先、取不到空态）；store-only `loadPersistedEvents`（绕开 record 闸门）；`sharedContextImport` 的窗口兼容（按 id 单条确认）。本地用例 `test:view-runtime-split` 29 例 + `test:session-message-index` 21 例；T-SL10/T-SL11/T-SL14 的端到端仍留给 Step 13。
- Step 10 — phase-view-runtime-split — blocking: yes — qa: auto：协议 additive（`sessionRuntime` + `runtimeNotReady`）；UI `viewOnly` + **composer 保持可用（不得传 `disabled`）**+ `canStop:false`。
- Step 11 — phase-view-runtime-split — blocking: yes — qa: auto：`rowsRange` 冷路径不复触发冷开；升级路径改 `hydratedSessions.delete()` 先删。
- Step 12 — phase-lazy-history — blocking: yes — qa: auto：`historyMode`；eager context init 移到 turn；发送闸门在 init **之后**；逐个核对 `resume.ts` 里以全量 messages 为输入的剩余步骤（`turnNumber`/`latestAssistant*`/`mainTurnCacheHitAggregate`/`discardPersistedPendingSteerInputs`/`syncPersistedSessionTitleForResume`）。
- Step 13 — phase-gates — blocking: yes — qa: auto：`test-cold-open-window.mjs` 覆盖 IS1 逐值一致、IS2 两种事故防护、IS6 翻页不漏、IS7 历史完整。
- Step 14 — phase-gates — blocking: no — qa: manual_user：真机四路径 ×3（`--path cold|warm|reopen|switchback --iterations 3`），**验收基准读 renderer 侧 `uiViewReadyMs`**（要做首绘再叠加 `paintAfterApplyMs`，缺席时读 `paint_missing` 原因），**按 phase-0 的三档表判**：冷开**主判** `uiViewReadyMs − openTiming.hostPrepareMs ≤ 1s`、并列分解项 `uiViewReadyMs − openTiming.cliBootstrapMs`（修正后）、总量作观察项；热开 `uiViewReadyMs ≤ 800ms`（按 CLI runtime 是否持有会话分 regime）；切回不适用该指标，断言**没有新 ACK** 并单列内存态切回耗时；`openPhases` 只作分解项（`viewReadyMs` 是 CLI 进程内段，不含 host/CLI spawn/RPC/渲染，且各段嵌套不可相加）；**`runtimeReadyMs` 从 `conversation/runtimeReady` query 读**（`openPhases` 是 ACK 帧，不含激活耗时；口径是激活本体耗时，不是从 ACK 起算），对照 `baseline.json` 判；同时记录「首发送 → 首 token」以暴露 eager init 后移的成本。

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
10. **`openTiming.snapshotRowCount` 语义会漂移**（该字段在 `openTiming` 里，**不在** `openPhases`）：`v4-gateway.ts:1481` 今天取的是**投影全量行数**，窗口化后会变成「物化窗口行数」。**Step 7 已把它钉死为「本次物化的投影行数」**（全量物化 = `totalCount`，窗口化 = 窗口行数；会话总行数只看 `rows.totalCount`），并在写入点写了口径注释。phase-0 基线对照必须注明这一点，否则会被误读成「优化无效」——**同一份 133ms 的 `viewReadyMs` 在窗口化前后对应的 `snapshotRowCount` 不是同一个量**。
11. **既有测试会碎，须列入回归范围**：`test-turn-directory.mjs:83-90` 用白盒直接改 `rows.totalCount/firstRowId` 并靠全量行喂 `getTurnDirectory`，manifest 成为权威后必须重写该夹具。
12. **本 spec 推翻了前次的 B3 排除**：`docs/apm/memory/20261025-session-open-latency-b1.md:24` 明确记过「B3（首帧不等全量）被排除」。本次依据是后来的「都修吧，根治」兜底授权（`:33`），属**推翻前次决策**，不是「已获授权」——按三态纪律如实登记。
13. **窗口/页的 `modelChange` marker 靠播种才能与全量一致**（Step 7 查出并修）：`seedTurnModelBaseline` 漏在任何一个重物化入口上，都会让「模型恰好在窗首/页首切换」的那一轮少一行、其后 rowId 整体前移；它是**静默**的（不报错，只是翻页错位）。回归锚点：`test-session-row-manifest` M1（页首切换轮）与 M6（窗首切换轮）。
14. **窗口化二次读降级没有自愈路径**（Step 6 遗留，Step 7 确认）：只沿用物化前事实 + `fallbackReason`，下一次冷开重判。可接受的理由是「不写坏数据 + 现象可见 + 修法成本高于收益」——从窗口投影补不出头部轮次，只能「下次冷开强制全量 + 整表重建」，那等于把一次冷开降级成两次。长期「能用但不一致」的会话每次冷开都走这条路，Step 14 判读时要看 `getColdWindowOutcome().fallbackReason` 的出现频率。
15. **窗口化冷开 + 第一条改动了行集合的 live ingest 之后，窗口以上的翻页再次不可用**（Step 7 登记的 new_risk，Step 8 定口径）：manifest 事实在「投影行集合发生变化」时作废（否则 `totalCount` 会漏算正在跑的那一轮），页物化因此关闭，`rows/range` 退回「投影里没有就没有」。现象是 `hasMore:false`、不报错、不写坏数据。**Step 8 已定的部分**：激活 / 标题 / 模式 / 交互应答这类不增删行的事件不再作废基线（`rowSetSignature`），所以「打开会话就把翻页打死」的形态不再存在；**仍未定/未做**的是「live 期间继续用清单翻页」——本轮之外的历史轮次虽仍在清单里，页物化的正文读仍以「投影与清单同源」为前提，放开它需要「清单 + 未入清单尾部轮次」的合并口径，不在本 spec 范围。行为锚点：`test-session-row-manifest` M8（增删行仍作废）+ `test-view-runtime-split` A1/A2（两类事件的分界）。
16. **激活后的全量升级是 fire-and-forget，可能与首轮 send 并发**（Step 10 登记的 new_risk）：`scheduleProjectionUpgrade` 不 await（否则激活的读数和 send 的时延都会被一次全量正文读污染），于是最坏形态是「用户一看到历史就发第一条消息」时，升级的 `rehydrate` 与这一轮事件同时发生。安全性依赖既有的 hydration buffer + `sourceEventSeq` 尾部重放（N/N+1 乱序、已 ingest 事件按 eventId 去重）；现象面只可能是短暂的行重排（订阅者被 resync 成新快照），不会写坏数据。若 Step 13 端到端观测到流式行回退，回退点是把升级从「激活成功即排」改成「首个 turn 结束后再排」（语义上仍满足「激活后补齐」，只是延后）。行为锚点：`test-view-runtime-split` K2（一次全量读、不二次 resume）。
17. **两份 runtime 态读数并存且语义不同**（Step 10 登记）：协议字段 `availability.sessionRuntime`（网关按 `isRuntimeReady`/`viewReadySessions` 判，view-only 报 `viewOnly`）与 `openTiming.sessionRuntimeState`（`conversationState` 的产物，view-only 报 `"cold"`）。两者的取值域、写入点、消费方都不同；**不得互相校验**，也不得用后者代替前者做 UI 门禁。Step 14 判读时必须注明这一点，避免把「字段说 viewOnly、openTiming 说 cold」当成不一致。

### 回滚

按 phase 独立提交、独立 revert，**逆序回滚**：

- phase-row-manifest **不建议回滚**（它是 IS2/IS5 的防复发基础；回滚会同时撤销 T-SL3/T-SL4 的保护）；
- phase-paged-materialization 回滚 = 恢复全量正文读取，manifest 保留（正确性不受影响，只损失性能）；
- phase-view-runtime-split 回滚 = **必须先回三态再回单表**（否则出现不可达分支）；
- phase-lazy-history 回滚 = `historyMode` 默认 `"full"` 即回现状（字段保留）。
