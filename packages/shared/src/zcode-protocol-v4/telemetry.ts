import { z } from "zod";
import { zcodeSyntheticUserMessageSourceSchema } from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";

// Phase 1 遥测移除后本文件只保留 `turn.started` / `turn.terminal` 两条会话事实：
// `conversationTelemetryFact` 通知名、`v4/telemetry/event` transport 与 host emitter 均在（D-8），
// 下游 `taskActivityTracker` 用这两条事实算「运行中任务数」，删掉即静默恒 0。
// 其余 kind（model.request.status / stream.chunk / tool.lifecycle / permission.lifecycle /
// usage.delta / subagent.lifecycle / workflow.lifecycle / compaction.terminal）随之删除。

const factBaseFields = {
  /** 会话创建期采用的 App Memory 开关，不表示记忆读写结果。 */
  memoryEnabled: z.boolean().optional(),
  version: z.literal(1),
  eventId: z.string().min(1),
  eventSeq: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  sessionId: z.string().min(1),
  sourceCommandId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
} as const;

const turnStartedFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.started"),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    inputSource: zcodeSyntheticUserMessageSourceSchema.optional(),
    // `workflow`：dynamic-workflow run 的完成 / 提问通知唤起的独立轮。
    backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
    automationId: z.string().min(1).optional(),
    offPeakTaskId: z.string().min(1).optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    taskTrigger: z.enum(["schedule", "manual"]).optional(),
    scheduledAt: timestampSchema.optional(),
  })
  .strict();

const turnTerminalFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.terminal"),
    status: z.enum(["success", "interrupted", "failed"]),
    resultType: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokenCount: z.number().nonnegative().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    errorRetryable: z.boolean().optional(),
    turnPhase: z.string().optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();

/**
 * CLI 经 `v4/telemetry/event` 上送的实时会话事实，供桌面运行中会话统计消费。
 * 每个分支都 strict，避免新增 runtime 字段时把 prompt、工具输入或 provider URL 意外外带。
 */
const conversationTelemetryFactRuntimeSchema = z
  .discriminatedUnion("kind", [turnStartedFactSchema, turnTerminalFactSchema])
  .superRefine((fact, context) => {
    if (fact.kind === "turn.started" && fact.automationId && fact.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (fact.kind === "turn.started" && fact.offPeakRunType && !fact.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
  });

type ConversationTelemetryFactBase = z.infer<typeof conversationTelemetryFactRuntimeSchema>;
type TurnStartedConversationTelemetryFact = Extract<
  ConversationTelemetryFactBase,
  { kind: "turn.started" }
> &
  import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution;

export type ConversationTelemetryFact =
  | Exclude<ConversationTelemetryFactBase, { kind: "turn.started" }>
  | TurnStartedConversationTelemetryFact;

export const conversationTelemetryFactSchema = conversationTelemetryFactRuntimeSchema.transform(
  (fact): ConversationTelemetryFact => fact as ConversationTelemetryFact,
);