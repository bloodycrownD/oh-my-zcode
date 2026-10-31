import { getTurnTools } from "./turn-tool-visibility.js";
import { appendRuntimeAgentListing } from "../helpers/agent-listing.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { createMessageId, traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  runMagicContextTurnTransform,
  prepareRuntimeProviderRequest,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import {
  isUnattendedDispatchTurn,
  UNATTENDED_DISPATCH_DENIED_TOOL_NAMES,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    // FORK: 上游每轮先调用 refreshOffPeakTurnAfterTakeover 应用闲时接管后的模型；
    // fork 已整体移除官方闲时/计费面，该钩子恒为 no-op，不再接线。
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    if (state.completedRealToolResultBatch && !outputTokenRecoveryActive) {
      state.completedRealToolResultBatch = false;
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(state.turnRequestState, recallEntry ? [recallEntry] : []);
    }

    // 原生 compact（microcompact / autoCompact / rapid-refill 熔断）由 magic-context
    // 插件接管，fork 已整体移除，不再调用上游的压缩链路。
    // FORK: 上游 beginLocalTurnPreparation 的本地 TTFT 遥测阶段随遥测面整体移除，
    // 这里不再标记 mcp / tools 准备阶段。
    await this.initializeMcp(state.turnTraceContext);
    // tools/list_changed 只在回合开始前生效。
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    throwIfTurnAborted(state.turnAbortSignal);
    const candidateTools = getTurnTools(this, state);
    // FORK: 无值班次轮的主信号是 toolDisallowlist 里的 SendMessage 哨兵；命中后必须把
    // UNATTENDED_DISPATCH_DENIED_TOOL_NAMES 整套补齐（上游 getTurnTools 只按 denylist 原样过滤）。
    const unattendedDeniedTools = new Set<string>(UNATTENDED_DISPATCH_DENIED_TOOL_NAMES);
    const tools = isUnattendedDispatchTurn(state)
      ? candidateTools.filter((tool) => !unattendedDeniedTools.has(tool.name))
      : candidateTools;
    if (!outputTokenRecoveryActive) {
      await appendRuntimeAgentListing(this, state.turnRequestState, tools, state.turnTraceContext);
    }
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    if (!outputTokenRecoveryActive) {
      const announcement = buildToolSearchAnnouncement({
        model: state.model,
        mode: this.config.toolSearch?.mode,
        tools,
        registry: this.getToolRegistry(),
        entries: state.turnRequestState.entries,
      });
      if (announcement) {
        // 公告正文和增量事实必须先一起落盘；否则 fork/resume 会把已公告工具重新当成首次出现。
        const messageId = await persistRuntimeReminderMessage.call(
          this,
          announcement,
          state.turnTraceContext,
          {
            model: state.model,
            anchor: buildProjectionAnchor(state.turnTraceContext, "synthetic"),
          },
        );
        if (messageId) this.latestConversationMessageId = messageId;
        commitTurnRequestEntries(this, state.turnRequestState, [announcement]);
      }
    }
    // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
    // 一律走 ui/update-model-context。
    const providerEntries = [...state.turnRequestState.entries];
    // Step 19b：magic-context transform 前置到双投影之前——messages 与
    // recordedMessages 同源于 requestEntries，transform 在投影前跑一次，两条投影
    // 因此必然看到同一份字节（否则 m[0]/m[1] 与 drop 只进其中一条）。
    // flag off 时装配层不注入端口，这里是纯判空，行为与 Phase 1 逐行等价。
    const magicContextEntries = await runMagicContextTurnTransform(
      this,
      {
        entries: providerEntries,
        model: state.model,
        sessionId: this.sessionId,
        workingDirectory: this.workspaceRoot,
      },
      traceContextToLogContext(state.turnTraceContext),
    );
    // Dream 可能在同一 turn 的首个模型请求期间完成；每次 attachment collection 都检查，
    // 才能把一次性更新放进紧随其后的模型请求，而不是延迟到下一次用户输入。
    const memoryUpdate = outputTokenRecoveryActive
      ? undefined
      : consumePendingProjectMemoryUpdate(this);
    const requestEntries = memoryUpdate
      ? [...magicContextEntries, memoryUpdate]
      : magicContextEntries;
    const prepared = prepareRuntimeProviderRequest(this, {
      model: state.model,
      tools,
      registry: this.getToolRegistry(),
      entries: requestEntries,
      applyCacheControl: true,
    });
    this.logger?.debug("ToolSearch request exposure", {
      event: "tool.search.exposure",
      enabled: prepared.toolSearch.enabled,
      mode: prepared.toolSearch.mode,
      reason: prepared.reason,
      catalogSize: prepared.toolSearch.catalog.length,
      schemaCount: prepared.request.tools.length,
    });
    // 修复原因：provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = prepared.projection;
    const { messages } = prepared.request;
    const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
    const recordableProjection =
      recordableEntries === prepared.entries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            loadedToolCallIds: prepared.loadedToolCallIds,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: prepared.request.tools,
      toolSearch: prepared.toolSearch,
    });

    if (result === "break") {
      break;
    }
  }
}
