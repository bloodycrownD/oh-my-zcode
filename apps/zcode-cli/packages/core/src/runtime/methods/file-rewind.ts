import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { applyPatch, type StructuredPatch } from "diff";
import {
  RewindScope,
  RewindStrategy,
  SessionEventType,
  getCurrentTraceContext,
  isFileSystemPortError,
  parseWorkspaceCheckpointArtifact,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CheckpointCreatedPayload,
  MessageId,
  TraceContext,
  TurnId,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointForRewind,
  selectCheckpointsForMessages,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type {
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindIgnoredFile,
  WorkspaceFileRewindPreview,
  WorkspaceFileRewindSafeFile,
  WorkspaceFileRewindUnsafeFile,
  WorkspaceFileRewindUnsafeReason,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

type PlannedFileState = {
  content: string | null;
  exists: boolean;
  hash: string | null;
};

type FileCheckpointOperation = {
  action: "restore" | "delete";
  afterContent: string | null;
  artifact: WorkspaceCheckpointArtifact;
  beforeContent: string | null;
  checkpoint: CheckpointCreatedPayload;
  path: string;
  toolName: string;
};

type WorkspaceFileRewindPlan = WorkspaceFileRewindPreview & {
  operations: FileCheckpointOperation[];
};

type FileRewindJournalEntry = {
  path: string;
  state: PlannedFileState;
};

interface FileAggregate {
  action: "restore" | "delete";
  operationCount: number;
  path: string;
  toolNames: Set<string>;
  unsafe?: {
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    reason: WorkspaceFileRewindUnsafeReason;
  };
}

interface IgnoredFileAggregate {
  operationCount: number;
  path: string;
  toolNames: Set<string>;
}

export async function previewWorkspaceFileRewind(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  } = {},
): Promise<WorkspaceFileRewindPreview> {
  const plan = await buildWorkspaceFileRewindPlan.call(this, options);
  return toPreview(plan);
}

export async function applyWorkspaceFileRewind(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    /** 组合 rewind 的提交闸：文件全部写成功后、workspace event 发布前提交 branch cut。 */
    commitAfterApply?: () => Promise<void>;
  } = {},
): Promise<WorkspaceFileRewindApplyResult> {
  const traceContext = options.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;
  const plan = await buildWorkspaceFileRewindPlan.call(this, {
    ...options,
    traceContext,
  });
  if (!plan.canApply) {
    return {
      applied: false,
      failurePhase: "apply",
      preview: toPreview(plan),
      response: "File rewind was not applied because at least one file is unsafe.",
    };
  }

  if (!this.fileSystemPort) {
    return {
      applied: false,
      failurePhase: "apply",
      preview: toPreview({
        ...plan,
        canApply: false,
        unsafeFiles: [
          ...plan.unsafeFiles,
          {
            operationCount: 1,
            path: "workspace",
            reason: "file_read_failed",
            toolNames: [],
            message: "FileSystemPort is not configured.",
          },
        ],
      }),
      response: "File rewind was not applied because the file-system adapter is unavailable.",
    };
  }

  const restoredFiles: Array<{ action: "delete" | "restore"; path: string }> = [];
  const journal: FileRewindJournalEntry[] = [];
  // 阶段边界（spec edit-resend-stale-text / I4、变更点 13）：apply 与 commit 必须分开。
  // - apply 阶段（写文件）失败 → journal 可以补偿，工作区回到命令执行前；
  // - commit 阶段（文件已全部写成功后的 commitAfterApply，典型是会话截断）一旦开始，
  //   **绝不补偿文件**。文件回退不可逆，而 commit 里 setRevert 之后的
  //   rebuildConversationDerivedState / appendEvent 可能已经抛错——补偿会造出
  //   「会话已截断 + 文件未截断」，重启也不自愈（cold-event-merge 只收敛会话分支）。
  let commitStarted = false;
  try {
    for (const operation of plan.operations) {
      throwIfTurnAborted(options.abortSignal);
      const state = await readCurrentFileState.call(
        this,
        operation.path,
        traceContext,
        options.abortSignal,
      );
      if ("reason" in state) {
        throw new Error(state.message ?? `Failed to journal ${operation.path}`);
      }
      journal.push({ path: operation.path, state });
      if (operation.action === "delete" || operation.beforeContent === null) {
        await this.fileSystemPort.removeFile(
          {
            path: operation.path,
            missingOk: true,
            trace: traceContext,
          },
          { signal: options.abortSignal },
        );
        restoredFiles.push({ action: "delete", path: operation.path });
        continue;
      }

      await this.fileSystemPort.writeTextFile(
        {
          path: operation.path,
          content: operation.beforeContent,
          createParents: true,
          atomic: true,
          trace: traceContext,
        },
        { signal: options.abortSignal },
      );
      restoredFiles.push({ action: "restore", path: operation.path });
    }
    // 文件已全部回写成功：从这一行起进入 commit 阶段，后面任何失败都不得补偿文件。
    commitStarted = true;
    await options.commitAfterApply?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (commitStarted) {
      // 文件已经回退且不可逆；commit 回调可能已经落下了会话截断。补偿文件会让
      // 会话与工作区永久不一致，所以这里只如实上报 commit 失败、保留文件回退结果，
      // 由调用方转成对客户端可见的 fault（T-RT1 的「失败可见」语义）。
      this.logger?.warn("Workspace file rewind commit failed after files were applied", {
        ...traceContextToLogContext(traceContext),
        errorMessage: message,
        event: "rewind.file_summary.commit_failed",
        module: "core.runtime",
        operationCount: plan.operations.length,
        status: "failed",
      });
      return {
        applied: false,
        commitError: message,
        failurePhase: "commit",
        preview: toPreview(plan),
        response: `Workspace files were rewound but the rewind commit failed: ${message}`,
      };
    }
    // 多文件 rewind 过去在第 N 次写失败时会留下半回滚 workspace。
    // journal 按写入逆序恢复命令执行前内容；补偿失败升级为不可恢复错误。
    try {
      await compensateFileRewindJournal.call(this, journal, traceContext);
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        "Workspace file rewind failed and compensation was incomplete",
      );
    }
    return {
      applied: false,
      failurePhase: "apply",
      preview: {
        ...toPreview(plan),
        canApply: false,
        unsafeFiles: [
          ...plan.unsafeFiles,
          {
            operationCount: Math.max(1, journal.length),
            path: journal.at(-1)?.path ?? "workspace",
            reason: "file_read_failed",
            toolNames: [],
            message,
          },
        ],
      },
      response: "File rewind was not applied because the write failed; prior files were restored.",
    };
  }

  const firstOperation = plan.operations[0];
  const lastOperation = plan.operations.at(-1);
  const targetMessageId = options.targetMessageId ?? options.targetMessageIds?.[0];
  const rewindId = `rewind_${crypto.randomUUID()}`;
  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId,
      scope: RewindScope.Workspace,
      strategy: RewindStrategy.ActiveChain,
      targetMessageId,
      targetCheckpointId: lastOperation?.checkpoint.checkpointId,
      restoredSnapshotRef: lastOperation?.checkpoint.snapshotRef,
      reason: "file_summary_rewind",
    },
    traceContext,
  );
  await this.appendEvent(event, traceContext);

  this.logger?.info("Workspace file summary rewind applied", {
    ...traceContextToLogContext(traceContext),
    event: "rewind.file_summary.completed",
    fileCount: plan.safeFiles.length,
    module: "core.runtime",
    operationCount: plan.operations.length,
    restoredFileCount: restoredFiles.length,
    status: "completed",
    targetCheckpointId: lastOperation?.checkpoint.checkpointId,
    targetMessageId,
  });

  return {
    applied: true,
    preview: toPreview(plan),
    response: `Rewound ${plan.safeFiles.length} file${plan.safeFiles.length === 1 ? "" : "s"} from summary checkpoints.`,
  };
}

async function compensateFileRewindJournal(
  this: AgentRuntimeInternal,
  journal: FileRewindJournalEntry[],
  traceContext: TraceContext,
): Promise<void> {
  for (const entry of [...journal].reverse()) {
    if (!entry.state.exists || entry.state.content === null) {
      await this.fileSystemPort!.removeFile({
        path: entry.path,
        missingOk: true,
        trace: traceContext,
      });
      continue;
    }
    await this.fileSystemPort!.writeTextFile({
      path: entry.path,
      content: entry.state.content,
      createParents: true,
      atomic: true,
      trace: traceContext,
    });
  }
}

async function buildWorkspaceFileRewindPlan(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  },
): Promise<WorkspaceFileRewindPlan> {
  const traceContext = options.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;
  if (!this.artifactStore || !this.fileSystemPort) {
    return {
      canApply: false,
      ignoredFiles: [],
      operations: [],
      safeFiles: [],
      unsafeFiles: [
        {
          operationCount: 1,
          path: "workspace",
          reason: !this.artifactStore ? "checkpoint_unreadable" : "file_read_failed",
          toolNames: [],
          message: !this.artifactStore
            ? "ArtifactStore is not configured."
            : "FileSystemPort is not configured.",
        },
      ],
    };
  }

  const events = await this.eventStore.getEvents(this.sessionId);
  const checkpoints = resolveTargetCheckpoints(events, {
    targetCheckpointId: options.targetCheckpointId,
    targetMessageId: options.targetMessageId,
    targetMessageIds: options.targetMessageIds,
  });
  if (checkpoints.length === 0) {
    return {
      canApply: false,
      ignoredFiles: [],
      operations: [],
      safeFiles: [],
      unsafeFiles: [],
    };
  }

  const artifacts: Array<{
    artifact: WorkspaceCheckpointArtifact;
    checkpoint: CheckpointCreatedPayload;
  }> = [];
  const unreadableFiles: WorkspaceFileRewindUnsafeFile[] = [];

  for (const checkpoint of checkpoints) {
    throwIfTurnAborted(options.abortSignal);
    try {
      const read = await this.artifactStore.readToolResultArtifact(
        {
          uri: checkpoint.snapshotRef,
          trace: traceContext,
        },
        { signal: options.abortSignal },
      );
      artifacts.push({
        artifact: parseWorkspaceCheckpointArtifact(JSON.parse(read.content)),
        checkpoint,
      });
    } catch (error) {
      unreadableFiles.push({
        operationCount: Math.max(1, checkpoint.fileCount ?? 1),
        path: `checkpoint:${checkpoint.checkpointId}`,
        reason: "checkpoint_unreadable",
        toolNames: [],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ignoredByPath = new Map<string, IgnoredFileAggregate>();
  const operations: FileCheckpointOperation[] = [];
  const unsupportedByPath = new Map<string, FileAggregate>();

  for (const { artifact, checkpoint } of artifacts) {
    if (isIgnoredShellTool(artifact.toolName)) {
      for (const file of artifact.files) {
        addIgnoredFile(
          ignoredByPath,
          resolveCheckpointFilePath(this.workspaceRoot, file.path),
          artifact.toolName,
        );
      }
      continue;
    }

    for (const file of artifact.files) {
      // Write/ApplyPatch checkpoint 会保留模型传入的工作区相对路径，而
      // FileSystemPort 只接受绝对路径。若不在计划阶段按 runtime workspace root
      // 解析，安全文件会被误报 file_read_failed，组合 rewind 只返回 blocked。
      const filePath = resolveCheckpointFilePath(this.workspaceRoot, file.path);
      const afterContent = resolveCheckpointAfterContent(file);
      if (afterContent === undefined) {
        markUnsafe(unsupportedByPath, {
          action: file.existedBefore && file.beforeContent !== null ? "restore" : "delete",
          path: filePath,
          reason: "unsupported_checkpoint",
          toolName: artifact.toolName,
        });
        continue;
      }

      operations.push({
        action: file.existedBefore && file.beforeContent !== null ? "restore" : "delete",
        afterContent,
        artifact,
        beforeContent: file.beforeContent,
        checkpoint,
        path: filePath,
        toolName: artifact.toolName,
      });
    }
  }

  const simulatedByPath = new Map<string, PlannedFileState>();
  const safeByPath = new Map<string, FileAggregate>();
  const unsafeByPath = new Map<string, FileAggregate>(unsupportedByPath);
  const applyOperations: FileCheckpointOperation[] = [];

  for (const operation of [...operations].reverse()) {
    throwIfTurnAborted(options.abortSignal);
    const aggregate = ensureFileAggregate(safeByPath, operation);
    aggregate.operationCount += 1;
    aggregate.toolNames.add(operation.toolName);
    aggregate.action = operation.action;

    if (unsafeByPath.has(operation.path)) {
      continue;
    }

    const currentState =
      simulatedByPath.get(operation.path) ??
      (await readCurrentFileState.call(this, operation.path, traceContext, options.abortSignal));
    if ("reason" in currentState) {
      markUnsafe(unsafeByPath, {
        action: operation.action,
        message: currentState.message,
        path: operation.path,
        reason: currentState.reason,
        toolName: operation.toolName,
      });
      continue;
    }

    const expectedHash = hashContent(operation.afterContent);
    if (currentState.hash !== expectedHash) {
      markUnsafe(unsafeByPath, {
        action: operation.action,
        currentHash: currentState.hash ?? "missing",
        expectedHash,
        path: operation.path,
        reason: "external_modified",
        toolName: operation.toolName,
      });
      continue;
    }

    simulatedByPath.set(operation.path, {
      content: operation.beforeContent,
      exists: operation.beforeContent !== null,
      hash: hashContent(operation.beforeContent),
    });
    applyOperations.push(operation);
  }

  for (const [path, unsafe] of unsafeByPath) {
    safeByPath.delete(path);
    unsafe.operationCount = Math.max(
      unsafe.operationCount,
      operations.filter((operation) => operation.path === path).length,
    );
  }

  const safeFiles = Array.from(safeByPath.values()).map(toSafeFile).sort(compareByPath);
  const unsafeFiles = [
    ...unreadableFiles,
    ...Array.from(unsafeByPath.values()).map(toUnsafeFile),
  ].sort(compareByPath);
  const ignoredFiles = Array.from(ignoredByPath.values()).map(toIgnoredFile).sort(compareByPath);

  return {
    canApply: safeFiles.length > 0 && unsafeFiles.length === 0,
    ignoredFiles,
    operations: unsafeFiles.length === 0 ? applyOperations : [],
    safeFiles,
    unsafeFiles,
  };
}

function resolveCheckpointFilePath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

function resolveTargetCheckpoints(
  events: Parameters<typeof selectCheckpointForRewind>[0],
  target: {
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
  },
): CheckpointCreatedPayload[] {
  const targetMessageIds =
    target.targetMessageIds && target.targetMessageIds.length > 0
      ? target.targetMessageIds
      : target.targetMessageId
        ? [target.targetMessageId]
        : [];
  if (targetMessageIds.length > 0) {
    const checkpoints = selectCheckpointsForMessages(events, targetMessageIds);
    if (checkpoints.length > 0 || !target.targetTurnId) {
      return checkpoints;
    }
  }

  if (target.targetTurnId && !String(target.targetTurnId).includes("~")) {
    // 旧 TurnStarted 没有 user messageId，无法通过 rowId->messageId
    // 找到 workspace checkpoint；普通 turn 可用事件 turnId 精确兜底。split
    // product turn 带 "~q" 后缀，不能按 runtime turnId 兜底，避免串到其他 queued turn。
    return events
      .filter((event) => event.type === SessionEventType.CheckpointCreated)
      .filter((event) => String(event.turnId ?? "") === String(target.targetTurnId))
      .map((event) => event.payload)
      .filter((payload): payload is CheckpointCreatedPayload => {
        const checkpoint = payload as Partial<CheckpointCreatedPayload>;
        return checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both;
      });
  }

  const checkpoint = selectCheckpointForRewind(events, target.targetCheckpointId);
  return checkpoint ? [checkpoint] : [];
}

function resolveCheckpointAfterContent(
  file: WorkspaceCheckpointArtifact["files"][number],
): string | null | undefined {
  const afterContent = (file as { afterContent?: unknown }).afterContent;
  if (typeof afterContent === "string") {
    return afterContent;
  }

  if (!file.existedBefore && file.beforeContent === null && file.structuredPatch.length === 0) {
    return undefined;
  }

  const beforeContent = file.beforeContent ?? "";
  const patch: StructuredPatch = {
    oldFileName: file.path,
    newFileName: file.path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: file.structuredPatch,
  };
  const patched = applyPatch(beforeContent, patch, {
    autoConvertLineEndings: false,
    fuzzFactor: 0,
  });
  return typeof patched === "string" ? patched : undefined;
}

async function readCurrentFileState(
  this: AgentRuntimeInternal,
  path: string,
  traceContext: TraceContext,
  abortSignal: AbortSignal | undefined,
): Promise<PlannedFileState | { message?: string; reason: "file_read_failed" }> {
  try {
    const read = await this.fileSystemPort!.readTextFile(
      {
        path,
        trace: traceContext,
      },
      { signal: abortSignal },
    );
    return {
      content: read.content,
      exists: true,
      hash: hashContent(read.content),
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return {
        content: null,
        exists: false,
        hash: hashContent(null),
      };
    }
    return {
      reason: "file_read_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function hashContent(content: string | null): string {
  if (content === null) {
    return "missing";
  }
  return createHash("sha256").update(content).digest("hex");
}

function isIgnoredShellTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized.includes("terminal") ||
    normalized.endsWith("shell")
  );
}

function ensureFileAggregate(
  aggregates: Map<string, FileAggregate>,
  operation: FileCheckpointOperation,
): FileAggregate {
  const existing = aggregates.get(operation.path);
  if (existing) {
    return existing;
  }
  const aggregate: FileAggregate = {
    action: operation.action,
    operationCount: 0,
    path: operation.path,
    toolNames: new Set(),
  };
  aggregates.set(operation.path, aggregate);
  return aggregate;
}

function markUnsafe(
  aggregates: Map<string, FileAggregate>,
  input: {
    action: "restore" | "delete";
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    path: string;
    reason: WorkspaceFileRewindUnsafeReason;
    toolName: string;
  },
): void {
  const existing = aggregates.get(input.path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(input.toolName);
    existing.unsafe = {
      currentHash: input.currentHash ?? existing.unsafe?.currentHash,
      expectedHash: input.expectedHash ?? existing.unsafe?.expectedHash,
      message: input.message ?? existing.unsafe?.message,
      reason: existing.unsafe?.reason ?? input.reason,
    };
    return;
  }

  aggregates.set(input.path, {
    action: input.action,
    operationCount: 1,
    path: input.path,
    toolNames: new Set([input.toolName]),
    unsafe: {
      currentHash: input.currentHash,
      expectedHash: input.expectedHash,
      message: input.message,
      reason: input.reason,
    },
  });
}

function addIgnoredFile(
  aggregates: Map<string, IgnoredFileAggregate>,
  path: string,
  toolName: string,
): void {
  const existing = aggregates.get(path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(toolName);
    return;
  }
  aggregates.set(path, {
    operationCount: 1,
    path,
    toolNames: new Set([toolName]),
  });
}

function toSafeFile(file: FileAggregate): WorkspaceFileRewindSafeFile {
  return {
    action: file.action,
    operationCount: file.operationCount,
    path: file.path,
    toolNames: Array.from(file.toolNames).sort(),
  };
}

function toUnsafeFile(file: FileAggregate): WorkspaceFileRewindUnsafeFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: file.unsafe?.reason ?? "unsupported_checkpoint",
    toolNames: Array.from(file.toolNames).sort(),
    ...(file.unsafe?.message ? { message: file.unsafe.message } : {}),
    ...(file.unsafe?.expectedHash ? { expectedHash: file.unsafe.expectedHash } : {}),
    ...(file.unsafe?.currentHash ? { currentHash: file.unsafe.currentHash } : {}),
  };
}

function toIgnoredFile(file: IgnoredFileAggregate): WorkspaceFileRewindIgnoredFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: "bash_ignored",
    toolNames: Array.from(file.toolNames).sort(),
  };
}

function compareByPath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

function toPreview(plan: WorkspaceFileRewindPlan): WorkspaceFileRewindPreview {
  return {
    canApply: plan.canApply,
    ignoredFiles: plan.ignoredFiles,
    safeFiles: plan.safeFiles,
    unsafeFiles: plan.unsafeFiles,
  };
}
