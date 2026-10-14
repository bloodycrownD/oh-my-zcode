import {
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
  createToolExecutor,
  getCurrentTraceContext,
  registerBuiltInTools,
  traceContextToLogContext,
} from "../deps.js";
import type { HookRunner, SessionId, ToolExecutor, TraceContext } from "../deps.js";
import { createDoomLoopGateState } from "../../tool/executor/doom-loop-gate.js";
import {
  CTX_EXPAND_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
  CTX_REDUCE_TOOL_NAME,
  CTX_SEARCH_TOOL_NAME,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps, AgentRuntimeConfig } from "../types.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { createRuntimeSessionModePort } from "../session-mode-port.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "./tool-allowlist.js";
import { isStaleBranchRuntimeTaskEvent } from "../methods/runtime-command-generation.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { sessionHasLoadedSkill } from "../../agent/loaded-skills.js";

const DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000;

/** 见 `resolveRuntimeDisallowedToolsWithMagicContext` 的根因注释。 */
const MAGIC_CONTEXT_WORKFLOW_CHILD_DISALLOWED_TOOLS: readonly string[] = [
  CTX_REDUCE_TOOL_NAME,
  CTX_EXPAND_TOOL_NAME,
  // Step 10（D4/D14）同族加入。ctx_memory 是**跨会话持久写**：workflow child
  // 的工具交互只在 subagent 路径镜像到父会话，而一条记忆的影响远大于一次会话
  // （所有后续会话的 m0/m1 注入与 ctx_search 都会看见它），用户在父界面没有
  // 否决机会——与 ctx_reduce「盖章不可见」同属结构性禁用，不是权限档位问题。
  // ctx_search 读的是同一个 store，与 ctx_expand 同理禁掉。
  CTX_SEARCH_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
];
const EMPTY_RUNTIME_HOOK_CONFIG = {
  enabled: false,
  events: {},
  maxOutputBytes: 32_768,
  timeoutMs: 60_000,
} as const;

export function initializeRuntimeTooling(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): { executor: ToolExecutor; hookRunner?: HookRunner } {
  registerRuntimeBuiltInTools(runtime, deps);
  const hookRunner = createRuntimeHookRunner(runtime, deps, sessionId);
  return {
    executor: deps.toolExecutor ?? createRuntimeToolExecutor(runtime, deps, hookRunner),
    hookRunner,
  };
}

/**
 * FORK（bugfix-batch-20261011 / Step 14）：prompt-surface 分档描述的一组注册选项。
 *
 * 首次装配（{@link registerRuntimeBuiltInTools}）与分支刷新
 * （`refreshBranchAwareBuiltInTools`，embedded-search 分支的第二个注册入口）**必须**拿到
 * 同一个推导结果。后者只传一个精简选项集，漏传这一组的后果不是「保持原样」而是「把 light
 * 档描述翻回 full」——registry.register 覆盖同名项且 silentDuplicateWarnings 吞告警，
 * 全程无声。因此抽成这一个函数，两个入口各自调用。
 *
 * `modelKey` 取会话当前的模型选择：它是 preset 路由的输入（`prompt_surface.models` 的
 * per-model 键）。缺席（还没有活模型 / 无选择）时求值器自己按 configured default 解析——
 * 那是配置的事实，不是退化路径。
 */
export function resolveMagicContextPromptSurfaceOptions(runtime: AgentRuntimeInternal): {
  magicContextToolDescription?: NonNullable<AgentRuntimeDeps["magicContextToolDescription"]>;
  magicContextModelKey?: string;
} {
  const describe = runtime.magicContextToolDescription;
  if (describe === undefined) return {};
  const selection = runtime.config.modelSelection;
  const modelKey =
    selection === undefined ? undefined : `${selection.providerId}/${selection.modelId}`;
  return {
    magicContextToolDescription: describe,
    ...(modelKey === undefined ? {} : { magicContextModelKey: modelKey }),
  };
}

function registerRuntimeBuiltInTools(runtime: AgentRuntimeInternal, deps: AgentRuntimeDeps): void {
  const nodeReplEnabled = runtime.config.runtimeFeatures?.nodeRepl === true;
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    includeSendMessage: runtime.subagentPort?.sendMessage !== undefined,
    includeRespondToCoordinator:
      runtime.config.taskType === "subagent_child" && Boolean(deps.coordinatorResponsePort),
    // submit_result 只在注入了 workflowSubmitPort 的 workflow actor 会话注册。以端口存在为门，
    // 与 taskType 无关：workflow actor 是 workflow_child，其 runtimeScope 目前是 "main"。
    includeSubmitResult: Boolean(deps.workflowSubmitPort),
    // mono 子代理：typed 声明。门仍是端口。
    ...(deps.workflowSubmitSchema === undefined
      ? {}
      : { submitResultSchema: deps.workflowSubmitSchema }),
    // escalate 与 submit_result 同门同理由：端口在场即注册（不做 opt-in：最可能撞墙的 actor 恰是作者没标记的那个）。
    includeEscalate: Boolean(deps.workflowEscalatePort),
    includeWorkflow: Boolean(deps.workflowPort),
    includeAutomation: Boolean(deps.automationPort) && runtime.config.taskType !== "subagent_child",
    // 动态工作流灰度门：这里不能用端口在场做判据——十个工具的端口在任何 CLI 里都装配齐全，灰度是 Host 的决定。
    // 取值收在 tool-allowlist.ts，与分支刷新那个入口共用同一个推导。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime.config),
    // browserControlPort 只是宿主能力，不应隐式暴露高权限 node_repl。
    // node_repl/browser-use 由 ZCode 官方 browser-use 插件启停推导出的 runtimeFeatures 控制。
    includeNodeRepl: nodeReplEnabled,
    includeBrowserUse: browserUseEnabled,
    // magic-context 上下文回收面：门是 `features.magicContext`（step 28 起默认 true）。
    // ctx handler 是动态 import 包的，所以这道门同时决定了「模型看得见这两个工具吗」
    // 与「整棵 magic-context 模块图进不进内存」——见 handlers/index.ts 的注释。
    includeMagicContextTools: runtime.config.magicContext?.enabled === true,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
    agentProfiles: runtime.config.subagents?.profiles,
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // workflow_child 的结构性禁用（CreateWorkflow/SaveWorkflow 因 alwaysAsk 隐形挂起；
    // ResumeWorkflowRun 已免确认但因「child 内不得再编排」仍在列）在 helper
    // 里与 turn 级名单合并，见 tool-allowlist.ts 的根因注释。
    disallowedTools: resolveRuntimeDisallowedToolsWithMagicContext(runtime.config),
    // FORK（Step 14）：prompt-surface 分档描述。与 embedded-search 分支刷新共用同一个
    // 推导入口，见 resolveMagicContextPromptSurfaceOptions 的说明。
    ...resolveMagicContextPromptSurfaceOptions(runtime),
  });
}

/**
 * workflow_child 额外不注册四个 ctx 工具。
 *
 * 根因与 `WORKFLOW_CHILD_DISALLOWED_TOOLS` 的第一条同源，但更硬：child 的工具交互
 * 事件只在 subagent 路径上镜像到父会话，一个 workflow child 在自己的会话里盖掉的
 * §N§ 标记，父会话与用户**都看不到**——用户会以为那段上下文还在，而它已经被排队
 * 清掉了。这不是「无窗可弹」，是「用户失去了否决的机会」，因此属于**结构性禁用**
 * 而不是权限档位问题。
 *
 * `ctx_expand` 也一并禁掉：它读的是同一个 store，读到被别的 actor 盖掉的 tag 只会
 * 让 child 拿到一份用户没批准过的视图。
 *
 * Step 10 起 `ctx_search` / `ctx_memory` 同族入列：前者读同一个记忆 store（同
 * ctx_expand 理由），后者是跨会话持久写——一条从 child 钉进去的记忆会影响之后
 * **所有**会话的注入与检索，比一次盖章的可见性缺口更大（见常量处的展开注释）。
 *
 * 这份追加刻意留在本文件而不是 `tool-allowlist.ts`：`resolveRuntimeDisallowedTools`
 * 是两个 child runtime 构造点共用的推导入口，而 ctx 这道门只跟「magic-context 开着」
 * 这件事有关，与 workflow child 的构造点无关。
 */
function resolveRuntimeDisallowedToolsWithMagicContext(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const base = resolveRuntimeDisallowedTools(config);
  if (config.taskType !== "workflow_child") return base;
  const disallowed = new Set(base ?? []);
  for (const toolName of MAGIC_CONTEXT_WORKFLOW_CHILD_DISALLOWED_TOOLS) {
    disallowed.add(toolName);
  }
  return [...disallowed];
}

function createRuntimeHookRunner(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): HookRunner | undefined {
  let hookRunner =
    deps.hookRunner ??
    ((runtime.config.hooks?.enabled || deps.workspaceHookSnapshot) && deps.executionPort
      ? createConfiguredHookRunner({
          config: runtime.config.hooks ?? EMPTY_RUNTIME_HOOK_CONFIG,
          emitEvent: async (event) => {
            await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
          },
          executionPort: deps.executionPort,
          getWorkingDirectory: () => runtime.workingDirectory,
          logger: runtime.logger,
          workspaceHookAdmission: deps.workspaceHookAdmission,
          workspaceHookSnapshot: deps.workspaceHookSnapshot,
        })
      : undefined);

  if (!deps.sessionMailboxPort) {
    return hookRunner;
  }

  hookRunner ??= createInMemoryHookRunner({
    emitEvent: async (event) => {
      if (isStaleBranchRuntimeTaskEvent(runtime, event)) return;
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    logger: runtime.logger,
  });
  for (const hook of createSessionMailboxHookRegistrations({
    enqueuePendingInput: async (input, traceContext) => {
      const result = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: traceContext.turnId,
        input,
        traceContext,
      });
      if (result.kind === "rejected") {
        runtime.logger?.warn("Session mailbox input was not queued", {
          ...traceContextToLogContext(traceContext),
          event: "session.mailbox.queue_rejected",
          module: "core.runtime",
          reason: result.reason,
          status: "completed",
        });
      }
    },
    mailbox: deps.sessionMailboxPort,
    sessionId,
  })) {
    if ("register" in hookRunner && typeof hookRunner.register === "function") {
      hookRunner.register(hook);
    }
  }
  return hookRunner;
}

function createRuntimeToolExecutor(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  hookRunner: HookRunner | undefined,
): ToolExecutor {
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  return createToolExecutor({
    registry: runtime.registry,
    permissionService: runtime.permissionService,
    permissionBroker: runtime.permissionBroker,
    // Doom loop 门：executor 会话级闭包状态 + 配置（默认 ask；无权限客户端时
    // broker 请求自动失败，ask 降级为拒绝，规避子代理 ask 死锁）。
    doomLoop: createDoomLoopGateState(),
    doomLoopCheck: runtime.config.modelAnomalyGuard?.doomLoopCheck ?? "ask",
    emitEvent: async (event) => {
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    enqueueBackgroundTaskNotification: (notification) => {
      runtime.enqueueBackgroundTaskNotification(notification);
    },
    shouldEnqueueBackgroundTaskNotification: (input) =>
      shouldEnqueueRuntimeBackgroundTaskNotification(runtime, input),
    logger: runtime.logger,
    backgroundTaskControlPort: {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    },
    executionPort: deps.executionPort,
    browserControlPort: browserUseEnabled ? deps.browserControlPort : undefined,
    browserDocumentationRoot: browserUseEnabled
      ? runtime.config.runtimeFeatures?.browserDocumentationRoot
      : undefined,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    // 合并删除旧模型连接时曾漏掉此端口；Read 分页渲染与整份 PDF 页数检查仍依赖宿主注入。
    pdfDocumentPort: deps.pdfDocumentPort,
    embeddedSearchBackend: runtime.config.embeddedSearchBackend,
    nativeSearchEnhancementsEnabled: runtime.config.nativeSearchEnhancementsEnabled,
    skillPort: deps.skillPort,
    subagentPort: runtime.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    automationPort: deps.automationPort,
    sessionStore: deps.sessionStore,
    sessionModePort: createRuntimeSessionModePort(runtime),
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: runtime.runtimeTaskRegistry,
    readFileState: runtime.readFileState,
    // 工作流创作工具的技能门（tool/handlers/workflow-skill-gate.ts）：按模型此刻看得见的历史回答
    // 「读过技能没有」。只在会话真有 Skill 工具时给探针——没有 skillPort 的会话装不上那个技能，
    // 门若仍然在场就成了一道谁也过不去的墙。
    ...(deps.skillPort === undefined
      ? {}
      : {
          hasLoadedSkill: (skillName: string) =>
            sessionHasLoadedSkill(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), skillName),
        }),
    subagentBackgroundBashMaxMs:
      runtime.config.taskType === "subagent_child"
        ? normalizeSubagentBackgroundBashMaxMs(runtime.config.subagents?.backgroundBashMaxMs)
        : undefined,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    hookRunner,
    getWorkingDirectory: () => runtime.workingDirectory,
    setWorkingDirectory: runtime.setWorkingDirectory.bind(runtime),
    getWorkspaceRoot: () => runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
    remoteSessionId: runtime.config.remoteSessionId,
    clientMode: runtime.config.clientMode,
    deliveryKind: runtime.config.deliveryKind,
    getMemoryRoot: () =>
      deps.memoryRoot ?? resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot),
    runtimeScope: runtime.config.taskType === "subagent_child" ? "subagent" : "main",
    permissionTimeoutMs: runtime.config.permissionTimeoutMs,
    sessionId: runtime.sessionId,
    traceContext: runtime.rootTraceContext,
    getMode: () => runtime.config.mode ?? "build",
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
  });
}

function resolveRuntimeBrowserUseEnabled(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): boolean {
  return (
    runtime.config.runtimeFeatures?.browserUse === true && deps.browserControlPort !== undefined
  );
}

function shouldEnqueueRuntimeBackgroundTaskNotification(
  runtime: AgentRuntimeInternal,
  input: {
    status: string;
    taskId: string;
    toolName: string;
    traceContext: TraceContext;
  },
): boolean {
  if (runtime.shuttingDown) {
    runtime.logger?.info?.("Suppressed background task notification during runtime shutdown", {
      ...traceContextToLogContext(input.traceContext),
      event: "runtime.background_task_notification.shutdown_suppressed",
      module: "core.runtime",
      taskId: input.taskId,
      taskStatus: input.status,
      toolName: input.toolName,
    });
    return false;
  }
  const registryTask = runtime.runtimeTaskRegistry.get(input.taskId);
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: runtime.config.taskType === "subagent_child",
      notificationSealed: runtime.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: input.toolName,
    })
  ) {
    return true;
  }
  runtime.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(input.traceContext),
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: runtime.backgroundTaskNotificationSealReason,
    taskId: input.taskId,
    taskStatus: input.status,
    toolName: input.toolName,
  });
  return false;
}

function normalizeSubagentBackgroundBashMaxMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS;
  }
  return Math.trunc(value);
}
