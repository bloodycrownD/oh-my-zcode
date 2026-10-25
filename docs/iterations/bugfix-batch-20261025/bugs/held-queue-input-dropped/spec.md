---
date: 2026-10-25
agile_trace: true
---

# held-queue-input-dropped 实现规格（SPEC）

## 根因 / 方案摘要

两层：①UI 侧 `confirmationRequired` 分支缺 `return;`，确认状态被同函数尾部 `setHeldQueueConfirmation(null)` 覆盖；②CLI 侧 held 路由仍是 `choice`，且手动提升后没有恢复 `autoDrain`。两处叠加造成「输入被吞 + 暂停态不解除」。

## 变更点清单

| 文件 | 改动 |
|---|---|
| `packages/ui/src/v4/ConversationComposer.tsx` | `confirmationRequired` 分支补 `return;`（`:1271` 附近） |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.ts` | `computeInputRouting` 的 held 分支：`choice` → `enqueue`，reasonCode 改 `heldQueuePausesButAcceptsInput` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts` | 手动提升成功后 `setQueueAutoDrain(true)` + `afterLegacyStateMutation("queue_auto_drain_resumed")` |
| `apps/zcode-cli/packages/bootstrap/scripts/test-held-queue-routing.mjs` | 新增 6 例回归（含 sendQueuedNow 恢复语义 tripwire） |
| `packages/ui/test/composerHeldQueueGuard.test.ts` | 新增 1 例形状守卫（只保留 `return;` 用例；v1.0.26 版本里第二条断言 `textChangeSerialRef` 在 v1.0.20 不存在，已删） |

## 详细改动说明

- 路由改 `enqueue` 后，`session-flow.ts:112` 的 `routing !== "choice"` 早退成为 no-op，`V4HeldQueueDispositionRequiredError` 保留兜底；派生变化：held 态 `/goal` 也入队、账本 `requestedDelivery` 由 `startNow` 变 `queue`。
- `autoDrainPromotion` 分支的判断沿用当年实现，保证「提升其它队列项」不会误开自动派发。

## 测试策略

### 测试用例

- `test:held-queue-routing`：6 例，覆盖 held→enqueue 路由、立即发送恢复 autoDrain、非 held 态不受影响、reasonCode 变更。
- `composerHeldQueueGuard`：1 例，源码形状守卫 `return;` 存在且位于 `setHeldQueueConfirmation` 之后。

## 风险与回滚方案

- 风险：暂停态语义变更会让「停止」后自动继续派发已有队列项（用户拍板的预期行为）；若不接受，回滚 `projection-state.ts` 一处即可。
- 回滚：三个逻辑改动独立，revert 单个提交可恢复旧语义。
