import type { ModelRequestSecurityState } from "./request-security.js";
// ============================================================
// Vercel AI SDK model runner
// ============================================================

import {
  ModelErrorCode,
  ModelProtocolError,
  getCurrentModelInvocationContext,
} from "@zcode/contracts";
import type {
  Logger,
  Model,
  ModelOptions,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelStatusSink,
  ModelStreamEvent,
  ModelTextResult,
} from "@zcode/contracts";
import type { RegistryModelConfig, RegistryProviderConfig } from "@zcode/provider";
import {
  AiSdkModelExecution,
  type AiSdkResolvedModel,
  type AiSdkNetworkConfig,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "./model-execution.js";
import {
  resolveAiSdkModelRetryOptions,
  type AiSdkModelRetryOptions,
  type ResolvedAiSdkModelRetryOptions,
} from "./retry-policy.js";
import { resolveRetryOptionsForBudget } from "./retry-budget.js";
import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "./stream-idle-timeout.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import { normalizeReasoningHistory } from "./reasoning-history-normalization.js";
import {
  defaultRuntime,
  type AiSdkModelRuntime,
  type AiSdkModelTextRequest,
  type ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { resolveToolSearchCapability } from "./tool-search.js";
import { createModel, type ModelExecutionRequest } from "./model.js";

export type { AiSdkModelRetryOptions } from "./retry-policy.js";
export type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
} from "./runner-runtime.js";
export { normalizeUsage, toModelStreamEvent } from "./runner-normalization.js";

export interface AiSdkModelAdapterOptions {
  defaultHeaders?: AiSdkModelExecutionConfig["defaultHeaders"];
  requestSecurityState?: ModelRequestSecurityState;
  endpointRoutingPort?: import("@zcode/contracts").ProviderEndpointRoutingPort;
  network?: AiSdkNetworkConfig;
  runtime?: AiSdkModelRuntime;
  env?: EnvRecord;
  debugDir?: string;
  logger?: Logger;
  retry?: AiSdkModelRetryOptions;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs?: number;
  modelIoFullRetentionEnabled?: boolean;
}

export interface CreateAiSdkModelOptions {
  providerId: string;
  modelId: string;
  providerConfig: RegistryProviderConfig;
  modelConfig: RegistryModelConfig;
  displayName?: string;
  options?: ModelOptions;
  requestDependencies?: ModelRequestDependencies;
}

export class AiSdkModelAdapter {
  private readonly execution: AiSdkModelExecution;
  private readonly runtime: AiSdkModelRuntime;
  private readonly env: EnvRecord;
  private readonly debugDir?: string;
  private readonly logger?: Logger;
  private readonly retry: ResolvedAiSdkModelRetryOptions;
  /** 对外出口：叶子只有一个时就是叶子本身，多个时是 `mergeStatusSinks` 合成的 fan-out。 */
  private statusSink?: ModelStatusSink;
  /** 叶子集合只增不减；同一实例重复加入按 Set 身份去重，避免嵌套合成导致双投。 */
  private readonly statusSinkLeaves: ModelStatusSink[] = [];
  private readonly statusSinkLeafIds = new Set<ModelStatusSink>();
  private readonly streamIdleTimeoutMs: number;
  private modelIoFullRetentionEnabled: boolean;

  constructor(options: AiSdkModelAdapterOptions) {
    this.execution = new AiSdkModelExecution(
      {
        defaultHeaders: options.defaultHeaders,
        ...(options.endpointRoutingPort
          ? { endpointRoutingPort: options.endpointRoutingPort }
          : {}),
        ...(options.network ? { network: options.network } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      {
        ...(options.requestSecurityState
          ? { requestSecurityState: options.requestSecurityState }
          : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      },
    );
    this.runtime = options.runtime ?? defaultRuntime;
    this.env = options.env ?? process.env;
    this.debugDir = options.debugDir;
    this.logger = options.logger;
    this.retry = resolveAiSdkModelRetryOptions(options.retry, this.env);
    if (options.statusSink) this.addStatusSinkLeaf(options.statusSink);
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
    this.modelIoFullRetentionEnabled = options.modelIoFullRetentionEnabled ?? false;
  }

  setModelIoFullRetentionEnabled(enabled: boolean): void {
    this.modelIoFullRetentionEnabled = enabled;
  }

  /**
   * 追加一个状态出口：与已有 sink 并行投递，任一失败不影响另一个。
   *
   * 生产遥测已按 119113f2 移除：`create-app` 不再装配进程级 sink，
   * `CreateModelAdapterBaseOptions` / `bootstrap/src/model-factory.ts` 也没有 `statusSink` 透传入口，
   * 因此本方法当前的生产调用数为 0，仅供测试注入（fault-matrix 的 statusEvents 断言需要多条出口）。
   * 恢复生产遥测时必须连同 create-app 的装配一起改，不能只在这里补一个调用。
   */
  addStatusSink(sink: ModelStatusSink): void {
    // 同一实例重复添加只投一次：身份去重挡在叶子集合这一层，嵌套合成对象会让
    // `runner-status` 的 `requestStatusSink !== statusSink` 也看不穿。
    if (this.statusSinkLeafIds.has(sink)) return;
    this.addStatusSinkLeaf(sink);
  }

  /** 登记叶子并重建无状态 fan-out：叶子只增不减，所以发布器每次重建即与集合一致。 */
  private addStatusSinkLeaf(sink: ModelStatusSink): void {
    this.statusSinkLeafIds.add(sink);
    this.statusSinkLeaves.push(sink);
    this.statusSink = mergeStatusSinks(this.statusSinkLeaves);
  }

  createModel(options: CreateAiSdkModelOptions): Model {
    const boundResolution = this.execution.bindModel({
      providerId: options.providerId,
      modelId: options.modelId,
      providerConfig: options.providerConfig,
      supportsJsonSchemaOutput: options.modelConfig.properties.supportsJsonSchemaOutput,
      optionSpecs: options.modelConfig.optionSpecs,
    });
    const properties = options.modelConfig.properties;
    const resolved = {
      ...boundResolution.resolved,
      properties,
    };
    const optionSpecs = options.modelConfig.optionSpecs;
    const toLegacyRequest = (request: ModelExecutionRequest): AiSdkModelTextRequest => {
      const context = getCurrentModelInvocationContext();
      const {
        refreshRuntimeHeadersBeforeAttempt,
        ...invocationContext
      } = context ?? {};
      return {
        toolSearchEnabled: request.toolSearchEnabled,
        messages: request.messages,
        tools: request.tools,
        responseJsonSchema: request.responseJsonSchema,
        abortSignal: request.abortSignal,
        maxOutputTokens: request.options.maxOutputTokens,
        ...invocationContext,
        ...(refreshRuntimeHeadersBeforeAttempt
          ? {
              refreshRuntimeHeadersBeforeAttempt: (input) =>
                refreshRuntimeHeadersBeforeAttempt(input),
            }
          : {}),
      };
    };
    const resolveForRequest = (
      request: AiSdkModelTextRequest,
      optionValues: Required<ModelOptions>,
    ): ((requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel) => {
      const maxOutputTokens = requireMaxOutputTokens(optionValues);
      return request.refreshRuntimeHeadersBeforeAttempt
        ? (requestAuth) => ({
            ...assertSameBoundModel(
              resolved,
              boundResolution.resolveRequest({
                options: {
                  maxOutputTokens,
                  reasoningLevel: optionValues.reasoningLevel,
                },
                requestAuth,
              }),
            ),
            properties,
          })
        : () => ({
            ...boundResolution.resolveRequest({
              options: {
                maxOutputTokens,
                reasoningLevel: optionValues.reasoningLevel,
              },
            }),
            properties,
          });
    };
    return createModel({
      requestCapabilities: {
        toolSearch: resolveToolSearchCapability(
          options.providerConfig.api.type,
          options.providerConfig.access,
        ),
      },
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      displayName: options.displayName,
      properties,
      optionSpecs: {
        maxOutputTokens: optionSpecs.maxOutputTokens,
        reasoningLevel: optionSpecs.reasoningLevel,
      },
      options: options.options,
      executor: {
        generateText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.generateTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
        streamText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.streamTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
      },
    });
  }

  private generateTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): Promise<ModelTextResult> {
    const projectedRequest = projectRequestHistory(request, resolved);
    return runGenerateText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }

  private async *streamTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): AsyncGenerator<ModelStreamEvent> {
    const projectedRequest = projectRequestHistory(request, resolved);
    yield* runStreamText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      // single-attempt 预算（带 selectionFallback 的执行作用域句柄）把 maxAttempts 收敛为 1。
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }
}

function requireMaxOutputTokens(options: ModelOptions): number {
  if (options.maxOutputTokens === undefined) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "maxOutputTokens requires an explicit request value",
    );
  }
  return options.maxOutputTokens;
}

function assertSameBoundModel(
  bound: ResolvedAiSdkModel,
  refreshed: AiSdkResolvedModel,
): AiSdkResolvedModel {
  if (bound.providerId !== refreshed.providerId || bound.modelId !== refreshed.modelId) {
    throw new Error("Runtime header refresh changed the bound model identity.");
  }
  return refreshed;
}

function projectRequestHistory(
  request: AiSdkModelTextRequest,
  resolved: ResolvedAiSdkModel,
): AiSdkModelTextRequest {
  if (resolved.providerKind !== "anthropic") return request;

  // 结构归一化过去位于每次物理请求都会经过的 serializer，签名修复重试
  // 因而会再次删除上一轮刚补出的 assistant 占位并合并 user。逻辑请求入口只投影一次，
  // 后续 attempt 只能复用或从这份 request-local history 派生。
  const messages = normalizeReasoningHistory(request.messages, {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
  });
  return messages === request.messages ? request : { ...request, messages };
}

/**
 * 由叶子集合构造无状态 fan-out 出口：发布器只持有构造时的叶子快照，不累积任何跨事件状态。
 * 叶子只有一个时直接返回叶子本身——`runner-status` 用 `requestStatusSink !== statusSink` 做身份去重，
 * 套一层合成对象会让「同一 sink 既是 adapter 出口又是 request 出口」投递两次。
 */
function mergeStatusSinks(leaves: readonly ModelStatusSink[]): ModelStatusSink {
  if (leaves.length === 1) return leaves[0];
  const targets = [...leaves];
  return {
    async publish(event) {
      await deliverToStatusSinks(targets, (leaf) => leaf.publish(event));
    },
    // 与 `runner-status` 同一条纪律：有 `publishFailure` 的 sink 拿原始异常，
    // 没有的退回 `publish(event)`，不让原始异常污染只消费事件的出口。
    async publishFailure(event, error) {
      await deliverToStatusSinks(targets, (leaf) =>
        leaf.publishFailure ? leaf.publishFailure(event, error) : leaf.publish(event),
      );
    },
  };
}

/**
 * 逐 sink 投递并用 `allSettled` 隔离：任一 sink 抛错不影响其它 sink 的投递。
 * 全部失败时没有可代表的单一原因，用 AggregateError 汇总上抛（调用方只记一条 warn）；
 * 部分失败保留第一个 rejection 的原始异常，不额外包一层。
 */
async function deliverToStatusSinks(
  leaves: readonly ModelStatusSink[],
  deliver: (leaf: ModelStatusSink) => void | Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    leaves.map((leaf) => Promise.resolve().then(() => deliver(leaf))),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 0) return;
  if (failures.length === leaves.length) {
    throw new AggregateError(failures, "Model status sink 全部投递失败");
  }
  throw failures[0];
}
