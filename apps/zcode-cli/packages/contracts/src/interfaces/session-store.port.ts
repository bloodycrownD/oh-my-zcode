// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================

import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type {
  MessageId,
  PartId,
  ProjectId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./shared.js";
import type {
  ModelId,
  ModelProviderId,
  ModelSelection,
  ModelToolSideEffectScope,
} from "../model/index.js";
import type { TodoItem } from "../tools/todo.js";
import type { SessionGoal, GoalStatus } from "../tools/target.js";
import type { PermissionRuleset } from "./permission.port.js";
import type { CollaborationMode } from "./session.port.js";
import type { EnvInfo } from "./context-source.port.js";

export const SESSION_TASK_TYPES = [
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;
export type SessionTaskType = (typeof SESSION_TASK_TYPES)[number];

export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

export const MESSAGE_VISIBILITIES = ["user-visible", "model-only"] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

export const SYNTHETIC_USER_MESSAGE_SOURCES = [
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  "plugin_reference",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动已保存工作流时落的那条 user 消息的来源。
  // 它虽是 synthetic（GUI 用元数据画启动卡而非显示文本），语义上却是用户真实动作：
  // origin=real_user、kind=user_prompt，与其余「运行时注入的提醒」类来源不同档。
  "workflow_launch",
  "shared_context",
] as const;
export type SyntheticUserMessageSource = (typeof SYNTHETIC_USER_MESSAGE_SOURCES)[number];

export type MessageSemanticsOrigin =
  | "real_user"
  | "agent_runtime"
  | "system"
  | "migration"
  | "import";

export type MessageSemanticsKind =
  | "user_prompt"
  | "slash_command"
  | "system_reminder"
  | "background_notification"
  | "subagent_notification"
  | "todo_reminder"
  | "rewind_notice"
  | "fork_notice"
  | "timeline_event"
  | "shared_context"
  | "assistant_response";

export interface MessageSemantics {
  origin: MessageSemanticsOrigin;
  kind: MessageSemanticsKind;
  source?: string;
  commandName?: string;
  uiVisibility: "visible" | "hidden" | "debug";
  providerVisibility: "visible" | "hidden";
  transcriptVisibility: "visible" | "hidden";
}

// v4 投影锚点词表（userInput.origin）。
// 与 MessageSemanticsOrigin 并存不互替：semantics.origin 是旧读侧语义，
// anchor.origin 是新协议 row 派生依据；老值由读侧只读映射。
export const MESSAGE_ANCHOR_ORIGINS = [
  "realUser",
  "backgroundResult",
  "goalContinuation",
  "mailbox",
  "synthetic",
] as const;
export type MessageAnchorOrigin = (typeof MESSAGE_ANCHOR_ORIGINS)[number];

/**
 * stable fork 的 fork 点 goal 事实。undefined 只表示旧数据；新数据必须显式写 none
 * 或完整快照，避免 fork 时读取 parent 当前 goal 冒充历史状态。
 */
export type StableForkGoalBoundaryMetadata =
  | { kind: "none" }
  | {
      kind: "snapshot";
      target: SessionGoal;
      verificationEntryIds: string[];
    };

/**
 * v4 transcript 锚点（清单）：全部 optional，
 * 走 message JSON blob 的 additive 演进，历史数据留空、读侧宽容降级。
 * sourceCommandId 是命令幂等的 transcript 兜底查重键，
 * 由 v4 command inbox 铺路后写入（接线）。
 */
export interface MessageProjectionAnchor {
  turnId?: TurnId;
  origin?: MessageAnchorOrigin;
  sourceCommandId?: string;
  /** 最终 assistant 固化当前 query 的历史轮次，供 cold hydration 精确恢复。 */
  historyRoundCount?: number;
  /** 新数据的 stable fork 固定边界；历史消息缺省，由唯一 resolver 无歧义时惰性补写。 */
  productTurnId?: string;
  orderedMessageIds?: MessageId[];
  boundaryMessageId?: MessageId;
  goalBoundary?: StableForkGoalBoundaryMetadata;
}

export interface SessionInfo {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  shareURL?: string;
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  summaryDiffs?: FileDiff[];
  revert?: SessionRevert;
  permission?: PermissionRuleset;
  time: {
    created: number;
    updated: number;
    titleUpdated?: number;
    compacting?: number;
    archived?: number;
  };
}

export interface CreateSessionInput {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType?: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  shareURL?: string;
  permission?: PermissionRuleset;
  time?: {
    created?: number;
    updated?: number;
  };
}

/** V4 stable fork resolver 固定的目标 product turn segment。 */
export interface StableForkTargetMetadata {
  productTurnId: string;
  transcriptTurnId: string;
  orderedMessageIds: string[];
  boundaryMessageId: string;
}

/** 与 child session 同事务落盘的命令幂等事实。 */
export interface ForkChildSessionMetadata {
  parentSessionId: string;
  sourceCommandId: string;
  forkTarget: StableForkTargetMetadata;
}

export type ForkCommandResult =
  | { type: "forkAssistant"; sessionId: string }
  | { type: "createSelectionSideSession"; sessionId: string }
  | { type: "editUserQuery"; disposition: "fork"; sessionId: string };

/**
 * conversation fork 的唯一原子提交载荷。core 在内存完成 remap；adapter 不参与业务裁决，
 * 只保证 child/copy/goal/entries/input/parent command fact 全有或全无。
 */
export interface ForkCommitBundle {
  child: CreateSessionInput;
  messages: MessageWithParts[];
  entries: SessionEntryInfo[];
  /** 存储复制来源（目标 ID -> 父记录 ID）；只保留旧磁盘快照，不参与模型选择。 */
  copySources?: { messages: Record<string, string>; parts: Record<string, string> };
  goal?: { source: SessionGoal; status: GoalStatus };
  initialInput?: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  };
  commandFact: {
    parentSessionId: string;
    sourceCommandId: string;
    ack: {
      commandId: string;
      status: "accepted";
      revisionAtDecision: number;
      result: ForkCommandResult;
    };
    metadata: Record<string, unknown>;
  };
}

export interface UpdateSessionInput {
  id: SessionId;
  directory?: string;
  path?: string | null;
  timeUpdated?: number;
  title?: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId | null;
  expectedTitleSources?: readonly SessionTitleSource[];
  shareURL?: string | null;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
    diffs?: FileDiff[];
  } | null;
  revert?: SessionRevert | null;
  permission?: PermissionRuleset | null;
  timeCompacting?: number | null;
  timeArchived?: number | null;
}

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  oldPath?: string;
  newPath?: string;
}

export interface SessionRevert {
  messageID: MessageId;
  partID?: PartId;
  snapshot?: string;
  diff?: string;
  kind?: "conversation_rewind";
  scope?: "conversation" | "workspace" | "both";
  targetMessageID?: MessageId;
  createdMessageID?: MessageId;
  keptMessageIDs?: MessageId[];
  /**
   * append-only conversation branch 的 cut 游标：本次 rewind 提交前最后一条持久消息。
   * active branch = keptMessageIDs + 该消息之后新追加的消息。旧 createdMessageID 仅用于兼容。
   */
  branchCutAfterMessageID?: MessageId;
  /** 每次 destructive conversation rewind 单调递增，用于隔离旧分支异步结果。 */
  branchGeneration?: number;
}

export interface ListSessionsInput {
  projectID?: ProjectId;
  /** undefined = 不按 identity 过滤；null = 仅本地/legacy 空 identity；字符串 = 精确 workspace identity。 */
  workspaceID?: WorkspaceId | null;
  directory?: string;
  path?: string;
  roots?: boolean;
  taskTypes?: SessionTaskType[];
  includeArchived?: boolean;
  limit?: number;
}

export interface ClaimLegacySessionWorkspaceInput {
  sessionIDs: SessionId[];
  directory: string;
  workspaceID: WorkspaceId;
}

export interface RepairLegacyRemoteSessionWorkspaceInput {
  sessionID: SessionId;
  projectID: ProjectId;
  legacyWorkspaceDirectory: string;
  workspaceID: WorkspaceId;
  workspacePath: string;
}

export interface RepairRemoteSessionPathsInput {
  sessionID: SessionId;
  workspaceID: WorkspaceId;
  expectedDirectory: string;
  expectedPath: string | null;
  directory: string;
  path: string | null;
  timeUpdated: number;
}

export type OutputFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };

export interface MessageSummary {
  title?: string;
  body?: string;
  diffs: FileDiff[];
}

export interface MessageContextSnapshot {
  envInfo?: EnvInfo;
}

export interface UserMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: MessageSummary;
  agent: string;
  /** 未绑定会话的合成消息、缺少模型信息的旧消息不伪造请求来源。 */
  modelSelection?: ModelSelection;
  system?: string;
  tools?: Record<string, boolean>;
  contextSnapshot?: MessageContextSnapshot;
  synthetic?: boolean;
  source?: SyntheticUserMessageSource;
  visibility?: MessageVisibility;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  metadata?: Record<string, unknown>;
}

export interface AssistantErrorInfo {
  name: string;
  data?: Record<string, unknown>;
}

export interface TokenUsageInfo {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface AssistantMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: AssistantErrorInfo;
  parentID: MessageId;
  /** 真正模型输出应携带来源；历史恢复的合成时间线允许没有执行模型。 */
  modelId?: ModelId;
  providerId?: ModelProviderId;
  mode: string;
  /** 当前输出对应的 Plan 状态；旧记录缺失时按旧 mode 解释，不回填历史。 */
  planEnabled?: boolean;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: TokenUsageInfo;
  structured?: unknown;
  reasoningLevel?: string;
  finish?: string;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  /** 附加领域语义（fork copy 的 forkOrigin provenance 等）。 */
  metadata?: Record<string, unknown>;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

export interface TextPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ReasoningPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end?: number;
  };
}

export type FilePartSource =
  | {
      type: "file";
      path: string;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "symbol";
      path: string;
      range: unknown;
      name: string;
      kind: number;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "resource";
      clientName: string;
      uri: string;
      text: { value: string; start: number; end: number };
    };

export interface AttachmentStorageMetadata {
  sizeBytes?: number;
  sha256?: string;
  image?: {
    maxDimension?: number;
    originalWidth?: number;
    originalHeight?: number;
    width?: number;
    height?: number;
    resized?: boolean;
    transformedSizeBytes?: number;
  };
  storageKind?: "inline" | "artifact" | "local_ref" | "remote_ref" | "metadata_only";
  artifactUri?: string;
  originalUrl?: string;
  recoverability?: "provider_ready" | "rebuildable" | "preview_only" | "metadata_only" | "missing";
  preview?: {
    text?: string;
    truncated?: boolean;
    originalBytes?: number;
    startLine?: number;
    totalLines?: number;
    truncatedByTokenCap?: boolean;
    partialViewNotice?: string;
  };
  errorCode?: string;
}

export interface FilePart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
  metadata?: AttachmentStorageMetadata;
}

export interface AgentPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
}

export type TimelinePartDisplay = "separator" | "worklog";

export type TimelinePartStatus =
  | "started"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | string;

export interface TimelineModelSelection extends ModelSelection {
  label?: string;
}

export interface TimelinePartBase {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "timeline";
  display: TimelinePartDisplay;
  status?: TimelinePartStatus;
  anchorMessageId?: MessageId;
  anchorTurnId?: TurnId;
  /** 用户命令产生的 marker 查重锚点；auto/system marker 缺省。 */
  sourceCommandId?: string;
  /**
   * fork copy 降级 provenance：anchor 指向未被复制的消息/父轮时，
   * 本地 anchor 必须清空（不得参与 child 落位），原引用降级到 origin* 仅供溯源。
   */
  originAnchorMessageId?: MessageId;
  originAnchorTurnId?: TurnId;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface GoalVerificationTimelinePart extends TimelinePartBase {
  timelineType: "goal_verification";
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  verification?: {
    passed: boolean;
    reason: string;
    nextAction?: string | null;
  };
}

export interface SessionForkTimelinePart extends TimelinePartBase {
  timelineType: "session_fork";
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

export interface ModelChangeTimelinePart extends TimelinePartBase {
  timelineType: "model_change";
  fromModel?: TimelineModelSelection;
  /** 回滚再升级后模型配置可缺失；不能因此丢掉整条历史内容。 */
  toModel?: TimelineModelSelection & { label: string };
}

export type TimelinePart =
  | GoalVerificationTimelinePart
  | SessionForkTimelinePart
  | ModelChangeTimelinePart;

export type TimelinePartDraft = TimelinePart extends infer Part
  ? Part extends TimelinePart
    ? Omit<Part, "id" | "messageID" | "sessionID" | "type">
    : never
  : never;

export interface SubtaskPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerId: ModelProviderId;
    modelId: ModelId;
  };
  command?: string;
}

export interface RetryPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "retry";
  attempt: number;
  error: AssistantErrorInfo;
  time: {
    created: number;
  };
}

export interface StepStartPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: TokenUsageInfo;
}

export interface SnapshotPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "snapshot";
  snapshot: string;
}

export interface PatchPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "patch";
  hash: string;
  files: string[];
}

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
  };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
  attachments?: FilePart[];
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "tool";
  callID: string;
  /** 同一 assistant 内本地工具的声明序号；旧记录可缺失，不能用落盘顺序代替。 */
  declarationIndex?: number;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | FilePart
  | AgentPart
  | TimelinePart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

/** 分享导入的单事务载荷：新 session、唯一 model-only 上下文和 provenance 全有或全无。 */
export interface SharedContextImportCommitBundle {
  session: CreateSessionInput;
  contextMessage: MessageWithParts;
  provenance: SessionEntryInfo;
}

export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

export interface SharedContextImportTransition {
  sessionID: SessionId;
  contextId: string;
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  sourceId?: string;
}

export const SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION =
  "target_completion_verification" as const;
export const SESSION_ENTRY_BASH_SHELL_SELECTION = "runtime/bash_shell_selection" as const;
export const SESSION_ENTRY_MODEL_SELECTION = "runtime/model_selection" as const;
export const SESSION_ENTRY_EXECUTION_STATE = "runtime/execution_state" as const;
export const SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION =
  "runtime/user_input_auto_resolution" as const;
export const SESSION_ENTRY_WORKSPACE_CHECKPOINT = "runtime/workspace_checkpoint" as const;
export const SESSION_ENTRY_WORKSPACE_FILE_REWIND = "runtime/workspace_file_rewind" as const;

export const SESSION_ENTRY_TYPES = [
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
] as const;

export type SessionEntryType = (typeof SESSION_ENTRY_TYPES)[number];

export interface SessionEntryInfo {
  id: string;
  sessionID: SessionId;
  type: SessionEntryType | string;
  // session entry 既承载用户/工具活动，也承载 session-local 配置快照。
  // 配置恢复或切换只应更新 entry 自己的版本，不能把任务活动时间伪装成“刚刚”。
  touchSession?: boolean;
  time: {
    created: number;
    updated: number;
  };
  /**
   * 逻辑 payload，不等同于数据库 JSON。runtime/model_selection 的读写为公共
   * ModelSelection（无选择沿用 null）；SQLite adapter 负责 modelSelection 包装，
   * 旧平铺字段仅供一次性迁移/回滚，不能暴露给普通消费者或复制到 fork 子记录。
   */
  data: unknown;
}

// ── session_input 账本──
// 输入的 durable 生命周期：admitted（已接受，排队/待注入）→ promoted（已消费成
// transcript user message，与消息持久化同事务）/ cancelled（用户删除队列项等）/
// discarded（session_resumed=重启不保留队列；user_cleared=heldQueue 清空发送）/
// failed（已接受但运行时无法启动；保留终态，重启时禁止再改写成 discarded）。
// id = input/command id（admission 时即存在）；promoted_message_id 是 nullable 外键——
// messageId 在 drain 时才生成。startNow 也必须先经过 durable admission：即使 CLI 在 ACK 后、
// user message 原子 promotion 前崩溃，恢复端也能把输入明确标成 discarded。
export type SessionInputDelivery = "startNow" | "guide" | "queue";

export type SessionInputStatus = "admitted" | "promoted" | "cancelled" | "discarded" | "failed";

/**
 * 执行权威读法的互斥五态（I1：执行侧输入文本与附件只能来自 session_input 账本）。
 *
 * - `pending`：未起跑（status=admitted）。`text` / `attachments` 是本轮**唯一**合法的
 *   执行输入。
 * - `started`：已起跑（promoted，与 user message 同事务落过 transcript）。
 * - `voided`：已作废（cancelled / discarded / failed）。
 * - `missing`：账本无此行——投影与账本不一致。
 * - `corrupt`：账本有这一行且仍是 admitted，但 payload 不可判定（非法 JSON / 非对象 /
 *   text 不是字符串 / 附件事实缺失）。**不是**「合法空文本」——空文本是合法输入
 *   （只有附件的 query），损坏是「读不出用户写了什么」。执行侧必须硬失败：
 *   兜底成 `text: ""` 等于拿空内容起轮再把队列项移除，用户内容静默丢失。
 *
 * 终态、缺失与损坏**刻意不携带 text**：让「终态还去取文本」在类型上写不出来。执行侧
 * 拿到非 pending 必须硬失败，禁止回落投影项文本（spec edit-resend-stale-text I1）。
 */
export type SessionInputExecutionAuthority =
  | {
      state: "pending";
      status: "admitted";
      id: string;
      sessionID: SessionId;
      /** 账本 payload.text：执行侧唯一权威文本。 */
      text: string;
      /**
       * 账本 payload.conversationInputIntent.attachments：执行侧唯一权威附件。
       *
       * 为什么附件也在账本：admission（`v4-bridge.ts` 写 `saveSessionInput`）已把
       * attachments 写进账本，`TurnSteerQueued` 的幂等 upsert 通过
       * `buildPersistedConversationInputIntent`（`attachments: intent.attachmentRefs`）
       * 原样保留——即「文本 + 附件」是同一权威面上的两个字段，零新增写入。
       * 空数组 = 账本明确说「无附件」，与「字段读不出」区分开（后者是 `corrupt`）。
       */
      attachments: readonly AttachmentRef[];
    }
  | {
      state: "corrupt";
      /** 不可判定原因：只看 payload 本身能否读成合法执行输入。 */
      reason:
        | "payload_unparsable"
        | "payload_not_object"
        | "text_not_string"
        | "attachments_unreadable";
      id: string;
      sessionID: SessionId;
    }
  | {
      state: "started";
      status: "promoted";
      id: string;
      sessionID: SessionId;
      promotedMessageID?: MessageId;
    }
  | {
      state: "voided";
      status: "cancelled" | "discarded" | "failed";
      id: string;
      sessionID: SessionId;
      statusReason?: string;
    }
  | {
      state: "missing";
      id: string;
      sessionID: SessionId;
    };

export interface SessionInputRecord {
  id: string;
  sessionID: SessionId;
  kind: string;
  delivery: SessionInputDelivery;
  payload: { text: string; [key: string]: unknown };
  admittedSequence: number;
  promotedSequence?: number;
  promotedMessageID?: MessageId;
  status: SessionInputStatus;
  statusReason?: string;
  time: { created: number; updated: number };
}

export type UsageQuerySource =
  | "main_turn"
  | "session_title"
  | "goal_completion_verification"
  | "subagent"
  | "workflow_child"
  | "unknown";

export type UsageStatus = "running" | "completed" | "error" | "cancelled";

export interface ModelUsageRecord {
  id: string;
  logicalRequestId: string;
  attemptIndex?: number;
  sessionID: SessionId;
  turnID?: TurnId;
  traceID?: TraceId;
  spanID?: string;
  assistantMessageID?: MessageId;
  parentUserMessageID?: MessageId;
  querySource: UsageQuerySource | string;
  providerId: ModelProviderId | string;
  modelId: ModelId | string;
  reasoningLevel?: string;
  agent?: string;
  mode?: string;
  taskType?: SessionTaskType;
  status: UsageStatus;
  startedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  providerTotalTokens?: number;
  computedTotalTokens?: number;
  retryCount?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  contextExceeded?: boolean;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  rawUsage?: unknown;
  providerMetadata?: unknown;
}

export interface TurnUsageRecord {
  sessionID: SessionId;
  turnID: TurnId;
  traceID?: TraceId;
  userMessageID?: MessageId;
  status: UsageStatus;
  startedAt: number;
  firstModelStartAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  modelRequestCount?: number;
  modelRetryCount?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  computedTotalTokens?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  contextExceeded?: boolean;
  errorType?: string;
  errorCode?: string;
}

export interface ToolUsageRecord {
  id: string;
  sessionID: SessionId;
  turnID?: TurnId;
  traceID?: TraceId;
  toolCallID: ToolCallId | string;
  toolName: string;
  sideEffectScope?: ModelToolSideEffectScope | string;
  readOnly?: boolean;
  destructive?: boolean;
  approvalStatus?: "none" | "requested" | "allowed" | "denied";
  status: UsageStatus;
  startedAt: number;
  firstOutputAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstOutputMs?: number;
  exitCode?: number;
  outputBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  truncated?: boolean;
  retryCount?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface AppUsageQueryInput {
  /** 含 (since, until] 的下界（unix ms）。 */
  since: number;
  /** 上界（unix ms），通常为 now。 */
  until: number;
  /** 调用端时区相对 UTC 的固定偏移（ms），用于按本地日归桶。 */
  tzOffsetMs: number;
}

export interface AppUsageTotalsRow {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
  avgTimeToFirstTokenMs: number | null;
}

export interface AppUsageTurnTotalsRow {
  totalSessions: number;
  totalTurns: number;
  avgTurnDurationMs: number | null;
  longestSessionMs: number;
}

export interface AppUsageToolTotalsRow {
  toolCallCount: number;
  toolErrorCount: number;
}

export interface AppUsageModelRow {
  modelId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface AppUsageToolRow {
  toolName: string;
  callCount: number;
  errorCount: number;
  avgDurationMs: number | null;
}

export interface AppUsageDayRow {
  dayIndex: number;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
}

export interface AppUsageDayModelRow {
  dayIndex: number;
  modelId: string | null;
  totalTokens: number;
}

export interface AppUsageQueryResult {
  totals: AppUsageTotalsRow;
  turnTotals: AppUsageTurnTotalsRow;
  toolTotals: AppUsageToolTotalsRow;
  models: AppUsageModelRow[];
  tools: AppUsageToolRow[];
  days: AppUsageDayRow[];
  dayModels: AppUsageDayModelRow[];
}

export interface TaskUsageQueryInput {
  sessionID: SessionId;
}

export interface TaskUsageQueryResult {
  sessionID: SessionId;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
  inputBaselineBySource: Record<string, number>;
}

export interface UsageStorePort {
  recordModelUsage(input: ModelUsageRecord): Promise<void>;
  upsertTurnUsage(input: TurnUsageRecord): Promise<void>;
  upsertToolUsage(input: ToolUsageRecord): Promise<void>;
  pruneUsage(input?: { beforeTime?: number }): Promise<void>;
  queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult>;
  queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult>;
}

export interface LocalSettingStorePort {
  getProjectPermissionMode(
    projectID: ProjectId,
  ): CollaborationMode | null | Promise<CollaborationMode | null>;
  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode | Promise<CollaborationMode>;
}

// ── 全序消息索引：id 序的唯一窄读面 ────────────────────────────────────────
//
// 只读排序键（id / sequence / time_created / rowid），**不读 `data`**：role 在
// `data` JSON 里，索引不需要它，读它等于回退成全量正文读。排序必须与 `messages()`
// 逐字一致（`order by sequence is null, sequence, time_created, rowid`）——这是 IS2
// 的权威序，两条路径不同序会让裁断在索引路径上复活已回滚分支。

/** 消息索引的一行：排序键 + SQLite rowid，不含 role/正文。 */
export interface SessionMessageIndexEntry {
  id: MessageId;
  /** `message.sequence` 原值；null = 迁移前的旧行，排序时排在非空之后。 */
  sequence: number | null;
  timeCreated: number;
  /** SQLite rowid，同序行的最终 tiebreaker。**不是**投影 rowId。 */
  storageRowId: number;
}

/**
 * `readActiveBranchToolParts` 的一条结果：工具调用 part + 它挂在哪条消息上。
 *
 * 带上 `messageId` 是为了让调用方按**自己的** id 序（active 分支序）排序/过滤；
 * 实现侧的顺序只保证「与 `messages()` 同一 part 序」，不保证分支语义。
 */
export interface SessionToolPartEntry {
  messageId: MessageId;
  part: ToolPart;
}

/**
 * 「最后一条带 mode 的 assistant」的窄读结果（首屏 model/mode 种子，IS3 / Step 9）。
 *
 * view-only shell 用 `createRecord(resume:false)` 物化 record：runtime 取**默认模型**，
 * 于是首屏若读 record 就会把默认模型当成历史选型显示出来。首屏种子只能来自持久事实，
 * 而 mode 只落在 assistant 消息上（没有 session_entry 承载它）。
 */
export interface PersistedAssistantSelection {
  /** 持久化的协作模式原值；调用方必须再过一次 mode 词表校验（旧记录可能有非法值）。 */
  mode?: string;
  /** 同一条消息的选型；缺 provider/model 时不伪造（首屏显示空态）。 */
  modelSelection?: ModelSelection;
}

// ── turn 行清单（row manifest）：全序计数的持久权威 ─────────────────────────
//
// 两张表分工（session_turn_manifest / session_turn_query_manifest）：
//   turn 级  —— 出 totalCount、firstRowId 与每个 turn 的 rowId base（base =
//               1 + Σ 前序 active turn 的 rowCount，**不落库**：落库就会成为与投影
//               规则并存的第二个事实源）；
//   query 级 —— 出 turnDirectory（只登记 origin === "realUser" 的 query）。
//
// 键控坐标是 (sessionID, branchGeneration)：branchGeneration 与
// `SessionRevert.branchGeneration` 同源，每次 destructive conversation rewind 单调 +1。
// 空 active 分支在存储里没有任何行，因此与「manifest 缺失」同义；读端按降级处理，
// 降级后仍需满足 totalCount=0 / firstRowId=null（见 TurnManifestSnapshot）。

/** `rowCount` 的产生路径：live = 活投影终态；cold = 冷物化回写。 */
export type TurnManifestRowCountSource = "live" | "cold";

export interface TurnManifestTurnRecord {
  turnId: string;
  /** active 分支内的 turn 位置（0 起）。决定 rowId base 的累加顺序。 */
  ordinal: number;
  /** 该 turn 全部可投影 messageId（按行序、去重）。 */
  messageIds: string[];
  firstMessageId: MessageId | null;
  lastMessageId: MessageId | null;
  /** 该 turn 在投影里的行数（含 turnHeader 与同 turn 的 steer 行）。 */
  rowCount: number;
  rowCountSource: TurnManifestRowCountSource;
  /** 投影规则版本；不匹配即整表重建，避免 rowId 整体漂移。 */
  projectionSchemaVersion: number;
}

export interface TurnManifestQueryRecord {
  turnId: string;
  /** 同一 turn 内 realUser query 的序号（0 起）。steer query 各自成条。 */
  queryOrdinalInTurn: number;
  /** 该 query 行的 transcript messageId；旧事件可能没有。 */
  queryMessageId: MessageId | null;
  queryRowId: number;
  /**
   * 该 query 分段的行数：从 query 行自身（含）到下一个 realUser query 行（不含）
   * 或 turn 末尾为止。turn 起始的 turnHeader 不属于任何分段。
   */
  rowCount: number;
  queryPreview: string;
  assistantPreview: string;
  assistantPreviewKind: "text" | "running" | "empty";
}

export interface TurnManifestWrite {
  sessionID: SessionId;
  branchGeneration: number;
  turn: TurnManifestTurnRecord;
  /** 该 turn 的全部 realUser query 行（整批替换，不做增量合并）。 */
  queries: TurnManifestQueryRecord[];
}

export interface TurnManifestSnapshot {
  branchGeneration: number;
  /** 按 ordinal 升序。 */
  turns: TurnManifestTurnRecord[];
  /** 按 (turnId 的 turn 顺序, queryOrdinalInTurn) 升序。 */
  queries: TurnManifestQueryRecord[];
  /** Σ turn.rowCount；空 active 分支为 0。 */
  totalCount: number;
  /** 空 active 分支为 null；否则恒为 1（rowId base 从 1 起）。 */
  firstRowId: number | null;
  realUserQueryTotal: number;
  /** 本次读取是否做过账目修正（就地改 row_count，不重读正文）。 */
  manifestAdjusted: boolean;
  adjustedTurnIds: string[];
}

export type TurnManifestReadResult =
  | { status: "missing" }
  | { status: "schemaMismatch"; expectedVersion: number; foundVersions: number[] }
  /**
   * manifest 与观察到的会话不一致 → **整表重建**（不做账目修正：修正只处理「已登记
   * turn 的行数偏差」，这三种是「清单本身缺项/指向不存在的消息」）。
   *
   * - `ordinalGap`：已登记 turn 的 ordinal 出现空洞 = 中间某轮从未登记（detached 写入
   *   丢失）。这是「存在 manifest 未登记的 turn」在 **manifest 内部**可判的一半。
   * - `unregisteredTurns`：调用方给出的权威 turn（投影/durable 事件）里有未登记的轮次。
   *   消息索引没有 turn 维度，尾部丢失只能靠这个观察抓。
   * - `messageIndexMismatch`：manifest 登记的 messageId 不在消息索引里（消息被删/换库）。
   */
  | {
      status: "inconsistent";
      reason: "ordinalGap" | "unregisteredTurns" | "messageIndexMismatch";
      /** unregisteredTurns 时给出观察到的、manifest 未登记的 turn。 */
      turnIds: string[];
      /** messageIndexMismatch 时给出索引里找不到的 messageId（截断到前 20 条）。 */
      missingMessageIds: string[];
    }
  | { status: "ok"; snapshot: TurnManifestSnapshot };

export interface TurnManifestReadInput {
  sessionID: SessionId;
  branchGeneration: number;
  expectedProjectionSchemaVersion: number;
  /**
   * 已物化窗口内 turn → 实际行数。给出时做一次 O(turns) 账目修正：
   * 只改不一致的 row_count（后续 turn 的 base 因累加而自动平移），不重读正文。
   */
  observedRowCounts?: ReadonlyMap<string, number>;
  /**
   * 消息索引（`listSessionMessageIndex`）的 id 观察。给出时校验 manifest 的 messageId
   * 覆盖：引用了索引里不存在的消息 → `inconsistent/messageIndexMismatch`（整表重建）。
   * 仓储只读 manifest 表本身，索引由调用方读一次传进来（仓储不得回读 message 正文）。
   */
  observedMessageIds?: readonly MessageId[];
  /**
   * 权威 turn 观察（调用方从投影或 durable 事件得到——**消息索引本身没有 turn 维度**，
   * 抓不到尾部丢失的轮次）。给出且存在 manifest 未登记的 turn →
   * `inconsistent/unregisteredTurns`（整表重建；就地补写需要 row_count，等价于物化）。
   */
  observedTurnIds?: readonly string[];
}

export interface TurnManifestBranchRewriteInput {
  sessionID: SessionId;
  /** 目标代次（rewind 后 = 事件给出的新代次）。 */
  branchGeneration: number;
  /** 复制来源代次；等于目标代次表示原地过滤同一代次。 */
  sourceGeneration: number;
  /** 保留的 turn，按 active 分支行序；ordinal 依此重建。 */
  keptTurnIds: readonly string[];
}

/**
 * rewind 分支重写结果。`applied: false` 表示源 manifest 不完整（老会话、gen 不匹配、
 * 该代次从未写过）——目标代次保持缺失，读端据此降级为全量物化并重建，**不得**把
 * 「缺行」当成「空分支」。
 */
export type TurnManifestBranchRewriteResult =
  | { applied: true; keptTurnCount: number }
  | { applied: false; reason: "sourceIncomplete"; missingTurnIds: string[] };

/**
 * manifest 读写面。实现约束：
 * - 写入是整 turn 替换（turn 行 upsert + 该 turn 的 query 行整批替换），幂等；
 * - branchGeneration 变化时只复制保留的 turn，不重算 row_count；
 * - 读取不得读 message/part 正文。
 */
export interface TurnManifestStorePort {
  upsertTurnManifest(input: TurnManifestWrite): Promise<void>;
  rewriteTurnManifestBranch(
    input: TurnManifestBranchRewriteInput,
  ): Promise<TurnManifestBranchRewriteResult>;
  readTurnManifest(input: TurnManifestReadInput): Promise<TurnManifestReadResult>;
}

export interface SessionStorePort {
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /** legacy 兼容原语；V4 stable/compact-edit fork 禁止调用，统一走 commitForkBundle。 */
  createForkedSessionWithMetadata?(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo>;
  /** V4 stable/compact-edit fork 的唯一事务入口。legacy workspace fork 不调用。 */
  commitForkBundle?(bundle: ForkCommitBundle): Promise<SessionInfo>;
  commitSharedContextImportBundle?(bundle: SharedContextImportCommitBundle): Promise<SessionInfo>;
  transitionSharedContextImport?(input: SharedContextImportTransition): Promise<boolean>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /**
   * 用 host task-index allowlist 为旧远端 session 补写 workspace identity。
   * 实现必须同时校验 id、directory 与 workspace_id is null，禁止覆盖已有 identity。
   */
  claimLegacySessionWorkspace?(input: ClaimLegacySessionWorkspaceInput): Promise<number>;
  /**
   * 修复曾把 remote identity 写入 directory/path 的单条历史 session。
   * 实现必须校验 session id、NULL workspace_id 及旧目录精确匹配，禁止批量路径迁移。
   */
  repairLegacyRemoteSessionWorkspace?(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean>;
  /**
   * 已有 remote identity 的维护性路径自愈 CAS。
   * 实现只能更新 directory、path 和单调 time_updated，禁止写回其它 session 元数据。
   */
  repairRemoteSessionPaths?(input: RepairRemoteSessionPathsInput): Promise<boolean>;
  saveMessage(input: MessageInfo, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void>;
  savePart(input: MessagePart, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removePart(input: { sessionID: SessionId; messageID: MessageId; partID: PartId }): Promise<void>;
  messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  /**
   * 全序消息索引：与 `messages()` **同一权威排序**，但不读 `data`、不解码 parts。
   * 缺席（旧宿主/内存 store）= 调用方降级为全量 `messages()`，不得当成空会话。
   */
  listSessionMessageIndex?(input: { sessionID: SessionId }): Promise<SessionMessageIndexEntry[]>;
  /**
   * 首屏 model/mode 的窄读：**最后一条带 mode 的 assistant**（IS3 / Step 9）。
   *
   * 只读一行的 `data`（不解码 parts、不扫全表）。用途是 view-only shell 的首屏种子：
   * `createRecord(resume:false)` 让 runtime 落到默认模型，`getSessionConfigSeed` 若读 record
   * 就会把**默认模型**当成历史选型显示出来。
   *
   * 缺席（旧宿主 / 内存 store）→ 首屏显示空态，激活后再补齐（spec 的首屏降级清单第 ④ 项）。
   */
  readLatestAssistantSelection?(input: {
    sessionID: SessionId;
  }): Promise<PersistedAssistantSelection | null>;
  /**
   * 分支感知的尾窗正文读（IS2 / IS6 的读面）。
   *
   * `activeMessageIds` 是调用方用消息索引 + `selectActiveConversationBranchIds` 算出的
   * **全序** active 分支 id 序；实现只按这份序取窗口内的 message + part 正文，不做裁断、
   * 不按时间取尾 N 条（那会在 revert 会话上复活旧分支或清空历史）。
   * `limitBefore` 是窗口首条 id（含），由 manifest 的窗口首轮给出；缺席或找不到 = 读整条分支。
   * `limitAfter` 是窗口**之后**一条 id（不含），由 manifest 的「页末轮之后第一个有消息的轮」
   * 给出；缺席或找不到 = 读到分支末尾。两个游标一起把一次翻页的正文读限制在页内的整轮里
   * （Step 7 按需物化；不传 `limitAfter` 时行为与 Step 5 逐字相同）。
   *
   * 缺席（旧宿主 / 内存 store）= 调用方降级为全量 `messages()`，不得当成空会话。
   */
  readActiveBranchTail?(input: {
    sessionID: SessionId;
    activeMessageIds: readonly MessageId[];
    limitBefore?: MessageId | null;
    limitAfter?: MessageId | null;
  }): Promise<MessageWithParts[]>;
  /**
   * **按 tool 名**取整条 active 分支的工具调用 part（fix-c19 的窄读）。
   *
   * 唯一消费者是子会话候选（`listSessionSubagents` → `collectSubagents`）：它只看
   * `Agent` / `Task` / `subagent` 三类 tool part，而旧实现为此读一次父会话全文
   * （长会话 3012 message / 29MB，实测 ~490ms）。
   *
   * `toolNames` 在 SQL 侧过滤（`json_extract(data, '$.tool')`），不把无关 part 读出来；
   * `activeMessageIds` 给出时只在**这份序**里取（顺序即返回值顺序），缺席则整会话取。
   * 实现**不做**分支裁断——裁断仍是 `selectActiveConversationBranchIds` 那一份唯一实现。
   *
   * 缺席（旧宿主 / 内存 store）= 调用方降级为全量 `messages()`（窄读是优化，不是语义前提）。
   */
  readActiveBranchToolParts?(input: {
    sessionID: SessionId;
    toolNames: readonly string[];
    activeMessageIds?: readonly MessageId[];
  }): Promise<SessionToolPartEntry[]>;
  saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
  sessionEntries?(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]>;
  /**
   * turn 行清单读写面（可选：旧宿主/内存 store 不实现）。缺席时投影侧只跳过 manifest
   * 写入，读取方必须降级为全量物化——不得把「没实现」当成「空分支」。
   */
  turnManifest?: TurnManifestStorePort;
  // ── session_input 账本（可选方法，旧宿主可不实现）──
  /** admission：输入已被接受（排队/待注入），durable 记账。幂等（同 id 重入更新 payload）。 */
  saveSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void>;
  /** 审批完全访问：execution、固定队列权限和幂等 receipt 同一事务；无 schema migration。 */
  commitPermissionFullAccess?(input: {
    sessionID: SessionId;
    queueItemIds: string[];
    execution: SessionEntryInfo;
    receipt: SessionEntryInfo;
    signal?: AbortSignal;
  }): Promise<void>;
  /** queue 编辑/重排的 durable 原子更新；只允许修改 admitted 记录。 */
  updateSessionInputs?(input: {
    sessionID: SessionId;
    updates: Array<{
      delivery?: SessionInputDelivery;
      id: string;
      intent?: import("./session.port.js").TurnInputIntentMetadata;
      text?: string;
      queuePosition?: number;
    }>;
  }): Promise<void>;
  /**
   * promotion（原子性硬要求）：账本置 promoted + user message/parts
   * 持久化在同一事务——杜绝「queue 已消费但 transcript 无 user message」的孤儿窗口。
   *
   * **只接受 status=admitted 的行**：UPDATE 带 `status='admitted'` 前置，条件不满足
   * （行已被 settle 成 cancelled/discarded/failed，或行不存在）即抛错并回滚整个事务，
   * 不留半截 user message。原因：执行侧读权威（`getSessionInputForExecution`）与
   * promotion 之间存在窗口（读在 reserve 之前），期间该行可能被取消；无前置条件的
   * UPDATE 会把已取消的输入改写成 promoted 并落进 transcript，等于让一条被撤销的
   * 输入在历史里复活（spec edit-resend-stale-text F5）。
   */
  promoteSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void>;
  /**
   * 非原子 promotion 标记：message 持久化已在别处完成的路径（background wake 的
   * synthetic notice）只补账本状态。新路径应优先用 promoteSessionInput（原子）。
   */
  markSessionInputPromoted?(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void>;
  /** 终态收口：cancelled（user_removed 等）/ discarded（session_resumed / user_cleared）。 */
  settleSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void>;
  listSessionInputs?(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]>;
  /** global createSession.firstInput 查重：由 queue_<sourceCommandId> 找回真实 session。 */
  getSessionInputById?(id: string): Promise<SessionInputRecord | null>;
  /**
   * 执行权威读法（I1）：按 id + session 读 session_input，返回互斥五态 + 权威文本/附件。
   *
   * 与 `getSessionInputById` 的分工：后者是 global 查重（createSession 跨 session 找回），
   * 不带 session 约束也不区分终态；本方法是执行侧「这条输入还能不能跑、跑什么内容」的
   * 唯一读入口——跨会话同 id 不得执行，终态/缺失/损坏必须由调用方硬失败（不得回落投影，
   * 不得把损坏 payload 兜底成空文本）。
   */
  getSessionInputForExecution?(input: {
    id: string;
    sessionID: SessionId;
  }): Promise<SessionInputExecutionAuthority>;
  readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]>;
  updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void>;
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal>;
  cloneTargetForFork?(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal>;
  createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null>;
  updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null>;
  startTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null>;
  heartbeatTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null>;
  finishTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null>;
  recoverInterruptedTargetRun?(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null>;
  updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null>;
  clearTarget(input: { sessionID: SessionId }): Promise<boolean>;
  getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null>;
  saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset>;
  setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionId): Promise<void>;
}
