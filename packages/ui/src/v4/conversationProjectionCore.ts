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
import { createConversationTurnRenderUnitsCache } from "./conversationTurnRenderUnits.js";

// renderUnits 增量构建器（缓存句柄模式）在这里再导出一次，让 core 成为投影侧纯逻辑的
// 唯一入口：store、组件、单测都从 core 取，不再各自 import v4 下的构建器文件。
export {
  buildConversationTurnRenderUnits,
  createConversationTurnRenderUnitsCache,
  type BuildConversationTurnRenderUnitsOptions,
  type ConversationTurnRenderUnit,
  type ConversationTurnRenderUnitsCache,
  type ConversationTurnRenderUnitsMutation,
} from "./conversationTurnRenderUnits.js";

/**
 * 共享的 renderUnits 增量缓存句柄。
 *
 * ConversationTimeline 的 `renderUnits` 与 SessionPane 的 `shareRenderUnits` /
 * `shareItems` 是同一次渲染里对同一份 `rows.window` 的两份派生——过去各自全量重建。
 * 共用一个句柄后，后一份直接命中前一帧写下的缓存条目（命中判定靠调用方给的
 * `lastMutation` 与句柄内部的失效锚点，与调用顺序无关）。
 * 换会话由 `scopeKey` 触发整表清空，turnId 撞号也拿不到别家的条目。
 */
export const conversationTurnRenderUnitsCache = createConversationTurnRenderUnitsCache();

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
 * 本帧的变更定位：变更行 rowId → turnId。
 *
 * 协议 delta 里只有 `row.appended` / `row.upserted` 携带整行（因此自带 turnId）；
 * `row.delta` 与 `row.removed` 只给 rowId，必须由本层从累加器命中的行反解 turnId，
 * 否则消费方（renderUnits 增量构建器）无法判断哪几轮失效。
 */
export interface ConversationProjectionLastMutation {
  /** 帧的右端点 seq，与同帧发布的 snapshot.seq 对齐，便于消费方断言同代。 */
  seq: number;
  /** 本帧变更行的 rowId → turnId。 */
  turnIdByRowId: ReadonlyMap<number, string>;
}

/**
 * 收集一帧 delta 触及的行 → turnId。必须在 apply **之前**取：`row.removed` 之后
 * 行索引与窗口都被裁掉，届时已经无从反解；`row.delta` 虽只就地改 text（turnId 不变），
 * 但读旧行同样安全且更省一次索引查找。
 */
function collectMutationTurnIds(
  accumulator: MutableConversationSnapshotAccumulator,
  deltas: readonly ConversationDelta[],
): Map<number, string> {
  const turnIdByRowId = new Map<number, string>();
  const window = accumulator.snapshot.rows.window;
  for (const delta of deltas) {
    switch (delta.op) {
      case "row.appended":
      case "row.upserted":
        // upsert 可能把行改挂到别的 turn 上，取新行的 turnId 才是本帧的落点。
        turnIdByRowId.set(delta.row.rowId, delta.row.turnId);
        break;
      case "row.delta": {
        const index = accumulator.rowIndexById.get(delta.rowId);
        const row = index === undefined ? undefined : window[index];
        if (row) turnIdByRowId.set(row.rowId, row.turnId);
        break;
      }
      case "row.removed": {
        // 窗口按 rowId 升序，fromRowId 之后的连续后缀整段被裁；逐行记 turnId，
        // 好让「被裁掉一半的轮」也能失效（否则它的 unit 会留着已不存在的行）。
        for (const row of window) {
          if (row.rowId < delta.fromRowId) continue;
          turnIdByRowId.set(row.rowId, row.turnId);
        }
        break;
      }
      default:
        // state.updated / workflowRun.* 不触及行，无需失效任何轮。
        break;
    }
  }
  return turnIdByRowId;
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
  /**
   * 最近一次 applyDeltas 的变更定位（rowId → turnId）；未 apply 过 delta 帧时为 null。
   * 必须在 applyDeltas 之后立即读——下一次 apply 会覆盖它。
   */
  lastMutation(): ConversationProjectionLastMutation | null;
  /** 取一份当前状态的外壳副本（只读快照，不推进任何状态）。 */
  publish(): ConversationSnapshot;
}

export function createConversationProjectionAccumulator(
  base: ConversationSnapshot,
): ConversationProjectionAccumulator {
  const accumulator = createMutableConversationSnapshotAccumulator(base);
  let lastMutation: ConversationProjectionLastMutation | null = null;
  return {
    applyDeltas(deltas, toSeq) {
      const turnIdByRowId = collectMutationTurnIds(accumulator, deltas);
      applyConversationDeltasMutable(accumulator, deltas);
      accumulator.snapshot.seq = toSeq;
      // 空 delta 帧（如纯 state.updated 水位推进）也要发布 lastMutation：
      // 消费方据此知道「本帧无行变更」，只有失效锚点那一轮需要重算。
      lastMutation = { seq: toSeq, turnIdByRowId };
      return publishConversationShell(accumulator);
    },
    lastMutation() {
      return lastMutation;
    },
    publish() {
      return publishConversationShell(accumulator);
    },
  };
}
