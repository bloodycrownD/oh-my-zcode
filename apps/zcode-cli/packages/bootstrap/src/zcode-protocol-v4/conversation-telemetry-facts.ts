import type {
  SessionEvent,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnStartedPayload,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { parseAutomationRunId } from "@zcode/shared";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@zcode/shared/zcode-protocol-v4";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventTimestamp(event: SessionEvent): number {
  const value =
    event.timestamp instanceof Date ? event.timestamp.getTime() : Number(event.timestamp);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function automationAdmission(inputId: string | undefined, automationId: string | undefined) {
  if (!inputId || !automationId) return {};
  const parsed = parseAutomationRunId(inputId);
  // inputId 不是本 automation 的 runId（历史入口漏传、异常透传）时不猜触发方式：
  // 只保留关联 ID，避免把普通输入误标成 schedule 或从无关字符串切出伪 scheduledAt。
  if (!parsed || parsed.automationId !== automationId) return { automationId };
  return {
    automationId,
    taskTrigger: parsed.trigger,
    ...(parsed.scheduledAt !== undefined ? { scheduledAt: parsed.scheduledAt } : {}),
  };
}

function terminalStatus(resultType: string): "success" | "interrupted" | "failed" {
  if (resultType === "success") return "success";
  if (resultType === "cancelled") return "interrupted";
  return "failed";
}

/**
 * 把本进程 live SessionEvent 中的轮次起止归一成 `turn.started` / `turn.terminal` 事实，
 * 供 App/服务端统计运行中的会话数。事实不带正文，只带 admission 给出的 inputId 与终态摘要。
 * 该类不读取 transcript/snapshot，因而无法在 hydration/recovery 时补造事件。
 *
 * 其余事实（模型状态、流式分片、工具/权限生命周期、用量、子代理、压缩、工作流）随遥测通道
 * 一并删除——协议侧 schema 已是二选一的 strict 判别联合，产出别的 kind 会被整条拒收。
 */
export class ConversationTelemetryFactNormalizer {
  private readonly sourceCommandByTurn = new Map<string, string>();

  normalize(sessionId: string, event: SessionEvent): ConversationTelemetryFact | null {
    const turnId = event.turnId ? String(event.turnId) : undefined;
    const turnKey = turnId ? `${sessionId}\0${turnId}` : undefined;
    const base = {
      version: 1 as const,
      eventId: String(event.id),
      eventSeq: Math.max(0, Math.floor(event.sequenceNumber)),
      occurredAt: eventTimestamp(event),
      sessionId,
      ...(turnId ? { turnId } : {}),
    };
    const sourceCommandId = turnKey ? this.sourceCommandByTurn.get(turnKey) : undefined;

    switch (event.type) {
      case SessionEventType.TurnStarted: {
        const payload = event.payload as TurnStartedPayload;
        const backgroundSource =
          payload.backgroundSource === "bash" ||
          payload.backgroundSource === "subagent" ||
          payload.backgroundSource === "workflow"
            ? payload.backgroundSource
            : undefined;
        // 用户轮与 background wake 均由 admission 提供 inputId，不混用持久化 messageId。
        const inputId = optionalString(payload.inputId);
        if (turnKey && inputId) this.sourceCommandByTurn.set(turnKey, inputId);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.started",
          ...(inputId ? { sourceCommandId: inputId } : {}),
          ...automationAdmission(inputId, optionalString(payload.automationId)),
          ...(optionalString(payload.offPeakTaskId)
            ? { offPeakTaskId: optionalString(payload.offPeakTaskId) }
            : {}),
          ...(payload.offPeakRunType ? { offPeakRunType: payload.offPeakRunType } : {}),
          ...(payload.executionKind ? { executionKind: payload.executionKind } : {}),
          ...(payload.inputSource ? { inputSource: payload.inputSource } : {}),
          ...(backgroundSource ? { backgroundSource } : {}),
        });
      }
      case SessionEventType.TurnComplete: {
        const payload = event.payload as TurnCompletePayload;
        const directSourceCommandId = optionalString(payload.inputId) ?? sourceCommandId;
        const fact = conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          ...(directSourceCommandId ? { sourceCommandId: directSourceCommandId } : {}),
          status: terminalStatus(payload.resultType),
          resultType: payload.resultType,
          durationMs: payload.duration,
          tokenCount: payload.tokenCount,
          toolCallCount: payload.toolCallCount,
          ...(payload.resultType === "cancelled"
            ? {
                errorCode: "USER_INTERRUPT",
                errorMessage: "User stopped generation",
              }
            : {}),
          ...(payload.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
        });
        this.clearTurn(turnKey);
        return fact;
      }
      case SessionEventType.TurnError: {
        const payload = event.payload as TurnErrorPayload;
        const directSourceCommandId = optionalString(payload.inputId) ?? sourceCommandId;
        const fact = conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          ...(directSourceCommandId ? { sourceCommandId: directSourceCommandId } : {}),
          status: "failed",
          errorCode: payload.error.code ?? payload.error.type,
          errorMessage: payload.error.message,
          ...(payload.error.retryable !== undefined
            ? { errorRetryable: payload.error.retryable }
            : {}),
          ...(payload.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          turnPhase: payload.turnPhase,
        });
        this.clearTurn(turnKey);
        return fact;
      }
      default:
        return null;
    }
  }

  private clearTurn(turnKey: string | undefined): void {
    if (!turnKey) return;
    this.sourceCommandByTurn.delete(turnKey);
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.sourceCommandByTurn.keys()) {
      if (key.startsWith(prefix)) this.sourceCommandByTurn.delete(key);
    }
  }
}