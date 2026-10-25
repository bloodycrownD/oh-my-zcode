import type { RuntimeInputPresentation } from "./runtime-input-presentation.js";
// ============================================================
// Session Ports - Core interfaces for session management
// ============================================================

import type { ErrorAttribution, SessionEvent } from "../events/session.events.js";
import type {
  InteractionRequestOrigin,
  MessageId,
  QueryId,
  SessionId,
  TurnId,
  TraceId,
} from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { CheckpointProjectionInfo, RewindProjectionInfo } from "../rewind/index.js";
import type {
  StreamRecoveryAnchorProjectionInfo,
  StreamingToolLedgerProjectionInfo,
} from "../events/stream-recovery.events.js";
import type { SessionGoal } from "../tools/target.js";
import type { GoalCompletionVerificationOutput } from "../tools/target.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "./permission.port.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { ModelSelection } from "../model/model.js";

// -----------------------------------------------
// Collaboration Mode and Risk Level
// -----------------------------------------------

export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "auto";
export type SessionStatus = "idle" | "running" | "waiting" | "paused" | "completed" | "error";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type InputDelivery = "auto" | "start_turn" | "steer_active_turn";
export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

// -----------------------------------------------
// Session Event Store Port
// -----------------------------------------------

/** 内存 event store 的驻留规模；只用于本地内存诊断日志。 */
export interface SessionEventStoreStats {
  sessions: number;
  events: number;
  /** 按 turn 窗口策略已淘汰的瞬态事件累计数；unbounded 模式恒为 0。 */
  evictedEvents?: number;
  /** 当前仍驻留的瞬态事件数（进行中 turn + 一个滞后 turn）。 */
  retainedTransient?: number;
}

export interface SessionEventStorePort {
  append(event: SessionEvent): Promise<SessionEvent>;
  getEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]>;
  getLatestSequenceNumber(sessionId: SessionId): Promise<number>;
  deleteSession(sessionId: SessionId): Promise<void>;
  /** 同步、O(sessions) 的只读统计；持久化实现可不提供。 */
  getStats?(): SessionEventStoreStats;
  /**
   * 低频 tick 触发的瞬态事件时间兜底淘汰；
   * 返回淘汰条数。持久化实现可不提供。
   */
  pruneTransientEvents?(nowMs?: number): number;
}

// -----------------------------------------------
// Live Session Event Sink Port
// -----------------------------------------------

export interface SessionEventSink {
  onSessionEvent(event: SessionEvent): void | Promise<void>;
}

// -----------------------------------------------
// Session Projection Port
// -----------------------------------------------

export interface SessionProjection {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  planEnabled?: boolean;
  status: SessionStatus;
  turnCount: number;
  totalTokenCount: number;
  contextUsed: number;
  contextWindow: number;
  pendingPermissions: PendingPermission[];
  pendingSteerInputs: PendingSteerInputInfo[];
  activeToolCalls: ActiveToolCall[];
  streamingToolLedger: StreamingToolLedgerProjectionInfo[];
  backgroundTasks: BackgroundTaskInfo[];
  currentTurnId?: TurnId;
  lastError?: ErrorInfo;
  lastCheckpoint?: CheckpointProjectionInfo;
  lastStreamRecoveryAnchor?: StreamRecoveryAnchorProjectionInfo;
  lastRewind?: RewindProjectionInfo;
  target?: SessionGoal | null;
  targetCompletionVerifications: GoalCompletionVerificationOutput[];
  targetCompletionVerificationTimeline: TargetCompletionVerificationProjectionInfo[];
}

export interface TargetCompletionVerificationProjectionInfo {
  targetId: string;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verificationId: string;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
  startedAt?: Date;
  updatedAt: Date;
}

export interface PendingPermission {
  requestId?: string;
  toolCallId: string;
  toolName: string;
  reason?: string;
  riskLevel: RiskLevel;
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /** 请求事件携带的 ask 预览；冷恢复重建的会话弹窗仍需带图，所以必须进 projection 状态。 */
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
}

export interface PendingSteerInputInfo {
  pendingInputId: string;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** 当前排队输入附带的工具隐藏列表；automation busy 入队必须在消费时继续生效。 */
  toolDisallowlist?: readonly string[];
  queuedAt: Date;
  targetTurnId: TurnId;
  traceId: TraceId;
  intent?: TurnInputIntentMetadata;
}

export interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  startedAt?: Date;
}

export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "denied";

export type BackgroundTaskInfoStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskInfo {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: string;
  blocked?: boolean;
  blockedReason?: string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskInfoStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export interface BackgroundTaskCancelResult {
  cancelled: boolean;
  reason?: string;
  snapshot?: BackgroundTaskInfo;
  status: BackgroundTaskInfoStatus;
  taskId: string;
}

export interface ErrorInfo {
  attribution?: ErrorAttribution;
  code?: string;
  detail?: string;
  type: string;
  message: string;
}

// -----------------------------------------------
// Event Reducer Port
// -----------------------------------------------

export interface EventReducerPort {
  reduce(events: SessionEvent[]): SessionProjection;
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// -----------------------------------------------
// Session Manager Port
// -----------------------------------------------

export interface SessionManagerPort {
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: SessionId): Promise<Session>;
  forkSession(sessionId: SessionId, forkPoint?: number): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
}

export interface SessionConfig {
  mode?: CollaborationMode;
  contextWindow?: number;
  traceId?: TraceId;
}

export interface Session {
  id: SessionId;
  config: SessionConfig;
  eventStore: SessionEventStorePort;
  projection: SessionProjection;
  eventReducer: EventReducerPort;
}

export interface TurnSteerInput {
  input: string;
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  pendingInputId?: string;
  traceContext?: TraceContext;
  /** 当前输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
}

export type TurnSteerCommandKind = "sendText" | "sendGoalCommand";
export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * 输入投递语义：
 * - "queue"：排队的未来意图，消费时切新 product turn（每条一轮，自己的回复/工时/edit 范围）；
 * - "guide"：对进行中工作的补充引导，内联在当前轮，不切轮。
 * runtime 注入机制两者相同（boundary 注入），差异只在产品呈现与账本语义。
 */
export type TurnSteerDeliveryMode = "guide" | "queue";

/**
 * 队列暂停位（`queueAutoDrain`）的**唯一派生规则**（spec edit-resend-stale-text；cr-func P2）。
 *
 * ============================================================================
 * 规则
 * ============================================================================
 *
 * 「暂停」只有一个含义：**队列里还有项，且用户/系统要求它们不要自动放行**。
 * 所以暂停位不是一个可以随处独立写的 flag，而是两个事实的函数：
 *
 *   ① 队列是否为空（由事件投影裁决，不是「本次删了几条」推算）；
 *   ② 是否有显式请求（用户点暂停/继续、stop 拦下后续项、auto-drain 失败停住、
 *      手动「立即发送」=恢复）。
 *
 * 于是：`暂停 = (队列非空) && (显式请求 ?? 当前位)`。0 项时任何暂停都承载不了，
 * 归一化为「放行」——这正是过去反复出现的「paused + 0 项」durable 残留：
 * 它在下一次入队时把「用户没按暂停」的项判成 held，用户只能手动点继续。
 *
 * 读不到队列长度（宿主能力缺席/投影未就绪）→ 保持当前位：无法证明「空」时不得放行，
 * 否则会在还有项时把存活项一起交给 auto-drain 抢跑。
 *
 * ============================================================================
 * 为什么必须收敛成这一个函数（放在 contracts 而不是某一层内部）
 * ============================================================================
 *
 * 这条规则以前被四处各自补：rewind 级联（core）、`deleteQueueItem`、
 * `sendQueuedNow`、`setAutoDrain`（bootstrap）。每新增一条「把队列抽干」的路径就漏一处
 * （delete 那处就是漏出来的），而每处的判据写法又略有差别（有的看本次删了几条、
 * 有的看投影、有的无条件复位）。规则跨这两层使用，所以放在两边都依赖的 contracts，
 * 而不是任一侧内部——否则必然出现第二份镜像。
 */
export function deriveQueueAutoDrain(input: {
  /**
   * 当前暂停位（core 的 runtime 门 / v4 投影的 `queue.autoDrain`，两者由
   * `QueueAutoDrainChanged` 事件保持同一事实）。
   */
  current: boolean;
  /**
   * 队列长度；`undefined` = 读不到（能力缺席/投影未就绪），按「无法证明为空」处理。
   * `0` = 明确为空（唯一会强制放行的取值）。
   */
  queueLength: number | undefined;
  /** 显式请求；缺省 = 只做「空队列归一化」，不改变现值。 */
  requested?: boolean;
}): boolean {
  // 空队列：暂停没有承载对象。这一步优先于显式请求——「paused + 0 项」本身就是要消灭的
  // 残留位，用户此刻点暂停也无法让它有意义（下一轮结束后的新项仍会被判 held）。
  if (input.queueLength === 0) return true;
  if (input.requested !== undefined) return input.requested;
  return input.current;
}

/** 协议无关的输入 intent metadata；bootstrap v4 在事件边界组装为 ConversationInputIntent。 */
export interface TurnInputIntentMetadata {
  planEnabled?: boolean;
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind: TurnSteerCommandKind;
  /** transcript hydration 贯穿完整 ConversationInputIntent 的 canonical command text。 */
  text?: string;
  /** Admission 时固定；Queue/Guide 后续不得重新读取 Composer 或 Session 最新选择。 */
  modelSelection?: ModelSelection;
  /**
   * modelSelection 是否由用户在当前命令中显式携带（而非继承被编辑轮/queue item 的
   * 旧快照）。true 时 runtime 写回并持久化会话选择；缺省/false 表示继承快照，
   * 不得静默覆盖会话选择——否则编辑重发会把用户刚切换的模型还原并落库。
   */
  modelSelectionPinned?: boolean;
  /** 与本次用户 Submission 一起固定的协作模式。 */
  mode?: "build" | "edit" | "plan" | "yolo";
  admissionSeq: number;
  admittedAt: number;
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  queuePosition?: number;
  fallbackReasonCode?: string;
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
  }>;
  sharedContextRefs?: Array<{
    kind: "shared_context_import";
    context_id: string;
  }>;
  /** edit/retry 重建的新 command 对原始 canonical input cause 的稳定追溯。 */
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
}

/** queue 内保留尚未 resolve 的附件描述；消费时与普通 turn 使用同一 resolver。 */
export interface PendingTurnAttachment {
  type: "file" | "image" | "video" | "pdf" | "url";
  path?: string;
  content?: string;
  sourceKind?: "clipboard-text";
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface PendingTurnInput {
  id: string;
  input: string;
  queuedAt: Date;
  traceId: TraceId;
  queryId?: QueryId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  /** 当前 pending input drain 后不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  turnId: TurnId;
  /**
   * queue 车道项被显式切到 guide 时物化进内存的标记（v4 setQueueItemDelivery）。
   * steer 车道原生项不携带。切回 queue 时物化项整体从内存移除（权威回到
   * queue 车道投影/事件），而非留在 pendingInputs 里被空闲判定误读。
   */
  materialized?: boolean;
}

export type TurnSteerResult =
  | {
      kind: "queued";
      pendingInputId: string;
      queueLength: number;
      turnId: TurnId;
      /**
       * 这条输入**实际**落在哪条投递车道（spec edit-resend-stale-text / I5）。
       *
       * - `guide`：内联进当前轮，模型已经看到这条输入；
       * - `queue`：留在队列等下一轮。
       *
       * 必须由 Core 在 admission 现场给出，不能让调用方按 `queueDelivery` 参数或
       * 附件情况复算：`prompt-admission.ts` 会在附件存在或 turn 不可 steer 时把
       * `guide` 回退成 `queue`，那套回退规则只有这一处。
       */
      delivery: TurnSteerDeliveryMode;
    }
  | {
      activeTurnId?: TurnId;
      kind: "rejected";
      reason: TurnSteerRejectReason;
    };

export interface SessionSummary {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;
  turnCount: number;
}
