// 轨迹面板的工具调用/结果跨记录配对（join）纯模块，同时是调用级 key 家族的唯一来源。
//
// 为什么必须跨记录：tool result 不在发起调用的 record.response 里（services 映射时
// `response.toolResults` 被整体丢弃），而是出现在**后续 record 的 request.messages** 中
// （role=tool 的消息，id 在 part 上）。因此 join 只能在 UI 纯函数区按 callId 全局索引。
//
// 硬约束：本模块被 packages/ui/test/modelTrajectoryToolJoin.test.ts 以 node:test + tsx 直测，
// 传递依赖链上不能出现 React 或 `@/` 别名导入（tsx 下别名不可解析）——
// 只允许相对导入或依赖包裸名导入（先例 ModelTrajectoryTurns.ts:1-5）。
//
// 数据面约束：join 只扫**完整** request.messages，绝不使用 delta 投影——
// messageCount 相等时 delta 为空数组，用它建索引会把配对的 result 全部误判成丢失。
import type {
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
} from "@zcode/services";
import {
  displayTrajectoryToolCallId,
  trajectoryToolCallInputs,
  trajectoryToolOutputs,
  trajectoryToolPayloadErrorText,
} from "./ModelTrajectoryToolPayload.js";
import type { TrajectoryWireRow } from "./ModelTrajectoryWireFilter.js";

/** 工具调用与结果的配对状态（UI 文案「未返回结果」对应 pending/missing，不称「丢失」）。 */
export type TrajectoryToolCallStatus = "ok" | "error" | "pending" | "missing";

/** 一次 response.toolCalls[i] 的配对结果（part 原样引用，渲染侧直接消费）。 */
export interface TrajectoryToolCallInfo {
  /** 原 response.toolCalls[i]，原样引用（含 kind:"unknown" 的 malformed 条目）。 */
  part: ZCodeModelTrajectoryContentPart;
  status: TrajectoryToolCallStatus;
  /** 配对 result 的展示文本（trajectoryToolOutputs 同源口径）；未配对为 ""。 */
  pairedResultText: string;
  /**
   * 配对 result part 的工具名（未配对时为 undefined）。
   * call 侧的服务映射用 `?? "tool"` 兜底名，结果侧才是真实工具名——
   * 徽标与搜索索引一律优先取它（spec 契约 3 / 实现注 9）。
   */
  pairedResultToolName?: string;
  /** 配对 result part 的调用 id（原始值，展示态的 "call_" 前缀裁剪由 helper 负责）。 */
  pairedResultToolId?: string;
}

/** 配对卡的徽标文本（工具名 + 调用 id）：DOM 与搜索索引共用同一份计算。 */
export interface TrajectoryToolCallBadgeText {
  /** 工具名；两侧都没有时为空串。 */
  name: string;
  /** 调用 id 展示态（去掉 "call_" 前缀，与既有 tool-id 徽标同口径）；没有时为空串。 */
  id: string;
}

/**
 * 配对卡徽标文本单源：优先取配对 result part 的真实工具名/id，回退 call part。
 *
 * 渲染（ModelTrajectoryToolPairCard 的徽标）与搜索索引（ModelTrajectorySearch 的
 * tool-name/tool-id target）必须逐字同源，否则搜工具名会「计数前进、画面不动」。
 *
 * 口径（CR A-P2-1）：result 侧用 `||` 回退——result part 的 toolName 若是空串
 * （旧数据里出现过空工具名），也要回退到 call 侧的名字，而不是渲染出空徽标。
 * call 侧名字本身已由 services 映射层做过 `?? "tool"` 兜底
 * （packages/services/src/zcode-agent/modelTrajectory.ts:423/450），
 * 所以无结果时徽标显示的就是那个兜底名「tool」。
 */
export function trajectoryToolCallBadgeText(
  info: TrajectoryToolCallInfo,
): TrajectoryToolCallBadgeText {
  const callPart = info.part;
  // 名：result 侧真实名优先（空串也回退），无 result 时取 call 侧名；
  // call 侧无名时兜底为服务层同款 "tool"（services modelTrajectory.ts 的 `?? "tool"`，
  // 服务层只对 undefined 兜底，空串会原样穿过，故 UI 侧再兜一次）。
  const name =
    info.pairedResultToolName || (callPart.kind === "tool-call" ? callPart.toolName || "tool" : "");
  const rawId =
    info.pairedResultToolId ?? (callPart.kind === "tool-call" ? callPart.toolCallId : undefined);
  return { name: name ?? "", id: rawId ? displayTrajectoryToolCallId(rawId) : "" };
}

export interface TrajectoryToolJoinResult {
  /**
   * 每条 call 的配对信息，key = trajectoryCallKey(requestId, recordIndex)。
   * 关键约束：数组与 record.response.toolCalls 严格同长度同顺序（含 kind:"unknown"
   * 条目），kind 过滤只用于计数，绝不缩数组——否则渲染与搜索 key 漂移。
   */
  callToolCalls: Map<string, TrajectoryToolCallInfo[]>;
  /**
   * 该 record 的 request.messages 中「已被配对消费」的 tool-result id 集合，key 同上。
   * 语义是「本 record 消息里被**任何 call**（通常在前一条 record）配对掉的 result」，
   * 不是「本 record 的 calls 配到的 result」（后者恒空）。渲染与索引用它将已配对行剔除。
   */
  pairedResultToolCallIds: Map<string, Set<string>>;
}

/** 已配对的 tool-result part（按 part 建索引，一条消息的多个 result 各自成条目）。 */
interface TrajectoryPairedToolResult {
  message: ZCodeModelTrajectoryMessage;
  part: Extract<ZCodeModelTrajectoryContentPart, { kind: "tool-result" }>;
}

/**
 * 调用级 key 的唯一来源：`<requestId>:<recordIndex>`（自 ModelTrajectoryTurns.ts 迁入，实现不变）。
 *
 * 它同时是 CallCard 的 `expansionKeyPrefix`、回合内调用列表的 Fragment key 与搜索项的 key；
 * 三处必须逐字一致——搜索命中靠它找回渲染节点，任一处漂移都会让定位静默失效。
 * `recordIndex` 是记录在入参数组里的全局下标，不是回合内序号。
 */
export function trajectoryCallKey(requestId: string, recordIndex: number): string {
  return `${requestId}:${recordIndex}`;
}

/**
 * 输入行展开键的唯一来源：`<前缀>:input:<messageIndex>`（自 ModelTrajectoryTurns.ts 迁入，实现不变）。
 * 前缀由 trajectoryCallKey 产生；`messageIndex` 始终是 wire 原始下标
 * （占位行被隐藏也不重排，保证开关切换不丢行级展开状态）。
 */
export function trajectoryInputRowKey(prefix: string, messageIndex: number): string {
  return `${prefix}:input:${messageIndex}`;
}

/**
 * 输出区工具调用行的 target key：`<callKey>:output:<kind>:<index>`。
 * 与迁移前渲染（ModelTrajectoryPaneParts.tsx 的 `${prefix}:output:${kind}:${index}`）和
 * 搜索索引（ModelTrajectorySearch.ts 的同款手拼模板）逐字同值；DOM 与索引共用此单源。
 */
export function trajectoryToolCallTargetKey(
  callKey: string,
  toolCallKind: ZCodeModelTrajectoryContentPart["kind"],
  toolCallIndex: number,
): string {
  return `${callKey}:output:${toolCallKind}:${toolCallIndex}`;
}

/** 单 part 的 result 展示文本（与 trajectoryToolOutputs 同源）。 */
function pairedResultText(result: TrajectoryPairedToolResult): string {
  return trajectoryToolOutputs({ role: "tool", parts: [result.part] })[0] ?? "";
}

/**
 * unknown 条目的 raw 原文（回退渲染 + 复制/全屏正文共用）；非 unknown 返回 undefined。
 *
 * 迁入本模块的原因：ToolPairCard.tsx 原本私有一份 rawPartText/formatRawPart，
 * 而 displayText（复制/全屏正文）也需要同一份原文——两份实现漂移会让
 * 「卡上显示的原文」与「复制到的文本」不一致。迁入后渲染与复制共用单源。
 */
export function trajectoryToolCallRawText(
  part: ZCodeModelTrajectoryContentPart,
): string | undefined {
  if (part.kind !== "unknown") return undefined;
  return formatRawPart(part.raw);
}

/** unknown 条目的 raw 原文（JSON 缩进形式；序列化失败回退 String）。 */
function formatRawPart(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}

/**
 * 索引 / 配对卡 DOM / 复制按钮三方共用的拼接文本：
 * use 段（trajectoryToolCallInputs 的 join 口径）+ 结果段，空段不拼、无尾分隔。
 *
 * unknown 条目（CR A-P2-6）：trajectoryToolCallInputs 只认 kind:"tool-call" 的 part，
 * 因此 unknown 的 use 段恒为空——复制按钮被禁用、全屏正文空白。
 * 这里把 raw 原文并入 use 段（回退渲染与复制/全屏同源），使 unknown 也有可复制、可全屏的正文。
 */
export function trajectoryToolCallDisplayText(info: TrajectoryToolCallInfo): string {
  const inputText = trajectoryToolCallInputs({ role: "assistant", parts: [info.part] }).join(
    "\n\n",
  );
  const useText =
    inputText || (info.part.kind === "unknown" ? (trajectoryToolCallRawText(info.part) ?? "") : "");
  if (!info.pairedResultText) return useText;
  return useText ? `${useText}\n\n${info.pairedResultText}` : info.pairedResultText;
}

/**
 * 跨记录 join（spec N-1）：先全局建 callId → result 索引，再逐 call 配对判定四态。
 *
 * - error：配对 result 的 output 是结构化错误（复用 trajectoryToolPayloadErrorText）；
 * - ok：配对到且无错误；
 * - pending：未配对且所属 record 是 records 最后一条（尾部在途是常态）；
 * - missing：未配对且非尾部（含被放弃 attempt 的 calls、含 kind:"unknown" 无 id 条目）。
 *
 * 同一 callId 在后续 record 的完整上下文里会重复出现：后写覆盖先写，文本同源无影响。
 */
export function joinTrajectoryToolResults(
  records: readonly ZCodeModelTrajectoryRecord[],
): TrajectoryToolJoinResult {
  const resultsByCallId = new Map<string, TrajectoryPairedToolResult>();
  const callIds = new Set<string>();
  for (const record of records) {
    for (const part of record.response?.toolCalls ?? []) {
      if (part.kind === "tool-call" && part.toolCallId) callIds.add(part.toolCallId);
    }
    for (const message of record.request.messages) {
      for (const part of message.parts) {
        // 无 id 的 result 不入 map，杜绝 undefined 误配对。
        if (part.kind !== "tool-result" || !part.toolCallId) continue;
        resultsByCallId.set(part.toolCallId, { message, part });
      }
    }
  }

  const lastRecordIndex = records.length - 1;
  const callToolCalls = new Map<string, TrajectoryToolCallInfo[]>();
  const pairedResultToolCallIds = new Map<string, Set<string>>();
  records.forEach((record, recordIndex) => {
    const key = trajectoryCallKey(record.requestId, recordIndex);
    callToolCalls.set(
      key,
      (record.response?.toolCalls ?? []).map((part) => {
        const callId = part.kind === "tool-call" ? part.toolCallId : undefined;
        const result = callId ? resultsByCallId.get(callId) : undefined;
        if (!result) {
          return {
            part,
            status: recordIndex === lastRecordIndex ? "pending" : "missing",
            pairedResultText: "",
          };
        }
        return {
          part,
          status: trajectoryToolPayloadErrorText(result.part.output) !== undefined ? "error" : "ok",
          pairedResultText: pairedResultText(result),
          pairedResultToolName: result.part.toolName,
          pairedResultToolId: result.part.toolCallId,
        };
      }),
    );

    // 只收「本 record 消息里被全局任何 call 消费掉」的 result id；孤立 result 不入集合，
    // 从而不会被 filterTrajectoryInputRows 剔除（窗口边界的孤立结果必须保留可读）。
    const pairedIds = new Set<string>();
    for (const message of record.request.messages) {
      for (const part of message.parts) {
        if (part.kind === "tool-result" && part.toolCallId && callIds.has(part.toolCallId)) {
          pairedIds.add(part.toolCallId);
        }
      }
    }
    pairedResultToolCallIds.set(key, pairedIds);
  });

  return { callToolCalls, pairedResultToolCallIds };
}

/**
 * 行是否整行剔除：该行至少有一个 part、且**全部** part 都是带 id 且已被配对消费的
 * tool-result。无 id / 行内含 text 等非 result part / 存在未配对 result part 一律保留
 * ——混合形态按保守处理（不丢内容；实测 1364/1364 单 part）。
 */
function isFullyPairedToolResultRow(
  message: ZCodeModelTrajectoryMessage,
  pairedIds: ReadonlySet<string>,
): boolean {
  if (message.parts.length === 0) return false;
  return message.parts.every(
    (part) =>
      part.kind === "tool-result" &&
      Boolean(part.toolCallId) &&
      pairedIds.has(part.toolCallId ?? ""),
  );
}

/**
 * 配对行剔除（r3 P2-10 形式化谓词）：渲染与搜索索引共用，不改 inputMessages 本身。
 * 只丢行、不按下标重排——messageIndex 仍是 wire 原始下标，展开键与奇偶底色不变。
 */
export function filterTrajectoryInputRows(
  rows: TrajectoryWireRow<ZCodeModelTrajectoryMessage>[],
  pairedIds: ReadonlySet<string>,
): { visibleRows: TrajectoryWireRow<ZCodeModelTrajectoryMessage>[]; pairedRemovedCount: number } {
  if (pairedIds.size === 0) {
    // 返回副本而非入参引用（CR A-P2-2）：调用方拿到 visibleRows 后若就地改写，
    // 不能反向污染原始 rows（下游拿到的就是同一份 inputMessages 行数组）。
    return { visibleRows: rows.slice(), pairedRemovedCount: 0 };
  }
  const visibleRows: TrajectoryWireRow<ZCodeModelTrajectoryMessage>[] = [];
  let pairedRemovedCount = 0;
  for (const row of rows) {
    if (isFullyPairedToolResultRow(row.message, pairedIds)) {
      pairedRemovedCount += 1;
      continue;
    }
    visibleRows.push(row);
  }
  return { visibleRows, pairedRemovedCount };
}
