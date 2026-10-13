# CR Fix Spec: queue-item-guide-toggle（排队项引导切换）

## 元信息

- repo: D:\Dev\Js\oh-my-zcode；branch: feature/queue-item-guide-toggle
- base_sha: main → head_sha: e7599f5d
- prd_path / spec_path: docs/iterations/oh-my-zcode-fork/features/queue-item-guide-toggle/{prd.md,spec.md}
- review_round: 2 / dag_version: 2
- 状态：**fix-spec-ready（P0-1 经 spec-check 修正为两段式：先插桩定位真断点，再按定位结果修复）**
- 评审方式：**主代理手工审查**（review 子代理多次 provider 限流，按 skill 失败纪律转手工，标注在此）；CR 轮=diff 通读+链路回读+core 实验；spec-check 轮=对 cr-fix-spec 本身的 execute-ready 审查（含对本轮诊断的复核）

> **spec-check 轮修正记录（round 2）**：CR 轮的 P0-1 诊断「查找域不含 queue 车道项」**被复核推翻**——CR 实验的 `rebuildProjection` mock 返回了空 `pendingSteerInputs`，而真 `EventReducer`（contracts/src/events/event-reducer.ts:326-348）对 `TurnSteerQueued` **不区分 delivery**，queue 车道项同样进 `pendingSteerInputs`，故 core held 回落（steering.ts:1034-1039）在真 reducer 下应能命中。教训：复现实验必须走真 reducer，不可 mock 投影。下文 P0-1 已按「已排除项 + 两段式定位修复」重写。

## Must-fix

### guide/P0-1 [P0] setQueueItemDelivery 真机全链路静默失效——切换功能不可用（两段式：插桩定位 → 修复）

- 维度：B（正确性）+ A（spec 核心承诺未兑现）
- 文件：
  - apps/zcode-cli/packages/core/src/runtime/methods/steering.ts（setPendingInputDelivery ~1021-1100；按定位结果改）
  - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts:179-205（按定位结果改）
  - apps/zcode-cli/packages/core/scripts/test-queue-item-delivery-toggle.mjs（补走真 reducer 的回归）
- 症状（真机 e2e S5，已排除时序因素，45s 稳定 busy 窗口复现）：点击「引导」→ dispatchCommand ACK 正常（status ∈ {accepted, noop}）→ 队列项不动、待引导列表不出现、无 toast、renderer console 无拒绝日志。
- **已排除项**（复核过的静态证据，下游勿重查）：
  1. id 空间：`inputIntentMetadata`（input-intent.ts:45）把 `queueItemId=queue_<commandId>` 写进 intent → `enqueueDeferredInput`（steering.ts:236-239）用它当 pendingInputId → **id 对齐成立**；handler 注释「同一 id 空间」表述本身无误（域差异另见下）。
  2. core 内存域：busy 中 queue 车道入队走 `enqueueDeferredInput` **不 push `activeTurn.pendingInputs`**（对照 steerTurn:147 有 push）——`setPendingInputDelivery:1030` 的内存 find 对 queue 车道项必 miss，随后进 held 回落（1031-1039）。
  3. held 回落可达性：真 `EventReducer` 的 `TurnSteerQueued` case（contracts/src/events/event-reducer.ts:326-348）**不区分 delivery**，queue 车道项在 `rebuildProjection().pendingSteerInputs` 中——held find 应命中（**注意：CR 轮实验 mock 了空投影得出「miss」结论，已作废**）。
  4. 投影消费：`onTurnSteerDeliveryChanged`（product-projection.ts:3484-3520）已注册（分发表 1432 行）、3487 守卫查 `snapshot.queue.items`（正是 queue 行所在域）、queuePatch 产出 state.updated。
  5. UI 投影：`projectPendingGuideQueue`（pendingGuideProjection.ts）按 `delivery.admitted` 分流，逻辑正确；SessionPane 挂载链在位。
  6. 事件记账：events.ts:357-387 对 TurnSteerDeliveryChanged 有 session_input 账本记账（仅持久化，不阻塞投影）。
- 改法（两段式，第一段产出喂第二段）：
  - **第一段（插桩定位）已完成（2026-10-13 wave-0）**：renderer hook + CLI handler/core + publisher 四层插桩，多轮 e2e 对照 pass/fail。**定位结论=分支丁（甲/乙/丙之外）：baseRevision CAS stale 拒绝**。证据：fail 轮 renderer ack=`{"status":"stale","reasonCode":"proto.staleRevision","revisionAtDecision":7}` 而发送时 `rev=6`；**CLI 侧 handler/core 零执行**（命令在 gateway CAS 层被拒，从未到 handler）；pass 轮 `rev=7` 恰好新鲜，全链 8 条日志完整（handler.enter→core.enter→held-fallback hit→changed=true 双向）。机制：busy 流式期间投影 revision 随流式事件快速前进，hook 点击时读到的 baseRevision 落后 1 步即被 CAS 拒；hook 设计「stale 不重试、静默回滚」（useQueueItemDeliveryToggle.ts:34-35 注释）→ 操作丢失，UI 零反馈。fail 轮 turn 结束后 autoDrain 正常消费掉排队项（remainingQueue=[]），无数据损坏，纯操作丢失。pass/fail 约各半=点击瞬间 revision 新鲜度的竞态。**此前 CR 轮对 CAS 的怀疑（v11）被 pass 轮样本误排除；「查找域不含 queue 项」诊断亦作废（真 reducer 含，held 回落在真机正常命中）。**
  - **第二段（修复，按分支丁执行）**：hook 级 stale 单次重试——`useQueueItemDeliveryToggle.ts` 的 then 分支收到 `status==="stale"` 时，重读 `getRevision()` 并用新 baseRevision 重发一次（队列命令幂等，重发安全；仅重试 1 次防循环）；重试后仍非 accepted/noop/duplicate → 走既有 onRejected 观测。配套：P2-1 三处静默 return（sessionId 空/pending 在途/revision null）补观测日志。
  - 分支甲/乙/丙保留为已排除路径（插桩证据表明 core held 回落、事件传播、投影消费在真机全通）。
- 验收/测试：
  1. ✅ 定位结论已回填（分支丁：baseRevision stale，见上）；
  2. hook stale 重试的单测（mock dispatchCommand 首回 stale 二回 accepted，断言重发用新 revision、只重试一次、连败走 onRejected）；
  3. 既有 core/bootstrap 回归全绿（本次修复不动 core/CLI 层）；
  4. 真机 e2e S5 复跑 ≥3 轮全过（stale 竞态被重试吸收）。
- 来源：CR round 1（手工）+ spec-check round 2（手工复核推翻原诊断，证据见上）

### guide/P0-2 [P0]（并入 P0-1 修复）core miss 时命令面静默 accepted——观测性缺失放大了 P0-1

- 维度：C-orch（命令面语义）+ J（可观测性）
- 文件：apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts:197-203
- 问题：`changed=false` 只 `logger.warn`，ack 仍 accepted——「命令被接受但无任何效果」无用户可见/结构化信号，正是 e2e 排查多轮的根因之一。修复 P0-1 后该分支理论不可达（防御层），但语义仍应明确。
- 改法：core miss 时（防御分支）返回明确拒绝（ack.status=rejected + reasonCode 如 `guard.queueItemDeliveryMissed`），替换静默 accepted+warn；availability 门不动（保持 ALLOWED，与 queueEdit 一致，不牵动 formal-proof 裁决表）。
- 验收：bootstrap 测试补一条「投影命中但 core 未命中 → rejected + reasonCode」用例。
- 来源：手工 CR round 1

### guide/P2-1 [P2] useQueueItemDeliveryToggle 的 early return 无观测

- 维度：J（可观测性）
- 文件：packages/ui/src/v4/useQueueItemDeliveryToggle.ts:51-53
- 问题：`!sessionId || in-flight` 与 `getRevision()===null` 三处静默 return——点击被吞时 renderer 无任何日志，e2e/用户排查困难。
- 改法：三处 return 前加 `logger.debug`（不改行为，只加观测；debug 级别避免刷屏）。
- 验收：typecheck 过；手动触发场景日志可见（debug 开启时）。
- 来源：手工 CR round 1

## Spec deviations

- open：spec「关键设计定案」声称「firstInlineGuideIndex 动态扫描 → 切换后项自然进入/移出 guide 子序列，core 消费侧零改动」——**消费侧零改动属实，但切换链路在真机静默失效**（P0-1），spec 的核心行为承诺未兑现。修复定位+落地后置 fixed；消费域确认（原「改法第 3 点」）并入两段式第一段插桩范围。

## Open questions / 待拍板

- guide 消费域问题（P0-1 改法第 3 点）修复时若发现消费侧也需改造，改法可能超出「窄改查找域」——届时报回，不在本轮预判。
- TUI（apps/zcode-cli TUI 界面）是否需要同样的切换入口：PRD 未承诺，不阻塞（留二期）。

## 已豁免（用户确认不修）

- 无。

## 合并后 QA（manual_user）

- 真机手工走查：busy 会话排队两项 → 点「引导」→ 项转入待引导列表（时间线出现「正在引导对话」）→「恢复排队」回队列；turn 结束后 guide 项在 tool 边界被内联消费（观察一条内联消息注入而非独立成轮）。

## K 节建议（下游执行时闭合）

- CHANGELOG Unreleased 在修复后补一行「修复排队项引导切换在真机不可用（core 查找域）」。
- 修复 commit 建议单独一个（与功能提交分开，便于回溯本次 CR 结论）。

## Fix-Spec Closure

| 项 | 状态 |
| --- | --- |
| fix-spec-ready | yes（P0-1 为两段式：定位步骤可执行、三个修复分支均有明确改法与验收） |
| fix_spec_path | docs/iterations/oh-my-zcode-fork/features/queue-item-guide-toggle/cr-fix-spec.md |
| dag_version / review_round | 2 / 2（spec-check 轮修正原诊断） |
| P0 / P1 / P2（已写入 fix-spec） | 2 / 0 / 1 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | open: 1（随 P0-1 修复闭合，含消费侧确认） |
| C-orch | P0-2 已覆盖命令面语义 |
| C 类合并后 QA | 见「合并后 QA」 |
