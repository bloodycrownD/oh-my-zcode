import { createContext } from "react";
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
import {
  trajectoryToolCallInputs,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
} from "@/ModelTrajectoryToolPayload.js";

export type TrajectorySearchField = "content" | "tool-name" | "tool-id";

export interface TrajectorySearchMatch {
  key: string;
  callKey: string;
  /** 展平后的全局调用下标（= recordIndex，与 CallCard 编号一致）。 */
  callIndex: number;
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

/** 搜索索引的输入：回合内的一次调用（展平后按记录顺序）。 */
export interface TrajectorySearchTimelineItem {
  key: string;
  record: ZCodeModelTrajectoryRecord;
  inputMessages: ZCodeModelTrajectoryMessage[];
  turnKey: string;
  turnIndex: number;
  callIndexInTurn: number;
}

interface SearchTarget {
  callKey: string;
  callIndex: number;
  callIndexInTurn: number;
  turnKey: string;
  turnIndex: number;
  expansionKey: string;
  field: TrajectorySearchField;
  text: string;
}

/** 当前激活命中的消息展开键（由该消息行自己消费，命中即强制展开）。 */
export const TrajectorySearchRevealContext = createContext<string | null>(null);

/**
 * 当前激活命中所在的回合键（B-7「命中自动展开对应回合」）。
 * 回合外壳未经消息行渲染，拿不到消息级 reveal 键，因此单独给一条回合命名空间通道；
 * 两个命名空间（`turn:` vs `<requestId>:<index>`）不重叠，可同时参与同一判定。
 */
export const TrajectorySearchRevealTurnContext = createContext<string | null>(null);

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
  return items.flatMap((item, callIndex) => {
    const position = {
      callKey: item.key,
      callIndex,
      callIndexInTurn: item.callIndexInTurn,
      turnKey: item.turnKey,
      turnIndex: item.turnIndex,
    };
    const targets = item.inputMessages.flatMap((message, messageIndex) =>
      messageTargets(position, `${item.key}:input:${messageIndex}`, message),
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
      targets.push(
        ...messageTargets(position, `${item.key}:output:${toolCall.kind}:${toolCallIndex}`, {
          role: "assistant",
          parts: [toolCall],
        }),
      );
    });
    return targets;
  });
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
