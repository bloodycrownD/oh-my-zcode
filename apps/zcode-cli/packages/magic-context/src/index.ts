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
  MagicContextConfigSchema,
  PROTECTED_TOKENS_MIN,
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
} from "./core/hooks/magic-context/event-resolvers.js";
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
export { resolveModelKey } from "./core/hooks/magic-context/event-resolvers.js";

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

/**
 * range / tag 解析：模型经常把 `§N§` 标记原样抄回来，这两个助手负责归一化。
 */
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

// ── 4c. 记忆读写与检索公共面（Step 10 / D4+D14） ──────────────────────────────
//
// 【为什么要出这个面】ctx_search（D4）与 ctx_memory（D14）两个工具的**卷积藏在
// magic-context 侧**：
//   - 检索：`searchMemoriesFTS` 内联了 `sanitizeFtsQuery` / `relaxedFtsQuery`
//     （Step 8 移植的逐字层）与 bm25 排序、workspace 过滤、过期过滤。宿主工具
//     （`@zcode/core` 的 `tool/handlers/ctx-search.ts`）只需要传「身份 + query +
//     limit + 日期界」，FTS5 语法消毒的一切实例都不得出现在宿主侧。
//   - 写入：`insertMemoryIdempotent` 是唯一的 memory 写入口之一（promotion 用
//     `insertMemory`），唯一约束命中时的 seen_count 递增语义在它内部。
//   - 身份：`resolveProjectIdentityForSession` 是 promotion（compartment runner）
//     与 pack transform 共用的那个**非抛错**身份解析入口；宿主另写一份 git/dir
//     身份推导，等于给同一项目造第二个身份空间。
//   - 可见性：`getVisibleMemoryIds` 读的是 inject-compartments 写的那一列
//     （`session_meta.memory_block_ids`），ctx_search 靠它把已在 <project-memory>
//     里渲染过的命中过滤掉——与 m0/m1 注入读同一列，不另立口径。
//
// 【宿主不得自己抄】以上任何一条在宿主侧重写，都会与包内运行时分叉：查询消毒
// 分叉 = FTS5 注入面重新打开；身份推导分叉 = 写入与检索落在两个 project_key 上
// （记忆「写了却搜不到」）；seen_count 语义分叉 = 去重计数漂移。因此这些符号
// 只经本 barrel 出，宿主（core / bootstrap）不得复制实现或 import 包内相对路径。
//
// FORK（bugfix-batch-20261011 / Step 10）：本批 D4/D14 落地面。
//
// ── 写入面的两条链（为什么 getMemoryByHash / updateMemorySeenCount /
//    computeNormalizedHash 也要出）────────────────────────────────────────────
// 上游 ctx_memory 的 write 分支本身就是「前置精确哈希检查 → 已存在则
// updateMemorySeenCount 并回报现有 id → 否则 insertMemory」。fork 的
// ctx_memory（core/tool/handlers/ctx-memory.ts）照搬这条链，写入用
// `insertMemoryIdempotent`（它的唯一约束回退是**竞争窗口**的第二道闸：
// 两个写者同时穿过前置检查时，靠唯一约束 + seen_count 递增收口）。
// 因此这三个符号与 insertMemoryIdempotent 是同一条写路径的组成部分，不是可选项。
//
// 登记（本批观察项，待逐字区 owner 处置）：`insertMemoryIdempotent` 的唯一约束
// 分支判定 `error.code === "SQLITE_CONSTRAINT_UNIQUE"` 是 Bun 后端的命名码
// （上游逐字码），node:sqlite 抛的是 `ERR_SQLITE_ERROR` + `errcode: 2067`，
// 该分支在本 fork 运行期不可达。宿主以前置检查覆盖去重语义（工具文案层无差异），
// 真竞争时 fail-visible 抛错；`src/core/**` 逐字区本节点不改。

export {
  insertMemoryIdempotent,
  getMemoriesByIds,
  getMemoryByHash,
  updateMemorySeenCount,
  ModuleMemoryAuthorityError,
  type InsertMemoryResult,
} from "./core/features/magic-context/memory/storage-memory.js";
export { computeNormalizedHash } from "./core/features/magic-context/memory/normalize-hash.js";
/**
 * v2 五分类：写入面唯一接受的分类集（V2_MEMORY_CATEGORIES 与契约层
 * `CTX_MEMORY_CATEGORIES` 一一对应，drift guard 测试钉住两边一致）。出 barrel
 * 是为了让宿主与测试都能核验「模型可写的分类」没有第二份定义。
 */
export { V2_MEMORY_CATEGORIES } from "./core/features/magic-context/memory/constants.js";
export {
  searchMemoriesFTS,
  type MemorySearchDateRange,
} from "./core/features/magic-context/memory/storage-memory-fts.js";
export {
  resolveProjectIdentityForSession,
  storedPathBelongsToIdentity,
} from "./core/features/magic-context/memory/project-identity.js";
export { getVisibleMemoryIds } from "./core/hooks/magic-context/inject-compartments.js";
export type {
  Memory,
  MemoryCategory,
  MemoryInput,
} from "./core/features/magic-context/memory/types.js";

// ── 4d. 211 行段 + prompt-surface 解析面（Step 12 / D1+D6+D7） ─────────────────

/**
 * `## Magic Context` 系统提示词段的唯一文案来源（壳缝①，git mv 自
 * `deferred/magic-context-prompt.ts`，上游 211 行真身）。
 *
 * 为何出这个面：宿主（core 的 context section / Step 14 的工具描述分档）必须拿到段文本
 * 与 preset 解析。**宿主不得自抄这段文案**——它是与渲染器、`<project-memory>` 注入格式
 * 逐字配套的用户可见提示词， paraphrasing 会让提示词与自己的管道脱同步；preset 分档同样
 * 只有这一份 resolver，宿主再实现一遍 model-key walk 就会与 transform 的 cache_ttl 走法
 * 分叉（`modelKeyLookupOrder` 是两条路共用的那个 walk）。
 *
 * `SELF_TAG_GUIDANCE` 单独导出：宿主 subagent 侧的引导需要它，而它与 11 参装配的完整段
 * 是两个生命周期。
 */
export { buildMagicContextSection, SELF_TAG_GUIDANCE } from "./core/agents/magic-context-prompt.js";

/**
 * prompt-surface 配置解析（壳缝①，git mv 自 `deferred/prompt-surface.ts`，上游 163 行
 * 真身）+ 每宿主 runtime（壳缝①，git mv 出 `deferred/prompt-surface-runtime.ts`，
 * 上游 284 行真身 + Step 12 三处 ZCode 适配，见文件头差异注）。
 *
 * 为何出这个面：
 *   - `resolvePromptSurface` / `promptSurfaceConfigIdentity`：bootstrap 的
 *     `buildTransformDeps` 把 `prompt_surface` 域喂给包内 transform，并把配置身份折进
 *     `getToolSetHash`（prompt-surface 是 m[0] 的 attribution-only 信号，改 preset 不会
 *     触发折叠，但必须在审计里看得见）；
 *   - `createPromptSurfaceRuntime` / `ACTIVE_TOOL_IDS` / `LIGHT_TOOL_DESCRIPTIONS`：
 *     tool registration 侧的 preset 分档（light 档换 compact 描述）与「哪些 ctx_* 工具
 *     存在」的唯一权威表。宿主据此覆盖 description，**不复制描述文本**。
 *   - `ACTIVE_TOOL_IDS` 不含 `ctx_note`（N2 终局不做），见 runtime 文件头差异 3。
 */
export {
  ACTIVE_TOOL_IDS,
  type CreatePromptSurfaceRuntimeOptions,
  createPromptSurfaceGuidanceEpochCache,
  createPromptSurfaceRuntime,
  LIGHT_TOOL_DESCRIPTIONS,
  type PromptSurfaceGuidanceEpochCache,
  type PromptSurfaceGuidanceSelection,
  type PromptSurfaceRegistrationSelection,
  type PromptSurfaceRuntime,
  type PromptSurfaceToolId,
  promptSurfaceHashMaterial,
} from "./core/shared/prompt-surface-runtime.js";
export {
  isValidPromptSurfaceModelKey,
  type ModelKeyCandidate,
  type ModelKeyLookupSource,
  modelKeyLookupOrder,
  type PromptSurfaceConfig,
  type PromptSurfacePreset,
  type PromptSurfaceResolutionSource,
  promptSurfaceConfigIdentity,
  resolveModelConfigOrDefault,
  resolveModelConfigValue,
  resolvePromptSurface,
} from "./core/shared/prompt-surface.js";

/**
 * D7 全覆盖缝②：三个结构性 type（`ModelInput` 等），包内 transform 的签名面。按裁定
 * 不搬上游的 harness 模型 resolver 家族（fork 的 E 组只有一套扁平 historian 配置），
 * 因此这里也只出 type 面，没有可调用的实现需要宿主自抄。
 */
export type {
  ModelHarness,
  ModelInput,
  ResolvedModelEntry,
} from "./core/shared/model-resolution.js";

// ── 4e. mural 渲染链公共面（Step 15 / D5） ──────────────────────────────────
//
// 【为什么要出这个面】mural 的**判定源**在宿主侧，渲染在包内。上游的 vision 判定
// 走包内 `models-dev-cache` 的 apiCache，而那条链在本 fork 零生产者（refresh 零
// 调用者）——恒 false 会让整条移植过来的渲染路径成为死代码。因此本 fork 把判定
// 换成静态目录 `ModelInputFormatData.supportsImage`（packages/shared/src/
// model-config.ts:51-59，与 contracts media-policy.ts:40 同一静态源），由宿主
// （bootstrap，持有 provider Registry）经 `setMuralVisionProbe` 注入：
//
//   - `setMuralVisionProbe`：宿主注册「canonical provider/model 是否吃图」的
//     解析器。进程级注入缝，与 `setRawMessageProvider` /
//     `registerSlowWriteReporter` 同范式（目录与会话无关，故全局）。宿主不得
//     自己包一层 vision 判断——那会与 provider 投影层的 media-policy 分叉。
//   - `modelKeyAcceptsImages` / `resolveMuralWire` / `ensureMuralRendered` 出
//     barrel 只为测试与诊断面（bootstrap 的实机验收 T-MU1/T-MU2 直断言它们）；
//     运行期唯一调用方是包内 inject-compartments 的 m0 物化路径。
//   - `MuralWireOptions` 等 type 面：宿主（bootstrap 的 transform 反投影）与
//     包内共用同一份线格式定义，不第二处手抄。
//
// 【宿主不得自己抄】渲染、覆盖门（MIN_MURAL_CUED_MEMORIES / MIN_MURAL_COVERAGE）、
// 文本哈希变更检测、PNG 编码全部在包内逐字层；宿主只提供「这个模型吃不吃图」
// 这一个事实。N3（dreamer）不做 ⇒ compress-cues 三件不搬，cue 由
// `storage-mural-cues`（Step 8 已落位）的既有列承载；cue 为空时覆盖门自然
// 静默跳过——禁用/无 vision/无 cue 三种情形的终局都是「不渲染」，与上游一致。
export {
  type EnsureMuralResult,
  type MuralVisionProbe,
  DETERMINISTIC_MURAL_MODEL,
  ensureMuralRendered,
  MIN_MURAL_COVERAGE,
  MIN_MURAL_CUED_MEMORIES,
  modelKeyAcceptsImages,
  muralCoverageGate,
  resolveMuralWire,
  setMuralVisionProbe,
} from "./core/features/magic-context/mural/render-trigger.js";
export type {
  MuralCoverage,
  MuralWireOptions,
  ResolvedMuralEntry,
} from "./core/features/magic-context/mural/resolve-mural.js";

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
