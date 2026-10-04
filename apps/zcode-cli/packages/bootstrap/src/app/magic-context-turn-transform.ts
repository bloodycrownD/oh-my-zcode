/**
 * Step 19b — bootstrap 侧的 magic-context 装配。
 *
 * ============================================================================
 * 这里是全仓唯一 import `@zcode/magic-context` 运行时值的地方，而且只在
 * `features.magicContext` 打开时才 import（`createZCodeApp` 用动态 import 调本文件
 * 的工厂）。原因见 `core/src/runtime/helpers/magic-context-turn-transform.ts` 的
 * 文件头：flag off 时（D-11 的默认态）CLI 启动不应该把整棵 magic-context 模块图
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
 *   scheduler                       createZCodeScheduler()：见该函数注释（缺口 S21）
 *   contextUsageMap                 空 Map —— 无生产者（缺口 S20/S24）
 *   clearReasoningAge               50（源 hook.ts 的 `?? 50`；clear_reasoning_age
 *                                   不在 E 组白名单）
 *   historyRefreshSessions /        装配层持有的 Set / Map（生产者 S20）
 *   pendingMaterializationSessions
 *   lastHeuristicsTurnId /
 *   commitSeenLastPass
 *   hiddenCompletionExecutor        `undefined` 占位 —— C 组，S20 接
 *   historianRunnable               `false` —— 无 executor 时诚实关闭
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
 *                                   config bridge 快照（真实 ConfigPort.observe
 *                                   接线是 Step 23）
 *   liveModelBySession / getModelKey / getNotificationParams / getToolSetHash
 *                                   每 pass 用 turn-loop 传入的 model 刷新
 *
 * ── 已知缺口 ────────────────────────────────────────────────────────────────
 *   - historian executor：`undefined` + `historianRunnable:false`；S20 在本文件补。
 *   - 模型窗口几何（`models-dev-cache` / `window-geometry`）：包内模块级单例且没有
 *     注入缝，包外改不了（改包内是 S20 的特权）。S19b 让 transform 走自己的默认/检测
 *     回退，窗口偏小只会让阈值更保守，不会误发超大请求。
 *   - `contextUsageMap` 无生产者。
 *   - 配置源是静态快照（Step 23 接 `ConfigPort.observe`）。
 */

import type {
  Logger,
  MagicContextTurnTransform,
  MagicContextTurnTransformInput,
  MagicContextTurnTransformResult,
  RuntimeAttachmentEntry,
  RuntimeMessageEntry,
} from "@zcode/core";
import type {
  ModelMessageContent,
  ModelMessageContentBlock,
  SessionStorePort,
} from "@zcode/contracts";
import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  DegradedPassRefusalError,
  EmergencyFailClosedError,
  StorageBusyRefusalError,
  UnmanagedOverWindowError,
  UnresolvedHistoryBoundaryError,
  createConfigBridge,
  createRawMessageProvider,
  createTagger,
  createTransform,
  findConfigReadinessError,
  getMagicContextDatabasePath,
  getSchemaFenceRejection,
  initializeMagicContextHost,
  isFailClosedBlockingError,
  isTransientSqliteError,
  noteEntry,
  openDatabase,
  projectRuntimeEntries,
  projectStoredMessage,
  replayLkg,
  resolveExecuteThresholdDetail,
  resolveLkgModelKeys,
  snapshotRuntimeEntries,
  withRawMessageProvider,
  type ContextDatabase,
  type MagicContextConfig,
  type MessageLike,
  type RawMessage,
  type Scheduler,
  type TransformDeps,
  type ZCodeRuntimeEntry,
} from "@zcode/magic-context";

/** 包内 `createTransform` 的返回值形状（单测用桩实现替换它）。 */
export type ZCodeMagicContextTransform = (
  input: Record<string, never>,
  output: { messages: unknown[] },
) => Promise<void>;

export interface MagicContextTurnTransformOptions {
  /** `RuntimeConfig.features.magicContext`。false → 工厂直接返回 undefined。 */
  enabled: boolean;
  /** `RuntimeConfig.magicContext` 参数域（Step 23 之前恒为 undefined）。 */
  configDomain?: unknown;
  sessionId: string;
  workingDirectory: string;
  /** 读历史的第二数据源；缺席时 raw-message provider 只服务内存历史。 */
  sessionStore?: SessionStorePort;
  logger: Logger;
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
 * 上游 `createScheduler` 随 OpenCode 的 event-resolution 层一起不搬（`deferred/
 * scheduler.ts` 只留下接口与 `parseCacheTtl`）。这里按同一判据实现最小版本：用
 * `resolveExecuteThresholdDetail` 解析本模型的 execute threshold（tokens 模式优先
 * 于 percentage，与 B 组 resolver 一致），再与当前 contextUsage 比较。
 *
 * Step 21 的 `features/magic-context/scheduler.ts` 落地后应整段删除并改指它。
 */
function createZCodeScheduler(config: MagicContextConfig): Scheduler {
  return {
    shouldExecute(sessionMeta, contextUsage, _currentTime, sessionId, modelKey, contextLimit) {
      void sessionMeta;
      const detail = resolveExecuteThresholdDetail(
        config.execute_threshold_percentage,
        modelKey,
        65,
        {
          tokensConfig: config.execute_threshold_tokens,
          ...(contextLimit === undefined ? {} : { contextLimit }),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
      );
      if (detail.mode === "tokens" && detail.absoluteTokens !== undefined) {
        return contextUsage.inputTokens >= detail.absoluteTokens ? "execute" : "defer";
      }
      return contextUsage.percentage >= detail.percentage ? "execute" : "defer";
    },
  };
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
  if (!options.enabled) return undefined;

  // S15 遗留 #6：`initializeMagicContextHost()` 必须在任何 DB 写之前。装配层把本
  // 工厂放在 flag 判定之后，是因为 flag off 时整条链路（含本文件的动态 import）
  // 都不该发生——那时不存在任何 magic-context DB 写，契约因此自动成立。
  initializeMagicContextHost();

  const bridge = createConfigBridge({
    // 静态源（S16 语义在 Step 23 前的形态）：读一次 RuntimeConfig 侧的配置快照。
    read: () => options.configDomain ?? {},
    subscribe: () => () => {},
  });
  const config = bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG;

  const readiness = findConfigReadinessError(config);
  if (readiness) {
    // historian 属 S20；S19b 只记诊断，不因此拒绝装配——否则默认配置（无
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

  const transform = createTransform(buildTransformDeps(config, db, options));
  return createZCodeMagicContextTurnTransformPort(transform, config, options);
}

function buildTransformDeps(
  config: MagicContextConfig,
  db: ContextDatabase,
  options: MagicContextTurnTransformOptions,
): TransformDeps {
  const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
  const liveModels = liveModelBySession;
  return {
    db,
    tagger: createTagger(),
    scheduler: createZCodeScheduler(config),
    contextUsageMap: new Map(),
    clearReasoningAge: 50,
    historyRefreshSessions: new Set<string>(),
    pendingMaterializationSessions: new Set<string>(),
    lastHeuristicsTurnId: new Map<string, string>(),
    commitSeenLastPass: new Map<string, boolean>(),
    // C 组缝（S20）：没有 executor 就诚实地关掉 historian 侧的 child agent，
    // 而不是传一个必然 throw 的占位——后者会把「没接」变成「每 pass 报错」。
    hiddenCompletionExecutor: undefined,
    historianRunnable: false,
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
 * 端口工厂。导出是因为 Step 19b 的单测要能用一个**桩 transform**驱动整条
 * 投影 → transform → 反投影链路（真实 `createTransform` 需要 magic-context.db 与
 * historian，属 S20/S24 的实跑范围）。
 */
export function createZCodeMagicContextTurnTransformPort(
  transform: ZCodeMagicContextTransform,
  config: MagicContextConfig,
  options: Pick<MagicContextTurnTransformOptions, "sessionId" | "sessionStore" | "logger">,
): MagicContextTurnTransform {
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

    const storedRows = await resolveStoredRows(input.entries.length);
    const provider = createRawMessageProvider({
      sessionId,
      borrowRuntimeEntries: () => snapshot,
      readStoredMessagePage: ({ afterOrdinal, limit, finalWatermark }) => ({
        messages: pageFromRows(storedRows, afterOrdinal, limit, finalWatermark),
        storedCount: storedRows.length,
      }),
      getStoredMessageCount: () => storedRows.length,
      readStoredMessageById: (messageId) => {
        const row = storedRows.find((candidate) => candidate.id === messageId);
        return row ? withOrdinal(row) : null;
      },
      readStoredOrdinalPage: (after, limit) =>
        storedRows
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
    });

    try {
      await withRawMessageProvider(sessionId, provider, async () => {
        await transform({}, { messages: projected });
      });
    } catch (error) {
      return handleTransformFailure(error, projected, originals, sessionId, config, options);
    }

    const { entries, syntheticHeadPositions } = projectMagicContextEntries(projected, originals);
    const unchanged =
      entries.length === input.entries.length &&
      entries.every((entry, index) => entry === input.entries[index]);
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
