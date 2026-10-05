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
  type ConversationTopicFrame,
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

// ─────────────────────────── turn 目录失效代际 + 重查去抖 ───────────────────────────

/**
 * 问题导航目录（turnNavigator 窄投影）是否需要失效。
 *
 * not-enough-queries / hydrated 终态曾只以 logEpoch 判定有效，导致同一 epoch 内追加
 * real-user query 后仍永久命中缓存。判定条件（append/upsert/removed 三类帧）：
 * - snapshot 整体替换 → true（全新状态，终态作废）；
 * - row.removed → true（rewind/分支裁剪改变可导航 query 集合）；
 * - row.appended/row.upserted 命中 realUser userInput → true（新增/变更用户问题）；
 * - 其余 delta（assistant text、tool、reasoning 流式）→ false，不触发重查。
 *
 * 失效代际只服务「要不要重查目录」这一个闸门；目录结果自身的新鲜度由服务端随读返回的
 * `atRevision`/`atLogEpoch` 裁决（陈旧读丢弃）。两者是代际分工，谁也不替代谁。
 */
export function shouldInvalidateTurnNavigatorDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

/** 目录失效代际的下一值：命中失效帧 +1，否则原值透传（未失效时不换引用）。 */
export function nextTurnNavigatorDirectoryRevision(
  currentRevision: number,
  frame: ConversationTopicFrame,
): number {
  return shouldInvalidateTurnNavigatorDirectory(frame) ? currentRevision + 1 : currentRevision;
}

/**
 * 目录重查去抖窗口（trailing，写死 250ms）。
 *
 * 服务端每次目录查询都从全量投影行现算 O(总行数)。流式回答期间 snapshot 帧密集到达，
 * 逐帧重查会把一个只读窄投影打成 RPC 风暴；250ms trailing 把窗口内的多次 revision
 * 变更合并成一次查询，代价是最坏情况多等 250ms。
 */
export const TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS = 250;

/** 可注入的定时器面（单测用假时钟驱动，不依赖真实 250ms 等待）。 */
export interface TrailingDebounceTimers {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_DEBOUNCE_TIMERS: TrailingDebounceTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TrailingDebouncer {
  /** 合并式调度：pending 期间的重复调用只重置触发时间，不新增一次执行。 */
  schedule(): void;
  cancel(): void;
  /** 是否已排队未执行（单测断言「合并为一次」的观测点）。 */
  readonly pending: boolean;
}

/**
 * trailing 去抖器。store 用它把「revision 变更 → 目录重查」压成一次查询。
 *
 * 与 `refreshPlans` 的 pending 标记是两种不同的合并：那是「在途时再排一次」，
 * 这里是「窗口内无论来几次都只跑最后一次」，前者保证不漏、后者保证不抖。
 */
export function createTrailingDebouncer(
  delayMs: number,
  run: () => void,
  timers: TrailingDebounceTimers = DEFAULT_DEBOUNCE_TIMERS,
): TrailingDebouncer {
  let handle: unknown = null;
  return {
    get pending() {
      return handle !== null;
    },
    schedule() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => {
        handle = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (handle === null) return;
      timers.clearTimeout(handle);
      handle = null;
    },
  };
}

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
 * rows 容器的两个标量字段是否逐字段相同（window 是数组引用，不在此列）。
 *
 * 单独抽出来是因为「本帧没裁到任何窗口行」并不等于「rows 容器可以直接复用」：
 * `row.removed` 命中 `firstRowId` 时走的是「整条活动分支被裁掉」分支，apply 会把
 * totalCount 归零、firstRowId 清空（见 apply.ts 的 removed 分支），而只要窗口本身
 * 就是空的，一行也不会进变更集。那种帧必须换新的 rows 容器，否则 hasOlderRows 与
 * 滚动条估计会读到上一帧的值。
 */
function sameRowsMeta(a: ConversationSnapshot["rows"], b: ConversationSnapshot["rows"]): boolean {
  return a.totalCount === b.totalCount && a.firstRowId === b.firstRowId;
}

/**
 * copy-on-notify 发布：把累加器当前状态复制成可以交给订阅者的外壳副本。
 *
 * **有行变更的帧**三层引用必须同时换新，否则下游静默不更新（renderer 侧的硬约束，
 * 不是性能优化）：
 * - `rows.window`：约 15 处 `[snapshot?.rows.window]` memo 依赖
 *   （SessionPane.tsx:643/670/678/740/746/754/962/1132/1691/1697/3757、
 *   useTreemappingConversationMessage.ts:97 等），引用不换则这些 memo 全部不更新；
 * - `rows`：只换 window 漏掉 rows 对象会留下半旧半新的窗口容器；
 * - `snapshot`：`usePendingCommandRecovery.ts:36` 等 `[snapshot]` effect 依赖。
 *
 * **无行变更的帧**（纯 `state.updated` 水位推进，或 delta 目标在窗口之外）只换
 * `snapshot` 外壳，`rows.window` 复用上一帧的引用：内容逐行相同却每帧换新，等于
 * 让上面那批 memo 在长会话里被无意义的帧反复打掉——这正是本轮旗舰指标的来源。
 * `rows` 容器是否一并复用由 sameRowsMeta 裁决（见其注释）。
 *
 * 累加器本体继续持有自己的 window 数组，下一帧的原地 push/覆盖不会写穿这份副本——
 * 这也是「发布外壳副本而非 accumulator 本体」的原因：本体是活的，外壳是那一帧的定格。
 * `firstRowId`（hasOlderRows 判定是否还有更早历史）与 `totalCount`（滚动条估计与
 * debug 日志）随 rows 副本一起带出，不得在发布边界丢失。
 */
function publishConversationShell(
  accumulator: MutableConversationSnapshotAccumulator,
  previous: ConversationSnapshot | null,
  rowsChanged: boolean,
): ConversationSnapshot {
  const { snapshot } = accumulator;
  // rowsChanged 的口径写死为「本帧变更集非空」（由调用方给，见 applyDeltas）：
  // row.delta 未命中窗口时压根不会进集合，因此空集就是「窗口未变」的安全代理。
  if (!rowsChanged && previous !== null && sameRowsMeta(previous.rows, snapshot.rows)) {
    return { ...snapshot, rows: previous.rows };
  }
  // 有行变更 → window 必换；无行变更但 rows 标量变了 → window 内容仍相同，复用引用，
  // 只换承载新标量的 rows 容器。
  const window =
    rowsChanged || previous === null
      ? [...snapshot.rows.window]
      : previous.rows.window;
  return { ...snapshot, rows: { ...snapshot.rows, window } };
}

/**
 * 本帧的变更定位：变更行 rowId → turnId。
 *
 * 协议 delta 里只有 `row.appended` / `row.upserted` 携带整行（因此自带 turnId）；
 * `row.delta` 与 `row.removed` 只给 rowId，必须由本层从累加器命中的行反解 turnId，
 * 否则消费方（renderUnits 增量构建器）无法判断哪几轮失效。
 */
export interface ConversationProjectionLastMutation {
  /** 本帧变更行的 rowId → turnId。 */
  turnIdByRowId: ReadonlyMap<number, string>;
}

/**
 * 在按 rowId 升序的窗口里找第一个 rowId >= target 的下标（不存在则为窗口长度）。
 *
 * 窗口升序是 rowsRange 契约保证的全序，apply 的 removed 分支本身也正是按这个升序做
 * 前缀压缩，所以「裁掉 fromRowId 起的连续后缀」的下界可以直接二分，不必逐行跳过前缀。
 * 全程只读 `rowId`，不解引用行内容。
 */
function lowerBoundByRowId(window: readonly ConversationRow[], target: number): number {
  let low = 0;
  let high = window.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const row = window[middle];
    if (row !== undefined && row.rowId < target) low = middle + 1;
    else high = middle;
  }
  return low;
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
        // 裁剪边界用二分下界定位：rewind 只裁末尾一两行时线性扫描要白走整个窗口，
        // 长会话里那是每帧 O(N)。窗口升序是 rowsRange 契约保证的全序，apply 的
        // removed 分支本身也正是按这个升序做前缀压缩。
        for (let index = lowerBoundByRowId(window, delta.fromRowId); index < window.length; index++) {
          const row = window[index]!;
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
  // 最近一次发布出去的外壳副本：无行变更帧要复用它的 rows 引用。
  let published: ConversationSnapshot | null = null;
  return {
    applyDeltas(deltas, toSeq) {
      const turnIdByRowId = collectMutationTurnIds(accumulator, deltas);
      applyConversationDeltasMutable(accumulator, deltas);
      accumulator.snapshot.seq = toSeq;
      // 空 delta 帧（如纯 state.updated 水位推进）也要发布 lastMutation：
      // 消费方据此知道「本帧无行变更」，只有失效锚点那一轮需要重算。
      lastMutation = { turnIdByRowId };
      published = publishConversationShell(accumulator, published, turnIdByRowId.size > 0);
      return published;
    },
    lastMutation() {
      return lastMutation;
    },
    publish() {
      // 只读发布不推进任何状态，但窗口可能是 rebuild 之后尚未 apply 过的中间态
      // （前插补拉 / 目录补齐都走这条路），内容确实与上一份外壳不同 →
      // 显式传 rowsChanged=true，不允许复用旧引用。
      published = publishConversationShell(accumulator, published, true);
      return published;
    },
  };
}
