import type {
  ConversationDelta,
  SessionMagicContextUsage,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * FORK（D-13）：`usage.magicContext` 的**存在性**投影与 conflation。
 *
 * 抽成独立文件的理由与 `product-projection-bash-progress.ts` 相同：它是纯 usage
 * 状态整形，与投影的事件归约无关，留在 `product-projection.ts`（上游文件）里纯属
 * 冲突面。`ProductProjection` 只保留一个委托入口，签名不变。
 *
 * 这里只 `import type` 协议类型，不碰 `ProductProjection`/contracts，也不碰
 * `src/app/magic-context-usage-summary.ts`（那份静态 require `@zcode/magic-context`，
 * 会把 native sqlite 拖进投影模块图）。
 *
 * `magicContextUsageField` 同时服务冷恢复 `seedUsage` 的两条种子路径：种子只管 token
 * 水位，**不得**顺手抹掉已经下发的摘要（D-13）。
 */

/**
 * D-13：`usage` 里 magic-context 摘要键的**存在性**投影。
 *
 * 用它而不是 `{ magicContext: value }` 的原因是缺席语义：字段缺席 = 「关着/没读数」，
 * 写一个 `magicContext: undefined` 的键在 JSON 序列化后同样消失，但在**内存**里会让
 * `usage.magicContext !== undefined` 判据说谎。宁可显式 spread。
 */
export function magicContextUsageField(usage: SessionMagicContextUsage | undefined): {
  magicContext?: SessionMagicContextUsage;
} {
  return usage === undefined ? {} : { magicContext: usage };
}

/** D-13 conflation：逐字段相等（含 cache 的两个布尔）才视为「没变」。 */
export function sameMagicContextUsage(
  left: SessionMagicContextUsage,
  right: SessionMagicContextUsage,
): boolean {
  return (
    left.budgetTokens === right.budgetTokens &&
    left.usedTokens === right.usedTokens &&
    left.usedPercent === right.usedPercent &&
    left.compartmentCount === right.compartmentCount &&
    left.droppedTagCount === right.droppedTagCount &&
    left.droppedTagTokens === right.droppedTagTokens &&
    left.cache?.m0 === right.cache?.m0 &&
    left.cache?.m1 === right.cache?.m1
  );
}

export interface MagicContextUsageTransition {
  /** 下一份 usage；无变化时与入参**同引用**（调用方据此跳过 snapshot 替换）。 */
  usage: SessionUsageState;
  /** 无变化时为空数组。 */
  deltas: ConversationDelta[];
}

/**
 * D-13：magic-context 摘要的 side-state 迁移（`ProductProjection.applyMagicContextUsage`
 * 的实现体）。
 *
 * 它**不是**事件：`magic-context.db` 的读数由装配层（`create-app` → transform 端口）
 * 在每轮 pass / 每次 provider usage 落库之后主动推过来，走 publisher 的 delta 扇出。
 * 之所以不塞进 `session.events` 的 `model_complete`：那条事件要落事件日志、要参与
 * 冷恢复重放，而这份摘要**是纯派生态**（关掉 magic-context 就没有，重放一遍也只是把
 * 同一份库再读一次）。
 *
 * 缺席语义：`null`/缺省 ⇒ **移除** `usage.magicContext` 键，而不是写一份全零对象。
 * 「不知道」和「全是 0」在 UI 上是两件完全不同的事（前者整段不渲染）。
 *
 * conflation：逐字段相等时返回空 `deltas`，不下发空 patch——usage 是本投影里最高频的
 * 键之一，无变化的下发会把 delta 日志灌满。
 *
 * 不做 schema 校验：publisher 的 buffer 钳位测试推的是
 * `{ usedTokens, contextWindow, percentage }` 这种非 `SessionMagicContextUsage` 形状，
 * 靠 pass-through 才进得了缓冲。
 */
export function transitionMagicContextUsage(
  current: SessionUsageState,
  next: SessionMagicContextUsage | null | undefined,
): MagicContextUsageTransition {
  if (next === null || next === undefined) {
    if (current.magicContext === undefined) return { usage: current, deltas: [] };
    // 删键而非写全零：与 `magicContextUsageField` 同一条缺席语义的另一半。
    const { magicContext: _dropped, ...rest } = current;
    return { usage: rest, deltas: [{ op: "state.updated", patch: { usage: rest } }] };
  }
  if (current.magicContext !== undefined && sameMagicContextUsage(current.magicContext, next)) {
    return { usage: current, deltas: [] };
  }
  const usage: SessionUsageState = { ...current, magicContext: next };
  return { usage, deltas: [{ op: "state.updated", patch: { usage } }] };
}
