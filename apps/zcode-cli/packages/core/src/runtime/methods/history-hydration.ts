// 懒历史的闸门（spec Step 12 / IS7）。
//
// 背景：`historyMode:"none"` 的 resume 只做 readFileState 与标量，**不**碰 provider 历史；
// view-only 激活因此不必等 O(active × parts) 的历史水化。代价是「history 里有东西」这件事
// 变成一个需要显式补齐的水位——任何把历史交给模型的入口都必须先过这里，否则模型看到的
// 是空会话（比慢更糟：它会重复已完成的工作）。
//
// 顺序是硬约束，不是风格：
//   1. `ensureContextInitialized` 内部的 `messageHistory.init()` **清空 entries**；
//   2. 因此 init 必须早于 hydrate；
//   3. resume 期已经写进 history 的提醒条目（shell / target / SessionStart hook）在 init 时
//      被清掉，必须在 hydrate **之后**按原顺序补回——「先 init 再 hydrate 再注入」正是
//      `historyMode:"full"` 的既有顺序，T-SL13 的逐字节相等依赖它。

import { hydrateMessageHistoryFromSession, traceContextToLogContext } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** resume 收尾登记「稍后要补的水化」，并快照当时已经写进 history 的条目。 */
export function deferHistoryHydration(
  this: AgentRuntimeInternal,
  rewind: {
    branchCutAfterMessageId?: MessageId;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  },
): void {
  this.deferredHistoryHydration = {
    ...rewind,
    resumeEntries: this.messageHistory.toRuntimeEntries(),
  };
  // 快照之后必须把这批条目从**活着的** history 里摘掉：闸门的第一步是 init，而 init 会
  // 把「当前 entries」整个接在 context 前缀之后——不摘就会变成
  // `context → 提醒 → 历史`（提醒跑到对话前面），与 `"full"` 的
  // `context → 历史 → 提醒` 分叉。摘掉是安全的：闸门跑之前没有人该读 provider 历史。
  this.messageHistory.init();
}

/**
 * 任何一次完整水化（闸门或 rewind 重建）都要清掉待办，否则下一次发轮会再水化一遍，
 * 历史出现两份（同一批消息被追加两次）。
 */
export function clearDeferredHistoryHydration(this: AgentRuntimeInternal): void {
  this.deferredHistoryHydration = undefined;
}

/**
 * 发送闸门：把 `historyMode:"none"` 推迟的全量历史补到 provider 能看见的位置。
 * 无待办时是纯早退（不读 store、不建 context）。
 */
export async function hydrateDeferredMessageHistory(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const pending = this.deferredHistoryHydration;
  if (!pending) return;
  const startedAtMs = Date.now();
  // init 必须在 hydrate 之前：它清空 entries，反过来会把刚水化的历史冲掉。
  await this.ensureContextInitialized(traceContext);
  // 首次发送前重读一次持久正文：这是「发送时才需要完整历史」的兑现点。不复用 resume 的
  // 入参是刻意的——那个数组是激活时刻的快照，而发送才是真正需要权威当下的入口。
  const messages = (await this.sessionStore?.messages({ sessionID: this.sessionId })) ?? [];
  const hydration = await hydrateMessageHistoryFromSession({
    artifactStore: this.artifactStore,
    branchCutAfterMessageId: pending.branchCutAfterMessageId,
    history: this.messageHistory,
    messages,
    rewindCreatedMessageId: pending.rewindCreatedMessageId,
    rewindKeptMessageIds: pending.rewindKeptMessageIds,
    rewindTargetMessageId: pending.rewindTargetMessageId,
  });
  if (pending.resumeEntries.length > 0) {
    this.messageHistory.addEntries(pending.resumeEntries);
  }
  this.deferredHistoryHydration = undefined;
  this.logger?.info("Session history hydrated before first turn", {
    ...traceContextToLogContext(traceContext),
    appliedMessageCount: hydration.appliedMessageCount,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    event: "session.history.lazy_hydrated",
    interruptedToolCount: hydration.interruptedToolCount,
    messageCount: hydration.messageCount,
    module: "core.runtime",
    partCount: hydration.partCount,
    resumeEntryCount: pending.resumeEntries.length,
    sessionId: this.sessionId,
    status: "completed",
  });
}
