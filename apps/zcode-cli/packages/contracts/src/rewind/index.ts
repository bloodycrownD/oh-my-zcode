// ============================================================
// Rewind Contracts - checkpoint payloads and rewind helpers
// ============================================================

import { z } from "zod";

import type { MessageId } from "../interfaces/shared.js";

const diffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

export const RewindScope = {
  Conversation: "conversation",
  Workspace: "workspace",
  Both: "both",
} as const;

export type RewindScope = (typeof RewindScope)[keyof typeof RewindScope];

// MF-08：本枚举原先还挂着一个「只回滚文件、不动对话链」的成员。evaluateRewindTarget
// 只产出 ActiveChain / Unavailable，那个成员从来没有产生点，是枚举与 wire schema 里的死值，
// 一并删除，避免调用方写出恒假分支。
export const RewindStrategy = {
  ActiveChain: "active_chain",
  ForkRequired: "fork_required",
  Unavailable: "unavailable",
} as const;

export type RewindStrategy = (typeof RewindStrategy)[keyof typeof RewindStrategy];

export const RewindTargetStatus = {
  ActiveChain: "active_chain",
  Missing: "missing",
} as const;

export type RewindTargetStatus = (typeof RewindTargetStatus)[keyof typeof RewindTargetStatus];

export const checkpointCreatedPayloadSchema = z
  .object({
    checkpointId: z.string().min(1),
    messageId: z.string().min(1),
    targetMessageId: z.string().min(1).optional(),
    toolMessageId: z.string().min(1).optional(),
    scope: z.enum([RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]),
    snapshotRef: z.string().min(1),
    diffRef: z.string().min(1).optional(),
    fileCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CheckpointCreatedPayload = Omit<
  z.infer<typeof checkpointCreatedPayloadSchema>,
  "messageId" | "targetMessageId" | "toolMessageId"
> & {
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
};

export const rewindTriggeredPayloadSchema = z
  .object({
    rewindId: z.string().min(1),
    scope: z.enum([RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]),
    strategy: z.enum([
      RewindStrategy.ActiveChain,
      RewindStrategy.ForkRequired,
      RewindStrategy.Unavailable,
    ]),
    targetMessageId: z.string().min(1).optional(),
    targetCheckpointId: z.string().min(1).optional(),
    restoredSnapshotRef: z.string().min(1).optional(),
    branchCutAfterMessageId: z.string().min(1).optional(),
    branchGeneration: z.number().int().nonnegative().optional(),
    createdMessageId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export type RewindTriggeredPayload = Omit<
  z.infer<typeof rewindTriggeredPayloadSchema>,
  "targetMessageId" | "branchCutAfterMessageId" | "createdMessageId"
> & {
  branchCutAfterMessageId?: MessageId;
  targetMessageId?: MessageId;
  createdMessageId?: MessageId;
};

export const workspaceCheckpointArtifactSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("workspace_file_before_change"),
    createdAt: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            existedBefore: z.boolean(),
            beforeContent: z.string().nullable(),
            afterContent: z.string().optional(),
            afterContentLength: z.number().int().nonnegative().optional(),
            structuredPatch: z.array(diffHunkSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type WorkspaceCheckpointArtifact = z.infer<typeof workspaceCheckpointArtifactSchema>;

export interface CheckpointProjectionInfo {
  checkpointId: string;
  createdAt: Date;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  scope: RewindScope;
  snapshotRef: string;
}

export interface RewindProjectionInfo {
  reason?: string;
  rewindId: string;
  scope: RewindScope;
  strategy: RewindStrategy;
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  triggeredAt: Date;
}

export interface RewindTargetEvaluation {
  allowedScopes: RewindScope[];
  reason: string;
  strategy: RewindStrategy;
  targetStatus: RewindTargetStatus;
}

export interface EvaluateRewindTargetInput<T extends { id: string }> {
  checkpointAvailable?: boolean;
  getId?: (item: T) => string;
  items: readonly T[];
  scope: RewindScope;
  targetMessageId: MessageId | string;
}

export interface ActiveConversationBranchOptions {
  branchCutAfterMessageId?: MessageId;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
}

// ============================================================
// Committed-failure contract（I4 事务边界）
// ============================================================

/** 类型化错误的稳定标识：跨包判定不用 `instanceof`（多份 module 实例会失效）。 */
export const CONVERSATION_REWIND_COMMITTED = "conversation_rewind_committed" as const;

/**
 * 截断**已经落盘**之后的失败（`setRevert` 之后，`discardRewoundPendingSteerInputs` /
 * `rebuildConversationDerivedState` / `RewindTriggered` 任一抛错）。
 *
 * 为什么必须是类型化事实、而不是让调用方用一个局部布尔：`setRevert` 在 rewind
 * 原语内部（`rewind-message.ts` 的 `applyConversationRewindPlan`），调用方只能把
 * 布尔语句放在整次调用**之后**——中途抛错时布尔仍是 false，于是「历史已截断」被
 * 当成「什么都没发生」原样 rethrow（没有 draftText、没有「历史已回退」文案）。
 * 抛错路径本身就是提交事实的唯一证据，所以由原语在 catch 里把它变成这个错误。
 *
 * `committed` 是给调用方读的事实字段；`rewindId` / `targetMessageId` 供对账与日志，
 * `cause` 保留原始失败（诊断用，不得据此回写 revert——文件回退已不可逆）。
 */
export class ConversationRewindCommittedError extends Error {
  readonly code = CONVERSATION_REWIND_COMMITTED;
  readonly committed = true;
  readonly rewindId: string;
  readonly targetMessageId?: MessageId;

  constructor(options: {
    cause: unknown;
    message?: string;
    rewindId: string;
    targetMessageId?: MessageId;
  }) {
    super(
      options.message ??
        `conversation rewind committed but a post-commit step failed: ${
          options.cause instanceof Error ? options.cause.message : String(options.cause)
        }`,
    );
    this.name = "ConversationRewindCommittedError";
    this.rewindId = options.rewindId;
    if (options.targetMessageId !== undefined) {
      this.targetMessageId = options.targetMessageId;
    }
    this.cause = options.cause;
  }
}

export function isConversationRewindCommittedError(
  error: unknown,
): error is ConversationRewindCommittedError {
  return (
    error instanceof Error && (error as { code?: unknown }).code === CONVERSATION_REWIND_COMMITTED
  );
}

/** runtime resume、cold projection 与 stable fork 共用的 conversation active-branch 裁剪。 */
export function selectActiveConversationBranch<T extends { info: { id: MessageId } }>(
  messages: readonly T[],
  options: ActiveConversationBranchOptions = {},
): T[] {
  if (!options.rewindTargetMessageId) return [...messages];
  const messagesById = new Map(messages.map((message) => [message.info.id, message]));
  const targetIndex = messages.findIndex(
    (message) => message.info.id === options.rewindTargetMessageId,
  );
  const kept = options.rewindKeptMessageIds
    ? options.rewindKeptMessageIds
        .map((messageId) => messagesById.get(messageId))
        .filter((message): message is T => message !== undefined)
    : targetIndex >= 0
      ? messages.slice(0, targetIndex)
      : [...messages];

  if (options.branchCutAfterMessageId) {
    const cutIndex = messages.findIndex(
      (message) => message.info.id === options.branchCutAfterMessageId,
    );
    // rewind 不再写 model-visible reminder。cut 游标直接指向提交前 transcript
    // 尾部，之后追加的任意 canonical message 自动属于新分支；旧分支仍留在 append-only store。
    return cutIndex >= 0 ? [...kept, ...messages.slice(cutIndex + 1)] : kept;
  }

  if (options.rewindKeptMessageIds) {
    if (!options.rewindCreatedMessageId) return kept;
    const createdIndex = messages.findIndex(
      (message) => message.info.id === options.rewindCreatedMessageId,
    );
    return createdIndex >= 0 ? [...kept, ...messages.slice(createdIndex)] : kept;
  }
  if (targetIndex < 0) return [...messages];
  if (!options.rewindCreatedMessageId) return kept;
  const createdIndex = messages.findIndex(
    (message) => message.info.id === options.rewindCreatedMessageId,
  );
  return createdIndex >= 0 ? [...kept, ...messages.slice(createdIndex)] : kept;
}

export function parseCheckpointCreatedPayload(input: unknown): CheckpointCreatedPayload {
  return checkpointCreatedPayloadSchema.parse(input) as CheckpointCreatedPayload;
}

export function parseRewindTriggeredPayload(input: unknown): RewindTriggeredPayload {
  return rewindTriggeredPayloadSchema.parse(input) as RewindTriggeredPayload;
}

export function parseWorkspaceCheckpointArtifact(input: unknown): WorkspaceCheckpointArtifact {
  return workspaceCheckpointArtifactSchema.parse(input) as WorkspaceCheckpointArtifact;
}

export function evaluateRewindTarget<T extends { id: string }>(
  input: EvaluateRewindTargetInput<T>,
): RewindTargetEvaluation {
  const getId = input.getId ?? ((item: T) => item.id);
  const targetIndex = input.items.findIndex((item) => getId(item) === input.targetMessageId);

  if (targetIndex < 0) {
    return {
      allowedScopes: [],
      reason: "target_not_found",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.Missing,
    };
  }

  const checkpointAvailable = input.checkpointAvailable === true;
  const allowedScopes = activeChainAllowedScopes(checkpointAvailable);
  if (!isRequestedScopeAllowed(input.scope, allowedScopes)) {
    return {
      allowedScopes,
      reason: "checkpoint_required_for_workspace_rewind",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.ActiveChain,
    };
  }

  return {
    allowedScopes,
    reason: "target_in_active_chain",
    strategy: RewindStrategy.ActiveChain,
    targetStatus: RewindTargetStatus.ActiveChain,
  };
}

function activeChainAllowedScopes(checkpointAvailable: boolean): RewindScope[] {
  return checkpointAvailable
    ? [RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]
    : [RewindScope.Conversation];
}

function isRequestedScopeAllowed(
  scope: RewindScope,
  allowedScopes: readonly RewindScope[],
): boolean {
  return allowedScopes.includes(scope);
}
