// @/-free 下沉模块：conversation projection 的纯逻辑。
//
// 可测性硬约束：被测模块的传递依赖链必须零 `@/` 导入（Node/tsx 下无别名解析），
// 因此这里只允许相对路径与 `@zcode/*` 包导入，不允许 import UI 侧 logger / memoryDiagnostics
// 或任何 React/浏览器全局。后续 renderUnits 增量构建器同样写进本文件；
// conversationProjectionStore.ts 改为 import 并 re-export，保持既有外部引用不破。
import {
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type MutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * rows/range 结果并入本地窗口（合并规范）：按 rowId 键控、只收
 * 窗口首行之前的行、去重后前插；顺序键 = rowId 升序（全序保证）。
 * 返回 null 表示无可并入行（窗口无变化，调用方不换引用）。
 */
export function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}

/**
 * copy-on-notify 发布：把累加器当前状态复制成可以交给订阅者的外壳副本。
 *
 * 三层引用必须同时换新，否则下游静默不更新（renderer 侧的硬约束，不是性能优化）：
 * - `rows.window`：约 15 处 `[snapshot?.rows.window]` memo 依赖
 *   （SessionPane.tsx:643/670/678/740/746/754/962/1132/1691/1697/3757、
 *   useTreemappingConversationMessage.ts:97 等），引用不换则这些 memo 全部不更新；
 * - `rows`：只换 window 漏掉 rows 对象会留下半旧半新的窗口容器；
 * - `snapshot`：`usePendingCommandRecovery.ts:36` 等 `[snapshot]` effect 依赖。
 *
 * 累加器本体继续持有自己的 window 数组，下一帧的原地 push/覆盖不会写穿这份副本——
 * 这也是「发布外壳副本而非 accumulator 本体」的原因：本体是活的，外壳是那一帧的定格。
 * `firstRowId`（hasOlderRows 判定是否还有更早历史）与 `totalCount`（滚动条估计与
 * debug 日志）随 rows 副本一起带出，不得在发布边界丢失。
 */
function publishConversationShell(
  accumulator: MutableConversationSnapshotAccumulator,
): ConversationSnapshot {
  const { snapshot } = accumulator;
  const window = [...snapshot.rows.window];
  const rows = { ...snapshot.rows, window };
  return { ...snapshot, rows };
}

/**
 * renderer 侧的 delta 应用包装：内部持有可变累加器，通知边界做 copy-on-notify。
 *
 * 分派逻辑一行都不重写——可变入口直接用 apply.ts 的 `applyConversationDeltasMutable`
 * （服务端 product-projection.ts 的冷恢复批量路径同款），因此 renderer 与协议规范
 * 实现不可能走散。
 */
export interface ConversationProjectionAccumulator {
  /**
   * 逐帧原地应用 delta、把 seq 显式推进到帧右端点，返回本次通知可发布的外壳副本。
   * seq 必须显式写：delta 语义里 seq 是快照对齐水位，不是行内容的一部分。
   */
  applyDeltas(deltas: readonly ConversationDelta[], toSeq: number): ConversationSnapshot;
  /** 取一份当前状态的外壳副本（只读快照，不推进任何状态）。 */
  publish(): ConversationSnapshot;
}

export function createConversationProjectionAccumulator(
  base: ConversationSnapshot,
): ConversationProjectionAccumulator {
  const accumulator = createMutableConversationSnapshotAccumulator(base);
  return {
    applyDeltas(deltas, toSeq) {
      applyConversationDeltasMutable(accumulator, deltas);
      accumulator.snapshot.seq = toSeq;
      return publishConversationShell(accumulator);
    },
    publish() {
      return publishConversationShell(accumulator);
    },
  };
}
