---
date: 2026-10-25
---

# edit-resend-stale-text 技术规格（SPEC）· 根治版

## 设计目标

把「发送 → 终止 → 编辑重发 → 实际发出去的是旧消息」这一类缺陷**一次性根除**，而不是再堵一个触发路径。

本症状在仓内已被修过四次，每次只补一层，每次回归：

| 轮次 | 落点 | 补的层 |
|---|---|---|
| 2026-10-09 | `docs/iterations/bugfix-batch-20261009/spec.md:17` | 文本 + 模型选择 |
| 2026-10-15 | `docs/iterations/bugfix-batch-20261015/cr-fix-spec.md:87` | `intent.text` 持久化 |
| v3.15.1 backport #27 | `core/.../steering.ts:841-912` | 排队项编辑同步 `intent` |
| 本树 | `commands/handlers/fork-edit-retry.ts:145-155` | 抢占判据 |

**四次失败的共同原因**：它们都在修「让旧文本有机会出现的那个触发器」，而没有建立不变量。只要出现一条新的时序让**旧队列项存活到截断之后**，症状必然回来。因此本 spec 的验收标准不是「这条路径不复现」，而是**五条不变式在任意时序下都成立，且有测试守护**。

### 需求来源

用户口述：

> 发送消息后，后悔了，终止，然后重新编辑并发送，结果实际发送的是旧消息，而不是最新消息。

> 我不懂什么最小，我只在乎根治……这个问题修了好多轮，却现在都没修好，最小修毫无意义，重要的是一次性修好，根治。

需求路径记为「用户口述」。父 PRD `docs/iterations/bugfix-batch-20261025/prd.md` 的范围是「只做四条缺陷」且写「不做数据回填」——**本条是第五条，属对父 PRD 的显式豁免**：本 spec 不做任何数据回填（`session_input` 只读既有行，缺失即硬失败 + 对账上报，不补写历史），故与「不做数据回填」不冲突；「四条」的范围需随本 spec 合入一并更新，或在父 PRD 里登记第五条。

### 本 spec 的决策立场（已获授权，不再回问）

用户原话：

> 我不懂什么最小，我只在乎根治……这个问题修了好多轮，却现在都没修好，最小修毫无意义，重要的是一次性修好，根治。

> 都修吧，根治。如果需要决定的地方，通通按照根治的思路做决定。

据此**直接定为**：

| 分叉 | 决定 | 理由 |
|---|---|---|
| 走「最小闭环」还是「根治」 | **根治** | 前四次修复全在修触发器，无人建立不变式；最小修等于第五次重演 |
| I2 是否作废「被截断区间的未起跑输入」 | **作废**（`discarded(rewound)`） | 截断语义必然：那一轮的待发输入不该在新分支上复活。与 `held-queue-input-dropped` 的拍板不冲突（那条讲追加输入照常入队） |
| 是否能容忍截断后新轮没跑 | **不能**，因此必须有 I4 事务与原语 | `clearRevert` 至今零调用，等于「截断不可逆 + 无补偿」 |
| 是否改 UI 骨架 | **不改** | 只补投递态可见性（I5），不动布局与交互范式；编辑器因 RC6 证否**完全不动** |
| 协议兼容 | **additive**（`delivery` 可选） | 旧客户端忽略即可，不引入版本协商 |

### 与同期另外两篇 spec 的关系

- `docs/iterations/magic-context-decoupling/spec.md`：MC 插件化 + 防腐层，**与本条无关**（已逐条验证，见「与 magic-context 无关」节），但其中的 `product-projection` 单写者模型（幽灵事故 B 线）与本条的投影改动落在同一文件，两个 PR 需协调合并顺序。
- `docs/iterations/session-open-latency/spec.md`：冷开性能，**与本条无关**，但两者都会改 `cold-event-merge` / `product-projection` 的事件归约路径，建议本条先合。

### 已排除的候选（不必再查）

`payload.newText` **不会**被改写成旧值：`packages/shared/src/zcode-protocol-v4/command.ts:131-134` 的 `newText` 必填；`commands/input-intent.ts:84,87` 用本次 admission 的新 `queueItemId` 与新 `text`，旧 id 只折叠进 `provenance.queueItemId`（`:101-109`）；`v4-bridge.ts:366-369` 的 `payload.newText ?? canonical.intent.text` 因 schema 必填而不可达。模型收到的文本是 `executeTurnCommand(command.input)`（`core/.../runtime-command-queue.ts:205-206`），`intent.text` 只是元数据（`input-intent-persistence.ts:30`）。

也就是说：**新文本从来没被替换，被发出去的是「另一条旧输入」**。这决定了根治方向。

### 与 magic-context 无关（已验证，不要再往 MC 上归因）

MC 稳定复现时总在场（`features.magicContext` 默认 true，`apps/zcode-cli/packages/adapters/src/config/index.ts:302`），是典型混淆变量。逐条验证结论：

- **MC 只有一个插入点**：`core/src/runtime/methods/turn-loop.ts:114-128`，输入是整份 provider 历史，输出只进 provider 请求；不触及用户输入落库（`bootstrap/src/app/input-facade.ts:109-114`、`core/src/runtime/methods/message-persistence.ts:115-181` 均在其之前）。
- **MC 不监听 rewind**：MC 包内对 `RewindTriggered` / `branchGeneration` / `session.revert` 零命中。rewind 是 `messageHistory.reset()` + 重水化（`core/.../rewind-message.ts:664-695`），被截断的旧 user 消息已不在活历史，MC 无法把它复活成独立 user 条目。
- **命令链无引用**：`fork-edit-retry` / `session-flow` / `queue` / `prompt-turn` / `input-intent` 对 `magic-context` 零引用。
- **关闭 MC 后三条根因路径逐行不变**：装配门 `create-app.ts:826-844`（`enabled !== true` 不 import、不建 DB），core 侧端口缺席即原样返回（`helpers/magic-context-turn-transform.ts:232-234`）。

→ **本 bug 不需要 MC 侧改动**。若修完后仍复现，不要再往 MC 方向查，按「残余候选」继续。

本树另有两条与 MC 相关但**不属于本 bug** 的独立隐患（另行评估，不并入本 spec）：

1. rewind 前已发布的 compartment 在边界 id 被裁掉后记 `refused` 却**整窗照发**（`magic-context/src/core/hooks/magic-context/inject-compartments.ts:3670-3705`），且 `injectM0M1` 的 unshift 不看 refused（`:3903-3917`）→ 模型可能看到旧轮摘要（摘要偏好逐字，`compartment-prompt.ts:23`）。这是「模型看到旧内容」，不是「发出去的是旧消息」。
2. `bootstrap/src/app/magic-context-turn-transform.ts:783-827` 的 `rebuildEntry` **无条件整拷** `original.metadata`，本树**没有** `sanitizeRebuiltMetadata` 守卫（该守卫存在于已回滚的 v1.0.21+ 树，不在本树）——即幽灵消息事故（记忆 #133）的防护在本树上不存在。

## 根因

### RC1 — 执行侧的输入文本从「投影」读（架构级）

`commands/handlers/queue.ts:296` 用 `host.getQueueItem(sessionId, queueItemId)` 取队列项，其实现直接读 **v4 产品投影快照**（`v4-gateway.ts:2593-2597`），随后 `:363-374` 以 `content: queueItem.text` 起轮。而 `sendQueuedNow` 命令载荷**只有 id**（`packages/shared/.../command.ts:147`），没有文本副本。

后果：**展示模型成了执行侧的输入权威**。投影任何陈旧、窗口裁剪、同 id 合并、冷热差异，都会变成「执行的文本不对」。这条通道不切断，任何修复都只是降低触发概率。

### RC2 — 分支截断不级联清理输入队列（结构性缺陷，可达性待 Step 4 确认）

`core/.../rewind-message.ts:559-572` 的 `setRevert` 只写截断点，`:555-558` 只删后台任务，**不动排队输入**。同时：

- `discardPendingInput`（`core/.../steering.ts:1473-1512`）**零调用方**（仅绑定在 proto 层），即「取消时作废排队项」的能力存在但未接线。
- `session_input` 账本里被 stop 留下的项长期停在 `admitted`（`core/.../events.ts:316-355`、`:388-419`）。
- 而 `submitConversationRewind` 成功后 `await host.afterLegacyStateMutation(record,"session_rewound")`（`fork-edit-retry.ts:114`）→ `v4-bridge.ts:1072-1075` → `autoDrainV4QueueIfReady`（`:593-666`），**在 `startCanonicalIntent`（`:216`）之前**完成 await。

于是**若**提升发生，时序是：截断 → 旧队列项被提升为活跃轮（`queue.ts:359-374` 用它自己的 `queueItem.text`）→ 新文本的 admission 撞上活跃轮 → `prompt-admission.ts:69-83` 入队 → `prompt-turn.ts:148-164` 静默返回。用户看到的就是「跑的是旧消息」。

**但这条链有前置闸门，首诊指出它可能不可达**：`autoDrainV4QueueIfReady` 要求 `snapshot.queue.autoDrain === true`（`v4-bridge.ts:601-635`、`queue-auto-drain.ts:13-18`），而「终止」会 `setQueueAutoDrain(false)`（`session-flow.ts:347-351`），编辑重发的抢占 `preemptActiveTurnAndWait` 未传 `preserveQueueAutoDrainOnCancel`（默认 false）也会在 cancelled 终态把它置 false（`session-flow.ts:452-455` + `product-projection.ts:2223-2233`）。因此：

- Step 4 必须先**确认真实可达路径**（候选：`setQueueItemDelivery(guide)` 的空闲回落 `queue.ts:213-222`，或先解 `held-queue-input-dropped` 后的形态），并在 T-RW2 里逐行标注触发条件与 `autoDrain` 取值；
- 若确认该链在本树不可达，则 **RC2 从「直接根因」降级为「结构性缺陷（截断语义不完整）」**，I2 仍要修（它是防止症状第五次回归的不变式），但 T-RW2 的「改前红」需换一条真实可达的用例来承载，不能靠一个改前就是绿的断言。

这条缺陷与「编辑只能作用于最后一条 user 行」无关，与 `intent.text` 无关，与模型选择无关——它是**截断语义不完整**。

### RC3 — 「这一轮的文本与意图」有两套独立装配

- admission 侧：`zcode-protocol/v4-bridge.ts:304-393`（写 `session_input` 账本）。
- 执行侧：`fork-edit-retry.ts:348-408` 经 `inputIntentMetadataFromCanonical`（`commands/input-intent.ts:74-111`）。

同一份 payload，两处各自实现 text/attachments/delivery/provenance 的继承规则。当前两处结果一致纯属人工对齐，无断言守护——这是 `intent.text` 类缺陷反复出现的结构性原因。

### RC4 — 「rewind → 重发」没有事务边界

`setRevert` 是全仓唯一写入点，**不可逆**：`clearRevert` 只有实现（`adapters/.../sqlite-session-store.ts:889-890`）、**src 内零调用方**。所以 rewind 一旦提交，后续 `startCanonicalIntent` 的排队、抛错（`ensureModelReady`、goal 校验）、或会话 resume 的队列清扫（`steering.ts:1514-1586`）都会留下「历史已截断、新轮没跑」。

### RC5 — 投递态不在 ACK 契约

`editUserQuery` 结果 schema 只有 `disposition: rewind|fork|blocked`（`packages/shared/.../command.ts:402-409`），没有 `delivery`。客户端**无法**区分「已起跑」与「已排队」，所以 UI 只能撒谎（`ConversationRowView.tsx:1100-1114` 非 `false` 即关编辑器）。

### RC6 — **已证否**，不入本 spec

首诊复核推翻了我最初的判断：`packages/ui/src/prompt-editor/ChatPromptEditor.tsx:187-190` 有 `hasSyncedInitialValueRef` 一次性守卫，同步 effect **只在挂载后首帧执行一次**，此后 `initialValue` 变化不再覆写。仓内已有同一结论的文档（「首帧回填 + 一次性同步，候选 (a) 已验证非缺陷」），残余仅「挂载后同一 rAF 帧内打字会被冲掉」的一帧窗口，且已判定为 UI 基建不可覆盖、留给 CDP 人工验收。

因此本 spec **不做编辑器改动**。原 `seed:{value,generation}` 方案既非必要（根因不存在），又会打红既有门禁测试 `packages/ui/test/chatPromptEditorSubmitValue.test.ts` 的 B1（它断言的正是当前 `initialValue` 同步形态 + no-op guard），而该测试已在根 `test:v4-perf` 内。

## 不变式（验收以这五条为准，不以「某条路径不复现」为准）

| ID | 不变式 | 违反时的症状 |
|---|---|---|
| **I1** | 执行侧输入文本只能来自 `session_input` 账本；投影只用于显示。账本项为终态（`cancelled`/`discarded`/`promoted`）时**硬失败**，禁止回落投影值 | 投影漂移被执行 |
| **I2** | 分支截断 ⇒ 被截断区间内所有未起跑输入作废（`discarded(rewound)`），且任何升降级路径不得复活 | 旧输入在新分支上跑 |
| **I3** | 一条 command 的 text/intent/attachments/delivery 只由一个函数解析，admission 与执行共用 | 两套规则漂移 |
| **I4** | `rewind → start` 中**截断与文件回退同进同退**：文件回滚失败则**不截断**（现状已正确）；截断已落后 start 失败**不回滚截断**（文件已不可逆地回退，恢复会话会让会话与工作区不一致），失败必须对客户端可见且新文本可立即重发 | 历史消失、新轮没跑、且用户不知道 |
| **I5** | 客户端必须能区分 `startNow` / `queue` / `guide`，UI 不得在 queued 时表现为成功 | 静默丢输入 |

## 总体方案

五条不变式对应五个阶段，**I1+I2 是根治主体，不可拆分合并**；I3/I4 是不复发的前提；I5 是可见性收口。阶段间有依赖顺序（见 Step 序号），但每个阶段可独立提交、独立回滚。

### phase-input-authority（I1 + I3）

1. 抽单一解析函数 `resolveCanonicalInput(record, payload, envelope) → { text, intent, attachments, delivery }`，落在 `bootstrap/src/zcode-protocol-v4/commands/input-intent.ts`（现有 `inputIntentMetadataFromCanonical` 扩张即为此函数）。
2. admission（`v4-bridge.ts:304-393`）与执行（`fork-edit-retry.ts:348-408`）都改为调用它；**删除**两处各自的继承代码与 `v4-bridge.ts:368` 的 `?? canonical.intent.text` 兜底。
3. `queue.ts` 的 `sendQueuedNow` 改为**从账本读文本**：新增宿主能力 `getSessionInputForExecution(sessionId, queueItemId)`（读 `session_input.payload.text` + `status`），文本取它，投影项只用于校验存在性。
   - `status !== "admitted"` → 抛 `fault.command.inputNotPending`，不回落。**`held` 不是 `session_input` 状态**——`SessionInputStatus` 只有 `admitted|promoted|cancelled|discarded|failed`（`contracts/src/interfaces/session-store.port.ts:794`），`held` 是队列级路由态（`queue.autoDrain=false`）；放行 held 队列项时其账本行本就落在 `admitted`。
   - 账本行缺失 → 抛 `fault.command.inconsistentAuthority`。
4. 断言守护：新增源码形状守卫，禁止 `queue.ts` 内出现 `queueItem.text` 作为执行内容。
4b. **I1 的作用范围必须写明**（否则与现状对不上）：I1 只覆盖「queue 提升链的执行文本」。以下**三处**今天仍读投影、**本 spec 不动**，列为已知限制：`retryTurn` 的重发文本（解析在 `commands/input-intent.ts:287-297` 的 `retryTurn` 分支，调用点 `handlers/fork-edit-retry.ts:277`；Step 2 收敛后旧锚点 `fork-edit-retry.ts:279` 已漂移）、`editUserQuery` 的 attachments 缺省（`commands/input-intent.ts:271-285`，调用点 `handlers/fork-edit-retry.ts:144`；旧锚点 `:137` 已漂移）、`queue.ts` 的 goal `objective ?? queueItem.text`。**`queue.ts` 普通分支的 `content:` / `intent.text` 不在例外表里——它在本次范围内**（`inputIntentMetadataFromQueueItem` 的 `text` 改为由账本传入，见变更点 21），因为不修它落库的 `intent.text` 仍可能来自投影，冷恢复会把它带回 edit target（`transcript-hydration.ts:1668,1690`）。T-IA4 的守卫例外表 = 上述三处（goal objective 解析 + goal 分支 intent.text + displayText）；T-IA1 追加断言「落库 `intent.text` == 账本文本」。

### phase-rewind-cascade（I2）

5. `rewind-message.ts` 在 `setRevert` 成功后、发 `RewindTriggered` 之前，级联作废被截断轮次上的未起跑输入。**判据写死，且必须用事件投影、不能用内存对象**：
   - 集合 = `session_input` 中满足全部三条的行：①`status = "admitted"`；②`id ∉ excludeSessionInputIds`（调用方传入本次重发自持的 id，见 5b）；③`targetTurnId ∈ removedTurnIds`。`removedTurnIds` 由 `rewind-message.ts:526-531` 从被截断消息的 anchor 反推；`targetTurnId` 取自 `TurnSteerQueued.targetTurnId`（`steering.ts:226-230`）经 `rebuildProjection().pendingSteerInputs[].targetTurnId`（`steering.ts:1547-1555`）投影出的值；`targetTurnId === "deferred"`（无活跃轮入队时的兜底值）**同样归入作废集合**。
   - **不能用 `activeTurn.pendingInputs`**：edit 路径在 rewind 之前已抢占并等到 idle（`fork-edit-retry.ts:150-155`），此刻 `activeTurn` 不存在；且普通排队项**按设计从不入内存**（`steering.ts:1045-1053`，`enqueueDeferredInput` 只发事件），只有 guide 物化项才进 `pendingInputs`。
   - **不能用 `runtimeTurnId ∈ [target, branchCutAfterMessageId]`**：区间两端是 **messageId**，`runtimeTurnId` 是 TurnId，单位错配。
   - 动作：`settleSessionInput(id, "discarded", reason: "rewound")` + 发布 `TurnSteerDiscarded(reason: "rewound")`。
5b. **排除自身行需要新入参（否则 5 的条件②无法实现）**：`rewindConversationToMessage` 的三处签名（`core/src/runtime/agent-runtime.ts:658-663`、`core/src/runtime/internal-turn-methods.ts:114-119`、`methods/rewind-message.ts`）新增 `excludeSessionInputIds?: string[]`；`TraceContext`（`contracts/src/tracing/tracer.ts:14-22`）不含 commandId，不能从它取；bootstrap 侧 `fork-edit-retry.ts:106` 传 `[queue_${envelope.commandId}]`（id 形态见 `command-inbox.ts:75-77`）。
6. `packages/contracts/src/events/session.events.ts:533-539` 的 Discarded reason 枚举加 `rewound`。
7. 投影 `product-projection.ts:3726-3729` 按 `discarded` 移除队列项（**既有行为，只验证，禁止加 reason 过滤**）；`autoDrain` 的复位**必须经权威路径** `setQueueAutoDrain(true)`（`steering.ts:1198-1221`），**且只在作废后投影队列为空时复位**。队列非空（例如 targetTurnId 属于更早 turn 的 held 项仍然存活）时必须保持 held——否则 `afterLegacyStateMutation` → `autoDrainV4QueueIfReady`（`v4-bridge.ts:593-635`）会在 `startCanonicalIntent` 之前把存活项提升起轮，**正好是本 bug 的复发路径**。
8. 接线 `discardPendingInput`：stop 时对被中断轮的 pending 输入显式结算（`TurnSteerDiscarded(reason: "turn_cancelled")`），消除 `admitted` limbo；若决定不接线则删除该方法与 proto 绑定（不留「能力在但没接」的第三态）。

### phase-rewind-transaction（I4）

**先说清一件事：`restoreRevert` 这个原语不做了。** 首轮设计它是为了让「截断 → start 失败」可回滚，但复核后这条方案不成立——`workspaceMode:"rewind"` 的文件回退发生在 `commitAfterApply` **之前**（`fork-edit-retry.ts:191-211`），一旦会话截断落下，工作区文件已经改过且不可逆；此时把 `session.revert` 写回「未截断」会造成**会话与工作区永久不一致，重启也不会自愈**（`cold-event-merge` 只收敛会话分支，不收敛工作区）。所以 I4 改为「同进同退 + 失败可见」，而不是「可回滚」。

9. **覆盖 apply 与 commit 两个阶段**：`workspaceMode === "rewind"` 时文件回滚必须先于 `setRevert`，文件侧 apply 失败即返回 `blocked` 且**不进入截断**（现状已如此：`file-rewind.ts:113-119` 的 `canApply === false` 在写文件前返回）。**但 commit 阶段必须与 apply 阶段分开**：`commitAfterApply` 现在在 try 内（`:182`），catch（`:183-193`）会补偿文件并返回 `applied:false`——而 `setRevert`（`rewind-message.ts:559`）之后还有 `rebuildConversationDerivedState`（`:576`）与 `appendEvent`（`:597`）可能抛错。**commit 一旦开始就不得再补偿文件**（否则「会话已截断 + 文件被补偿回未截断」，重启也不自愈）。这是本 spec 唯一需要改 `file-rewind.ts` 的地方（T-RT2 ②）。
10. **start 失败不回滚截断**：`editUserQuery` 的 `abort` 只做三件事——作废本次新建的 `session_input`、释放 reservation、把失败以可读 fault 回给客户端（附「历史已回退到目标轮，可直接重新发送」的语义）。**不写回 `session.revert`**。理由见上。
11. **失败后 newText 不丢（唯一可行路径是草稿）**：`abort` 之后目标行已随 rewind 从投影移除（`rewind-message.ts:523` 的 `keptMessages` 不含 target；`product-projection.ts:1839-1861` 从 turnHeader 起整段 `row.removed`），行组件与本地编辑态一并卸载——所以**不能**指望「同一目标行仍可编辑」。交付方式：`abort` 的失败结果携带 `draftText`，UI 收到后写入 composer 草稿（`ConversationRowView` 不做任何编辑态保留）。这条必须同时出现在契约、handler 与 UI 三处，否则 T-RT3 无实现路径。

### phase-delivery-ack（I5）

12. `packages/shared/.../command.ts:402-409` 的 `editUserQuery` 结果增加 `delivery: "startNow" | "queue" | "guide"`（**三值，与既有 `delivery` 字段同源**，`command.ts:430,439`）与可选 `queueItemId`（`delivery` 由 handler 必填，schema 层可选以便旧客户端忽略）。
13. `prompt-turn.ts:148-164` 的 `queued` 分支上抛投递态；`fork-edit-retry.ts:216-228` 透传。
14. UI：`SessionPane.tsx:2453-2501` 在 `delivery === "queue"` 时明示「已排队、未立即发送」，`ConversationRowView.tsx:1100-1114` 仅非 queued 才收敛编辑态。

### phase-editor-seed（**取消**）

RC6 已证否（见根因节），本阶段不实施。编辑器保持现状；`chatPromptEditorSubmitValue.test.ts` 的 B1 断言继续有效，**不得改动**。原计划的两个测试（T-ES1/T-ES2）一并删除——`packages/ui` 无 jsdom，它们本就无法在纯逻辑/源码形状断言里表达。

### phase-regression

17. 新增 `apps/zcode-cli/packages/bootstrap/scripts/test-edit-resend-authority.mjs`：五条不变式各至少一例，全部用真实 handler + 可控宿主。（`sendInput` 桩已能返回 `{delivery:"queue", kind:"queued"}`——`test-edit-retry.mjs:134-148` 已在 busy 时这么做，不需要新造桩。）
18. 现有 `test-edit-retry.mjs:121-124` 的 `rewindConversationToMessage` 桩扩成可返回失败/成功两态。
19. 门禁：把 `test:edit-retry`、`test:edit-resend-authority`、`test:queue-item-delivery-command`、`test:session-mapper-parts` 一并挂进根 `package.json:32` 的 `test:v4-perf`（现状 `test:edit-retry` 至今未进门禁，这是它能反复回归的直接原因）。

## 最终项目结构

不新增包、不新增模块目录，改动集中在既有文件；新增一个回归脚本。

```
apps/zcode-cli/packages/contracts/
  src/events/session.events.ts                         改（discarded reason 加 rewound）
  src/rewind/index.ts                                  **不改**（现有能力已是 id 序；本 spec 不动 contracts 的裁断契约）
apps/zcode-cli/packages/core/src/runtime/methods/
  rewind-message.ts                                    改（级联作废 + `excludeSessionInputIds` 入参）
  file-rewind.ts                                       改（**区分 apply 阶段与 commit 阶段**，commit 开始后不得补偿文件）
  steering.ts                                          改（discardPendingInput 接线）
  events.ts                                            改（discarded reason 落账）
apps/zcode-cli/packages/adapters/src/storage/session-store/
  sqlite-session-store.ts                              **不改**（`restoreRevert` 方案已撤销）
  repositories/session-inputs.ts                       改（按 id 读执行权威 + held 状态）
apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/
  commands/input-intent.ts                             改（单一解析函数）
  commands/handlers/fork-edit-retry.ts                 改（事务化 + 透传投递态）
  commands/handlers/queue.ts                           改（执行文本读账本）
  commands/handlers/session-flow.ts                    改（stop 结算 pending）
  commands/prompt-turn.ts                              改（queued 上抛）
  queue-auto-drain.ts                                  **不改**（该函数签名只有 autoDrain/dispatchState/sessionBusy/targetStatus，接收不到「终态项」；终态项本就不在 `snapshot.queue.items`）
  product-projection.ts                                改（discarded 移除项 —— **既有行为，只补守护断言**）
  projection-state.ts                                  **不改**（autoDrain 复位走 `steering.ts` 的 `setQueueAutoDrain`，不得直写投影）
apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts
                                                       改（admission 调单一解析 + 硬失败）
packages/shared/src/zcode-protocol-v4/command.ts       改（结果契约）
packages/ui/src/prompt-editor/ChatPromptEditor.tsx     **不改**（RC6 证否；门禁测试 B1 断言其现状）
packages/ui/src/v4/{ConversationRowView,SessionPane}.tsx 改（queued 投递态提示 + **失败时把 newText 写入草稿/composer**）
apps/zcode-cli/packages/bootstrap/scripts/
  test-edit-resend-authority.mjs                       新增
  test-edit-retry.mjs                                  改（桩两态 + 补例）
package.json                                           改（门禁挂载）
```

## 变更点清单

| # | 不变式 | 文件 | 改动 |
|---|---|---|---|
| 1 | I1 | `adapters/.../repositories/session-inputs.ts` | 新增按 `queueItemId` 读执行权威（text + status）的查询 |
| 2 | I1 | `bootstrap/.../commands/handlers/queue.ts:296,363-374` | 执行文本改读账本；终态/缺失硬失败；不再用 `queueItem.text` |
| 3 | I1 | `bootstrap/.../zcode-protocol/v4-bridge.ts` | 新增 `getSessionInputForExecution` 宿主桥接 |
| 4 | I3 | `bootstrap/.../commands/input-intent.ts:74-111` | 扩张为唯一解析函数 `resolveCanonicalInput` |
| 5 | I3 | `v4-bridge.ts:304-393`、`handlers/fork-edit-retry.ts:348-408` | 改调同一函数，删各自的继承代码 |
| 6 | I3 | `v4-bridge.ts:366-369` | 删除 `?? canonical.intent.text` 兜底 |
| 7 | I2 | `core/.../methods/rewind-message.ts:559-598` | `setRevert` 后级联作废被截断区间的未起跑输入 |
| 8 | I2 | `contracts/.../events/session.events.ts:533-539` | Discarded reason 加 `rewound` |
| 9 | I2 | `core/.../methods/steering.ts:1473-1512,720-751`、`core/.../events.ts:388-399` | 接线 pending 输入结算（在 core 取消路径）；**`rewound` 必须映射为 `discarded`**——`events.ts:388-399` 现在把除 `session_resumed` 外的 reason 一律映射 `cancelled` |
| 10 | I2 | `bootstrap/.../product-projection.ts:3726-3729` | **不改代码**：`onTurnSteerDiscarded` 已对任意 reason 无条件移除 `payload.pendingInputIds`。本项只做验证（T-RW3），**禁止**加 reason 过滤——`:3731-3738` 的 promoted 移除依赖同一语义 |
| 11 | I2 | `core/.../methods/steering.ts:1198-1221`（权威写入）+ `handlers/fork-edit-retry.ts` | 作废后调 `setQueueAutoDrain({autoDrain:true})` 复位，**且仅在作废后投影队列为空时复位**（队列非空则保持 held，否则存活项会在 `startCanonicalIntent` 之前抢跑 = 本 bug 复发）。**不得直写投影**——权威写入是 runtime 门 + `QueueAutoDrainChanged` 事件；真正的读点是 `steering.ts:465` 的 `queueExternalDrainActive` |
| 12 | — | ~~`queue-auto-drain.ts` 拒绝终态项~~ | **删除**：终态项本就不在 `snapshot.queue.items` 里（作废即移除），且该函数签名接收不到「终态项」 |
| 13 | I4 | `core/.../file-rewind.ts:182-215` | **区分 apply 阶段与 commit 阶段**：apply 失败才补偿文件；commit 开始后（`setRevert` 已落）不得补偿 |
| 14 | I4 | `handlers/fork-edit-retry.ts:122-250` | `abort` 不写回 `session.revert`；只作废本次 `session_input` + 释放 reservation + 回可读 fault（附 `draftText`） |
| 15 | I4 | `handlers/fork-edit-retry.ts:122-250` | 事务化 `begin/commit/abort` |
| 16 | I5 | `packages/shared/.../command.ts:402-409` | 结果加 `delivery`（`startNow\|queue\|guide` 三值，与既有字段同源）+ 可选 `queueItemId`；失败结果加 `draftText` |
| 17 | I5 | `handlers/prompt-turn.ts:148-164`、`handlers/fork-edit-retry.ts:216-228` | 投递态上抛与透传 |
| 18 | I5 | `packages/ui/src/v4/{SessionPane,ConversationRowView}.tsx` | queued 时明示「已排队未发送」；**失败时把 `draftText` 写入 composer 草稿**（不做行内编辑态保留） |
| 19 | I2 | `core/.../methods/rewind-message.ts:559-598`、`core/.../methods/steering.ts:1547-1555` | 作废判据 = `status='admitted'` ∧ `id ∉ excludeSessionInputIds` ∧ (`targetTurnId ∈ removedTurnIds` ∨ `targetTurnId === 'deferred'`)；`targetTurnId` 取自事件投影 `pendingSteerInputs`，**不用 `activeTurn.pendingInputs`**。Step 4 同批确认真实可达链（`autoDrain` 闸门）|
| 20 | I2 | `core/.../rewind-message.ts`、`agent-runtime.ts:658-663`、`internal-turn-methods.ts:114-119`、`handlers/fork-edit-retry.ts:106` | 新增 `excludeSessionInputIds?: string[]` 入参贯通（`TraceContext` 不含 commandId） |
| 21 | I1 | `handlers/queue.ts:344,363` | `inputIntentMetadataFromQueueItem` 的 `text` 改为**由账本传入**（`input-intent.ts:131` 直接 `text: canonicalText`），使落库 `intent.text` == 账本文本 |
| 22 | 全部 | `bootstrap/scripts/test-edit-resend-authority.mjs`、`test-edit-retry.mjs`、根 `package.json:32` | 回归网 + 门禁挂载 |

## 详细实现步骤

- Step 1 — phase-input-authority — blocking: yes — qa: auto：落地 `resolveCanonicalInput`，先只让 admission 侧面改调它并断言字节级等价（zero-behavior 半步），确认无漂移后再让执行侧改调。
- Step 2 — phase-input-authority — blocking: yes — qa: auto：执行侧改调同一函数，删除 `v4-bridge.ts:366-369` 的兜底与两处重复继承代码。**注意 `test-edit-retry-model.mjs:118-130` 的 A1 组测的是 payload schema（`newText`/`modelSelection`），与本次要改的 result schema 无关，不需同步**；需要新增的是 `editUserQuery` result schema 断言（见 Step 10）。
- Step 3 — phase-input-authority — blocking: yes — qa: auto：`session-inputs.ts` 新增按 id 读执行权威；`sendQueuedNow` 改读账本；终态/缺失硬失败；加源码形状守卫禁止 `queueItem.text` 作执行内容。**同批升级四个既有夹具的桩**（`test-model-live.mjs:367`、`test-e2e-live-all.mjs:319`、`test-queue-item-delivery-command.mjs:99`、`test-held-queue-routing.mjs`），其中 `test-model-live` 在门禁内，不同步会当次打红。
- Step 4 — phase-rewind-cascade — blocking: yes — qa: auto：`rewind-message.ts` 级联作废（判据写死 + 排除重发自身行）；`rewound` reason 入契约；`session_input` 落 `discarded`。**本步第一件事是确认真实可达链**（`autoDrain` 闸门是否让旧队首根本没被提升）：若不可达，先改 T-RW2 的复现入口再动手。
- Step 5 — phase-rewind-cascade — blocking: yes — qa: auto：投影移除项（**既有行为，只做验证**）+ 作废后**仅在队列为空时**经 `setQueueAutoDrain(true)` 复位 drain 门（队列非空必须保持 held）。
- Step 6 — phase-rewind-cascade — blocking: yes — qa: auto：把**`activeTurn.pendingInputs`** 的结算接在 **core 的取消路径**（`turn.ts:720-751`，`activeTurn` 在作用域内），或改用 `discardHeldPendingInputById`（`methods/index.ts:271`）。**不得用 `clearAllPendingInputs`**（`steering.ts:780-833` 会把 `pendingSteerInputs` 全部结算，连 T-RW2 必需的 held 项一起清掉）。**也不能从 bootstrap 的 `stop`（`session-flow.ts:312-378`）直接调 `discardPendingInput`**——它要求传入 `ActiveTurnSteeringState` 对象并按引用判等（`:1473-1483`），bootstrap 拿不到。
- Step 7 — phase-rewind-transaction — blocking: yes — qa: auto：改 `file-rewind.ts:182-215`，**把 commit 阶段与 apply 阶段分开**（apply 失败才补偿文件；commit 开始后不得补偿），并确认 apply 失败时确实不进入 `setRevert`；补 T-RT2 两个用例。
- Step 8 — phase-rewind-transaction — blocking: yes — qa: auto：`abort` 语义定稿（不写回 revert、作废本次 session_input、释放 reservation、可读 fault + `draftText`）；`draftText` 贯通契约 → handler → UI composer 草稿；补 T-RT3/T-RT4。
- Step 9 — phase-rewind-transaction — blocking: yes — qa: auto：`editUserQuery` 事务化主流程（校验 → rewind → start → commit），把 Step 7 的断言接进主流程。
- Step 10 — phase-delivery-ack — blocking: yes — qa: auto：契约 + 上抛 + 透传；旧客户端兼容性用 schema 可选性保证。
- Step 11 — phase-delivery-ack — blocking: yes — qa: auto：UI 分流（queued 提示、不收敛编辑态）。
- Step 12 — phase-rewind-cascade — blocking: yes — qa: auto：作废判据落成可判定集合（`admitted` ∧ 排除 `queue_<commandId>` ∧ (`targetTurnId ∈ removedTurnIds` ∨ `'deferred'`)），并补 T-RW5（不自伤）与 T-RW2 的 red→green 证据。
- Step 13 — phase-regression — blocking: yes — qa: auto：`test-edit-resend-authority.mjs` 五条不变式各至少一例；`test-edit-retry.mjs` 桩扩两态。
- Step 14 — phase-regression — blocking: yes — qa: auto：门禁挂载四个脚本进 `test:v4-perf`。
- Step 15 — phase-regression — blocking: no — qa: manual_user：真机三条入口各走三次（行内编辑重发 / 队列撤回后 composer 重发 / 不终止直接编辑），确认不再出现旧文本抢跑（合并后用户执行）。

## 测试策略

### 测试用例

每条不变式都要有「正向成立」与「反向不得发生」两侧断言。

- T-IA1 — blocking: yes — **I1 正向**：`sendQueuedNow` 起的轮文本 == 账本 `session_input.payload.text`，即使投影项文本被人为改成旧值。
- T-IA2 — blocking: yes — **I1 反向**：账本项为 `discarded`/`cancelled`/缺失时抛对应 fault，**不回落投影值**、不起轮。
- T-IA3 — blocking: yes — **I3 一致性**：同一 payload 经 admission 与执行两条入口产出的 `{text,intent,attachments,delivery}` 深度相等（属性测试，覆盖 `newText`/`attachments` 缺省与显式 `[]` 两种语义）。
- T-IA4 — blocking: yes — **I3 反向**：源码形状守卫（剥离注释后判定），`v4-bridge.ts` 不得再出现 `?? canonical.intent.text`；`queue.ts` 不得把 `queueItem.text` 用作**执行内容**（`content` / objective 传参）——注意 `queue.ts:318-324` 用 `queueItem.text` 解析 goal objective、`:352` 用它做 `displayText`，这两处合法，守卫须精确排除。
- T-RT4 — blocking: yes — **I4 草稿不丢**：`abort` 之后目标行虽已随 rewind 从投影移除（`rewind-message.ts:523` 的 `keptMessages` 不含 target、`product-projection.ts:1839-1861` 从 turnHeader 起整段 `row.removed`，该行组件与其本地编辑态一并卸载），**newText 必须仍可重发**——实现方式是把失败时的 newText 写入草稿/composer（不是靠行内编辑态存活），并在 T-RT3 里断言该草稿存在且可发送。
- T-RW1 — blocking: yes — **I2 正向**：rewind 截断到第 N 轮后，属于 `[N, cut]` 区间的 `admitted` 项全部转 `discarded(rewound)`，并发出对应 `TurnSteerDiscarded`。
- T-RW2 — blocking: yes — **I2 反向（本 bug 的核心断言）**：模拟「发送 → 终止（队列有 held 项）→ 编辑重发」，断言最终起跑的轮文本是 newText，且**旧项从未被提升**。**前置要求：本用例必须在改动前是红的**——Step 4 先确认真实可达链（`autoDrain` 闸门，见 RC2），若确认不可达则改用真实可达入口重写本用例，不允许留一个改前即绿的「核心断言」。
- T-RW3 — blocking: yes — **I2 幽灵项**：作废后投影队列不含该项；队列清空后 **runtime 的 `autoDrain` 门与投影同时**复位（只复位一侧即为失败）。
- T-RW4 — blocking: yes — **stop 结算（只针对 pendingInputs）**：被中断轮的 `activeTurn.pendingInputs` 不残留 `admitted`；**held 队列项的账本行按设计保留 `admitted`**（stop 在队列非空时故意 `setQueueAutoDrain(false)` 保留 held，`session-flow.ts:347-351`），T-RW2 的场景本身就需要「队列有 held 项」。**因此 Step 6 的结算对象限定为 `pendingInputs`，不得用 `clearAllPendingInputs`**（它会连 held 项一起清掉）。
- T-RW5 — blocking: yes — **I2 不自伤（必须观测中间态）**：断言对自身 id **没有任何 `settleSessionInput` 调用**，且 start 之前账本状态仍为 `admitted`。**不能断言终态 `promoted`**——正常提升走 `promoteSessionInput`（`session-inputs.ts:273-286`），其 UPDATE **没有** `status='admitted'` 前置，所以即使被误结算成 `discarded`，终态断言仍会绿（假绿）。
- T-RT1 — blocking: yes — **I4 失败可见**：`startCanonicalIntent` 抛错后，`session.revert` **保持已截断**（不回滚），客户端收到可读 fault 且带「历史已回退到目标轮」语义；transcript 与工作区**一致**（都对到目标轮）。
- T-RT2 — blocking: yes — **I4 文件与截断同进同退（两个用例）**：①`workspaceMode:"rewind"` 文件回滚失败返回 `blocked` 时 `session.revert` 未被写入（现状即如此，防回归）；②**`commitAfterApply` 抛错**（`setRevert` 之后 `rebuildConversationDerivedState`/`appendEvent` 失败）时，文件**不得被补偿回未截断**——commit 一旦开始即视为已提交，失败按 T-RT1 的「失败可见」处理，不得出现「会话已截断 + 文件未截断」。
- T-RT3 — blocking: yes — **I4 失败后仍可发送**：`abort` 之后，newText 已被写入草稿/composer（T-RT4 的交付物），断言该草稿存在、内容等于 newText、且可直接发送成功。**不得断言「同一目标行仍可编辑」**——该行已随 rewind 从投影移除（`keptMessages` 不含 target、`row.removed` 从 turnHeader 起），行内编辑态不可能存活。
- T-RT5 — blocking: yes — **I4 排队**：newText 被 queued 时**不算失败**（历史按用户意图截断，`delivery:"queue"` 由 I5 负责可见性），不得触发 abort。
- T-DA1 — blocking: yes — **I5**：`sendInput` 桩返回 `{kind:"queued"}` 时，`editUserQuery` 结果含 `delivery:"queue"`；UI 不把编辑态当成功收敛。
- T-DA2 — blocking: yes — **I5 兼容**：缺省 `delivery` 的旧结果不导致 UI 异常。
- T-ES1 — blocking: no — **已删除**（RC6 证否，原 I6 不成立，见根因节）。

夹具约束：T-IA*/T-RW*/T-RT*/T-DA* 落在 `bootstrap/scripts/`，用真实 handler + 可控宿主。**四个既有夹具的桩必须同步升级**（Step 3 交付项）：`scripts/test-model-live.mjs:367`、`scripts/test-e2e-live-all.mjs:319`、`scripts/test-queue-item-delivery-command.mjs:99` 都要加 `getQueueItem` 之外的账本能力；`test-held-queue-routing.mjs` 对 `queue.ts` 的源码形状断言需随实现同步。其中 `test-model-live` 已在根 `test:v4-perf` 内，不同步升级会当次打红。

## 风险与回滚方案

### 风险

1. **I1 改变执行侧权威来源**：`sendQueuedNow` 从投影读改为账本读，若账本与投影在历史数据上已不一致，会出现「以前能跑、现在硬失败」。**终态定为当次硬失败**（不做「先只打日志观察一轮」的过渡——那与 I1「禁止回落投影值」直接矛盾）：硬失败前做一次对账上报，把不一致写入诊断日志；若历史库确实缺字段，按 Step 3 决策降级为「先补账本再切权威」，但**不允许长期停在回落态**。
2. **I2 语义变化（已拍板）**：截断时把被截断区间的未起跑输入作废，意味着「终止后留在队列里的那条」在编辑重发时会消失。用户已授权「按根治思路做决定」，故**不再回问**；但与 `held-queue-input-dropped` 的拍板不冲突（那条讲追加输入照常入队，这条讲被截断区间的输入），实现时两条 spec 不得互斥。
3. **I4 不再引入「反向写 revert」能力**：首轮设计的 `restoreRevert` 已撤销（文件回滚不可逆会让会话与工作区不一致）。风险转为「start 失败后用户必须重发」——由 T-RT3/T-RT4 的草稿保留兜住。**另有一处真实窗口**：`file-rewind.ts:182` 的 `commitAfterApply` 在 try 内调用，catch（`:183-193`）会补偿文件并返回 `applied:false`；而 `setRevert`（`rewind-message.ts:559`）之后还有 `rebuildConversationDerivedState`（`:576`）与 `appendEvent`（`:597`）可能抛错——此时「会话已截断 + 文件被补偿回未截断」仍是不一致。对策：`file-rewind` 必须区分 **apply 阶段**与 **commit 阶段**，commit 一旦开始就不得再补偿文件（T-RT2 增加该用例）。
4. **协议加字段**：`delivery` 为可选字段，旧客户端忽略即可。**需新增的是 result schema 断言**（`test-edit-retry-model.mjs:118-130` 的 A1 组测 payload schema，不受影响）。既有 `delivery` 取值是 `startNow|queue|guide`（`command.ts:430,439`，`session-flow.ts:297-308` 已在用），编辑重发会继承被编辑轮的 `requestedDelivery`（`fork-edit-retry.ts:382`）→ `prompt-turn.ts:107-109` 可落到 `guide`，因此新字段必须用三值枚举，不能只写两值。
5. **影响面大**：本 spec 触及 contracts / core / adapters / bootstrap / shared / ui 六层。必须按 Step 顺序逐阶段提交，每个阶段单独过门禁，不允许一次性大提交。
6. **残余不确定**：`sendQueuedNow` 读账本所需的查询若历史上缺失字段，需回填策略；Step 3 内确认，若需回填则降级为「先补账本再切权威」。
7. **新增 fault code 需登记**：`fault.command.inputNotPending` / `fault.command.inconsistentAuthority` 仓内零命中，实现时须确认既有 fault 命名空间（`packages/shared` 的 fault registry）并按其规则登记，不得裸抛字符串。
8. **父 PRD 需同步登记第五条**：`docs/iterations/bugfix-batch-20261025/prd.md` 仍写「四条」，合入本 spec 时须一并更新，否则后续读者会以为本条不在范围内。

### 回滚

分阶段独立提交，每阶段可单独 revert：

- I1 回滚 Step 1-3（执行文本回投影读，恢复兜底 —— 症状回归但系统可跑）；
- I2 回滚 Step 4-6（恢复「截断不作废队列」旧语义）；
- I4 回滚 Step 7-9（`abort` 回非事务式，失败不再对客户端可见）；
- I5 回滚 Step 10-11；phase-editor-seed 已整段取消（契约字段可选，无迁移负担）；
- 回归网（Step 13-14）**不建议回滚**，它是防止第五次回归的唯一保障。

无 DB schema 迁移；`discarded` 新增 reason 为枚举值扩张；**不新增任何 revert 写回能力**（`restoreRevert` 已撤销）。
