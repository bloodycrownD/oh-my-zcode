// 轨迹回合的计数口径与计数行段序列（纯函数，无 React、无 `@/` 别名）。
//
// 硬约束：本模块被 packages/ui/test/modelTrajectoryTurnCounts.test.ts 以 node:test + tsx 直测，
// 传递依赖链上不能出现 React 或 `@/` 别名导入（tsx 下别名不可解析）——
// 只允许相对导入或依赖包裸名导入（先例 ModelTrajectoryToolJoin.ts:6-11）。
//
// 口径集中在本模块（spec N-7 / ④）：改口径单点改，别处只消费结果。
import type { TrajectoryTurnGroup, TrajectoryTurnStats } from "./ModelTrajectoryTurns.js";
import { resolveTrajectoryPrimaryCalls } from "./ModelTrajectoryTurns.js";
import { formatTrajectoryDuration } from "./ModelTrajectoryFormat.js";
import { trajectoryToolCallInputs } from "./ModelTrajectoryToolPayload.js";
import type { ZCodeModelTrajectoryContentPart } from "@zcode/services";

/** 一个回合的计数快照（口径见 spec ④）。 */
export interface TrajectoryTurnCounts {
  /** 工具调用次数：Σ 各主调用中 kind === "tool-call" 的条目数（只数不动数组）。 */
  toolCallCount: number;
  /**
   * 输出侧字数：Σ (response.text?.length ?? 0) + (reasoningText?.length ?? 0)
   * + use 段长度（工具调用输入按同源分隔符 "\n\n" join）。
   *
   * 口径细节：length 不 trim、undefined → 0；reasoningText 计入且随 reasoning 投影变化
   * （关闭思考过程后字数相应减小——所见即所得）；只覆盖 use 段，不含工具结果正文。
   */
  charCount: number;
  /** 失败数 = modelErrorCount + toolErrorCount（回合头红色图标与数字同源）。 */
  failureCount: number;
  /** 模型调用报错数：record.error 真值的条目数。 */
  modelErrorCount: number;
  /** 工具报错数：配对状态为 "error" 的条目数。 */
  toolErrorCount: number;
}

/**
 * 计数行的一段：
 * - i18n 段：`{ id, values }`，values 供 intl.formatMessage 插值；
 * - 原样字符串段：时长等非 i18n 文本（直接渲染）。
 * 分隔符由组件层插入，本模块只产出段序列。
 */
export type TrajectoryTurnCountSegment =
  | { id: string; values?: Record<string, string | number> }
  | string;

/** 主调用里 kind === "tool-call" 的条目（计数过滤用，不改数组本身）。 */
function isToolCallPart(part: ZCodeModelTrajectoryContentPart): boolean {
  return part.kind === "tool-call";
}

/**
 * 单次调用的 use 段长度（工具调用输入的展示文本长度）。
 *
 * 与 ToolJoin 的 displayText 同源：同一份 trajectoryToolCallInputs 口径，
 * 多条工具调用之间按 "\n\n" join（与展示一致，分隔符计入字数）。
 */
function countUseSegmentLength(parts: readonly ZCodeModelTrajectoryContentPart[]): number {
  const useParts = parts.filter(isToolCallPart);
  if (useParts.length === 0) return 0;
  return trajectoryToolCallInputs({ role: "assistant", parts: useParts }).join("\n\n").length;
}

/**
 * 回合计数（spec ④）：全部字段基于 primaryCalls（排除 sidecar；全 sidecar 时回退全部），
 * 与回合预览口径同源（resolveTrajectoryPrimaryCalls 为共享派生，不双写）。
 *
 * - toolCallCount：Σ kind === "tool-call" 的条目数（计数过滤不动数组）；
 * - charCount：输出侧字数（text + reasoningText + use 段）；
 * - modelErrorCount：record.error 真值条数；
 * - toolErrorCount：配对状态 "error" 的条目数；
 * - failureCount：两者之和。
 */
export function resolveTrajectoryTurnCounts(group: TrajectoryTurnGroup): TrajectoryTurnCounts {
  const primaryCalls = resolveTrajectoryPrimaryCalls(group);

  let toolCallCount = 0;
  let charCount = 0;
  let modelErrorCount = 0;
  let toolErrorCount = 0;

  for (const call of primaryCalls) {
    const response = call.record.response;
    toolCallCount += call.toolCalls.filter((info) => isToolCallPart(info.part)).length;
    charCount += (response?.text?.length ?? 0) + (response?.reasoningText?.length ?? 0);
    charCount += countUseSegmentLength(call.toolCalls.map((info) => info.part));
    if (call.record.error) modelErrorCount += 1;
    toolErrorCount += call.toolCalls.filter((info) => info.status === "error").length;
  }

  return {
    toolCallCount,
    charCount,
    failureCount: modelErrorCount + toolErrorCount,
    modelErrorCount,
    toolErrorCount,
  };
}

/**
 * 计数行的段序列（spec ④ / T-N6 逐字锁定）：
 *
 * 1. summaryCalls（count 取 stats.callCount，含 sidecar——与面板头现状一致）；
 * 2. turn.toolCalls（toolCallCount = 0 时省略）；
 * 3. turn.charCount（恒显示）；
 * 4. turn.failureCount（= 0 时省略；非零时整段红色）；
 * 5. 时长字符串段（formatTrajectoryDuration 原样产出，非 i18n 段；durationMs = 0 时省略）；
 * 6. 每个调用来源一段（保持首次出现顺序）。
 */
export function formatTurnCounts(
  stats: TrajectoryTurnStats,
  counts: TrajectoryTurnCounts,
): TrajectoryTurnCountSegment[] {
  const segments: TrajectoryTurnCountSegment[] = [
    { id: "modelTrajectory.summaryCalls", values: { count: stats.callCount } },
  ];

  if (counts.toolCallCount > 0) {
    segments.push({
      id: "modelTrajectory.turn.toolCalls",
      values: { count: counts.toolCallCount },
    });
  }

  segments.push({ id: "modelTrajectory.turn.charCount", values: { count: counts.charCount } });

  if (counts.failureCount > 0) {
    segments.push({
      id: "modelTrajectory.turn.failureCount",
      values: { count: counts.failureCount },
    });
  }

  if (stats.durationMs > 0) {
    segments.push(formatTrajectoryDuration(stats.durationMs));
  }

  // 每来源一段，保持首次出现顺序。stats.sourceKinds 在回合构造时已按首次出现顺序去重。
  for (const kind of stats.sourceKinds) {
    segments.push({ id: `modelTrajectory.source.${kind}` });
  }

  return segments;
}
