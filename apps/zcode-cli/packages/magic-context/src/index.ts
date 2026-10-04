/**
 * magic-context 内置包（Phase 2a 移植宿主）：core/ 为移植代码，host/ 为 ZCode 适配层。
 *
 * ============================================================================
 * Step 19b — PUBLIC BARREL（barrel 面）
 * ============================================================================
 *
 * 这是 `@zcode/core` / `@zcode/bootstrap` 唯一被允许 import 的入口。它刻意保持
 * 「按装配需要最小面」：
 *
 *   1. host 适配层（S15/S16/S17 落地的 ZCode 适配）
 *   2. config 三件套（E 组缩减版 schema）
 *   3. B 组 transform 工厂 + 失败分类 + LKG（B 组已就绪面）
 *   4. A 组存储的少量入口（openDatabase / tagger）
 *   5. message 转换纯函数（ZCode runtime entry ↔ MessageLike）
 *
 * 【硬约束 — 不 export C 组任何符号】S20（historian）会替换 `src/core/deferred/`
 * 的 deferred 缝，并在 `src/core/features/magic-context/` 落 historian 真身。
 * 本文件因此**不得**出现 compartment-runner / historian / HiddenCompletionExecutor
 * 一类的 C 组符号，否则：
 *   - bootstrap 一 import 本 barrel 就会把 C 组缝拖进 ZCode 的编译闭包，S20 替换
 *     缝时 ZCode 侧跟着炸；且
 *   - transform 的 historian executor 在 S19b 传 `undefined` 占位（S20 接），
 *     barrel 若导出 C 组符号会诱使装配处提前接线。
 *
 * `src/host/typecheck-seams.ts` 记录 host↔core 的结构契约，不在本文件导出面内。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

export const MAGIC_CONTEXT_PACKAGE_VERSION = "0.1.0";

// ── 1. host 适配层 ───────────────────────────────────────────────────────────

/**
 * S15 遗留 #6 的契约入口：`setHarness("zcode")` + project-dir resolver。
 * **必须**在任何 DB 写之前调用（装配层第一句），且幂等。
 */
export {
  ZCODE_HARNESS_ID,
  assertMagicContextHostInitialized,
  initializeMagicContextHost,
  isMagicContextHostInitialized,
  type MagicContextHostSnapshot,
} from "./host/harness.js";

/** ZCode 的 `RawMessageProvider` 工厂（S17）。绑定单个 session scope。 */
export {
  createRawMessageProvider,
  RAW_MESSAGE_RANGE_PAGE_SIZE,
  RAW_MESSAGE_VISIT_PAGE_SIZE,
  type RawMessageProvider,
  type RawMessageProviderDeps,
  type StoredMessagePage,
} from "./host/raw-message-provider.js";

/** ZCode 会话库只读门面 + provider 需要的分页 SQL 入口（S17）。 */
export {
  createSessionHistory,
  createZCodeSessionReader,
  getStoredMessageCountFromStore,
  readStoredMessageByIdFromStore,
  readStoredMessagePageFromStore,
  readStoredOrdinalPageFromStore,
  ZCODE_MESSAGE_ORDER_SQL,
  type SessionHistory,
  type SessionHistoryDeps,
  type SessionStoreHandle,
  type SessionStoreStatement,
} from "./host/session-history.js";

/** push 型配置桥（S16）。Step 23 把 `ConfigPort.observe` 接到 `source` 上。 */
export {
  createConfigBridge,
  type ConfigBridge,
  type ConfigBridgeOptions,
  type ConfigChangeEvent,
  type MagicContextConfigSource,
} from "./host/config-bridge.js";

/** 存储落点（S15/S17 遗留 #5）：project artifact 目录 + magic-context.db 路径。 */
export {
  MAGIC_CONTEXT_DB_FILE_NAME,
  getMagicContextDatabaseLocation,
  getMagicContextDatabasePath,
  getProjectArtifactsRoot,
  getProjectKey,
  getZCodeProjectMagicContextDir,
  getZCodeProjectMagicContextHistorianDir,
  resolveProjectMagicContextDir,
  setProjectDirResolver,
  type MagicContextDatabaseLocation,
} from "./host/storage-dir.js";

// ── 2. config 三件套（E 组缩减版） ───────────────────────────────────────────

export {
  DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
  DEFAULT_HISTORIAN_CONFIG,
  DEFAULT_HISTORY_BUDGET_PERCENTAGE,
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  EXCLUDED_CONFIG_KEYS,
  HISTORIAN_MODEL_REQUIRED_MESSAGE,
  MagicContextConfigSchema,
  PROTECTED_TOKENS_MIN,
  findConfigReadinessError,
  type HistorianConfig,
  type MagicContextConfig,
} from "./host/config/schema.js";
export type { ConfigReloadFailure, ConfigSnapshot } from "./host/config/snapshot.js";

// ── 3. B 组 transform 工厂 + 失败分类 + LKG ─────────────────────────────────

export {
  EMERGENCY_REFUSAL_NOTICE,
  clearMessageTokensCache,
  createTransform,
  resolveTransformHostSeams,
  type HostRefusalNotice,
  type TransformDeps,
} from "./core/hooks/magic-context/transform.js";

/**
 * 失败分级（B 组既有语义，S19b 不自创）：
 *   - fail-closed 硬拒：`EmergencyFailClosedError` / `FailClosedBlockingError`
 *   - 需 LKG 或拒发：`DegradedPassRefusalError` / `UnmanagedOverWindowError` /
 *     `UnresolvedHistoryBoundaryError` / `StorageBusyRefusalError` / transient sqlite
 *   - 其余：fail-open 放行（装配层自行决定是否持久化 last_transform_error）
 */
export {
  DegradedPassRefusalError,
  degradedPassError,
} from "./core/hooks/magic-context/degraded-pass-refusal.js";
export { EmergencyFailClosedError } from "./core/hooks/magic-context/emergency-fail-closed.js";
export {
  UnmanagedOverWindowError,
  isClearlyOverWindow,
} from "./core/hooks/magic-context/unmanaged-over-window.js";
export { UnresolvedHistoryBoundaryError } from "./core/hooks/magic-context/unresolved-history-boundary.js";
export { StorageBusyRefusalError } from "./core/hooks/magic-context/storage-busy-refusal.js";
export {
  FailClosedBlockingError,
  isFailClosedBlockingError,
} from "./core/features/magic-context/fail-closed-block.js";
export { isTransientSqliteError } from "./core/shared/sqlite.js";

/** LKG 重放（B 组）：失败后用上一次成功 pass 的字节重放，而不是发一份更大的请求。 */
export { replayLkg, resolveLkgModelKeys } from "./core/hooks/magic-context/lkg-replay.js";
export { dropSlot, getSlot, noteEntry } from "./core/hooks/magic-context/lkg-slot.js";

/** per-session raw-message provider 注册（S17 的工厂签名就是为这些入口设计的）。 */
export {
  hasRawMessageProvider,
  readRawSessionMessages,
  setRawMessageProvider,
  withRawMessageProvider,
} from "./core/hooks/magic-context/read-session-chunk.js";

/** 阈值解析（B 组已移植的 resolver）：装配 Scheduler 用它算 execute threshold。 */
export {
  createScheduler,
  parseCacheTtl,
  type Scheduler,
} from "./core/features/magic-context/scheduler.js";
export {
  resolveExecuteThreshold,
  resolveExecuteThresholdDetail,
} from "./core/deferred/event-resolvers.js";
export type { LiveModelBySession } from "./core/deferred/hook-handlers.js";
export type { NotificationParams } from "./core/deferred/send-session-notification.js";
export type {
  ContextUsage,
  SchedulerDecision,
  SessionMeta,
} from "./core/features/magic-context/types.js";

// ── 4. A 组存储的少量入口 ───────────────────────────────────────────────────

export {
  getSchemaFenceRejection,
  openDatabase,
  type ContextDatabase,
  type OpenDatabaseOptions,
} from "./core/features/magic-context/storage-db.js";
export { createTagger, type Tagger } from "./core/features/magic-context/tagger.js";

// ── 4b. D 组 ctx 工具面 + 状态读取（Step 21） ──────────────────────────────────

/**
 * D 组第一批两个 ctx 工具的真身（`tools/ctx-reduce/**` + `tools/ctx-expand/**`），
 * 连同它们依赖的 `unwrap-imitated-reduced-args` / `range-parser` / `tag-input`。
 *
 * 剥离的两处（SPEC「明确不搬」）：`@opencode-ai/plugin` 的 `tool()` / `ToolDefinition`
 * 运行时值导入 → `CtxToolDefinition` + `toolSchema`（zod）；`plugin/rust-tool-backends`
 * 的类型导入（连同其 `rustReduce` 分支）。`ctx_reduce` 的**命令幂等**语义因此由
 * 工具自身的 `commandIdLedger` 承担，键的推导逻辑逐字保留（T-M11）。
 */
export { CTX_REDUCE_DESCRIPTION } from "./core/tools/ctx-reduce/constants.js";
export {
  createCtxReduceTools,
  type CtxReduceToolDeps,
} from "./core/tools/ctx-reduce/tools.js";
export type { CtxReduceArgs } from "./core/tools/ctx-reduce/types.js";
export { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "./core/tools/ctx-expand/constants.js";
export {
  resolveCtxExpandMode,
  type CtxExpandMode,
  type CtxExpandOrdinalDomain,
} from "./core/tools/ctx-expand/mode.js";
export {
  createCtxExpandTools,
  type CtxExpandToolDeps,
} from "./core/tools/ctx-expand/tools.js";
export type { CtxExpandArgs } from "./core/tools/ctx-expand/types.js";
export type { CtxToolContext, CtxToolDefinition } from "./core/tools/tool-definition.js";

/** range / tag 解析：模型经常把 `§N§` 标记原样抄回来，这两个助手负责归一化。 */
export { parseRangeString } from "./core/features/magic-context/range-parser.js";
export { parseTagInput, TAG_INPUT_ERROR } from "./core/features/magic-context/tag-input.js";
export {
  unwrapImitatedReducedArgs,
  type ImitatedArgRule,
  type ImitatedArgsSchema,
  type ImitatedReducedArgs,
} from "./core/tools/unwrap-imitated-reduced-args.js";

/**
 * protected working set（Step 21 真身替换 `deferred/protection-window.ts`）。
 * `ctx_reduce` 直接用它算「held」的那部分，`transform` 用它决定哪些行活过压缩。
 */
export {
  computeProtectionWindow,
  getProtectionWindowForSession,
  readEpochFloorSnapshot,
  type ProtectionWindowResult,
  type ProtectionWindowRow,
} from "./core/features/magic-context/protection-window.js";

/** cache TTL 冻结策略（Step 21 真身替换两个 deferred 缝）。 */
export {
  type CacheTtlConfig,
  type ResolvedCacheTtl,
  resolveModelCacheTtl,
} from "./core/shared/model-cache-ttl.js";
export {
  readSessionCacheTtl,
  resolveSessionCacheTtl,
} from "./core/features/magic-context/session-cache-ttl.js";

/**
 * 用户可见 refusal 目录（Step 21 真身替换 `deferred/user-facing-codes.ts`）。
 * B 组的 refusal 类与 `/ctx-status` 的「读不出来」文案都走它。
 */
export {
  renderCapabilityRefusal,
  renderEmbeddingFailure,
  renderUserFacingFailure,
  USER_FACING_FAILURES,
  type UserFacingFailureKey,
  type UserFacingTextStyle,
} from "./core/shared/user-facing-codes.js";

/**
 * `/ctx-*` 命令注册表（Step 21 真身替换 `deferred/builtin-commands.ts` 的命令表一半）。
 * 「哪些名字存在、描述是什么」在这里；命令的**执行**按 SPEC 由 Step 22 在 ZCode 侧
 * 重写为本地命令语义（替代上游的 Effect 204 sentinel）。
 */
export {
  getMagicContextBuiltinCommands,
  type MagicContextBuiltinCommandName,
} from "./core/features/builtin-commands/commands.js";

/**
 * `/ctx-status` 文本快照（Step 21 新写，替代源实现那 5 个约 2137 行的
 * RPC/TUI-coupled 文件）。只读 `magic-context.db`：预算 / compartments / dropped 统计。
 */
export {
  formatMagicContextStatusSnapshot,
  readMagicContextStatusSnapshot,
  type CtxStatusTagBucket,
  type MagicContextStatusSnapshot,
  type ReadMagicContextStatusOptions,
} from "./host/ctx-status.js";

/**
 * `/ctx-recomp` 的包侧入口（Step 22）。简化语义：真 runner 由装配层（S24）经
 * `setMagicContextRecompRunner` 装；没装时 outcome 明确回报 `unavailable`，
 * 命令据此把边界说清楚，而不是谎称已重建。
 */
export {
  isMagicContextRecompRunnerRegistered,
  requestMagicContextRecompute,
  setMagicContextRecompRunner,
  type MagicContextRecompOutcome,
  type MagicContextRecompRunner,
  type MagicContextRecompScope,
  type RequestMagicContextRecomputeOptions,
} from "./host/ctx-recomp.js";

// ── 5. message 转换纯函数 ───────────────────────────────────────────────────

export {
  isRuntimeAttachmentEntry,
  isRuntimeMessageEntry,
  messageLikeToRawMessage,
  projectMessageUnchanged,
  projectRuntimeEntries,
  projectRuntimeEntry,
  projectStoredMessage,
  snapshotRuntimeEntries,
  type MessageLike,
  type MessageInfo as MagicContextMessageInfo,
  type RawMessage,
  type RawMessageOrdinalAnchor,
  type RawMessageOrdinalEntry,
  type RawMessageParts,
  type RuntimeProjectionOptions,
  type ThinkingLikePart,
  type ToolLikePart,
  type ZCodeModelInputMessage,
  type ZCodeModelMessageContentBlock,
  type ZCodeModelToolCall,
  type ZCodeRuntimeAttachmentEntry,
  type ZCodeRuntimeEntry,
  type ZCodeRuntimeMessageEntry,
  type ZCodeRuntimeMessageMetadata,
} from "./host/types.js";
