/**
 * Step 24 — magic-context historian 的**宿主接线面**（D-6 sidecar）。
 *
 * ============================================================================
 * 这里只做三件事，一件都不含 magic-context 的判定逻辑
 * ============================================================================
 *
 *   1. **sidecarModelCall**：把包侧的 {@link SidecarModelRequest} 映射到 core 的
 *      `runSidecarModelRequest`（旁路原语），并把结果映射回
 *      {@link SidecarModelCallResult}。
 *   2. **executor 装配**：`createHiddenCompletionExecutor({ sidecarModelCall })`。
 *      没有 historian 模型时**不装**，`historianRunnable` 保持 false —— 与 S16 的
 *      「缺省报错文案」一致：报错归报错，装配不炸。
 *   3. **historian 后台调度器 + `/ctx-recomp` runner**：两者调用的是同一个
 *      「跑一次 compartment pass」的动作（`startCompartmentAgent`），所以它们
 *      共用下面 {@link runOneCompartmentPass}。
 *
 * ── 为什么 sidecar 走 core 的原语，而不是直接 `model.generateText` ──────────────
 *
 * `SidecarModelCallOptions.preserveProviderStreamBoundaries` 是**必填字面量
 * `true`**（见包内 `host/hidden-completion-executor.ts` 的文件头）。它是
 * `commitNormalizedContentBlock` 判定「provider 真的提交了这个 content block」的
 * 唯一依据；flag 缺席时那条判定会静默退化成「SDK 归一化的块结束位置 suggests 它
 * 提交了」，一个已经提交的工具调用会被当成没提交而重发——**不抛错、不失败、只是
 * 判错**。core 的 `runSidecarModelRequest` 是全仓唯一消费
 * `compact_stream_boundary` 事件的地方，所以旁路原语必须经它，不能绕开。
 *
 * ── historian 模型从哪来 ──────────────────────────────────────────────────────
 *
 * `magicContext.historian.model`，形如 `"provider/model"`（E 组 schema 的字段说明
 * 就是这么写的）。宿主侧由 `create-app.ts` 提供一个 `createSidecarModel(modelId)`
 * 闭包：它走 provider Registry + `modelFactory`，因此**「这个模型此刻能不能造出来」
 * 只有一个答案**——与主会话选模型走同一条校验（`validateSelection`），而不是这里
 * 再抄一份解析。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import {
  createChildTraceContext,
  createRootTraceContext,
  type Logger,
  type Model,
  type ModelInputMessage,
  type TraceContext,
} from "@zcode/contracts";
import { runSidecarModelRequest } from "@zcode/core";
import {
  createHiddenCompletionExecutor,
  createHistorianScheduler,
  DEFAULT_HISTORIAN_TIMEOUT_MS,
  deriveHistorianChunkTokens,
  getActiveCompartmentRun,
  getCompartments,
  hasRunnableCompartmentWindow,
  resolveOpenCodeProtectedTailBoundary,
  setMagicContextRecompRunner,
  startCompartmentAgent,
  type ContextDatabase,
  type ContextUsage,
  type HiddenCompletionExecutor,
  type HiddenCompartmentRunnerDeps,
  type HistorianRunStatus,
  type HistorianScheduler,
  type MagicContextConfig,
  type SidecarModelCall,
  type SidecarModelCallResult,
} from "@zcode/magic-context";

/** 宿主按 `"provider/model"` 造一个 Model；返回 undefined 表示此刻造不出来。 */
export type CreateSidecarModel = (modelId: string) => Model | undefined;

/** executor 与调度器的构造输入（`db` 由装配层持有，见 transform 装配文件）。 */
export interface MagicContextHistorianHostDeps {
  logger: Logger;
  /** 装配层持有的同一个 db handle（transform 与 historian 必须共用一个连接）。 */
  db: ContextDatabase;
  sessionId: string;
  workingDirectory: string;
  /** `"provider/model"` → Model。缺席（单测/不装配模型面的 embedder）时 executor 不装。 */
  createSidecarModel?: CreateSidecarModel;
  /**
   * S24-fix：本进程已知的真实占用读数（`{percentage, inputTokens}`），供后台 pass
   * 解 protected-tail 边界。返回 `null` = 「还没量到」，不是「很空」——两个值让
   * 边界解出的可跑头部宽度不同，混为一谈会切进本该保护的尾巴。
   *
   * S24 之前这里恒为 `null`（`usage:null` provisional-zero），因为 `contextUsageMap`
   * 没有生产者。S24 补上 recorder 之后可以给真读数了。
   */
  readLiveUsage?: () => ContextUsage | null;
  /** 会话的根 trace；sidecar 请求在它下面开子 span，于是日志能串回同一轮。 */
  traceContext?: TraceContext;
}

/** 装配产物：注入 TransformDeps 的 historian 字段 + 后台调度器。 */
export interface MagicContextHistorianHost {
  hiddenCompletionExecutor?: HiddenCompletionExecutor;
  historianRunnable: boolean;
  /** `magicContext.historian.model`（`"provider/model"`），未配置时 undefined。 */
  historianModel?: string;
  fallbackModels: readonly string[];
  historianTwoPass: boolean;
  historianMaxOutputTokens?: number;
  historianTimeoutMs: number;
  /** historian 自身的窗口决定 chunk 预算；historian 模型未知时用保守回退。 */
  getHistorianChunkTokens: () => number;
  /** turn 成功后 fire-and-forget 触发一次后台 pass。缺席 = historian 没装。 */
  historianScheduler?: HistorianScheduler;
  /**
   * 每 pass 用本轮真实模型刷新主模型窗口。后台 pass 的 protected-tail 边界按
   * **主模型**的窗口解，所以这条事实必须来自 turn，而不是装配期猜一个。
   */
  noteLiveModel: (model: Pick<Model, "properties">) => void;
  /** 关闭时终止在飞的 historian（会话关闭 / App 退出）。 */
  shutdown: () => void;
}

/** historian 模型窗口未知时的保守假设，与包内 `DEFAULT_HISTORIAN_CONTEXT_FALLBACK` 同值。 */
const UNKNOWN_HISTORIAN_CONTEXT_LIMIT = 128_000;

/**
 * FORK（S24-fix2）：historian 请求的输出上限。
 *
 * `magicContext.historian.maxTokens` 是用户的旋钮；没配时本 fork 必须自己给一个
 * 缺省值，原因是**两端的模型契约不同**：上游 OpenCode 的模型层会替调用方补一个
 * 默认输出上限，而 ZCode 的 `Model` 契约把 `maxOutputTokens` 列为**每次请求的必填项**
 * （`adapters/src/model/model.ts` 的 `validateOptions`，缺省与越界共用同一条文案）。
 * 于是「用户没配 maxTokens」在 fork 里等于「每一次旁路请求都在建请求阶段被拒」——
 * live 证据：`historian failure: … (invalid_model_request): maxOutputTokens is
 * outside the model option range`，historian 一个 compartment 都产不出来。
 *
 * 缺省值按模型自己声明的上限夹紧（`optionSpecs.maxOutputTokens.max`），因此小输出
 * 模型永远不会被要求超过它接受的值；用户显式配的值同样走这条夹紧。
 */
const DEFAULT_HISTORIAN_MAX_OUTPUT_TOKENS = 8_192;

function resolveHistorianMaxOutputTokens(
  config: MagicContextConfig,
  model: Model,
): number | undefined {
  const ceiling = model.optionSpecs?.maxOutputTokens?.max;
  const max = typeof ceiling === "number" && ceiling > 0 ? Math.floor(ceiling) : undefined;
  const configured = config.historian.maxTokens;
  const wanted =
    typeof configured === "number" && configured > 0
      ? Math.floor(configured)
      : Math.min(DEFAULT_HISTORIAN_MAX_OUTPUT_TOKENS, max ?? Number.POSITIVE_INFINITY);
  if (max !== undefined && wanted > max) return max;
  return wanted > 0 ? wanted : undefined;
}

/**
 * 主模型窗口未知时的回退。取 200k：绝大多数现代模型在 128k–1M 之间，选一个偏小
 * 的值会让 protected tail 变窄——**那才是危险的方向**（切进本该保护的尾巴），
 * 而偏大只会让可跑头部更窄、多跳一次 pass。
 */
const UNKNOWN_MAIN_CONTEXT_LIMIT = 200_000;

/**
 * 把包侧的 sidecar 请求映射到 core 的旁路原语。
 *
 * 消息形状是**两段**：system（historian agent 的系统提示）与 user（runner 拼好的
 * `<new_messages>` + 有界块）。这与上游「子会话 + prompt」的形状等价，而 D-6 明确
 * 不允许真的开子会话。
 */
export function createZCodeSidecarModelCall(deps: {
  logger: Logger;
  createSidecarModel: CreateSidecarModel;
  traceContext?: TraceContext;
}): SidecarModelCall {
  const rootTrace =
    deps.traceContext ?? createRootTraceContext({ attributes: { feature: "magic_context" } });

  return async (request, options): Promise<SidecarModelCallResult> => {
    // run.model 是 ModelInput（`"provider/model"` 或 `{model, qualifier}`）。
    const modelKey = readModelKey(request.run.model);
    const model = modelKey === undefined ? undefined : deps.createSidecarModel(modelKey);
    if (!model) {
      // 分类器把 `model_config_missing` 认成「这个配置永远不可能 work」，于是
      // 终态 refusal 而不是一个会被重试的传输失败——与 `classifySidecarFailure`
      // 的 SETUP_ERROR_CODES 是同一组码。
      const error = new Error(
        `historian sidecar model is unavailable (run=${request.run.kind}, model=${modelKey ?? "<none>"})`,
      );
      (error as { code?: string }).code = "model_config_missing";
      throw error;
    }

    const messages: ModelInputMessage[] = [
      { role: "system", content: request.run.system },
      { role: "user", content: request.prompt },
    ];
    const traceContext = createChildTraceContext(rootTrace, {
      attributes: { feature: "magic_context", kind: request.run.kind },
    });

    let raw: Awaited<ReturnType<typeof runSidecarModelRequest>>;
    try {
      raw = await runSidecarModelRequest({
        logger: deps.logger,
        model,
        request: {
          abortSignal: request.abortSignal,
          messages,
          // 硬约束的转手点：包内 executor 传进来的字面量 `true` 原样递给原语，
          // 于是 `compact_stream_boundary` 事件照常发出。中间任何一层都不能"优化"掉它。
          preserveProviderStreamBoundaries: options.preserveProviderStreamBoundaries,
          traceContext,
          metadata: {
            module: "bootstrap",
            event: "magic_context.historian_sidecar",
            agent: request.run.agent,
          },
          ...(request.run.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.run.maxOutputTokens }),
        },
      });
    } catch (error) {
      // FORK (S24-fix2)：包内 executor 把 setup 类失败**分类**成
      // `HiddenCompletionRefusal{code}`，原始 `error.message` 就此丢失——
      // 而「为什么这次旁路请求在建请求阶段就被拒」恰恰是排障时唯一需要的那句话
      // （S24-fix 的 T-M6 取证就是卡在这条信息缺失上）。这里只补一条诊断日志并原样
      // 重抛：不改分类、不改重试语义、不吞异常。
      deps.logger.warn(
        "Magic context historian sidecar request failed before/while reaching the provider",
        {
          module: "bootstrap",
          event: "magic_context.historian_sidecar_failed",
          model: modelKey,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode:
            error !== null && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code)
              : undefined,
          detail: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }

    const finishReason = raw.finishReason ?? "";
    const result: SidecarModelCallResult = {
      text: raw.text,
      usage: raw.usage,
      finishReason,
      // 输出被 cap 截断且一个字都没吐时，historian 必须把它当成一个**不同的失败**
      // （`historianReasoningBudgetDiagnostic`）而不是「空输出」去升级重试。
      lengthCapped: /length|token.?limit|max.?output/i.test(finishReason) && raw.text.length === 0,
      providerId: model.providerId,
      modelId: model.modelId,
    };
    return result;
  };
}

/** `HiddenRunIdentity["model"]` 是 `ModelInput`，这里只取身份那一段。 */
function readModelKey(model: unknown): string | undefined {
  if (typeof model === "string") return model.length > 0 ? model : undefined;
  if (model !== null && typeof model === "object") {
    const candidate = (model as { model?: unknown }).model;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * 装 historian 的宿主接线面。
 *
 * `historianRunnable` 的判据只有一条：**historian 模型配了、且此刻造得出来**。
 * 两者任一不成立就不装 executor，`historianRunnable` 保持 false ——
 * transform 侧于是走「诚实关闭」那条分支（清 `compartmentInProgress`、
 * 不 startCompartmentAgent），而不是每 pass 抛一个「没接线」。
 */
export function createMagicContextHistorianHost(
  config: MagicContextConfig,
  deps: MagicContextHistorianHostDeps,
): MagicContextHistorianHost {
  const historianModel = config.historian.model;
  const fallbackModels = [...config.historian.fallback_models];
  const historianTwoPass = config.historian.two_pass;
  const historianTimeoutMs = DEFAULT_HISTORIAN_TIMEOUT_MS;
  const executeThresholdPercentage = readExecuteThreshold(config);

  // 主模型窗口：每 pass 由 `noteLiveModel` 刷新。装配期没有 turn，也就还没有事实。
  let mainContextLimit = UNKNOWN_MAIN_CONTEXT_LIMIT;
  // historian 自身的窗口决定 chunk 预算，装配期从造出来的 Model 上读一次。
  let historianContextLimit = UNKNOWN_HISTORIAN_CONTEXT_LIMIT;

  let hiddenCompletionExecutor: HiddenCompletionExecutor | undefined;
  let historianMaxOutputTokens: number | undefined = config.historian.maxTokens;
  if (historianModel !== undefined && deps.createSidecarModel !== undefined) {
    const model = deps.createSidecarModel(historianModel);
    if (model) {
      historianContextLimit = model.properties.contextWindow;
      historianMaxOutputTokens = resolveHistorianMaxOutputTokens(config, model);
      hiddenCompletionExecutor = createHiddenCompletionExecutor({
        sidecarModelCall: createZCodeSidecarModelCall({
          logger: deps.logger,
          createSidecarModel: deps.createSidecarModel,
          ...(deps.traceContext === undefined ? {} : { traceContext: deps.traceContext }),
        }),
      });
    } else {
      deps.logger.warn("Magic context historian model cannot be constructed; historian stays off", {
        module: "bootstrap",
        event: "magic_context.historian_model_unavailable",
        model: historianModel,
      });
    }
  }

  const getHistorianChunkTokens = (): number => deriveHistorianChunkTokens(historianContextLimit);

  const runPass = (sessionId: string, forceDrainQuota: boolean): Promise<HistorianRunStatus> => {
    if (!hiddenCompletionExecutor) return Promise.resolve("no-op");
    return runOneCompartmentPass({
      db: deps.db,
      executor: hiddenCompletionExecutor,
      sessionId,
      directory: deps.workingDirectory,
      historianModel,
      fallbackModels,
      historianTwoPass,
      historianMaxOutputTokens,
      historianTimeoutMs,
      historianChunkTokens: getHistorianChunkTokens(),
      executeThresholdPercentage,
      mainContextLimit,
      liveUsage: deps.readLiveUsage?.() ?? null,
      forceDrainQuota,
    });
  };

  const historianScheduler =
    hiddenCompletionExecutor === undefined
      ? undefined
      : createHistorianScheduler({
          runSession: async (sessionId) => runPass(sessionId, false),
          onError: (sessionId, error) =>
            deps.logger.warn("Magic context historian pass failed", {
              module: "bootstrap",
              event: "magic_context.historian_failed",
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            }),
        });

  // `/ctx-recomp`：跑一次真实的 compartment pass，并把**新建条数**如实回报。
  // 上游那条同步全量重建走 recomp-orchestrator（SPEC「明确不搬」），首版是薄封装。
  setMagicContextRecompRunner(async ({ db, sessionId }) => {
    if (!hiddenCompletionExecutor) return 0;
    const before = countCompartments(db, sessionId);
    // 用户显式点了「重算」，于是绕开 pressure-window 的配额门；上游 `/ctx-recomp`
    // 走的是同一条 `forceDrainQuota`。
    await runPass(sessionId, true);
    return Math.max(0, countCompartments(db, sessionId) - before);
  });

  return {
    ...(hiddenCompletionExecutor === undefined ? {} : { hiddenCompletionExecutor }),
    historianRunnable: hiddenCompletionExecutor !== undefined,
    ...(historianModel === undefined ? {} : { historianModel }),
    fallbackModels,
    historianTwoPass,
    ...(historianMaxOutputTokens === undefined ? {} : { historianMaxOutputTokens }),
    historianTimeoutMs,
    getHistorianChunkTokens,
    ...(historianScheduler === undefined ? {} : { historianScheduler }),
    noteLiveModel: (model) => {
      const window = model.properties?.contextWindow;
      if (typeof window === "number" && window > 0) mainContextLimit = window;
    },
    shutdown: () => historianScheduler?.shutdown(),
  };
}

function readExecuteThreshold(config: MagicContextConfig): number {
  const threshold = config.execute_threshold_percentage;
  return typeof threshold === "number" ? threshold : threshold.default;
}

function countCompartments(db: ContextDatabase, sessionId: string): number {
  try {
    return getCompartments(db, sessionId).length;
  } catch {
    return 0;
  }
}

/**
 * 跑**一次** compartment pass：解边界 → 启 agent → 等它落地。
 *
 * 与 transform 内部那条触发路径共用 `startCompartmentAgent`（因此共用同一把
 * compartment lease 与同一个 `activeRuns` 表），差别只有两点：
 *   - 边界在这里现解（`mode:"incremental-runner"`），因为后台 pass 不属于某一 pass；
 *   - 它**等**结果，而 transform 那条是 fire-and-forget。
 *
 * 边界解不出可运行的 head 时诚实回 `"no-op"`，不假装重建过。
 */
async function runOneCompartmentPass(input: {
  db: ContextDatabase;
  executor: HiddenCompletionExecutor;
  sessionId: string;
  directory: string;
  historianModel: string | undefined;
  fallbackModels: readonly string[];
  historianTwoPass: boolean;
  historianMaxOutputTokens: number | undefined;
  historianTimeoutMs: number;
  historianChunkTokens: number;
  executeThresholdPercentage: number;
  mainContextLimit: number;
  liveUsage: ContextUsage | null;
  forceDrainQuota: boolean;
}): Promise<HistorianRunStatus> {
  if (getActiveCompartmentRun(input.sessionId)) return "no-op";

  // 边界用**本进程已知的真实读数**（S24-fix）。S24 之前这里恒传 `usage:null`
  // （provisional-zero），因为 `contextUsageMap` 那时没有生产者；现在 recorder 记下的
  // 就是上一轮/本轮 provider 真报的占用，于是 protected tail 按真实压力圈定。
  // 仍然读不到时保持 `null`（偏保守：压力按 0 算 → 保护尾部更宽 → 可跑头部更窄，
  // 宁可少跑一次也不会切掉本该保护的尾巴）。
  const boundarySnapshot = resolveOpenCodeProtectedTailBoundary({
    db: input.db,
    sessionId: input.sessionId,
    mode: "incremental-runner",
    contextLimit: input.mainContextLimit,
    executeThresholdPercentage: input.executeThresholdPercentage,
    usage: input.liveUsage,
  });
  if (!hasRunnableCompartmentWindow(boundarySnapshot)) return "no-op";

  const resolveBoundary = (): ReturnType<typeof resolveOpenCodeProtectedTailBoundary> =>
    resolveOpenCodeProtectedTailBoundary({
      db: input.db,
      sessionId: input.sessionId,
      mode: "incremental-runner",
      contextLimit: input.mainContextLimit,
      executeThresholdPercentage: input.executeThresholdPercentage,
      usage: input.liveUsage,
    });

  const runnerDeps: HiddenCompartmentRunnerDeps = {
    client: undefined,
    db: input.db,
    sessionId: input.sessionId,
    directory: input.directory,
    historianChunkTokens: input.historianChunkTokens,
    historianTimeoutMs: input.historianTimeoutMs,
    boundarySnapshot,
    currentContextLimit: boundarySnapshot.contextLimit,
    // S24-fix：historian 是异步的，从触发到它真的开跑之间会话又落了新消息，于是
    // ordinal→id 的映射整体后移，快照必然被判 stale。上游为 manual-wrapup 准备的
    // 这条「run 时重解一次」钩子在这里正是同一件事；不接它，runner 每轮都诚实
    // no-op（实测日志：`historian no-op: stale protected-tail snapshot (offset
    // ordinal 1 id changed)`），compartment 永远产不出来。重解用的是同一份判据与
    // 同一个真实读数，所以 protected-tail 保证不变——重解后的
    // protectedTailStart/eligibleEnd 是按**当下**的消息算出来的。
    refreshBoundarySnapshot: () => resolveBoundary(),
    hiddenCompletionExecutor: input.executor,
    getNotificationParams: () => ({}),
    ...(input.historianModel === undefined ? {} : { model: input.historianModel }),
    ...(input.fallbackModels.length === 0 ? {} : { fallbackModels: input.fallbackModels }),
    ...(input.historianMaxOutputTokens === undefined
      ? {}
      : { historianMaxOutputTokens: input.historianMaxOutputTokens }),
    historianTwoPass: input.historianTwoPass,
    // D-2 之外的保守默认：historian 不向 project memory 提升事实。设置页的
    // memory 开关在 Phase 2b 才接进来，此处显式关闭而不是留 undefined。
    memoryEnabled: false,
    ...(input.forceDrainQuota ? { forceDrainQuota: true } : {}),
  };

  startCompartmentAgent(runnerDeps);
  const active = getActiveCompartmentRun(input.sessionId);
  if (!active) return "no-op";
  try {
    await active.promise;
    return active.published ? "success" : "no-op";
  } catch {
    return "error";
  }
}
