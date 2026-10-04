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
  findConfigReadinessError,
  getActiveCompartmentRun,
  getMagicContextDatabasePath,
  getSchemaFenceRejection,
  initializeMagicContextHost,
  isFailClosedBlockingError,
  isTransientSqliteError,
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
import { readMagicContextUsageSummary } from "./magic-context-usage-summary.js";

/** 包内 `createTransform` 的返回值形状（单测用桩实现替换它）。 */
export type ZCodeMagicContextTransform = (
  input: Record<string, never>,
  output: { messages: unknown[] },
) => Promise<void>;

export interface MagicContextTurnTransformOptions {
  /** `RuntimeConfig.features.magicContext`。false → 工厂直接返回 undefined。 */
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
      const window = model.properties?.contextWindow;
      if (typeof window === "number" && window > 0) contextWindow = window;
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

export async function createMagicContextTurnTransform(
  options: MagicContextTurnTransformOptions,
): Promise<MagicContextTurnTransform | undefined> {
  // T-M8（Step 19a/23）：门控是**装配层**的判断，且必须是第一句——关着时既不建
  // bridge、也不 import magic-context 模块图、更不开 DB。这一行之下的一切都与
  // Phase 1 基线无关，所以关着时行为逐行等价。
  if (!options.enabled) return undefined;

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

  const db = openDatabase(getMagicContextDatabasePath());
  if (!db) {
    const fence = getSchemaFenceRejection();
    const detail = fence
      ? `magic-context.db schema fence rejected: database v${fence.persistedVersion} is newer than this build supports (v${fence.supportedVersion})`
      : "magic-context.db could not be opened";
    if (config.fail_closed_blocking !== false) {
      throw new Error(`[magic_context] ${detail} (fail_closed_blocking=true)`);
    }
    options.logger.warn("Magic context storage unavailable; transform stays inert", {
      module: "bootstrap",
      event: "magic_context.storage_unavailable",
      detail,
    });
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
    void readMagicContextUsageSummary(db, options.sessionId)
      .then((summary) => sink(summary.usage))
      .catch(() => {
        // 读不出来就推 null：投影层据此删掉该键，面板整段收起。诊断面不抛。
      });
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
  const notifyPassSucceeded = (model: MagicContextTurnTransformInput["model"]): void => {
    // 主模型窗口有两个消费者，都只有 turn 知道：后台 protected-tail 边界的输入，
    // 以及 usage recorder 的百分比分母（缺了分母，占比就永远算不出来）。
    historian.noteLiveModel(model);
    options.usageRecorder?.noteLiveModel(model);
    // fire-and-forget：本行绝不 await。调度器自己合并同会话的连续触发、自己 drain、
    // 自己 abort——让 UI 等一个可能跑几十秒的 historian 是错的。
    historian.historianScheduler?.notifyTurnSuccess({ sessionId: options.sessionId });
    // D-13 ①：这一 pass 刚改过 compartments / dropped / 缓存块。
    publishUsageSummary();
  };
  return createZCodeMagicContextTurnTransformPort(transform, {
    getConfig: () => bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG,
    options,
    // 两个消费者都不在时**不挂**回调：Step 19b 的单测走的就是这条路径，它必须与
    // S19b 逐行相同。
    ...(historian.historianScheduler === undefined && options.usageRecorder === undefined
      ? {}
      : { onPassSucceeded: notifyPassSucceeded }),
  });
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
     * FORK（S24 / D-6）：每 pass 成功后的 historian 后台驱动。**刻意不在 core 的
     * turn-loop 上挂点**——那要求改 turn-loop 语义（本 fork 的纪律禁区）。本端口
     * 是装配层自己的回调：一次 transform 成功就意味着这一轮请求已被接受，此时让
     * historian 去折叠后台历史正是它该做的。
     *
     * 缺席（Step 19b 的单测走的就是这条）时端口行为与 S19b 逐行相同。
     */
    onPassSucceeded?: (model: MagicContextTurnTransformInput["model"]) => void;
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
