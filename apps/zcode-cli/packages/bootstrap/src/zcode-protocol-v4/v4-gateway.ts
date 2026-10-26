import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  type BackgroundBashOutputResult,
} from "@zcode/shared/zcode-protocol-v4";
// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowRunSessionSummary,
  MessageWithParts,
  SessionEvent,
  TargetChangedPayload,
  TurnId,
  TurnManifestBranchRewriteInput,
  FileSystemErrorCode,
} from "@zcode/contracts";
import type {
  ConversationSnapshot,
  SessionMagicContextUsage,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType, isFileSystemPortError } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import type {
  CommandAck,
  AttachmentRef,
  CommandEnvelope,
  CommandKey,
  CommandResult,
  ConversationRowTarget,
  CommandsQueryResult,
  ConversationInputIntent,
  ConversationTopicFrame,
  QueueItem,
  RoutedTopicFrame,
  RoutedTopicWireFrame,
  SessionSummary,
  SessionsIndexTopicFrame,
  SubscribeAck,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationTurnDirectoryResult,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationOpenTiming,
  ConversationOpenPhases,
  SessionRuntimeAvailability,
  V4ConversationRuntimeReadyResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  readZCodeAttachmentFaultCode,
  encodeTopicWireFrames,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  parseCommandEnvelope,
  measureTopicNotificationEnvelopeBytes,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowParamsSchema,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationPlansParamsSchema,
  WORKFLOW_ARTIFACT_LIMITS,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  WORKFLOW_WORKSPACE_LIMITS,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationTurnDirectoryParamsSchema,
  v4ConversationTurnDirectoryResultSchema,
  v4ConversationRuntimeReadyParamsSchema,
  v4ConversationRuntimeReadyResultSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import {
  ColdSessionResumeCoordinator,
  type ColdSessionResumeOutcome,
  type ColdSessionShellOutcome,
} from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import type {
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
  TurnModelBaselineSeed,
} from "./product-projection.js";
import { ProductProjection } from "./product-projection.js";
import {
  TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
  type TurnManifestEntry,
} from "./turn-manifest-entry.js";
import {
  decideRowManifestAction,
  selectColdRowPage,
  type ColdRowPagePlan,
  type ColdTailWindowPlan,
  type SessionRowManifestFacts,
  type SessionRowManifestReadOutcome,
  type SessionRowManifestReadRequest,
} from "./session-row-manifest.js";
import type { ConversationRowTargetAction } from "./product-projection.js";
import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";

function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // conversation projection 为了 row 索引用 string 保存 product turnId；
  // 离开 gateway 调 runtime 文件摘要/回退能力时，需要恢复 contracts 的品牌类型。
  return turnId as TurnId | null;
}

function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
      return type;
    default:
      return null;
  }
}

interface PersistedEventsLoadResult {
  events: SessionEvent[];
  synthesized: boolean;
  /**
   * 冷恢复时持久化的分支代次（`SessionRevert.branchGeneration`）。事件重放推不出来：
   * synthesized transcript 不含 RewindTriggered，缺这个种子 manifest 会键控到代次 0。
   */
  branchGeneration?: number;
  /** durable transcript 重放后、live buffer 补回前注入的 store-verified child manifest。 */
  subagentsSeed?: SessionSubagentsSeed;
  /** shared_context 不生成可见 row；只把脱敏 handover metadata 下发。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** memory eventStore 取快照时已包含的 raw sequence 水位。 */
  sourceEventSeq?: number;
  /** 与本次历史事件使用同一容量的种子；null 表示已查询但没有历史水位。 */
  usageSeed?: SessionUsageSeed | null;
  /**
   * 本次冷开实际物化的**尾窗坐标**（Step 6 / IS2 / IS6）。给出时：
   * `events` 只覆盖窗口内的整轮（`turnId` 起点由 `ordinal` 决定），投影必须用
   * `rowIdBase` 播种 `rowIdOrigin`，manifest 回写必须从 `ordinal` 起编号且 `keptTurnIds`
   * 取**整条分支**（`branchTurnIds`）。缺席 = 全量物化（旧行为）。
   */
  coldWindow?: ColdTailWindowPlan;
  /**
   * 窗口的**上一轮模型基线**（Step 7 补漏）：窗口前一轮首条消息的选型。
   *
   * 它与 `coldWindow` 是一对：`rowIdOrigin` 决定行号起点，它决定「窗首那一轮要不要落
   * `modelChange` marker」。只喂窗口时投影没有上一轮（`lastTurnModel` 停在 silentInitial），
   * 而 marker 是靠「上一轮模型 vs 本轮 config」判定的——模型恰好在窗首切换时那一行会消失，
   * 于是 `row_count` 少 1、其后每一行的 rowId 整体前移（与全量物化分叉）。
   * 全量物化路径不传（它自己有完整的轮次）。
   */
  synthesisModelBaseline?: TurnModelBaselineSeed;
  /**
   * 本次首屏是按 **view-only 口径**读的（Step 9 的 store-only：record 还是 shell，或压根
   * 没有 record）。此时 usage / fileChanges 摘要 / `thoughtLevels` 等 runtime 事实刻意缺席
   * ——它们只能从 runtime 读，读不到时留空比拿默认模型编一个更误导的值好。
   *
   * 激活后从宿主端口**窄读**补齐（fix-c19：不再重读正文——行集合由 manifest 给，窗口化
   * 首屏就是终态）。**只有**它为真才算「欠一次派生量补种」；窗口化本身不算（窗口只裁正文，
   * runtime 事实齐全，把整条分支灌进 live 投影正是风险 24）。
   */
  viewOnlyHydration?: boolean;
}

/**
 * 「宿主没有持久读取能力」的读结果：**真的没有持久事实**（旧宿主 / 最小夹具）。
 *
 * 它与「读失败」在 `events` / `sourceEventSeq` 两个字段上完全同形，语义却相反：
 * 前者是**权威的空**（没有任何持久事实可读），后者是**未知**（本来该有，但这次没读到）。
 * 未知不得覆盖已知——两者的分流点只有 `performHydration` 里那一个 `loadFailed` 判定，
 * 所以这里的常量**只能**用在「确实没有」的位置（`loadPersistedEvents` 缺席）。
 */
const NO_PERSISTED_EVENTS: PersistedEventsLoadResult = {
  events: [],
  synthesized: false,
  sourceEventSeq: 0,
};

type V4GatewayErrorContext = Record<string, unknown>;

/**
 * 一条已读回的**整份字节**，供分块读取复用。
 *
 * 两个家族共用这张表：已发送附件的预览（`attachmentRead`）与 dwf 用户面产物的字节
 * （`workflowRunArtifactRead`）。共用是有意的——两者的失效规则逐字相同（TTL、字节预算、
 * 最旧先逐、会话销毁时按 `sessionId` 清），而分成两张表会得到两份**各自**的字节预算，
 * 于是"最多缓存多少字节"这条约束就再也说不清了。
 *
 * 键空间靠**首段标签**区分（`att` / `dwfart`），不靠字段个数或内容——两个家族的键都是
 * NUL 分隔的四五段，段数相同、内容也可能撞（一个叫 "1" 的产物 id 与一个 attachmentIndex
 * 1 会长得一样），只有一个不可能相等的首段才是可证明的隔离。
 *
 * `bytes` 为 null 表示读还在飞：此时它不计入预算，也不会被按预算逐出（逐出一个正在被
 * await 的条目只会让下一块重新读一遍整份文件，正是这张表要消灭的事）。
 */
interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export interface V4GatewayHost {
  cliVersion?: string;
  /** 会话是否在宿主注册表中活跃（inbox 的 sessionNotFound 裁决依据）。 */
  sessionExists(sessionId: string): boolean;
  /**
   * 该会话的 **runtime 是否正在跑**（IS4 / Step 9）。
   *
   * 这是与 {@link sessionExists} **不同**的问题：`materializeSessionShell` 会
   * `createRecord` 但不 resume，于是 record 在册而 runtime 没起来。「会话算不算 live」与
   * 「runtime 是否就绪」都必须读这里——读 record 会让 view-only 会话误报就绪，send 类命令
   * 随即撞上一个没起 runtime 的 record（幽灵 runtime 的入口）。
   *
   * 未实现（旧宿主 / 测试桩）→ gateway 退回「record 在册」：那些宿主没有 view-only shell
   * 路径，两种口径等价。
   */
  isSessionRuntimeActive?(sessionId: string): boolean;
  /**
   * V4 冷恢复钩子。gateway 用同一个 READY promise 包住 runtime activation 与 projection
   * hydration；宿主只负责恢复 record。
   */
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  /**
   * **只物化 view-only 外壳**（IS3 / Step 9 的视图水位入口）：store 读 session + 首屏
   * model/mode 种子 + `createRecord(resume:false)`，**不** resume。
   *
   * 有它时 `ensureViewReadyPublisher` 只等这一条，首屏不再串进 runtime 激活；
   * 缺席（旧宿主 / 测试桩）→ 退回 Step 8 的「先激活再建投影」，行为不变。
   *
   * `notFound` 与 `resumePersistedSession` 同义（store 里也没有这条会话），错误分型由
   * `ColdSessionResumeCoordinator` 统一。
   */
  materializeSessionShell?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionShellOutcome>;
  /**
   * 下行物理帧出口（宿主负责投递：stdio notification / MessagePort / ws）。
   *
   * 逻辑帧 fallback 会绕过 1MiB 上限、分片和接收端原子组装边界；因此生产
   * host 与测试 host 都必须显式接收 physical wire，类型层不再允许退回逻辑帧。
   */
  emitWireFrame(frame: RoutedTopicWireFrame): void;
  /** 当前进程 live ingest 的无正文事实；不缓存、不进入 topic replay。 */
  emitConversationTelemetryFact?(fact: ConversationTelemetryFact): void;
  /** 当前进程 live request_access 权限事实；不缓存、不进入 topic replay。 */
  emitCuaPermissionObservation?(observation: CuaPermissionObservation): void;
  /**
   * sessions-index：会话 → 所属 workspaceId（列表 topic 的分桶键）。
   * 未实现（旧宿主）→ sessions-index 路径整体不激活（no-op），不影响 conversation。
   */
  getSessionWorkspaceId?(sessionId: string): string | null;
  /** sessions-index：会话的列表用元信息（createdAt/父会话/最后活动时刻）。 */
  getSessionIndexMeta?(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    parentSessionId?: string;
  } | null;
  /**
   * config 种子：会话 runtime 的当前真值（模型选型/思考深度/协作模式）。
   * 投影初值不能写死空值——runtime 的启动默认模型、项目持久化 mode 偏好、历史会话
   * resume 恢复的上次选型都只活在 runtime 里（ModelSelected 仅在 switchModelConfig 后
   * 补发，日志里可能根本没有），种子是它们进投影的唯一通道。
   * 会话不在册返回 null（gateway 跳过，保持空初值）；未实现（旧宿主/测试桩）同。
   */
  getSessionConfigSeed?(sessionId: string): SessionConfigSeed | null;
  /** 只读会话创建期 App 开关，不读取实时设置或推断 Memory 工具使用。 */
  getSessionMemoryEnabled?(sessionId: string): boolean | undefined;
  /**
   * 冷恢复 usage 种子：transcript 合成路径可能只能生成 0/默认窗口的占位
   * ModelComplete；宿主可从持久化 assistant tokens / runtime snapshot 提供真实水位。
   * 未实现时保持事件日志归约结果。
   */
  getSessionUsageSeed?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<SessionUsageSeed | null> | SessionUsageSeed | null;
  /** sessions-index：某 workspace 下当前在册的会话 id（冷启动 snapshot 用）。 */
  listWorkspaceSessionIds?(workspaceId: string): string[];
  /**
   * sessions-index：draft 判定——deferred 持久化且未发首条输入的会话不进列表。
   * 旧 workspace prepare 路径会预建 deferred 会话（历史上列表读 sqlite、
   * deferred 不落盘故不可见）；sessions-index 从活注册表派生后这些幽灵 draft 会
   * 以「新任务」出现在侧栏。首条 sendText 把 persistence 提升为 immediate 后，
   * 事件流自然触发 fanOutToIndex 使会话入列。未实现（旧宿主/测试桩）→ 不过滤。
   */
  isDraftSession?(sessionId: string): boolean;
  /**
   * sessions-index：从持久化 store 直接构造某 workspace 全部会话的轻量摘要（冷启动种子）。
   * 未加载（无 live publisher）的会话靠它进列表；已加载的会话由 gateway 用 live 投影覆盖。
   * store 读取是异步的，故允许返回 Promise（gateway 订阅时 await；同步 stub 直接返回数组）。
   */
  getStoredSessionSummaries?(workspaceId: string): Promise<SessionSummary[]> | SessionSummary[];
  /**
   * 3.3.6 远端历史兼容：用精确 task allowlist 幂等认领后返回严格 identity 摘要。
   * 非远端 workspace 返回 null；失败可降级为空数组，后续携带 allowlist 的订阅会重试。
   */
  refreshLegacySessionSummaries?(
    workspaceId: string,
    legacyTaskIds: readonly string[],
  ): Promise<SessionSummary[] | null> | SessionSummary[] | null;
  /**
   * workspace-config：某 workspace 的配置目录（config options + slash 命令）。
   * 订阅时的种子与 invalidateWorkspaceConfig 重拉都走这里。
   * 未实现（旧宿主 / 测试桩）→ workspace-config 路径退化为空目录快照。
   */
  getWorkspaceConfig?(
    workspaceId: string,
  ): Promise<WorkspaceConfigState | null> | WorkspaceConfigState | null;
  readBackgroundBashOutput?(sessionId: string, workId: string): Promise<BackgroundBashOutputResult>;
  /** 执行 accepted 命令的副作用；返回值进 ACK.result（fork/createSession 带 sessionId）。 */
  executeCommand(
    envelope: CommandEnvelope,
    admission?: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<CommandResult | undefined>;
  /** 输入命令执行前先落 durable admission；返回同一份完整 intent 供 inbox pin。 */
  admitCommandInput?(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelCommandInput?(
    envelope: CommandEnvelope,
    queueItemId: string,
    reason: string,
  ): Promise<void>;
  /** projection 运行中越过 16MiB 时终止当前 turn；同一 fault 周期由 gateway 保证只调用一次。 */
  terminateTurnForProjectionFault?(
    sessionId: string,
    reasonCode: "proto.payloadTooLarge",
  ): Promise<void> | void;
  /** commands/query 持久化 fallback；四个来源必须按 sourceCommandId 精确命中。 */
  lookupTranscriptCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupTimelineCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupChildCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupDiscardedCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  /** transcript 原子 promotion 后同步失效旧 lazy seed，再解除 CommandInbox live pin。 */
  invalidatePersistentCommandFacts?(sessionId: string): void;
  /** canonical goal complete 已进入 projection；宿主副作用必须 detached，禁止阻塞 ingest。 */
  onTargetCompleted?(sessionId: string, event: SessionEvent): void;
  /**
   * turn 终态的行清单写入（`onTurnComplete` / `onTurnError` 两处）。实现必须持久、幂等，
   * 且不得阻塞 ingest——投影侧只负责把 entry 交出来。缺席（旧宿主/测试桩）时只跳过
   * manifest，投影与协议行为不变。
   */
  recordTurnManifest?(sessionId: string, entry: TurnManifestEntry): void | Promise<void>;
  /**
   * rewind 的分支重写：把 `keptTurnIds` 描述的保留前缀搬到 `branchGeneration` 代次。
   * 缺席时该代次的 manifest 保持缺失，读端降级为全量物化并重建。
   */
  rewriteTurnManifestBranch?(
    sessionId: string,
    input: Omit<TurnManifestBranchRewriteInput, "sessionID">,
  ): void | Promise<void>;
  /**
   * turn 行清单读取（IS5 的唯一读路径实现，宿主负责接 store）。
   *
   * 缺席（旧宿主 / 测试桩）时 gateway 完全不读清单：`openPhases.manifestMs` 缺席
   * （缺席≠0），全序量回退到投影现算——不得把「没实现」当成「空分支」。
   */
  readRowManifest?(
    sessionId: string,
    input: SessionRowManifestReadRequest,
  ): Promise<SessionRowManifestReadOutcome>;
  /**
   * 失效该会话的全序消息索引缓存（`listSessionMessageIndex` 是 O(messages) 读）。
   * gateway 在**任何** live ingest 上调一次：新消息落库 / rewind 截断都走同一条事件流，
   * 这是不会漏的粗粒度失效点。
   */
  invalidateRowManifestIndex?(sessionId: string): void;
  /**
   * 按需物化一页（Step 7 / IS6 的**执行缝**）。
   *
   * 计划由 gateway 用 manifest 的 facts 选出（`selectColdRowPage`），宿主只做三件事：
   * 按 `limitBefore`/`limitAfter` 读**页内整轮**正文 → 用与冷开同一套合成器产出事件 →
   * 交回事件。gateway 再拿临时投影物化这一页（`rowIdOrigin = plan.rowIdBase`）并交
   * publisher 编码。
   *
   * 为什么计划在 gateway、正文在宿主：`publisher.getRowsRange` 是**同步**方法且没有
   * store（构造只有 sessionId/logEpoch/options），异步 + IO 只能落在网关这一层；而
   * 「缺哪几个 turn」是 manifest 事实，不该让宿主另写一份选择规则。
   *
   * 返回 null = 这一页不物化（端口缺席 / 游标与索引不同步 / 页内无消息），调用方退回
   * 「投影现算的那一页 + `hasMore:false`」——宁可上拉到底，不可交出与全量物化不一致的行。
   */
  materializeRowPage?(sessionId: string, plan: ColdRowPagePlan): Promise<ColdRowPageEvents | null>;
  /** 完整 chunk transaction commit 后一次性写 session artifact。 */
  putSessionAttachment?(
    sessionId: string,
    input: { fileName: string; mime: string; bytes: Uint8Array },
  ): Promise<{ ref: string }>;
  /** 已发送 image/video/PDF 只读查询；gateway 完成 row/ref 授权后才允许进入宿主。 */
  readSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      maxBytes: number;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Share 选择阶段的 userInput 附件 metadata stat；gateway 先完成 row/index 授权。 */
  statSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local 已发送视频路径；gateway 完成 row/index 授权后才允许进入宿主。 */
  resolveSessionAttachmentPreviewSource?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<V4AttachmentPreviewSourceResult>;
  getConversationFileChanges?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileChangesResult>;
  previewConversationFileRewind?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /**
   * workflow run 的事件日志分页（详情页审计面）。缺席 = 该会话 runtime 没有这个能力
   * （dwf journal 不可用 → run service 整个没构造），gateway 据此回结构化能力不支持错误。
   *
   * 一页的两道界（条数与字节）在 CLI 侧注入：`limit` 缺省为协议上限、`maxBytes` 恒为协议上限
   * （FORK 偏离上游：上游由本层注入，fork 定在 run-service——host 面改动最小）；
   * `hasMore` 由存储判定，本层只透传（页可能因字节提前收尾，「取满 limit」不是判据）。
   */
  listDynamicWorkflowRunEvents?(
    sessionId: string,
    input: { runId: string; afterSequence?: number; limit?: number },
  ): Promise<DynamicWorkflowRunEventsResult>;
  /**
   * dwf run 的枚举面（重启后的发现查询）。
   * 缺席条件同 {@link listDynamicWorkflowRunEvents}。
   */
  listDynamicWorkflowRuns?(
    sessionId: string,
    input: { limit?: number },
  ): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * workflow run 的**用户面产物**读面。三条一起在场、
   * 一起缺席（app 侧同一个条件注册）。缺席条件同 {@link listDynamicWorkflowRunEvents}。
   *
   * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
   */
  listDynamicWorkflowRunArtifacts?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  listDynamicWorkflowRunArtifactItems?(
    sessionId: string,
    input: { runId: string; artifactId: string; afterSequence?: number; limit: number },
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  readDynamicWorkflowRunArtifact?(
    sessionId: string,
    input: { runId: string; artifactId: string; version: number },
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * workflow run 的工作区 transcript：两条一起在场、
   * 一起缺席。授权在宿主侧（run 属于本会话）；拒绝与未知都回 `undefined`。
   */
  listDynamicWorkflowRunWorkspaceNodes?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(
    sessionId: string,
    input: { runId: string; siteId: string; ordinal: number; maxBytes: number },
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  /**
   * hydration：读取 session 的持久化事件用于冷订阅重建投影（fork child / resume /
   * app-restart）。`synthesized=true` 表示事件日志覆盖不了 transcript，events 是从
   * transcript 反向合成的——此时即便已有 cold publisher（fork resume 的 ingest 抢先
   * 建的）也要**重建**，否则历史不进投影。`synthesized=false`（完整事件日志）则保留
   * 已有 live publisher（流式不能被重建打断）。未实现（旧宿主）冷订阅退化为空投影。
   *
   * 读口径**没有**开关（fix-c19 删掉了「跳过窗口规划」那条读模式）：每次读都按「尾窗
   * 规划 + 本次 record 形态」决定正文范围与 runtime 事实。全量投影不再存在，宿主不必再
   * 支持「把整条分支读回来」。
   */
  loadPersistedEvents?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<PersistedEventsLoadResult>;
  /** 仅用于低频生命周期和恢复裁决；高频 event/stream trace 禁止走生产日志。 */
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: V4GatewayErrorContext): void;
}

interface ConversationV4GatewayOptions {
  now?: () => number;
  /** logEpoch 生成器（默认进程内随机；测试注入固定值保证确定性）。 */
  createLogEpoch?: (sessionId: string) => string;
}

interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

interface RawSequenceState {
  /** 已经由 cold snapshot 或 live replay 消费的 runtime raw cursor。 */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset；遇到 sequence=0 时会向前校正。 */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** publisher 已成功 apply 的 event；runtime sink 已看见但仍在 gap buffer 的不在此集合。 */
  appliedEventIds: Set<string>;
  /** publisher apply 失败事实；临时 sink 迟到注册 waiter 时也必须立即 reject。 */
  failedEventById: Map<string, Error>;
  /** notify sink 可乱序；只有从 sourceEventSeq+1 连续时才可向投影 drain。 */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** synthesized hydration 重建投影时，补回持久读取边界之后已经到达的 raw 事实。 */
  recentRawEventsById: Map<string, SessionEvent>;
}

interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}

/**
 * runtime 水位的一条记录。
 *
 * `promise` 是宿主 resume（= 激活本体）的单飞结果；`activated` 是**成功结论**。
 * 结论必须留在表里（不像视图水位那样 settle 即删）：`conversation/runtimeReady` 的布尔
 * 只能读结论——`host.sessionExists` 在 Step 9 的 view-only shell 上也为真，它证明不了
 * runtime 跑起来了。**失败不驻留**（条目删除，下一次触发可重试），与
 * `ColdSessionResumeCoordinator` 的 settle 即释放保持一致；否则一次瞬时 resume 失败会把
 * 该会话永久钉在「激活过一次，失败」上。
 */
interface RuntimeReadyFlight {
  promise: Promise<MessageWithParts[] | undefined>;
  /** true = 本进程内这次激活已成功；false = 仍在飞。 */
  activated: boolean;
}

/**
 * 命令对 runtime 的依赖分三档（IS3 / Step 8）。
 *
 * - `trigger-activation`：**唯一的激活触发器**。用户此刻就要「跑」，因此允许当场启动
 *   runtime 激活并等它（`sendText` 类）。若这些命令也只拒不发，view-only 会话没有任何
 *   路径能升到 runtime-ready（死锁），所以它们是门的一部分而不是门的受害者。
 * - `require-runtime`：handler 会 `requireRecord`（或经 `host.getRecord` 判 record）。
 *   runtime 未就绪时回 ACK `status:"rejected" + reasonCode:"runtimeNotReady"`——**可重试**，
 *   不能伪装成 `failed`（那是「命令真的坏了」），也不能放行（handler 只会抛 sessionNotFound）。
 * - `record-free`：幂等收口，明示不依赖 record（晚到的交互应答、全局建会话、store 级丢弃）。
 *   今天它们在没有 record 时也能成功，闸门不得拒掉它们。
 */
type CommandRuntimeGate = "trigger-activation" | "require-runtime" | "record-free";

/**
 * send 类命令：starts/branches a turn（或立即拉起一个 run），因此是激活触发器。
 *
 * 清单是**显式**的：新增一个「点了就跑」的命令必须在这里登记，否则它在 view-only 会话上
 * 会被 require-runtime 档拒成 `runtimeNotReady`（安全方向，但用户点不动）。
 */
const ACTIVATION_TRIGGER_COMMANDS: ReadonlySet<CommandEnvelope["type"]> = new Set<
  CommandEnvelope["type"]
>([
  "sendText",
  "sendGoalCommand",
  "resumeGoal",
  "editUserQuery",
  "retryTurn",
  "sendQueuedNow",
  "forkAssistant",
  "createSelectionSideSession",
  "startSavedWorkflow",
  "resumeWorkflowRun",
]);

/**
 * 明示不依赖 record 的命令（handler 侧刻意不做 `requireRecord`，见
 * `handlers/interaction-background.ts` 与 `handlers/session-mgmt.ts` 的注释）：
 * 晚到应答可能发生在会话已收口/删除之后，必须保持幂等成功；`discardSharedContext`
 * 走的是 store 级能力。
 */
const RECORD_FREE_COMMANDS: ReadonlySet<CommandEnvelope["type"]> = new Set<CommandEnvelope["type"]>(
  ["resolveInteraction", "snoozeInteractionAutoResolution", "discardSharedContext"],
);

/**
 * 命令 → runtime 依赖档（IS3 的唯一分类实现）。
 *
 * 只做纯映射，不读任何状态：闸门的判定（能不能放行）在 `handleCommand` 里，测试可以直接
 * 对这张表逐个命令断言——「新增命令忘了归位」会在这里红，而不是在生产里表现成一条
 * 莫名其妙的 sessionNotFound。
 */
export function commandRuntimeGate(type: CommandEnvelope["type"]): CommandRuntimeGate {
  if (ACTIVATION_TRIGGER_COMMANDS.has(type)) return "trigger-activation";
  if (RECORD_FREE_COMMANDS.has(type)) return "record-free";
  return "require-runtime";
}

const PROJECTION_EVENT_COMMIT_TIMEOUT_MS = 25_000;
const MAX_TELEMETRY_EVENT_IDS = 2_000;
/** detached subagent child 终态后无订阅者时，publisher 由低频 tick 释放前的保留时长。 */
const DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000;
/**
 * 「runtime 未就绪」的 ACK 原因码（`CommandAck.reasonCode` 是自由字符串，无需改协议）。
 *
 * 语义 = **可重试**：命令没有被执行、也没有进 inbox 幂等表；客户端在
 * `conversation/runtimeReady` 报 ready 之后用同一个 commandId 重发是安全的。
 */
const RUNTIME_NOT_READY_REASON = "runtimeNotReady";

/**
 * 命令闸门的一次判定结果。
 *
 * `gated` 只说明「要等水位」，不预判能不能放行——require-runtime 档要等完才知道，
 * 判定与等待分开才不会被写成两条口径。
 */
type CommandGateDecision =
  | { kind: "pass" }
  | {
      kind: "gated";
      sessionId: string;
      mode: "trigger-activation" | "await-runtime";
      commandId: string;
    };

class ProjectionEventCommitWaitError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.projectionEventCommit.aborted"
      | "fault.projectionEventCommit.applyFailed"
      | "fault.projectionEventCommit.disposed"
      | "fault.projectionEventCommit.gatewayDisposed"
      | "fault.projectionEventCommit.rehydrated"
      | "fault.projectionEventCommit.timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionEventCommitWaitError";
  }
}

/**
 * server 内部分派结果：initial frame 只供 request-scoped post-response outbox
 * 消费，公共 JSON-RPC result schema 始终严格为 `{ ack }`。
 */
interface V4SubscribeDispatchResult<TFrame> {
  ack: SubscribeAck & {
    openTiming?: ConversationOpenTiming;
    openPhases?: ConversationOpenPhases;
  };
  initialFrame: TFrame | null;
  initialWires: RoutedTopicWireFrame[];
  commit(): boolean;
}

/**
 * 一次 hydration 内三段的耗时（毫秒），供 ACK 的 `openPhases` 回填。
 *
 * 产生点只有 `performHydration`：`mergeMs` = `loadPersistedEvents`（持久事件合并 /
 * transcript 合成），`rehydrateMs` = `publisher.rehydrate`（投影重建），`manifestMs` =
 * row manifest 读路径（step 4 起）。早退分支（保留健康 live publisher）三者都可缺席。
 */
interface HydrationPhases {
  mergeMs?: number;
  rehydrateMs?: number;
  /**
   * row manifest 读路径耗时（IS5 的读端：manifest 两张表 + 消息索引观察）。
   * 产生点只有 `performHydration`，且只在宿主实现 `readRowManifest` 时有值——
   * 旧宿主/测试桩下缺席（**缺席 ≠ 0**）。
   */
  manifestMs?: number;
  /**
   * 本次冷开的清单是否被**账目修正**过（就地改 `row_count`，不重读正文）。
   *
   * 只在「清单可用」时才有值（true/false）；降级重建与没读清单都缺席——缺席不能当成
   * false，那会把「这次没走清单」说成「清单本来就没偏差」。它是 Step 14 判读
   * 「live 与 cold 的行数分布还在不在分叉」的唯一直接证据。
   */
  manifestAdjusted?: boolean;
  /**
   * 本次 hydration 收口时刻（performance.now()）。ACK 组装时用它判断「这几段是不是
   * 刚落在这条 subscribe 的等待窗口内」——热切换/已 hydrate 的会话不会把上一次的耗时
   * 冒充成本次的分段。
   */
  finishedAtMs?: number;
}

/**
 * manifest 读路径的结论摘要（`manifestFallback` 打点 + 测试探针）。
 *
 * `action` 是唯一判定（`decideRowManifestAction`）：`materialize-and-rebuild` =
 * 本次冷开走全量物化并回写整代 manifest。三种降级原因共用它，不各写一条分支。
 */
interface RowManifestOutcomeSummary {
  action: "use-manifest" | "materialize-and-rebuild";
  /** use-manifest 时为 "manifest"；否则是降级原因。 */
  reason: string;
  detail?: Extract<SessionRowManifestReadOutcome, { kind: "fallback" }>["detail"];
  at: number;
}

/**
 * 冷开尾窗的落点（Step 6 的可观测面）。
 *
 * 没有它，「窗口化没生效」与「清单与索引不同步」在现象上完全一样（都退化成全量）。
 * 宿主侧 `coldWindowFallback.reason` 与这里的 `applied` 一起构成三段式读法：
 *   - 宿主给了窗口 + applied:true → 窗口真的物化了；
 *   - 宿主没给窗口（见 `zcode_protocol.v4.cold_window_fallback` 的 reason）→ 没生效，
 *     其中 `limitBeforeMissed` 就是**清单与索引不同步**（清单指向的窗口首条消息不在 active 序）；
 *   - 宿主给了窗口但读清单二次判定降级（`fallbackReason`）→ 本次冷开沿用物化前的事实。
 */
interface ColdWindowOutcomeSummary {
  ordinal: number;
  rowIdBase: number;
  rowCount: number;
  turnCount: number;
  limitBefore: string | null;
  applied: boolean;
  /** 窗口化路径上的清单二次判定降级（永不重建；沿用物化前的事实）。 */
  fallbackReason?: string;
  at: number;
}

/**
 * 宿主交回的「一页事件」（Step 7 执行缝的另一半）。
 *
 * 只有事件：`rowIdOrigin` 由 gateway 从 `plan.rowIdBase` 播种（一份事实只有一个来源），
 * 宿主不持有投影。
 */
interface ColdRowPageEvents {
  events: SessionEvent[];
  /** 页内正文消息条数（诊断：与 plan 的轮数/行数一起判「读少了」）。 */
  messageCount: number;
  /** 合成器的模型基线是否取到；false = 页首轮会多发一条 ModelSync 事件（见下）。 */
  initialModelKeyResolved: boolean;
  /**
   * 页的**上一轮模型基线**（页前一轮首条消息的选型）。
   *
   * 临时投影必须用它播种 `seedTurnModelBaseline`：否则页首轮恰好是模型切换轮时，
   * `modelChange` marker 行不会生成，页内行数比 manifest 少 1、rowId 整体前移。
   */
  modelBaseline?: TurnModelBaselineSeed;
}

/**
 * 最近一次按需物化一页的落点（Step 7 的可观测面）。
 *
 * 与 `ColdWindowOutcomeSummary` 同一读法：`applied:false` 必须带 `reason`，否则「翻页没
 * 物化」与「翻页本来就没有更早行」在现象上完全一样。
 */
interface RowPageOutcomeSummary {
  applied: boolean;
  /** applied:false 的原因（选不出页 / 宿主拒绝 / 一致性守卫拦下）。 */
  reason?: string;
  beforeRowId: number;
  limit: number;
  /** 实际参与规划的轮数/行数（applied 时有值）。 */
  turnCount?: number;
  rowCount?: number;
  /** 规划的首轮 ordinal 与 base（排查 rowId 平移用）。 */
  ordinal?: number;
  rowIdBase?: number;
  /** 本次物化最终写进这一页的行数（0 = 守卫拦下）。 */
  pageRows?: number;
  /** 宿主读正文 + 合成的耗时（毫秒）。`openPhases.materializeMs` 刻意不填它，见注释。 */
  materializeMs?: number;
  at: number;
}

function encodeReservedTopicFrame(
  reservation: TopicFrameReservation<RoutedTopicFrame>,
): RoutedTopicWireFrame[] {
  return encodeTopicWireFrames(reservation.frame, {
    deliveryKind: reservation.deliveryKind,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    logicalFrameId: reservation.logicalFrameId,
    logicalFrameOrdinal: reservation.logicalFrameOrdinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }) as RoutedTopicWireFrame[];
}

function subscriptionRouteKey(topic: string, subscriptionId: string, connectionId: string): string {
  return `${topic}\0${subscriptionId}\0${connectionId}`;
}

function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`zcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/**
 * 附件是否允许走预览读取（attachmentRead / attachmentPreviewSource 的授权闸）。
 *
 * 根因：原判定只放行图片、视频和 PDF，长粘贴落盘的文本附件即使归属当前行也被拒绝；
 * 文本只对「材料标记」（sourceKind）开放，后续仍须通过权威行、附件索引与 ref 归属校验。
 * FORK：本仓没有 topic-history 生产端（见 shared/src/attachment-source.ts），故只取
 * clipboard-text 一支；上游还放行 topic-history（.reference :2211-2222）。
 *
 * 抽为模块级纯谓词是为了可测：测试脚本直接驱动该判定，不再依赖网关实例。
 */
export function isReadablePreviewAttachment(
  attachment: Pick<AttachmentRef, "mime" | "sourceKind">,
): boolean {
  const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf" ||
    (mime === "text/plain" && attachment.sourceKind === "clipboard-text")
  );
}

/**
 * 读取回执的媒体类型闸（attachmentPreviewSource / attachmentRead 的第二道闸）。
 *
 * 根因：授权闸已按 sourceKind 放行文本材料，结果闸仍只认媒体类型，使 text/plain
 * 附件在读取回执处被 previewNotMedia 拦下。这里只做**对等豁免**：请求 mime 与结果
 * mime 都是 text/plain 才放行，不允许靠结果类型升级授权（请求 image/* 拿到文本仍拒）。
 *
 * allowGeneric（share 读取）由调用方先行短路，不进入本判定。
 */
export function isReadablePreviewResultMediaType(
  requestMime: string,
  resultMediaType: string,
): boolean {
  const resultMime = resultMediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    resultMime.startsWith("image/") ||
    resultMime.startsWith("video/") ||
    resultMime === "application/pdf" ||
    (resultMime === "text/plain" &&
      requestMime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain")
  );
}

/** 附件在文件系统层「确定不存在」的错误码集合。 */
const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * 把 host / FileSystemPort 抛出的错误归一成带稳定码的附件 fault。
 * host 已经给出结构化 fault 码时原样透传，其余按 FileSystemPortError.code 判定；
 * 都不匹配则保持原错误，让上层按「未知」处理，而不是猜成确定分类。
 */
function toShareStatFault(error: unknown): unknown {
  if (readZCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}

export class ConversationV4Gateway {
  private readonly publishers = new Map<string, ConversationTopicPublisher>();
  /** sessions-index：workspaceId → 列表 publisher（与 conversation 并列，独立 seq/logEpoch）。 */
  private readonly indexPublishers = new SessionsIndexPublisherRegistry();
  /** workspace-config：workspaceId → 配置目录 publisher（conflated 整体替换态）。 */
  private readonly configPublishers = new Map<string, WorkspaceConfigPublisher>();
  /** 已完成首次 hydration 的 session（避免重复重建 / 双计，见 hydratePublisher）。 */
  private readonly hydratedSessions = new Set<string>();
  /** 首次 hydration 按 session 单飞；并发 pane 共享同一份重建结果。 */
  private readonly hydrationInFlight = new Map<string, Promise<ConversationTopicPublisher>>();
  /**
   * **视图水位**（读与翻页只等这一层）：冷会话「把投影建起来」的单飞。
   *
   * IS3 把「看」与「跑」拆成两条水位，这里是「看」的那条：`rowsRange` / `turnDirectory` /
   * `plans` / 附件预览等只读入口归它；它们绝不等待 runtime 激活。Step 9 起它只物化
   * view-only 外壳（store-only 读正文），激活本体归 `runtimeReadyFlights`。
   * 语义仍是「本次冷恢复收口」，不能拿它当「runtime 已就绪」。
   */
  private readonly viewReadyFlights = new Map<string, Promise<ConversationTopicPublisher>>();
  /**
   * **runtime 水位**（send 类命令与所有 `requireRecord` 路径只等这一层）：runtime 激活的单飞。
   *
   * 与 `coldResume` 内部单飞是**同一件事的两个视角**：那边只负责「别恢复两次」，这边还要
   * 记住 settle 结论——`conversation/runtimeReady` 的布尔必须读结论而不能读 record
   * （record 只证明「宿主注册表里有它」，Step 9 的 view-only shell 也会创建 record）。
   * 因此条目**settle 后不删**，只在 cleanup / dispose 清理；reject 也留着（并发加入者看到同一
   * 个错误，重试语义由调用方决定）。
   */
  private readonly runtimeReadyFlights = new Map<string, RuntimeReadyFlight>();
  /**
   * 「runtime 已就绪」的**激活结论**集合（IS3 / Step 9）。
   *
   * 写入点只有两个：①本进程一次成功的 `coldResume.ensureResumed`（激活本体）；
   * ②宿主报告 runtime 正在跑（热会话 / 新建会话 / 别处 resume 过的会话）时回填。
   * 读取点只有 `isRuntimeReady`。
   *
   * **不得**用「record 在册」代替它（Step 9 的退化形态）：`materializeSessionShell` 也建
   * record，那个短路会让 view-only 会话误报 `runtimeReady:true`——`conversation/runtimeReady`
   * 说谎只是症状，真正的代价是 send 类命令不再去激活、直接撞上一个没起 runtime 的 record。
   */
  private readonly runtimeReadySessions = new Set<string>();
  /**
   * 视图已就绪的会话（IS4 的 viewOnly 半边）。
   *
   * `live` / `notLive` 用同步的 `conversationState` 判；`viewOnly` 与 `absent` 的差别只在
   * 「有没有一次成功的视图水化」，而那只可能是一次异步 store 读的产物，同步函数判不出来。
   * 只由 hydration 成功收口写入，cleanup / dispose 清除。
   */
  private readonly viewReadySessions = new Set<string>();
  /**
   * 「首屏欠一次 **runtime 派生量**补种」的会话（fix-c19）。
   *
   * 判据只有 `viewOnlyHydration === true`（record 还是 shell / 压根没有 record）：这时
   * usage 与 config 种子（`thoughtLevels` / `planEnabled` / `permissionGrant`）**刻意缺席**
   * ——它们只能从 runtime 读，而 runtime 还没起。激活成功后从宿主端口窄读一次补种即可。
   *
   * **不再升级成全量投影**：行集合由 manifest 给，窗口以上的页由 `rows/range` 按需物化
   * （1.7~6.7ms/页），把 5k 行灌进 live 投影只买到 398MB 堆和 5 倍切回成本（风险 24）。
   * 窗口化首屏就是终态。
   */
  private readonly runtimeFactsPending = new Set<string>();
  /** load await 窗口内的 raw accepted events；重建后按 cursor/eventId 补回。 */
  private readonly hydrationBuffers = new Map<string, HydrationBuffer>();
  /**
   * 最近一次 hydration 的分段耗时（见 `openPhases`）。ACK 组装时读取；
   * 只做观测，不参与任何判定。
   */
  private readonly lastHydrationPhases = new Map<string, HydrationPhases>();
  /**
   * 最近一次 manifest 读路径的结论（观测 + 测试探针）。
   *
   * 这里是 `manifestFallback` 打点的唯一落点：`missing` / `schemaMismatch` /
   * `inconsistent` 三种状态**同样**记成 `fallback`（spec Step 3 交给 Step 4 钉住的约束），
   * 区分只体现在 `reason` / `detail` 上，动作完全一致（全量物化 + 重建 manifest）。
   */
  private readonly rowManifestOutcomes = new Map<string, RowManifestOutcomeSummary>();
  /** 冷开尾窗的落点（Step 6）：一次冷开一条，`applied` 与降级原因一起进诊断。 */
  private readonly coldWindowOutcomes = new Map<string, ColdWindowOutcomeSummary>();
  /**
   * 最近一次按需物化一页的落点（Step 7）。只留最后一条：翻页是逐页串行的，
   * 明细进 debug 日志，这里只给测试/诊断读「上一页到底物化了没有、因为什么没物化」。
   */
  private readonly rowPageOutcomes = new Map<string, RowPageOutcomeSummary>();
  /**
   * 本进程内观测到的 runtime 激活耗时（毫秒）。
   *
   * 生产点今天只有冷订阅的 `coldResume.ensureResumed`（phases 拆开之前，激活与建投影是
   * 串行的一段）；phase-view-runtime-split 拆出 `runtimeReadyFlights` 后改由 ACK 后的后台
   * 预激活写入，`conversation/runtimeReady` 的读数口径不变。
   * 只做观测：不参与任何判定，缺席 = 本进程没观测到激活。
   */
  private readonly runtimeActivationMs = new Map<string, number>();
  /** transcript 合成序列与 runtime raw 序列之间的 per-session 单调映射。 */
  private readonly rawSequenceStates = new Map<string, RawSequenceState>();
  /** connection-independent；command admission 与 transport subscription 生命周期解耦。 */
  private readonly projectionEventCommitWaiters = new Map<
    string,
    Map<string, Set<ProjectionEventCommitWaiter>>
  >();
  /** 没有独立 bootstrap record、但由父 runtime 持续转发 raw events 的 live child。 */
  private readonly detachedLiveSessions = new Set<string>();
  /**
   * detached subagent child 的父 record 归属与终态时间。child 没有自己的 record，publisher 只能随父 record 释放，
   * 或在 turn 结束且无订阅者、超过 grace 后由低频 tick 释放；否则会驻留到进程退出。
   */
  private readonly detachedChildParent = new Map<string, string>();
  private readonly detachedChildrenByParent = new Map<string, Set<string>>();
  private readonly detachedTerminalAt = new Map<string, number>();
  /** 冷恢复协调器（既有 activation 单飞 + 错误分型）。 */
  private readonly coldResume: ColdSessionResumeCoordinator;
  /** 订阅 → flush 调度状态（publisher 内部不持有定时器，调度归网关）。 */
  private readonly flushStates = new Map<string, FlushState>();
  /** ACK/outbox 尚未 admission 的 control reservation 禁止被 online flush 抢先发送。 */
  private readonly controlReservations = new WeakSet<object>();
  /** transport high-water pause 只按 trusted connectionId 隔离，不改变 ingest/publisher 真值。 */
  private readonly pausedConnections = new Set<string>();
  /** 一个越界周期只触发一次 runtime stop；终态事件到达后解除。 */
  private readonly projectionFaultedSessions = new Set<string>();
  private readonly inbox: CommandInbox;
  private readonly attachmentUploads: AttachmentUploadRegistry;
  private readonly binaryReadCache = new Map<string, BinaryReadCacheEntry>();
  private binaryReadCacheBytes = 0;
  /** 高频进度事件的 index fan-out 节流（14-sessions-index「事件 fan-out 节奏」）。 */
  private readonly indexFanoutThrottle = new SessionsIndexFanoutThrottle({
    publish: (sessionId) => this.publishCurrentSummaryToIndex(sessionId),
  });
  private readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly createLogEpoch: (sessionId: string) => string;
  private readonly telemetryNormalizer = new ConversationTelemetryFactNormalizer();
  private readonly cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();
  private readonly telemetryEventIds = new Set<string>();
  private disposed = false;

  /** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void {
    const publisher = this.publishers.get(sessionId);
    if (!publisher) return;
    publisher.seedSharedContextImport(source);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
    }
  }

  /**
   * magic-context 预算摘要（D-13）side state 入口。
   *
   * 与 {@link updateSharedContextImport} 的差别：这条**产 delta**（面板要实时看到
   * 预算随轮次变化），因此走 publisher 的扇出；`null` = 读不到了，投影层删掉该键。
   * publisher 缺席（会话还没建立 topic）时静默丢弃——下一轮 pass 会再推一次。
   */
  updateMagicContextUsage(sessionId: string, usage: SessionMagicContextUsage | null): void {
    const publisher = this.publishers.get(sessionId);
    if (!publisher) return;
    publisher.publishMagicContextUsage(usage);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
    }
  }

  constructor(
    private readonly host: V4GatewayHost,
    options: ConversationV4GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
    this.coldResume = new ColdSessionResumeCoordinator(host);
    this.inbox = new CommandInbox({
      getRevision: (sessionId) => {
        // 问的是「这条会话算不算存在」而不是「runtime 活没活」（IS4）：view-only 会话有投影
        // 但没激活 runtime，按 live 判会把它当不存在，admission 直接回 sessionNotFound。
        if (this.conversationViewState(sessionId) === "absent") return null;
        // 已知会话但尚无事件 → 投影未建，revision 视为 0（draft 起点）。
        return this.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => this.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = this.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      lookupTranscriptCommand: (key) => this.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => this.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => this.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => this.host.lookupDiscardedCommand?.(key) ?? null,
      now: this.now,
    });
    this.attachmentUploads = new AttachmentUploadRegistry({
      now: this.now,
      putSessionAttachment: async (sessionId, input) => {
        if (!this.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return this.host.putSessionAttachment(sessionId, input);
      },
    });
    this.attachmentPruneTimer = setInterval(
      () => this.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    );
    (
      this.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
  }

  setConnectionFlowState(rawParams: unknown): void {
    const params = v4ConnectionFlowParamsSchema.parse(rawParams);
    if (params.state === "closed") {
      this.pausedConnections.delete(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      this.attachmentUploads.clearConnection(params.connectionId);
      return;
    }
    if (params.state === "saturated") {
      if (this.pausedConnections.has(params.connectionId)) return;
      this.pausedConnections.add(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      return;
    }
    if (!this.pausedConnections.delete(params.connectionId)) return;
    this.flushConnection(params.connectionId);
  }

  private clearConnectionFlushTimers(connectionId: string): void {
    for (const state of this.flushStates.values()) {
      if (state.connectionId !== connectionId || state.timer === null) continue;
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private flushConnection(connectionId: string): void {
    for (const [routeKey, state] of this.flushStates) {
      if (state.connectionId !== connectionId) continue;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      const publisher = this.publishers.get(state.sessionId);
      if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
        this.flushStates.delete(routeKey);
        continue;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }
    for (const workspaceId of this.indexPublishers.keys()) {
      this.flushIndex(workspaceId, connectionId);
    }
    for (const workspaceId of this.configPublishers.keys()) {
      this.flushConfig(workspaceId, connectionId);
    }
  }

  /** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */
  ingest(sessionId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) {
      const eventId = String(event.id);
      if (hydrationBuffer.eventIds.has(eventId)) return;
      // 先记 raw fact；它可能因前序尚未到而暂时不进 publisher。
      hydrationBuffer.eventIds.add(eventId);
      hydrationBuffer.rawEvents.push(event);
    }
    this.emitLiveTelemetryFact(sessionId, event);
    for (const normalizedEvent of this.normalizeRuntimeEventSequence(sessionId, event)) {
      this.ingestNormalizedEvent(sessionId, normalizedEvent);
    }
  }

  private emitLiveTelemetryFact(sessionId: string, event: SessionEvent): void {
    const eventId = String(event.id);
    // 主 session 与 detached child 各自维护事件序列，eventId 不能假设跨
    // session 全局唯一。旧去重只用 eventId，会把 child 的同号事件误判成主会话重放，
    // 导致前台 Subagent 的真实轮次事实被静默丢弃。
    const telemetryEventKey = `${sessionId}\0${eventId}`;
    if (this.telemetryEventIds.has(telemetryEventKey)) return;
    this.telemetryEventIds.add(telemetryEventKey);
    if (this.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
      const oldest = this.telemetryEventIds.values().next().value;
      if (typeof oldest === "string") this.telemetryEventIds.delete(oldest);
    }
    try {
      const fact = this.telemetryNormalizer.normalize(sessionId, event);
      if (fact) {
        this.host.emitConversationTelemetryFact?.(fact);
      }
    } catch (error) {
      // 轮次事实绝不能反向阻断 conversation 投影；严格 schema 失败只记录诊断。
      this.host.onError?.("v4.telemetry.normalize", error);
    }
    try {
      const observation = this.cuaPermissionNormalizer.normalize(sessionId, event);
      if (observation) this.host.emitCuaPermissionObservation?.(observation);
    } catch (error) {
      // 权限观察只是 live UI 提示，schema 或投影异常不能阻断 conversation 主链路。
      this.host.onError?.("v4.cuaPermissionObservation.normalize", error);
    }
  }

  /** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway is disposed",
        ),
      );
    }
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.appliedEventIds.has(eventId)) return Promise.resolve();
    const failed = state.failedEventById.get(eventId);
    if (failed) return Promise.reject(failed);
    if (options.signal?.aborted) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal.reason },
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const byEvent = this.projectionEventCommitWaiters.get(sessionId) ?? new Map();
      this.projectionEventCommitWaiters.set(sessionId, byEvent);
      const waiters = byEvent.get(eventId) ?? new Set();
      byEvent.set(eventId, waiters);
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) byEvent.delete(eventId);
        if (byEvent.size === 0) this.projectionEventCommitWaiters.delete(sessionId);
      };
      const waiter: ProjectionEventCommitWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        // 只 reject 当前 waiter 会让 raw gap 中的 TurnStarted 继续存活；
        // command 已 cancelled 后补齐 gap，迟到事件仍会进入 canonical projection。
        // event failure 必须固化到 sequence state，后续 drain 只推进 cursor、不再 apply。
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.aborted",
            `projection event commit wait aborted: ${eventId}`,
            { cause: options.signal?.reason },
          ),
        );
      };
      const timeout = setTimeout(() => {
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.timeout",
            `projection event commit wait timed out: ${eventId}`,
          ),
        );
      }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
      timeout.unref?.();
      waiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */
  async waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void> {
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.failedEventById.has(eventId)) {
      const event = state.recentRawEventsById.get(eventId);
      if (
        event?.type !== SessionEventType.SessionModeChanged ||
        !(event.payload as { permissionGrant?: unknown }).permissionGrant
      ) {
        throw new Error("Permission grant event unavailable for recovery");
      }
      await this.hydrationInFlight.get(sessionId);
      this.hydratedSessions.delete(sessionId);
      await this.hydratePublisher(sessionId, undefined, true);
    }
    await this.waitForProjectionEventCommit(sessionId, eventId);
  }

  private ingestNormalizedEvent(sessionId: string, event: SessionEvent): void {
    const publisher = this.ensurePublisher(sessionId);
    // 全序消息索引是 O(messages) 读且按会话缓存（Step 5/7 的翻页要反复用同一份 id 序）。
    // 任何 live 事件都可能是「新消息落库 / rewind 截断」的载体：这里无条件失效一次，
    // 粗粒度但**不会漏**——按事件类型白名单的失效点迟早会漏掉一个新事件类型。
    this.host.invalidateRowManifestIndex?.(sessionId);
    // rewind 的 manifest 重写必须知道**截断前**的代次与 turn 顺序：投影内部一旦截断，
    // 旧代次就只剩「还在的新行」，拿不到该复制什么。
    const manifestBranchBefore =
      event.type === SessionEventType.RewindTriggered
        ? publisher.getTurnManifestBranchState()
        : null;
    const promotedQueueRemoval =
      event.type === SessionEventType.TurnSteerDiscarded &&
      (event.payload as { reason?: string }).reason === "promoted";
    const removedQueueItems =
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded
        ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
            (queueItemId) => {
              const item = publisher
                .getSnapshot()
                .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
              return item ? [item] : [];
            },
          )
        : [];
    try {
      publisher.ingest(event);
    } catch (error) {
      const commitError =
        error instanceof ProjectionEventCommitWaitError
          ? error
          : new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply event ${String(event.id)}`,
              { cause: error },
            );
      this.rejectProjectionEventCommit(sessionId, String(event.id), commitError);
      if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
      this.host.onError?.("v4.projection.payloadTooLarge", error);
      if (!this.projectionFaultedSessions.has(sessionId)) {
        this.projectionFaultedSessions.add(sessionId);
        void Promise.resolve(
          this.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
        ).catch((terminateError) => {
          this.host.onError?.("v4.projection.terminate", terminateError);
        });
      }
      return;
    }
    this.resolveProjectionEventCommit(sessionId, String(event.id));
    this.recordTurnManifestForEvent(sessionId, event, publisher);
    if (manifestBranchBefore !== null) {
      this.rewriteTurnManifestBranchForRewind(sessionId, publisher, manifestBranchBefore);
    }
    if (
      event.type === SessionEventType.TargetChanged &&
      (event.payload as TargetChangedPayload).target?.status === "complete"
    ) {
      try {
        this.host.onTargetCompleted?.(sessionId, event);
      } catch (error) {
        this.host.onError?.("v4.projection.targetCompleted", error);
      }
    }
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.projectionFaultedSessions.delete(sessionId);
    }
    if (event.type === SessionEventType.TurnSteerQueued) {
      const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
      const item = queueItemId
        ? publisher
            .getSnapshot()
            .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
        : undefined;
      if (item) this.inbox.pinLiveInput(sessionId, item);
    }
    if (!promotedQueueRemoval) {
      if (removedQueueItems.length > 0) {
        // delete/clear 已先把 durable session_input 写成 cancelled，但本 session
        // 的 persistent command index 可能缓存过旧空结果。必须先失效再解除 live pin，
        // 否则 LRU 淘汰后同 commandId 查询仍可能 unknown 并被重复执行。
        this.host.invalidatePersistentCommandFacts?.(sessionId);
      }
      for (const item of removedQueueItems) {
        this.inbox.releaseLiveInput({
          sessionId,
          commandId: item.sourceCommandId,
        });
      }
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
      if (sourceCommandId) {
        // persistent index 可能早于本条 user message 被 query 过；先失效再解 pin，
        // 后续 LRU 淘汰回源时才能重读刚提交的 transcript，而不是命中旧空 seed。
        this.host.invalidatePersistentCommandFacts?.(sessionId);
        this.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
      }
    }
    // assistant 守恒：投影拒收了正文流（订阅中途建 publisher、错过
    // TurnStarted 的典型形态）→ 撤销 hydrated 标记，下次订阅强制从持久事实重新
    // hydration 补齐缺段——静默丢会让内容缺失直到用户手动刷新才恢复。
    if (publisher.getDroppedContentStreamEventCount() > 0 && this.hydratedSessions.has(sessionId)) {
      this.hydratedSessions.delete(sessionId);
      this.host.onError?.(
        "v4.assistantConservation",
        new Error(
          `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
        ),
      );
    }
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      this.scheduleFlush(routeKey, state, publisher);
    }
    // sessions-index fan-out（防御式：任何异常都不能打断 conversation 主路径）。
    this.fanOutToIndex(sessionId, event);
  }

  /**
   * turn 终态的行清单写入（`onTurnComplete` 与 `onTurnError` 两个终态点都到这里，
   * 因为投影对两者都走同一份「行已定稿」状态）。
   *
   * 挂在**投影已成功吃下事件之后**：manifest 记的是投影物化出来的行数，投影没吃下的
   * 事件写进去就是凭空捏造一条全序事实。写入是 detached 的（不阻塞 ingest），
   * 失败只打点——manifest 缺失的后果是下次冷开降级全量物化，不是数据错误。
   */
  private recordTurnManifestForEvent(
    sessionId: string,
    event: SessionEvent,
    publisher: ConversationTopicPublisher,
  ): void {
    if (event.type !== SessionEventType.TurnComplete && event.type !== SessionEventType.TurnError) {
      return;
    }
    const record = this.host.recordTurnManifest;
    if (!record) return;
    const entry = publisher.getTurnManifestEntry(event);
    if (!entry) return;
    try {
      void Promise.resolve(record(sessionId, entry)).catch((error: unknown) => {
        this.host.onError?.("v4.turnManifest.record", error, {
          phase: "record",
          sessionId,
          turnId: entry.turn.turnId,
        });
      });
    } catch (error) {
      this.host.onError?.("v4.turnManifest.record", error, { phase: "record", sessionId });
    }
  }

  /**
   * rewind 的分支重写：把保留前缀搬到新代次（同代次则原地过滤）。
   *
   * 只在「代次变了」或「turn 集合变了」时写：workspace `file_summary_rewind` 只改
   * header 的 fileChanges 状态、不截行，不该触发一次 O(turns) 的 manifest 重写。
   */
  private rewriteTurnManifestBranchForRewind(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    before: { branchGeneration: number; turnIds: string[] },
  ): void {
    const rewrite = this.host.rewriteTurnManifestBranch;
    if (!rewrite) return;
    const after = publisher.getTurnManifestBranchState();
    const changed =
      after.branchGeneration !== before.branchGeneration ||
      after.turnIds.length !== before.turnIds.length ||
      after.turnIds.some((turnId, index) => turnId !== before.turnIds[index]);
    if (!changed) return;
    try {
      void Promise.resolve(
        rewrite(sessionId, {
          branchGeneration: after.branchGeneration,
          sourceGeneration: before.branchGeneration,
          keptTurnIds: after.turnIds,
        }),
      ).catch((error: unknown) => {
        this.host.onError?.("v4.turnManifest.rewind", error, { phase: "rewind", sessionId });
      });
    } catch (error) {
      this.host.onError?.("v4.turnManifest.rewind", error, { phase: "rewind", sessionId });
    }
  }

  /**
   * 冷开读路径（IS5）：读 manifest → 判定可用性 → 注入 publisher 或回写重建。
   *
   * 顺序钉死为「全量物化之后」：`observedRowCounts` 与 `observedTurnIds` 都来自投影行，
   * 读之前物化就不存在「账目修正」与「未登记 turn」这两个观察。
   *
   * 三条降级（missing / schemaMismatch / inconsistent）走 `decideRowManifestAction` 的同一
   * 分支：全量物化已经是既成事实（本阶段冷开就是全量），差别只在**回写重建 manifest**。
   * 这是 `manifestFallback` 的唯一打点处；Step 5 的窗口化物化会在这里改成
   * `fullyMaterialized: false` 并接按需物化。
   */
  private async hydrateRowManifest(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    phases: HydrationPhases,
    coldWindow?: ColdTailWindowPlan,
  ): Promise<void> {
    const read = this.host.readRowManifest;
    if (!read) return;
    const startedAt = performance.now();
    const branch = publisher.getTurnManifestBranchState();
    try {
      const outcome = await read(sessionId, {
        branchGeneration: branch.branchGeneration,
        expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
        observedTurnIds: branch.turnIds,
        observedRowCounts: publisher.getTurnRowCounts(),
        // 窗口化物化：投影只覆盖 active 分支的后缀，**反向** turn 集合校验必须关掉
        // （「manifest 比窗口长」是合法状态），否则每一页都会被判成 inconsistent。
        fullyMaterialized: coldWindow === undefined,
      });
      const action = decideRowManifestAction(outcome);
      if (outcome.kind === "manifest") {
        publisher.seedRowManifestFacts(outcome.facts);
        this.rowManifestOutcomes.set(sessionId, {
          action,
          reason: "manifest",
          at: Date.now(),
        });
        // 「清单可用」的两种结局都要可见：修正过 = true，没修正 = false。
        // 降级重建 / 没读清单时这个键缺席（缺席 ≠ 没偏差）。
        phases.manifestAdjusted = outcome.manifestAdjusted;
        if (outcome.manifestAdjusted) {
          // 账目修正：冷物化出的行数与 live 写入的 row_count 不同，只改计数不重读正文。
          // 必须打点，否则「清单被悄悄改过」会被读成「manifest 从来没生效」。
          this.host.onDebug?.(
            `v4 row manifest adjusted session=${sessionId} turns=${outcome.adjustedTurnIds.length}`,
          );
        }
        if (!outcome.messageIndexChecked) {
          this.host.onDebug?.(`v4 row manifest message index unavailable session=${sessionId}`);
        }
        return;
      }
      this.rowManifestOutcomes.set(sessionId, {
        action,
        reason: outcome.reason,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        at: Date.now(),
      });
      this.host.onDebug?.(
        `v4 row manifest fallback session=${sessionId} reason=${outcome.reason} ` +
          `turns=${branch.turnIds.length}`,
      );
      if (coldWindow !== undefined) {
        // **窗口化路径永不重建**：投影只有尾部若干轮，拿它回写会把头部真实轮次的行数写成
        // 0（ordinalBase + 剪枝只能「保留已知的」，不能「补出没物化的」）。
        // 清单在物化前已通过 `decideRowManifestAction` 判为可用，这里的不一致只可能来自
        // 两读之间发生的 live 写入 / 冷热 turn 身份分歧——本次冷开沿用物化前读到的事实
        // （它们才是与这批 events 同一时刻的快照），下一次冷开会重新判定。
        publisher.seedRowManifestFacts(coldWindow.facts);
        const previous = this.coldWindowOutcomes.get(sessionId);
        if (previous) {
          this.coldWindowOutcomes.set(sessionId, {
            ...previous,
            fallbackReason: outcome.reason,
            at: Date.now(),
          });
        }
        this.host.onDebug?.(
          `v4 row manifest windowed fallback session=${sessionId} reason=${outcome.reason} ` +
            `ordinal=${coldWindow.ordinal}`,
        );
        return;
      }
      // missing = 该代次本来就没有行，没有可剪的尾部；schemaMismatch / inconsistent 的残留
      // 行必须剪掉，否则读端会一直看到「清单比投影长」而反复降级。
      this.rebuildRowManifestFromProjection(sessionId, publisher, {
        prune: outcome.reason !== "missing",
      });
    } catch (error) {
      // 读路径自身已把 store 异常收敛成 fallback/readFailed；到这里只剩宿主实现抛错。
      // 不吞：记一笔并按「没有清单」处理，冷开不能因为清单读失败整体失败。
      this.rowManifestOutcomes.set(sessionId, {
        action: "materialize-and-rebuild",
        reason: "readFailed",
        at: Date.now(),
      });
      this.host.onError?.("v4.rowManifest.read", error, { phase: "read", sessionId });
      if (coldWindow !== undefined) {
        publisher.seedRowManifestFacts(coldWindow.facts);
        return;
      }
      // 读失败时 store 状态未知，不做剪枝（剪枝是一次删除，宁可少做）。
      this.rebuildRowManifestFromProjection(sessionId, publisher);
    } finally {
      phases.manifestMs = Math.max(0, Math.round(performance.now() - startedAt));
    }
  }

  /**
   * 降级后的整代回写：把全量物化出的每一轮写成 `row_count_source = 'cold'`，再剪掉投影里
   * 已不存在的尾部 ordinal。
   *
   * 为什么要剪：`upsertTurnManifest` 只保证「本 turn 覆盖写」，manifest 里比投影更长的
   * 尾部（rewind 未被记录 / schema 旧残留）不会被它删掉，读端下一轮仍会看到
   * `unobservedTurnIds` → 再降级 → 死循环。剪枝走 `rewriteTurnManifestBranch` 的同代次
   * 原地过滤（`sourceGeneration === branchGeneration`），它正是「按给定 keptTurnIds 重排
   * ordinal 并删掉其余」的唯一实现。
   *
   * `ordinalBase` 是这条路径唯一的危险参数：仓储的 `insertTurnRow` 会把「同一 ordinal 上的
   * 另一个 turn」当成被 rewind 截掉的残留逐出。全量物化从 0 起；**窗口化物化必须从
   * manifest 已有的 turn 数起**（Step 6 的 `coldWindow.ordinal`），并且届时的
   * `keptTurnIds` 必须是**整条分支**（`coldWindow.branchTurnIds`，manifest 的 turn 序），
   * 否则剪枝会把没物化的头部真实轮次删掉。
   *
   * 现状是窗口化路径**不重建**（投影只有尾部，回写会把头部轮次的行数写成 0），所以这两条
   * 参数只在「将来放开窗口化重建」时才用得上：`keptTurnIds` 缺省取投影的整条分支序，
   * 那只在全量物化时才是「整条」。
   *
   * 写入链是 detached 的：失败只打点——清单缺失的后果是下次冷开再降级一次，不是数据错误。
   */
  private rebuildRowManifestFromProjection(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    options: {
      ordinalBase?: number;
      prune?: boolean;
      /** 剪枝保留的 turn 序：全量物化 = 投影 active 序；窗口化必须传 manifest 整条分支。 */
      keptTurnIds?: readonly string[];
    } = {},
  ): void {
    const record = this.host.recordTurnManifest;
    if (!record) return;
    const branch = publisher.getTurnManifestBranchState();
    const entries = publisher.getTurnManifestEntriesForBranch({
      rowCountSource: "cold",
      ...(options.ordinalBase === undefined ? {} : { ordinalBase: options.ordinalBase }),
    });
    if (entries.length === 0) return;
    const writes = entries.map((entry) =>
      Promise.resolve()
        .then(() => record(sessionId, entry))
        .catch((error: unknown) => {
          this.host.onError?.("v4.turnManifest.record", error, {
            phase: "rebuild",
            sessionId,
            turnId: entry.turn.turnId,
          });
        }),
    );
    const rewrite = this.host.rewriteTurnManifestBranch;
    if (options.prune !== true || !rewrite) {
      void Promise.all(writes);
      return;
    }
    void Promise.all(writes).then(() =>
      Promise.resolve(
        rewrite(sessionId, {
          branchGeneration: branch.branchGeneration,
          sourceGeneration: branch.branchGeneration,
          keptTurnIds: options.keptTurnIds ?? branch.turnIds,
        }),
      ).catch((error: unknown) => {
        this.host.onError?.("v4.turnManifest.rewind", error, { phase: "rebuild-prune", sessionId });
      }),
    );
  }

  /**
   * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
   * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
   */
  ingestDetachedLiveSession(
    sessionId: string,
    event: SessionEvent,
    parentSessionId?: string,
  ): void {
    if (!this.detachedLiveSessions.has(sessionId)) {
      this.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
    }
    this.detachedLiveSessions.add(sessionId);
    if (parentSessionId && parentSessionId !== sessionId) {
      this.detachedChildParent.set(sessionId, parentSessionId);
      let children = this.detachedChildrenByParent.get(parentSessionId);
      if (!children) {
        children = new Set();
        this.detachedChildrenByParent.set(parentSessionId, children);
      }
      children.add(sessionId);
    }
    // child 是一次性 session，没有 record 也没有后继 turn，publisher 曾驻留到进程退出。
    // 记下终态时间，供 pruneDetachedChildPublishers 在 grace 后释放；child 再次开 turn 则撤销。
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.detachedTerminalAt.set(sessionId, Date.now());
    } else if (event.type === SessionEventType.TurnStarted) {
      this.detachedTerminalAt.delete(sessionId);
    }
    this.ingest(sessionId, event);
  }

  /**
   * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
   * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
   */
  pruneDetachedChildPublishers(
    nowMs: number = Date.now(),
    graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
  ): number {
    let released = 0;
    for (const [childId, terminalAt] of [...this.detachedTerminalAt]) {
      if (nowMs - terminalAt < graceMs) continue;
      // 只问「child 自己有没有 record」（有 record 的会话由常规生命周期管），不是 live 判定。
      if (this.hasHostRecord(childId)) continue;
      if (this.publishers.get(childId)?.hasSubscribers()) continue;
      this.releaseDetachedChild(childId);
      released += 1;
    }
    return released;
  }

  private releaseDetachedChild(childId: string): void {
    this.host.onDebug?.(`release detached live child publisher session=${childId}`);
    this.cleanupSessionRuntime(childId, { clearCommandInbox: false, notifyIndexRemoved: false });
  }

  /**
   * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
   * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
   * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
   * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
   */
  private fanOutToIndex(sessionId: string, event: SessionEvent): void {
    if (event.type === SessionEventType.ModelStreaming) return;
    // 工作流进度同样是高频流（实测 8s 4000 条），但列表要继续动，所以不是丢弃而是
    // leading + trailing 窗口节流：窗内合并为窗末一帧，终态仍在一个窗口内送达。
    if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
      this.indexFanoutThrottle.request(sessionId);
      return;
    }
    this.publishCurrentSummaryToIndex(sessionId);
  }

  /**
   * 把当前完整 projection 发布到 sessions-index。
   *
   * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
   * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
   * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
   * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
   */
  private publishCurrentSummaryToIndex(sessionId: string): void {
    // 这一次发布带的就是窗内合并后的当前摘要：待发的 trailing 到此被满足，不重复发帧。
    this.indexFanoutThrottle.notePublished(sessionId);
    const getWorkspaceId = this.host.getSessionWorkspaceId;
    if (!getWorkspaceId) return;
    try {
      const workspaceId = getWorkspaceId.call(this.host, sessionId);
      if (!workspaceId) return;
      if (this.host.isDraftSession?.(sessionId)) return;
      const indexPublisher = this.indexPublishers.get(workspaceId);
      if (!indexPublisher) return;
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) return;
      const changed = indexPublisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
      if (changed) this.flushIndex(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.sessionsIndex.ingest", error);
    }
  }

  /** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */
  private resolveIndexMeta(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    parentSessionId?: string;
  } {
    const meta = this.host.getSessionIndexMeta?.(sessionId);
    return {
      createdAt: meta?.createdAt ?? 0,
      lastActivityAt: meta?.lastActivityAt ?? this.now(),
      ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    };
  }

  /** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */
  private flushIndex(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.indexPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.emit", error);
      }
    }
  }

  /**
   * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
   */
  async subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const dispatch = await this.subscribeSessionsIndexReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a sessions-index topic: ${params.topic}`);
    }
    const publisher = await this.ensureIndexPublisher(workspaceId, params.legacyTaskIds);
    // ensure 内部可能跨异步 store/claim；dispose 发生在 await 返回前时禁止继续登记订阅。
    this.indexPublishers.ensureActive();
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushIndex(workspaceId),
      );
    } catch (error) {
      // initial logical frame 在 physical encode 阶段即可因 16MiB 上限失败；
      // 已登记订阅/in-flight reservation 后失败必须 rollback，否则会留下永远无法退订的幽灵 owner。
      result.rollback();
      throw error;
    }
  }

  /** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */
  private async ensureIndexPublisher(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const existing = this.indexPublishers.get(workspaceId);
    const shouldRefreshLegacy =
      Boolean(legacyTaskIds?.length) && Boolean(this.host.refreshLegacySessionSummaries);
    if (existing && !shouldRefreshLegacy) return existing;

    return this.indexPublishers.runExclusive(workspaceId, () =>
      this.ensureIndexPublisherExclusive(workspaceId, legacyTaskIds),
    );
  }

  /** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */
  private async ensureIndexPublisherExclusive(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const refreshed =
      legacyTaskIds && legacyTaskIds.length > 0
        ? ((await this.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
        : null;
    const existing = this.indexPublishers.get(workspaceId);
    if (existing) {
      // claim 不能绑定到首次构造：空种子一旦进 Map 就永久挡住重试。
      // 重读只补缺失项，避免冷存储默认态覆盖已有 live projection。
      if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
        this.flushIndex(workspaceId);
      }
      return existing;
    }
    const publisher = new SessionsIndexPublisher(
      workspaceId,
      this.createLogEpoch(`sessions-index/${workspaceId}`),
      this.now,
    );
    // 种子 1：store 里全部会话的轻量摘要（未加载的靠它进列表）。
    const stored = refreshed ?? (await this.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
    for (const summary of stored) publisher.seed(summary);
    // 种子 2：已加载会话用 live 投影覆盖（更准的 phase/preview/backgroundWork）。
    const liveIds = this.host.listWorkspaceSessionIds?.(workspaceId) ?? [...this.publishers.keys()];
    for (const sessionId of liveIds) {
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) continue;
      // draft（deferred 未发首条）不进冷启动种子，与 fanOutToIndex 的过滤一致。
      if (this.host.isDraftSession?.(sessionId)) continue;
      publisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
    }
    this.indexPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /**
   * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
   */
  async subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const dispatch = await this.subscribeWorkspaceConfigReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseWorkspaceConfigTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a workspace-config topic: ${params.topic}`);
    }
    const publisher = await this.ensureConfigPublisher(workspaceId);
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushConfig(workspaceId),
      );
    } catch (error) {
      // 与 sessions-index 同一原子边界：encode 失败 = subscribe 未 admission。
      result.rollback();
      throw error;
    }
  }

  /**
   * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
   * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
   * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
   * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
   */
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void {
    if (this.disposed) return;
    let publisher = this.configPublishers.get(workspaceId);
    if (!publisher) {
      publisher = new WorkspaceConfigPublisher(
        workspaceId,
        this.createLogEpoch(`workspace-config/${workspaceId}`),
        this.now,
      );
      this.configPublishers.set(workspaceId, publisher);
    }
    try {
      if (publisher.publish(state)) this.flushConfig(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.workspaceConfig.publish", error);
    }
  }

  private async pullWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfigState | null> {
    if (!this.host.getWorkspaceConfig) return null;
    return (await this.host.getWorkspaceConfig(workspaceId)) ?? null;
  }

  /** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */
  private async ensureConfigPublisher(workspaceId: string): Promise<WorkspaceConfigPublisher> {
    const existing = this.configPublishers.get(workspaceId);
    if (existing) return existing;
    const publisher = new WorkspaceConfigPublisher(
      workspaceId,
      this.createLogEpoch(`workspace-config/${workspaceId}`),
      this.now,
    );
    const seed = await this.pullWorkspaceConfig(workspaceId).catch((error) => {
      this.host.onError?.("v4.workspaceConfig.seed", error);
      return null;
    });
    if (seed) publisher.publish(seed);
    // await 期间的并发订阅可能已注册同 workspace publisher → 以先注册者为准。
    const raced = this.configPublishers.get(workspaceId);
    if (raced) return raced;
    this.configPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */
  private flushConfig(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.configPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.workspaceConfig.emit", error);
      }
    }
  }

  /** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */
  async subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    const dispatch = await this.subscribeReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    // viewReadyMs 的起点：CLI 侧「打开会话」这件事从这里开始（与 openPhases 同轴）。
    // 终点取 ACK 组装完成处，因此它覆盖 restore + hydration + initial frame encode。
    //
    // ⚠ 口径（cr-func 2026-10-25 矫正）：这是 **CLI 进程内**的视图就绪段，**不含**
    // host 准备（openTiming.hostPrepareMs）、CLI spawn（openTiming.cliBootstrapMs）、
    // RPC 往返、首帧传输与 renderer 的 apply/paint。冷开时它系统性偏短，**不能**拿它
    // 判「用户体验 ≤1s」——验收基准是 renderer 侧的 uiViewReadyMs
    // （conversationProjectionStore / conversationOpenObservability）。
    // 各段还嵌套：viewReadyMs ⊇ initialFrameEncodeMs，viewReadyMs ⊃ mergeMs + rehydrateMs，
    // 阶段 0 还 ⊃ runtime 激活本体。只可读，不可相加。
    const viewReadyStartedAt = performance.now();
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      throw new Error(`Unsupported topic: ${params.topic}`);
    }
    const isLiveConversation = this.conversationState(sessionId) === "live";
    this.host.onDebug?.(
      `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
    );
    // Hydration：首次订阅时从权威来源重建投影。
    // - 无 publisher（cold）→ 建 + 重放。
    // - 有 publisher 但事件日志覆盖不了 transcript（fork child：resume 的 ingest 抢先
    //   建了个只含 fork 事件的 cold publisher）→ 用 transcript 合成**重建**。
    // - 有 publisher 且事件日志完整（流式 live）→ 保留，重放会双计且打断流。
    //
    // 订阅是**视图**入口，只等视图水位（IS3）。Step 9 起视图水位只物化外壳（不 resume），
    // 激活由下面的 ACK 后预激活接管——「首屏返回时 runtime 还没起来」是预期状态。
    //
    // 已在飞的视图水位必须被加入（即使此刻 record 已经变成 live）：那条 flight 的
    // hydration 会带上 resume 给的 `persistedMessages`，另起一次会丢掉它并可能建出
    // 「只含事件日志、缺 transcript」的投影。
    const restoreStartedAt = performance.now();
    const viewFlight = this.viewReadyFlights.get(sessionId);
    const publisher = viewFlight
      ? await viewFlight
      : isLiveConversation
        ? await this.hydratePublisher(sessionId)
        : await this.ensureViewReadyPublisher(
            sessionId,
            params.resumeThoughtLevel,
            params.workspace,
          );
    const cliSessionRestoreMs = !isLiveConversation
      ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
      : undefined;
    // 旧入口允许 UI 自选 deliveryProfile，桌面调用遗漏时还会默认成
    // replayable。现在只认 host attachment 注入的可信 clientMode。
    const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    // subscribeReserved 已构建 wire projection；若在它之后才开始计时，大会话的
    // 行过滤/窗口截断会落在 restore 与 encode 两段之外。起点必须覆盖构建与 physical encode。
    const initialFrameEncodeStartedAt = performance.now();
    const result = publisher.subscribeReserved({
      connectionId: params.connectionId,
      base: params.base,
      deliveryProfile: profileName,
      // 与 clientMode 同族的可信注入：能力位来自该连接的 clientHello，缺席一律按旧消费者办
      // （整键 patch + 旧界裁剪）。resync / rehydrate 沿用订阅上已记下的这一位，不再重取。
      workflowRunDeltas: params.workflowRunDeltas === true,
    });
    const routeKey = subscriptionRouteKey(
      params.topic,
      result.ack.subscriptionId,
      params.connectionId,
    );
    let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
    try {
      dispatch = this.subscribeDispatch(result.ack, result.reservation, () => {
        const state = this.flushStates.get(routeKey);
        if (state) this.scheduleFlush(routeKey, state, publisher);
      });
      const hydrationPhases = this.lastHydrationPhases.get(sessionId);
      // 只回填「落在这条 subscribe 等待窗口内」的 hydration 分段：restoreStartedAt 之后的
      // hydration 才是本次订阅真正等掉的那一段（热切换不跑 hydration，不能冒领旧值）。
      const freshHydrationPhases =
        hydrationPhases?.finishedAtMs !== undefined &&
        hydrationPhases.finishedAtMs >= restoreStartedAt
          ? hydrationPhases
          : undefined;
      dispatch.ack = {
        ...dispatch.ack,
        openTiming: {
          version: 1,
          ...(cliSessionRestoreMs !== undefined ? { cliSessionRestoreMs } : {}),
          initialFrameEncodeMs: Math.max(
            0,
            Math.round(performance.now() - initialFrameEncodeStartedAt),
          ),
          sessionRuntimeState: isLiveConversation ? "warm" : "cold",
          // ⚠ 口径（risk 10，Step 7 钉死）：这是**本次物化的投影行数**，不是会话总行数。
          // 全量物化时它 = totalCount；窗口化冷开时它 = 窗口行数（≤ coldWindowMaxRows）。
          // 会话总行数只看 `rows.totalCount`（manifest 权威）。把它当总行数读会把
          // 「窗口化生效」误读成「会话变短了 / 优化无效」。
          snapshotRowCount: publisher.getSnapshot().rows.window.length,
        },
        // ACK 侧分段（IS8）：openTiming 是 .strict()，分段只能放这个新顶层键。
        // `materializeMs` 仍缺席且**不该有**：按需物化发生在 rowsRange 上（那里没有 ACK
        // 帧），它的成本经 `getRowPageOutcome(sessionId).materializeMs` 与 debug 行暴露；
        // 硬塞进 ACK 只会得到一个永远是 undefined 的键（口径禁令见 transport.ts）。
        openPhases: {
          version: 1,
          viewReadyMs: Math.max(0, Math.round(performance.now() - viewReadyStartedAt)),
          ...(freshHydrationPhases?.manifestMs !== undefined
            ? { manifestMs: freshHydrationPhases.manifestMs }
            : {}),
          ...(freshHydrationPhases?.manifestAdjusted !== undefined
            ? { manifestAdjusted: freshHydrationPhases.manifestAdjusted }
            : {}),
          ...(freshHydrationPhases?.mergeMs !== undefined
            ? { mergeMs: freshHydrationPhases.mergeMs }
            : {}),
          ...(freshHydrationPhases?.rehydrateMs !== undefined
            ? { rehydrateMs: freshHydrationPhases.rehydrateMs }
            : {}),
        },
      };
    } catch (error) {
      // 重订 initial encode 失败时客户端仍持有旧 subId；replacement 必须
      // 原子 rollback，旧 publisher subscription 与 flush timer 都继续有效。
      result.rollback();
      throw error;
    }
    // encode 成功后 replacement 才 admission；此时再清旧调度状态，失败路径不碰旧 owner。
    for (const [staleRouteKey, staleState] of this.flushStates) {
      if (staleState.sessionId !== sessionId) continue;
      if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
        continue;
      }
      if (staleState.timer) clearTimeout(staleState.timer);
      this.flushStates.delete(staleRouteKey);
    }
    this.flushStates.set(routeKey, {
      sessionId,
      topic: params.topic,
      subscriptionId: result.ack.subscriptionId,
      connectionId: params.connectionId,
      deliveryProfile: profileName,
      flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
      timer: null,
    });
    // ACK 已组装、帧已编码 —— 激活从这里开始后台跑（IS3 的触发点，见
    // `prewarmRuntimeAfterViewAck`）。必须放在帧编码之后：否则激活的 await 会串进
    // viewReadyMs / initialFrameEncodeMs，把「看」的耗时算到「跑」头上。
    this.prewarmRuntimeAfterViewAck(sessionId, params.resumeThoughtLevel, params.workspace);
    return dispatch;
  }

  /**
   * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
   * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
   */
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame> {
    const params = v4ConversationResyncParamsSchema.parse(rawParams);
    const request = {
      base: params.base,
      ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
    };
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId !== null) {
      const publisher = this.publishers.get(sessionId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const routeKey = subscriptionRouteKey(
        params.topic,
        params.subscriptionId,
        params.connectionId,
      );
      const flushState = this.flushStates.get(routeKey);
      if (flushState?.timer) {
        clearTimeout(flushState.timer);
        flushState.timer = null;
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(result.ack, result.reservation, () => {
          const state = this.flushStates.get(routeKey);
          if (state) this.scheduleFlush(routeKey, state, publisher);
        });
      } catch (error) {
        // physical encode 在 ACK admission 前失败时，same-sub recovery
        // 不能留下新的 inFlight 或取消旧 online flush；原子恢复旧状态后重挂 timer。
        result.rollback();
        if (flushState) this.scheduleFlush(routeKey, flushState, publisher);
        throw error;
      }
    }

    const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
    if (indexWorkspaceId !== null) {
      const publisher = this.indexPublishers.get(indexWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushIndex(indexWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }

    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      const publisher = this.configPublishers.get(configWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushConfig(configWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }
    throw new Error(`Unsupported topic: ${params.topic}`);
  }

  /**
   * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
   * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
   * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
   *
   * Step 7（IS6）：窗口化冷开之后投影只含尾部若干轮，窗口以上的行**不存在**。此时这一页
   * 走 `materializeRowPage`（gateway 按 manifest 定位缺哪几个整轮 → 宿主异步读正文 + 合成
   * → 临时投影物化 → 交 publisher 编码），结果不驻留投影（只进本次返回页）。
   *
   * 三条「不物化」的边界必须分清，否则「没生效」会被读成「翻页坏了」：
   *   - **视图已就绪**（`readableViewPublisher`：投影在、`viewReadySessions` 在册）→ 直接读
   *     这份投影，连冷路径都不进：不重新物化外壳、不起第二次冷开（Step 11）。升级在飞的
   *     窗口也走这条（那时 `hydratedSessions` 已被删，但投影仍可读）；
   *   - 本页整段落在已物化窗口内 → 投影现算（窗口内翻页永不触发第二次冷开）；
   *   - manifest 事实已作废（有 live 事件**改动了行集合**）→ 退回投影现算，`hasMore` 随之
   *     退化为「更早方向在投影里还有没有」，见 new_risk（窗口化 + live 追加行之后翻页暂
   *     不可用）；`SessionResumed` / 标题 / 模式 / 交互应答这类不增删行的事件**不作废**基线
   *     （Step 8 定稿；`ModelSelected` 不在此列——模型切换会在轮内长出一行 marker）；
   *   - 选不出页 / 宿主拒绝 / 一致性守卫拦下 → 退回投影现算并打点 `getRowPageOutcome`。
   */
  async rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult> {
    const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
    const publisher = await this.resolveViewPublisher(params.sessionId);
    const profile: "continuous" | "replayable" =
      // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
      params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    // 先判「这一页缺不缺」，再决定要不要付物化的钱：窗口内翻页只走投影现算。
    // manifest 事实只取一次，判定与规划共用（两处各取一次会让「判定时还在、规划时没了」
    // 变成一条不可达分支）。
    const facts = publisher.getRowManifestFacts();
    // manifest 事实缺席 = 没有可用清单（live 会话 / 老会话降级）：不去猜轮边界。
    // 这一句是**唯一**的清单闸：`materializeRowsPage` 拿到的一定是非空事实，不再重复判。
    if (facts !== null && this.rowPageNeeded(facts, publisher, params.beforeRowId, params.limit)) {
      const page = await this.materializeRowsPage({
        sessionId: params.sessionId,
        publisher,
        facts,
        beforeRowId: params.beforeRowId as number,
        limit: params.limit,
        profile,
      });
      if (page !== null) return page;
    }
    return publisher.getRowsRange(
      {
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      },
      profile,
    );
  }

  /**
   * 这一页是否需要按需物化（IS6 的判定半边）。
   *
   * 判据是「请求区间的最低行是否落在**已物化窗口**之下」——不是 `hasMore`：窗口内翻页时
   * `hasMore` 本来就是 true（更早方向确实还有行），拿它当触发条件会让投影内的每一页都去
   * 物化一次。反过来，请求区间跨在窗口边界上时整页交给物化（临时投影覆盖页内整轮，因此
   * 它自己就是完整的），不做两份来源的拼接。
   */
  private rowPageNeeded(
    facts: SessionRowManifestFacts,
    publisher: ConversationTopicPublisher,
    beforeRowId: number | undefined,
    limit: number,
  ): boolean {
    if (beforeRowId === undefined) return false;
    if (!this.host.materializeRowPage) return false;
    const windowRows = publisher.getSnapshot().rows.window;
    const projectedFirstRowId = windowRows[0]?.rowId;
    if (projectedFirstRowId === undefined) return false;
    // 投影首行就是权威首行 = 全量物化（没有缺页）。窗口化时首行是窗口首轮 base > 首行。
    if (projectedFirstRowId <= (facts.firstRowId ?? 1)) return false;
    const clampedLimit = Math.max(1, Math.min(limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
    // 请求区间 = [beforeRowId - limit, beforeRowId)。区间下界在窗口之下 → 缺行。
    return beforeRowId - clampedLimit < projectedFirstRowId;
  }

  /**
   * 按需物化一页（Step 7 的执行缝）。
   *
   * 三个必须成立的守卫，任一不成立就**放弃这一页**（返回 null，调用方退回投影现算）：
   *   1. 临时投影的 turn 数 === plan.turnCount（合成器的轮边界与 manifest 对齐；
   *      不对齐说明页首轮那条消息不构成一轮的起点，行身份会整体错位）；
   *   2. 临时投影的行数 === plan.rowCount（**每页一次的账目校验**：manifest 的
   *      `row_count` 必须与冷物化逐值一致，不一致宁可少一页也不交出平移过的 rowId）；
   *   3. 页内行必须完整落在 `[rowIdBase, rowIdBase + rowCount)`（同一件事的另一面，
   *      但乱序/空洞会在这里先暴露）。
   */
  private async materializeRowsPage(input: {
    sessionId: string;
    publisher: ConversationTopicPublisher;
    /** 判定时取到的 manifest 事实（= 规划的唯一输入，不再回读）。 */
    facts: SessionRowManifestFacts;
    beforeRowId: number;
    limit: number;
    profile: "continuous" | "replayable";
  }): Promise<V4ConversationRowsRangeResult | null> {
    const materialize = this.host.materializeRowPage;
    if (!materialize) return null;
    const selection = selectColdRowPage(input.facts, {
      beforeRowId: input.beforeRowId,
      limit: input.limit,
    });
    if (selection.kind !== "page") {
      // `noOlderRows` 是「上面本来就没有行」，不是失败：不打成 fallback。
      if (selection.reason !== "noOlderRows") {
        this.rowPageOutcomes.set(input.sessionId, {
          applied: false,
          reason: selection.reason,
          beforeRowId: input.beforeRowId,
          limit: input.limit,
          at: Date.now(),
        });
        this.host.onDebug?.(
          `v4 row page unavailable session=${input.sessionId} reason=${selection.reason} ` +
            `beforeRowId=${input.beforeRowId}`,
        );
      }
      return null;
    }
    const plan = selection.plan;
    const startedAt = performance.now();
    let page: ColdRowPageEvents | null;
    try {
      page = await materialize.call(this.host, input.sessionId, plan);
    } catch (error) {
      // 翻页是只读且可重发的 query：宿主抛错不能让整条读挂掉，只放弃这一页。
      this.host.onError?.("v4.rowPage.materialize", error, {
        phase: "materialize",
        sessionId: input.sessionId,
        ordinal: plan.ordinal,
      });
      page = null;
    }
    const materializeMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (page === null) {
      this.rowPageOutcomes.set(input.sessionId, {
        applied: false,
        reason: "hostUnavailable",
        beforeRowId: input.beforeRowId,
        limit: input.limit,
        ordinal: plan.ordinal,
        rowIdBase: plan.rowIdBase,
        materializeMs,
        at: Date.now(),
      });
      this.host.onDebug?.(
        `v4 row page host declined session=${input.sessionId} ordinal=${plan.ordinal} ` +
          `limitBefore=${String(plan.limitBefore)}`,
      );
      return null;
    }

    // 临时投影：rowIdOrigin 与上一轮模型基线都必须在中行之前播种（`seedRowIdOrigin` /
    // `seedTurnModelBaseline` 在已有行时抛错，这是刻意的失败模式），随后一次性重放这一页。
    const projection = new ProductProjection(input.sessionId, `row-page/${Date.now()}`);
    projection.seedRowIdOrigin(plan.rowIdBase);
    if (page.modelBaseline !== undefined) {
      projection.seedTurnModelBaseline(page.modelBaseline);
    }
    for (const event of page.events) projection.applyEvent(event);
    const snapshot = projection.getSnapshot();
    const producedTurnIds = projection.getTurnManifestBranchState().turnIds;
    const pageRows = snapshot.rows.window;
    const expectedLastRowId = plan.rowIdBase + plan.rowCount - 1;
    const rowsInsidePage =
      pageRows.length === plan.rowCount &&
      pageRows[0]?.rowId === plan.rowIdBase &&
      pageRows[pageRows.length - 1]?.rowId === expectedLastRowId;
    if (producedTurnIds.length !== plan.turnCount || !rowsInsidePage) {
      // 对齐失败：不交出这一页。打点必须带两侧数字，否则「合成器与 manifest 谁错」
      // 无从判断（这正是窗口化最难复现的一类分歧）。
      this.rowPageOutcomes.set(input.sessionId, {
        applied: false,
        reason: "alignmentMismatch",
        beforeRowId: input.beforeRowId,
        limit: input.limit,
        ordinal: plan.ordinal,
        rowIdBase: plan.rowIdBase,
        turnCount: plan.turnCount,
        rowCount: plan.rowCount,
        pageRows: pageRows.length,
        materializeMs,
        at: Date.now(),
      });
      this.host.onError?.("v4.rowPage.alignment", new Error("row page alignment mismatch"), {
        phase: "viewport",
        sessionId: input.sessionId,
        ordinal: plan.ordinal,
        expectedTurns: plan.turnCount,
        producedTurns: producedTurnIds.length,
        expectedRows: plan.rowCount,
        producedRows: pageRows.length,
        firstRowId: pageRows[0]?.rowId ?? null,
        expectedFirstRowId: plan.rowIdBase,
      });
      return null;
    }
    const result = input.publisher.encodeRowsRangePage(
      pageRows,
      { beforeRowId: input.beforeRowId, limit: input.limit },
      input.profile,
    );
    this.rowPageOutcomes.set(input.sessionId, {
      applied: true,
      beforeRowId: input.beforeRowId,
      limit: input.limit,
      ordinal: plan.ordinal,
      rowIdBase: plan.rowIdBase,
      turnCount: plan.turnCount,
      rowCount: plan.rowCount,
      pageRows: result.rows.length,
      materializeMs,
      at: Date.now(),
    });
    this.host.onDebug?.(
      `v4 row page applied session=${input.sessionId} ordinal=${plan.ordinal} ` +
        `rowIdBase=${plan.rowIdBase} turns=${plan.turnCount} rows=${plan.rowCount} ` +
        `pageRows=${result.rows.length} messages=${page.messageCount} ` +
        `initialModelKey=${String(page.initialModelKeyResolved)} ` +
        `materializeMs=${materializeMs} hasMore=${String(result.hasMore)}`,
    );
    return result;
  }

  /**
   * v4/conversation/turnDirectory：turnNavigator 的窄投影目录（用户可见 query 粒度）。
   *
   * 与 rowsRange 同族同形：只读 query、不建订阅、经视图水位取 publisher
   * （`resolveViewPublisher`），因此冷会话（重启后直开历史）无需改动
   * transcript-hydration 即可自动可用。
   */
  async turnDirectory(rawParams: unknown): Promise<V4ConversationTurnDirectoryResult> {
    const params = v4ConversationTurnDirectoryParamsSchema.parse(rawParams);
    const publisher = await this.resolveViewPublisher(params.sessionId);
    return v4ConversationTurnDirectoryResultSchema.parse(
      publisher.getTurnDirectory(
        {
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.beforeQueryRowId !== undefined
            ? { beforeQueryRowId: params.beforeQueryRowId }
            : {}),
        },
        // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
        params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
      ),
    );
  }

  /**
   * v4/conversation/runtimeReady：runtime 激活耗时的观测 query。
   *
   * 为什么独立成 query 而不是 ACK 字段：view-only 下 runtime 激活发生在 view-ready
   * ACK **之后**，ACK 帧里不可能有该值（IS8；openPhases 明确不含 runtimeReadyMs）。
   *
   * 只读语义：**不触发激活**，只回已发生的事实。`runtimeReadyMs` 的生产点是
   * `ensureRuntimeReady`（量的是 `coldResume.ensureResumed` 本体）；触发方是 ACK 后的
   * 后台预激活、send 类命令，以及没有 shell 端口的旧宿主上视图水位的降级分支；
   * 读数口径不随写入点变化（Step 9 起视图水位本身不再产生这个值）。
   *
   * `runtimeReadyMs` 的口径钉死为 **「激活本体耗时」**（`ensureResumed` 的耗时），
   * 不是「从 ACK 起算」：阶段 0 的激活在 ACK **之前**，按 ACK 起算会算出负数；
   * 阶段 8 拆开后激活在 ACK **之后**，按 ACK 起算又会把等待时间算进去。只有「激活本体」
   * 能跨阶段比较。`runtimeReadyMs: null` = 本进程没观测到一次激活（≠ 0）。
   *
   * `runtimeReady` 布尔的口径是 **「runtime 是否已就绪」**（`isRuntimeReady`：live 判定
   * 或一次成功激活的结论），**不是**「record 是否在册」——Step 9 起 view-only shell 也会
   * `createRecord`，按 record 判会把「只建了视图、没跑 runtime」误报成就绪。
   */
  async runtimeReady(rawParams: unknown): Promise<V4ConversationRuntimeReadyResult> {
    const params = v4ConversationRuntimeReadyParamsSchema.parse(rawParams);
    return v4ConversationRuntimeReadyResultSchema.parse({
      sessionId: params.sessionId,
      runtimeReadyMs: this.runtimeActivationMs.get(params.sessionId) ?? null,
      runtimeReady: this.isRuntimeReady(params.sessionId),
    });
  }

  /** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */
  async plans(rawParams: unknown): Promise<V4ConversationPlansResult> {
    const params = v4ConversationPlansParamsSchema.parse(rawParams);
    const publisher = await this.resolveViewPublisher(params.sessionId);
    return publisher.getPlans();
  }

  /**
   * workflow run 事件日志的分页读取（cursor = journal sequence）。
   *
   * 与 rows/range、plans 同族：只读、无状态、超时重发安全。刻意**不是** v4 command——
   * command 的 ACK 结果是那个封闭的「变更结果」判别联合，一页只读事件不属于那个词汇表。
   *
   * 一页的条数与字节两道界都在 CLI 侧（run-service）注入（FORK 偏离上游：上游在本层注入
   * maxBytes，fork 定在 run-service——host 面改动最小，见 v4-gateway 的
   * `listDynamicWorkflowRunEvents`）；本层只透传调用方的 limit。`hasMore` 由存储层判定——
   * 页可能因字节提前收尾，「取满 limit」不再是判据。
   */
  async workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult> {
    const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunEvents) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const page = await this.host.listDynamicWorkflowRunEvents(params.sessionId, {
      runId: params.runId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return v4ConversationWorkflowRunEventsResultSchema.parse(page);
  }

  /**
   * dwf run 的枚举 query。与
   * workflowRunEvents 同族：只读、无状态、超时重发安全。limit 的缺省与钳制在 CLI 侧
   * （run service），这里只透传；`resumable` 由 CLI 按 resume 门的同一个谓词算好。
   */
  async workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult> {
    const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRuns) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const runs = await this.host.listDynamicWorkflowRuns(params.sessionId, {
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return v4ConversationWorkflowRunsResultSchema.parse({ runs });
  }

  /**
   * workflow run 的**用户面产物**清单。
   * 与 workflowRunEvents 同族：只读、无状态、超时重发安全。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层
   * 返回值（引擎内部对后者的同名叫法）。
   *
   * 未知 runId 回空清单而不是错误：一个已被淘汰 / 从未存在的 run 没有产物，这是一个
   * 事实而不是故障——同一姿态见事件日志对越界 cursor 的处理。
   */
  async workflowRunArtifacts(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactsResult> {
    const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifacts) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const artifacts = await this.host.listDynamicWorkflowRunArtifacts(params.sessionId, {
      runId: params.runId,
    });
    return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
  }

  /**
   * 预置看板的取数面：喂给某个产物的 `report` 条目分页。
   *
   * `limit` 的**缺省与钳制都在这里**（存储层精确兑现、绝不自造页大小也绝不再钳）；`hasMore` 照 workflowRunEvents 的惯例多取一条判定——判据绝不能是「这页正好满」，
   * 那会在条目数恰好等于 limit 时误报，让看板去翻一页不存在的数据。
   */
  async workflowRunArtifactData(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
    const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifactItems) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunArtifactItems",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const limit = Math.max(
      1,
      Math.min(
        params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
        WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
      ),
    );
    const items = await this.host.listDynamicWorkflowRunArtifactItems(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      // 多取一条只为判定 hasMore；它不进结果页。
      limit: limit + 1,
    });
    const hasMore = items.length > limit;
    return v4ConversationWorkflowRunArtifactDataResultSchema.parse({
      items: hasMore ? items.slice(0, limit) : items,
      hasMore,
    });
  }

  /**
   * 内容产物的字节，**逐字照 attachmentRead**：一次一块、≤ 512 KiB（schema 已钉住 limit 的
   * 上界），`nextOffset` 为 null 即读到尾。
   *
   * **授权全在宿主侧**（端口实现）：该 run 必须属于 `sessionId` 这个会话 ∧ journal 里有
   * `(artifactId, version)` 的 completed 行，然后才拿**行上的** uri 去 store 读。网关只做
   * 参数校验与分块——它没有 journal，也不该有第二份授权判据（两处各判一次，同一个 id
   * 迟早会在两层上得到不同的解释）。宿主回 `undefined` = 无此版本 / 不是你的 run /
   * 这是块看板（没有字节），三者对调用方是同一个业务事实，这里归一成结构化的 not found。
   *
   * `offset` 越界不是错误：返回空块 + `nextOffset: null`，与读到尾同一形态。
   */
  async workflowRunArtifactRead(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
    const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunArtifact) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const artifact = await this.readWorkflowArtifactPayload(params);
    const totalBytes = artifact.bytes.byteLength;
    const start = Math.min(params.offset, totalBytes);
    const end = Math.min(start + params.limit, totalBytes);
    const chunk = artifact.bytes.subarray(start, end);
    return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: artifact.mediaType,
      totalBytes,
      nextOffset: end < totalBytes ? end : null,
    });
  }

  /**
   * 工作区 transcript 的清单：一个 run 的
   * `files.*` / `git.*` / `world.run` 行，不带正文。
   *
   * 宿主回 `undefined`（未知 run / 不是你的 run）得到空清单而不是错误：与产物清单同一姿态，
   * 也是授权链「不告诉越权者猜对了哪一半」的要求。清单超过 maxNodes 截尾并置 `truncated`——
   * 一个循环里跑了三千次 `world.run` 的 run 不该把侧板撑爆。
   */
  async workflowRunWorkspace(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
    const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunWorkspaceNodes) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunWorkspaceNodes",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const nodes =
      (await this.host.listDynamicWorkflowRunWorkspaceNodes(params.sessionId, {
        runId: params.runId,
      })) ?? [];
    const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
    return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
      nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  /**
   * 一个工作区节点的正文，按 `maxBytes` 保形有界化（缺省与上限都是 resultMaxBytes，钳在这里）。
   * 授权全在宿主侧；宿主回 `undefined` = 无此节点 / 不是你的 run / 不是 world 行，归一成
   * 结构化的 not found。
   */
  async workflowRunNodeResult(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunNodeResultResult> {
    const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunNodeResult) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const maxBytes = Math.max(
      1,
      Math.min(
        params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
        WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
      ),
    );
    const result = await this.host.readDynamicWorkflowRunNodeResult(params.sessionId, {
      runId: params.runId,
      siteId: params.siteId,
      ordinal: params.ordinal,
      maxBytes,
    });
    if (result === undefined) {
      throw new Error(
        `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
      );
    }
    return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
  }

  /**
   * 一个产物版本的**整份**字节，带缓存。
   *
   * 端口的 `readArtifact` 返回的是整份字节，而
   * `workflowRunArtifactRead` 是**分块**查询——不缓存的话，一个 20 MiB 的 PDF 按 512 KiB
   * 分 40 块取，就会把整份文件从 store 读 40 遍（800 MiB 的 I/O），而且每一块都要重走一遍
   * journal 授权链。`attachmentRead` 早就有这张表，这里复用它（见 {@link BinaryReadCacheEntry}
   * 关于两个家族共用一张表的论证）。
   *
   * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
   * 同一次读，而不是各自发起一次再各自写一遍缓存。
   *
   * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
   * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
   * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
   *
   * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
   * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
   * 负缓存钉死 30 秒。
   */
  private readWorkflowArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // 首段标签 `dwfart`：与附件预览共用同一张表，靠首段隔离（见 BinaryReadCacheEntry）。
    const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    const payload = this.host.readDynamicWorkflowRunArtifact!(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      version: params.version,
    })
      .then((artifact) => {
        if (artifact === undefined) {
          throw new Error(
            `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
          );
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = artifact.bytes.byteLength;
          this.binaryReadCacheBytes += artifact.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        // contentType 归一成表里的 mediaType 词汇；值仍是 journal 记录上的那一份
        // （UI 分派渲染器的精确匹配契约），不是 store 按文件名再推的那个。
        return { bytes: artifact.bytes, mediaType: artifact.contentType };
      })
      .catch((error: unknown) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, {
      sessionId: params.sessionId,
      accessedAt: now,
      bytes: null,
      payload,
    });
    return payload;
  }

  /**
   * dwf 两个 journal 读面的宿主 record 前置。
   *
   * 这两个 query 都经 app 能力读 journal，而宿主按 sessionId 找 record——历史
   * 会话的 record 只由**订阅**路径激活。renderer 里发现查询的 effect 声明在 lease/订阅
   * effect 之前，而 CLI 严格串行派发请求（`zcode-protocol/transport.ts`，只有 session/stop
   * 越队），于是「重启后打开历史会话」时它必然先于订阅被处理、必然拿到 sessionNotFound：
   * 工具卡的 join 回退整块消失，卡片退回编译态，被打断的 run 连入口都没有。
   *
   * 只拉 record，**不**建 READY publisher：journal 与 conversation log 无关，读一页 run
   * 不需要投影（同一判断见这两个 query 刻意不带 atSeq/atLogEpoch）。习语与 attachmentBegin
   * 逐字相同；`ensureResumed` 自带按会话单飞，与并发订阅共享同一次 activation。
   *
   * 活性判定必须走 `conversationState`（IS4），不能只看 `sessionExists`。dwf actor transcript
   * 是 detached live 会话——真 runtime 活在 run service 里、宿主刻意没有 record；嵌套
   * SessionPane 的发现查询带着 actor id 打到这里，旧判定就对一条**正在运行**的会话物化出
   * 第二个（幽灵）runtime：它向同一份事件日志追加 SessionResumed、丢弃 pending steer、重放
   * resume hooks，双写把序列账搞乱，transcript 从此定格（症状是直播冻结在「已工作 xx 秒」）。
   */
  private async ensureHostRecordForJournalRead(sessionId: string): Promise<void> {
    // 只等 runtime 水位（journal 读要宿主 record）。走 `ensureRuntimeReady` 而不是直接
    // `coldResume`：与订阅/命令共享同一条激活单飞，并留下 settle 结论供 runtimeReady query 读。
    await this.ensureRuntimeReady(sessionId);
  }

  async fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult> {
    const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
    if (!this.host.getConversationFileChanges) {
      throw new Error("fault.fileChanges.unsupported");
    }
    const publisher = await this.resolveViewPublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileChanges");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.getConversationFileChanges(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  async backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult> {
    const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
    // 观察查询不能 hydrate/恢复冷会话；任务由现有 runtime 授权。
    if (!this.host.readBackgroundBashOutput) return { kind: "unsupported", workId };
    return backgroundBashOutputResultSchema.parse(
      await this.host.readBackgroundBashOutput(sessionId, workId),
    );
  }

  async fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult> {
    const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
    if (!this.host.previewConversationFileRewind) {
      throw new Error("fault.fileRewindPreview.unsupported");
    }
    const publisher = await this.resolveViewPublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileRewindPreview");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.previewConversationFileRewind(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  private resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
    const snapshot = publisher.getSnapshot();
    if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
    if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
    const resolution = publisher.resolveRowActionTarget(params.target, action);
    if (!resolution.ok) throw new Error(resolution.reasonCode);
    return resolution;
  }

  /** begin 只 admission metadata，不解码/暂存 full payload。 */
  async attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult> {
    const params = v4AttachmentBeginParamsSchema.parse(rawParams);
    if (!this.host.putSessionAttachment) {
      throw new Error("fault.attachment.putUnsupported");
    }
    // 上传要写进 runtime（`app.writePromptAttachment`），所以是 **runtime 水位**：
    // 不能靠视图水位（view-only 会话有投影但没有 record，写会 404）。
    await this.ensureRuntimeReady(params.sessionId);
    return this.attachmentUploads.begin(params);
  }

  async attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult> {
    return this.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
  }

  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult> {
    return this.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
  }

  async attachmentAbort(rawParams: unknown): Promise<void> {
    await this.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
  }

  async attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult> {
    const params = v4AttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new Error("fault.attachment.readUnsupported");
    }
    // 附件归属由投影里的权威 user row 证明 → 视图水位足够（read 需要 record，
    // 但那一步在 host 侧失败即可，读入口不为它顺手激活 runtime）。
    const publisher = await this.resolveViewPublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      // renderer 传来的 ref 不能直接成为文件路径；必须先由当前 session
      // 的权威 user row 证明归属，避免跨 session 或任意路径读取。
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }

    const payload = await this.readAttachmentPayload(
      params.sessionId,
      params.ref,
      resolution.attachment.mime,
      resolution.messageId,
      resolution.attachmentIndex,
    );
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return {
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    };
  }

  async conversationAttachmentRead(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentReadResult> {
    const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
    }
    // 三个附件分享读面都只读投影（行归属 + messageId），因此走视图水位：view-only
    // 会话也能预览已发送附件；宿主侧的 record 缺失由 host 自己失败，不在这里藏一次激活。
    const publisher = await this.resolveViewPublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let payload: { bytes: Uint8Array; mediaType: string };
    try {
      payload = await this.readAttachmentPayload(
        params.sessionId,
        params.ref,
        attachment.mime,
        messageId,
        params.attachmentIndex,
        true,
      );
    } catch (error) {
      throw toShareStatFault(error);
    }
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return v4ConversationAttachmentReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    });
  }

  async conversationAttachmentStat(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentStatResult> {
    const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
    if (!this.host.statSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
    }
    const publisher = await this.resolveViewPublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let result: { totalBytes: number; mediaType: string; mtimeMs?: number };
    try {
      result = await this.host.statSessionAttachment(params.sessionId, {
        ref: params.ref,
        mime: attachment.mime,
        ...(messageId ? { messageId } : {}),
        attachmentIndex: params.attachmentIndex,
      });
    } catch (error) {
      // 「附件确实不在了」是 share 预检唯一能确定判定为跳过的分类，必须以稳定码上抛；
      // 否则 service 只能猜错误文本。
      throw toShareStatFault(error);
    }
    // stat 结果曾被 30MiB 的 schema 上限卡住，超大附件在这里抛 ZodError，
    // 于是 share 预检把「已知容量超限」这个确定阻断降级成 deferred 并静默丢内容。
    // 上限放宽后仍需要一个显式出口：真的超过协议可表达范围时给出稳定码。
    if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
    }
    return v4ConversationAttachmentStatResultSchema.parse(result);
  }

  async attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult> {
    const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
    const publisher = await this.resolveViewPublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }
    if (
      params.clientMode !== "desktop-continuous" ||
      !resolution.attachment.mime.startsWith("video/") ||
      !this.host.resolveSessionAttachmentPreviewSource
    ) {
      return { kind: "chunked" };
    }
    const result = await this.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
      ref: params.ref,
      mime: resolution.attachment.mime,
      ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
      ...(resolution.attachmentIndex !== undefined
        ? { attachmentIndex: resolution.attachmentIndex }
        : {}),
    });
    return v4AttachmentPreviewSourceResultSchema.parse(result);
  }

  private resolveReadableMediaAttachment(
    publisher: ConversationTopicPublisher,
    sessionId: string,
    ref: string,
    target?: { rowId: number; entityId: string },
    attachmentIndex?: number,
  ): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
    const matchesRef = (attachment: AttachmentRef) =>
      attachment.ref === ref || attachment.previewRef === ref;
    if (target && attachmentIndex !== undefined) {
      const row = publisher
        .getSnapshot()
        .rows.window.find(
          (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
        );
      if (row?.kind !== "userInput") return null;
      const attachment = row.attachments?.[attachmentIndex];
      if (!attachment || !isReadablePreviewAttachment(attachment) || !matchesRef(attachment)) {
        return null;
      }
      // 热态 renderer 可能还持有 original ref，而 hydrate 后的权威 row 已补
      // previewRef；两者属于同一个 row/index，授权不能因投影时序不同而误判为跨行读取。
      const messageId = publisher.getMessageIdForRow(row.rowId);
      return {
        attachment,
        attachmentIndex,
        ...(messageId ? { messageId } : {}),
      };
    }

    // 旧 renderer 没有 row target，无法按消息定位持久 artifact；一旦
    // previewRef 存在就只能授权该 durable ref，不能重新放行可变的原始路径。
    for (const row of publisher.getSnapshot().rows.window) {
      if (row.kind === "userInput") {
        for (const attachment of row.attachments ?? []) {
          if (!isReadablePreviewAttachment(attachment)) continue;
          if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
        }
      }
      if (
        row.kind === "assistantText" &&
        artifactRefBelongsToSession(ref, sessionId) &&
        extractMarkdownArtifactImageRefs(row.text).includes(ref)
      ) {
        // assistant Markdown 可以引用工具产出的 session artifact，
        // 但旧授权只查看 userInput.attachments，导致合法图片到 UI 后被 harden
        // 拦截。仍以当前 session 的权威投影做精确 ref 授权，绝不接受 renderer
        // 自报的任意 artifact/path。Markdown 是模型可控文本，所以 URI authority
        // 还必须与当前请求 session 精确匹配；仅“当前投影里出现过”不能证明它有权
        // 读取另一个 session 的 artifact。
        return {
          attachment: {
            ref,
            fileName: "assistant-image",
            mime: "image/*",
            bytes: 0,
          },
        };
      }
    }
    return null;
  }

  /**
   * 读取附件全部字节（带 TTL/容量缓存）。
   *
   * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
   * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
   * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
   * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
   */
  private readAttachmentPayload(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric = false,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // 首段标签 `att`：这张表与 dwf 产物字节共用（见 BinaryReadCacheEntry），两个键空间
    // 只能靠一个不可能相等的首段隔离。
    const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    // 预览读取曾复用上传的 20MiB 总量上限；video 使用已有全局输入上限，
    // image 和上传事务继续保持原边界。
    const maxBytes = allowGeneric
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : mime.startsWith("video/")
        ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
        : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
    const payload = this.host.readSessionAttachment!(sessionId, {
      ref,
      mime,
      maxBytes,
      ...(messageId ? { messageId } : {}),
      ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
    })
      .then((result) => {
        // 结果闸与授权闸共用同一组判定语义（见 isReadablePreviewResultMediaType）。
        if (!allowGeneric && !isReadablePreviewResultMediaType(mime, result.mediaType)) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
        }
        if (result.bytes.byteLength > maxBytes) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = result.bytes.byteLength;
          this.binaryReadCacheBytes += result.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        return result;
      })
      .catch((error) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, { sessionId, accessedAt: now, bytes: null, payload });
    return payload;
  }

  private pruneBinaryReadCache(now = this.now()): void {
    for (const [key, entry] of this.binaryReadCache) {
      if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
        this.deleteBinaryReadCacheEntry(key);
      }
    }
    if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
    const oldest = [...this.binaryReadCache.entries()]
      .filter(([, entry]) => entry.bytes !== null)
      .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    for (const [key] of oldest) {
      this.deleteBinaryReadCacheEntry(key);
      if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
    }
  }

  private deleteBinaryReadCacheEntry(key: string): void {
    const entry = this.binaryReadCache.get(key);
    if (!entry) return;
    this.binaryReadCache.delete(key);
    this.binaryReadCacheBytes = Math.max(0, this.binaryReadCacheBytes - (entry.bytes ?? 0));
  }

  /** v4/conversation/unsubscribe。 */
  unsubscribe(rawParams: unknown): void {
    const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      const workspaceId = parseSessionsIndexTopic(params.topic);
      if (workspaceId !== null) {
        this.indexPublishers
          .get(workspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
        return;
      }
      const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
      if (configWorkspaceId !== null) {
        this.configPublishers
          .get(configWorkspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
      }
      return;
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const state = this.flushStates.get(routeKey);
    if (!state) return;
    if (state?.timer) clearTimeout(state.timer);
    this.flushStates.delete(routeKey);
    // 裸 subscriptionId 在不同 topic/connection 可碰撞；旧网关先按 subId
    // 反查再对三类 publisher 广撒网，会删掉别的连接。topic + connection 必须同时命中。
    this.publishers.get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
  }

  /**
   * 命令闸门的判定（不等待、不创建水位）。
   *
   * 只解析信封并查 `commandRuntimeGate` 的分类；解析失败 → `pass`（让 inbox 按它自己的
   * 错误口径拒绝，闸门不抢那条错误）。`sessionId === null` 的 `createSession` 永远 `pass`：
   * 它创建的就是 runtime 本身，把它也拒掉就等于「没有会话能出生」。
   */
  private commandGateDecision(rawParams: unknown): CommandGateDecision {
    const parsed = parseCommandEnvelope(rawParams);
    if (!parsed.ok) return { kind: "pass" };
    const { sessionId, type, commandId } = parsed.envelope;
    if (sessionId === null) return { kind: "pass" };
    const gate = commandRuntimeGate(type);
    if (gate === "record-free") return { kind: "pass" };
    return {
      kind: "gated",
      sessionId,
      mode: gate === "trigger-activation" ? "trigger-activation" : "await-runtime",
      commandId,
    };
  }

  /**
   * v4/command：inbox 六态裁决；accepted 时执行副作用并把终态随响应返回。
   *
   * 这里曾经"立即回初始 ACK、后台 settle"，
   * 导致 createSession/forkAssistant 的调用方拿不到 result.sessionId（settle 只回填
   * 幂等表，只有同 commandId 重试才能读到）——违反
   * 「accepted 即时带 result」。命令副作用本身是快返回的（sendPrompt 后台起 turn），
   * await 不会把 RPC 挂到整个 turn 结束，所以同步等待终态。
   * settle 仍然固化结果供 duplicate 重放。
   */
  async handleCommand(rawParams: unknown): Promise<CommandAck> {
    // 命令闸门（IS3 / Step 8）：命令只能在 **runtime-ready** 之后执行。
    //
    // 分类见 `commandRuntimeGate`；这里只负责「等 / 触发 / 拒」三种动作：
    //   - 触发器（send 类）：当场启动或加入 runtime 水位，然后等它——这是 view-only
    //     会话唯一的升级路径，缺了它 composer 就是死锁；
    //   - require-runtime：不创建水位。已在飞的视图/runtime 水位都等（保持「冷开期间的
    //     命令先等恢复收口」这条既有语义），等完仍未就绪 → 可重试的 `runtimeNotReady`；
    //   - record-free：原样放行（晚到交互应答、全局建会话、store 级丢弃）。
    // sessionId 为 null（createSession）不受此门限制。
    const gate = this.commandGateDecision(rawParams);
    if (gate.kind === "gated") {
      if (gate.mode === "trigger-activation") {
        await this.ensureRuntimeReady(gate.sessionId);
        // 视图水位仍在飞时也要等：命令读的是投影（admission 的 revision / row target），
        // 提前放行只会在 hydration 窗口里拿到 staleRevision。
        await this.awaitExistingViewFlight(gate.sessionId);
      } else {
        // 只等已在飞的水位，不创建。激活失败不能让「未就绪」变成命令异常：
        // 结论已在 flight 上，下面的 `isRuntimeReady` 会给出可重试的 runtimeNotReady。
        await this.awaitExistingViewFlight(gate.sessionId).catch(() => undefined);
        const runtimeFlight = this.runtimeReadyFlights.get(gate.sessionId);
        if (runtimeFlight) await runtimeFlight.promise.catch(() => undefined);
        if (!this.isRuntimeReady(gate.sessionId)) {
          return {
            commandId: gate.commandId,
            status: "rejected",
            reasonCode: RUNTIME_NOT_READY_REASON,
            message: "session runtime is not ready yet; retry after runtime activation settles",
            revisionAtDecision: this.publishers.get(gate.sessionId)?.getSnapshot().revision ?? 0,
          };
        }
      }
    }

    const outcome = await this.inbox.handle(rawParams);
    if (outcome.kind === "ack") return outcome.ack;
    let durableInputIntent: ConversationInputIntent | null = null;
    let settledAck: CommandAck | null = null;
    type CommandFinal = Parameters<typeof outcome.settle>[0];
    const reportError = (scope: string, error: unknown): void => {
      try {
        this.host.onError?.(scope, error);
      } catch {
        // 错误观察器不能反向破坏 command final 与 session FIFO 的收口。
      }
    };
    const settleOnce = (final: CommandFinal): CommandAck => {
      if (settledAck) return settledAck;
      const ack = {
        ...outcome.ack,
        ...final,
      };
      outcome.settle(final);
      settledAck = ack;
      return ack;
    };
    const cancelDurableInput = async (reason: string): Promise<void> => {
      if (!durableInputIntent) return;
      try {
        await this.host.cancelCommandInput?.(outcome.envelope, outcome.queueItemId, reason);
      } catch (cancelError) {
        // 原命令 ACK 必须保留真实执行结果；ledger cancel 失败单独告警，不能覆盖原错误。
        reportError("v4.command.input.cancel", cancelError);
      }
    };
    const releaseDurableInput = (
      final: Pick<CommandAck, "status" | "reasonCode" | "message" | "result">,
    ) => {
      if (!durableInputIntent || outcome.envelope.sessionId === null) return;
      try {
        this.inbox.releaseLiveInput(
          {
            sessionId: outcome.envelope.sessionId,
            commandId: durableInputIntent.sourceCommandId,
          },
          { ...outcome.ack, ...final },
        );
      } catch (releaseError) {
        reportError("v4.command.input.release", releaseError);
      }
    };
    try {
      const admission = {
        admissionSeq: outcome.admissionSeq,
        admittedAt: outcome.admittedAt,
        queueItemId: outcome.queueItemId,
      };
      const admissionPublisher =
        outcome.envelope.type === "createSession"
          ? new ConversationTopicPublisher(`pending-${outcome.envelope.commandId}`, "admission", {
              now: this.now,
            })
          : outcome.envelope.sessionId === null
            ? null
            : this.ensurePublisher(outcome.envelope.sessionId);
      const admissionProjectionBytes = admissionPublisher?.measureInputAdmissionProjectionBytes(
        outcome.envelope,
        admission,
      );
      if (
        admissionProjectionBytes !== null &&
        admissionProjectionBytes !== undefined &&
        admissionProjectionBytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      ) {
        return settleOnce({
          status: "failed",
          reasonCode: "proto.payloadTooLarge",
          message: `conversation projection would exceed ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
        });
      }
      durableInputIntent =
        (await this.host.admitCommandInput?.(outcome.envelope, admission)) ?? null;
      if (durableInputIntent && outcome.envelope.sessionId !== null) {
        this.inbox.pinLiveInput(outcome.envelope.sessionId, durableInputIntent);
      }
      const result = await this.host.executeCommand(outcome.envelope, admission);
      // 新建/侧聊命令采用结果会话的开关，避免把父会话或当前 App 设置误记到新会话。
      const telemetrySessionId =
        result?.type === "createSession" || result?.type === "createSelectionSideSession"
          ? result.sessionId
          : outcome.envelope.sessionId;
      const memoryEnabled = telemetrySessionId
        ? this.host.getSessionMemoryEnabled?.(telemetrySessionId)
        : undefined;
      const final = {
        status: "accepted" as const,
        ...(result ? { result } : {}),
        ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
      };
      return settleOnce(final);
    } catch (error) {
      // noop 不是失败（同值切换收口）：不进 onError，noop ACK 返回。
      if (error instanceof V4CommandNoopError) {
        await cancelDurableInput(error.reasonCode);
        const final = {
          status: "noop" as const,
          reasonCode: error.reasonCode,
        };
        releaseDurableInput(final);
        return settleOnce(final);
      }
      reportError("v4.command.execute", error);
      // 携带 reasonCode 的领域错误（V4PromptRejectedError / heldQueueDispositionRequired 等）
      // 原样上行，客户端才能按 guard 错误码分流；否则归一 executionFailed。
      const domainReasonCode =
        typeof (error as { reasonCode?: unknown } | null)?.reasonCode === "string"
          ? String((error as { reasonCode: string }).reasonCode)
          : null;
      // I4：截断已提交后 start 失败必须让客户端拿回 newText（目标行已随 rewind 卸载，
      // composer 草稿是唯一出路）。只有显式携带 draftText 的领域错误才透传，不推断。
      const draftText =
        typeof (error as { draftText?: unknown } | null)?.draftText === "string"
          ? String((error as { draftText: string }).draftText)
          : undefined;
      const final = {
        status: "failed" as const,
        reasonCode:
          error instanceof V4CommandNotImplementedError
            ? "fault.command.notImplemented"
            : (domainReasonCode ?? "fault.command.executionFailed"),
        message: error instanceof Error ? error.message : String(error),
        ...(draftText ? { draftText } : {}),
      };
      await cancelDurableInput(final.reasonCode);
      releaseDurableInput(final);
      return settleOnce(final);
    } finally {
      if (!settledAck) {
        // publisher/measure/admission 任一同步异常过去会跳过 settle，
        // 导致相同 command 永久等待、同 session FIFO 也无法继续 admission。
        const final = {
          status: "failed" as const,
          reasonCode: "fault.command.executionFailed",
          message: "command admission terminated before a durable final was recorded",
        };
        releaseDurableInput(final);
        settleOnce(final);
      }
    }
  }

  /** v4/commands/query：同 key 与 handleCommand 共用 CommandInbox gate。 */
  async queryCommands(rawParams: unknown): Promise<CommandsQueryResult> {
    const params = commandsQueryParamsSchema.parse(rawParams);
    // 命令结果查询只**加入已在飞的水位**（视图 + runtime），绝不创建：它既不是激活
    // 触发器，也不属于 runtime-ready 门槛（view-only 会话上它必须照常可用）。
    // 水位失败也不影响查询：它只做排序约束，真实结论在 inbox 的幂等表里。
    await Promise.all(
      params.commands.map(async (key) => {
        if (key.sessionId === null) return;
        await this.awaitExistingViewFlight(key.sessionId).catch(() => undefined);
        const flight = this.runtimeReadyFlights.get(key.sessionId);
        if (flight) await flight.promise.catch(() => undefined);
      }),
    );
    return commandsQueryResultSchema.parse({
      results: await this.inbox.query(params.commands),
    });
  }

  getQueueItem(sessionId: string, queueItemId: string): QueueItem | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
    return item ?? null;
  }

  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.kind === kind),
    );
  }

  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue"): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
    );
  }

  /**
   * 队列长度（投影事实）。**读不到返回 `undefined`，不再是 0**（cr-func P2-3）：
   * publisher 未注册/未就绪时 `?? 0` 会伪造「空队列」，而暂停位派生规则
   * （`deriveQueueAutoDrain`）与 stop 的「拦下后续项」都以「只有明确的 0 才放行」
   * 为前提——伪造空会让他们把存活项放走。调用方一律按「无法证明为空」处理。
   */
  getQueueLength(sessionId: string): number | undefined {
    return this.publishers.get(sessionId)?.getSnapshot().queue.items.length;
  }

  /**
   * 队列暂停位（投影事实）。派生规则需要「当前位」这一输入：`deriveQueueAutoDrain`
   * 只在目标位 ≠ 现值时才写，避免每次结构事件都追加一条同值 `QueueAutoDrainChanged`。
   *
   * 读不到返回 `undefined`（不再伪造 `true`）：`?? true` 等于「已放行」，会让
   * 「读不到就保持现值/不得放行」的规则失效（同一处 fail-open，cr-func P2-3）。
   */
  getQueueAutoDrain(sessionId: string): boolean | undefined {
    return this.publishers.get(sessionId)?.getSnapshot().queue.autoDrain;
  }

  /** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */
  hasResidencyBlockingCommands(sessionId: string): boolean {
    // 这里保留 `?? 0` 是有意的：publisher 缺席 = 该会话没有可回收的投影队列，
    // 不是「读不到暂停判据」；回收保护只看「有没有确定存在的项」。
    return (this.getQueueLength(sessionId) ?? 0) > 0 || this.inbox.hasPinnedSessionState(sessionId);
  }

  getQueueHead(sessionId: string): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items[0];
    if (!snapshot || !item) return null;
    return {
      autoDrain: snapshot.queue.autoDrain,
      dispatchState: item.dispatch.state,
      kind: item.kind,
      queueItemId: item.queueItemId,
      text: item.text,
    };
  }

  /**
   * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
   * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
   */
  getInputRoutingMode(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
    return this.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
  }

  getSessionFollowupMode(sessionId: string): "queue" | "guide" | null {
    return this.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
  }

  /**
   * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
   * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
   */
  getMessageIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
  }

  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ) {
    return this.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
  }

  /** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */
  getMessageIdsForTurnRow(sessionId: string, rowId: number): string[] {
    return this.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
  }

  /** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */
  isLatestAssistantSegmentRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
  }

  resolveStableForkCandidate(sessionId: string, rowId: number) {
    return this.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
  }

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
  }

  /** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */
  isLatestEditableUserRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
  }

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  getTurnIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
  }

  /**
   * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
   * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
   */
  getTurnRewindAnchor(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
  }

  /** 会话关闭：清 publisher 与其全部订阅调度；hydration 标记同清（重开走冷启动重建）；
   *  并从其 workspace index 移除该会话（session.removed 推给列表订阅者）。 */
  disposeSession(sessionId: string): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: false,
      notifyIndexRemoved: true,
    });
  }

  /**
   * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
   * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
   * 保留，再次订阅经冷恢复透明重建。
   */
  deactivateSession(sessionId: string): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: true,
      notifyIndexRemoved: false,
    });
  }

  /**
   * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
   * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
   */
  assertSessionRuntimeDeactivatable(sessionId: string): void {
    if (!this.inbox.hasPinnedSessionState(sessionId)) return;
    throw new Error(`Session command inbox is still pinned: ${sessionId}`);
  }

  /** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */
  hasConversationSubscribers(sessionId: string): boolean {
    return this.publishers.get(sessionId)?.hasSubscribers() ?? false;
  }

  /**
   * 内存诊断计数器。只读 size，不触碰状态。
   * detachedLive 用于观察子 session publisher 是否随父 session 释放。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    return {
      publishers: this.publishers.size,
      detachedLive: this.detachedLiveSessions.size,
      detachedTerminal: this.detachedTerminalAt.size,
      rawSeqStates: this.rawSequenceStates.size,
    };
  }

  private cleanupSessionRuntime(
    sessionId: string,
    options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
  ): void {
    if (options.clearCommandInbox) {
      // 清掉 in-flight/live 命令会破坏幂等与 FIFO。resident facts 已在回收前
      // 拦截；若这里仍命中，必须在拆 publisher 之前失败，不能留下半清状态。
      this.assertSessionRuntimeDeactivatable(sessionId);
    }
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.disposed",
        `conversation session disposed while waiting for projection event commit: ${sessionId}`,
      ),
    );
    this.attachmentUploads.clearSession(sessionId);
    for (const [key, entry] of this.binaryReadCache) {
      if (entry.sessionId === sessionId) this.deleteBinaryReadCacheEntry(key);
    }
    if (options.notifyIndexRemoved) {
      // 先取 workspaceId（会话 record 还在时），把 session.removed 推给列表订阅者。
      try {
        const workspaceId = this.host.getSessionWorkspaceId?.(sessionId) ?? null;
        if (workspaceId !== null) {
          const indexPublisher = this.indexPublishers.get(workspaceId);
          // 无订阅者时也必须先更新 projection，避免已有 publisher 在下次
          // subscribe 的 snapshot 中复活已删除会话；flushIndex 对空订阅自然 no-op。
          if (indexPublisher?.removeSession(sessionId)) {
            this.flushIndex(workspaceId);
          }
        }
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.remove", error);
      }
    }
    this.indexFanoutThrottle.clearSession(sessionId);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (state.timer) clearTimeout(state.timer);
      this.flushStates.delete(routeKey);
    }
    this.publishers.delete(sessionId);
    this.hydratedSessions.delete(sessionId);
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) hydrationBuffer.cancelled = true;
    this.hydrationBuffers.delete(sessionId);
    this.hydrationInFlight.delete(sessionId);
    // 两条水位 + 三态里的 viewOnly 半边一起清：会话被关掉之后「视图还在」不再是事实，
    // runtime 的 settle 结论也不能留下来（下一次冷开必须重新判，且 runtimeReadyMs 的口径是
    // 「本进程内这次激活」而不是「历史上激活过」）。
    this.viewReadyFlights.delete(sessionId);
    this.runtimeReadyFlights.delete(sessionId);
    this.viewReadySessions.delete(sessionId);
    // 会话被关掉后「欠一次派生量补种」不再是事实：下一次冷开会按当时的 record 形态重新判定。
    this.runtimeFactsPending.delete(sessionId);
    // 激活结论同样不能留下：会话被关掉之后「runtime 就绪」不再是事实，下一次冷开必须
    // 重新判（否则重建出的 view-only shell 会继承上一条 record 的就绪结论）。
    this.runtimeReadySessions.delete(sessionId);
    this.rawSequenceStates.delete(sessionId);
    if (options.clearCommandInbox) this.inbox.clearSession(sessionId);
    this.telemetryNormalizer.clearSession(sessionId);
    this.detachedLiveSessions.delete(sessionId);
    this.projectionFaultedSessions.delete(sessionId);
    // detached child 归属清理：自己作为 child 从父表摘除；作为父则连带释放没有 record 的 child。
    this.detachedTerminalAt.delete(sessionId);
    const parentId = this.detachedChildParent.get(sessionId);
    if (parentId !== undefined) {
      this.detachedChildParent.delete(sessionId);
      const siblings = this.detachedChildrenByParent.get(parentId);
      siblings?.delete(sessionId);
      if (siblings && siblings.size === 0) this.detachedChildrenByParent.delete(parentId);
    }
    const children = this.detachedChildrenByParent.get(sessionId);
    if (children) {
      this.detachedChildrenByParent.delete(sessionId);
      for (const childId of children) {
        this.detachedChildParent.delete(childId);
        // 同 prune：只判 record 归属，不判 live（child 本身就在 detachedLiveSessions 里）。
        if (this.hasHostRecord(childId)) continue;
        this.releaseDetachedChild(childId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const sessionId of this.projectionEventCommitWaiters.keys()) {
      this.rejectProjectionEventWaiters(
        sessionId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway disposed while waiting for projection event commit",
        ),
      );
    }
    clearInterval(this.attachmentPruneTimer);
    this.indexFanoutThrottle.clear();
    this.attachmentUploads.clear();
    this.binaryReadCache.clear();
    this.binaryReadCacheBytes = 0;
    for (const state of this.flushStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.flushStates.clear();
    this.publishers.clear();
    this.hydratedSessions.clear();
    for (const buffer of this.hydrationBuffers.values()) buffer.cancelled = true;
    this.hydrationBuffers.clear();
    this.lastHydrationPhases.clear();
    this.rowManifestOutcomes.clear();
    this.coldWindowOutcomes.clear();
    this.rowPageOutcomes.clear();
    this.runtimeActivationMs.clear();
    this.hydrationInFlight.clear();
    // 两条水位与三态半边同步清空（IS3 / IS4）：dispose 之后不应留下任何「曾就绪」的事实。
    this.viewReadyFlights.clear();
    this.runtimeReadyFlights.clear();
    this.viewReadySessions.clear();
    this.runtimeReadySessions.clear();
    this.runtimeFactsPending.clear();
    this.rawSequenceStates.clear();
    this.telemetryEventIds.clear();
    this.detachedLiveSessions.clear();
    this.detachedChildParent.clear();
    this.detachedChildrenByParent.clear();
    this.detachedTerminalAt.clear();
    this.projectionFaultedSessions.clear();
    this.coldResume.clear();
    this.indexPublishers.dispose();
    this.configPublishers.clear();
    this.pausedConnections.clear();
  }

  /** 测试探针：立即排空某订阅（绕过定时器）。 */
  flushNow(subscriptionId: string): ConversationTopicFrame | null {
    const match = [...this.flushStates.entries()].find(
      ([, state]) => state.subscriptionId === subscriptionId,
    );
    const state = match?.[1];
    if (!state) return null;
    if (this.pausedConnections.has(state.connectionId)) return null;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const publisher = this.publishers.get(state.sessionId);
    if (!publisher) return null;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * 测试探针 / 诊断：某会话最近一次 manifest 读路径的结论。
   *
   * 生产可观测面是 `v4 row manifest fallback ...` 的 debug 行与 `rowManifestOutcomes`；
   * 这个 getter 让「降级打点」在测试里可断言（不必解析日志）。
   */
  getRowManifestOutcome(sessionId: string): RowManifestOutcomeSummary | null {
    return this.rowManifestOutcomes.get(sessionId) ?? null;
  }

  /** 测试探针 / 诊断：某会话最近一次冷开的尾窗落点（缺席 = 从没窗口化过）。 */
  getColdWindowOutcome(sessionId: string): ColdWindowOutcomeSummary | null {
    return this.coldWindowOutcomes.get(sessionId) ?? null;
  }

  /** 测试探针 / 诊断：某会话最近一次按需物化一页的落点（缺席 = 从没翻过页）。 */
  getRowPageOutcome(sessionId: string): RowPageOutcomeSummary | null {
    return this.rowPageOutcomes.get(sessionId) ?? null;
  }

  private ensurePublisher(sessionId: string): ConversationTopicPublisher {
    let publisher = this.publishers.get(sessionId);
    if (!publisher) {
      publisher = new ConversationTopicPublisher(sessionId, this.createLogEpoch(sessionId), {
        now: this.now,
        // IS3/IS8：runtime 态在**帧编码边界**注入（投影保持事件派生的确定性）。
        // provider 每帧读一次，所以激活完成后的下一帧起就自动变回 live，不需要二次接线。
        sessionRuntime: () => this.sessionRuntimeAvailability(sessionId),
      });
      this.publishers.set(sessionId, publisher);
      // config 种子：创建即注入 runtime 真值（不产 delta / 不 bump revision）。
      this.seedPublisherConfig(sessionId, publisher);
    }
    return publisher;
  }

  /**
   * 会话对外的 runtime 态（IS3/IS8 的唯一口径）。
   *
   * `viewOnly` 只在「视图已就绪、runtime 未就绪」时成立——这正是 Step 9 拆开后的常态。
   * 其余（视图还没水化、或 runtime 已就绪）一律 `live`：schema 的默认值就是 live，
   * 在「还不知道」时下发 view-only 会让客户端把一条正常会话的编辑入口全锁掉。
   */
  private sessionRuntimeAvailability(sessionId: string): SessionRuntimeAvailability {
    if (this.isRuntimeReady(sessionId)) return "live";
    return this.viewReadySessions.has(sessionId) ? "viewOnly" : "live";
  }

  /**
   * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
   * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
   * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
   * 事件接线期间），hydration 处补一次兜住该窗口。
   */
  private seedPublisherConfig(sessionId: string, publisher: ConversationTopicPublisher): void {
    const getSeed = this.host.getSessionConfigSeed;
    if (!getSeed) return;
    try {
      const seed = getSeed.call(this.host, sessionId);
      if (seed) publisher.seedConfig(seed);
    } catch (error) {
      this.host.onError?.("v4.configSeed", error);
    }
  }

  /**
   * 冷会话「视图就绪」的唯一入口：**视图水位**（`viewReadyFlights`）的单飞。
   *
   * 两件事按顺序发生：**物化 view-only 外壳**（store 读 session + 首屏种子，
   * `createRecord(resume:false)`；Step 8 及以前这里是「等一次 runtime 激活」）→ hydration。
   * 视图水化成功后登记 `viewReadySessions`/`hydratedSessions`。
   *
   * 读与翻页**只**等这一层（IS3 的 view 半边）；它们不该因为「runtime 还没激活」而被拒，
   * 也不该反过来替命令触发激活。**激活只能来自** ACK 之后的后台预激活
   * （`prewarmRuntimeAfterViewAck`）与 send 类命令——那两处都在本函数之外。
   *
   * 调用方**不止冷订阅**：`rowsRange`、`turnDirectory`、`plans`、`fileChanges`、附件读面
   * 都经 `resolveViewPublisher` 走到这里。Step 9 之前本函数也是 `runtimeReadyMs` 的生产链
   * （内部等激活）；现在激活本体归 `ensureRuntimeReady`，读路径不再产生那份耗时。
   *
   * Step 11：视图**已经**可读时本函数直接早退（`readableViewPublisher`），不再物化外壳。
   * 这条早退同时覆盖「读入口先水化、随后冷订阅再进来」的顺序——否则那次订阅会把外壳
   * 再物化一遍（= 一次冷开），而它的投影其实已经建好了。
   */
  private ensureViewReadyPublisher(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ConversationTopicPublisher> {
    const existingFlight = this.viewReadyFlights.get(sessionId);
    if (existingFlight) return existingFlight;
    // Step 11：视图已可读 → 直接返回这份投影，**不再**物化外壳。这里也会被 subscribe 走到
    // （冷会话订阅的入口就是本函数），所以修在这里才能覆盖「读入口先水化、随后订阅」这条
    // 真实顺序：以前那次订阅会把外壳再物化一遍（`materializeSessionShell` 在生产宿主里对
    // 已在册的 record 早退，但外壳物化本身在 record 被回收时就是一次完整冷开）。
    const readable = this.readableViewPublisher(sessionId);
    if (readable !== undefined) return Promise.resolve(readable);
    // 先登记同一个 READY，再开始所有耗时工作。
    const operation = Promise.resolve().then(async () => {
      // Step 9：视图只等外壳。**不要**在这里再调 `ensureRuntimeReady`——那会让首屏重新
      // 串上激活（MCP/技能/MEMORY.md 的装载），正是本步要拆掉的东西。
      const resumedMessages = await this.ensureViewShell(sessionId, resumeThoughtLevel, workspace);
      return this.hydratePublisher(sessionId, resumedMessages);
    });
    this.viewReadyFlights.set(sessionId, operation);
    // 成功和失败都由同一清理函数释放；不创建会重复传播 rejection 的派生 promise。
    const clear = () => {
      if (this.viewReadyFlights.get(sessionId) === operation) {
        this.viewReadyFlights.delete(sessionId);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  /**
   * 视图水位的「物化外壳」一步（IS3 / Step 9）。
   *
   * 有 `host.materializeSessionShell` → 只建 view-only 外壳，返回 undefined（正文由
   * store-only hydration 自己读，不再依赖 resume 的返回值）。
   * 没有 → 退回 Step 8 的「先激活再建投影」，并把 resume 读到的正文带回去（行为不变）。
   */
  private async ensureViewShell(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    if (!this.host.materializeSessionShell) {
      return await this.ensureRuntimeReady(sessionId, resumeThoughtLevel, workspace);
    }
    await this.coldResume.ensureShellMaterialized(sessionId, resumeThoughtLevel, workspace);
    return undefined;
  }

  /**
   * **runtime 水位**（`runtimeReadyFlights`）的唯一入口：runtime 激活的单飞。
   *
   * 口径钉死为**激活本体耗时** = `coldResume.ensureResumed` 的耗时，不是「从 ACK 起算」：
   * 阶段 0 激活在 ACK 之前（按 ACK 起算会是负数），阶段 8 拆开之后激活在 ACK 之后
   * （按 ACK 起算会把等待算进去）。只有本体耗时能跨阶段比较，所以写入点挪到哪里都只写这一段。
   *
   * 三个调用方：①`ensureViewShell` 的降级分支（旧宿主没有 `materializeSessionShell`
   * 时的 Phase-8 行为；生产宿主不会走到）②ACK 之后的后台预激活 ③send 类命令（唯一允许
   * 「当场启动」的触发器）。**不在这里判 workspace/thoughtLevel**：
   * 首个调用方给什么就用什么，后续加入者复用同一份 flight（与 `coldResume` 的单飞一致）。
   *
   * 结论语义：成功 → 条目驻留并置 `activated`（`conversation/runtimeReady` 读它）；
   * 失败 → 条目删除（下一次触发可重试，与 `coldResume` 自己的 settle 即释放一致）。
   */
  private ensureRuntimeReady(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const existing = this.runtimeReadyFlights.get(sessionId);
    if (existing) return existing.promise;
    // 已经是 live runtime 的会话（热切换 / detached live child）：不重复 resume。
    // `runtimeActivationMs` 保持缺席（缺席 ≠ 0：本进程没观测到一次激活）。
    if (this.conversationState(sessionId) === "live") {
      // 这也是一条激活结论：runtime 早在别处起来了，本进程不需要再激活一次。
      this.runtimeReadySessions.add(sessionId);
      return Promise.resolve(undefined);
    }
    const activationStartedAt = performance.now();
    // promise 在 flight 上回填（结论要靠 flight 的同一性做「只删自己」判定）。
    const flight: RuntimeReadyFlight = { activated: false, promise: Promise.resolve(undefined) };
    flight.promise = (async () => {
      try {
        const persistedMessages = await this.coldResume.ensureResumed(
          sessionId,
          resumeThoughtLevel,
          workspace,
        );
        flight.activated = true;
        this.runtimeReadySessions.add(sessionId);
        this.runtimeActivationMs.set(
          sessionId,
          Math.max(0, Math.round(performance.now() - activationStartedAt)),
        );
        // fix-c19：激活成功 → 补齐只有 runtime 才知道的派生量（usage / config 种子）。
        // **必须在激活本体之后**（激活前那两个宿主端口只会给出空值），且 fire-and-forget
        // （激活的读数是「本体耗时」，不能被这次补种污染；send 类命令也不该为它多等）。
        // 行集合不动：窗口化首屏就是终态，翻页由 `rows/range` 按需物化。
        this.scheduleRuntimeFactsSeed(sessionId, "runtimeActivated");
        return persistedMessages;
      } catch (error) {
        // 失败不驻留：并发加入者手里仍有同一个 promise（看到同一个错误），但表里清掉，
        // 下一次订阅/发送可以重新尝试激活。
        if (this.runtimeReadyFlights.get(sessionId) === flight) {
          this.runtimeReadyFlights.delete(sessionId);
        }
        throw error;
      }
    })();
    this.runtimeReadyFlights.set(sessionId, flight);
    return flight.promise;
  }

  /**
   * 激活后补齐**只有 runtime 才知道的派生量**（fix-c19，取代 Step 10 的「升级成全量投影」）。
   *
   * 补的是什么：`usage`（上下文占用 / 分母）与 config 种子（`thoughtLevels` /
   * `planEnabled` / `permissionGrant`）。它们在 view-only 首屏**刻意缺席**（读不到就留空，
   * 不拿默认模型编一个更误导的值），而宿主那两个端口在激活后就能直接给出真值。
   *
   * 补的**不是**行：投影的行集合由 manifest 给（IS5），窗口以上的页由 `rows/range` 按需
   * 物化。旧实现（Step 10 的「升级成全量投影」）用一次 `forceRebuild` 的整份重读把整条
   * 分支（实测 5255 行）灌进 live 投影，代价是 398MB 堆与 450 → 2327ms 的切回（风险 24）；
   * 而它换来的能力按需路径本来就有。那条路径已删除，这里只剩两个宿主端口的窄读。
   *
   * **两个触发点，互不依赖先后**（沿用 Step 15 的结论）：激活成功分支与
   * `performHydration` 收口各调一次。app 冷启最常见顺序是「激活先完成」（journal 读入口在
   * 点击前就 `await ensureRuntimeReady`），那时 `runtimeFactsPending` 还没写；只挂激活分支
   * 就会永久缺席。
   *
   * 幂等边界：flag 谁先到谁消费（`delete` 之后不再排）；激活未就绪时不消费（等激活来排）。
   * 补种是**幂等**的（`seedConfig` 跳过事件触碰过的字段，`seedUsage` 覆盖同值），因此
   * 不需要「在飞」登记——一次订阅生命周期内最多一份，且不碰任何行。
   *
   * fire-and-forget：失败只记账，绝不回传给已经成功的激活调用方。
   *
   * 耗时只进 debug（不进 `openPhases` / `openTiming`：ACK 在激活之前，那两个口径装不下
   * 激活之后的成本）。
   */
  private scheduleRuntimeFactsSeed(
    sessionId: string,
    reason: "runtimeActivated" | "firstScreenSettled",
  ): void {
    if (this.disposed) return;
    if (!this.runtimeFactsPending.has(sessionId)) {
      // 本次首屏不是 view-only 口径（正文与 runtime 事实都齐）：不欠补种。
      this.host.onDebug?.(
        `v4 runtime facts seed skipped session=${sessionId} reason=notPending trigger=${reason}`,
      );
      return;
    }
    if (!this.isRuntimeReady(sessionId)) {
      // flag 保留：激活分支（`trigger=runtimeActivated`）会再来一次。
      this.host.onDebug?.(
        `v4 runtime facts seed deferred session=${sessionId} reason=runtimeNotReady trigger=${reason}`,
      );
      return;
    }
    // 先消费事实：一次订阅生命周期内补种一次即可（激活后 runtime 真值不会自己变回去）。
    this.runtimeFactsPending.delete(sessionId);
    const startedAt = performance.now();
    void this.seedRuntimeFacts(sessionId).then(
      () => {
        const seedMs = Math.max(0, Math.round(performance.now() - startedAt));
        this.host.onDebug?.(`v4 runtime facts seed applied session=${sessionId} seedMs=${seedMs}`);
      },
      (error: unknown) => {
        // 下一次冷开会按当时的 record 形态重新判定（不轮询重试）。
        this.host.onDebug?.(`v4 runtime facts seed skipped session=${sessionId} reason=seedFailed`);
        this.host.onError?.("v4.runtime.runtimeFactsSeed", error, { sessionId });
      },
    );
  }

  /**
   * 派生量补种的执行体：**只读宿主端口，不读 store、不重建投影**。
   *
   * - `seedPublisherConfig`：同步读 `getSessionConfigSeed`（runtime 真值；view-only shell
   *   那条分支返回外壳物化时的持久窄查询结果，激活后自然换成真值）；
   * - `seedPublisherUsage`：`getSessionUsageSeed` 在 shell 期返回 null、激活后给出真值。
   *
   * 两者都只改投影初值、不产生 delta，所以补偿后必须让现有订阅 resync 一次
   * （`requireSnapshotResync` + 驱动 flush），否则用户要等到下一个事件才看见。
   */
  private async seedRuntimeFacts(sessionId: string): Promise<void> {
    const publisher = this.publishers.get(sessionId);
    // 窗口化首屏的投影可能已经被 dispose（会话关闭）——那就没什么可补的。
    if (publisher === undefined) return;
    this.seedPublisherConfig(sessionId, publisher);
    await this.seedPublisherUsage(sessionId, publisher);
    if (this.disposed || this.publishers.get(sessionId) !== publisher) return;
    publisher.requireSnapshotResync();
    this.resyncSessionSubscribers(sessionId, publisher, "runtimeFactsResync");
  }

  /**
   * 视图 ACK 之后的后台 runtime 预激活（**IS3 的激活触发点**，spec 明文要求）。
   *
   * 调用点在 `subscribeReserved` 返回帧之前、帧编码之后：它 fire-and-forget，绝不 await，
   * 因此不落在本次 RPC 的关键路径上——多数情况下用户看到历史时 runtime 已在就绪路上。
   * 失败只经 `onError` 记账（结论同时记在 `runtimeReadyFlights` 上，供
   * `conversation/runtimeReady` 读）。
   *
   * 阶段 9 起它是**首屏唯一的自动激活来源**：视图水位只物化外壳（不 resume），因此这条
   * fire-and-forget 是「用户看到历史之后 runtime 才开始起来」的唯一接线点。它必须留在
   * `subscribeReserved` 里、帧编码之后（源码守卫 F1 锁位置）——挪进视图水位就会把激活
   * 耗时重新算进 `viewReadyMs`，删掉则首屏永不自动激活（死锁）。
   */
  private prewarmRuntimeAfterViewAck(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): void {
    if (this.disposed) return;
    // 已在飞 / 已成功 / 已失败（条目已删）都以水位表为准，不在这里重判。
    if (this.runtimeReadyFlights.has(sessionId)) return;
    if (this.conversationState(sessionId) === "live") return;
    void this.ensureRuntimeReady(sessionId, resumeThoughtLevel, workspace).catch((error) => {
      this.host.onError?.("v4.runtime.prewarm", error, { sessionId });
    });
  }

  /**
   * 读 / 翻页取 publisher 的唯一入口（IS3 的 view 半边）。
   *
   * 取代过去在每个只读方法里各抄一遍的 `readyFlights → hasLiveConversation →
   * ensureColdReadyPublisher / hydratePublisher` 三段式：读的语义只有一种——「给我一个
   * 可读的投影」。live 会话直接 hydration；冷会话走视图水位（**只物化外壳 + 建投影，
   * 不牵扯激活**；Step 9）。
   */
  private async resolveViewPublisher(sessionId: string): Promise<ConversationTopicPublisher> {
    const existingFlight = this.viewReadyFlights.get(sessionId);
    if (existingFlight) return existingFlight;
    // Step 11：视图已可读就不再走冷路径。这才是「翻页/重订不触发第二次冷开」的接缝——
    // 放在这里而不是各读方法里，是因为读入口很多（见 `ensureViewReadyPublisher` 的调用方）。
    const readable = this.readableViewPublisher(sessionId);
    if (readable !== undefined) return readable;
    if (this.conversationState(sessionId) === "notLive") {
      return this.ensureViewReadyPublisher(sessionId);
    }
    return this.hydratePublisher(sessionId);
  }

  /**
   * 「视图已可读」时直接给出投影，否则 undefined（调用方退回冷路径）。**唯一**判定点。
   *
   * 两个条件缺一不可：
   *   ①有一次成功的视图水化（`viewReadySessions`，IS4 的 viewOnly 半边）；
   *   ②投影还在（`publishers`）且防双算水位在册（`hydratedSessions`）。
   *
   * fix-c19 之后③只剩前半。旧实现的「升级在飞」那半条是为「升级会先删
   * `hydratedSessions`」让路的；全量升级已删，投影在订阅生命周期内**不会**被换掉，
   * 因而这里也不存在「可读但不在水位里」的窗口。
   *
   * 但②的后半**不能**退化成「只要 `viewReadySessions`」：水化失败时 `hydratedSessions`
   * 不会登记，那时读入口必须退回冷路径重读一次（自愈）——否则一次失败的 rehydrate 会把
   * 半成品投影钉到会话关闭为止。
   */
  private readableViewPublisher(sessionId: string): ConversationTopicPublisher | undefined {
    if (!this.viewReadySessions.has(sessionId)) return undefined;
    const publisher = this.publishers.get(sessionId);
    if (publisher === undefined) return undefined;
    if (this.hydratedSessions.has(sessionId)) return publisher;
    return undefined;
  }

  /**
   * 读入口的「等已在飞的视图水化」版本：不创建 flight、不触发冷开。
   *
   * 只给「本来就是 live 会话的附加只读能力」用（dwf journal 读取等）；冷会话若也要读，
   * 应当显式走 `resolveViewPublisher` 而不是在这里顺手激活。
   */
  private async awaitExistingViewFlight(sessionId: string): Promise<void> {
    const flight = this.viewReadyFlights.get(sessionId);
    if (flight) await flight;
  }

  /**
   * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
   * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
   */
  private hydratePublisher(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existing = this.publishers.get(sessionId);
    // 已 hydrate 过的 live publisher：直接复用（避免重复重建 / 双计）。
    if (existing && this.hydratedSessions.has(sessionId)) return Promise.resolve(existing);

    const inFlight = this.hydrationInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const buffer: HydrationBuffer = {
      cancelled: false,
      eventIds: new Set<string>(),
      rawEvents: [],
    };
    this.hydrationBuffers.set(sessionId, buffer);
    const hydration = this.performHydration(
      sessionId,
      buffer,
      persistedMessages,
      forceRebuild,
    ).finally(() => {
      if (this.hydrationBuffers.get(sessionId) === buffer) {
        this.hydrationBuffers.delete(sessionId);
      }
      if (this.hydrationInFlight.get(sessionId) === hydration) {
        this.hydrationInFlight.delete(sessionId);
      }
    });
    this.hydrationInFlight.set(sessionId, hydration);
    return hydration;
  }

  private async performHydration(
    sessionId: string,
    buffer: HydrationBuffer,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existingAtStart = this.publishers.get(sessionId);
    // 诊断字段 `liveSessionAtStart` 沿用 live 语义（IS4）：detached child 也算 live。
    const liveSessionAtStart = this.conversationState(sessionId) === "live";
    const hydrationStartedAt = performance.now();
    // openPhases 的 merge / rehydrate 分段：本函数是唯一产生点（早退分支只有 merge 段）。
    const phases: HydrationPhases = {};
    this.lastHydrationPhases.set(sessionId, phases);
    this.host.onDebug?.(
      `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
        `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
        `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
    );
    const mergeStartedAt = performance.now();
    // 读失败必须与「读到空」分开：两者过去共用同一个空结果，于是一次抛错被当成
    // 「持久事实变少了」——rehydrate 空事件把投影清空、`sourceEventSeq: 0` 把 raw 游标
    // 打回起点，之后每个 live 事件都卡在「等 seq=1」的 gap 上（静默停摆到重开）。
    // `loadFailed` 只在本方法内部消费，宿主契约不变。
    let loadFailed: unknown = null;
    const loaded: PersistedEventsLoadResult = this.host.loadPersistedEvents
      ? await this.host
          .loadPersistedEvents(sessionId, persistedMessages)
          .catch((error: unknown) => {
            loadFailed = error;
            return NO_PERSISTED_EVENTS;
          })
      : NO_PERSISTED_EVENTS;
    // 持久事件合并 / transcript 合成 → openPhases.mergeMs。
    phases.mergeMs = Math.max(0, Math.round(performance.now() - mergeStartedAt));
    // 尾窗坐标（Step 6）：宿主声明「本次 events 只覆盖窗口内的整轮」时才存在。
    // 全量物化时缺席，后面三步（rowIdOrigin / fullyMaterialized / ordinalBase）全部沿用旧语义。
    // 落点等「确实重物化了」再记（下面的早退分支会保留既有 live publisher，窗口并未生效）。
    const coldWindow = loaded.coldWindow;

    this.host.onDebug?.(
      `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
        `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
        `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
    );

    if (this.disposed || buffer.cancelled) {
      throw new Error(`v4 hydration cancelled for session ${sessionId}`);
    }

    if (loadFailed !== null) {
      // 一次失败的持久读取没有提供任何「事实变少了」的证据，所以这里**不 swap**：
      // 保留上一次成功水化（或 live 事件喂出来）的投影，并原样保留 raw 游标。
      // 生产里的主要来源是「live publisher 已存在、首次 subscribe 才水化」与
      // 授权提交失败重放（`waitForPermissionGrantCommit`）。
      return this.keepProjectionAfterLoadFailure(sessionId, loadFailed, {
        durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
        existingPublisherAtStart: existingAtStart !== undefined,
        forceRebuild,
        liveSessionAtStart,
        persistedMessages: persistedMessages?.length ?? 0,
        phases,
      });
    }

    // assistant 守恒：拒收过正文流的 publisher 不可信——它建立于
    // TurnStarted 之后，缺段无法用 append-only 重放补进中间位置，只能整体重建。
    const latestPublisher = this.publishers.get(sessionId);
    const existingDroppedContent =
      latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
    // 事件日志完整（synthesized=false）且已有健康 live publisher（流式）→ 保留，不重放。
    if (
      existingAtStart &&
      latestPublisher === existingAtStart &&
      !loaded.synthesized &&
      !forceRebuild &&
      !existingDroppedContent
    ) {
      // 创建时种子可能落空（record 尚未入册），首次订阅补一次（幂等、事件优先）。
      this.hydrationBuffers.delete(sessionId);
      this.seedPublisherConfig(sessionId, latestPublisher);
      if (loaded.branchGeneration !== undefined) {
        latestPublisher.seedBranchGeneration(loaded.branchGeneration);
      }
      if (loaded.sharedContextImport) {
        latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
      }
      await this.seedPublisherUsage(
        sessionId,
        latestPublisher,
        persistedMessages,
        loaded.usageSeed,
      );
      this.markViewReady(sessionId);
      this.publishCurrentSummaryToIndex(sessionId);
      // 早退分支没有 rehydrate：只落 merge 段与收口时刻，读端按缺席处理 rehydrateMs。
      phases.finishedAtMs = performance.now();
      return latestPublisher;
    }

    // 只记住 await 之前的 existing 引用是不够的：load 等待期间 raw event
    // 会继续推进这个 publisher，synthesized 返回后却把它整体删除，queue/stream 随之
    // 消失。重建以 sourceEventSeq 为 raw snapshot 边界，并把等待窗口内事件补回。
    // fix-c19：到这里才是本次投影真的被物化了。首屏按 **view-only 口径**读（record 还是
    // shell / 没有 record）⇒ runtime-only 的派生量（usage / config 种子）缺席，记一笔
    // 「激活后补一次」。**窗口化本身不再记**：窗口只裁正文，行集合与全量一致（IS1/IS2），
    // 而 manifest 是行数的权威——把整条分支灌进 live 投影正是风险 24（398MB / 5 倍切回）。
    if (loaded.viewOnlyHydration === true) {
      this.runtimeFactsPending.add(sessionId);
    }
    const publisher = latestPublisher ?? existingAtStart ?? this.ensurePublisher(sessionId);
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.rehydrated",
        `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
      ),
    );
    const rehydrateStartedAt = performance.now();
    if (coldWindow !== undefined) {
      // 到这里才是真的用窗口重物化了（早退分支保留 live publisher，不消费 events）。
      this.coldWindowOutcomes.set(sessionId, {
        ordinal: coldWindow.ordinal,
        rowIdBase: coldWindow.rowIdBase,
        rowCount: coldWindow.rowCount,
        turnCount: coldWindow.turnCount,
        limitBefore: coldWindow.limitBefore === null ? null : String(coldWindow.limitBefore),
        applied: true,
        at: Date.now(),
      });
    }
    // fix-c19：升级（同一条分支的窗口投影 → 全量投影）已经不存在，这里**不再**为它把旧
    // 清单事实带过 `rehydrate → hydrateRowManifest` 的过渡（风险 25 的修法随之退场）。
    // 唯一还会 rehydrate 的路径（`keepProjectionAfterLoadFailure` 之后的授权重放）本来就
    // 可能换分支代次，继续按「旧基线一律失效」清掉才是安全的一侧。
    publisher.rehydrate(loaded.events, {
      // 恢复时 transcript/event store 可能仍含运行期已拒绝的超大正文。不能让同一事实
      // 在 CLI 重启后再次把 subscribe 卡死；跳过该不可传输 projection event，继续归约
      // 后续持久 TurnError/TurnComplete，使冷快照停在最后一个可恢复边界。
      onPayloadTooLarge: (error) =>
        this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "publisher.rehydrate",
          sessionId,
        }),
      // 冷窗口的 rowId 起点（IS1）：全量物化恒为 1（不出现在这里）。
      // 播种点必须在「候选投影建好、首次 ingest 之前」——rehydrate 内部就是这么做的；
      // 放到 rehydrate 之后会因「已有行」直接抛错（刻意的失败模式）。
      ...(coldWindow === undefined ? {} : { rowIdOrigin: coldWindow.rowIdBase }),
      // 窗口的上一轮模型基线：与 rowIdOrigin 同一个播种时机，漏了会让窗首那一轮的
      // `modelChange` marker 消失（窗内 rowId 整体前移 1）。
      ...(loaded.synthesisModelBaseline === undefined
        ? {}
        : { modelBaseline: loaded.synthesisModelBaseline }),
    });
    // 投影重建（全量事件重放）→ openPhases.rehydrateMs。
    phases.rehydrateMs = Math.max(0, Math.round(performance.now() - rehydrateStartedAt));
    // 代次种子放在 rehydrate 之后：rehydrate 会换掉 projection，而 synthesized transcript
    // 里没有 RewindTriggered，事件重放推不出代次（会停在 0，manifest 键控到错的代次上）。
    if (loaded.branchGeneration !== undefined) {
      publisher.seedBranchGeneration(loaded.branchGeneration);
    }
    if (loaded.sharedContextImport) {
      publisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
    // 同次恢复的种子先应用，再补 live buffer；较新的使用量和选模事件始终获胜。
    if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
    const sourceEventSeq = Math.max(
      0,
      loaded.sourceEventSeq ??
        (loaded.synthesized
          ? 0
          : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
    );
    const previousSequenceState = this.rawSequenceStates.get(sessionId);
    const sequenceState: RawSequenceState = {
      sourceEventSeq,
      offset: publisher.getSnapshot().seq - sourceEventSeq,
      lastTransportSeq: publisher.getSnapshot().seq,
      seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
      appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
      failedEventById: new Map(previousSequenceState?.failedEventById),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, sequenceState);
    // 持久读取的 sourceEventSeq 是 load 开始时的水位；hydration buffer
    // 只能记录 load 开始后的事件。若 seq=N 已在 buffer 创建前进入 live publisher，而
    // load 只读到 N-1 时，rehydrate 后不能仅重放 N+1：raw reorder 会永久等待已经被
    // 丢掉的 N，连带让 running Agent 控制行消失。保留与 publisher 相同大小的 raw tail，
    // 与 await 窗口 buffer 合并后从持久边界连续重放。
    const replayByEventId = new Map<string, SessionEvent>();
    for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    for (const rawEvent of buffer.rawEvents) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    const replayEvents = [...replayByEventId.values()].sort((left, right) => {
      if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
        return left.sequenceNumber - right.sequenceNumber;
      }
      if (left.sequenceNumber > 0) return -1;
      if (right.sequenceNumber > 0) return 1;
      return 0;
    });
    for (const rawEvent of replayEvents) {
      for (const normalized of this.normalizeRuntimeEventSequence(sessionId, rawEvent)) {
        // 补回的 buffer 事件绕过了 ingestNormalizedEvent（直接进 publisher），因此
        // manifest 的两个写入点必须在这里各补一次，否则 hydration 窗口内结束的 turn
        // 与发生于该窗口的 rewind 都不会落到 manifest 上。
        const manifestBranchBefore =
          normalized.type === SessionEventType.RewindTriggered
            ? publisher.getTurnManifestBranchState()
            : null;
        try {
          publisher.ingest(normalized);
          this.resolveProjectionEventCommit(sessionId, String(normalized.id));
        } catch (error) {
          this.rejectProjectionEventCommit(
            sessionId,
            String(normalized.id),
            new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply hydrated event ${String(normalized.id)}`,
              { cause: error },
            ),
          );
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
            phase: "replayBufferedEvents",
            sessionId,
          });
          continue;
        }
        this.recordTurnManifestForEvent(sessionId, normalized, publisher);
        if (manifestBranchBefore !== null) {
          this.rewriteTurnManifestBranchForRewind(sessionId, publisher, manifestBranchBefore);
        }
      }
    }
    // publisher 已替换且 buffer 已同步补齐；在 usage seed 的异步等待窗口内，新 raw
    // event 直接走上面的 per-session sequence state 进入新 publisher，不再需要二次 replay。
    if (this.hydrationBuffers.get(sessionId) === buffer) {
      this.hydrationBuffers.delete(sessionId);
    }
    // 冷恢复种子（重放之后）：resume 已把历史会话的上次选型写回 runtime
    // （reconcileResumedRuntimeSettings），而合成/持久化事件里可能没有 ModelSelected——
    // 种子只填事件未触碰的字段，日志有值时以日志为准（冷恢复口径）。
    this.seedPublisherConfig(sessionId, publisher);
    if (loaded.usageSeed === undefined) {
      await this.seedPublisherUsage(sessionId, publisher, persistedMessages);
    }
    // IS5 读路径：全量物化已经完成，此时才能拿投影的 turn 序与行数去核对 manifest。
    // 放在 seeds 之后、`hydratedSessions.add` 之前：ACK 的 snapshot 编码必须已经能看到
    // 注入的 manifest 事实（否则首帧的 totalCount 会先按投影现算一次，再被下一帧改掉）。
    // loadPersistedEvents 的产出里可能带**尾窗坐标**（Step 6）：此时投影只物化了窗口，
    // 声明 `fullyMaterialized:false`，且回写必须从窗口 ordinal 起编号、按整条分支剪枝。
    await this.hydrateRowManifest(sessionId, publisher, phases, loaded.coldWindow);
    this.resyncSessionSubscribers(sessionId, publisher);
    this.markViewReady(sessionId);
    this.publishCurrentSummaryToIndex(sessionId);
    phases.finishedAtMs = performance.now();
    // fix-c19：view-only 首屏**收口**是派生量补种的第二个触发点。
    //
    // 只在本次真的记了「欠补种」事实时才调（`notPending` 那条 debug 由激活分支承担，避免
    // 每次 hydrate 都刷一行）。激活已完成的顺序（app 冷启：journal 读入口在点击前就激活）
    // 在这里就能补上；激活尚未完成的顺序由激活分支补。fire-and-forget，不进首帧关键路径。
    if (this.runtimeFactsPending.has(sessionId)) {
      this.scheduleRuntimeFactsSeed(sessionId, "firstScreenSettled");
    }
    return publisher;
  }

  /**
   * 持久读取失败时的**唯一**回落：保留现有投影、原样保留 raw 游标，并记一条可检索的失败。
   *
   * 两条不变量（一次读失败绝不允许破坏它们）：
   *   ① 用户可见的投影行数**不得变少**——读失败不是「历史没了」的证据。过去它带着
   *      `events: []` 流进 `rehydrate`，现象是用户眼前的历史整段消失。
   *   ② live 事件**不得停止前进**——过去同一次回落把 `sourceEventSeq` 交成 0，游标回到
   *      起点而 live raw 序号已在几百上千，随后每个事件都卡在 `sourceEventSeq + 1` 的 gap 上，
   *      投影永远停在空/残状态直到用户重开。
   *
   * 自愈不在本函数里：调用方照常**不**重新登记 `hydratedSessions`，读入口
   * `readableViewPublisher` 的第二个条件因此不成立，下一次读/翻页会退回冷路径再读一次
   * （与「早退不得把缺段的投影钉住」同一条自愈路径）。不在这里轮询重试。
   *
   * 真冷（本来就没有投影）没有「旧投影」可以保留：空投影是唯一诚实的结果（用户眼前本来
   * 就没有历史）。那时也没有 raw 游标可归零，两者一致。
   */
  private keepProjectionAfterLoadFailure(
    sessionId: string,
    error: unknown,
    context: {
      durationMs: number;
      existingPublisherAtStart: boolean;
      forceRebuild: boolean;
      liveSessionAtStart: boolean;
      persistedMessages: number;
      phases: HydrationPhases;
    },
  ): ConversationTopicPublisher {
    const kept = this.publishers.get(sessionId);
    const publisher = kept ?? this.ensurePublisher(sessionId);
    // `kept === undefined`（真冷）时**不建** raw 游标：`.ensurePublisher` 是空投影，游标等到
    // 第一个 live 事件再惰性创建即可（新会话的真实水位就是 0）。这里唯一不能做的事是
    // `rawSequenceStates.delete` / 重建成 0——那正是 gap 死锁的来源。
    this.host.onError?.("v4.hydrate.loadFailed", error, {
      durationMs: context.durationMs,
      existingPublisherAtStart: context.existingPublisherAtStart,
      forceRebuild: context.forceRebuild,
      // 关键结论：true = 保住了旧投影；false = 本来就没有可保的（真冷）。
      // 两者必须能在日志里分开，否则「空会话读失败」会被误读成「历史被清空」。
      keptProjection: kept !== undefined,
      keptRows: publisher.getSnapshot().rows.window.length,
      liveSessionAtStart: context.liveSessionAtStart,
      persistedMessages: context.persistedMessages,
      phase: "loadPersistedEvents",
      rawSourceEventSeq: this.rawSequenceStates.get(sessionId)?.sourceEventSeq ?? null,
      sessionId,
    });
    context.phases.finishedAtMs = performance.now();
    return publisher;
  }

  /**
   * cold 合成会把事件重新编号为 1..N，而 runtime 仍沿用 eventStore raw seq。这里用
   * source cursor 建立 N-C 偏移；raw seq=0（live-only child）则顺延，并同步校正后续偏移。
   * eventId 兜住 snapshot/buffer 同时看见同一事件的竞态，cursor 兜住已入 snapshot 的事件。
   */
  private normalizeRuntimeEventSequence(sessionId: string, event: SessionEvent): SessionEvent[] {
    const state = this.getOrCreateRawSequenceState(sessionId);
    const eventId = String(event.id);
    if (state.seenEventIds.has(eventId)) return [];

    const rawSeq = event.sequenceNumber;
    state.recentRawEventsById.set(eventId, event);
    while (state.recentRawEventsById.size > PROTOCOL_V4_LIMITS.eventRetentionPerSession) {
      const oldestEventId = state.recentRawEventsById.keys().next().value;
      if (oldestEventId === undefined) break;
      state.recentRawEventsById.delete(oldestEventId);
    }
    if (rawSeq <= 0) {
      state.seenEventIds.add(eventId);
      state.lastTransportSeq += 1;
      return [{ ...event, sequenceNumber: state.lastTransportSeq }];
    }
    if (event.type === SessionEventType.SessionResumed) {
      // 旧 runtime 在 unsubscribe/重建窗口时可能遗漏尾部 raw event。新 runtime
      // 延续持久 eventStore 高水位时，SessionResumed 的 raw seq 会大于旧 cursor；
      // 若只处理 seq 回退，resume 和后续 TurnStarted 就会永久等待无法补齐的旧 gap。
      // SessionResumed 是明确 epoch 边界：丢弃边界前的旧 pending，同时保留可能乱序先到的
      // 新 epoch 后续事件，再从 resume 自身连续 drain。
      for (const pendingSeq of state.pendingByRawSeq.keys()) {
        if (pendingSeq <= rawSeq) state.pendingByRawSeq.delete(pendingSeq);
      }
      state.sourceEventSeq = rawSeq - 1;
      state.offset = state.lastTransportSeq - state.sourceEventSeq;
    }
    if (rawSeq <= state.sourceEventSeq) {
      state.seenEventIds.add(eventId);
      this.resolveProjectionEventCommit(sessionId, eventId);
      return [];
    }

    state.seenEventIds.add(eventId);
    if (!state.pendingByRawSeq.has(rawSeq)) state.pendingByRawSeq.set(rawSeq, event);
    const ready: SessionEvent[] = [];
    // eventStore 先编号，各事件各自 await 持久化后再 notify，
    // 因此 N+1 可以先于 N 到达。高水位过滤会把迟到 N 错判成 duplicate；
    // 必须按 raw seq 暂存，只连续 drain，才能保住 queue/stream 总序。
    for (;;) {
      const nextRawSeq = state.sourceEventSeq + 1;
      const next = state.pendingByRawSeq.get(nextRawSeq);
      if (!next) break;
      state.pendingByRawSeq.delete(nextRawSeq);
      let transportSeq = nextRawSeq + state.offset;
      if (transportSeq <= state.lastTransportSeq) {
        transportSeq = state.lastTransportSeq + 1;
        state.offset = transportSeq - nextRawSeq;
      }
      state.sourceEventSeq = nextRawSeq;
      state.lastTransportSeq = transportSeq;
      // waiter timeout/abort 只清 listener 是不够的，还要终止已在 raw gap 中的
      // event。command 返回 failed 后，缺失 seq 一到仍会把同一 TurnStarted 投影出来。
      // 失败事件仍消费 raw 序号以解除后续事件阻塞，但绝不能再成为 canonical fact。
      if (state.failedEventById.has(String(next.id))) {
        continue;
      }
      ready.push(
        transportSeq === next.sequenceNumber ? next : { ...next, sequenceNumber: transportSeq },
      );
    }
    return ready;
  }

  private getOrCreateRawSequenceState(sessionId: string): RawSequenceState {
    const existing = this.rawSequenceStates.get(sessionId);
    if (existing) return existing;
    const created: RawSequenceState = {
      sourceEventSeq: 0,
      offset: 0,
      lastTransportSeq: 0,
      seenEventIds: new Set(),
      appliedEventIds: new Set(),
      failedEventById: new Map(),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, created);
    return created;
  }

  private resolveProjectionEventCommit(sessionId: string, eventId: string): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.delete(eventId);
    state.appliedEventIds.add(eventId);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.resolve();
  }

  private rejectProjectionEventCommit(sessionId: string, eventId: string, error: Error): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.set(eventId, error);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.reject(error);
  }

  private rejectProjectionEventWaiters(sessionId: string, error: Error): void {
    const byEvent = this.projectionEventCommitWaiters.get(sessionId);
    if (!byEvent) return;
    for (const waiters of byEvent.values()) {
      for (const waiter of [...waiters]) waiter.reject(error);
    }
    this.projectionEventCommitWaiters.delete(sessionId);
  }

  /**
   * 宿主注册表里有没有这条会话的 record（**只回答这一件事**）。
   *
   * IS4 的唯一原始调用点：`host.sessionExists` 对 live 与 view-only 都可能是 true，
   * 散落直判会让「还算不算存在 / 是不是 live」这两个问题在不同入口得到不同答案
   * （幽灵 runtime 前科见 `ensureHostRecordForJournalRead` 的注释）。需要语义判定的
   * 调用方改用 `conversationState` / `conversationViewState` / `isRuntimeReady`；
   * 确实只想问「record 在不在」的（detached child 释放、诊断日志）走这里并注明理由。
   */
  private hasHostRecord(sessionId: string): boolean {
    return this.host.sessionExists(sessionId);
  }

  /**
   * 宿主侧的**「runtime 正在跑」**事实（IS4 / Step 9 的唯一原始活性判定点）。
   *
   * 与 `hasHostRecord` 是两个问题：Step 9 的 view-only shell 也 `createRecord`，record 在册
   * 而 runtime 没起来。**旧宿主 / 测试桩**没有 `isSessionRuntimeActive` 探针时退回
   * `hasHostRecord`——那些宿主没有 shell 路径，两种口径等价（这是刻意的兼容降级，不是漏判）。
   */
  private hostRuntimeActive(sessionId: string): boolean {
    const probe = this.host.isSessionRuntimeActive;
    if (!probe) return this.hasHostRecord(sessionId);
    try {
      return probe.call(this.host, sessionId) === true;
    } catch (error) {
      // 探针坏了不得让门禁按「已就绪」放行（安全方向是未就绪）。
      this.host.onError?.("v4.runtime.activeProbe", error, { sessionId });
      return false;
    }
  }

  /**
   * 会话的 **live / notLive** 二态（IS4 的同步半边）。
   *
   * 运行中 subagent 没有独立 bootstrap record，但 raw child 事件会先建 publisher——
   * `detachedLiveSessions` 与「runtime 正在跑」同属 live，退化成 notLive 会把一条正在跑的
   * child 再 cold resume 成第二个 runtime。
   *
   * **不读 record**（Step 9 起）：view-only shell 有 record 但没有 runtime，把它判成 live 会让
   * 预激活与激活入口一起早退（首屏永不自动激活）。
   */
  private conversationState(sessionId: string): "live" | "notLive" {
    if (this.detachedLiveSessions.has(sessionId)) return "live";
    return this.hostRuntimeActive(sessionId) ? "live" : "notLive";
  }

  /**
   * 三态视图（IS4）：live / viewOnly / absent。
   *
   * `viewOnly` = 视图（投影）已经能读，但 runtime 没激活；`absent` = 连视图都没有
   * （宿主注册表没有、也没有一次成功的视图水化）。只有 `absent` 才能当成
   * 「这个会话不存在」——把它和 viewOnly 混为一谈会让读与翻页直接 404。
   */
  private conversationViewState(sessionId: string): "live" | "viewOnly" | "absent" {
    if (this.conversationState(sessionId) === "live") return "live";
    if (this.viewReadySessions.has(sessionId)) return "viewOnly";
    return "absent";
  }

  /**
   * runtime 是否**已就绪**（≠ record 是否在册）。
   *
   * 只读**激活结论**集合：①本进程一次成功的激活（`ensureRuntimeReady`）；
   * ②宿主报告 runtime 正在跑时的回填（热会话 / 新建会话 / 别处 resume 过）。
   *
   * ⚠ **不得**退回「record 在册 ⇒ 就绪」的短路（Step 8 的临时口径）：Step 9 的
   * `materializeSessionShell` 会 `createRecord` 但不 resume，那条短路会让 view-only 会话
   * 误报 true，正是幽灵 runtime 的入口。回归锚点：D3（record 不在册仍能判出 ready）+ D4
   * （record 在册但 runtime 没跑必须判 false）。
   */
  private isRuntimeReady(sessionId: string): boolean {
    if (this.runtimeReadySessions.has(sessionId)) return true;
    // 回填：live runtime 本身就是「已就绪」的结论，写进集合供后续读取（也避免每次再问宿主）。
    if (this.conversationState(sessionId) === "live") {
      this.runtimeReadySessions.add(sessionId);
      return true;
    }
    return false;
  }

  /** 视图水化的成功收口：`hydratedSessions`（防双算）与 `viewReadySessions`（IS4）同点登记。 */
  private markViewReady(sessionId: string): void {
    this.hydratedSessions.add(sessionId);
    this.viewReadySessions.add(sessionId);
  }

  private async seedPublisherUsage(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    persistedMessages?: MessageWithParts[],
    loadedSeed?: SessionUsageSeed | null,
  ): Promise<void> {
    if (loadedSeed !== undefined) {
      if (loadedSeed) publisher.seedUsage(loadedSeed);
      return;
    }
    const getSeed = this.host.getSessionUsageSeed;
    if (!getSeed) return;
    try {
      const seed = await getSeed.call(this.host, sessionId, persistedMessages);
      if (seed) publisher.seedUsage(seed);
    } catch (error) {
      this.host.onError?.("v4.usageSeed", error);
    }
  }

  /**
   * 把该会话现有订阅的待发帧立刻驱动一次（hydration 收口与派生量补种共用）。
   *
   * 两处都需要它，但理由不同：hydration 收口是「投影换了，订阅必须 resync」；补种是
   * 「投影只改了 usage/config 这两个初值、不产 delta」，若不主动驱动，客户端要等到下一个
   * 事件才看见（`seedUsage` / `seedConfig` 不产 delta 是刻意的，它们不能伪造行变化）。
   *
   * 失败只记账并重新排 flush：一次 emit 失败不该让订阅永久停在旧快照上。
   */
  private resyncSessionSubscribers(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    phase: "subscriptionResync" | "runtimeFactsResync" = "subscriptionResync",
  ): void {
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (this.pausedConnections.has(state.connectionId)) continue;
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.hydrate.subscriptionResync", error, { phase, sessionId });
        this.scheduleFlush(routeKey, state, publisher);
      }
    }
  }

  private scheduleFlush(
    routeKey: string,
    state: FlushState,
    publisher: ConversationTopicPublisher,
  ): void {
    if (this.pausedConnections.has(state.connectionId)) return;
    if (state.timer !== null) return;
    const timer = setTimeout(() => {
      state.timer = null;
      // timer 排队后可能收到 SAT；reserve 前必须二次检查，不能产生竞态帧。
      if (this.pausedConnections.has(state.connectionId)) return;
      // 惰性清理：订阅已被替换/退订→ 删调度状态，不产帧。
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
        this.flushStates.delete(routeKey);
        return;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) return;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }, state.flushWindowMs);
    // CLI 进程退出不被 flush 定时器挂住。
    timer.unref?.();
    state.timer = timer;
  }

  private emitReservation<F extends RoutedTopicFrame>(
    reservation: TopicFrameReservation<F>,
  ): boolean {
    // resync/subscribe recovery 已进入 request-scoped outbox 时，online
    // flush 若复用同一 inFlight 会让 physical wire 抢在 ACK response 前出站。
    if (this.controlReservations.has(reservation)) return false;
    const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
    for (const wire of wires) this.host.emitWireFrame(wire);
    return reservation.commit();
  }

  private subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F> {
    const initialWires = reservation
      ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
      : [];
    if (reservation) this.controlReservations.add(reservation);
    let afterCommitRan = false;
    return {
      ack,
      initialFrame: reservation?.frame ?? null,
      initialWires,
      commit: () => {
        if (!reservation) return true;
        this.controlReservations.delete(reservation);
        const committed = reservation.commit();
        if (committed && !afterCommitRan) {
          afterCommitRan = true;
          // control reservation 等 ACK/outbox admission 时，既有 flush timer
          // 可能已触发并因同一 inFlight 被抑制。commit 后必须主动重驱动 publisher，
          // 否则期间积累的 delta 会一直等到下一次 ingest/publish 才可见。
          afterCommit?.();
        }
        return committed;
      },
    };
  }
}

/** 宿主 executor 对未接线命令抛出此错误 → ACK failed fault.notImplemented。 */
export class V4CommandNotImplementedError extends Error {
  constructor(type: string) {
    super(`v4 command not implemented in M3: ${type}`);
    this.name = "V4CommandNotImplementedError";
  }
}

/**
 * 命令 handler 的 noop 收口通道（「同值切换 ACK 必须可判别」）：
 * handler 判定命令无事可做（如 switchModelConfig/switchCollaborationMode 命中
 * runtime 当前值）时抛出，gateway 映射为 ACK status="noop" + reasonCode——
 * 不得以 accepted（无 result）静默吞掉，客户端才能区分「已生效」与「本来就是这个值」。
 */
export class V4CommandNoopError extends Error {
  constructor(
    readonly reasonCode: string,
    message?: string,
  ) {
    super(message ?? `v4 command is a no-op (${reasonCode})`);
    this.name = "V4CommandNoopError";
  }
}
