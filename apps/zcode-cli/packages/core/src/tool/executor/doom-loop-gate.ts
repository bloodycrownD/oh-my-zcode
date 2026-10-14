import { CoreErrorType, createCoreError, type CollaborationMode } from "@zcode/contracts";
import type { ToolExecutionResult } from "../types.js";
import type { ExecutableToolCall } from "../types.js";
import { createErrorResult } from "./errors.js";

/**
 * Doom loop 门（opencode 式，2026-10-14 用户拍板：事不过三——容忍 3 次重复，
 * 第 4 次调用执行前拦截）。同工具+同输入连续第 DOOM_LOOP_THRESHOLD 次调用在
 * **执行前**拦截——ask 弹权限卡（复用 permission flow 的整套确认窗/broker/hook
 * race），deny 直接拒并停止本轮，off 关闭。
 * 无权限客户端时 broker 请求自动失败（"No permission client configured"），
 * ask 降级为拒绝——规避 opencode #18108（子代理 ask 死锁）。
 *
 * 与 runtime/helpers/model-anomaly.ts 的软提醒并存成梯度：软提醒阈值 3
 * （streak≥3 注入提示文本，由 turn loop 在工具执行后触发），本门阈值 4 在执行前
 * 拦截——第 3 次提醒、第 4 次硬拦。两者签名算法相同（键序稳定化 JSON），
 * 各自独立计数，互不耦合——本文件不得 import runtime/helpers（分层方向）。
 */

export type DoomLoopCheckMode = "ask" | "deny" | "off";

export interface DoomLoopGateState {
  /**
   * signature → 连续调用计数（执行前推进）。streak 语义要求「连续」：被任何
   * 异签名调用打断后，被打断签名的计数即作废（opencode #25254 教训——否则
   * A,A,B,A 会把 A 误判为 3 连）。lastSignature 单游标驱动打断清除。
   */
  readonly streaks: Map<string, { count: number; toolName: string }>;
  lastSignature?: string;
  /** 会话级豁免（权限卡「本会话总是允许」，由 broker sessionPermissionUpdates 驱动）。 */
  readonly exemptTools: Set<string>;
}

/** 事不过三：容忍 3 次重复执行，第 4 次调用在执行前被拦（2026-10-14 用户拍板）。 */
export const DOOM_LOOP_THRESHOLD = 4;

export function createDoomLoopGateState(): DoomLoopGateState {
  return { streaks: new Map(), exemptTools: new Set() };
}

export function buildDoomLoopSignature(toolName: string, input: unknown): string {
  return `${JSON.stringify(toolName)}:${stableJson(input)}`;
}

/** 与 model-anomaly.ts 的 stableJson 保持同步（复制以避免 tool→runtime 反向依赖）。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export interface DoomLoopStreak {
  signature: string;
  count: number;
}

export function recordDoomLoopStreak(
  state: DoomLoopGateState,
  toolName: string,
  input: unknown,
): DoomLoopStreak {
  const signature = buildDoomLoopSignature(toolName, input);
  if (state.lastSignature !== undefined && state.lastSignature !== signature) {
    // 连续性打断：上一个签名的累计作废（见 DoomLoopGateState.streaks 注释）。
    state.streaks.delete(state.lastSignature);
  }
  state.lastSignature = signature;
  const previous = state.streaks.get(signature);
  const count = previous ? previous.count + 1 : 1;
  state.streaks.set(signature, { count, toolName });
  return { signature, count };
}

export type DoomLoopGateVerdict = "pass" | "ask" | "deny";

export function evaluateDoomLoopGate(
  state: DoomLoopGateState,
  mode: DoomLoopCheckMode,
  toolName: string,
  count: number,
): DoomLoopGateVerdict {
  if (mode === "off") return "pass";
  if (state.exemptTools.has(toolName)) return "pass";
  if (count < DOOM_LOOP_THRESHOLD) return "pass";
  return mode === "deny" ? "deny" : "ask";
}

export interface DoomLoopGateIntervention {
  verdict: DoomLoopGateVerdict;
  count: number;
  askDecision?: ReturnType<typeof buildDoomLoopAskDecision>;
  deniedResult?: ToolExecutionResult;
}

/**
 * permission-flow 的主门入口（一层收拢，保持 permission-flow 行数红线内）：
 * 推进 streak → 判定 → deny 构造带停轮的错误结果，ask 构造 decision 改写，
 * pass 不产生干预。调用方只需处理 verdict 分支。
 */
export function interveneDoomLoopGate(
  state: DoomLoopGateState,
  mode: DoomLoopCheckMode,
  toolCall: ExecutableToolCall,
  executionInput: unknown,
  collaborationMode: CollaborationMode,
): DoomLoopGateIntervention {
  const streak = recordDoomLoopStreak(state, toolCall.name, executionInput);
  const verdict = evaluateDoomLoopGate(state, mode, toolCall.name, streak.count);
  if (verdict === "deny") {
    return {
      verdict,
      count: streak.count,
      deniedResult: buildDoomLoopDeniedResult(
        toolCall,
        toolCall.name,
        streak.count,
        buildDoomLoopReason(toolCall.name, streak.count),
      ),
    };
  }
  if (verdict === "ask") {
    return {
      verdict,
      count: streak.count,
      askDecision: buildDoomLoopAskDecision(toolCall.name, streak.count, collaborationMode),
    };
  }
  return { verdict, count: streak.count };
}

export function buildDoomLoopReason(toolName: string, count: number): string {
  return `Doom loop detected: ${toolName} has been called ${count} times in a row with identical input. Allow once, always allow this tool in this session, or deny to stop the turn.`;
}

/** ask：改写 permissionDecision 为 doom_loop ask，走 permission flow 既有确认窗链路。 */
export function buildDoomLoopAskDecision(
  toolName: string,
  count: number,
  mode: CollaborationMode,
) {
  return {
    allowed: false,
    decision: "ask" as const,
    escalated: false,
    mode,
    reason: buildDoomLoopReason(toolName, count),
    riskLevel: "medium" as const,
    ruleId: "doom_loop",
  };
}

const DOOM_LOOP_DENIED_MODEL_MESSAGE = (toolName: string, count: number) =>
  `Tool call blocked by doom loop detection: ${toolName} was called ${count} times in a row with identical input and the turn has been stopped. If this repetition is intentional, ask the user to allow it from settings (doomLoopCheck) and re-run.`;

/**
 * deny / 用户拒绝：构造带 turnControl 停轮的错误结果（stopTurnAfterResult 既有
 * 机制由 batch-runner/turn loop 消费，reason=doom_loop 与 automation_create_limit
 * 同一通道）。startedAt/completedAt 即时戳——调用从未执行，无真实执行时序。
 */
export function buildDoomLoopDeniedResult(
  toolCall: ExecutableToolCall,
  toolName: string,
  count: number,
  reason: string,
): ToolExecutionResult {
  const coreError = createCoreError(CoreErrorType.PermissionDenied, reason, {
    context: { ruleId: "doom_loop", toolCallId: toolCall.id, toolName },
    recoverable: true,
  });
  const base = createErrorResult(toolCall, coreError);
  return {
    ...base,
    modelContent: DOOM_LOOP_DENIED_MODEL_MESSAGE(toolName, count),
    turnControl: {
      reason: "doom_loop",
      stopTurnAfterResult: true,
    },
  };
}

/** 权限卡 deny（用户拒绝 ask）后为既有 error result 补 doom 停轮标记。 */
export function withDoomLoopTurnStop(result: ToolExecutionResult): ToolExecutionResult {
  if (result.success) return result;
  return {
    ...result,
    turnControl: { reason: "doom_loop", stopTurnAfterResult: true },
  };
}

/**
 * 权限卡 allow 且携带 sessionPermissionUpdates（「本会话总是允许」）时登记豁免。
 * 判定宽松匹配：任何针对 ruleId=doom_loop 的 allow 更新即豁免该工具。
 */
export function applyDoomLoopSessionUpdates(
  state: DoomLoopGateState,
  toolName: string,
  sessionUpdates: Array<{ ruleId?: string; decision?: string; effect?: string }> | undefined,
): void {
  if (!sessionUpdates?.length) return;
  const doomAllow = sessionUpdates.some(
    (update) =>
      update.ruleId === "doom_loop" &&
      (update.decision === "allow" || update.effect === "allow"),
  );
  if (doomAllow) state.exemptTools.add(toolName);
}
