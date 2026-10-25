import {
  DEFAULT_MAX_PREVIEW_CHARS,
  DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  buildPreviewText,
  type ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  MessageId,
  TurnManifestQueryRecord,
  TurnManifestRowCountSource,
  TurnManifestTurnRecord,
} from "@zcode/contracts";

/**
 * turn 行清单的**唯一派生口径**：活投影终态（`onTurnComplete` / `onTurnError`）与
 * turnDirectory（`getTurnDirectory`）共用这里的 preview / kind 计算，保证
 * 「manifest 快路径」与「全量物化」逐字节一致（T-SL7 的前提）。
 *
 * 不变量：
 * - 目录只认 `origin === "realUser"` 的 userInput 行（其余 origin 只展示，不进目录）；
 * - 摘要是 turn 级的：同一 turn 的多条 steer query 共享同一份 assistantPreview；
 * - `assistantPreviewKind` 三态：有 assistantText → text；否则 header 在跑 → running；
 *   否则（含无 header 兜底）→ empty，且非 text 态的 preview 恒为空串（文案不下发）。
 */

/**
 * 投影规则版本：turnId / rowId base / row 形状任一变化都必须 +1。
 * 版本不匹配即整表重建——旧 manifest 会让 rowId 整体漂移，症状是翻页错位而不是报错。
 *
 * v2（Step 4）：废除跨 turn 的全局 `nextRowId++`，rowId base 改为「前序 active turn 的
 * row_count 累加」（rewind 后复用被截轮的 base、不再产生空洞）。v1 清单里的
 * `query_row_id` 是按带空洞的旧口径写的，继续用会让目录游标指向错误位置——必须整表重建。
 *
 * v3（Step 6）：`row_count` 改为「该轮在整份行窗口里的行数」，迟到行（锚在历史轮的 goal
 * verification 等，物理落在尾部）按 `turnId` 归户计入。v2 清单只数连续块，`Σ row_count`
 * 比投影实际行数少 N，冷窗口按这份累加做 rowIdOrigin 会让窗口内 rowId 整体前移 N——只能
 * 整表重建，不能用账目修正补（修正只改已登记 turn 的计数，而 v2 的偏差恰恰是「迟到的
 * 那几行没有任何 turn 认领」）。
 */
export const TURN_MANIFEST_PROJECTION_SCHEMA_VERSION = 3;

/** 没有正文可摘时的 fallback：客户端按 `assistantPreviewKind` 填 i18n，服务端不下发文案。 */
export const TURN_DIRECTORY_EMPTY_PREVIEW = "";

export function turnDirectoryPreview(texts: readonly string[]): string {
  return buildPreviewText({
    texts,
    // 摘要口径与 renderer rail 严格同源（@zcode/shared/previewText 的 220 字符 / 2 段）。
    fallback: TURN_DIRECTORY_EMPTY_PREVIEW,
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  });
}

export function turnDirectoryAssistantPreviewKind(
  hasAssistantText: boolean,
  headerState: string | undefined,
): TurnManifestQueryRecord["assistantPreviewKind"] {
  if (hasAssistantText) return "text";
  return headerState === "running" ? "running" : "empty";
}

/** 写进 manifest 的一轮：turn 行 + 该 turn 的全部 realUser query 行。 */
export interface TurnManifestEntry {
  branchGeneration: number;
  projectionSchemaVersion: number;
  turn: TurnManifestTurnRecord;
  queries: TurnManifestQueryRecord[];
}

/**
 * 从**同一个 turn 的行**（按投影行序）派生 manifest 条目。
 *
 * `rows` 必须是该 turn 在活投影里的全部行；空数组表示该 turn 已经没有可物化行
 * （例如迟到终态在被 rewind 截掉的 turn 上），此时返回 null，调用方不得写入
 * ——写一条 row_count=0 的 turn 会凭空产生一个 turn 位置。
 */
export function buildTurnManifestEntry(input: {
  turnId: string;
  ordinal: number;
  rows: readonly ConversationRow[];
  messageIdForRow: (rowId: number) => MessageId | undefined;
  rowCountSource: TurnManifestRowCountSource;
  branchGeneration: number;
}): TurnManifestEntry | null {
  if (input.rows.length === 0) return null;
  // 防御式过滤：调用方传进来的窗口可能含邻 turn 的行（投影切片写错时不会报错，
  // 只会把别人的行数记到这一轮头上）。row_count 的权威是「本 turn 的行」。
  const turnRows = input.rows.filter((row) => row.turnId === input.turnId);
  if (turnRows.length === 0) return null;

  const assistantTexts: string[] = [];
  const queryRowIndexes: number[] = [];
  let headerState: string | undefined;
  for (const [index, row] of turnRows.entries()) {
    if (row.kind === "turnHeader") {
      // 同一 turn 只有一条 header；出现重复时以首个非空为准。
      headerState ??= row.state;
      continue;
    }
    if (row.kind === "assistantText") {
      assistantTexts.push(row.text);
      continue;
    }
    if (row.kind === "userInput" && row.origin === "realUser") {
      queryRowIndexes.push(index);
    }
  }

  const messageIds: MessageId[] = [];
  const seenMessageIds = new Set<string>();
  for (const row of turnRows) {
    const messageId = input.messageIdForRow(row.rowId);
    if (!messageId || seenMessageIds.has(messageId)) continue;
    seenMessageIds.add(messageId);
    messageIds.push(messageId);
  }

  const hasAssistantText = assistantTexts.length > 0;
  const assistantPreviewKind = turnDirectoryAssistantPreviewKind(hasAssistantText, headerState);
  const assistantPreview = hasAssistantText ? turnDirectoryPreview(assistantTexts) : "";
  const queries: TurnManifestQueryRecord[] = queryRowIndexes.map((rowIndex, queryOrdinal) => {
    const row = turnRows[rowIndex]!;
    // 分段 = 本 query 行（含）到下一个 realUser query 行（不含）或 turn 末尾：
    // 这样 queryRowId + rowCount 就是稳定可定位的一段，turnHeader 不属于任何分段。
    const segmentEnd = queryRowIndexes[queryOrdinal + 1] ?? turnRows.length;
    return {
      turnId: input.turnId,
      queryOrdinalInTurn: queryOrdinal,
      queryMessageId: input.messageIdForRow(row.rowId) ?? null,
      queryRowId: row.rowId,
      rowCount: segmentEnd - rowIndex,
      queryPreview: turnDirectoryPreview([row.kind === "userInput" ? row.text : ""]),
      assistantPreview,
      assistantPreviewKind,
    };
  });

  return {
    branchGeneration: input.branchGeneration,
    projectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
    turn: {
      turnId: input.turnId,
      ordinal: input.ordinal,
      messageIds,
      firstMessageId: messageIds[0] ?? null,
      lastMessageId: messageIds.at(-1) ?? null,
      rowCount: turnRows.length,
      rowCountSource: input.rowCountSource,
      projectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
    },
    queries,
  };
}
