import type { ConfigResult } from "@zcode/adapters/config";
import { resolveInitialModelSelection, type ModelSelectionOptions } from "@zcode/provider";
import { resolveBashTimeoutPolicy, type AgentProfile, type AgentRuntimeConfig } from "@zcode/core";
import { type BuiltInSubagentModelSelectionOverrides } from "@zcode/shared";
import {
  type CollaborationMode,
  type HookConfigSource,
  type HookEventName,
  type HookMatcherConfig,
  type HooksRuntimeConfig,
  type McpServerConfig,
} from "@zcode/contracts";
import { omitMcpServers, resolveTrustedOfficialCuaServerNames } from "../mcp-config.js";
import { resolveDefaultEmbeddedSearchBackend } from "./embedded-search-backend.js";
import { getProjectMemoryRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import {
  resolveRegistryOwnedModelSelection,
  resolveRegistryModelSelection,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

interface ResolvedAppRuntimeConfig {
  configuredMcpServers: Record<string, McpServerConfig>;
  runtimeConfig: AgentRuntimeConfig;
  untrustedProjectMcpServers: Set<string>;
}

interface ResolvedInitialRegistrySelection extends ResolvedRegistrySelection {
  readonly selectionOptions?: ModelSelectionOptions;
}

export function resolveAppRuntimeConfig(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  persistedMode?: CollaborationMode;
  builtInMcpServers?: Record<string, McpServerConfig>;
  builtInSubagentModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  pluginHooks?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  pluginMcpServers?: Record<string, McpServerConfig>;
  pluginRuntimeFeatures?: AgentRuntimeConfig["runtimeFeatures"];
  subagentOutputRootDir: string;
  subagentProfiles?: readonly AgentProfile[];
  storageRoot?: string;
  workingDirectory: string;
  workspaceIdentity?: string;
}): ResolvedAppRuntimeConfig {
  const {
    cliStorageRoot,
    configResult,
    options,
    persistedMode,
    builtInMcpServers,
    pluginMcpServers,
    pluginRuntimeFeatures,
    subagentOutputRootDir,
    subagentProfiles = [],
    workingDirectory,
    workspaceIdentity,
  } = input;
  const userInstructions = options.runtimeConfig?.userInstructions ?? { workingDirectory };
  const registrySelection = resolveInitialRegistrySelection(options);
  // 恢复历史不等于开始执行：失效/缺失选择保持未绑定，不能借 configured default 补齐。
  const initialModelSelection = options.resume
    ? registrySelection?.selection
    : (options.runtimeConfig?.modelSelection ?? registrySelection?.selection);
  // 空白会话先创建、再应用本次 Submission 的选择；强制初始默认模型会
  // 让未配置 default 的用户在 switch/send 前就创建失败。未绑定 Runtime 可以存在，
  // 真正执行仍由 admission/ModelFactory 校验完整选择，不能在这里偷偷选择 Registry 首项。
  const requestedTitleGeneration = options.runtimeConfig?.titleGeneration;
  const requestedTitleModelSelection = requestedTitleGeneration?.modelSelection;
  const titleGeneration =
    requestedTitleGeneration === undefined
      ? undefined
      : {
          ...requestedTitleGeneration,
          // 标题生成 sidecar 默认 15s 在慢模型/代理链路下容易超时，
          // 入口层统一补 60s，避免旧 core 默认值或空配置让桌面端继续回落到 15s。
          timeoutMs: requestedTitleGeneration.timeoutMs ?? 60_000,
          // 空 titleGeneration 表示启用默认标题生成，模型必须跟随会话当前模型。
          // 如果这里在草稿 session 创建时固化另一份标题模型，之后切模型只会更新主链路，
          // 首发时的 generate title sidecar 会继续使用切换前的旧 provider/model。
          ...(requestedTitleModelSelection
            ? {
                modelSelection: requestedTitleModelSelection,
              }
            : {}),
        };
  // Protocol session/create 传入的 mcp.servers 只包含 UI MCP 设置里的用户配置，
  // 不包含插件注册的 MCP。宿主内建 server 最后合并并保留其 identity，避免用户或第三方
  // 用同名配置劫持 mcp__node_repl__*；普通 plugin MCP 仍允许显式用户配置覆盖。
  const configuredMcpServers = {
    ...pluginMcpServers,
    ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers),
    ...builtInMcpServers,
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginMcpServers ?? {},
  );
  const cuaBridgeServerNames = new Set(trustedOfficialCuaServerNames);
  if (pluginRuntimeFeatures?.computerUse === true && configuredMcpServers.node_repl) {
    // node_repl 需要 broker 注入，但不是 CUA MCP server。注入资格与官方 CUA 图片
    // authority 必须分开；把它塞进 trustedOfficialCuaServerNames 会让整个
    // 通用 node_repl 结果被误送进 exact-raster gate，Browser 截图和 console 日志都会失败。
    cuaBridgeServerNames.add("node_repl");
  }
  // 产品决定 workspace MCP 开箱即用：project 作用域 MCP 默认 trusted，并自动连接。
  const untrustedProjectMcpServers = new Set<string>();
  const autoConnectMcpServers = omitMcpServers(
    configuredMcpServers,
    untrustedProjectMcpServers,
    cuaBridgeServerNames,
  );
  const runtimeBuiltInModelSelectionOverrides =
    options.runtimeConfig?.subagents?.builtInModelSelectionOverrides ?? {};
  const runtimeConfig: AgentRuntimeConfig = {
    ...options.runtimeConfig,
    bashTimeoutPolicy:
      options.runtimeConfig?.bashTimeoutPolicy ??
      resolveBashTimeoutPolicy(options.env ?? process.env),
    mode: options.runtimeConfig?.mode ?? persistedMode ?? configResult.config.permission.mode,
    modelSelection: initialModelSelection,
    // 仅接受显式传入的会话级工具面（ZCode Protocol session/create 或 CLI
    // --allowed-tools/--disallowed-tools）。不要从 config.permission.allowedTools
    // 回落：那个键的既有语义是“免审批清单”，把它投影到注册面会让老配置里
    // 只写了几个 allowedTools 的用户突然丢失其余全部工具。
    toolAllowlist: options.runtimeConfig?.toolAllowlist,
    toolDisallowlist: options.runtimeConfig?.toolDisallowlist,
    embeddedSearchBackend:
      options.runtimeConfig?.embeddedSearchBackend ??
      resolveDefaultEmbeddedSearchBackend({
        env: options.env,
      }),
    runtimeFeatures: pluginRuntimeFeatures,
    language: options.runtimeConfig?.language,
    titleGeneration,
    workingDirectory,
    userInstructions: {
      ...userInstructions,
      workingDirectory: userInstructions.workingDirectory ?? workingDirectory,
    },
    skillMetadataBudget:
      options.runtimeConfig?.skillMetadataBudget ?? configResult.config.skills.metadataBudget,
    toolConcurrency: {
      maxConcurrency:
        options.runtimeConfig?.toolConcurrency?.maxConcurrency ??
        configResult.config.toolConcurrency.maxConcurrency,
    },
    modelAnomalyGuard: {
      ...configResult.config.modelAnomalyGuard,
      ...options.runtimeConfig?.modelAnomalyGuard,
    },
    mcp: {
      enabled: options.runtimeConfig?.mcp?.enabled ?? configResult.config.features.mcp,
      servers: autoConnectMcpServers,
      trustedOfficialCuaServerNames: [...trustedOfficialCuaServerNames],
    },
    hooks: mergeRuntimeHooks(
      options.runtimeConfig?.hooks
        ? withHookConfigSource(options.runtimeConfig.hooks, { kind: "internal" })
        : configResult.config.hooks,
      input.pluginHooks,
    ),
    subagents: {
      ...options.runtimeConfig?.subagents,
      enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
      outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
      builtInModelSelectionOverrides: {
        ...(input.builtInSubagentModelSelectionOverrides ?? {}),
        ...runtimeBuiltInModelSelectionOverrides,
      },
      profiles: [...(options.runtimeConfig?.subagents?.profiles ?? []), ...subagentProfiles],
    },
    memory: {
      cliStorageRoot,
      enabled: options.runtimeConfig?.memory?.enabled ?? configResult.config.features.memory,
      ...(options.runtimeConfig?.memory?.extractionEnabled === undefined
        ? {}
        : { extractionEnabled: options.runtimeConfig.memory.extractionEnabled }),
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      use: options.runtimeConfig?.memory?.use ?? configResult.config.memory.use,
      workspaceIdentity: workspaceIdentity?.trim() || undefined,
    },
    // Step 19b 门控：`features.magicContext`（S19a 落地的 kill switch，step 28 起
    // 默认 true）投影进 runtime config。core 的 turn-loop 只读这一位做二次门控，
    // 真正的注册门是装配层——它在 false 时连 transform 实例都不构造（用户显式
    // 关闭时的零成本态，T-M8 语义）。
    //
    // FORK（MF-01）：这里补上 spec 契约 8 的另一半——`effective = features.magicContext
    // && magicContext.enabled`。之前只镜像 features flag，于是 D-12 设置页把
    // `enabled` 当表单字段提交时「保存成功」而行为逐行不变（`config.enabled`
    // 全仓只被 `findConfigReadinessError` 读过一次）。域值缺席时按包内 schema 的
    // 缺省 true 处理（`enabled: z.boolean().default(true)`）。
    //
    // 这是**冷**求值：结果冻结进 runtime.config。运行中改 `enabled` 走端口上的
    // 活值谓词 `isEnabled()`（core 每 turn 现读），见 core
    // `runtime/helpers/magic-context-turn-transform.ts` 与 bootstrap
    // `magic-context-turn-transform.ts`。
    magicContext: {
      enabled:
        (options.runtimeConfig?.magicContext?.enabled ??
          configResult.config.features.magicContext) &&
        // 配置契约层把参数域收敛成不透明对象（`create-app.ts` 侧同样靠断言读它），
        // 这里只需要 `enabled` 那一位。
        (configResult.config as { magicContext?: { enabled?: boolean } }).magicContext?.enabled !==
          false,
    },
  };
  return {
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
  };
}

function withHookConfigSource(
  config: HooksRuntimeConfig,
  source: HookConfigSource,
): HooksRuntimeConfig {
  return {
    ...config,
    events: Object.fromEntries(
      Object.entries(config.events).map(([eventName, matchers]) => [
        eventName,
        matchers?.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
        })),
      ]),
    ) as HooksRuntimeConfig["events"],
  };
}

function resolveInitialRegistrySelection(
  options: ZCodeAppOptions,
): ResolvedInitialRegistrySelection | undefined {
  const registry = options.providerRegistry;
  if (!registry) return undefined;

  if (options.runtimeConfig?.modelSelection) {
    const selection = options.runtimeConfig.modelSelection;
    if (options.resume && !registry.validateSelection(selection).ok) return undefined;
    const resolved = resolveRegistryOwnedModelSelection(registry, selection);
    return resolved
      ? {
          ...resolved,
          ...(selection.options ? { selectionOptions: selection.options } : {}),
        }
      : undefined;
  }

  if (options.resume) return undefined;
  const initial = resolveInitialModelSelection({
    configuredDefault: options.configuredDefaultModelSelection,
    registry: registry.getView(),
  });
  if (initial.source === "none") return undefined;
  const resolved = resolveRegistryOwnedModelSelection(registry, initial.selection);
  return resolved
    ? {
        ...resolved,
        ...(initial.selection.options ? { selectionOptions: initial.selection.options } : {}),
      }
    : undefined;
}

function mergeRuntimeHooks(
  base: HooksRuntimeConfig | undefined,
  pluginHooks: Partial<Record<HookEventName, HookMatcherConfig[]>> | undefined,
): HooksRuntimeConfig | undefined {
  if (!pluginHooks || Object.values(pluginHooks).every((matchers) => !matchers?.length)) {
    return base;
  }

  const mergedEvents: HooksRuntimeConfig["events"] = {
    ...base?.events,
  };
  for (const [eventName, matchers] of Object.entries(pluginHooks) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length === 0) continue;
    mergedEvents[eventName] = [...(mergedEvents[eventName] ?? []), ...matchers];
  }

  return {
    enabled: true,
    events: mergedEvents,
    maxOutputBytes: base?.maxOutputBytes ?? 32768,
    timeoutMs: base?.timeoutMs ?? 60000,
  };
}

export function runtimeConfigLogContext(
  runtimeConfig: AgentRuntimeConfig,
  workingDirectory: string,
) {
  const memoryRoot = runtimeConfig.memory?.cliStorageRoot
    ? getProjectMemoryRoot(
        runtimeConfig.memory.cliStorageRoot,
        workingDirectory,
        runtimeConfig.memory.workspaceIdentity,
      )
    : undefined;
  return {
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    memoryEnabled: runtimeConfig.memory?.enabled !== false,
    memoryExtractionEnabled: runtimeConfig.memory?.extractionEnabled !== false,
    memoryRoot,
    memoryUse: runtimeConfig.memory?.use !== false,
    mcsMode: runtimeConfig.midConversationSystem?.mode,
    mode: runtimeConfig.mode,
    model: runtimeConfig.modelSelection
      ? `${runtimeConfig.modelSelection.providerId}/${runtimeConfig.modelSelection.modelId}`
      : undefined,
    runtimeFeatureBrowserUse: runtimeConfig.runtimeFeatures?.browserUse === true,
    runtimeFeatureNodeRepl: runtimeConfig.runtimeFeatures?.nodeRepl === true,
    workingDirectory,
  };
}
