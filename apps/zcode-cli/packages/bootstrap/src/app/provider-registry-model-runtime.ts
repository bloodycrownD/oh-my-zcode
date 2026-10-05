import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { Logger, Model } from "@zcode/contracts";
import type { AgentRuntimeDeps } from "@zcode/core";
import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
  readonly logger?: Pick<Logger, "warn">;
  /**
   * FORK（D-12）：目标 Selection 在 Registry 中不存在时的回退解析。
   * 返回值必须再过一次 `validateSelection`，否则 `#createRegistryModel` 会在
   * `selection.options!.reasoningLevel!` 上崩。用户配置的默认模型很可能不带 options。
   */
  readonly resolveFallbackSelection?: (bad: ModelSelection) => ModelSelection | undefined;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  readonly #logger?: Pick<Logger, "warn">;
  readonly #resolveFallbackSelection?: (bad: ModelSelection) => ModelSelection | undefined;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
    this.#logger = options.logger;
    this.#resolveFallbackSelection = options.resolveFallbackSelection;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (validation.ok) return this.#createModel(target.selection, target);
    // FORK（D-12）：Registry 已不认这个 Selection（典型是旧会话里的 `account:*` providerId）。
    // 回退目标必须自身可校验，且必须带得出 reasoningLevel，否则下游 `options!` 会 TypeError。
    const fallback = this.#resolveFallbackSelection?.(target.selection);
    const fallbackReasoningLevel = fallback?.options?.reasoningLevel;
    if (!fallback || fallbackReasoningLevel === undefined) {
      throw createRegistrySelectionProtocolError(validation);
    }
    if (!this.#registry.validateSelection(fallback).ok) {
      throw createRegistrySelectionProtocolError(validation);
    }
    this.#logger?.warn("已回退到默认模型：原会话的 provider 不再存在", {
      event: "provider_registry.model_selection_fallback",
      fallbackModelId: fallback.modelId,
      fallbackProviderId: fallback.providerId,
      modelId: target.selection.modelId,
      module: "bootstrap.provider_registry",
      providerId: target.selection.providerId,
    });
    return this.#createModel(fallback, {
      ...target,
      selection: { ...fallback, options: { ...fallback.options, reasoningLevel: fallbackReasoningLevel } },
    });
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createModel(
    selection: ModelSelection,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const providerId = selection.providerId;
    const modelId = selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    return this.#createRegistryModel(provider, registryModel, target);
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // Selection 已在上面的 Registry 边界完成校验，Factory 不再承担任何缺省修复。
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      modelConfig: config,
      options: {
        reasoningLevel: normalReasoningLevel,
      },
    });
  }
}
