// renderUnits 的「单轮物化」层：把一轮 draft 的协议行切分成可见性桶，再物化成
// ConversationTurnRenderUnit（含 workSegments / flowItems——真正贵的部分）。
//
// 与 conversationTurnRenderUnits.ts 的分工：那边管「多轮怎么排」（分组、keep、归位、
// 增量缓存），这边管「一轮长什么样」。分文件是为了守住 max-lines 400 的有效行上限。
//
// 必须保持 `@/`-free（可测性硬 gate：Node/tsx 下无别名解析，被测模块传递依赖链零
// `@/` 才能 `npx tsx --test`），因此一律用同目录相对路径引入 v4 依赖。
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "./conversationTurnFlowItems.js";
import {
  isWorkflowLaunchUserInputRow,
  resolveWorkflowLaunchMeta,
} from "./workflowLaunchTurn.js";
import {
  buildConversationTurnWorkSegments,
  resolveConversationTurnWorkDurationMs,
  resolveConversationTurnWorkStatus,
} from "./conversationTurnWorkSegments.js";
import type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "./conversationTurnWorkSegments.js";

export type { AssistantWorkRow, ConversationTurnFlowItem } from "./conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "./conversationTurnWorkSegments.js";

export interface ConversationTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  visibleUserInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  /**
   * 所有 visual work segment 的历史行聚合，仅供复制、预览和旧调用兼容。
   * 实际折叠边界读取 workSegments，且各段内部必须保持 CLI row 全序。
   */
  assistantHistoryRows: AssistantWorkRow[];
  /** 操作正文锚点之后、真正轮尾 marker 之前的 row；保持 CLI 全序原位渲染。 */
  assistantFollowingRows: AssistantWorkRow[];
  assistantTailRows: AssistantWorkRow[];
  /** Browser 自动轮尾截图：完成态渲染在 file diff 摘要之后、消息操作栏之前。 */
  browserTurnEndRows: AssistantWorkRow[];
  /** turn-local Hook product rows；不进入 assistant work/折叠，只供轮尾详情 action。 */
  hookInvocations: HookInvocationRow[];
  /** 整轮全部 assistant text 段，用于复制/预览聚合，不代表渲染位置。 */
  assistantTextRows: AssistantTextRow[];
  /** 轻边界（modelChange）：渲染在 user 输入之前的轮顶分隔。 */
  leadingBoundaryRows: TimelineMarkerRow[];
  /** 完成态轮尾最终正文；fork/retry/action/preview 只挂这一段。 */
  latestAssistantTextRow?: AssistantTextRow;
  /** 同一 product turn 内 user/assistant 的可见交错顺序；相邻工作行保持成组。 */
  flowItems: ConversationTurnFlowItem[];
  /** 原始输入与每条 accepted guide 分别对应一个独立视觉工作段。 */
  workSegments?: ConversationTurnWorkSegment[];
  renderRows: ConversationRow[];
  isLastTurn: boolean;
  isRunning: boolean;
  assistantHistoryDefaultOpen: boolean;
  timelineOnly: boolean;
  /** turn 级聚合工作状态，仅供旧调用兼容；新组件消费 workSegments[].workStatus。 */
  workStatus?: ConversationTurnWorkStatus;
  startedAt?: number;
  /** 中枢直接启动轮的启动元数据（规则见 `workflowLaunchTurn.ts`）；在场时轮由 run 卡呈现、无用户气泡。 */
  workflowLaunch?: WorkflowLaunchMeta;
}

export interface BuildConversationTurnRenderUnitsOptions {
  sessionPhase?: SessionPhase;
  /**
   * 缓存作用域（会话标识）。共享缓存句柄被不同会话复用时切换此值即整体清空，
   * 避免 turnId 跨会话撞号时命中别家的缓存条目。
   */
  scopeKey?: string;
}

export interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

export function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

export function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

export function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

export function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

function isTimelineMarkerRow(row: ConversationRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker";
}

function isVisibleAssistantWorkRow(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // reasoning_start/reasoning_end 可能形成空的终态 block；只在共享
    // render-unit 边界裁掉它，避免 completed 状态绕过 streaming renderer 的空行过滤。
    return false;
  }
  // EnterPlanMode 只是内部模式切换边界，把它当普通工具放进“已工作”，
  // 会显示一条没有用户价值的“工具调用已执行”。只在 render unit 过滤，不改写协议投影，
  // 以保留 desktop continuous / web remote replayable 共用的运行态与恢复语义。
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  if (isUserInputRow(row)) return true;
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

// 落位语义（lane）由 CLI 投影裁决下发（UI 不得按 marker type 自行推断）。
// lane 缺省（不应发生）按 assistantWork 兜底——降级进折叠组，不丢行。
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/**
 * artifact 行是分享投影追加到轮尾的产出物（insertDiscoveredArtifacts 插在该
 * productTurn 最后一行之后），但它同样属于 AssistantWorkRow，会成为 flow 的最后一行。
 * 于是折叠锚点的兜底条件「最后一行是 assistantText」失效——公开投影禁止 actions，
 * 分享页只有这条兜底——最终答复被卷进「已工作」并整轮默认展开。
 *
 * 它是追加的产出物、不属于对话流，按轮尾处理即可；与 browserTurnEndRows 摘轮尾截图同理。
 * 注意不能改成「取 flow 里最后一条 assistantText」：那会把 CUA 响应中途的正文
 * 提升成最终答复，拆散同一个 assistantResponseId 的分组。
 */
function isTurnTrailingArtifactRow(row: AssistantWorkRow): boolean {
  return row.kind === "artifact";
}

function splitTurnTailRows(rows: readonly AssistantWorkRow[]): {
  flowRows: AssistantWorkRow[];
  tailRows: AssistantWorkRow[];
} {
  let tailStart = rows.length;
  while (
    tailStart > 0 &&
    (isTurnEndingTimelineMarkerRow(rows[tailStart - 1]!) ||
      isTurnTrailingArtifactRow(rows[tailStart - 1]!))
  ) {
    tailStart -= 1;
  }
  return {
    flowRows: rows.slice(0, tailStart),
    tailRows: rows.slice(tailStart),
  };
}

function isBrowserTurnEndRow(row: AssistantWorkRow): boolean {
  // 自动截图以完成态 tool row 持久化在最终正文之后，旧分组只把
  // timeline boundary 识别为轮尾，导致截图被搬进上方“已工作”折叠区而不可见。
  return (
    row.kind === "toolCall" &&
    row.display?.kind === "node_repl_images" &&
    row.display.source === "browser_turn_end"
  );
}

function isLightBoundaryMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "lightBoundary";
}

function isCompletionBlockingWorkRowRunning(row: AssistantWorkRow): boolean {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.state === "streaming";
    case "toolCall":
      return (
        row.backgrounded !== true &&
        (row.status === "inputStreaming" ||
          row.status === "pendingApproval" ||
          row.status === "running")
      );
    case "subagent":
      return row.backgrounded !== true && row.status === "running";
    case "timelineMarker":
      return "status" in row.marker && row.marker.status === "running";
    default:
      return false;
  }
}

export function createDraftUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // cold snapshot 可能从同一 turn 的 assistant/tool 行中间截断，补到
    // turnHeader 后首个可见 rowId 会变化。虚拟列表 key 必须只依赖协议稳定的 turnId，
    // 否则补页会把原 turn 当成新节点重挂，丢失测高缓存和视口锚点。
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

export function resolveTurnRunning(
  draft: DraftTurnRenderUnit,
  options: BuildConversationTurnRenderUnitsOptions,
): boolean {
  if (draft.header) {
    if (draft.header.executionKind === "controlOnly") return false;
    // turnHeader 是 projection 的权威轮次边界；已终态主轮不能被
    // 同轮仍在运行的 background tool/subagent 行重新推成 running。
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // cold snapshot 只保留尾窗时可能裁掉 turnHeader；旧 fallback 会把
    // 孤立的 inputStreaming/running tool row 重新推成 thinking，终态 control 必须优先。
    return false;
  }
  // 仅兼容缺少 turnHeader 的旧投影；background-only work 不阻塞主轮完成。
  return draft.assistantWorkRows.some(isCompletionBlockingWorkRowRunning);
}

export function shouldForceOpenAbnormalHistory(
  header: TurnHeaderRow | undefined,
  sessionPhase: SessionPhase | undefined,
): boolean {
  if (header) {
    return header.state === "completedInterrupted" || header.state === "failed";
  }
  return sessionPhase === "completedInterrupted" || sessionPhase === "error";
}

/**
 * 一轮 draft 的「可见性切分」：把协议行切成用户输入 / 助手工作 / 轻边界 / 轮尾等桶。
 *
 * 抽出成独立纯函数有两个原因：
 * 1. materialize 与增量缓存的 keep 判定必须逐字节同源——keep 只依赖本切分结果，
 *    两者共用同一个函数就等于把「缓存判定 ≡ 全量判定」写进类型里，而不是靠注释约定；
 * 2. materialize 里真正贵的只有 workSegments/flowItems 构建（多次 filter + Set），
 *    切分本身是廉价的一遍扫描，可以留给缓存未命中的增量路径单独执行。
 */
export interface DraftVisibility {
  workflowLaunch: WorkflowLaunchMeta | undefined;
  visibleUserInputs: UserInputRow[];
  visibleAssistantWorkRows: AssistantWorkRow[];
  visibleOrderedRows: ConversationRow[];
  timelineOnly: boolean;
  leadingBoundaryRows: TimelineMarkerRow[];
  leadingBoundaryRowIds: ReadonlySet<number>;
  bodyRows: AssistantWorkRow[];
  browserTurnEndRows: AssistantWorkRow[];
  browserTurnEndRowIds: ReadonlySet<number>;
  flowRows: AssistantWorkRow[];
  assistantTailRows: AssistantWorkRow[];
}

export function resolveDraftVisibility(draft: DraftTurnRenderUnit): DraftVisibility {
  const workflowLaunch = resolveWorkflowLaunchMeta(draft.header, draft.userInputs);
  // 启动轮的用户行由 run 卡代言，不进可见输入也不进流。
  const renderedRows =
    workflowLaunch === undefined
      ? draft.orderedRows
      : draft.orderedRows.filter((row) => !isWorkflowLaunchUserInputRow(row));
  const visibleUserInputs = renderedRows.filter(isUserInputRow);
  const visibleAssistantWorkRows = draft.assistantWorkRows.filter(isVisibleAssistantWorkRow);
  const visibleOrderedRows = renderedRows.filter(isVisibleConversationRow);
  const timelineOnly =
    visibleUserInputs.length === 0 &&
    visibleAssistantWorkRows.length > 0 &&
    visibleAssistantWorkRows.every(isTimelineMarkerRow);

  // modelChange 是轮顶轻边界，渲染在 user 输入之前，不进工作流。
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser 自动截图要越过 file diff 摘要成为最后内容块，因此先单独抽取；
  // 其余 row 仍按 CLI 全序处理，只有连续的真实轮尾 marker 后缀可从 flow 拆出。
  const browserTurnEndRows: AssistantWorkRow[] = [];
  const nonBrowserRows: AssistantWorkRow[] = [];
  if (!timelineOnly) {
    for (const row of bodyRows) {
      if (isBrowserTurnEndRow(row)) {
        browserTurnEndRows.push(row);
      } else {
        nonBrowserRows.push(row);
      }
    }
  }
  // 不能用 filter 抽取所有 turnTailBoundary，并把 ExitPlanMode 也强行归入 tail，
  // 会把计划和中间 marker 从原 tool row 搬到轮底。其余 row 必须留在 flow 中。
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);
  return {
    workflowLaunch,
    visibleUserInputs,
    visibleAssistantWorkRows,
    visibleOrderedRows,
    timelineOnly,
    leadingBoundaryRows,
    leadingBoundaryRowIds,
    bodyRows,
    browserTurnEndRows,
    browserTurnEndRowIds: new Set(browserTurnEndRows.map((row) => row.rowId)),
    flowRows,
    assistantTailRows,
  };
}

/**
 * 保留判定。挂在 draft + 切分结果上（而不是已物化的 unit 上），好让增量路径
 * 在不物化 workSegments/flowItems 的前提下完成同样的裁决。
 */
export function shouldKeepDraftUnit(
  draft: DraftTurnRenderUnit,
  visibility: DraftVisibility,
  isRunning: boolean,
): boolean {
  // 隐形行清零后（投影不再产不可渲染 marker），任何工作行都可渲染；
  // 「哪些 marker 可渲染」不再是 UI 的判断。
  return (
    visibility.visibleUserInputs.length > 0 ||
    visibility.visibleAssistantWorkRows.length > 0 ||
    draft.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute)) ||
    visibility.leadingBoundaryRows.length > 0 ||
    // 直接启动轮：用户行不可见、无助手内容，轮由 run 卡呈现——它当然要留下。
    visibility.workflowLaunch !== undefined ||
    isRunning
  );
}

export function materializeDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const {
    workflowLaunch,
    visibleUserInputs,
    visibleOrderedRows,
    timelineOnly,
    leadingBoundaryRows,
    leadingBoundaryRowIds,
    bodyRows,
    browserTurnEndRows,
    browserTurnEndRowIds,
    flowRows,
    assistantTailRows,
  } = resolveDraftVisibility(draft);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // 旧展开规则只看 running 和最终正文，异常终态一旦保留 partial assistant text
  // 就会被当作正常完成而收起，隐藏中断/失败上下文。终态必须以 header 为权威；冷恢复
  // 尾窗缺 header 时才回退 session phase，desktop continuous 与 mobile replayable 共用此边界。
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // product turn 的最终正文仍是唯一 action target；视觉工作段只改变折叠边界。
  const assistantTextRows = flowRows.filter(isAssistantTextRow);
  const actionAssistantTextRow = assistantTextRows.find(
    (row) => row.actions?.canFork === true || row.actions?.canRetry === true,
  );
  const lastFlowRow = flowRows.at(-1);
  const latestAssistantTextRow =
    actionAssistantTextRow ??
    (!isRunning && lastFlowRow && isAssistantTextRow(lastFlowRow) ? lastFlowRow : undefined);
  const workDurationMs = resolveConversationTurnWorkDurationMs(draft.header);
  const workStatus = resolveConversationTurnWorkStatus(
    draft.header,
    bodyRows,
    isRunning,
    workDurationMs,
    isInterrupted,
  );
  const orderedBodyRows = visibleOrderedRows.filter(
    // main 的 workSegments 会从 orderedRows 重建 flow；如果这里只从
    // bodyRows 抽取截图，它仍会被塞回正文流并在轮尾再次渲染，造成重复和顺序错乱。
    (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
  );
  const workSegments = buildConversationTurnWorkSegments({
    key: draft.key,
    header: draft.header,
    orderedRows: orderedBodyRows,
    assistantTailRows,
    latestAssistantTextRow,
    isRunning,
    isLastTurn,
    isInterrupted,
    forceOpenHistory,
    timelineOnly,
  });
  const orderedAssistantHistoryRows = workSegments.flatMap(
    (segment) => segment.assistantHistoryRows,
  );
  const assistantFollowingRows = workSegments.flatMap((segment) => segment.assistantFollowingRows);
  const flowItems = workSegments.flatMap((segment) => segment.flowItems);
  const mustOpenHistory = workSegments.at(-1)?.assistantHistoryDefaultOpen ?? false;
  return {
    key: draft.key,
    turnId: draft.turnId,
    ...(draft.header ? { header: draft.header } : {}),
    visibleUserInputs,
    // 轻边界已经由 leadingBoundaryRows 独立承载，不能再算作 assistant work。
    assistantWorkRows: bodyRows,
    assistantHistoryRows: orderedAssistantHistoryRows,
    assistantFollowingRows,
    assistantTailRows,
    browserTurnEndRows,
    hookInvocations: draft.hookInvocations,
    assistantTextRows,
    leadingBoundaryRows,
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems,
    workSegments,
    // renderRows 是查找/诊断用的平面视图，也必须服从 CLI row 全序。
    renderRows: visibleOrderedRows,
    isLastTurn,
    isRunning,
    assistantHistoryDefaultOpen: mustOpenHistory,
    timelineOnly,
    ...(workStatus ? { workStatus } : {}),
    ...(draft.header ? { startedAt: draft.header.startedAt } : {}),
    ...(workflowLaunch ? { workflowLaunch } : {}),
  };
}

/**
 * 末位归位：keep 过滤改变了「保留集」的末位，必须按新末位重算 isLastTurn 与
 * 末段展开态。这是缓存键里 isLastTurn 段的语义来源。
 */
export function normalizeRenderUnitPosition(
  unit: ConversationTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLastTurn = index === total - 1;
  const forceOpenHistory = shouldForceOpenAbnormalHistory(unit.header, options.sessionPhase);
  const assistantHistoryDefaultOpen =
    unit.workSegments && unit.workSegments.length > 0
      ? !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workSegments.at(-1)?.workStatus?.state === "running") ||
          (unit.workSegments.length === 1 &&
            unit.latestAssistantTextRow === undefined &&
            unit.assistantWorkRows.length > 0))
      : !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workStatus?.state === "running") ||
          (unit.latestAssistantTextRow === undefined && unit.assistantWorkRows.length > 0));
  const workSegments = unit.workSegments?.map((segment, segmentIndex, segments) =>
    segmentIndex === segments.length - 1
      ? {
          ...segment,
          assistantHistoryDefaultOpen:
            !unit.timelineOnly &&
            (forceOpenHistory ||
              (isLastTurn && segment.workStatus?.state === "running") ||
              (segments.length === 1 &&
                unit.latestAssistantTextRow === undefined &&
                segment.assistantWorkRows.length > 0)),
        }
      : segment,
  );
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    workSegments?.at(-1)?.assistantHistoryDefaultOpen ===
      unit.workSegments?.at(-1)?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}