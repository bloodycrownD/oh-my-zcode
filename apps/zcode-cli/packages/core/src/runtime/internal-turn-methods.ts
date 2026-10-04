import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { RuntimeInputPresentation } from "@zcode/contracts";
import type {
  BackgroundExecutionSnapshot,
  BackgroundTaskCancelResult,
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
  MessageId,
  MessageWithParts,
  MessagePart,
  MessageVisibility,
  Model,
  ModelSelection,
  ModelNetworkStatusEvent,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  PartId,
  PermissionBrokerRequest,
  SessionEvent,
  SessionEventType,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SyntheticUserMessageSource,
  TimelinePartDraft,
  ToolCallId,
  TraceContext,
  TurnId,
  TurnExecutionKind,
  TurnInputIntentMetadata,
  CheckpointCreatedPayload,
  RewindScope,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
  ToolCall,
  TurnState,
  ToolSchedule,
  ToolExecutionResult,
} from "./deps.js";
import type {
  ActiveTurnStartReservation,
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ParsedRewindCommand,
  PermissionDecisionResult,
  ResolvedTurnAttachment,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "./types.js";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";

export interface AgentRuntimeTurnMethods {
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  executeTurnCommand(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
    startReservation?: ActiveTurnStartReservation,
  ): Promise<TurnResult>;
  executeRewindCommand(
    input: string,
    command: ParsedRewindCommand,
    turnId: TurnId,
    turnTraceContext: TraceContext,
    abortSignal?: AbortSignal,
    inputId?: string,
  ): Promise<TurnResult>;
  formatRewindStatus(): Promise<string>;
  rewindWorkspaceToCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetCheckpointId?: string;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  rewindToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;
  rewindCascadeToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  rewindWorkspaceToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  finishUnavailableRewind(options: {
    checkpoint?: CheckpointCreatedPayload;
    evaluation?: RewindTargetEvaluation;
    events: SessionEvent[];
    reason: string;
    rewindId: string;
    scope?: RewindScope;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  restoreWorkspaceCheckpointArtifact(
    artifact: WorkspaceCheckpointArtifact,
    traceContext: TraceContext,
    abortSignal?: AbortSignal,
  ): Promise<WorkspaceRewindRestoredFile[]>;
  copySessionMessagesForFork(options: {
    forkedSessionId: SessionId;
    messages: MessageWithParts[];
    traceContext: TraceContext;
  }): Promise<{
    copiedMessageCount: number;
    messageIdMap: Map<MessageId, MessageId>;
  }>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  emitToolScheduledEvents(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    assistantMessageId: MessageId,
    traceContext: TraceContext,
  ): Promise<SessionEvent[]>;
  emitFileMutationCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messageId: MessageId;
    result: ToolExecutionResult;
    toolMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<void>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;
  getPendingPermissionRequests(): PermissionBrokerRequest[];
  getProjection(): Promise<SessionProjection>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;
  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;
  hasRunningBackgroundTasks(): boolean;
  getSessionId(): SessionId;
  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;
  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;
  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;
  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;
  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;
  loadCheckpointMessagePreviews(): Promise<Map<MessageId, string>>;
  createModelStatusSink(
    traceContext: TraceContext,
    events: SessionEvent[],
    options?: {
      onStatus?: (event: ModelNetworkStatusEvent) => void;
      streamRecovery?: ModelStreamRecoveryStatus;
    },
  ): ModelStatusSink;
  logModelNetworkStatus(statusEvent: ModelNetworkStatusEvent, traceContext: TraceContext): void;
  buildBackgroundTaskPayload(
    taskId: string,
    existing: BackgroundTaskInfo | undefined,
    snapshot: BackgroundExecutionSnapshot | undefined,
    overrides?: {
      cancelRequestedAt?: Date;
      cancellable?: boolean;
      completedAt?: Date;
      status?: BackgroundTaskInfoStatus;
    },
  ): BackgroundTaskInfo;
  createEvent(type: SessionEventType, payload: unknown, traceContext: TraceContext): SessionEvent;
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  notifyEventSinks(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  ensureSessionPersisted(input: string, traceContext: TraceContext): Promise<void>;
  persistUserPrompt(
    messageID: MessageId,
    input: string,
    attachments: ResolvedTurnAttachment[] | undefined,
    traceContext: TraceContext,
    options?: {
      steerDelivery?: "guide" | "queue";
      inputPresentation?: RuntimeInputPresentation;
      sessionInputId?: string;
      sourceCommandId?: string;
      clientId?: string;
      intent?: TurnInputIntentMetadata;
      executionKind?: TurnExecutionKind;
      epilogueStart?: number;
    },
  ): Promise<void>;
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  persistPendingModelChangeTimeline(traceContext: TraceContext): Promise<void>;
  persistSyntheticUserNotice(
    messageID: MessageId,
    text: string,
    traceContext: TraceContext,
  ): Promise<void>;
  persistSyntheticUserNoticeForSession(options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    text: string;
    traceContext: TraceContext;
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  }): Promise<void>;
  persistAssistantTimelinePartForSession(options: {
    sessionId: SessionId;
    messageID?: MessageId;
    partID?: PartId;
    parentID?: MessageId;
    created?: number;
    completed?: number;
    finish?: string;
    timeline: TimelinePartDraft;
    traceContext: TraceContext;
  }): Promise<{ messageID: MessageId; partID: PartId }>;
  persistAssistantMessage(
    messageID: MessageId,
    parentID: MessageId,
    created: number,
    update:
      | {
          completed?: number;
          error?: { name: string; data?: Record<string, unknown> };
          finish?: string;
          tokens?: unknown;
        }
      | undefined,
    traceContext: TraceContext,
    model?: Model,
  ): Promise<void>;
  persistMessage(
    input: Parameters<SessionStorePort["saveMessage"]>[0],
    traceContext: TraceContext,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void>;
  persistPart(
    input: MessagePart,
    traceContext: TraceContext,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void>;
  rebuildProjection(): Promise<SessionProjection>;
}
