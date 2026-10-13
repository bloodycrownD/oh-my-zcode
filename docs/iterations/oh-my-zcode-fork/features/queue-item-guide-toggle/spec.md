---
date: 2026-10-13
agile_trace: true
---

# queue-item-guide-toggle 实现规格（SPEC）

## 根因 / 方案摘要

投递模式（queue/guide）此前只在提交时由 followupMode 决定，提交后不可改。用户拍板：排队项需可随时在 queue ↔ guide 间切换（guide = 引导至下一轮工具调用后运行，即既有内联注入语义；与「立即」sendQueuedNow 的抢占语义区分）。

关键前提（实现前核实）：`firstInlineGuideIndex` 为**动态扫描**（`steering.ts:445-454` 按 `pendingInputDelivery(item) === "guide"` 实时 findIndex，非入队时固化）——切换 delivery 后项自然进入/移出 guide 子序列，**core 消费侧零改动**；该行为已用单测钉死防回归。

方案：新增轻量协议命令 `setQueueItemDelivery`，只改既有 `delivery.admitted` 值，不新增 schema 字段/值域、不新造调度优先级、不触 v1.0.6 队列五红线。

## 变更点清单

**packages/shared**

- `src/zcode-protocol-v4/command.ts`：新命令 `setQueueItemDelivery`，payload `{ queueItemId, delivery: "queue" | "guide" }`；注册进 `COMMANDS_REQUIRING_BASE_REVISION`（baseRevision CAS）。availability 门不新增（与 queueEdit 同为恒 ALLOWED——row 级门足够，避免牵动 formal-proof 裁决表）。
- `src/test-ids.ts`：`TID_V4_QUEUE_ITEM_GUIDE` / `TID_V4_QUEUE_ITEM_UNQUEUE_GUIDE`（闲置的 `TID_V4_QUEUE_ITEM_UP` 是上游「上移」遗留，不复用）。

**apps/zcode-cli/packages/core**

- `src/runtime/methods/steering.ts`：新增 `setPendingInputDelivery`（三层注册 agent-runtime / internal-methods / methods/index）。行为：
  - active turn 命中 pendingInputs → 改写 delivery，`appendEvent(TurnSteerDeliveryChanged)`；同值 toggle 为幂等 noop（不产事件，容 CommandInbox 重放/重复点击）。
  - active turn 已结束的 held 项 → `rebuildProjection` 后从 `pendingSteerInputs` 兜底命中，重发同 id 事件（v4 reducer 原地更新该行 delivery，同 editQueueItem 的 held 先例）；缺项返回 false。
  - 持久化不直写：走 events.ts 集中记账（`TurnSteerDeliveryChanged → updateSessionInputs`），与 core fallback 改投共用一条写入路径（`session_input` 表 CHECK delivery ∈ (startNow,guide,queue) 已含两值）。
- guide→queue 恢复后项保持 pendingInputs 原数组位（core 不改顺序），队列面板按原 FIFO 位回现。

**apps/zcode-cli/packages/bootstrap**

- `src/app/types.ts` + `src/app/input-facade.ts`：app facade 暴露 `setQueueItemDelivery`。
- `src/zcode-protocol-v4/commands/handlers/queue.ts`：handler 门序（按序）：投影命中（否则 `guard.queueItemDeliveryMissing`）→ `dispatch.state === "queued"`（reserved/promoting 拒绝 `guard.queueItemDeliveryLocked`，此时项归 sendQueuedNow promotion 主线所有，core `pendingInputReservations` 为第二道门）→ 同值 noop → core 改写（false = 并发 drain/reserve 竞态，留 warn 不报错，同 edit 竞态语义）。
- `src/zcode-protocol-v4/product-projection.ts`：`onTurnSteerDeliveryChanged`——用户 toggle 的 steer 态映射（guide→steering / queue→notRequested）与 core fallback（fellBack）区分。
- 测试脚本注册进 package.json：`scripts/test-queue-item-delivery-command.mjs`。

**packages/ui**

- `src/v4/ConversationQueueRow.tsx`（新，自 QueuePanel 拆出以守 maxFileLines）：行内新增「引导」按钮（禁用条件同 rowLocked = dispatch.state !== "queued" || editPending；行级 ACK 等待态防重复点击）。
- `src/v4/ConversationQueuePanel.tsx`：瘦身（-176 行），QueueRow 外置。
- `src/v4/ConversationPendingGuideList.tsx`：行内新增「恢复排队」按钮。
- `src/v4/useQueueItemDeliveryToggle.ts`（新 hook）：封装命令发送 + 行级 pending 态 + 身份恒定回调；readOnly 场景不注入。
- `src/v4/SessionPane.tsx` / `ConversationTimeline.tsx`：props 线程接通。
- i18n：zh/en 各 4 key（parity 5912=5912）。
- `CHANGELOG.md`：Unreleased 用户面条目。

## 状态所有者与事件顺序

```text
用户点击「引导」（队列面板行）
  → useQueueItemDeliveryToggle 发 setQueueItemDelivery(queueItemId, "guide", baseRevision)
    → CommandInbox session gate（串行 admission，baseRevision CAS）
      → handler 门序：missing / locked / noop / core.setQueueItemDelivery
        → pendingInputs 该项 delivery.admitted = "guide" + TurnSteerDeliveryChanged 事件
          → events.ts 记账 → updateSessionInputs 落 session_input
          → product-projection 更新 queue 行（steer=steering）
            → snapshot 下发 → pendingGuideProjection 将该项滤出 visibleQueue、转入待引导列表
              → 下一 tool 边界 turn-guide-drain 消费 guide 子序列最早一项（动态扫描）
```

「恢复排队」对称：guide→queue，项回 visibleQueue 原 FIFO 位，steer=notRequested。

## 测试策略

### 测试用例

- core（`apps/zcode-cli/packages/core/scripts/test-queue-item-delivery-toggle.mjs`，10 例）：双向改写、同值 noop、guide 消费序列动态包含/排除（全 queue→中间切 guide→切回）、ordinary queue 不挡 guide、held 回落、缺项 false。
- bootstrap（`apps/zcode-cli/packages/bootstrap/scripts/test-queue-item-delivery-command.mjs`，10 例）：schema/handler 门序（missing/locked/noop）、投影 steer 态区分、竞态 warn。
- 回归：`packages/ui/test/conversationProjectionCore.test.ts` 47/47。
- 门禁：根 typecheck 0 err；CLI turbo typecheck 全 successful；lint 74w/0e 基线持平；architecture:check 0 新增违规；i18n parity 相等；改动文件 oxfmt 通过。

## 风险与回滚方案

- 回滚即还原本分支 diff；已落库的 `TurnSteerDeliveryChanged` 事件与 `session_input` 行为既有 schema 容忍（旧版本读入仅忽略 delivery 变化，无结构破坏）。
- reserved/promoting 拒绝门保证与「立即」提升流程无所有权竞态；若未来 promotion 语义变更，guard 门序需同步审。
- 桌面端实机 E2E（真实 busy 会话中点击切换）未跑，风险集中在 UI 时序（行级 ACK 态已防抖）；上线后观察 `v4 setQueueItemDelivery missed` warn 频率可评估竞态面。
