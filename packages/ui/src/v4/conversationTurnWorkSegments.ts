import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroupFlowItems,
} from "./conversationCuaGroups.js";
import { buildConversationFlowItems } from "./conversationTurnFlowItems.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "./conversationTurnFlowItems.js";

export interface ConversationTurnWorkStatus {
  state: "running" | "completed" | "interrupted";
  durationMs?: number;
}

export interface ConversationTurnWorkSegment {
  key: string;
  triggerRow?: UserInputRow;
  flowItems: ConversationTurnFlowItem[];
  assistantWorkRows: AssistantWorkRow[];
  assistantHistoryRows: AssistantWorkRow[];
  assistantFollowingRows: AssistantWorkRow[];
  assistantHistoryDefaultOpen: boolean;
  workStatus?: ConversationTurnWorkStatus;
  /**
   * 本段工时的起算时刻，取值与 resolveSegmentDurationMs 逐分支同源。
   * durationMs 是构建期烘焙值，运行中显示必须靠它现算，避免整棵时间线每秒重渲染。
   */
  startedAt?: number;
}

export function resolveConversationTurnWorkStatus(
  header: TurnHeaderRow | undefined,
  workRows: readonly AssistantWorkRow[],
  isRunning: boolean,
  durationMs: number | undefined,
  isInterrupted = false,
): ConversationTurnWorkStatus | undefined {
  if (header?.executionKind === "controlOnly") return undefined;
  const hasWork =
    isRunning ||
    workRows.length > 0 ||
    (header?.executionKind === "agent" ? durationMs !== undefined : (durationMs ?? 0) > 0);
  if (!hasWork) return undefined;
  return {
    state: isRunning ? "running" : isInterrupted ? "interrupted" : "completed",
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function resolveConversationTurnWorkDurationMs(
  header: TurnHeaderRow | undefined,
): number | undefined {
  if (!header) return undefined;
  if (header.activeMs !== undefined) return header.activeMs;
  if (header.endedAt !== undefined) return Math.max(header.endedAt - header.startedAt, 0);
  // 这里只给「构建期烘焙」的静态工时：完成态缺 activeMs/endedAt 就返回 undefined，
  // 绝不能让历史「已工作」随时钟增长。运行中的「工作中 N 秒」不再由构建器按当前时钟
  // 外推——那要求每秒把 nowMs 送进整条时间线的构建，代价是整棵 ConversationTimeline
  // 重渲染；改由 WorkingDurationText 拿 segment.startedAt 自己 tick（见
  // resolveSegmentStartedAt，取值与本函数逐分支同源）。因此本函数不再接收 nowMs。
  return undefined;
}

interface DraftVisualWorkSegment {
  orderedRows: ConversationRow[];
  triggerRow?: UserInputRow;
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function splitVisualWorkSegments(rows: readonly ConversationRow[]): DraftVisualWorkSegment[] {
  const segments: DraftVisualWorkSegment[] = [];
  let current: DraftVisualWorkSegment = { orderedRows: [] };
  for (const row of rows) {
    if (isUserInputRow(row) && row.guided === true && current.orderedRows.length > 0) {
      segments.push(current);
      current = { orderedRows: [], triggerRow: row };
    }
    current.orderedRows.push(row);
  }
  if (current.orderedRows.length > 0) segments.push(current);
  return segments;
}

/** guide 段命中的协议工时事实；普通单段 turn 没有它（workSegments 是 optional）。 */
function resolveSegmentWorkFact(options: {
  header?: TurnHeaderRow;
  segmentIndex: number;
  triggerRow?: UserInputRow;
}): NonNullable<TurnHeaderRow["workSegments"]>[number] | undefined {
  return (
    (options.triggerRow?.entityId
      ? options.header?.workSegments?.find(
          (candidate) => candidate.triggerEntityId === options.triggerRow?.entityId,
        )
      : undefined) ?? options.header?.workSegments?.[options.segmentIndex]
  );
}

function resolveSegmentDurationMs(options: {
  header?: TurnHeaderRow;
  segmentIndex: number;
  triggerRow?: UserInputRow;
  nextTriggerRow?: UserInputRow;
  segmentCount: number;
}): number | undefined {
  const fact = resolveSegmentWorkFact(options);
  if (fact?.activeMs !== undefined) return fact.activeMs;
  if (fact?.endedAt !== undefined) return Math.max(0, fact.endedAt - fact.startedAt);
  if (options.segmentCount === 1) {
    return resolveConversationTurnWorkDurationMs(options.header);
  }
  // 兼容旧 guide snapshot：新 CLI 会下发 workSegments；仅旧数据缺事实时才按
  // guided row 的稳定时间边界恢复，避免刷新后又退回整个 turn 的单一工时。
  const startedAt = options.triggerRow?.createdAt ?? options.header?.startedAt;
  const endedAt = options.nextTriggerRow?.createdAt ?? options.header?.endedAt;
  if (startedAt !== undefined && endedAt !== undefined) return Math.max(0, endedAt - startedAt);
  // 运行中且缺 endedAt 的段不给 durationMs：外推当前时钟会让「已工作」随时间增长，
  // 而构建器已不再接收 nowMs。运行中展示由 WorkingDurationText 按 startedAt 现算。
  return undefined;
}

/**
 * 本段工时起算时刻。必须与 resolveSegmentDurationMs 逐分支同源：
 * 有 fact → fact.startedAt；无 fact 且单段 → header.startedAt（普通单段 turn 走
 * resolveConversationTurnWorkDurationMs 的 header 分支，不是 triggerRow.createdAt）；
 * 无 fact 且多段（旧 guide 数据）→ triggerRow.createdAt ?? header.startedAt。
 * 分支写错会让运行中时长恒 0 或恒等于整轮时长。
 */
function resolveSegmentStartedAt(options: {
  header?: TurnHeaderRow;
  segmentIndex: number;
  triggerRow?: UserInputRow;
  segmentCount: number;
}): number | undefined {
  const fact = resolveSegmentWorkFact(options);
  if (fact) return fact.startedAt;
  if (options.segmentCount === 1) return options.header?.startedAt;
  return options.triggerRow?.createdAt ?? options.header?.startedAt;
}

export function buildConversationTurnWorkSegments(options: {
  key: string;
  header?: TurnHeaderRow;
  orderedRows: readonly ConversationRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  latestAssistantTextRow?: AssistantTextRow;
  isRunning: boolean;
  isLastTurn: boolean;
  isInterrupted: boolean;
  forceOpenHistory: boolean;
  timelineOnly: boolean;
}): ConversationTurnWorkSegment[] {
  const visualDrafts = splitVisualWorkSegments(options.orderedRows);
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  return visualDrafts.map((segment, segmentIndex) => {
    const segmentAssistantRows = segment.orderedRows.filter(isAssistantWorkRow);
    const segmentTailRows = segmentAssistantRows.filter((row) => tailRowIds.has(row.rowId));
    const segmentFlowRows = segmentAssistantRows.filter((row) => !tailRowIds.has(row.rowId));
    const lastSegmentFlowRow = segmentFlowRows.at(-1);
    const segmentCompleted = segmentIndex < visualDrafts.length - 1 || !options.isRunning;
    const productLatestAssistantTextRow = options.latestAssistantTextRow
      ? segmentFlowRows.find((row) => row.rowId === options.latestAssistantTextRow?.rowId)
      : undefined;
    const visibleAssistantTextRow =
      productLatestAssistantTextRow && isAssistantTextRow(productLatestAssistantTextRow)
        ? productLatestAssistantTextRow
        : segmentCompleted && lastSegmentFlowRow && isAssistantTextRow(lastSegmentFlowRow)
          ? lastSegmentFlowRow
          : undefined;
    const visibleAssistantIndex = visibleAssistantTextRow
      ? segmentFlowRows.findIndex((row) => row.rowId === visibleAssistantTextRow.rowId)
      : -1;
    const segmentHistoryRows = options.timelineOnly
      ? []
      : visibleAssistantIndex < 0
        ? segmentFlowRows
        : segmentFlowRows.slice(0, visibleAssistantIndex);
    const segmentFollowingRows =
      visibleAssistantIndex < 0 ? [] : segmentFlowRows.slice(visibleAssistantIndex + 1);
    const segmentRunning = segmentIndex === visualDrafts.length - 1 && options.isRunning;
    const segmentDurationMs = resolveSegmentDurationMs({
      header: options.header,
      segmentIndex,
      triggerRow: segment.triggerRow,
      nextTriggerRow: visualDrafts[segmentIndex + 1]?.triggerRow,
      segmentCount: visualDrafts.length,
    });
    const segmentStartedAt = resolveSegmentStartedAt({
      header: options.header,
      segmentIndex,
      triggerRow: segment.triggerRow,
      segmentCount: visualDrafts.length,
    });
    const segmentWorkStatus = resolveConversationTurnWorkStatus(
      options.header,
      segmentFlowRows,
      segmentRunning,
      segmentDurationMs,
      options.isInterrupted && segmentIndex === visualDrafts.length - 1,
    );
    const segmentKey =
      segmentIndex === 0
        ? options.key
        : `${options.key}:guide:${segment.triggerRow?.entityId ?? segment.triggerRow?.rowId ?? segmentIndex}`;
    const flowItems = buildConversationFlowItems({
      orderedRows: segment.orderedRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantTailRows: segmentTailRows,
      ...(visibleAssistantTextRow ? { visibleAssistantTextRow } : {}),
      ...(options.latestAssistantTextRow
        ? { latestAssistantTextRow: options.latestAssistantTextRow }
        : {}),
      timelineOnly: options.timelineOnly,
    });
    return {
      key: segmentKey,
      ...(segment.triggerRow ? { triggerRow: segment.triggerRow } : {}),
      flowItems: prepareCuaGroupFlowItems(flowItems, {
        enabled: ENABLE_CUA_TOOL_CALL_GROUPING,
        stageTailIsRunning: segmentRunning,
      }),
      assistantWorkRows: segmentAssistantRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantHistoryDefaultOpen:
        !options.timelineOnly &&
        (options.forceOpenHistory ||
          (options.isLastTurn && segmentWorkStatus?.state === "running") ||
          (visualDrafts.length === 1 &&
            visibleAssistantTextRow === undefined &&
            segmentFlowRows.length > 0)),
      ...(segmentWorkStatus ? { workStatus: segmentWorkStatus } : {}),
      ...(segmentStartedAt !== undefined ? { startedAt: segmentStartedAt } : {}),
    };
  });
}
