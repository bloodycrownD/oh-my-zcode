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

/** 裁断只需要 rewind 选项；正文与 role 一律不参与（IS2：「id 必须全序，正文可窗口」）。 */
export interface ActiveConversationBranchRewind {
  branchCutAfterMessageId?: MessageId;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
}

export interface ActiveConversationBranchOptions<
  T = unknown,
> extends ActiveConversationBranchRewind {
  /**
   * 条目 → messageId 访问器。缺省读全量消息的 `{ info: { id } }`；索引条目
   * （`SessionMessageIndexEntry`）没有 `info`，走索引路径时必须显式给出。
   */
  getMessageId?: (item: T) => MessageId;
}

/**
 * conversation active-branch 裁剪的**唯一实现**：只吃 id 序。
 *
 * 全量消息路径（`selectActiveConversationBranch`）与索引路径
 * （`listSessionMessageIndex` 给出的 id 序）都规约到这一份规则，避免两套裁断在
 * `target`/`cut` 落点或 `keptMessageIDs` 缺失时给出不同分支——那样的分歧不是崩溃，
 * 而是**静默复活已回滚分支**或**整段清空历史**（spec IS2 / T-SL2）。
 *
 * 输入必须是由调用方保证的**全序** id 序列（窗口序会因 `targetIndex < 0` 复活旧分支）。
 */
export function selectActiveConversationBranchIds(
  orderedMessageIds: readonly string[],
  options: ActiveConversationBranchRewind = {},
): string[] {
  if (!options.rewindTargetMessageId) return [...orderedMessageIds];
  const indexById = new Map<string, number>();
  orderedMessageIds.forEach((messageId, index) => {
    if (!indexById.has(messageId)) indexById.set(messageId, index);
  });
  const targetIndex = indexById.get(options.rewindTargetMessageId) ?? -1;
  const kept = options.rewindKeptMessageIds
    ? options.rewindKeptMessageIds.filter((messageId) => indexById.has(messageId))
    : targetIndex >= 0
      ? orderedMessageIds.slice(0, targetIndex)
      : [...orderedMessageIds];

  if (options.branchCutAfterMessageId) {
    const cutIndex = indexById.get(options.branchCutAfterMessageId) ?? -1;
    // rewind 不再写 model-visible reminder。cut 游标直接指向提交前 transcript
    // 尾部，之后追加的任意 canonical message 自动属于新分支；旧分支仍留在 append-only store。
    return cutIndex >= 0 ? [...kept, ...orderedMessageIds.slice(cutIndex + 1)] : kept;
  }

  if (options.rewindKeptMessageIds) {
    if (!options.rewindCreatedMessageId) return kept;
    const createdIndex = indexById.get(options.rewindCreatedMessageId) ?? -1;
    return createdIndex >= 0 ? [...kept, ...orderedMessageIds.slice(createdIndex)] : kept;
  }
  if (targetIndex < 0) return [...orderedMessageIds];
  if (!options.rewindCreatedMessageId) return kept;
  const createdIndex = indexById.get(options.rewindCreatedMessageId) ?? -1;
  return createdIndex >= 0 ? [...kept, ...orderedMessageIds.slice(createdIndex)] : kept;
}

/**
 * runtime resume、cold projection 与 stable fork 共用的 conversation active-branch 裁剪。
 *
 * 输入放宽：条目不再必须是全量 `MessageWithParts`——只要给 `getMessageId`，索引条目
 * （只有 id 与排序键）也能裁断。裁断逻辑本身在 `selectActiveConversationBranchIds`，
 * 本函数只做「id 序 → 条目」的映射，**不得**再写第二份分支判断。
 */
export function selectActiveConversationBranch<T>(
  items: readonly T[],
  options: ActiveConversationBranchOptions<T> = {},
): T[] {
  if (!options.rewindTargetMessageId) return [...items];
  const getId = options.getMessageId ?? defaultMessageIdOf<T>;
  const indexById = new Map<string, number>();
  const orderedMessageIds: string[] = [];
  items.forEach((item, index) => {
    const messageId = getId(item);
    orderedMessageIds.push(messageId);
    if (!indexById.has(messageId)) indexById.set(messageId, index);
  });
  return selectActiveConversationBranchIds(orderedMessageIds, options).map(
    (messageId) => items[indexById.get(messageId)!]!,
  );
}

function defaultMessageIdOf<T>(item: T): MessageId {
  return (item as { info: { id: MessageId } }).info.id;
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
