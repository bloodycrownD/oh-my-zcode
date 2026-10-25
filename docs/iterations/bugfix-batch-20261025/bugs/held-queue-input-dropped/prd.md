---
date: 2026-10-25
dependency: iterations/bugfix-batch-20261025/prd.md
---

# held-queue-input-dropped Bug PRD

## 背景

用户手动中断（stop）一个会话后，队列里若还有待发消息，队列会进入「暂停」态（autoDrain=false，pauseReason=stopped）。此时再输入新消息，v1.0.20 走的是「clear / keep」选择框路由；而该分支在历史上被误删了一行 `return;`（提交 `24af3955` 拆遥测时），导致确认框刚弹出就被同函数的 `setHeldQueueConfirmation(null)` 覆盖、输入被清空且没有发出去。用户观感就是「一直显示运行中、想发消息发不出去、点停止也停不下来」。

## 现象描述

- 会话被中断后，输入框里的新消息发不出去（输入被清空，队列里没有）。
- 队列暂停横幅一直存在，「立即发送」点了之后暂停态不解除。
- 体感上像是「还在运行，关不掉」。

## 复现步骤

1. 会话正在生成时点停止（或发消息后中断），使队列进入 stopped 暂停态（队列里先留一条待发消息）。
2. 在输入框输入新内容并回车。
3. 观察：是否出现确认框、输入是否被清空、队列是否新增条目。
4. 在队列面板点「立即发送」，观察暂停横幅是否消失。

## 预期行为

- 暂停态下输入**照常入队**（用户已拍板语义：停止只暂停自动派发，不影响追加队列）。
- 「立即发送」把该条手动提出后**自动恢复派发**（autoDrain=true），暂停横幅消失。

## 实际行为

- 确认框被同步覆盖，输入被吞。
- 「立即发送」成功后没有恢复 autoDrain，暂停态残留。

## 影响范围

仅影响「队列暂停且仍有待发消息」这一窗口内的输入与手动提升；正常运行态不受影响。

## 验收标准

1. 暂停态输入新消息 → 进入队列，不弹确认框、不丢输入。
2. 「立即发送」后 autoDrain 恢复，横幅消失，后续消息正常自动派发。
3. `test:held-queue-routing` 6/6、`composerHeldQueueGuard` 1/1 通过。

## 回归测试要点

- held 路由由 `choice` 改为 `enqueue` 是**用户拍板的语义变化**：`/goal` 在暂停态同样入队；发送账本的 `requestedDelivery` 由 `startNow` 变为 `queue`。
- `V4HeldQueueDispositionRequiredError` 保留为兜底，旧客户端带 disposition 也不会报错。
