import { createContext } from "react";
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
// 包内导入一律相对路径（而非 `@/`）：本模块被 modelTrajectoryTurns.test.ts 经
// buildTrajectorySearchIndex 以 node:test 直测，tsx 从仓库根运行时不解析 `@/` 别名。
// 反向依赖（Turns → 本模块）是 `import type`，verbatimModuleSyntax 下被擦除，无运行时环。
import {
  trajectoryToolCallBadgeText,
  trajectoryToolCallDisplayText,
  trajectoryToolCallTargetKey,
  type TrajectoryToolCallInfo,
} from "./ModelTrajectoryToolJoin.js";
import { trajectoryInputRowKey } from "./ModelTrajectoryTurns.js";
import {
  trajectoryToolCallInputs,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
} from "./ModelTrajectoryToolPayload.js";

export type TrajectorySearchField = "content" | "tool-name" | "tool-id";

export interface TrajectorySearchMatch {
  key: string;
  /** 回合内序号（B-7：索引/定位同时携带回合坐标）。 */
  callIndexInTurn: number;
  /** 命中所在的回合展开键（`turn:<turnId>` / `turn:fallback:<requestId>`）。 */
  turnKey: string;
  /** 命中所在的回合下标（虚拟化单位已是回合，滚动定位用它）。 */
  turnIndex: number;
  expansionKey: string;
  field: TrajectorySearchField;
  fieldMatchIndex: number;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
}

interface TrajectorySearchIndex {
  query: string;
  matches: TrajectorySearchMatch[];
}

/** 搜索索引的输入行：wire 原始下标 + 消息（占位行是否保留由调用方先行过滤）。 */
interface TrajectorySearchInputRow {
  message: ZCodeModelTrajectoryMessage;
  messageIndex: number;
}

/** 搜索索引的输入：回合内的一次调用（展平后按记录顺序）。 */
export interface TrajectorySearchTimelineItem {
  key: string;
  record: ZCodeModelTrajectoryRecord;
  /** 可见输入行；messageIndex 是 wire 原始下标，与渲染的 expansionKey 对齐（B-2）。 */
  inputRows: TrajectorySearchInputRow[];
  /**
   * 工具调用的跨记录配对信息（与 record.response.toolCalls 下标对齐）。
   * tool-call 的 content target 文本取 trajectoryToolCallDisplayText（与配对卡 DOM 同源），
   * 徽标文本取 trajectoryToolCallBadgeText（真实工具名优先）。
   */
  toolCalls: TrajectoryToolCallInfo[];
  turnKey: string;
  turnIndex: number;
  callIndexInTurn: number;
}

interface SearchTarget {
  callIndexInTurn: number;
  turnKey: string;
  turnIndex: number;
  expansionKey: string;
  field: TrajectorySearchField;
  text: string;
}

/**
 * 搜索命中展开键的集合类型（v1.0.19 P1-5）。
 * 由「当前激活命中的单个键」放宽为「本次查询的全部命中键」——
 * 默认收起时若只展开 active 命中，其余命中行的 content 字段不在 DOM，
 * 计数前进但高亮不可见（命中 N 处只见 1 处高亮）。
 */
export type TrajectorySearchRevealSet = ReadonlySet<string>;

/**
 * 空集合常量：作为 Context 默认值复用，避免每次渲染新建 Set。
 * Context 值每帧变化会让全部消费行反复重渲染（Provider 侧必须 useMemo 构造）。
 */
export const EMPTY_TRAJECTORY_SEARCH_REVEAL_SET: TrajectorySearchRevealSet = new Set<string>();

/**
 * 命中消息展开键的集合（由该消息行自己消费，命中即强制展开）。
 * 消费方：useTrajectoryExpansion（Expansion.ts）与 TrajectoryClampedPreview（经 hook 间接消费）。
 */
export const TrajectorySearchRevealContext = createContext<TrajectorySearchRevealSet>(
  EMPTY_TRAJECTORY_SEARCH_REVEAL_SET,
);

/**
 * 命中所在回合键的集合（B-7「命中自动展开对应回合」）。
 * 回合外壳未经消息行渲染，拿不到消息级 reveal 键，因此单独给一条回合命名空间通道；
 * 两个命名空间（`turn:` 前缀 vs trajectoryCallKey 产物）不重叠，可同时参与同一判定。
 */
export const TrajectorySearchRevealTurnContext = createContext<TrajectorySearchRevealSet>(
  EMPTY_TRAJECTORY_SEARCH_REVEAL_SET,
);

export function buildTrajectorySearchIndex(
  items: readonly TrajectorySearchTimelineItem[],
  query: string,
): TrajectorySearchIndex {
  const normalizedQuery = normalizeTrajectorySearchText(query).text.trim();
  if (!normalizedQuery) return { query: "", matches: [] };

  const matches: TrajectorySearchMatch[] = [];
  for (const target of buildSearchTargets(items)) {
    const sourceMatches = findTrajectoryTextMatches(target.text, normalizedQuery);
    sourceMatches.forEach(({ sourceStart, sourceEnd }, fieldMatchIndex) => {
      matches.push({
        ...target,
        key: `${target.expansionKey}:${target.field}:${fieldMatchIndex}:${sourceStart}`,
        fieldMatchIndex,
        sourceStart,
        sourceEnd,
        sourceText: target.text,
      });
    });
  }
  return { query: normalizedQuery, matches };
}

function buildSearchTargets(items: readonly TrajectorySearchTimelineItem[]): SearchTarget[] {
  return items.flatMap((item) => {
    const position = {
      callIndexInTurn: item.callIndexInTurn,
      turnKey: item.turnKey,
      turnIndex: item.turnIndex,
    };
    const targets = item.inputRows.flatMap((row) =>
      messageTargets(position, trajectoryInputRowKey(item.key, row.messageIndex), row.message),
    );
    const response = item.record.response;
    if (!response) return targets;
    if (response.reasoningText) {
      targets.push(contentTarget(position, `${item.key}:output:reasoning`, response.reasoningText));
    }
    if (response.text) {
      targets.push(contentTarget(position, `${item.key}:output:message`, response.text));
    }
    response.toolCalls.forEach((toolCall, toolCallIndex) => {
      // target key 与配对卡 DOM 逐字同源（ModelTrajectoryToolPairCard 用同一 helper）。
      const expansionKey = trajectoryToolCallTargetKey(item.key, toolCall.kind, toolCallIndex);
      const info = item.toolCalls[toolCallIndex];
      if (info) {
        // 配对形态：content 文本 = displayText（use 段 + 结果段），徽标文本取真实工具名。
        targets.push(...toolCallTargets(position, expansionKey, info));
        return;
      }
      // 兜底（无配对信息）：退回单段调用输入文本。
      targets.push(
        ...messageTargets(position, expansionKey, {
          role: "assistant",
          parts: [toolCall],
        }),
      );
    });
    return targets;
  });
}

/** 工具调用行的搜索 target：content（use + 结果）+ tool-name + tool-id。 */
function toolCallTargets(
  position: Omit<SearchTarget, "expansionKey" | "field" | "text">,
  expansionKey: string,
  info: TrajectoryToolCallInfo,
): SearchTarget[] {
  const badge = trajectoryToolCallBadgeText(info);
  const content = trajectoryToolCallDisplayText(info);
  return [
    ...(content ? [contentTarget(position, expansionKey, content)] : []),
    ...(badge.name
      ? [{ ...position, expansionKey, field: "tool-name" as const, text: badge.name }]
      : []),
    ...(badge.id ? [{ ...position, expansionKey, field: "tool-id" as const, text: badge.id }] : []),
  ];
}

function messageTargets(
  position: Omit<SearchTarget, "expansionKey" | "field" | "text">,
  expansionKey: string,
  message: ZCodeModelTrajectoryMessage,
): SearchTarget[] {
  const metadata = trajectoryToolMetadata(message);
  const content = message.parts.some((part) => part.kind === "tool-result")
    ? trajectoryToolOutputs(message).join("\n\n")
    : message.parts.some((part) => part.kind === "tool-call")
      ? trajectoryToolCallInputs(message).join("\n\n")
      : message.parts
          .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
          .join("\n\n");
  return [
    ...(content ? [contentTarget(position, expansionKey, content)] : []),
    ...(metadata.names
      ? [{ ...position, expansionKey, field: "tool-name" as const, text: metadata.names }]
      : []),
    ...(metadata.ids
      ? [{ ...position, expansionKey, field: "tool-id" as const, text: metadata.ids }]
      : []),
  ];
}

function contentTarget(
  position: Omit<SearchTarget, "expansionKey" | "field" | "text">,
  expansionKey: string,
  text: string,
): SearchTarget {
  return { ...position, expansionKey, field: "content", text };
}

export function findTrajectoryTextMatches(
  source: string,
  normalizedQuery: string,
): Array<{ sourceStart: number; sourceEnd: number }> {
  const normalizedSource = normalizeTrajectorySearchText(source);
  const matches: Array<{ sourceStart: number; sourceEnd: number }> = [];
  let searchStart = 0;
  while (searchStart < normalizedSource.text.length) {
    const matchStart = normalizedSource.text.indexOf(normalizedQuery, searchStart);
    if (matchStart === -1) break;
    const matchEnd = matchStart + normalizedQuery.length;
    const sourceStart = normalizedSource.starts[matchStart] ?? 0;
    matches.push({
      sourceStart,
      sourceEnd: normalizedSource.ends[matchEnd - 1] ?? sourceStart,
    });
    searchStart = matchEnd;
  }
  return matches;
}

function normalizeTrajectorySearchText(source: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let inWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      if (!inWhitespace) {
        text += " ";
        starts.push(index);
        ends.push(index + 1);
        inWhitespace = true;
      } else {
        ends[ends.length - 1] = index + 1;
      }
      continue;
    }
    inWhitespace = false;
    const normalizedCharacter = character.toLocaleLowerCase();
    text += normalizedCharacter;
    for (let offset = 0; offset < normalizedCharacter.length; offset += 1) {
      starts.push(index);
      ends.push(index + 1);
    }
  }
  return { text, starts, ends };
}
