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
export { parseCacheTtl } from "./core/deferred/scheduler.js";
export type { Scheduler } from "./core/deferred/scheduler.js";
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
