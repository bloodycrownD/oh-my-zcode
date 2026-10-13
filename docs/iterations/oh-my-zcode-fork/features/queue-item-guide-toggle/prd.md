---
date: 2026-10-13
dependency: []
---

# queue-item-guide-toggle Feature PRD

## 背景与变更动机

omz 运行中的后续操作（busy 时提交的输入）会进入排队队列（`ConversationQueuePanel`），当前投递模式在**提交时**由 followupMode 决定（排队 / 引导），提交后不可更改。用户希望：排队中的项可以随时切换投递方式——「在队列上加一个按钮——引导，点击后变为引导，再次点击变回排队」。

「引导」语义与用户对齐 = 仓库既有 guide 投递（设置文案：「在 omz 运行时将后续操作加入队列，或**引导至下一轮工具调用后运行**」）：切到引导后，该项进入 pendingGuide 内联注入序列，在当前轮下一个 tool 边界被引导执行；切回排队则回到普通 FIFO、消费时独立成轮。与既有「立即」按钮（sendQueuedNow，抢占当前轮）语义互斥区分。

上游 ZCode 无此按钮（投递模式提交后不可改），属 fork 新增 UX；协议 `delivery.admitted` 枚举已含 guide 值，无需扩展值域。

## 范围说明（相对原需求）

- 新增协议命令 `setQueueItemDelivery`：排队项投递车道 queue ↔ guide 双向切换（带 baseRevision CAS）。
- 不抢占当前轮、不新增调度优先级、不改 auto-drain 与 guide 内联消费的既有规则。
- reserved/promoting（已被「立即」提升流程锁定）的项不可切换。
- UI 双侧入口：队列面板每行「引导」按钮（queue→guide，切走后项转入时间线待引导列表）；待引导列表行「恢复排队」按钮（guide→queue，项回到队列面板原 FIFO 位）。

## 影响模块与接口

- `packages/shared`：zcode-protocol-v4 `command.ts`（新命令 payload + baseRevision 注册）、test-ids。
- `apps/zcode-cli/packages/core`：`steering.ts` 新增 `setPendingInputDelivery`（三层注册：agent-runtime / internal-methods / methods/index）；事件走既有 `TurnSteerDeliveryChanged`，持久化复用 events.ts 集中记账 → `updateSessionInputs`，不新增写入路径。
- `apps/zcode-cli/packages/bootstrap`：app facade（types.ts + input-facade.ts）、`handlers/queue.ts` handler（`guard.queueItemDeliveryMissing` / `guard.queueItemDeliveryLocked`）、product-projection 投影。
- `packages/ui`：`ConversationQueueRow.tsx`（新文件，自 QueuePanel 拆出）、`ConversationQueuePanel.tsx` 瘦身、`ConversationPendingGuideList.tsx`、`useQueueItemDeliveryToggle.ts`（新 hook，行级 ACK 等待态）、SessionPane/Timeline 线程 props。
- v1.0.6 队列五红线（出队模型活值、不写回会话态、执行域豁免、idle-only lease、settle 不阻塞）全部不动。

## 验收标准

1. busy 时排队项行内出现「引导」按钮；点击后该项从队列面板消失、转入时间线待引导列表，并在当前轮下一个 tool 边界被内联执行。
2. 待引导列表行内「恢复排队」按钮；点击后项回到队列面板原 FIFO 位，恢复普通排队语义。
3. guide 消费序列按 delivery 动态判定：切换后项自然进入/移出 guide 子序列；普通 queue 项不可偷跑的既有规则不变。
4. reserved/promoting 中的项点击切换被拒绝（guard），不破坏「立即」提升流程的 stop barrier 语义。
5. 同值重复点击为幂等 noop（不产事件）；baseRevision 过期按既有 CAS 语义拒绝。
6. active turn 已结束的 held 项（仅存于投影/事件日志）切换时走投影兜底更新，不报错。
7. i18n parity 相等；typecheck / lint 基线 / architecture:check 无新增违规。

## 测试用例

- core（`scripts/test-queue-item-delivery-toggle.mjs`，10 例）：双向切换改写 pendingInputs、同值 noop、guide 消费序列动态包含/排除（三项全 queue → 中间项切 guide → 切回）、ordinary queue 不挡 guide、held 回落、缺项 false。
- bootstrap（`scripts/test-queue-item-delivery-command.mjs`，10 例）：协议 schema/handler 门序（missing/locked/noop）、投影三层、steer 状态区分（用户 toggle guide→steering / queue→notRequested vs core fallback→fellBack）。
- 回归 `packages/ui/test/conversationProjectionCore.test.ts` 47/47。
