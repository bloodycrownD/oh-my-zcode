import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionContext } from "../../permission/service.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import { resolveToolApproval } from "./approval-gate.js";
import {
  applyDoomLoopSessionUpdates,
  interveneDoomLoopGate,
  withDoomLoopTurnStop,
} from "./doom-loop-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionRequested, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision } from "./hook-flow.js";
import { runPermissionAskRace } from "./permission-responder-race.js";
import {
  loadProjectPermissionRuleset,
  persistProjectPermissionUpdates,
} from "./permission-rules-persistence.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";
import { validateInput } from "./validation.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";

type ToolPermissionFlowResult =
  | { allowed: true; executionInput: unknown; permissionWaitMs?: number }
  | { allowed: false; result: ToolExecutionResult };

export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<ToolPermissionFlowResult> {
  const permissionContext: PermissionContext = {
    toolName: toolCall.name,
    input: executionInput,
    riskLevel: entry.metadata.riskLevel,
    mode,
    prePlanMode: deps.sessionModePort?.getPrePlanMode(),
    planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
    // workflow 草稿免确认要按工作目录解析相对路径，见 PermissionService 的
    // isPreapprovedWorkflowDraftWrite。
    workingDirectory: deps.getWorkingDirectory(),
  };
  const runtimePermissionContext = resolveRuntimePermissionContext(deps);
  const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, runtimePermissionContext);
  const suggestedPermissionUpdates =
    rulePolicy?.suggestedPermissionUpdates ??
    buildDefaultPermissionUpdates(toolCall.name, executionInput, entry.permissionCapabilityGroup);

  let projectRules: PermissionRuleset | null;
  try {
    projectRules = await loadProjectPermissionRuleset(deps);
  } catch (error) {
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to load project permission rules", {
          cause: error instanceof Error ? error : undefined,
          context: { sessionId: deps.sessionId, toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: true,
        }),
      ),
    };
  }

  let permissionDecision = deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(entry, executionInput, runtimePermissionContext),
    projectRules,
    rulePolicy,
  );
  permissionDecision = applyPreToolPermissionDecision(permissionDecision, preToolHookResult, mode);
  permissionDecision = applyMemoryFilePermission({
    decision: permissionDecision,
    executionInput,
    memoryRoot: deps.getMemoryRoot?.(),
    toolName: toolCall.name,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  });

  // Doom loop 门（opencode 式）：同工具+同输入重复调用的第 4 次（事不过三，
  // 容忍 3 次；软提醒在第 3 次）在执行前拦截。
  // deny → 带停轮标记的错误结果（调用不执行）；ask → decision 改写为 doom_loop ask，
  // 走下方既有确认窗/broker/hook-race 链路；off/豁免/未达阈值 → 放行。
  const doom = deps.doomLoop
    ? interveneDoomLoopGate(deps.doomLoop, deps.doomLoopCheck ?? "ask", toolCall, executionInput, mode)
    : null;
  if (doom?.verdict === "deny" && doom.deniedResult) {
    return { allowed: false, result: doom.deniedResult };
  }
  const doomLoopActive = doom?.verdict === "ask";
  if (doom?.verdict === "ask" && doom.askDecision) permissionDecision = doom.askDecision;

  deps.logger?.debug("Tool permission evaluated", {
    ...traceContextToLogContext(traceContext),
    decision: permissionDecision.decision,
    event: "tool.permission.evaluated",
    inputSummary: summarizeInput(toolCall.input),
    mode,
    module: "core.tool.executor",
    reason: permissionDecision.reason,
    riskLevel: permissionDecision.riskLevel,
    ruleId: permissionDecision.ruleId,
    sideEffectScope: permissionDecision.sideEffectScope,
    status:
      permissionDecision.decision === "allow"
        ? "completed"
        : permissionDecision.decision === "ask"
          ? "waiting"
          : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  if (permissionDecision.allowed) {
    return { allowed: true, executionInput };
  }

  if (permissionDecision.decision === "deny") {
    await emitPermissionDenied(deps, toolCall, permissionDecision.reason, traceContext);

    deps.logger?.warn("Tool permission denied", {
      ...traceContextToLogContext(traceContext),
      decision: permissionDecision.decision,
      event: "tool.permission.denied",
      mode,
      module: "core.tool.executor",
      reason: permissionDecision.reason,
      ruleId: permissionDecision.ruleId,
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return {
      allowed: false,
      result: createPermissionErrorResult(toolCall, permissionDecision.reason, {
        decision: permissionDecision.decision,
        mode,
        ruleId: permissionDecision.ruleId,
      }),
    };
  }

  const approval = resolveToolApproval(deps, toolCall, entry, executionInput, traceContext);
  if (approval.gate === "proceed") {
    return { allowed: true, executionInput };
  }

  const requestId = `perm_${crypto.randomUUID()}`;
  await emitPermissionRequested(
    deps,
    toolCall,
    executionInput,
    requestId,
    permissionDecision.riskLevel,
    permissionDecision.reason,
    suggestedPermissionUpdates,
    traceContext,
    approval,
  );

  let brokerResult: PermissionBrokerResult;
  let normalizedHookModifiedInput: unknown;
  let useNormalizedHookModifiedInput = false;
  const permissionWaitStartedAt = Date.now();
  try {
    // hook 链与 broker 并发竞速（内芯见 permission-responder-race.ts——串行 hook
    // 曾致确认窗点击全部被幂等丢弃的死亡路径注释在那里）。
    const raced = await runPermissionAskRace({
      deps,
      toolCall,
      entry,
      executionInput,
      permissionDecision,
      suggestedPermissionUpdates,
      approval,
      requestId,
      mode,
      projectRules,
      traceContext,
      ...(signal === undefined ? {} : { signal }),
    });
    brokerResult = raced.brokerResult;
    normalizedHookModifiedInput = raced.normalizedHookModifiedInput;
    useNormalizedHookModifiedInput = raced.useNormalizedHookModifiedInput;
    permissionDecision = raced.permissionDecision;
  } catch (error) {
    const coreError = isCoreError(error)
      ? error
      : createCoreError(CoreErrorType.PermissionDenied, "Permission request failed", {
          cause: error instanceof Error ? error : undefined,
          context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: true,
        });
    await emitPermissionResolved(
      deps,
      toolCall,
      requestId,
      {
        decision: "deny",
        reason: coreError.message,
        resolvedAt: new Date(),
      },
      traceContext,
    );
    // Doom ask 无权限客户端/超时/故障：降级为拒绝；带停轮标记（防子代理死锁的
    // opencode #18108 教训——ask 永远不会有人应答时不悬挂）。
    const brokerFailedResult = createErrorResult(toolCall, coreError);
    return {
      allowed: false,
      result: doomLoopActive ? withDoomLoopTurnStop(brokerFailedResult) : brokerFailedResult,
    };
  }

  const resolvedPermission = {
    ...brokerResult,
    resolvedAt: brokerResult.resolvedAt ?? new Date(),
  };
  const permissionWaitMs = Math.max(0, Math.round(Date.now() - permissionWaitStartedAt));
  await emitPermissionResolved(deps, toolCall, requestId, resolvedPermission, traceContext);
  // Doom ask 获允许且带「本会话总是允许」更新：登记会话级豁免，该工具不再触发门。
  if (doomLoopActive && deps.doomLoop && resolvedPermission.decision === "allow") {
    applyDoomLoopSessionUpdates(
      deps.doomLoop,
      toolCall.name,
      resolvedPermission.sessionPermissionUpdates as never,
    );
  }

  deps.logger?.info("Tool permission resolved", {
    ...traceContextToLogContext(traceContext),
    decision: resolvedPermission.decision,
    event: "tool.permission.resolved",
    mode,
    module: "core.tool.executor",
    reason: resolvedPermission.reason,
    requestId,
    status:
      resolvedPermission.decision === "allow" || resolvedPermission.decision === "modify"
        ? "completed"
        : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  if (resolvedPermission.decision === "deny") {
    const deniedResult = createPermissionErrorResult(
      toolCall,
      resolvedPermission.reason,
      {
        decision: resolvedPermission.decision,
        mode,
        reasonSource: resolvedPermission.reasonSource,
        requestId,
        ruleId: permissionDecision.ruleId,
      },
      resolvedPermission.preserveReasonFormatting
        ? { preserveReasonFormatting: true }
        : undefined,
    );
    // Doom ask 被用户拒绝：停整轮（用户拍板语义）。
    return {
      allowed: false,
      result: doomLoopActive ? withDoomLoopTurnStop(deniedResult) : deniedResult,
    };
  }

  if (resolvedPermission.decision === "escalate") {
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(
          CoreErrorType.PermissionEscalation,
          resolvedPermission.reason ?? `Permission escalation requested for ${toolCall.name}`,
          {
            context: {
              decision: resolvedPermission.decision,
              mode,
              requestId,
              ruleId: permissionDecision.ruleId,
              toolName: toolCall.name,
            },
            recoverable: true,
          },
        ),
      ),
    };
  }

  if (resolvedPermission.permissionUpdates?.length) {
    try {
      await persistProjectPermissionUpdates(
        deps,
        resolvedPermission.permissionUpdates,
        traceContext,
      );
    } catch (error) {
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(
            CoreErrorType.StorageError,
            "Failed to persist project permission update",
            {
              cause: error instanceof Error ? error : undefined,
              context: {
                requestId,
                sessionId: deps.sessionId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
              recoverable: true,
            },
          ),
        ),
      };
    }
  }

  if (resolvedPermission.sessionPermissionUpdates?.length) {
    // 会话免确认：只进内存里的会话 ruleset，
    // 与上面的项目级持久化互不可见。
    deps.permissionService.grantSessionPermission(resolvedPermission.sessionPermissionUpdates);
    deps.logger?.info("Session permission granted", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.session_grant.applied",
      module: "core.tool.executor",
      requestId,
      status: "completed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      updateCount: resolvedPermission.sessionPermissionUpdates.length,
    });
  }

  if (resolvedPermission.decision !== "modify") {
    return {
      allowed: true,
      executionInput: useNormalizedHookModifiedInput ? normalizedHookModifiedInput : executionInput,
      permissionWaitMs,
    };
  }

  const modifiedInput = useNormalizedHookModifiedInput
    ? normalizedHookModifiedInput
    : normalizeToolExecutionInput({
        entry,
        input: resolvedPermission.modifiedInput ?? executionInput,
        logger: deps.logger,
        source: "permission",
      });
  const modifiedInputValidation = validateInput(modifiedInput, entry);
  if (modifiedInputValidation) {
    return {
      allowed: false,
      result: createErrorResult(toolCall, modifiedInputValidation),
    };
  }
  return { allowed: true, executionInput: modifiedInput, permissionWaitMs };
}
