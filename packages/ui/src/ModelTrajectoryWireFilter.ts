// 轨迹 wire 占位行分类器（spec B-4 / B10，纯逻辑、零 React、零 `@/` 别名）。
//
// wire 上的「空占位行」是 Magic Context 清理后的残留形态：
// `[dropped §N§]` / `[dropped]` / `[truncated §N§]` / `[cleared]` / 只剩 `§N§` 标记 / 空 parts。
// 它们占住消息条数与角色列，却不承载任何可读内容，轨迹面板展开回合时默认隐藏。
// system/user 角色永不隐藏：`<system-reminder>` 等注入在 wire 上是 role=user，
// 隐藏它会直接抹掉系统上下文（spec B-4 拍板）。
//
// 硬约束：本模块被 packages/ui/test/modelTrajectoryWireFilter.test.ts 以 node:test 直测，
// 依赖链上不能出现 React 或 `@/` 别名导入（tsx 下别名不可解析）——
// 只允许相对导入或依赖包裸名导入（先例 ModelTrajectoryTurns.ts:1-5）。
import type { ZCodeModelTrajectoryContentPart, ZCodeModelTrajectoryMessage } from "@zcode/services";

/** `visible` = 正常消息；`placeholder` = 可隐藏的空占位行。 */
export type TrajectoryWireMessageVisibility = "visible" | "placeholder";

/** 永不隐藏的角色：system 是系统提示词，user 里有 `<system-reminder>` 等注入。 */
const NEVER_HIDDEN_ROLES: ReadonlySet<string> = new Set(["system", "user"]);

/**
 * 占位符全文模式：整段文本只由以下标记与空白组成才算空占位。
 * 与 magic-context 的 `isMarkerOnlyText`（strip-content.ts:15）同源，额外补
 * `[truncated §N§]`（旧版预览形态，历史记录里仍可能存在）与 bare `[truncated]`。
 */
const PLACEHOLDER_ONLY_PATTERN =
  /^(?:(?:§\d+§|\[dropped(?: §\d+§)?\]|\[truncated(?: §\d+§)?\]|\[cleared\])\s*)+$/u;

/** 文本是否只是占位标记（空串 / 纯空白同样视为无内容）。 */
function isPlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || PLACEHOLDER_ONLY_PATTERN.test(trimmed);
}

/** text / reasoning 是承载可读内容的文本 part；其余 part 视为结构化内容。 */
type TextualTrajectoryPart = Extract<
  ZCodeModelTrajectoryContentPart,
  { kind: "text" | "reasoning" }
>;

function isTextualPart(part: ZCodeModelTrajectoryContentPart): part is TextualTrajectoryPart {
  return part.kind === "text" || part.kind === "reasoning";
}

/**
 * 判定单条 wire 消息是否空占位行（spec B-4 分类器）。
 *
 * 规则：
 * 1. system / user 强制 visible（不看内容）；
 * 2. `parts` 为空 → placeholder（「全空 parts」）；
 * 3. 任一 part 是结构化内容（tool-call / tool-result / image / unknown）→ visible；
 * 4. 所有文本 part 都是空串或纯占位标记 → placeholder；否则 visible。
 */
export function classifyTrajectoryWireMessage(
  message: ZCodeModelTrajectoryMessage,
): TrajectoryWireMessageVisibility {
  if (NEVER_HIDDEN_ROLES.has(message.role.trim().toLowerCase())) return "visible";
  for (const part of message.parts) {
    if (!isTextualPart(part)) return "visible";
    if (!isPlaceholderText(part.text)) return "visible";
  }
  // parts.length === 0 时循环不执行，直接落到这里。
  return "placeholder";
}

export interface TrajectoryWireFilterResult<T extends ZCodeModelTrajectoryMessage> {
  visible: T[];
  /** 被判定为空占位行的条数（UI「已隐藏 N 条」的唯一计数来源）。 */
  hiddenCount: number;
}

/**
 * 按占位分类拆分消息列表（默认隐藏开关打开时 UI 的渲染输入）。
 * 保持原数组顺序，不修改入参，返回的 visible 是原对象引用。
 */
export function filterTrajectoryWireMessages<T extends ZCodeModelTrajectoryMessage>(
  messages: readonly T[],
): TrajectoryWireFilterResult<T> {
  const { rows, hiddenCount } = classifyTrajectoryWireRows(messages);
  return {
    visible: rows.filter((row) => !row.placeholder).map((row) => row.message),
    hiddenCount,
  };
}

/** 带原始下标的行级分类结果：UI 渲染以 messageIndex 构造 expansionKey 与奇偶底色。 */
export interface TrajectoryWireRow<T extends ZCodeModelTrajectoryMessage> {
  message: T;
  messageIndex: number;
  placeholder: boolean;
}

/**
 * 行级分类（UI 的唯一渲染输入）：保留原始 messageIndex，UI 不再自行 map+计数，
 * 消除分类逻辑双轨（cr-func-all P2-3）。
 */
export function classifyTrajectoryWireRows<T extends ZCodeModelTrajectoryMessage>(
  messages: readonly T[],
): { rows: TrajectoryWireRow<T>[]; hiddenCount: number } {
  const rows: TrajectoryWireRow<T>[] = [];
  let hiddenCount = 0;
  for (const [messageIndex, message] of messages.entries()) {
    const placeholder = classifyTrajectoryWireMessage(message) === "placeholder";
    if (placeholder) {
      hiddenCount += 1;
    }
    rows.push({ message, messageIndex, placeholder });
  }
  return { rows, hiddenCount };
}
