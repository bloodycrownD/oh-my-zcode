/**
 * Step 19b — turn-loop 的 magic-context 插入缝。
 *
 * ============================================================================
 * 这个文件**不 import `@zcode/magic-context` 的任何运行时值**，这是刻意的。
 * ============================================================================
 *
 * `features.magicContext === false`（用户显式关闭时的退路态，T-M8 语义）时要求"零行为"
 * ——装配层连 transform / provider 实例都不创建。如果 turn-loop 经由本模块的某个 helper
 * 直接 import 包里的 `projectRuntimeEntries`，那么 CLI 每次启动都会把整棵 magic-context
 * 模块图（含 zod schema 与 sqlite chokepoint）拉进内存，而它们一个都不会被用到。
 *
 * 所以分工是：
 *   - **core（本文件，零包依赖）**：声明端口类型、门控、调用、wire 调试日志。
 *   - **bootstrap（`magic-context-turn-transform.ts`）**：唯一 import 包的地方。
 *     它在 flag on 时惰性 `import()`，负责投影 → transform → 反投影，并按 B 组
 *     既有语义完成失败分级（fail-closed 重抛 / LKG replay / fail-open 放行）。
 *     仍然决定拒发的错误才会从端口抛出来。
 *
 * turn-loop 的插入点因此只有一行判空，见 `turn-loop.ts` 的
 * `const requestEntries = await runMagicContextTurnTransform(...)`。
 *
 * 本模块**没有任何运行时 import**（全部是 `import type`）。这不只是洁癖：它让这段
 * 门控 + 诊断代码可以被 node 直接加载（Step 19b 的单测就这样跑），而不必把整个
 * core 运行时图拉进来。`traceContextToLogContext` 因此由调用方算好传进来。
 */

import type { RuntimeAttachmentEntry, RuntimeMessageEntry } from "../../agent/message-history.js";
import type { LogContext, Logger, Model, SessionId } from "../deps.js";

// ─────────────────────────────────────────────────────────────────────────────
// 端口
// ─────────────────────────────────────────────────────────────────────────────

/** 端口一次调用的结果分类。`fail_open` 表示"失败但按 B 组语义放行了原始输入"。 */
export type MagicContextTurnOutcome =
  /** transform 成功且输出与输入不同。 */
  | "applied"
  /** transform 成功但输出与输入逐引用相同（无注入、无 drop）。 */
  | "unchanged"
  /** transform 失败，用上一次成功 pass 的字节重放。 */
  | "lkg_replayed"
  /** transform 失败且无可重放请求，按 fail-open 放行原始输入。 */
  | "fail_open";

/** wire 级验证用的单条投影摘要（T-M4）。不含任何消息正文。 */
export interface MagicContextWireEntryDebug {
  index: number;
  kind: "message" | "attachment";
  role?: string;
  /** attachment 的 `metadata.source`；普通消息为空。 */
  source?: string;
  /** 该条是否由 inject-compartments 标记为 m[0]/m[1]。 */
  syntheticHead: boolean;
  /** 入口是否已带 cacheControl；最终锚点由双投影统一设置，这里只记入口落点。 */
  entryCacheControl?: string;
}

export interface MagicContextWireDebugSnapshot {
  /** transform 后进入双投影的 entry 总数。 */
  total: number;
  /** m[0]/m[1] 计数。 */
  syntheticHeadCount: number;
  /** m[0]/m[1] 在输出数组中的下标（升序）。 */
  syntheticHeadPositions: number[];
  entries: MagicContextWireEntryDebug[];
}

export interface MagicContextTurnTransformInput {
  /** `providerEntries` 的浅快照；transform 只允许就地改这份数组的投影。 */
  entries: readonly RuntimeMessageEntry[];
  model: Model;
  sessionId: SessionId;
  workingDirectory: string;
}

export interface MagicContextTurnTransformResult {
  entries: RuntimeMessageEntry[];
  outcome: MagicContextTurnOutcome;
  /**
   * m[0]/m[1] 在 `entries` 中的下标（升序）。装配层知道自己在反投影里标了什么，
   * core 只用它来给 wire 调试日志定位——**不**由 core 反推，因为 core 这条路径
   * 刻意不 import magic-context 包（见文件头）。
   */
  syntheticHeadPositions?: readonly number[];
}

/**
 * 装配层提供的每请求 transform。缺席即"flag off"——装配层在 flag off 时根本不创建
 * 它，所以 turn-loop 的判空就是完整门控。
 */
export interface MagicContextTurnTransform {
  (input: MagicContextTurnTransformInput): Promise<MagicContextTurnTransformResult>;
  /**
   * FORK（MF-01）：**活值**开关谓词，每 turn 现读一次。
   *
   * 为什么不能只读 `runtime.config.magicContext?.enabled`：那份 config 是**装配期
   * 冻结**的副本，D-12 的「运行中改设置、无需重启」在它上面读不到 ConfigPort 的
   * 新值（spec Step 16 判据）。而 `magicContext.enabled` 是设置页的一个普通表单
   * 字段——不给活值通道，用户点下去就会得到「保存成功但行为不变」。
   *
   * 缺席（旧的/轻量的端口实现）= 不做二次门控，退回到 `runtime.config` 那一位，
   * 行为与本 fork 之前逐行相同。
   */
  isEnabled?(): boolean;
}

export interface MagicContextTurnTransformRuntime {
  readonly config: { magicContext?: { enabled?: boolean } };
  readonly magicContextTurnTransform?: MagicContextTurnTransform;
  readonly logger?: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// wire 调试（T-M4 的"手段"，实跑留 S24）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 打开后，turn-loop 的插入点会对 transform 后的 entries 打一条结构化日志：
 * 每条 entry 的 role / synthetic 标记 / attachment source / cacheControl 入口落点，
 * 外加 m[0]/m[1] 的存在性与下标、以及总数。
 *
 * 为什么是环境变量而不是配置项：这是诊断开关，不是产品开关，且 T-M4 的验证要在
 * 不重启、不改 config.json 的前提下反复开关。日志走 runtime 既有 logger
 * （禁 console 直写），因此和 `model.request.started` 落在同一条流上。
 */
export const MAGIC_CONTEXT_WIRE_DEBUG_ENV = "ZCODE_MAGIC_CONTEXT_DEBUG_WIRE";

export function isMagicContextWireDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MAGIC_CONTEXT_WIRE_DEBUG_ENV] === "1";
}

/**
 * 从 transform 后的 entries 直接算一份 wire 摘要。
 *
 * 端口可以自带一份更权威的 `syntheticHeadPositions`（它知道自己在反投影里标了什
 * 么），但这条 fallback 让日志在端口是桩实现时依然可用——T-M4 要看的是"投影层实际
 * 收到了什么"，而不是"装配层声称它放了什么"。
 */
export function buildMagicContextWireDebugSnapshot(
  entries: readonly RuntimeMessageEntry[],
  syntheticHeadPositions: readonly number[] = [],
): MagicContextWireDebugSnapshot {
  const headPositions = new Set(syntheticHeadPositions);
  const perEntry: MagicContextWireEntryDebug[] = entries.map((entry, index) => {
    // `entry.kind === "attachment"` 就是 message-history 的 `isRuntimeAttachmentEntry`
    // 在 ZCode 联合上的全部判据（该变体的 `kind` 是必填字面量）。这里刻意不 import
    // 它：本模块要保持零运行时 import（见文件头），而这一行不可能与上游判据漂移。
    if (entry.kind === "attachment") {
      const attachment: RuntimeAttachmentEntry = entry;
      return {
        index,
        kind: "attachment",
        role: "user",
        source: attachment.metadata.source,
        syntheticHead: headPositions.has(index),
        ...(attachment.cacheControl
          ? { entryCacheControl: JSON.stringify(attachment.cacheControl) }
          : {}),
      };
    }
    return {
      index,
      kind: "message",
      role: entry.message.role,
      source: entry.metadata?.source,
      syntheticHead: headPositions.has(index),
      ...(entry.message.cacheControl
        ? { entryCacheControl: JSON.stringify(entry.message.cacheControl) }
        : {}),
    };
  });
  return {
    total: entries.length,
    syntheticHeadCount: headPositions.size,
    syntheticHeadPositions: [...headPositions].sort((left, right) => left - right),
    entries: perEntry,
  };
}

function logMagicContextWireSnapshot(
  runtime: MagicContextTurnTransformRuntime,
  logContext: LogContext | undefined,
  result: MagicContextTurnTransformResult,
): void {
  const snapshot = buildMagicContextWireDebugSnapshot(
    result.entries,
    result.syntheticHeadPositions ?? [],
  );
  runtime.logger?.info("Magic context wire projection", {
    ...(logContext ?? {}),
    module: "core.runtime",
    event: "magic_context.wire",
    // 不复用 `status`：Logger 的 status 是事件生命周期词汇，而这里是本 pass 的
    // 分级结果（applied / unchanged / lkg_replayed / fail_open）。
    magicContextOutcome: result.outcome,
    total: snapshot.total,
    syntheticHeadCount: snapshot.syntheticHeadCount,
    syntheticHeadPositions: snapshot.syntheticHeadPositions,
    entries: snapshot.entries,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 调用
// ─────────────────────────────────────────────────────────────────────────────

/**
 * turn-loop 的插入点。返回**新的** `RuntimeMessageEntry[]`；flag off 或端口缺席时
 * 返回的就是入参那份数组本身（逐引用相等），双投影拿到的仍是 Phase 1 的行为。
 *
 * `logContext` 是调用方已经算好的 `traceContextToLogContext(...)` 结果——本模块不
 * import core 的 deps 门面（见文件头）。
 */
export async function runMagicContextTurnTransform(
  runtime: MagicContextTurnTransformRuntime,
  input: MagicContextTurnTransformInput,
  logContext?: LogContext,
): Promise<readonly RuntimeMessageEntry[]> {
  // 门控：端口缺席（装配层没建实例）已经覆盖了 flag off；配置再显式关一次是防御
  // ——Step 23 接 ConfigPort 热更新后，运行中改配置必须立刻生效而不必重启装配。
  //
  // FORK（MF-01）：两个门是**同源**的两半——`runtime.config` 那一位是装配期的冷求值
  // （`features && magicContext.enabled`），端口的 `isEnabled()` 是同一字段的活值
  // 版本。后者在场时以它为准，于是设置页把 `enabled` 关掉后，下一个 turn 不再插桩。
  if (!runtime.magicContextTurnTransform) return input.entries;
  if (runtime.magicContextTurnTransform.isEnabled?.() === false) return input.entries;
  if (runtime.config.magicContext?.enabled === false) return input.entries;

  const result = await runtime.magicContextTurnTransform(input);
  if (isMagicContextWireDebugEnabled()) {
    logMagicContextWireSnapshot(runtime, logContext, result);
  }
  return result.entries;
}
