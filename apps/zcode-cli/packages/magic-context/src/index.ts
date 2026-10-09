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
 * 【S19b 的硬约束 —— S20 起已解除】本文件在 S19b 期间**不得**出现
 * compartment-runner / historian / HiddenCompletionExecutor 一类的 C 组符号。
 * 那条约束的前提是「C 组还是 `src/core/deferred/` 的缝」，于是 barrel 一导出就
 * 会把缝拖进 ZCode 的编译闭包。S20 把缝换成了真身（`src/core/features/` 与
 * `src/core/hooks/magic-context/`），前提不再成立；S24 因此开第 3b 节把**接线面**
 * 导出——注意是接线面（executor 工厂 / 调度器 / agent 启动入口），不是 C 组全量：
 * 逐字移植的 runner 内部（prompt 组装、校验、发布事务）仍不进 barrel。
 *
 * `src/host/typecheck-seams.ts` 记录 host↔core 的结构契约，不在本文件导出面内。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
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

// ── 3b. C 组 historian 接线面（S20 真身 / S24 接线） ──────────────────────────
//
// 只有**装配层真正要调的那几个入口**在这里：sidecar executor 工厂、historian
// 后台调度器、以及 compartment agent 的启动/查询。逐字移植的 runner 内部
// （prompt 组装、schema fence 校验、发布事务）不在导出面内——它们由前两个入口
// 内部调用，装配层不需要也不该直接碰。

/**
 * D-6 的 sidecar executor 工厂。**装配层唯一的 historian 模型入口**：它把一次
 * sidecar 请求映射到宿主提供的 `sidecarModelCall`，并强制
 * `preserveProviderStreamBoundaries: true`（类型层面，见该文件的文件头）。
 */
export {
  DEFAULT_HIDDEN_RUN_TIMEOUT_MS,
  classifySidecarFailure,
  createHiddenCompletionExecutor,
  toTokenTotals,
  type HiddenCompletionExecutorOptions,
  type SidecarModelCall,
  type SidecarModelCallOptions,
  type SidecarModelCallResult,
  type SidecarModelRequest,
} from "./host/hidden-completion-executor.js";
export {
  HiddenCompletionRefusal,
  type HiddenCompletion,
  type HiddenCompletionExecutor,
  type HiddenRunHandle,
  type HiddenRunIdentity,
} from "./core/hooks/magic-context/compartment-runner-types.js";

/**
 * historian 后台调度器（fire-and-forget + 合并 + 有界 drain + abort）。装配层在
 * turn 成功后 `notifyTurnSuccess`，在会话关闭时 `drainHistorianSchedulerWithTimeout`。
 */
export {
  DEFAULT_HISTORIAN_DRAIN_TIMEOUT_MS,
  createHistorianScheduler,
  drainHistorianSchedulerWithTimeout,
  type CreateHistorianSchedulerOptions,
  type HistorianRunStatus,
  type HistorianScheduler,
  type HistorianTurnSuccess,
} from "./core/features/magic-context/historian-scheduler.js";

/**
 * compartment agent 的启动/查询入口。transform 内部在触发条件满足时自己调
 * `startCompartmentAgent`；装配层的调度器与 `/ctx-recomp` runner 走的是同一条路，
 * 所以这两个入口必须出得来，否则「turn 成功后再跑一次」只能重写一遍启动逻辑。
 */
export {
  getActiveCompartmentRun,
  markActiveCompartmentRunPublished,
  registerActiveCompartmentRun,
  startCompartmentAgent,
} from "./core/hooks/magic-context/compartment-runner.js";
export type { HiddenCompartmentRunnerDeps } from "./core/hooks/magic-context/compartment-runner-types.js";

/**
 * historian chunk 预算的推导（chunk = historian 窗口的一个固定比例）。装配层在
 * 构造 `HiddenCompartmentRunnerDeps` 时需要它，与 transform 内部用的是同一个函数。
 */
export { deriveHistorianChunkTokens } from "./core/hooks/magic-context/derive-budgets.js";
/**
 * historian 超时预算的常量。E 组刻意没把这个旋钮搬进配置白名单，所以它的值由配置面
 * **覆盖不了**——装配层要设超时预算时只能引用这一个常量，不能自己写一个 600000。
 */
export { DEFAULT_HISTORIAN_TIMEOUT_MS } from "./core/hooks/magic-context/compartment-runner-historian.js";

/**
 * protected-tail 边界求解。`resolveOpenCodeProtectedTailBoundary` 是 transform 用的
 * 那一个（`deps.hostProtectedTailBoundary` 缺席时的默认实现）；装配层的调度器在
 * 自己发起一次后台 pass 时用 `mode:"incremental-runner"` 走同一份判据。
 */
export {
  hasRunnableCompartmentWindow,
  resolveOpenCodeProtectedTailBoundary,
  type ProtectedTailBoundarySnapshot,
} from "./core/hooks/magic-context/protected-tail-boundary.js";

// ── 4. A 组存储的少量入口 ───────────────────────────────────────────────────

export {
  getMigrationOnOpenRefusal,
  getSchemaFenceRejection,
  openDatabase,
  // bugfix-batch-20261009 / 5e：busy/瞬时开库失败的分类（cause 链上的类型与
  // code 判定，不做 message 子串分类）。bootstrap 的 boot 有界重试只对判定为
  // busy/瞬时的失败重试；fence/ABI/不可写等确定性失败仍走 fail-closed throw。
  // 见 storage-db.ts 中该函数的 FORK 块。
  isTransientStorageOpenError,
  type ContextDatabase,
  type MigrationOnOpenRefusal,
  type OpenDatabaseOptions,
} from "./core/features/magic-context/storage-db.js";
export { createTagger, type Tagger } from "./core/features/magic-context/tagger.js";

/**
 * compartment 行的只读查询。`/ctx-recomp` 的 runner 要在重算前后各数一次条数，
 * 而那条计数必须与 `/ctx-status` 读的是同一份查询——两处各写一次 SQL 迟早漂移。
 */
export {
  getCompartments,
  type Compartment,
} from "./core/features/magic-context/compartment-storage.js";

/**
 * session_meta 的 usage 读写面（S24）。
 *
 * 上游 OpenCode 的 plugin 由 `message.updated` 事件负责写 `last_*_usage` 三列；
 * ZCode 没有 plugin 事件通道，宿主只能自己写。于是**写**与**读**必须都出得来，
 * 而且必须是同一对函数——宿主另写一份 SQL 迟早与包内的列名/语义漂移。
 *
 * `updateSessionMeta` 也被 transform 自己用于同样的三列，所以这个出口不会成为
 * 第二条写路径。
 */
export { updateSessionMeta } from "./core/features/magic-context/storage-meta.js";
export { loadPersistedUsage } from "./core/features/magic-context/storage-meta-persisted.js";

/**
 * `"provider/model"` → 包内的模型身份 key（`piModelRefToCanonical` 之后）。
 *
 * FORK (S24-fix)：宿主侧的 usage recorder 必须把**同一个**函数算出来的 key 写进
 * `session_meta.last_observed_model_key` —— transform 的换模型失效判据拿它与
 * `resolveModelKey(currentOutgoingModel)` 比。宿主自己拼字符串等于抄一份规范化规则，
 * provider 别名一改就会静默失配。
 */
export { resolveModelKey } from "./core/deferred/event-resolvers.js";

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
export { createCtxReduceTools, type CtxReduceToolDeps } from "./core/tools/ctx-reduce/tools.js";
export type { CtxReduceArgs } from "./core/tools/ctx-reduce/types.js";
export {
  CTX_EXPAND_DESCRIPTION,
  CTX_EXPAND_TOKEN_BUDGET,
} from "./core/tools/ctx-expand/constants.js";
export {
  resolveCtxExpandMode,
  type CtxExpandMode,
  type CtxExpandOrdinalDomain,
} from "./core/tools/ctx-expand/mode.js";
export { createCtxExpandTools, type CtxExpandToolDeps } from "./core/tools/ctx-expand/tools.js";
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
