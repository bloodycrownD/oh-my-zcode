---
date: 2026-10-11
generated_by: impl-model-main
head_sha_at_generation: d69ef5e4048b96f4a2a86cc32b8e0ae54abae9ec
iteration: bugfix-batch-20261011
phase: phase-model-live
steps: [Step 4, Step 5]
---

# 主会话切模型实时生效（Step 4/5）证据包

> 生成节点：impl-model-main（与 impl-settle 并行工作；本文件只覆盖缺陷②「主会话切模型」，
> 不涉及 settle 条件化）。spec 权威红线见 `docs/iterations/bugfix-batch-20261011/spec.md`
> 「现状约束 → 模型选择语义」。

## 1. 现状快照链（改造前，探索核实锚点）

```text
Composer 选模型
  └─ packages/ui/src/v4/SessionPane.tsx handleSelectModel（:2824 旧注释）
       「Composer 选择表达『下一次提交』」→ 只更新 renderer draft intent
       （全 ui 无 switchModelConfig 调用点）
  └─ 提交时冻结：packages/ui/src/v4/composer/composerSubmissionConfig.ts:13-44
       createComposerSubmissionConfig → modelSelection 恒带（desktop）
  └─ 协议 admission：bootstrap .../commands/handlers/session-flow.ts:200-203
       modelSelectionPinned = payload.modelSelection !== undefined（desktop 恒 true）
       busy → app.enqueueDeferredInput(intent)（steering.ts:201-294 冻结整个 intent）
       → TurnSteerQueued 事件 → 投影 QueueItem（product-projection.ts:3387-3434）
  └─ promote：handlers/queue.ts sendQueuedNow → input-intent.ts inputIntentMetadataFromQueueItem
       （刻意不置 pin；product-projection.ts:3403/3533 三处「勿当漏字段补」注释）
  └─ core turn.ts:100 admittedModelSelection = intent.modelSelection ?? getSessionModelSelection()
  └─ 写回门 core/runtime/methods/turn-model.ts:52
       仅 selectionScope!=="execution" && modelSelectionPinned===true 时
       setSessionModelSelection + persist + emitModelSelected
       （v1.0.4 修复：编辑重发/queue 提升不再无条件写回）
```

三个既有语义在本批**原样保持**：

1. 编辑重发（fork-edit-retry.ts:372、goal.ts:75、session-mgmt.ts:96）旧快照执行 + 不写回。
2. execution-scope 轮（turn.ts:239-240、turn-guide-drain.ts:29-38）禁切模、不改写会话选择。
3. QueueItem 不持久化 `modelSelectionPinned`（admission 期进程内标志）。

## 2. 改动点（Step 4 / Step 5）

| # | 文件 | 改动 | 说明 |
|---|---|---|---|
| 4 | `packages/ui/src/v4/SessionPane.tsx` | `handleSelectModel` 对已有 session 追加 `dispatchConfigCas("switchModelConfig", { provider, model, thought: "" })`，经 `configCommandBarrier` 串行；`:2757` 预热注释与 `:2824` 设计注释改写为新语义 | 仅 `sessionId !== null` 下发；草稿/预热 session 仍走首发 CAS 链。失败收口对齐 `handleSendText`：noop/stale 不弹 toast，仅 warn 日志 + `recordV4CommandAck` 调试缓冲（dispatchConfigCas 内部既有） |
| 5a | `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` | 私有字段 `lastModelSwitchAt = 0` + 公开接口 `getLastModelSwitchAt(): number` | 墙钟 ms，只增不减 |
| 5a | `apps/zcode-cli/packages/core/src/runtime/{internal.ts,internal-methods.ts}` | 字段/方法声明 | — |
| 5a | `apps/zcode-cli/packages/core/src/runtime/methods/config.ts` | `setSessionModelSelection` 变值时写 `lastModelSwitchAt = Date.now()`；新增 `getLastModelSwitchAt` | **同值重写不记**（desktop 每条 sendText 都 pin 当前选择）；**清除不记**（恢复/配置刷新失效不是切换） |
| 5a | `apps/zcode-cli/packages/core/src/runtime/methods/index.ts` | `proto.getLastModelSwitchAt` 注册 | — |
| 5c | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts` | 新增 `applyPromotedModelSelection(runtime, item, intent)`，sendQueuedNow 的 goal/text 两个分支都过它 | 只覆盖 `intent.modelSelection`，显式 `modelSelectionPinned: false`，不调 setSessionModelSelection |
| 5c | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/input-intent.ts` | 仅在 `inputIntentMetadataFromQueueItem` 文档块加指向注释；:118-119「不置 pin」注释逐字保留 | 规则落点单一，注释互指 |
| 5d | `apps/zcode-cli/packages/bootstrap/scripts/test-model-live.mjs` | 新增（node --test，registerHooks→dist） | 见 §4 |
| 挂载 | 根 `package.json` `test:v4-perf` | 追加 `pnpm --dir apps/zcode-cli --filter "@zcode/bootstrap..." build && node --test apps/zcode-cli/packages/bootstrap/scripts/test-model-live.mjs` | 自带 dist 前置，链上自洽 |

**r1 审查更正的采纳情况**：①QueueItem **不新增** `enqueuedAt`（全仓 0 命中），判据改用既有
`item.admittedAt ?? 0`（v4 command admission 墙钟，语义即入队时刻；CommandInbox
command-inbox.ts:163 `const admittedAt = this.host.now?.() ?? Date.now()`）；
②promote 不置 pin=true、不新增写回调用，`input-intent.ts:118-119` 注释原样保留；
③SessionPane 两处既有 submission-scoped 设计注释（:2824/:2757）已按新语义显式改写；
④仅对已有 session 下发；失败收口对齐既有链。

## 3. 时间戳判定规则

```text
lastModelSwitchAt（core，会话态；0 = 本进程从未变值）
item.admittedAt   （QueueItem，本项入队的 command admission 墙钟）

promote 判定（bootstrap handlers/queue.ts applyPromotedModelSelection）：
  lastModelSwitchAt > (item.admittedAt ?? 0)
    → intent.modelSelection := runtime.getSessionModelSelection()（活值）
      intent.modelSelectionPinned := false（不写回会话态）
  否则
    → 维持 item 旧快照（含旧发送端 admission 兜底固定的快照）

  item.admittedAt 缺失（旧投影/水化条目）→ ?? 0 视为最老：任何真实切换都晚于它。
```

为什么「同值重写不记」是必需的：desktop 每条 `sendText` 都携带 modelSelection
（`composerSubmissionConfig`），admission 后经 pin 门写回会话态。若把每次提交的写回都记成
「切换」，时间戳会被提交动作本身不断刷新，「入队后未切模」会被误判成「切过模」，
排队消息的旧快照语义被无声改写（T-ML2b 钉死）。

为什么「清除不记」：恢复/配置刷新让选择失效是一次失效，不是用户切换；若记，则
`lastModelSwitchAt > admittedAt` 可能对更早入队的项恒真，把活值（undefined）判成应采用值。

## 4. 测试覆盖（T-ML1..T-ML4 + auto-drain 同路径）

`node --test apps/zcode-cli/packages/bootstrap/scripts/test-model-live.mjs`（便携 Node 24.14.0）：

| 用例 | 断言 |
|---|---|
| T-ML1a | `setSessionModelSelection` 只在选型**变值**时记 `lastModelSwitchAt`；同值重写/清除都不记 |
| T-ML1b | 切换后下一个新提交轮用新模型：`sendText` admission 冻结活值 → 执行用新模型 → 同值写回不刷新时间戳 |
| T-ML2a | 入队后切换 → sendQueuedNow 提升轮用活值、`modelSelectionPinned=false`、喂回执行态不发生写回三连 |
| T-ML2b | 入队后未切换（含「切换发生在入队之前」）→ 提升轮用 item 旧快照 |
| T-ML2c | auto-drain（`__v4ExecutionContext.autoDrainPromotion`，v4-bridge 同路径）与手动提升同规则 |
| T-ML3 | 编辑重发仍用被编辑轮快照且不写回会话态——即使 `lastModelSwitchAt > 0`（v1.0.4 回归红线） |
| T-ML4 | execution-scope 轮按 intent 选型执行但绝不写回会话态 |

隔离：假 provider（`bind/generateText/streamText` 抛错）、假 runtime/host 窄面、
`sessionStore.saveSessionEntry` 捕获进内存；不写真实 `~/.omz`/`~/.zcode`、不触网。
被测代码零打桩：core/bootstrap 一律按 dist 文件路径加载真实模块；发布原始 TS 的 workspace 包
（`@zcode/shared`/`@zcode/model-option-map`/`@zcode/provider`/`@zcode/provider-node`）由
registerHooks 改指同布局 dist（同 `test-magic-context-turn-transform.mjs` 手法）。

## 5. 验证记录（实跑）

| 命令 | 结果 |
|---|---|
| `node --test apps/zcode-cli/packages/bootstrap/scripts/test-model-live.mjs`（便携 Node 24.14.0） | 7/7 pass |
| `pnpm test:v4-perf`（根聚合链，含新挂载段） | 162 + 15 + 5 + 3 + 7 全 pass，exit 0 |
| `npx tsx --test scripts/test-edit-retry-model.mjs`（bootstrap 既有 v1.0.4 回归） | 16/16 pass |
| `pnpm --filter @zcode/core typecheck` / `--filter @zcode/bootstrap typecheck` | 0 error |
| 根 `pnpm typecheck`（`tsc -b` 全项目含 packages/ui） | 0 error，exit 0 |
| `pnpm architecture:check --changed` | violations 0 / new 0 |
| `npx oxlint <10 个改动文件>` | 0 warning / 0 error |
| `npx oxfmt --check <8 个改动文件>`（除 SessionPane） | All matched files use the correct format |
| `npx oxfmt --check packages/ui/src/v4/SessionPane.tsx` | 既有基线不合规（HEAD 即如此：重复 import 块），本节点改动**零新增**不合规（对比 oxfmt(head) vs oxfmt(mine) 差异仅为本节点新增行） |

根 `pnpm lint` 全量输出 784w/307e，全部来自**未跟踪**的 `.reference/`（上游 magic-context
镜像）与 `.tools/`（代理临时脚本），与被跟踪源码基线无关；本节点 10 个改动文件定向
oxlint 为 0w/0e。
