/**
 * magic-context 用量面（自 `../magic-context-turn-transform.ts` 逐字搬出，纯搬迁、
 * 零语义改动）：预算摘要推送（D-13）、provider usage 记录器（S24）、窗口三源兜底
 * （e2e/R-2）。
 *
 * 本文件不 import 同目录其它模块，也没有模块级副作用——`positiveWindow` /
 * `resolveConservativeContextWindow` 保持私有（与拆分前一致，不扩大对外面）。
 */

import type { Logger } from "@zcode/core";
import { getModelUsageContextTokens, type ModelUsage } from "@zcode/contracts";
import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";
import {
  loadPersistedUsage,
  resolveModelKey,
  updateSessionMeta,
  type ContextDatabase,
} from "@zcode/magic-context";

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
