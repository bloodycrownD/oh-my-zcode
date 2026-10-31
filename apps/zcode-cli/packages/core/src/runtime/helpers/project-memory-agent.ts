import type { Model, ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
  traceContextToLogContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
// fork 的 extraction 走 buildRuntimeProviderRequestMessages；上游 dream 走
// prepareRuntimeProviderRequest（带 ToolSearch exposure 决策）。两者都保留。
import {
  buildRuntimeProviderRequestMessages,
  prepareRuntimeProviderRequest,
} from "./runtime-provider-request-messages.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";

export interface ProjectMemoryAgentContext {
  memoryRoot: string;
  providerEntries: readonly RuntimeMessageEntry[];
  midConversationSystem: AgentRuntimeInternal["config"]["midConversationSystem"];
  model: Model;
  /** model-io 的 querySource 维度；只用于本地 transcript 元数据。 */
  // FORK: 上游此字段是 ModelApiOperation（随遥测面移除）；这里用字面量联合保留
  // Extraction 与 Dream 两条上游调用链的既有取值。
  operation: "project_memory_extract" | "project_memory_dream";
  readFileState: ReadFileStateMap;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}

export function captureProjectMemoryAgentContext(
  runtime: AgentRuntimeInternal,
  input: {
    memoryRoot: string;
    /** Extraction 继承产生该工作的 Turn Model。 */
    model?: Model;
    operation: "project_memory_extract" | "project_memory_dream";
    traceContext: TraceContext;
  },
): ProjectMemoryAgentContext {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = withModelInvocationContext(baseModel, () => ({
    // Extraction 是 transcript 的消费者；不把它自己的请求写回同一 model-io 目录，
    // 避免后台链路占用 rollout 槽位并在后续 Extraction 中自反馈。
    metadata: {
      ...traceContextToLogContext(input.traceContext),
      querySource: input.operation,
      skipTranscript: true,
    },
    // TODO(upgrade-316): 上游把这里的 per-call modelRequestSessionType 换成
    // modelCall + refreshRuntimeHeadersBeforeAttempt；前者已随遥测面移除（ModelInvocationContext
    // 无 modelCall 字段），后者依赖的 methods/model-runtime-headers.ts 未进入本 fork 树。
    // 暂保留 fork 的 "other" 覆写，待人工确认是否改由句柄层 sessionType 统一决定。
    modelRequestSessionType: "other",
    traceContext: input.traceContext,
  }));
  return {
    memoryRoot: input.memoryRoot,
    // Extraction 会跨异步边界消费这份成员浅快照；它依赖 RuntimeMessageEntry
    // 进入 MessageHistory 后保持不可变。后续只能 append、整体 replace 或 copy-on-write，
    // 禁止原地修改共享的 entry/message/content，否则会污染已调度的 Memory 上下文。
    providerEntries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
    midConversationSystem: runtime.config.midConversationSystem,
    model,
    operation: input.operation,
    readFileState: new Map(runtime.readFileState),
    // Memory 的既有执行策略不允许 ToolSearch；历史引用只在此请求投影中降级。
    tools: runtime
      .getTools(model)
      .filter((tool) => tool.name !== "ToolSearch")
      .map((tool) => ({ ...tool })),
    traceContext: input.traceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

export function prepareProjectMemoryAgentRequest(
  context: ProjectMemoryAgentContext,
  prompt: string,
) {
  return prepareRuntimeProviderRequest(
    {
      config: { midConversationSystem: context.midConversationSystem },
    },
    {
      applyCacheControl: true,
      entries: context.providerEntries,
      model: context.model,
      prompt,
      tools: context.tools,
    },
  ).request;
}

/**
 * fork 路径：把 prompt 追加到已捕获的投影条目后，直接渲染 provider 消息。
 * 与上游 prepareProjectMemoryAgentRequest 并存（extraction 用本函数，dream 用上游那个）。
 */
export function buildProjectMemoryAgentProviderMessages(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  prompt: string,
): ModelInputMessage[] {
  const entries: RuntimeMessageEntry[] = [
    ...context.providerEntries,
    { message: { content: prompt, role: "user" } },
  ];
  return buildRuntimeProviderRequestMessages(
    {
      config: { midConversationSystem: context.midConversationSystem },
    },
    { applyCacheControl: true, entries, model: context.model },
  ).messages;
}

export function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  return createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: runtime.fileSystemPort,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getMemoryRoot: () => context.memoryRoot,
    getWorkingDirectory: () => context.workingDirectory,
    getWorkspaceRoot: () => context.workspaceRoot,
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // Memory agent 必须继承 Main 已完成的 Read；否则 provider context 说文件已读，
    // Edit 执行边界却会拒绝同一文件，和基线的 cloned tool context 不一致。
    readFileState: new Map(context.readFileState),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: context.traceContext,
  });
}
