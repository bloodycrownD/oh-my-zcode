# CR Fix Spec: queue-item-guide-toggle（排队项引导切换）

## 元信息

- repo: D:\Dev\Js\oh-my-zcode；branch: feature/queue-item-guide-toggle
- base_sha: main → head_sha: e7599f5d
- prd_path / spec_path: docs/iterations/oh-my-zcode-fork/features/queue-item-guide-toggle/{prd.md,spec.md}
- review_round: 1 / dag_version: 1
- 状态：**fix-spec-ready**（待用户确认后开工）
- 评审方式：**主代理手工审查**（review 子代理两次 provider 限流，按 skill 失败纪律转手工，标注在此）；评审手段 = diff 通读 + 关键链路逐段回读 + core 决定性实验（真实 enqueueDeferredInput 路径复现）

## Must-fix

### guide/P0-1 [P0] setQueueItemDelivery 对 queue 车道项永远 miss——切换功能在真机不可用

- 维度：B（正确性）+ A（spec 核心承诺未兑现）
- 文件：
  - apps/zcode-cli/packages/core/src/runtime/methods/steering.ts（setPendingInputDelivery，~1021-1100）
  - apps/zcode-cli/packages/core/scripts/test-queue-item-delivery-toggle.mjs（补回归）
- 问题（证据链，全部实锤）：
  1. busy 中以 queue 车道入队走 `enqueueDeferredInput`（prompt-admission.ts:71），该路径**只发 TurnSteerQueued 事件，不向 `activeTurn.pendingInputs` 内存 push 项**（对照 steerTurn 路径 steering.ts:147 有 push）——core 决定性实验输出 `pendingInputs 长度=0`；
  2. `setPendingInputDelivery` 的查找域只有两个：①`activeTurn.pendingInputs.find(id)`（内存，仅 steer 车道项在此）②held 回落 `rebuildProjection().pendingSteerInputs`（仅 steer 项）——**queue 车道项两个域都不在**；
  3. 实验复现：真实 enqueueDeferredInput（带 intent.queueItemId）入队后调 `setPendingInputDelivery(queueItemId → guide)` 返回 **false**、零事件——与真机 e2e S5 症状 100% 一致（ack accepted、无拒绝日志、UI 45s 零变化）；
  4. handler（commands/handlers/queue.ts:197-203）把 `changed=false` 仅 warn 吞掉 → ack 仍 accepted → 用户侧无任何反馈；
  5. 为什么单测/实现双双漏过：core 单测 makeRuntime **手工把 queue 项塞进 pendingInputs**（test-queue-item-delivery-toggle.mjs:63-81，id 人为对齐），从未走真实 admission 路径；bootstrap 投影测试直接喂构造事件。注释「queueItemId 与 pendingInputId 同一 id 空间，无需翻译」（handlers/queue.ts:4）的**id 对齐部分正确**（intent.queueItemId 经 inputIntentMetadata:45 → enqueueDeferredInput:238 落 pendingInputId），**错在域**：id 对齐了但项根本不进该方法查找的内存域。
- 改法（方向 A：窄改 core 查找域，不动 admission 分层）：
  1. `setPendingInputDelivery` 在「内存 miss 且 pendingSteerInputs miss」后增加第三查找域：queue fact 投影（`rebuildProjection()` 结果中承载普通排队项的集合——具体字段名实现时确认，即 pendingSteerInputs 的队列对应物；若 rebuildProjection 不含 queue 车道项则需提供等价查询）；
  2. 命中后按既有 held 回落同款模式处理（steering.ts:1034-1066 先例）：同值 return true；否则 appendEvent(TurnSteerDeliveryChanged{ pendingInputId, requestedDelivery, admittedDelivery, targetTurnId, intent(含改写后的 admittedDelivery) })——bootstrap 投影 reducer `onTurnSteerDeliveryChanged`（product-projection.ts:3484-3520）的 3487 守卫查的正是 snapshot.queue.items 域，链路现成，bootstrap 侧零改动；
  3. **消费侧打通验证（修复时必须确认的第二个隐藏断点）**：guide 车道的内联消费（firstInlineGuideIndex 动态扫描 steering.ts:445-454、turn-guide-drain 的取项来源）读的是内存 pendingInputs 还是含投影/账本项。若只读内存域，则投影域项切 guide 后永远不被内联消费——需让消费路径覆盖投影域项（如 drain 前重建内存项，或消费侧读 session_input 账本）。此项不定，修复即不完整；
  4. 同步改 handler 注释口径（handlers/queue.ts:4 的「同一 id 空间」表述补充域差异说明）。
- 验收/测试：
  1. core 回归测试：把本 CR 的复现实验固化为正式测试——走真实 `enqueueDeferredInput`（带 intent.queueItemId，模拟真机 busy admission 参数）入队 → `setPendingInputDelivery(queueItemId)` → 断言返回 true、TurnSteerDeliveryChanged 事件产生、事件 payload 的 intent.admittedDelivery 正确；同值二次调用返回 true 且零新事件；reserved 项仍拒绝（既有用例保持）；
  2. bootstrap 回归：既有投影测试（steer=steering/notRequested/fellBack 三态）保持全绿；
  3. 真机 e2e S5 复跑通过（driver 已在 cache/e2e-guide-toggle.mjs，工具循环任务制 busy 窗口口径）。
- 来源：手工 CR round 1（实验脚本逻辑，可直接改造为上述回归测试）：

```js
// 复现要点（在 feature/queue-item-guide-toggle 工作区）：
const rt = makeRuntime(); // steerable activeTurn + 空 pendingInputs + events 收集
await enqueueDeferredInput.call(rt, {
  input: "q1", delivery: "queue", inputId: "cmd-1111",
  intent: { sourceCommandId: "cmd-1111", queueItemId: "queue_cmd-1111", /* ... */ },
  traceContext,
});
rt.activeTurn.pendingInputs.length; // 0 —— 项不在内存域
const changed = await setPendingInputDelivery.call(rt, {
  pendingInputId: "queue_cmd-1111", delivery: "guide", traceContext,
});
changed; // false（bug）；修复后应为 true 且产生 TurnSteerDeliveryChanged
```

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

- open：spec「关键设计定案」声称「firstInlineGuideIndex 动态扫描 → 切换后项自然进入/移出 guide 子序列，core 消费侧零改动」——**消费侧零改动属实，但写侧（setPendingInputDelivery）在真机路径不可达**（P0-1），spec 的核心行为承诺未兑现。修复 P0-1 并确认消费侧（P0-1 改法第 3 点）后置 fixed；若消费侧需要改动，须回写 spec 对应小节。

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
| fix-spec-ready | yes |
| fix_spec_path | docs/iterations/oh-my-zcode-fork/features/queue-item-guide-toggle/cr-fix-spec.md |
| dag_version / review_round | 1 / 1 |
| P0 / P1 / P2（已写入 fix-spec） | 2 / 0 / 1 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | open: 1（随 P0-1 修复闭合，含消费侧确认） |
| C-orch | P0-2 已覆盖命令面语义 |
| C 类合并后 QA | 见「合并后 QA」 |
