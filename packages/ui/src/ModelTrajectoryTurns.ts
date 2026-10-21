// 轨迹面板的回合聚合与输入增量投影（纯函数，无 React、无 `@/` 别名）。
//
// 硬约束：本模块被 packages/ui/test/modelTrajectoryTurns.test.ts 以 node:test 直测，
// 传递依赖链上不能出现 React 或 `@/` 别名导入（tsx 下别名不可解析）——
// 只允许相对导入或依赖包裸名导入（先例 conversationTurnRenderUnits.test.ts:11-13）。
//
// 归属（spec B-1/B-2/B-3）：回合分组、真实用户输入判定、回合预览、reasoning 投影、
// 调用序列增量（shouldUseConversationDelta / resolveTrajectoryInputMessages /
// computeDeltaMessages 自 ModelTrajectoryTimeline.tsx 迁入）全部落在本模块；
// Timeline/Pane 只负责渲染、虚拟化与状态（wave-2 切换引用）。
import {
  buildPreviewText,
  DEFAULT_MAX_PREVIEW_CHARS,
  DEFAULT_MAX_PREVIEW_PARAGRAPHS,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
} from "@zcode/services";
// 纯类型导入（verbatimModuleSyntax 下被完全擦除）：本模块运行时不会加载 Search.ts
// （它依赖 React 的 createContext，不属于零 React 的纯函数区）。
import type { TrajectorySearchTimelineItem } from "./ModelTrajectorySearch.js";
import {
  filterTrajectoryInputRows,
  joinTrajectoryToolResults,
  trajectoryCallKey,
  trajectoryInputRowKey,
  type TrajectoryToolCallInfo,
} from "./ModelTrajectoryToolJoin.js";
import { classifyTrajectoryWireRows } from "./ModelTrajectoryWireFilter.js";

/** 回合头部在没有真实用户输入、也没有 assistant 文本时的占位文案（UI 可传 i18n 文本覆盖）。 */
export const TRAJECTORY_EMPTY_USER_PREVIEW = "（无用户输入）";

// 调用级 key 家族自本迭代起由 ModelTrajectoryToolJoin.ts 单源持有（spec N-1）：
// 本模块继续 re-export，既有引用点（Search / CallInput / PaneParts）零改动。
export { trajectoryCallKey, trajectoryInputRowKey };

/**
 * 非真实用户输入的消息前缀（判定前先剥 `§N§` 标签并 trimStart）。
 * 前三项对齐 conversation-message-projection-policy.ts:45-46 的既有启发式；
 * 后三项是 Magic Context 的注入包裹形态（`<session-history>` / `<project-memory>` /
 * `<new-compartments>`）——它们在 wire 上是 role=user，但不是用户主动输入。
 */
const NON_USER_INPUT_PREFIXES = [
  "<system-reminder",
  "<task-notification",
  "<subagent-notification",
  "<session-history",
  "<project-memory",
  "<new-compartment",
] as const;

/** Magic Context 给每条消息加的 `§N§` 标签前缀（回复文本以它开头）。 */
const TRAJECTORY_TAG_PREFIX_PATTERN = /^§\d+§\s*/u;

/** 只剩占位符的 user 消息（内容已被上下文清理带走）不算真实用户输入。 */
const TRAJECTORY_PLACEHOLDER_ONLY_PATTERN = /^\[(?:dropped|truncated|cleared)(?:\s+§\d+§)?\]$/u;

function trajectoryMessageText(message: ZCodeModelTrajectoryMessage): string {
  return message.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("");
}

/** 剥掉开头的 `§N§` 标签（连带其后空白），得到可展示的用户原文。 */
function stripTrajectoryTagPrefix(text: string): string {
  return text.replace(TRAJECTORY_TAG_PREFIX_PATTERN, "");
}

/** 真实用户输入的原文（已剥标签）；非真实输入返回 null。 */
function resolveRealUserInputText(message: ZCodeModelTrajectoryMessage): string | null {
  if (message.role !== "user") return null;
  const text = stripTrajectoryTagPrefix(trajectoryMessageText(message).trimStart()).trimStart();
  if (!text) return null;
  if (NON_USER_INPUT_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  if (TRAJECTORY_PLACEHOLDER_ONLY_PATTERN.test(text)) return null;
  return text;
}

/**
 * 真实用户输入判定（B-1 的辅助启发式，不是回合切分键——切分键是 `record.turnId`）。
 * role=user 且剥掉 `§N§` 后不是注入包裹 / 通知 / 纯占位符。
 */
export function isTrajectoryRealUserMessage(message: ZCodeModelTrajectoryMessage): boolean {
  return resolveRealUserInputText(message) !== null;
}

/**
 * 是否按「会话消息数增量」展示该次调用的输入。
 *
 * 现语义（迁入 Turns.ts 时逐字保留）：main / subagent / 未标注来源走增量；
 * sidecar（与类型里的 unknown）完整展示 request.messages。
 * - sidecar（标题生成等）有独立 prompt，套主会话的消息数 delta 会把它的 prompt 藏掉；
 * - subagent 与主会话共享历史（真实样本 cnt 可达 193），完整展开是退化，故与 main 同走 delta。
 */
export function shouldUseConversationDelta(record: ZCodeModelTrajectoryRecord): boolean {
  const kind = record.callSource?.kind;
  return kind === undefined || kind === "main" || kind === "subagent";
}

/**
 * 该次调用在完整会话里的消息条数。
 * tail/delta 记录读落盘的 `messageCount`（压缩前全量条数）；full-retention 记录
 * （全量直写分支不带压缩元数据）回落到磁盘上可见的条数（spec B-2 兜底口径）。
 */
function resolveConversationMessageCount(record: ZCodeModelTrajectoryRecord): number {
  return record.request.messageCount ?? record.request.messages.length;
}

/**
 * 调用序列增量：按 `messageCount` 差值三分支（B-2 拍板，替代旧的「可见条数差」口径）。
 *
 * - `curr > prev`（正常追加）→ 取尾部 `curr − prev` 条。负数下标切片在增量大于可见条数
 *   （tail 窗口只留了尾部若干条）时自然退化为「全部可见消息」，不会越界。
 * - `curr === prev`（同上下文重试）→ `[]`。必须单独分支：`slice(-0)` 等于 `slice(0)`，
 *   会把整段上下文重新展示一遍。
 * - `curr < prev`（回合边界/上下文重置，真实样本 234→182）→ 整段 messages；
 *   由调用方把 prev 重置为该条记录的消息数。
 *
 * `index === 0` 恒展示磁盘上全部可见消息（首条快照没有前序上下文）。
 */
export function computeDeltaMessages({
  record,
  index,
  previousConversationMessageCount,
}: {
  record: ZCodeModelTrajectoryRecord;
  index: number;
  previousConversationMessageCount: number;
}): ZCodeModelTrajectoryMessage[] {
  const messages = record.request.messages;
  if (index === 0) return messages;

  const currentConversationMessageCount = resolveConversationMessageCount(record);
  if (currentConversationMessageCount === previousConversationMessageCount) return [];
  if (currentConversationMessageCount < previousConversationMessageCount) return messages;
  return messages.slice(-(currentConversationMessageCount - previousConversationMessageCount));
}

/**
 * 单次调用的可见输入消息 + 推进后的消息数（全局 prevCount 链的一步）。
 * 首条展示完整起始上下文；后续主会话只展示非 assistant 的新增
 * （assistant 内容由该条记录自己的 Output 呈现）。
 */
export function resolveTrajectoryInputMessages({
  record,
  index,
  previousConversationMessageCount,
}: {
  record: ZCodeModelTrajectoryRecord;
  index: number;
  previousConversationMessageCount: number;
}): {
  inputMessages: ZCodeModelTrajectoryMessage[];
  nextConversationMessageCount: number;
} {
  if (!shouldUseConversationDelta(record)) {
    // sidecar 等独立 prompt 的调用：完整展示，且不推进主会话的消息数链。
    return {
      inputMessages: record.request.messages,
      nextConversationMessageCount: previousConversationMessageCount,
    };
  }

  const deltaMessages = computeDeltaMessages({ record, index, previousConversationMessageCount });
  return {
    inputMessages:
      index === 0 ? deltaMessages : deltaMessages.filter((message) => message.role !== "assistant"),
    nextConversationMessageCount: resolveConversationMessageCount(record),
  };
}

export type TrajectoryTurnUserPreviewKind = "user" | "assistantFallback" | "empty";

/** 回合内的一次模型调用。 */
export interface TrajectoryTurnCall {
  record: ZCodeModelTrajectoryRecord;
  /** 该记录在入参 records 数组中的全局下标，用于 `<requestId>:<recordIndex>` expansionKey 与搜索键。 */
  recordIndex: number;
  /** 回合内序号（0-based）。 */
  callIndexInTurn: number;
  /** 该次调用的可见输入（messageCount 三分支）；首条记录与 sidecar 记录为全部可见消息。 */
  inputMessages: ZCodeModelTrajectoryMessage[];
  /**
   * 工具调用与结果的配对信息（spec N-1）：与 record.response.toolCalls 严格同长度同顺序
   * （含 kind:"unknown" 的 malformed 条目），response 缺失时为空数组。
   */
  toolCalls: TrajectoryToolCallInfo[];
  /**
   * 该 record 输入消息里「已被全局配对消费」的 tool-result id 集合。
   * 用于把已配对的结果行从渲染与索引中剔除（不改动 inputMessages 本身）。
   */
  pairedResultToolCallIdsInInput: Set<string>;
}

export interface TrajectoryTurnStats {
  callCount: number;
  /** 各次调用 durationMs 之和（缺失按 0 计）。 */
  durationMs: number;
  /** 去重后的调用来源，保持首次出现顺序；未标注按 main 计。 */
  sourceKinds: ZCodeModelTrajectoryCallSourceKind[];
  /**
   * 已无生产消费者（trace-nm-borrow 后 UI 错误判定以 `counts.failureCount` 为准，
   * 不含 sidecar 且含工具失败）。字段保留仅为 T-T3 deepEqual 契约与上迭代 e2e 脚本兼容。
   */
  errorCount: number;
  startedAt?: string;
  completedAt?: string;
}

/** 一个回合（虚拟化单位）：同 turnId 的多条调用合并，sidecar 并入所属回合。 */
export interface TrajectoryTurnGroup {
  /** 展开/搜索用的稳定键：`turn:<turnId>`；无 turnId 的 fallback 组为 `turn:fallback:<requestId>`。 */
  key: string;
  /** 权威回合 id；fallback 组为 null。 */
  turnId: string | null;
  /** 回合序号（0-based），供「回合 N」展示与搜索定位。 */
  turnIndex: number;
  calls: TrajectoryTurnCall[];
  /** 回合头部「用户输入」预览（已折叠/截断）；无真实输入时是 assistant 回落或占位文案。 */
  userPreview: string;
  userPreviewKind: TrajectoryTurnUserPreviewKind;
  /** 回合内 assistant 文本的摘要；无文本时为空串。 */
  assistantPreview: string;
  stats: TrajectoryTurnStats;
}

export interface ResolveTrajectoryTurnGroupsOptions {
  /** 无真实用户输入且无 assistant 文本时的占位文案（默认 TRAJECTORY_EMPTY_USER_PREVIEW）。 */
  emptyUserPreview?: string;
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

interface TrajectoryPreviewLimits {
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}

interface PendingTrajectoryTurnGroup {
  key: string;
  turnId: string | null;
  calls: TrajectoryTurnCall[];
}

function normalizeTrajectoryTurnId(turnId: string | undefined): string | null {
  const trimmed = turnId?.trim();
  return trimmed ? trimmed : null;
}

/**
 * fallback 组的键：无 turnId 的记录各自独立成组。requestId 是首选稳定键；
 * 缺失或重复时补记录下标，保证同一份数据上 key 唯一且刷新稳定。
 */
function resolveFallbackTurnKey(
  record: ZCodeModelTrajectoryRecord,
  recordIndex: number,
  takenKeys: ReadonlyMap<string, unknown>,
): string {
  const base = `turn:fallback:${record.requestId || `#${recordIndex}`}`;
  return takenKeys.has(base) ? `${base}#${recordIndex}` : base;
}

function firstAssistantInputText(calls: readonly TrajectoryTurnCall[]): string | undefined {
  for (const call of calls) {
    for (const message of call.inputMessages) {
      if (message.role !== "assistant") continue;
      const text = trajectoryMessageText(message).trim();
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * 回合的主调用集合（单一实现）：排除 sidecar（标题生成等辅助调用）；全 sidecar 时回退为全部调用。
 *
 * 回合预览与回合计数（ModelTrajectoryTurnCounts.ts）共用此口径，避免两处派生逻辑漂移。
 */
function pickPrimaryCalls(calls: readonly TrajectoryTurnCall[]): TrajectoryTurnCall[] {
  const primary = calls.filter((call) => call.record.callSource?.kind !== "sidecar");
  return primary.length > 0 ? primary : [...calls];
}

/**
 * 回合的主调用集合（对外共享入口）：回合计数模块复用同一派生逻辑。
 * 语义见 pickPrimaryCalls——排除 sidecar；全 sidecar 时回退为全部调用。
 */
export function resolveTrajectoryPrimaryCalls(group: TrajectoryTurnGroup): TrajectoryTurnCall[] {
  return pickPrimaryCalls(group.calls);
}

function buildTrajectoryTurnGroup(
  pending: PendingTrajectoryTurnGroup,
  turnIndex: number,
  emptyUserPreview: string,
  limits: TrajectoryPreviewLimits,
): TrajectoryTurnGroup {
  // 预览只取主调用（非 sidecar）的可见输入：sidecar 是标题生成，其 request.messages 是
  // 完整上下文，用它扫真实用户消息会把上一回合的用户输入误当成本回合输入。
  const primaryCalls = pickPrimaryCalls(pending.calls);

  const userInputText = primaryCalls
    .flatMap((call) => call.inputMessages)
    .reduce<string | null>((found, message) => found ?? resolveRealUserInputText(message), null);

  const assistantTexts = primaryCalls.flatMap((call) => {
    const text = call.record.response?.text;
    return typeof text === "string" && text.trim().length > 0 ? [text] : [];
  });
  // tail 截断 / 注入开头的回合可能没有任何真实 user 消息：回落该回合首条 assistant 文本。
  const assistantFallbackText = assistantTexts[0] ?? firstAssistantInputText(primaryCalls);

  const previewSource = userInputText ?? assistantFallbackText;
  const buildPreview = (texts: readonly string[], fallback: string): string =>
    buildPreviewText({ texts, fallback, ...limits });

  const userPreviewKind: TrajectoryTurnUserPreviewKind = userInputText
    ? "user"
    : assistantFallbackText
      ? "assistantFallback"
      : "empty";

  const sourceKinds: ZCodeModelTrajectoryCallSourceKind[] = [];
  let durationMs = 0;
  let errorCount = 0;
  let completedAt: string | undefined;
  for (const call of pending.calls) {
    const kind = call.record.callSource?.kind ?? "main";
    if (!sourceKinds.includes(kind)) sourceKinds.push(kind);
    durationMs += call.record.durationMs ?? 0;
    if (call.record.error) errorCount += 1;
    if (call.record.completedAt) completedAt = call.record.completedAt;
  }

  return {
    key: pending.key,
    turnId: pending.turnId,
    turnIndex,
    calls: pending.calls,
    userPreview: previewSource ? buildPreview([previewSource], emptyUserPreview) : emptyUserPreview,
    userPreviewKind,
    assistantPreview: buildPreview(assistantTexts, ""),
    stats: {
      callCount: pending.calls.length,
      durationMs,
      sourceKinds,
      errorCount,
      startedAt: pending.calls[0]?.record.startedAt,
      completedAt,
    },
  };
}

/**
 * 按 `record.turnId` 把调用记录聚合成回合（稳定顺序 = 记录首次出现顺序）。
 * - 同 turnId 的多条调用合并进同一回合（含与主轮同 turnId 的 sidecar）；
 * - 无 turnId（或空串）的记录各自独立成组，key 为 `turn:fallback:<首条 requestId>`；
 * - 每条调用带上按全局 prevCount 链算好的可见输入，供 CallCard 直接渲染。
 */
export function resolveTrajectoryTurnGroups(
  records: readonly ZCodeModelTrajectoryRecord[],
  options: ResolveTrajectoryTurnGroupsOptions = {},
): TrajectoryTurnGroup[] {
  const emptyUserPreview = options.emptyUserPreview ?? TRAJECTORY_EMPTY_USER_PREVIEW;
  const limits: TrajectoryPreviewLimits = {
    maxPreviewChars: options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: options.maxPreviewParagraphs ?? DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  };

  const pendingGroups: PendingTrajectoryTurnGroup[] = [];
  const pendingByKey = new Map<string, PendingTrajectoryTurnGroup>();
  // 工具配对只算一次（spec N-1）：跨记录 join 结果按 call key 分发到各次调用。
  const toolJoin = joinTrajectoryToolResults(records);
  // 全局 prevCount 链跨回合不重置：判据是「本次调用相对上一次调用新增了多少条上下文」，
  // sidecar/full 调用不推进这条链（与 resolveTrajectoryInputMessages 的返回值一致）。
  let previousConversationMessageCount = 0;

  records.forEach((record, recordIndex) => {
    const turnId = normalizeTrajectoryTurnId(record.turnId);
    const key = turnId
      ? `turn:${turnId}`
      : resolveFallbackTurnKey(record, recordIndex, pendingByKey);
    let pending = pendingByKey.get(key);
    if (!pending) {
      pending = { key, turnId, calls: [] };
      pendingByKey.set(key, pending);
      pendingGroups.push(pending);
    }

    const resolved = resolveTrajectoryInputMessages({
      record,
      index: recordIndex,
      previousConversationMessageCount,
    });
    previousConversationMessageCount = resolved.nextConversationMessageCount;
    const callKey = trajectoryCallKey(record.requestId, recordIndex);
    pending.calls.push({
      record,
      recordIndex,
      callIndexInTurn: pending.calls.length,
      inputMessages: resolved.inputMessages,
      toolCalls: toolJoin.callToolCalls.get(callKey) ?? [],
      pairedResultToolCallIdsInInput: toolJoin.pairedResultToolCallIds.get(callKey) ?? new Set(),
    });
  });

  return pendingGroups.map((pending, turnIndex) =>
    buildTrajectoryTurnGroup(pending, turnIndex, emptyUserPreview, limits),
  );
}

function stripMessageReasoning(message: ZCodeModelTrajectoryMessage): ZCodeModelTrajectoryMessage {
  if (!message.parts.some((part) => part.kind === "reasoning")) return message;
  return { ...message, parts: message.parts.filter((part) => part.kind !== "reasoning") };
}

function stripResponseReasoning(
  response: ZCodeModelTrajectoryRecord["response"],
): ZCodeModelTrajectoryRecord["response"] {
  if (!response || response.reasoningText === undefined) return response;
  const next = { ...response };
  delete next.reasoningText;
  return next;
}

/**
 * reasoning 投影（B-3）：全局 `messageStreamShowReasoning` 关闭时由 Pane 传入 records。
 * 删除 `response.reasoningText` 与 `request.messages[].parts` 里的 reasoning part；
 * **只过滤 part 不删 message**，保住「按消息数算增量」的语义（消息条数不变）。
 * 未命中的记录原样返回引用，避免每次开关切换都全量重建。
 */
export function stripTrajectoryReasoning(
  records: readonly ZCodeModelTrajectoryRecord[],
): ZCodeModelTrajectoryRecord[] {
  return records.map((record) => {
    const messages = record.request.messages.map(stripMessageReasoning);
    const messagesChanged = messages.some(
      (message, messageIndex) => message !== record.request.messages[messageIndex],
    );
    const response = stripResponseReasoning(record.response);
    if (!messagesChanged && response === record.response) return record;
    return { ...record, request: { ...record.request, messages }, response };
  });
}

/**
 * 把回合分组展平成搜索索引输入（B-7，自 ModelTrajectoryTimeline.tsx 迁入纯函数区）：
 * key 与 CallCard 的 expansionKeyPrefix 同源（trajectoryCallKey），额外携带回合坐标
 * 供滚动定位与「命中展开回合」。
 *
 * `hidePlaceholders` 必须与渲染时的占位过滤开关一致：CallInputSection 默认隐藏占位行，
 * 索引若仍包含它们，搜 `dropped` / `truncated` 会命中不在 DOM 里的行——计数前进但高亮
 * 与滚动都不动作（B-2）。过滤只丢行、**不按下标重排**：messageIndex 仍是 wire 原始下标，
 * 与渲染 expansionKey 逐字对齐。
 */
export function resolveTrajectorySearchItems(
  turnGroups: readonly TrajectoryTurnGroup[],
  hidePlaceholders: boolean,
): TrajectorySearchTimelineItem[] {
  return turnGroups.flatMap((group) =>
    group.calls.map((call) => {
      const key = trajectoryCallKey(call.record.requestId, call.recordIndex);
      const { rows } = classifyTrajectoryWireRows(call.inputMessages);
      const visibleRows = hidePlaceholders ? rows.filter((row) => !row.placeholder) : rows;
      // N-3：已配对的 tool-result 行从索引剔除（与渲染同源，避免命中不在 DOM 的行）。
      const { visibleRows: pairedFilteredRows } = filterTrajectoryInputRows(
        visibleRows,
        call.pairedResultToolCallIdsInInput,
      );
      return {
        key,
        record: call.record,
        inputRows: pairedFilteredRows,
        toolCalls: call.toolCalls,
        turnKey: group.key,
        turnIndex: group.turnIndex,
        callIndexInTurn: call.callIndexInTurn,
      };
    }),
  );
}
