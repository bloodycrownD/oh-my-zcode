import { createMessageId, traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import { buildToolExposure, buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  runMagicContextTurnTransform,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  isAutomationMutationRestrictedTurn,
  isUnattendedDispatchTurn,
  UNATTENDED_DISPATCH_DENIED_TOOL_NAMES,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
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

    await this.initializeMcp(state.turnTraceContext);
    throwIfTurnAborted(state.turnAbortSignal);
    const turnDisallowedTools = buildTurnDisallowedTools(state);
    // automation 派发到已 active 会话或重试恢复时，入口 metadata 可能没有带到
    // loop state；但 queryId 仍是 automation-*。provider 请求边界必须按 queryId 再硬过滤
    // automation 写工具，否则模型会先看到并创建、修改或删除任务定义。
    const tools = state.automationCreateLimitReached
      ? []
      : turnDisallowedTools
        ? this.getTools(state.model).filter((tool) => !turnDisallowedTools.has(tool.name))
        : this.getTools(state.model);
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
    const providerEntries = [...state.turnRequestState.entries];
    // ── phase-toolsearch 插入缝（落地序与等价性证明见
    // docs/iterations/upstream-v316-fullsync/toolsearch-seam-proof.md）──
    // 落地序=「工具暴露决策 → 公告提交 → MC transform → 双投影」。与 spec 预定序
    // （MC 在前）的偏差是推演反例决定的：MC 正投影会把 role:"tool" 的块数组文本化、
    // tool_reference 块直接丢失，暴露决策若在 MC 之后跑，local 模式的定义展开永不发生。
    // 暴露决策读 canonical entries（块完整），展开后的 text 块经 MC 文本化仍存活。
    // mode off（omz 默认）时 buildToolExposure 为恒等、无公告，本缝与改动前逐字节等价。
    const toolExposure = buildToolExposure({
      model: state.model,
      mode: this.config.toolSearch?.mode,
      tools,
      registry: this.registry,
      entries: providerEntries,
    });
    if (this.logger !== undefined) {
      this.logger.debug("ToolSearch request exposure", {
        ...traceContextToLogContext(state.turnTraceContext),
        event: "tool.search.exposure",
        module: "core.runtime",
        enabled: toolExposure.enabled,
        mode: toolExposure.context.mode,
        reason: toolExposure.reason,
        catalogSize: toolExposure.context.catalog.length,
      });
    }
    let toolSearchAnnouncement: RuntimeMessageEntry | undefined;
    if (!outputTokenRecoveryActive) {
      toolSearchAnnouncement = buildToolSearchAnnouncement({
        model: state.model,
        mode: this.config.toolSearch?.mode,
        tools,
        registry: this.registry,
        entries: providerEntries,
      });
      // 公告与上游混入物 persistRuntimeReminderMessage 不同：只 commit 进内存
      // turnRequestState（下一轮公告 delta 扫描的事实源），不落 session、不进 hydrator。
      if (toolSearchAnnouncement) {
        commitTurnRequestEntries(this, state.turnRequestState, [toolSearchAnnouncement]);
      }
    }
    // Step 19b：magic-context transform 前置到双投影之前——messages 与
    // recordedMessages 同源于 requestEntries，transform 在投影前跑一次，两条投影
    // 因此必然看到同一份字节（否则 m[0]/m[1] 与 drop 只进其中一条）。
    // flag off 时装配层不注入端口，这里是纯判空，行为与 Phase 1 逐行等价。
    const requestEntries = await runMagicContextTurnTransform(
      this,
      {
        entries: toolSearchAnnouncement
          ? [...toolExposure.entries, toolSearchAnnouncement]
          : toolExposure.entries,
        model: state.model,
        sessionId: this.sessionId,
        workingDirectory: this.workspaceRoot,
      },
      traceContextToLogContext(state.turnTraceContext),
    );
    // provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = buildRuntimeProviderRequestMessages(this, {
      entries: requestEntries,
      applyCacheControl: true,
      model: state.model,
      loadedToolCallIds: toolExposure.loadedToolCallIds,
    });
    const { messages } = providerProjection;
    const recordableEntries = filterOutputTokenContinuationEntries(requestEntries);
    const recordableProjection =
      recordableEntries === requestEntries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            applyCacheControl: true,
            model: state.model,
            loadedToolCallIds: toolExposure.loadedToolCallIds,
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
      tools: toolExposure.tools,
      toolSearchEnabled: toolExposure.context.mode === "native",
      toolSearch: toolExposure.context,
    });

    if (result === "break") {
      break;
    }
  }
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (isUnattendedDispatchTurn(state)) {
    // 无值班次执行轮禁止在 modelExecution 之外另起子 Agent/子会话。
    // 注意 automation 执行轮不进此分支——cron turn 的工具面隔离由上面的分支单独裁决。
    for (const toolName of UNATTENDED_DISPATCH_DENIED_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
