/**
 * Step 19b — bootstrap 侧的 magic-context 装配。
 *
 * ============================================================================
 * 这里是全仓唯一 import `@zcode/magic-context` 运行时值的地方，而且只在
 * `features.magicContext` 打开时才 import（`createZCodeApp` 用动态 import 调本文件
 * 的工厂）。原因见 `core/src/runtime/helpers/magic-context-turn-transform.ts` 的
 * 文件头：用户显式把 flag 关掉时，CLI 启动不应该把整棵 magic-context 模块图
 * 拉进内存。
 * ============================================================================
 *
 * 本文件负责三件事：
 *
 *   1. **投影**：ZCode `RuntimeMessageEntry[]` → magic-context `MessageLike[]`，
 *      跑 transform，再把结果**反投影**回 `RuntimeMessageEntry[]`。反投影是 ZCode
 *      侧的知识（ZCode 用 `kind:"attachment"` 与独立的 `role:"tool"` entry，而
 *      magic-context/OpenCode 把 tool 结果挂在一条 user 消息的 part 上），所以它
 *      必须写在 ZCode 侧而不是包内。
 *
 *   2. **TransformDeps 装配**（映射表见 `TRANSFORM_DEPS_MAPPING`）。
 *
 *   3. **失败分级**：完全照 B 组既有语义（上游 `plugin/messages-transform.ts` 的
 *      三档）——fail-closed 重抛 / LKG replay / fail-open 放行。本层不自创分类。
 *
 * ── TransformDeps 字段 → ZCode 能力（Step 19b 交接表）────────────────────────
 *
 *   db                              openDatabase(getMagicContextDatabasePath())
 *   tagger                          createTagger()
 *   scheduler                       createZCodeScheduler()：包内真身（S21）+ 键名映射
 *   contextUsageMap                 S24：宿主 usage recorder 的内存表（装配期 prime
 *                                   回上一轮落库读数）
 *   hostProcessLifetime             S24-fix：`"one-process-per-turn"`。ZCode CLI 一轮
 *                                   prompt 一个进程，所以包内 transform 的「首 pass
 *                                   usage 重置」必须走累积语义——不声明它，每一轮都
 *                                   会把上一轮的占用读数清成 0%（T-M2/T-M3/T-M6 的
 *                                   共同根因，见 MVP 报告 §3）
 *   clearReasoningAge               50（源 hook.ts 的 `?? 50`；clear_reasoning_age
 *                                   不在 E 组白名单）
 *   historyRefreshSessions /        装配层持有的 Set / Map（生产者 S20）
 *   pendingMaterializationSessions
 *   lastHeuristicsTurnId /
 *   commitSeenLastPass
 *   hiddenCompletionExecutor        S24：`createMagicContextHistorianHost` 造的 D-6
 *                                   sidecar executor；historian 模型缺省/造不出来时
 *                                   **不装**（见下「已知缺口」）
 *   historianRunnable               同上：有 executor 才 true
 *   historianModel /fallbackModels/ two_pass / maxTokens → 同一次装配从 E 组 schema
 *   historianTimeoutMs /                 读出并原样下发
 *   getHistorianChunkTokens
 *   client                          不传 —— ZCode 无 PluginContext client
 *                                   （通知缝缺口 S20）
 *   hostRawMessages /               createRawMessageProvider：内存 borrow +
 *   hostMessageReconciliationSource session store 快照
 *   hostModelFallback               liveModelBySession —— ZCode 的「上次 assistant
 *                                   模型」等价物（`opencode-db-path` 不再使用）
 *   directory / projectPath         runtimeConfig.workingDirectory
 *   storeGeneration                 不传 —— ZCode 会话库既非 OpenCode v1 也非
 *                                   v2，跳过坐标 rebase
 *   cacheTtlConfig / protectedTokens / smartDrops / historyBudgetPercentage /
 *   executeThresholdPercentage / executeThresholdTokens
 *                                   config bridge 快照；**S23 起是真配置口**：
 *                                   bridge 订阅 `ConfigPort.observe(
 *                                   ConfigKey.MagicContext)`（全仓首个消费者），
 *                                   配置变更原地改写同一份 deps 对象，下一 pass 即生效
 *   liveModelBySession / getModelKey / getNotificationParams / getToolSetHash
 *                                   每 pass 用 turn-loop 传入的 model 刷新
 *
 * ── 已知缺口 ────────────────────────────────────────────────────────────────
 *   - historian executor：`createMagicContextTurnTransformOptions.createSidecarModel`
 *     缺席、或 `magicContext.historian.model` 没配/此刻造不出 Model 时不装，
 *     `historianRunnable` 保持 false。这与 S16 的缺省报错文案是同一条语义：
 *     「报了错」不等于「装配炸掉」。
 *   - 模型窗口几何（`models-dev-cache` / `window-geometry`）：包内模块级单例且没有
 *     注入缝，包外改不了（改包内是 S20 的特权）。S19b 让 transform 走自己的默认/检测
 *     回退，窗口偏小只会让阈值更保守，不会误发超大请求。
 *   - `contextUsageMap` 的生产者（S24）在宿主侧：后台 historian pass 因此能读到真实
 *     占用读数来解 protected-tail 边界（`readUsage`），不再需要 `usage:null` 的
 *     provisional-zero。真正没有读数时才回 `null`（不知道 ≠ 很空）。
 *   - 首 pass usage 重置的上游语义由 `hostProcessLifetime` 关掉（见上表）。
 *   - 配置面（D-12）已接线：写盘 `updateMagicContextInFileConfig`、内存
 *     `ConfigPort.set`、推送 `ConfigPort.observe` 三段齐备；桌面设置页的调用侧
 *     （Step 29）落地后才有用户可改的入口。
 */

import type {
  Logger,
  MagicContextTurnTransform,
  MagicContextTurnTransformInput,
  MagicContextTurnTransformResult,
  RuntimeAttachmentEntry,
  RuntimeMessageEntry,
} from "@zcode/core";
import {
  getModelUsageContextTokens,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ModelUsage,
  type SessionStorePort,
  type TraceContext,
} from "@zcode/contracts";
import { ConfigKey, type ConfigPort } from "@zcode/contracts";
import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";
import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  DegradedPassRefusalError,
  EmergencyFailClosedError,
  StorageBusyRefusalError,
  UnmanagedOverWindowError,
  UnresolvedHistoryBoundaryError,
  createConfigBridge,
  createRawMessageProvider,
  createScheduler as createPackageScheduler,
  createTagger,
  createTransform,
  drainHistorianSchedulerWithTimeout,
  findConfigReadinessError,
  getActiveCompartmentRun,
  getMagicContextDatabasePath,
  getMigrationOnOpenRefusal,
  getSchemaFenceRejection,
  initializeMagicContextHost,
  isFailClosedBlockingError,
  isTransientSqliteError,
  isTransientStorageOpenError,
  loadPersistedUsage,
  noteEntry,
  openDatabase,
  projectRuntimeEntries,
  projectStoredMessage,
  replayLkg,
  resolveLkgModelKeys,
  resolveModelKey,
  setRawMessageProvider,
  snapshotRuntimeEntries,
  updateSessionMeta,
  type ContextDatabase,
  type MagicContextConfig,
  type MessageLike,
  type MigrationOnOpenRefusal,
  type RawMessage,
  type Scheduler,
  type TransformDeps,
  type ZCodeRuntimeEntry,
} from "@zcode/magic-context";
import {
  createMagicContextHistorianHost,
  type CreateSidecarModel,
  type MagicContextHistorianHost,
} from "./magic-context-historian.js";
import { emitMagicContextTransformAbsent } from "./magic-context-absent-event.js";
import { readMagicContextUsageSummary } from "./magic-context-usage-summary.js";

/** 包内 `createTransform` 的返回值形状（单测用桩实现替换它）。 */
export type ZCodeMagicContextTransform = (
  input: Record<string, never>,
  output: { messages: unknown[] },
) => Promise<void>;

export interface MagicContextTurnTransformOptions {
  /**
   * **冷**求值后的 effective 开关（`features.magicContext && magicContext.enabled`，
   * 见 spec 契约 8 与 `runtime-config.ts`）。false → 工厂直接返回 undefined：不开
   * bridge、不 import 模块图、不开 DB。
   *
   * 运行中切换走返回端口上的 `isEnabled()`，不是这里。
   */
  enabled: boolean;
  /**
   * FORK（S23 / D-12）：本 App 的配置口。提供时 config bridge 订阅
   * `ConfigPort.observe(ConfigKey.MagicContext)`，运行中改配置**下一 turn 即生效**，
   * 无需重启。
   *
   * 缺席时退回 S19b 的静态快照（只读 `configDomain`），保留给单测与不装配配置面的
   * embedder；生产装配（`create-app.ts`）一定传入。
   */
  configPort?: ConfigPort;
  /** `RuntimeConfig.magicContext` 参数域快照；仅在没有 `configPort` 时作为配置源。 */
  configDomain?: unknown;
  sessionId: string;
  workingDirectory: string;
  /** 读历史的第二数据源；缺席时 raw-message provider 只服务内存历史。 */
  sessionStore?: SessionStorePort;
  logger: Logger;
  /**
   * FORK（S24 / D-6）：`"provider/model"` → 一个可发请求的 `Model`。historian 的
   * sidecar 请求经它发出，缺席时 executor **不装**、`historianRunnable` 保持 false
   * （见 `createMagicContextHistorianHost`）。生产装配（`create-app.ts`）由
   * provider Registry + `modelFactory` 提供。
   */
  createSidecarModel?: CreateSidecarModel;
  /** 会话根 trace；sidecar 请求在它下面开子 span。 */
  traceContext?: TraceContext;
  /**
   * FORK（MF-05）：把本装配的**关闭钩子**交给装配层。
   *
   * 之前 `drainHistorianSchedulerWithTimeout` / `historian.shutdown` /
   * `bridge.dispose` 三件事没有任何生产调用方（config bridge 在
   * `config-bridge.ts` 里订阅 `ConfigPort` 且永不退订），于是会话/进程结束时
   * 在飞的 historian 不会被收口、订阅计数也不会归零。
   *
   * 装配层把它挂进 `session-facade.ts` 的 `close()` 链——**必须**在
   * `closeSessionResources` 之前：historian 的在飞请求要写库，而 store / execution
   * port 一旦先关，写库就落在已关闭的 store 上。
   *
   * 缺席（单测与不装 historian 的装配）= 不产生关闭钩子，行为与本 fork 之前逐行
   * 相同。
   */
  registerClose?(close: () => Promise<void>): void;
  /**
   * FORK（S24）：provider usage 的记录口。上游 OpenCode 的 plugin 在
   * `message.updated` 事件里写这张表，ZCode 没有 plugin 事件通道，于是这里由宿主
   * 从 `model_complete` 事件喂。**不接它等于永久 `percentage=0`**——scheduler 永远
   * `defer`，drop 与 historian 都不会启动（实测见 E2E 报告 T-M2 的 FAIL 记录）。
   * 缺席时退回 S19b 的空 Map，行为与那时逐行相同。
   */
  usageRecorder?: MagicContextUsageRecorder;
  /**
   * FORK（D-13）：预算摘要的出口。装配层（`create-app`）把它接到 v4 gateway 的
   * `updateMagicContextUsage`，于是 `usage.magicContext` 出现在桌面 ChatContextUsage
   * 面板上。
   *
   * **缺席 = 整条推送不存在**：CLI/TUI 前端没有 snapshot 投影层，不传它；没有它时
   * 本文件只多两个 `if (!sink) return`，DB 读写一次都不多。传 `null` 表示「读不到」，
   * 投影层据此删掉该键（面板整段收起），**不是**写一份全零。
   */
  onMagicContextUsage?: (usage: SessionMagicContextUsage | null) => void;
}

/**
 * FORK（D-13 / MF-11）：把一次预算摘要读数推给投影层，**绝不**让读失败变成静默。
 *
 * 读不出来时推 `null`——投影层据此删掉该键、面板整段收起。这不是可选的礼貌：
 * 之前的 `.catch(() => {})` 让面板停留在上一帧的读数上，用户看到的是「用量卡住
 * 了」，而真相是「这一轮没读到」。空 catch 的注释承诺与代码不一致，正是 MF-11 的
 * 全部内容。
 *
 * 不 await：UI 的用量面板必须永远不等一次 sqlite 读。`sink` 自己抛错也被就地消化
 * ——诊断面不参与这一轮的成败，更不该变成一条 unhandled rejection。
 */
export function pushMagicContextUsageSummary(
  read: () => Promise<SessionMagicContextUsage | null>,
  sink: (usage: SessionMagicContextUsage | null) => void,
): void {
  void read()
    .then(
      (usage) => {
        sink(usage);
      },
      () => {
        sink(null);
      },
    )
    .catch(() => {
      // sink 自己抛错：到这里读已经成功，吞掉即可。
    });
}

/**
 * FORK（e2e/R-2）：catalog 与 registry 都给不出 `properties.contextWindow` 时的
 * **保守默认窗口**（token）。
 *
 * 与包内 transform 的 `boundaryContextLimit` 兜底同值——那里在拿不到任何 limit
 * 时同样落到 128_000（见包内 transform 的边界解析）。方向上偏保守：窗口取小 ⇒
 * percentage 偏大 ⇒ 压缩宁可早一步；真发出去前 wire-estimate / emergency /
 * DegradedPassRefusalError 等通道仍会拦住超窗口请求，不会把裸历史发给 provider。
 *
 * 这是 e2e/R-2「二层兜底」的最后一层：第一层是模型自带的 `properties.contextWindow`
 * （catalog），第二层是装配层注入的「会话生效模型」registry 查询。三层都落空时用
 * 这里的值——percentage 从此永远算得出来，scheduler 不再因窗口缺席而恒 defer。
 */
export const MAGIC_CONTEXT_CONSERVATIVE_CONTEXT_WINDOW = 128_000;

/** e2e/R-2：保守默认窗口的 env 覆盖（诊断/实验通道，不是产品开关）。 */
export const MAGIC_CONTEXT_DEFAULT_CONTEXT_WINDOW_ENV =
  "ZCODE_MAGIC_CONTEXT_DEFAULT_CONTEXT_WINDOW";

/** 读出「可用的正数窗口」；非有限/非正数一律视为缺席（走下一层兜底）。 */
function positiveWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * e2e/R-2 二层兜底：窗口的最终来源。每次求值都现读 env——测试改
 * `ZCODE_MAGIC_CONTEXT_DEFAULT_CONTEXT_WINDOW` 后下一次绑定即生效，不需要重建
 * recorder。
 */
function resolveConservativeContextWindow(env: NodeJS.ProcessEnv = process.env): number {
  return (
    positiveWindow(Number(env[MAGIC_CONTEXT_DEFAULT_CONTEXT_WINDOW_ENV])) ??
    MAGIC_CONTEXT_CONSERVATIVE_CONTEXT_WINDOW
  );
}

/** `TransformDeps.contextUsageMap` 的值形状（包内 `loadContextUsage` 读的那三个字段）。 */
export interface MagicContextUsageMapEntry {
  hasUsageTokens: boolean;
  lastResponseTime: number;
  updatedAt: number;
  usage: { inputTokens: number; percentage: number };
}

/**
 * provider usage 记录器（S24）。
 *
 * 它是 S19b 留下的 `contextUsageMap` 空表的**唯一生产者**，而且必须**两边都写**：
 *
 *   - **内存**：本进程这一轮读数。`loadContextUsage` 的快路径。
 *   - **session_meta**（`last_context_percentage` / `last_input_tokens` /
 *     `last_response_time`）：跨进程。CLI 每一轮 prompt 都是**一个新进程**，只写
 *     内存等于每轮从 0 开始——实测那样 scheduler 永远 `defer`，drop 与 historian
 *     一次都不启动。
 *
 * 跨进程那一半由 {@link MagicContextUsageRecorder.prime} 在装配期读回：CLI 每一轮
 * prompt 都是**一个新进程**，只写内存等于每轮从 0 开始——实测那样 scheduler 永远
 * `defer`，drop 与 historian 一次都不启动。读回之后本进程的第一 pass 就带着它，
 * 而 transform 的「首 pass 重置」在 `hostProcessLifetime:"one-process-per-turn"`
 * 下不再清零（S24-fix，见上面装配表的注与 MVP 报告 §3）。换模型时 transform 自己
 * 会 `contextUsageMap.delete(sessionId)`，所以这份读数不会跨模型生效。
 *
 * 落库时**同一笔**写上 `last_observed_model_key` / `last_usage_context_limit`：那是
 * 「这条读数在哪个模型、哪个窗口上量的」的凭据，transform 的换模型失效判据只看这两
 * 列（`lastObservedModelKey`）+ 那两列计出来的占比。
 *
 * 百分比的分母是**本轮真实模型的窗口**——装配期没有 turn，也就还没有这个事实，
 * 所以分母来自 `noteLiveModel`。
 *
 * ── e2e/R-2（窗口三源） ────────────────────────────────────────────────────────
 *
 * 死结原形：`record()` 的 `contextWindow === undefined` 恒 skip ⇒ percentage 恒
 * 0 ⇒ scheduler 恒 defer ⇒ 压缩一次不启动。而 `contextWindow` 的唯一来源
 * `noteLiveModel` 又只在 **pass 成功后**的 `notifyPassSucceeded` 被调用——pass 需要
 * percentage 才决定做不做事，percentage 又需要一次成功 pass 才拿得到窗口，鸡生蛋。
 * 用户实证的触发条件是「未设置历史/默认模型」：那条路径上模型的
 * `properties.contextWindow` 在 catalog/registry 里也缺席。
 *
 * R-2 的两半修法：
 *   ① 绑定提前——turn 开始（端口入口，pass 之前）即 `noteLiveModel(input.model)`，
 *      见 `createZCodeMagicContextTurnTransformPort` 的 `onTurnStart`；
 *   ② 窗口三源——模型自带 properties → 装配层兜底（会话生效模型的 registry
 *      查询，create-app 注入 `resolveFallbackContextWindow`）→ 保守默认/env
 *      （`MAGIC_CONTEXT_CONSERVATIVE_CONTEXT_WINDOW`）。
 */
export interface MagicContextUsageRecorder {
  /** 直接交给 `TransformDeps.contextUsageMap`。 */
  readonly contextUsageMap: Map<string, MagicContextUsageMapEntry>;
  /** 装配期：把上一次落库的读数读回内存，让本进程的第一 pass 就带着它。 */
  prime: (db: ContextDatabase) => void;
  /** 记住本轮真实模型的窗口与身份，作为百分比分母 + `last_observed_model_key`。 */
  noteLiveModel: (model: MagicContextRecorderModel) => void;
  /** 记一次 provider usage。`contextUsed` 缺席（provider 未报）时**不写**。 */
  record: (input: { at?: number; usage: ModelUsage }) => void;
  /**
   * S24-fix：本进程当前已知的真实占用读数（内存优先，落库兜底），供后台 historian
   * pass 解 protected-tail 边界。**没有任何读数时返回 `null`**——「不知道」与「0」
   * 不是一回事，边界解算对两者的偏袒方向相反。
   */
  readUsage: () => MagicContextUsageMapEntry["usage"] | null;
  /**
   * FORK（D-13）：登记「本进程刚记下一次 provider usage」的观察者。
   *
   * 谁需要这个观察者？只有**把预算摘要推给投影层**的那条链：`last_input_tokens` /
   * `last_context_percentage` 是在 `record()` 里落库的，transform pass 结束那一刻它们
   * 还是上一轮的值。于是装配层在这里挂一个「读完就推」的回调，UI 才能在同一轮里看到
   * 新水位——挂成硬依赖反而会让 S19b 的单测（没有投影层）多出一条路径。
   */
  onUsageRecorded: (listener: () => void) => void;
}

/** `noteLiveModel` 只需要模型的这两处；用 Pick 免得装配层为了传值造一个 Model。 */
export interface MagicContextRecorderModel {
  providerId?: string;
  modelId?: string;
  properties?: { contextWindow?: number };
}

export function createMagicContextUsageRecorder(
  sessionId: string,
  logger?: Logger,
  options?: {
    /**
     * FORK（e2e/R-2 二层兜底）：模型自带 `properties.contextWindow` 缺席时的窗口
     * 解析。装配层（create-app）传入的闭包解析「会话生效模型」（显式选择 ?? 活默认，
     * 与 agent/C-1 的 `resolveConfiguredDefaultModelSelectionOf` 同源）并在
     * provider registry 里查它的窗口。返回 undefined 时落到保守默认/env 那一层。
     */
    resolveFallbackContextWindow?: () => number | undefined;
  },
): MagicContextUsageRecorder {
  const contextUsageMap = new Map<string, MagicContextUsageMapEntry>();
  const recordedListeners: Array<() => void> = [];
  let contextWindow: number | undefined;
  let modelKey: string | null = null;
  let db: ContextDatabase | undefined;
  const note = (level: "debug" | "info", event: string, detail: Record<string, unknown>): void =>
    logger?.[level]("Magic context usage recorder", {
      module: "bootstrap",
      event,
      sessionId,
      ...detail,
    });
  // 观察者异常不许打断记录：`record` 在事件扇出里被调用，一次读数失败已经不该
  // 让事件投递失败，监听者的失败更不该。
  const notifyRecorded = (): void => {
    for (const listener of recordedListeners) {
      try {
        listener();
      } catch {
        // 纯展示面，吞掉。
      }
    }
  };
  return {
    contextUsageMap,
    onUsageRecorded: (listener) => {
      recordedListeners.push(listener);
    },
    prime: (handle) => {
      db = handle;
      try {
        const persisted = loadPersistedUsage(handle, sessionId);
        if (!persisted) return;
        contextUsageMap.set(sessionId, {
          usage: persisted.usage,
          updatedAt: persisted.updatedAt,
          lastResponseTime: persisted.updatedAt,
          // true = 这条读数带真 token（上一轮 provider 真的报过），transform 直接
          // 采信而不回表重算。见 `loadContextUsage` 的快路径。
          hasUsageTokens: true,
        });
        note("debug", "magic_context.usage_primed", { ...persisted.usage });
      } catch (error) {
        note("info", "magic_context.usage_prime_failed", {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
    noteLiveModel: (model) => {
      // e2e/R-2：窗口三源——模型自带（catalog）→ 装配层兜底（会话生效模型的
      // registry 查询）→ 保守默认/env。原实现只认第一源，缺席时
      // `contextWindow` 保持 undefined，`record()` 于是恒 skip、percentage 恒 0
      // （用户实证场景：未设置历史/默认模型 ⇒ catalog 无窗口 ⇒ 压缩一次不启动）。
      // 现在三个来源都落空也有 128_000 兜底，`contextWindow` 恒为正数。
      const window =
        positiveWindow(model.properties?.contextWindow) ??
        positiveWindow(options?.resolveFallbackContextWindow?.()) ??
        resolveConservativeContextWindow();
      contextWindow = window;
      // S24-fix：`last_observed_model_key` 是 transform 换模型失效判据的**唯一**输入
      // （`persistedUsageBeforeResets.lastObservedModelKey`）。不写它，「换模型后用旧
      // 模型的占用去算新模型的阈值」这条路径就永远不触发。这里用包内 `resolveModelKey`
      // 而不是自己拼字符串——宿主另写一份 key 规范化迟早与包内漂移。
      modelKey = resolveModelKey(model.providerId, model.modelId) ?? null;
    },
    record: ({ at = Date.now(), usage }) => {
      const inputTokens = getModelUsageContextTokens(usage);
      // provider 没报 input（某些 sidecar/错误路径）时写 0 只会把「不知道」说成
      // 「很空」，而 0% 会让 scheduler 一直 defer——所以宁可保持上一次的读数。
      //
      // e2e/R-2：`contextWindow` 分支保留作防御（三源兜底后恒为正数，见
      // `noteLiveModel`），但不再是主跳过原因——R-2 之前它才是：未配置模型的
      // 会话每轮都在这里 skip，`usage_skipped` 的 `contextWindow: null` 与
      // `inputTokens: null` 是两道可区分的门（取证锚点见 spec）。
      if (inputTokens === undefined || contextWindow === undefined || contextWindow <= 0) {
        // 「没记上」是异常而不是常态：它意味着 transform 会一直看到 0% 并永远 defer。
        // 所以这条走 info 而不是 debug——默认日志级别下它必须看得见。
        note("info", "magic_context.usage_skipped", {
          inputTokens: inputTokens ?? null,
          contextWindow: contextWindow ?? null,
        });
        return;
      }
      const percentage = (inputTokens / contextWindow) * 100;
      note("debug", "magic_context.usage_recorded", { inputTokens, contextWindow, percentage });
      contextUsageMap.set(sessionId, {
        usage: { inputTokens, percentage },
        updatedAt: at,
        lastResponseTime: at,
        // true = 这条读数带真 token，transform 直接采信而不回表重算
        // （`loadContextUsage` 的快路径）。
        hasUsageTokens: true,
      });
      if (!db) {
        notifyRecorded();
        return;
      }
      try {
        updateSessionMeta(db, sessionId, {
          lastContextPercentage: percentage,
          lastInputTokens: inputTokens,
          lastResponseTime: at,
          // S24-fix：这两列与前两列必须**同一笔**落库。`last_observed_model_key` /
          // `last_usage_context_limit` 是「上一次读数是在哪个模型、哪个窗口上量的」
          // 的凭据；缺了它们，下一个进程读到这条读数时无法判断它属于自己还是上一个
          // 模型（换模型失效路径静默失效，见 MVP 报告 §6.3）。
          ...(modelKey === null ? {} : { lastObservedModelKey: modelKey }),
          lastUsageContextLimit: contextWindow,
        });
      } catch (error) {
        // 落库失败只影响下一个进程的第一 pass，本进程这一轮仍用内存读数。
        note("info", "magic_context.usage_persist_failed", {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      // 落库之后才通知：观察者要读的就是刚落库的那几列。
      notifyRecorded();
    },
    readUsage: () => contextUsageMap.get(sessionId)?.usage ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 反投影：MessageLike[] → RuntimeMessageEntry[]
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ToolPart {
  type: "tool";
  callID?: unknown;
  tool?: unknown;
  providerExecuted?: unknown;
  state?: { status?: unknown; input?: unknown; output?: unknown; error?: unknown };
}

function isToolPart(part: unknown): part is ToolPart {
  return isRecord(part) && part.type === "tool";
}

/** 结果态的 tool part 过滤器——必须带类型谓词，否则 filter 只会给出 `unknown[]`。 */
function isCompletedToolPart(part: unknown): part is ToolPart {
  return isToolPart(part) && (part.state?.status === "completed" || part.state?.status === "error");
}

function isAttachment(entry: RuntimeMessageEntry): entry is RuntimeAttachmentEntry {
  return entry.kind === "attachment";
}

function textOf(parts: readonly unknown[]): string {
  return parts
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n\n");
}

function contentBlocksOf(parts: readonly unknown[]): ModelMessageContentBlock[] {
  const blocks: ModelMessageContentBlock[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.type === "tool") continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      blocks.push({
        type: "reasoning",
        text: part.text,
        ...(isRecord(part.providerOptions)
          ? { providerOptions: part.providerOptions as Record<string, unknown> }
          : {}),
      });
      continue;
    }
    // image / video / file / resource_link / 未来新增的块：正投影是 `{...block}`
    // 拷贝，这里再拷一次即回到原值。ZCode 的块联合是封闭的，所以未知 `type`
    // 必须经 `unknown` 过渡——magic-context 的透传语义（"按 type 收窄，未知即惰性"）
    // 只有这样才能表达。
    blocks.push({ ...part } as unknown as ModelMessageContentBlock);
  }
  return blocks;
}

function normalizeContent(content: ModelMessageContent): ModelMessageContentBlock[] {
  const blocks =
    typeof content === "string"
      ? content.length > 0
        ? [{ type: "text" as const, text: content }]
        : []
      : [...content];
  // 空 text block 与「没有 content」在 wire 上等价：正投影把 `""` 变成
  // `[{type:"text",text:""}]`，不归一化就会把每一条空回复误判成"被改写"。
  return blocks.filter((block) => !(block.type === "text" && block.text.length === 0));
}

function sameContent(left: ModelMessageContent, right: ModelMessageContent): boolean {
  const leftBlocks = normalizeContent(left);
  const rightBlocks = normalizeContent(right);
  if (leftBlocks.length !== rightBlocks.length) return false;
  return leftBlocks.every((block, index) => {
    const other = rightBlocks[index];
    return other !== undefined && JSON.stringify(block) === JSON.stringify(other);
  });
}

function toolOutputOf(part: ToolPart): string {
  if (typeof part.state?.output === "string") return part.state.output;
  return typeof part.state?.error === "string" ? part.state.error : "";
}

/**
 * 重建后的消息与原始 entry 等价时**复用原始 entry 对象**。
 *
 * 这是 m[0]/m[1] 与 cache 前缀稳定性的关键：transform 没碰过的消息必须以原对象
 * （连同 `metadata.source` / `tokens` / `cacheControl`）进入双投影，否则每一 pass
 * 都会因对象身份变化而抖动。
 *
 * 这里**不复用**包里的 `projectMessageUnchanged` 作为判定：它对带 toolCalls 的
 * assistant 一律返回 false（于是每 pass 都重建、丢掉 metadata 与 cacheControl 落点），
 * 又对纯文本 user 消息只看 role、不看内容（于是 §N§ 打标会被静默丢弃）。本函数是
 * `rebuildEntry` 的严格镜像：任何"重建后与原消息不同"的情形都判定为已改动。
 */
function isUnchanged(message: MessageLike, original: RuntimeMessageEntry): boolean {
  if (isAttachment(original)) return message.parts.length === 1;
  const source = original.message;
  const parts = message.parts;
  const toolResults = parts.filter(isCompletedToolPart);

  // ZCode 的 tool 结果是独立 entry；正投影把它折成一条 user 消息上的 tool part。
  if (source.role === "tool") {
    if (toolResults.length !== 1 || message.info.role !== "user") return false;
    const only = toolResults[0]!;
    if ((only.state?.status === "error") !== (source.isError === true)) return false;
    if (only.callID !== source.toolCallId || only.tool !== (source.toolName ?? "")) return false;
    return sameContent(toolOutputOf(only), source.content);
  }

  if (message.info.role !== source.role) return false;
  if (parts.some(isToolPart) && source.role !== "assistant") return false;
  if (!sameContent(contentBlocksOf(parts), source.content)) return false;

  const calls = source.role === "assistant" ? parts.filter(isToolPart) : [];
  const expected = source.toolCalls ?? [];
  if (calls.length !== expected.length) return false;
  return calls.every((call, index) => {
    const want = expected[index];
    return (
      want !== undefined &&
      call.callID === want.id &&
      call.tool === want.name &&
      JSON.stringify(call.state?.input) === JSON.stringify(want.input)
    );
  });
}

function rebuildEntry(
  message: MessageLike,
  original: RuntimeMessageEntry | undefined,
): RuntimeMessageEntry {
  const parts = message.parts;
  const metadata = original && !isAttachment(original) ? original.metadata : undefined;
  const toolResults = parts.filter(isCompletedToolPart);
  // magic-context 把 tool 结果挂在一条 user 消息上，ZCode 建模为独立
  // `role:"tool"` entry —— 按 OpenCode 的 `toModelMessages` 规则拆回去。
  if (toolResults.length > 0 && message.info.role === "user") {
    const only = toolResults[0]!;
    const failed = only.state?.status === "error";
    return {
      message: {
        role: "tool",
        content: toolOutputOf(only),
        toolCallId: typeof only.callID === "string" ? only.callID : "",
        toolName: typeof only.tool === "string" ? only.tool : "",
        ...(failed ? { isError: true } : {}),
      },
      ...(metadata ? { metadata } : {}),
    };
  }

  const content = contentBlocksOf(parts);
  const role = message.info.role === "unknown" ? "user" : (message.info.role ?? "user");
  const calls = role === "assistant" ? parts.filter(isToolPart) : [];
  return {
    message: {
      role: role as "user" | "assistant" | "system" | "tool",
      content: content.length === 0 ? "" : content,
      ...(calls.length === 0
        ? {}
        : {
            toolCalls: calls.map((call, index) => ({
              id: typeof call.callID === "string" ? call.callID : `mc_call_${index}`,
              name: typeof call.tool === "string" ? call.tool : "",
              input: call.state?.input,
              ...(call.providerExecuted === true ? { providerExecuted: true } : {}),
            })),
          }),
    },
    ...(metadata ? { metadata } : { metadata: { source: "legacy_synthetic" as const } }),
  };
}

function magicContextAttachment(message: MessageLike): RuntimeMessageEntry {
  return {
    kind: "attachment",
    content: textOf(message.parts),
    metadata: { source: "magic_context" },
  };
}

/**
 * m[0]/m[1] 的落位。
 *
 * 正投影把它们 unshift 到数组最前，而 ZCode 的 system prompt 是 `entries[0]`。
 * 照搬会让"注入上下文"排在 system 指令之前——OpenCode 里不存在这个差异（它的
 * system prompt 不在 messages 里）。所以这里把它们挪到**开头连续 system 段之后**：
 * 既保住"本轮之前"的语义，又不改 provider projection 的任何规则
 * （`reorderAttachmentLikeEntries` 见到 provider-visible 的 meta attachment 只会
 * 维持它相对前一个 bubble stop 的位置）。
 */
function hoistHeadsAfterSystemPrefix(entries: RuntimeMessageEntry[]): {
  entries: RuntimeMessageEntry[];
  headPositions: number[];
} {
  const isHead = (entry: RuntimeMessageEntry | undefined): boolean =>
    entry !== undefined && isAttachment(entry) && entry.metadata.source === "magic_context";
  if (!isHead(entries[0])) {
    return {
      entries,
      headPositions: entries.flatMap((entry, index) => (isHead(entry) ? [index] : [])),
    };
  }
  let headCount = 0;
  while (headCount < entries.length && isHead(entries[headCount])) headCount += 1;
  const heads = entries.slice(0, headCount);
  const rest = entries.slice(headCount);
  let systemCount = 0;
  while (systemCount < rest.length) {
    const candidate = rest[systemCount]!;
    if (isAttachment(candidate) || candidate.message.role !== "system") break;
    systemCount += 1;
  }
  return {
    entries: [...rest.slice(0, systemCount), ...heads, ...rest.slice(systemCount)],
    headPositions: Array.from({ length: heads.length }, (_, index) => systemCount + index),
  };
}

function projectMagicContextEntries(
  messages: readonly MessageLike[],
  originals: ReadonlyMap<string, RuntimeMessageEntry>,
): { entries: RuntimeMessageEntry[]; syntheticHeadPositions: number[] } {
  const flat: RuntimeMessageEntry[] = [];
  for (const message of messages) {
    if (message.info.syntheticHead === true) {
      flat.push(magicContextAttachment(message));
      continue;
    }
    const original =
      typeof message.info.id === "string" ? originals.get(message.info.id) : undefined;
    flat.push(
      original && isUnchanged(message, original) ? original : rebuildEntry(message, original),
    );
  }
  const { entries, headPositions } = hoistHeadsAfterSystemPrefix(flat);
  return { entries, syntheticHeadPositions: headPositions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 包内 `features/magic-context/scheduler.ts` 的真身（S21 落地）消费 camelCase 的
 * `SchedulerConfig`，而本文件持的是 snake_case 的 `MagicContextConfig`——这里只做
 * 键名映射，判据（brand-new session 跳过、tokens 模式换算 contextLimit 等）全部
 * 归包内权威实现。原 Step 19b 的最小版 scheduler 已随真身落地删除。
 */
function createZCodeScheduler(config: MagicContextConfig): Scheduler {
  return createPackageScheduler({
    executeThresholdPercentage: config.execute_threshold_percentage,
    ...(config.execute_threshold_tokens === undefined
      ? {}
      : { executeThresholdTokens: config.execute_threshold_tokens }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RawMessageProvider 的持久历史半边
// ─────────────────────────────────────────────────────────────────────────────

interface StoredRow {
  raw: RawMessage;
  timeCreated: number;
  id: string;
  /** 1-based 的存储序（ordinal）。 */
  ordinal: number;
}

function toStoredRows(
  messages: readonly {
    info: {
      id: string;
      role: string;
      time?: { created?: number; completed?: number };
      summary?: unknown;
      finish?: string;
    };
    parts: readonly unknown[];
  }[],
  sessionId: string,
): StoredRow[] {
  return messages.map((message, index) => {
    const created =
      typeof message.info.time?.created === "number" ? message.info.time.created : index;
    return {
      raw: projectStoredMessage({
        id: message.info.id,
        role: message.info.role,
        parts: message.parts,
        sessionId,
        createdAt: created,
        completedAt: message.info.time?.completed,
        summary: message.info.summary !== undefined,
        ...(message.info.finish === undefined ? {} : { finish: message.info.finish }),
      }) as unknown as RawMessage,
      timeCreated: created,
      id: message.info.id,
      ordinal: index + 1,
    };
  });
}

/**
 * 按 ordinal 切一页。ordinal 是 1-based 的存储序（ZCode 的
 * `sequence is null, sequence, time_created, rowid`），与 `SessionStorePort.messages()`
 * 的顺序一致，因此 ordinal 在两侧是同一个位置。
 */
function pageFromRows(
  rows: readonly StoredRow[],
  afterOrdinal: number,
  limit: number,
  finalWatermark: number,
): RawMessage[] {
  const page = rows.filter((row) => row.ordinal > afterOrdinal && row.ordinal <= finalWatermark);
  return page.slice(0, Math.max(0, Math.floor(limit))).map(withOrdinal);
}

/** `projectStoredMessage` 产出的 `MessageLike` 补上 ordinal 即成 `RawMessage`。 */
function withOrdinal(row: StoredRow): RawMessage {
  return { ...row.raw, ordinal: row.ordinal } as RawMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⑤-5a 结构化事件面：transform **缺席**（不是「跑了但没做事」）时发一条
 * `magic_context.transform_absent`（logger.warn 级），带机器可判的 `reason`。
 *
 * 为什么需要它：⑤ 的本机取证显示桌面 app-server 进程开库成功、但 transform 从未
 * 创建/从未执行，且该缺席**完全静默**——0 条 transform pass、0 条失败日志、0 条
 * storage 事件，用户完全看不出「压缩已停机」。三条缺席路径全部发事件后，桌面
 * 日志/事件面第一次能回答「为什么没有压缩」（细分词表见 leaf 模块的文件头）。
 *
 * mc/A-1 / mc/C-orch-1：发射点收敛到零依赖 leaf
 * `magic-context-absent-event.ts`——本模块在 flag 关时**不被加载**（装配门的
 * 成本纪律），disabled 事件不可能由它发出，而 create-app 侧另写一条同形状的
 * logger.warn 会让事件名/reason 词表分裂成两处无类型约束的字面量。leaf 零依赖，
 * 装配层静态 import 它没有启动成本。工厂内只保留直构/测试路径的发射：
 *
 *   - `disabled`       ：**生产由 create-app 侧发射**（见那里的 enabled gate
 *                        else 分支）；本分支保留给直构/测试
 *   - `db_null:<细分>` ：本工厂的 openDatabase 返回 null 路径（细分见
 *                        `describeStorageUnavailability`）
 *   - `import_failed`  ：装配层（create-app.ts）动态 import 本模块失败（5b）
 *
 * 语义边界（fail-closed 契约不受影响，事件只是可观测性）：
 *   - import_failed：发事件后**照旧 throw**（保留 fail-closed 性状）；
 *   - disabled / db_null：发事件后照旧 return undefined 降级；db_null 且
 *     `fail_closed_blocking=true` 时同样**先发事件、再 throw**。
 */
// （发射实现见 ./magic-context-absent-event.ts 的 emitMagicContextTransformAbsent）

/**
 * 把 `openDatabase` 的 null 归到可行动的细分上（供 `db_null:<细分>` 的 reason）。
 *
 * 优先级与包内一致（migration_guard → schema_fence → storage_failure），守卫见
 * 包内 `storage-unavailable-reason.ts:24`：**migration 且确有阻塞进程（或不可读
 * 文件）** 才判 migration_guard——只有一条 migration 记录但零 blockers 时不误判
 * （unreadable+空 pids 两处结论必须相同，mc/C-1）。刻意**不在 bootstrap 侧 import
 * 那个 helper：它未出包公共面，为本文件一个 reason 字符串去扩公共面不划算；这里用
 * 已导出的 `getMigrationOnOpenRefusal` / `getSchemaFenceRejection` 两个 accessor
 * 现拼（模块级状态由最近一次 open 写入，每次 open 前都会被清空，因此拿到 null 时
 * 它们就是权威细分）。
 *
 * busy/瞬时类不在此列：那是 openDatabase 的 **throw** 路径（cause 链分类见
 * `isTransientStorageOpenError`），由上面的有界重试负责，不会以 null 形态到达
 * 本函数。
 *
 * `refusal` 参数是测试缝（仅测试缝，不扩运行时面）：缺省读模块级状态（与生产零参
 * 调用逐行等价），表驱动用例可直接注入夹具，免去为一条细分去伪造整个 open 场景。
 */
export function describeStorageUnavailability(
  refusal: MigrationOnOpenRefusal | null = getMigrationOnOpenRefusal(),
): {
  reason: "db_null:migration_guard" | "db_null:fence" | "db_null:pending_or_unclassified";
  detail: string;
} {
  // 与包内 storage-unavailable-reason.ts:24 同形守卫：migration 记录在场但毫无
  // 阻塞证据（serverPids/blockingProcesses 皆空且没有 unreadableFile）时不判
  // migration_guard——包内只在「挡着迁移的活进程确定存在」时给这个 kind。
  if (
    refusal &&
    ((refusal.blockingProcesses?.length ?? refusal.serverPids.length) > 0 || refusal.unreadableFile)
  ) {
    return {
      reason: "db_null:migration_guard",
      detail: `magic-context.db migration on open refused: database v${refusal.persistedVersion} blocked by ${refusal.serverPids.length} live server process(es) on an older build`,
    };
  }
  const fence = getSchemaFenceRejection();
  if (fence) {
    return {
      reason: "db_null:fence",
      detail: `magic-context.db schema fence rejected: database v${fence.persistedVersion} is newer than this build supports (v${fence.supportedVersion})`,
    };
  }
  return {
    reason: "db_null:pending_or_unclassified",
    detail:
      "magic-context.db could not be opened (pending async open competing for the same path, or an unclassified refusal)",
  };
}

/**
 * ⑤-5a：boot 开库的退避序列（毫秒）。
 *
 * 值与包内 `migrations.ts` 的 `MIGRATION_LOCK_RETRY_DELAYS_MS`
 * （[1s,2s,4s,8s,15s]）的**前 4 档**一致；那个常量是模块私有符号、未出包公共面，
 * 不为一次 import 去扩公共面，因此这里按同一序列复制前 4 档并在本注释登记出处
 * （若包内序列调整，两处需同步）。上界语义同样对齐包内
 * `runMigrationsWithRetry`：delays.length + 1 次尝试。
 */
const MAGIC_CONTEXT_BOOT_OPEN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * ⑤-5a：boot 开库的**有界** busy 重试。
 *
 * 只对 busy/瞬时类失败重试：5e 之后 `openDatabase` 的 catch 以 `{ cause }` 保留了
 * 底层错误，`isTransientStorageOpenError` 在 cause 链上按类型与 code 判定
 * （`SqliteAcquisitionBusyError` / `MigrationLockBusyError` / `isTransientSqliteError`），
 * **不靠 message 文本猜**。schema fence、ABI 不匹配、路径不可写、迁移体失败等
 * 确定性失败立即重抛，由装配点按 `fail_closed_blocking` 契约处理——重试绝不把
 * fail-closed 偷换成静默降级。
 *
 * fence / migration guard / pending 竞争是 openDatabase 的**确定性 null**（不抛），
 * 天然不进本函数，装配点照旧走 `db_null` 降级路径。
 *
 * 工厂本身是 async，直接 `await` sleep，不冻宿主、也不必改走 `openDatabaseAsync`。
 *
 * `delaysMs` / `sleep` 是测试缝（与 `runMigrationsWithRetry` 的同名选项同一手法）：
 * 生产装配只传 logger，用上面的生产序列。
 */
export async function openMagicContextStorageWithBusyRetry(
  open: () => ContextDatabase | null,
  options: {
    logger: Logger;
    delaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
  },
): Promise<ContextDatabase | null> {
  const delaysMs = options.delaysMs ?? MAGIC_CONTEXT_BOOT_OPEN_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise<void>((r) => setTimeout(r, delayMs)));
  const totalAttempts = delaysMs.length + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return open();
    } catch (error) {
      // 不是 busy/瞬时（fence 之外的确定性失败）⇒ 原样上抛，fail-closed 语义不变。
      if (!isTransientStorageOpenError(error)) throw error;
      const delayMs = delaysMs[attempt - 1];
      // 序列耗尽：上界到顶，维持「重试后仍失败就抛」的 fail-closed 终态。
      if (delayMs === undefined) throw error;
      options.logger.warn("Magic context storage open is busy; retrying with backoff", {
        module: "bootstrap",
        event: "magic_context.storage_open_retry",
        reason: "storage_busy_retry",
        attempt,
        totalAttempts,
        retryInMs: delayMs,
        detail: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }
  // 不可达：循环内每条路径都 return/throw。给 TypeScript 一个确定的收尾。
  throw new Error("[magic_context] storage open retry exhausted without a verdict");
}

export async function createMagicContextTurnTransform(
  options: MagicContextTurnTransformOptions,
): Promise<MagicContextTurnTransform | undefined> {
  // T-M8（Step 19a/23）：门控是**装配层**的判断，且必须是第一句——关着时既不建
  // bridge、也不 import magic-context 模块图、更不开 DB。这一行之下的一切都与
  // Phase 1 基线无关，所以关着时行为逐行等价。
  //
  // ⑤-5a：关着也是一种「缺席」，必须留下可观测痕迹——桌面日志/事件面据此能回答
  // 「为什么没有压缩」，而不是像取证时那样 0 条 transform pass 且 0 条告警。
  // 语义照旧：发事件后 return undefined，不建 bridge、不开 DB。
  //
  // mc/A-1：**生产由 create-app 侧发射 disabled**（flag 关时本模块根本不加载，
  // 只有那边发得出事件）；本分支保留给直构/测试（如 test-boot-busy-retry T4
  // 绕开装配门直调工厂的场景）。
  if (!options.enabled) {
    emitMagicContextTransformAbsent(
      options.logger,
      "disabled",
      "features.magicContext / magicContext.enabled is false; no bridge, no database, no transform",
    );
    return undefined;
  }

  // S15 遗留 #6：`initializeMagicContextHost()` 必须在任何 DB 写之前。装配层把本
  // 工厂放在 flag 判定之后，是因为 flag off 时整条链路（含本文件的动态 import）
  // 都不该发生——那时不存在任何 magic-context DB 写，契约因此自动成立。
  initializeMagicContextHost();

  const bridge = createConfigBridge(createConfigSource(options), {
    // 写入了一个通不过 schema 的域值时，bridge 保留 last-known-good 并把原因交给
    // 这里——降级方向是「这次改动没生效」，而不是「功能被关掉」。
    onReloadFailure: (failure) =>
      options.logger.warn("Magic context config reload rejected; keeping last known good", {
        module: "bootstrap",
        event: "magic_context.config_reload_failed",
        detail: failure.error,
      }),
  });
  const config = bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG;

  // FORK（MF-05）：bridge 一旦建立就持有 `ConfigPort` 的订阅，退订与否必须有
  // 主人。下面三条提前 return 都要走同一个 dispose。
  const disposeBridge = (): void => bridge.dispose();

  const readiness = findConfigReadinessError(config);
  if (readiness) {
    // historian 属 S20/S24；S19b 只记诊断，不因此拒绝装配——否则默认配置（无
    // historian.model）下 flag 一开就完全不可用，而本步交付的是注入链路本身。
    options.logger.warn("Magic context is enabled without a historian model", {
      module: "bootstrap",
      event: "magic_context.config_readiness",
      detail: readiness,
    });
  }

  // ⑤-5a：busy/瞬时失败经 `openMagicContextStorageWithBusyRetry` 有界重试
  // （退避序列 = 包内 MIGRATION_LOCK_RETRY_DELAYS_MS 前 4 档），上界后仍失败照旧
  // 抛给下面的 fail-closed 契约；确定性失败（fence/guard 之外的 ABI、不可写等）
  // 不重试、原样上抛。fence / migration guard / pending 竞争是确定性 **null**，
  // 走下面的 db_null 分支，与重试无关。
  const db = await openMagicContextStorageWithBusyRetry(
    () => openDatabase(getMagicContextDatabasePath()),
    { logger: options.logger },
  );
  if (!db) {
    // 细分 fence / migration_guard / pending_or_unclassified：同一个「库没开出来」，
    // 运维动作完全不同，reason 必须是机器可判的。
    const unavailability = describeStorageUnavailability();
    // ⑤-5a：db_null 缺席**先发事件**再决定降级还是抛错——默认
    // fail_closed_blocking=true 时 :816-818 先 throw，事件不能因此缺席
    // （「带着原因响亮地失败」正是可观测性的落点）。
    emitMagicContextTransformAbsent(options.logger, unavailability.reason, unavailability.detail);
    if (config.fail_closed_blocking !== false) {
      throw new Error(`[magic_context] ${unavailability.detail} (fail_closed_blocking=true)`);
    }
    // 旧名 storage_unavailable → storage_unavailability，与 transform_absent
    // 成对（absent=为什么没有 transform，unavailability=库为什么开不出来）；
    // 已检索零消费者，改名不影响任何消费面。
    options.logger.warn("Magic context storage unavailable; transform stays inert", {
      module: "bootstrap",
      event: "magic_context.storage_unavailability",
      detail: unavailability.detail,
    });
    // DB 开不出来时没有 historian、没有调度器，但 bridge 的 ConfigPort 订阅已
    // 建立——不 dispose 就等于给一个永不会生效的订阅留个尾巴。
    disposeBridge();
    return undefined;
  }

  // deps 必须是**同一个活对象**：包内 transform 每个 pass 都重新读
  // `deps.cacheTtlConfig` / `deps.executeThresholdPercentage` 等字段，所以这里把
  // 配置字段挂在一个稳定引用上，热生效时原地改写即可；重建 deps 反而会让已经
  // 持有的 transform 继续看旧闭包。
  //
  // historian 装配（S24 / D-6）在这里发生一次：executor + `historianRunnable`
  // 一起进 deps。后台调度器与 `/ctx-recomp` runner 的注册也发生在同一个工厂里
  // ——它们必须在任何一条 `/ctx-*` 命令与任何一次 turn 之前就位。
  const historian = createMagicContextHistorianHost(config, {
    logger: options.logger,
    db,
    sessionId: options.sessionId,
    workingDirectory: options.workingDirectory,
    // S24-fix：后台 pass 的 protected-tail 边界改用真实读数（recorder 记的那一份，
    // 装配期 prime 时是上一轮落库的值）。没有 recorder 时保持 `undefined` → 边界解
    // 拿 `null`，与 S24 的 provisional-zero 行为逐字相同。
    ...(options.usageRecorder === undefined
      ? {}
      : { readLiveUsage: options.usageRecorder.readUsage }),
    ...(options.createSidecarModel === undefined
      ? {}
      : { createSidecarModel: options.createSidecarModel }),
    ...(options.traceContext === undefined ? {} : { traceContext: options.traceContext }),
  });

  // 装配期把上一次落库的读数读回内存。CLI 一轮 prompt 一个进程，所以这一行是
  // 「第二轮起 transform 才看得见压力」的全部原因（见 recorder 的文件注释）。
  options.usageRecorder?.prime(db);

  // FORK（D-13）：预算摘要的两个推送时机。这里**不做** await——UI 的用量面板必须
  // 永远不等一次 sqlite 读；推的是 side state，晚一帧只影响面板的新鲜度。
  //
  //   ① pass 成功：compartments / dropped / 上下文缓存命中都在这一轮落定。
  //   ② provider usage 落库：usedTokens / usedPercent 的新水位在这一刻才写进
  //      `session_meta`，pass 结束那一刻读到的还是上一轮的数。
  const publishUsageSummary = (): void => {
    const sink = options.onMagicContextUsage;
    if (!sink) return;
    pushMagicContextUsageSummary(
      async () => (await readMagicContextUsageSummary(db, options.sessionId)).usage,
      sink,
    );
  };
  options.usageRecorder?.onUsageRecorded(publishUsageSummary);

  const deps = buildTransformDeps(config, db, options, historian);
  // ③ 热生效（D-12 第三段）：bridge 订阅 ConfigPort，配置变更即 bump
  // generation/digest 并把新域原地写进 deps。下一个 turn 的第一次 pass 就读到新值
  // ——这就是 spec Step 16 的验收判据（不重启）。
  bridge.onChange((event) => {
    applyConfigToDeps(deps, event.snapshot.effective);
    options.logger.info("Magic context config reloaded", {
      module: "bootstrap",
      event: "magic_context.config_reloaded",
      generation: event.snapshot.generation,
      changedKeys: event.changedKeys,
    });
  });

  const transform = createTransform(deps);
  /**
   * FORK（e2e/R-2）：把本轮实际执行模型绑给两个消费者——后台 protected-tail 边界
   * 的输入，以及 usage recorder 的百分比分母（缺了分母，占比就永远算不出来）。
   *
   * 绑定时机有两处，缺一不可：
   *   - **turn 开始**（`onTurnStart`，pass 之前）：这是 R-2 的核心。原实现只在
   *     pass 成功后绑定，形成鸡生蛋死结——pass 的 scheduler 决策要读 percentage，
   *     percentage 的分母又只在 pass 成功后才有；第一轮/失败轮永远算不出占比，
   *     scheduler 恒 defer（用户实证：未设置历史/默认模型时不压缩）。
   *   - **pass 成功后**（`notifyPassSucceeded`，保留）：turn 中途换模型的场景仍能
   *     在当轮末尾刷新。提前绑定只会让这两处更准，不会互相覆盖出错——同一个
   *     `input.model`，幂等。
   */
  const bindLiveModel = (model: MagicContextTurnTransformInput["model"]): void => {
    historian.noteLiveModel(model);
    options.usageRecorder?.noteLiveModel(model);
  };
  const notifyPassSucceeded = (model: MagicContextTurnTransformInput["model"]): void => {
    bindLiveModel(model);
    // fire-and-forget：本行绝不 await。调度器自己合并同会话的连续触发、自己 drain、
    // 自己 abort——让 UI 等一个可能跑几十秒的 historian 是错的。
    historian.historianScheduler?.notifyTurnSuccess({ sessionId: options.sessionId });
    // D-13 ①：这一 pass 刚改过 compartments / dropped / 缓存块。
    publishUsageSummary();
  };
  // FORK（MF-05）：会话/进程关闭时按 **drain → shutdown → dispose** 的顺序收口。
  //
  //   ① drain（有界）：在飞的那次后台 pass 先跑完，让它的 publish 与 drain 预留真正
  //      落库——「一进程 = 一轮」下这一步不做就等于把尾账留给下一个进程。
  //   ② shutdown：停调度 + abort 在飞的 sidecar 请求（MF-03 补上 signal 之后它才
  //      真的停得下来）。
  //   ③ dispose：退掉 bridge 对 `ConfigPort` 的订阅，订阅计数归零。
  //
  // 三步都必须在 `closeSessionResources` **之前**：historian 要写库，而那时 store /
  // execution port 还开着。
  options.registerClose?.(async () => {
    if (historian.historianScheduler !== undefined) {
      await drainHistorianSchedulerWithTimeout(
        historian.historianScheduler,
        HISTORIAN_SETTLE_TIMEOUT_MS,
      );
    }
    historian.shutdown();
    disposeBridge();
  });

  const port = createZCodeMagicContextTurnTransformPort(transform, {
    getConfig: () => bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG,
    options,
    // e2e/R-2：**turn 开始即绑定**实际执行模型（pass 之前）。门控与
    // `onPassSucceeded` 同源：两个消费者（historian 边界 + usage recorder）
    // 任一在场就挂。historian 的 `noteLiveModel` 只记一个数，runnable=false 时盲记
    // 无害；recorder 缺席时 `bindLiveModel` 内部自动跳过那一半。
    ...(historian.historianScheduler === undefined && options.usageRecorder === undefined
      ? {}
      : { onTurnStart: bindLiveModel }),
    // 两个消费者都不在时**不挂**回调：Step 19b 的单测走的就是这条路径，它必须与
    // S19b 逐行相同。
    ...(historian.historianScheduler === undefined && options.usageRecorder === undefined
      ? {}
      : { onPassSucceeded: notifyPassSucceeded }),
    // FORK（MF-04）：调度器那一次 pass 也需要有界 settle。`notifyTurnSuccess` 本身
    // 仍是 fire-and-forget（不该让 UI 等一次可能几十秒的 historian），但**进程会
    // 退出**——于是在这一轮交还控制权之前，替它等一个有界的窗口。
    ...(historian.historianScheduler === undefined
      ? {}
      : {
          settleScheduledPass: () =>
            drainHistorianSchedulerWithTimeout(
              historian.historianScheduler as NonNullable<typeof historian.historianScheduler>,
              HISTORIAN_SETTLE_TIMEOUT_MS,
            ),
        }),
  });
  // FORK（MF-01）：端口上的活值开关。core 每个 turn 现读它，于是设置页把
  // `magicContext.enabled` 关掉后**下一个 turn**就不再插桩，而不必重启进程。
  //
  // 数据源刻意是 bridge 自己的快照而不是 `runtimeConfig`：那份 config 是装配期的
  // 冻结副本，而这里的快照被 `ConfigPort` 订阅持续更新，正是「活值」的那一半。
  // `enabled` 缺席按 schema 缺省 true 处理。
  const isEnabled = (): boolean =>
    (bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG).enabled !== false;
  return Object.assign(port, { isEnabled });
}

/**
 * D-12 第二段与第三段之间的桥：`ConfigPort` → 包内 `MagicContextConfigSource`。
 *
 * 签名对齐的两处细节（实测 `adapters/src/config/index.ts`）：
 *   - `ConfigPort.observe()` 不接受 key，它返回 `ConfigObserver`，key 在
 *     `.subscribe(key, handler)` 上。因此这里每次 `read()` 取一次 observer 再订阅，
 *     而不是 `observe(key, cb)`。
 *   - `subscribe` 的 handler 是 `(value, prev) => void`，包的 source 只要
 *     `() => void`（它自己会重新 `read()`），所以用 `() => void` 包一层，
 *     **不**把回调参数透传过去——那会让 bridge 拿到上一次的快照当新值。
 *   - `ConfigPort.set` 传的是整域值，`get(key)` 原样返回（无校验），所以
 *     `read()` 不需要自己拼装 `{}`；域校验是 bridge 的活（失败即保留 last-known-good）。
 */
function createConfigSource(options: MagicContextTurnTransformOptions): {
  read: () => unknown;
  subscribe: (listener: () => void) => () => void;
} {
  const configPort = options.configPort;
  if (!configPort) {
    // S19b 遗留的静态源：没有配置口时读一次快照，永不推送。
    return {
      read: () => options.configDomain ?? {},
      subscribe: () => () => {},
    };
  }
  return {
    read: () => configPort.get(ConfigKey.MagicContext),
    subscribe: (listener) =>
      configPort.observe().subscribe(ConfigKey.MagicContext, () => listener()),
  };
}

/**
 * 把一份已校验的配置原地写进 TransformDeps 的配置派生字段。
 *
 * 只覆盖包内声明为「配置来源」的那些字段；`db` / `tagger` / `contextUsageMap` 等
 * 运行期状态不动。`scheduler` 是唯一例外——它在装配时按当时配置闭包捕获了阈值，
 * 所以换成每 pass 现读配置的版本（见 `createZCodeScheduler`）。
 */
function applyConfigToDeps(deps: TransformDeps, config: MagicContextConfig): void {
  deps.cacheTtlConfig = config.cache_ttl;
  if (config.protected_tokens === undefined) {
    delete deps.protectedTokens;
  } else {
    deps.protectedTokens = config.protected_tokens;
  }
  deps.smartDrops = config.smart_drops;
  deps.historyBudgetPercentage = config.history_budget_percentage;
  deps.executeThresholdPercentage = config.execute_threshold_percentage;
  if (config.execute_threshold_tokens === undefined) {
    delete deps.executeThresholdTokens;
  } else {
    deps.executeThresholdTokens = config.execute_threshold_tokens;
  }
  deps.scheduler = createZCodeScheduler(config);
}

function buildTransformDeps(
  config: MagicContextConfig,
  db: ContextDatabase,
  options: MagicContextTurnTransformOptions,
  historian: MagicContextHistorianHost,
): TransformDeps {
  const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
  const liveModels = liveModelBySession;
  return {
    db,
    tagger: createTagger(),
    scheduler: createZCodeScheduler(config),
    // S19b 留的空表；S24 由宿主侧的 usage recorder 供给（见选项说明）。
    contextUsageMap: options.usageRecorder?.contextUsageMap ?? new Map(),
    // S24-fix：声明 ZCode CLI 的进程模型，让包内 transform 的「首 pass usage 重置」
    // 走累积语义而不是上游的清零语义。**这是 T-M2/T-M3/T-M6 三项能跑起来的前提**：
    // 不声明时每一轮 prompt 的首 pass 都会把上一轮落库的占用读数清成 0%，scheduler
    // 于是永远 defer，drop 与 historian 一次都不启动（现场见 MVP 报告 §3）。
    hostProcessLifetime: "one-process-per-turn",
    clearReasoningAge: 50,
    historyRefreshSessions: new Set<string>(),
    pendingMaterializationSessions: new Set<string>(),
    lastHeuristicsTurnId: new Map<string, string>(),
    commitSeenLastPass: new Map<string, boolean>(),
    // C 组缝（S24 接）：sidecar executor 在场时 transform 的 compartment phase
    // 才可能 startCompartmentAgent；两者任一缺席都走「诚实关闭」那条分支
    // （清 `compartmentInProgress`、不起 agent），而不是每 pass 报错。
    ...(historian.hiddenCompletionExecutor === undefined
      ? {}
      : { hiddenCompletionExecutor: historian.hiddenCompletionExecutor }),
    historianRunnable: historian.historianRunnable,
    ...(historian.historianModel === undefined ? {} : { historianModel: historian.historianModel }),
    ...(historian.fallbackModels.length === 0 ? {} : { fallbackModels: historian.fallbackModels }),
    historianTwoPass: historian.historianTwoPass,
    historianTimeoutMs: historian.historianTimeoutMs,
    getHistorianChunkTokens: historian.getHistorianChunkTokens,
    ...(historian.historianMaxOutputTokens === undefined
      ? {}
      : { historianMaxOutputTokens: historian.historianMaxOutputTokens }),
    cacheTtlConfig: config.cache_ttl,
    ...(config.protected_tokens === undefined ? {} : { protectedTokens: config.protected_tokens }),
    smartDrops: config.smart_drops,
    historyBudgetPercentage: config.history_budget_percentage,
    executeThresholdPercentage: config.execute_threshold_percentage,
    executeThresholdTokens: config.execute_threshold_tokens,
    directory: options.workingDirectory,
    projectPath: options.workingDirectory,
    transformMode: "ts",
    liveModelBySession: liveModels,
    getModelKey: (sessionId: string) => {
      const live = liveModels.get(sessionId);
      return live ? `${live.providerID}/${live.modelID}` : undefined;
    },
    getNotificationParams: () => ({}),
    // telemetry-only：变化被记录但不会让 m[0] 折叠。空串 = 恒定指纹。
    getToolSetHash: () => "",
  } satisfies TransformDeps;
}

/**
 * FORK（S24-fix2）：让本 pass 起的 historian 跑完再交还控制权。
 *
 * 上游（OpenCode）是长驻进程：compartment agent 是 fire-and-forget 的，但**进程
 * 不会退出**，所以它跑完的 publish 与 drain 预留一定落地。
 *
 * ZCode CLI 是「一进程 = 一轮 prompt」：transform 一返回，这一轮就结束了，historian
 * 还在飞的那几秒会随进程一起消失——drain 预留泄漏（下一轮报
 * `historian skip: internal drain budget spent`）、compartment 不落库。
 *
 * 所以这里有界地等这一轮 historian 落定（失败/拒绝都被吞掉——它本来就不该影响
 * 这一轮请求）。代价是这一轮的请求会晚发出几秒；这是「进程会退出」这件事在本 fork
 * 里必须付的钱，不改任何判据。
 *
 * provider 的注册范围问题见下面 `ensureProviderRegistered` 的注释。
 */
const HISTORIAN_SETTLE_TIMEOUT_MS = 60_000;

async function settleInFlightHistorian(sessionId: string): Promise<void> {
  const active = getActiveCompartmentRun(sessionId);
  if (!active) return;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, HISTORIAN_SETTLE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      active.promise.then(
        () => undefined,
        () => undefined,
      ),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 端口工厂。导出是因为 Step 19b 的单测要能用一个**桩 transform**驱动整条
 * 投影 → transform → 反投影链路（真实 `createTransform` 需要 magic-context.db 与
 * historian，属 S20/S24 的实跑范围）。
 *
 * FORK（S23 / D-12）：配置改为**每次失败分级时现读**（`getConfig`）而不是构造时
 * 冻结。`fail_closed_blocking` 正是用户在设置页最常改的开关：冻结副本会让用户
 * 刚点下的「不阻塞」在下一次失败里失效，而那次失败的处理方式恰恰由它决定。
 */
export function createZCodeMagicContextTurnTransformPort(
  transform: ZCodeMagicContextTransform,
  port: {
    getConfig: () => MagicContextConfig;
    options: Pick<MagicContextTurnTransformOptions, "sessionId" | "sessionStore" | "logger">;
    /**
     * FORK（e2e/R-2）：**turn 开始**（pass 之前）的本轮模型绑定。
     *
     * 为什么需要第三个时机：`onPassSucceeded` 在 pass **成功后**才跑，而 pass 的
     * scheduler 决策要读 usage percentage，percentage 的分母（模型窗口）又是
     * `onPassSucceeded` 才绑的——第一轮/失败轮永远 defer（鸡生蛋死结，用户实证
     * 「未设置历史/默认模型 ⇒ 不压缩」）。本钩子由工厂在端口入口前调用，先于任何
     * pass 决策拿到分母。同样**刻意不在 core 的 turn-loop 上挂点**——那是本 fork
     * 的纪律禁区；端口入口就是「这一轮的插入点」，语义等价。
     *
     * 缺席（Step 19b 的单测走的就是这条）时端口行为与 R-2 之前逐行相同。
     */
    onTurnStart?: (model: MagicContextTurnTransformInput["model"]) => void;
    /**
     * FORK（S24 / D-6）：每 pass 成功后的 historian 后台驱动。**刻意不在 core 的
     * turn-loop 上挂点**——那要求改 turn-loop 语义（本 fork 的纪律禁区）。本端口
     * 是装配层自己的回调：一次 transform 成功就意味着这一轮请求已被接受，此时让
     * historian 去折叠后台历史正是它该做的。
     *
     * 缺席（Step 19b 的单测走的就是这条）时端口行为与 S19b 逐行相同。
     */
    onPassSucceeded?: (model: MagicContextTurnTransformInput["model"]) => void;
    /**
     * FORK（MF-04）：`onPassSucceeded` 之后**有界**地等调度器那一次后台 pass 落定。
     *
     * 缺席 = 只保留 S24-fix2 的 `settleInFlightHistorian`（它只护 transform **内部**
     * 那条触发路径）。有了本钩子，「一进程 = 一轮」下的调度器 pass 也不再随进程
     * 退出被截断——否则 drain 预留泄漏、compartment 不落库（`:970` 注释自陈的
     * 那条风险）。
     */
    settleScheduledPass?: () => Promise<void>;
  },
): MagicContextTurnTransform {
  const { options } = port;
  // 持久历史快照的缓存键：同一 turn 内 live entries 长度不变，因此整个 turn 只读
  // 一次 session store；跨 turn 长度增长时自然失效。
  let cachedRows: { liveLength: number; rows: StoredRow[] } | undefined;

  async function resolveStoredRows(liveLength: number): Promise<StoredRow[]> {
    if (cachedRows?.liveLength === liveLength) return cachedRows.rows;
    if (!options.sessionStore) {
      cachedRows = { liveLength, rows: [] };
      return cachedRows.rows;
    }
    try {
      const persisted = await options.sessionStore.messages({
        sessionID: options.sessionId as never,
      });
      cachedRows = { liveLength, rows: toStoredRows(persisted, options.sessionId) };
    } catch {
      // 读不到持久历史不是致命错误：provider 会回落到内存 borrow。
      cachedRows = { liveLength, rows: [] };
    }
    return cachedRows.rows;
  }

  // FORK（S24-fix2）：provider 的生命周期是**整个进程**，不是「一次 transform」。
  //
  // 上游（OpenCode）是长驻进程 + 每事件注册，所以「transform 作用域」≈「进程」；
  // 本 fork 是「一进程 = 一轮 prompt」，把注册绑在 transform 上就让**同一轮里的
  // 其它消费者**读不到原始历史：
  //
  //   - historian 的 publish 前边界校验（`hasRawSessionMessageById`）——于是模型已经
  //     产出的 compartment 被 `reason=dangling_boundary` 丢掉；
  //   - `/ctx-flush`、`/ctx-status` 这类命令；
  //   - **`ctx_expand` 按 tag 恢复原文**——`renderItemByTag` 走
  //     `readRawSessionMessageById(tag.toolOwnerMessageId)`，owner 是 `mc<N>`，
  //     没有 provider 就回落到 OpenCode 的库（ZCode 上不存在），于是每一个被 drop
  //     的 tag 都回答「original tool owner is no longer in stored history」（T-M3）。
  //
  // 于是这里注册一次、之后每轮只**换内容**：deps 闭包读下面这两个 holder，provider
  // 对象本身不变。进程退出即失效（CLI 一进程一轮），不留跨进程状态。
  let currentSnapshot: readonly ZCodeRuntimeEntry[] = [];
  let currentRows: StoredRow[] = [];
  let providerRegistered = false;

  function ensureProviderRegistered(sessionId: string): void {
    if (providerRegistered) return;
    setRawMessageProvider(
      sessionId,
      createRawMessageProvider({
        sessionId,
        borrowRuntimeEntries: () => currentSnapshot,
        readStoredMessagePage: ({ afterOrdinal, limit, finalWatermark }) => ({
          messages: pageFromRows(currentRows, afterOrdinal, limit, finalWatermark),
          storedCount: currentRows.length,
        }),
        getStoredMessageCount: () => currentRows.length,
        readStoredMessageById: (messageId) => {
          const row = currentRows.find((candidate) => candidate.id === messageId);
          return row ? withOrdinal(row) : null;
        },
        readStoredOrdinalPage: (after, limit) =>
          currentRows
            .filter(
              (row) =>
                after === null ||
                row.timeCreated > after.timeCreated ||
                (row.timeCreated === after.timeCreated && row.id > after.id),
            )
            .slice(0, Math.max(1, Math.floor(limit)))
            .map((row) => ({
              id: row.id,
              timeCreated: row.timeCreated,
              contributesOrdinal: true,
              hasValidInfo: true,
            })),
      }),
    );
    providerRegistered = true;
  }

  return async (
    input: MagicContextTurnTransformInput,
  ): Promise<MagicContextTurnTransformResult> => {
    // e2e/R-2：turn 开始即绑定本轮实际执行模型——先于投影与任何 pass 决策，
    // 让 usage recorder 的百分比分母在这一轮的第一pass 之前就位（破除「pass 成功
    // 才绑窗口」的鸡生蛋死结）。失败路径（fail-open / LKG replay）也不例外地已绑：
    // 它们同样会产生 model_complete，读数一样要落得下。
    if (port.onTurnStart !== undefined) port.onTurnStart(input.model);
    // 数组浅快照：`borrowReadOnlyRuntimeEntries` 的契约要求跨 await 前做数组快照，
    // 且 transform 只允许就地改这份投影。
    const snapshot = snapshotRuntimeEntries(input.entries as readonly ZCodeRuntimeEntry[]);
    const sessionId = input.sessionId;
    const projected = projectRuntimeEntries(snapshot, { sessionId, createdAt: Date.now() });
    const originals = new Map<string, RuntimeMessageEntry>();
    projected.forEach((message, index) => {
      const id = message.info.id;
      const original = input.entries[index];
      if (typeof id === "string" && original) originals.set(id, original);
    });

    currentSnapshot = snapshot;
    currentRows = await resolveStoredRows(input.entries.length);
    ensureProviderRegistered(sessionId);

    try {
      await transform({}, { messages: projected });
      // FORK（S24-fix2）：见 settleInFlightHistorian 的注释——historian 必须跑完，
      // 否则「一进程 = 一轮」会让它在 publish 之前随进程一起消失（drain 预留泄漏、
      // compartment 不落库）。
      await settleInFlightHistorian(sessionId);
    } catch (error) {
      return handleTransformFailure(
        error,
        projected,
        originals,
        sessionId,
        port.getConfig(),
        options,
      );
    }

    const { entries, syntheticHeadPositions } = projectMagicContextEntries(projected, originals);
    const unchanged =
      entries.length === input.entries.length &&
      entries.every((entry, index) => entry === input.entries[index]);
    // historian 后台驱动：**只在 transform 成功时**触发。`fail_open` 那条路径
    // 意味着这一 pass 什么都没做（放行了未改写的请求），此时驱动 historian 是
    // 在替一次已经失败的折叠再调度一次——所以严格排除。
    if (port.onPassSucceeded !== undefined) port.onPassSucceeded(input.model);
    // FORK（MF-04）：调度器新起的那次 pass 也要有界 settle，理由同
    // `settleInFlightHistorian`——进程会退出。失败/拒绝由钩子自己吞掉：它本来就不该
    // 影响这一轮请求（上面那次 settle 也是同样的处置）。
    if (port.settleScheduledPass !== undefined) {
      // 失败/拒绝在这里被吞掉：settle 只是替这一轮多等一个窗口，它本身绝不该改变
      // 这一轮请求的成败（与上面 `settleInFlightHistorian` 同一处置）。
      await port.settleScheduledPass().catch(() => undefined);
    }
    return { entries, outcome: unchanged ? "unchanged" : "applied", syntheticHeadPositions };
  };
}

/**
 * B 组三档分级（上游 `plugin/messages-transform.ts` 的 TypeScript 车道）。
 * 只有第一档会把错误抛回 core；其余两档在这里就地消化成一次放行。
 */
function handleTransformFailure(
  error: unknown,
  projected: readonly MessageLike[],
  originals: ReadonlyMap<string, RuntimeMessageEntry>,
  sessionId: string,
  config: MagicContextConfig,
  options: Pick<MagicContextTurnTransformOptions, "logger">,
): MagicContextTurnTransformResult {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;

  // ① fail-closed：确定性不可用。blocking 配置默认 true = 重抛，让用户看到 loud 错误。
  if (error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error)) {
    if (config.fail_closed_blocking !== false) throw error;
    options.logger.warn("Magic context fail-closed is inert; passing the request through", {
      module: "bootstrap",
      event: "magic_context.fail_closed_inert",
      errorName: typeof name === "string" ? name : undefined,
    });
    return passthrough(projected, originals);
  }

  // ② LKG replay：先试上一次成功 pass 的字节。
  const replayed = tryReplayLkg(projected, sessionId, options);
  if (replayed) return replayed;

  // ③ 产不出可安全发送的请求 → 拒发，而不是把更大的裸历史交给 provider。
  if (
    error instanceof DegradedPassRefusalError ||
    error instanceof UnmanagedOverWindowError ||
    error instanceof UnresolvedHistoryBoundaryError
  ) {
    throw error;
  }

  // ④ transient sqlite：重试由包的 writer acquisition 负责，这里只做分类。
  if (isTransientSqliteError(error) && !(error instanceof StorageBusyRefusalError)) {
    throw new StorageBusyRefusalError(error, "zcode-turn-loop");
  }
  if (error instanceof StorageBusyRefusalError) throw error;

  // ⑤ 其余（schema 损坏、编程错误）：fail-open 放行输入，只记一条诊断。
  options.logger.warn("Magic context transform failed; serving the unmodified request", {
    module: "bootstrap",
    event: "magic_context.fail_open",
    errorName: typeof name === "string" ? name : undefined,
    errorCode: typeof code === "string" ? code : undefined,
  });
  return passthrough(projected, originals);
}

function passthrough(
  projected: readonly MessageLike[],
  originals: ReadonlyMap<string, RuntimeMessageEntry>,
): MagicContextTurnTransformResult {
  const { entries, syntheticHeadPositions } = projectMagicContextEntries(projected, originals);
  return { entries, outcome: "fail_open", syntheticHeadPositions };
}

function tryReplayLkg(
  projected: readonly MessageLike[],
  sessionId: string,
  options: Pick<MagicContextTurnTransformOptions, "logger">,
): MagicContextTurnTransformResult | undefined {
  try {
    const keys = resolveLkgModelKeys(projected as MessageLike[]);
    const entry = noteEntry(sessionId, projected as MessageLike[]);
    if (!entry) return undefined;
    const replay = replayLkg({
      sessionId,
      messages: projected as MessageLike[],
      modelKey: keys.modelKey,
      providerKey: keys.providerKey,
      entry,
    });
    if (!replay.ok) {
      options.logger.warn("Magic context LKG replay declined", {
        module: "bootstrap",
        event: "magic_context.lkg_replay_declined",
        reason: replay.reason,
      });
      return undefined;
    }
    // 重放出来的是模块输出（MessageLike），没有 ZCode entry 可复用，全部重建。
    const { entries, syntheticHeadPositions } = projectMagicContextEntries(
      replay.messages,
      new Map(),
    );
    return { entries, outcome: "lkg_replayed", syntheticHeadPositions };
  } catch (replayError) {
    options.logger.warn("Magic context LKG replay unavailable", {
      module: "bootstrap",
      event: "magic_context.lkg_replay_unavailable",
      detail: replayError instanceof Error ? replayError.message : String(replayError),
    });
    return undefined;
  }
}
