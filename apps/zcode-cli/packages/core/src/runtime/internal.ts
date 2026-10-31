import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  Logger,
  ModelSelection,
  EventReducer,
  MessageId,
  TurnId,
  ModelToolContract,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  ContextSourcePort,
  ContextSourceSnapshot,
  ExecutionPort,
  FileSystemPort,
  HookRunner,
  ImageProcessorPort,
  PdfDocumentPort,
  McpConnectionSnapshot,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  TraceContext,
  MessageHistory,
  ReadFileStateMap,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
} from "./deps.js";
import type {
  ActiveTurnSteeringState,
  ActiveTurnStartReservation,
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  BackgroundTaskNotificationSealReason,
  DeferredHistoryHydration,
  PendingModelChangeTimeline,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { WorkflowBlockedReminderClock } from "../runtime-task/workflow-blocked-reminder.js";
import type { DynamicWorkflowActivationSource } from "./methods/dynamic-workflow-activation.js";
import type { AgentRuntimeCoreMethods } from "./internal-methods.js";
import type { AgentRuntimeTurnMethods } from "./internal-turn-methods.js";
import type { AgentRuntimeHookMethods } from "./internal-hook-methods.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { MagicContextTurnTransform } from "./helpers/magic-context-turn-transform.js";
import type { MagicContextPromptSectionResolver } from "./helpers/magic-context-prompt-section.js";
import type { ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

export interface AgentRuntimeInternal
  extends AgentRuntimeCoreMethods, AgentRuntimeTurnMethods, AgentRuntimeHookMethods {
  sessionId: SessionId;
  turnNumber: number;
  config: AgentRuntimeConfig;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  toolScheduler: ToolScheduler;
  eventReducer: EventReducer;
  eventStore: SessionEventStorePort;
  rootTraceContext: TraceContext;
  appVersion: string;
  logger?: Logger;
  eventSinks: Set<SessionEventSink>;
  now: () => Date;
  isRemoteWorkspace: () => boolean;
  registry: ToolRegistry;
  executor: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  modelFactory: AgentRuntimeDeps["modelFactory"];
  modelIoDir?: string;
  browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  sessionModelSelection: ModelSelection | undefined;
  /** Step 5（bugfix-batch-20261011）：最近一次选择变值的墙钟（ms）；0 = 从未变值。 */
  lastModelSwitchAt: number;
  messageHistory: MessageHistory;
  readFileState: ReadFileStateMap;
  cachedTools: ModelToolContract[] | null;
  /** 工作流工具面是否已注册（launch.md「On demand: activation」）；非 onDemand 会话出生即 true。 */
  dynamicWorkflowToolsActivated: boolean;
  dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  contextBuilder: ContextBuilder | null;
  contextInitialized: boolean;
  /**
   * 懒历史（`historyMode:"none"`）待补的全量水化。有值 = provider 历史还没水化，
   * 任何把它交给模型的入口必须先过闸门（IS7）。见 `methods/history-hydration.ts`。
   */
  deferredHistoryHydration?: DeferredHistoryHydration;
  contextSourceSnapshot?: ContextSourceSnapshot;
  latestContextBuildResult?: ContextBuildResult;
  memoryRoot?: string;
  memoryIndexContent?: string;
  memoryRecallState: MemoryRecallState;
  memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  /** Step 19b：缺席即 `features.magicContext` 关闭；turn-loop 只判空。 */
  magicContextTurnTransform?: MagicContextTurnTransform;
  /** Step 13（D1）：缺席即 `features.magicContext` 关闭或装配失败；context builder 只判空。 */
  magicContextPromptSection?: MagicContextPromptSectionResolver;
  /** Step 14：prompt-surface 分档描述求值器；缺席即不换档。 */
  magicContextToolDescription?: (input: {
    toolId: string;
    fullDescription: string;
    modelKey?: string;
  }) => string;
  // v3.16.2 project memory dream 的状态位（helpers/project-memory-dream.ts 读改写）。
  memoryDreamLastScanAtMs: number;
  pendingMemoryUpdate?: ProjectMemoryUpdate;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  residencyBlockingWorkCount: number;
  mcpInitialized: boolean;
  mcpToolsRegistered: boolean;
  /** 当前注册在 registry 的 MCP 工具名集合；refreshMcpServers 据此 diff 反注册。 */
  mcpRegisteredToolNames: Set<string>;
  /** 初始化 / 上次刷新时注册的 MCP 工具名与集合签名（上游 A7 list_changed 判据）。 */
  registeredMcpToolNames?: string[];
  mcpToolsSignature?: string;
  mcpToolListRevision?: number;
  subagentPort?: SubagentPort;
  getAgentDefinitions: NonNullable<AgentRuntimeDeps["getAgentDefinitions"]>;
  prepareAgentDefinitions: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;

  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  /**
   * 「run 还欠着决定、主代理闲着」的提醒钟（methods/dynamic-workflow-blocked-reminder.ts）。真实 runtime 上
   * 恒在场；可选只为让手写的局部 runtime 桩不必带它。
   */
  workflowBlockedReminder?: WorkflowBlockedReminderClock;
  branchGeneration: number;
  artifactStore?: ToolArtifactStorePort;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillLoadOutcome?: SkillLoadOutcome;
  workingDirectory: string;
  workspaceRoot: string;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  sessionPersisted: boolean;
  needsPlanModeExitReminder: boolean;
  latestConversationMessageId?: MessageId;
  latestAssistantMessageId?: MessageId;
  latestAssistantTurnId?: TurnId;
  mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  currentTurnFileChanges: RuntimeTurnFileChangeMap;
  lastAssistantCompletedAtMs?: number;
  lastEmittedLocalDate?: string;
  runtimeCommandQueue: RuntimeCommandQueue;
  runtimeCommandDrainActive: boolean;
  activeForegroundExecution?: ActiveForegroundExecutionState;
  foregroundPromotionLease?: ForegroundPromotionLeaseState;
  activeTurn?: ActiveTurnSteeringState;
  activeTurnStartReservation?: ActiveTurnStartReservation;
  pendingInputSequence: number;
  pendingInputReservations: Map<string, string>;
  permissionFullAccessPending?: boolean;
  pendingInputDrains?: number;
  lastPermissionGrantId?: string;
  queueAutoDrain: boolean;
  queueExternalDrainActive: boolean;
  shuttingDown: boolean;
  backgroundTaskNotificationsSealed: boolean;
  backgroundTaskNotificationSealReason?: BackgroundTaskNotificationSealReason;
  pendingModelChangeTimeline?: PendingModelChangeTimeline;
  sessionStartHookRan: boolean;
  sessionTitleGenerationAttempted: boolean;
}
