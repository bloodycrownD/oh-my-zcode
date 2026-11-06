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
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolExecutionResult,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
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
import { snapshotPermissionInput } from "./permission-input.js";
import { applyPermissionInputAdjustments } from "./permission-input-adjustments.js";
import { validatePermissionResponse } from "./permission-response.js";
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
import { maxRisk } from "../../permission/risk.js";

type ToolPermissionFlowResult =
  | {
      allowed: true;
      executionInput: unknown;
      permissionWaitMs?: number;
      /** 确认窗里的调整中实际生效的那部分（applyPermissionInputAdjustments 的 applied）。 */
      inputAdjustments?: Readonly<Record<string, unknown>>;
    }
  | { allowed: false; result: ToolExecutionResult };

// 本 fork 的确认流程：doom-loop 门 + permission-responder-race + persistProjectPermissionUpdates，
// 已并入上游 v3.16 的重入语义（approvalMode "user-once" 单次确认、登记后发布事件、
// applyPermissionInputAdjustments）。重入只发生一次：hook 改写输入后重问一轮、该轮不再问 hook。
export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
  /** 上游 v3.16 新增：已经准备好的运行时权限上下文（Guarded 下带已快照的 cwd）。 */
  preparedContext?: ToolRuntimePermissionCapabilityContext,
): Promise<ToolPermissionFlowResult> {
  const permissionContext: PermissionContext = {
    toolName: toolCall.name,
    input: executionInput,
    riskLevel: entry.metadata.riskLevel,
    mode,
    prePlanMode: deps.sessionModePort?.getPrePlanMode(),
    planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
    // workflow 草稿免确认要按工作目录解析相对路径，见 PermissionService 的
    // isPreapprovedWorkflowDraftWrite。Guarded 下沿用 caller 已快照的 cwd。
    workingDirectory: preparedContext?.workingDirectory ?? deps.getWorkingDirectory(),
  };
  // 判权上下文只能有一个构造点：caller 备好的 preparedContext（含 bashShellSelection 与
  // guarded 的 cwd 快照）优先，缺项用 deps 兜底；首次判权、重判与事件都用这一份。
  const runtimePermissionContext: ToolRuntimePermissionCapabilityContext = {
    ...resolveRuntimePermissionContext(deps),
    ...preparedContext,
  };
  const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, runtimePermissionContext);
  // 重问轮会按改写后的输入重算这一份（见下方 raced.suggestedPermissionUpdates），
  // 否则「始终允许」会把被 hook 拦下的原始命令写进项目规则。
  let suggestedPermissionUpdates =
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
    workingDirectory: preparedContext?.workingDirectory ?? deps.getWorkingDirectory(),
    workspaceRoot: preparedContext?.workspaceRoot ?? deps.getWorkspaceRoot(),
  });

  // Doom loop 门（opencode 式）：同工具+同输入重复调用的第 4 次（事不过三，
  // 容忍 3 次；软提醒在第 3 次）在执行前拦截。
  // deny → 带停轮标记的错误结果（调用不执行）；ask → decision 改写为 doom_loop ask，
  // 走下方既有确认窗/broker/hook-race 链路；off/豁免/未达阈值 → 放行。
  const doom = deps.doomLoop
    ? interveneDoomLoopGate(
        deps.doomLoop,
        deps.doomLoopCheck ?? "ask",
        toolCall,
        executionInput,
        mode,
        permissionDecision.approvalMode,
      )
    : null;
  if (doom?.verdict === "deny" && doom.deniedResult) {
    return { allowed: false, result: doom.deniedResult };
  }
  const doomLoopActive = doom?.verdict === "ask";
  if (doom?.verdict === "ask" && doom.askDecision) {
    // 合并而不是整体覆盖：doom ask 只是把结论改成「再问一次」，不能顺手丢掉 guarded
    // 已经算好的单次确认（approvalMode）、选项策略与副作用域，也不能把 riskLevel 降级
    // （doom 自报 medium，危险命令本是 high）。ruleId/reason 取 doom 的新值。
    // 与 N1 的边界：合并后仍是 user-once 的 doom ask 只提供「允许一次 / 拒绝」，
    // 不适用会话级豁免——应答一旦夹带 sessionPermissionUpdates 就会被单次确认校验判非法。
    permissionDecision = {
      ...permissionDecision,
      ...doom.askDecision,
      riskLevel: maxRisk(permissionDecision.riskLevel, doom.askDecision.riskLevel),
      ...(permissionDecision.approvalMode
        ? { approvalMode: permissionDecision.approvalMode }
        : {}),
      ...(permissionDecision.optionsPolicy
        ? { optionsPolicy: permissionDecision.optionsPolicy }
        : {}),
      ...(permissionDecision.sideEffectScope
        ? { sideEffectScope: permissionDecision.sideEffectScope }
        : {}),
    };
  }

  deps.logger?.debug("Tool permission evaluated", {
    ...traceContextToLogContext(traceContext),
    approvalMode: permissionDecision.approvalMode,
    decision: permissionDecision.decision,
    event: "tool.permission.evaluated",
    inputSummary: summarizeInput(toolCall.input),
    mode,
    module: "core.tool.executor",
    optionsPolicy: permissionDecision.optionsPolicy,
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

  const approval = resolveToolApproval(
    deps,
    toolCall,
    entry,
    executionInput,
    traceContext,
    permissionDecision.optionsPolicy,
    permissionDecision.approvalMode === "user-once",
  );
  if (approval.gate === "proceed") {
    return { allowed: true, executionInput };
  }

  const requestIdFor = () => `perm_${crypto.randomUUID()}`;
  let requestId = requestIdFor();

  let brokerResult: PermissionBrokerResult;
  let normalizedHookModifiedInput: unknown;
  let useNormalizedHookModifiedInput = false;
  // 这一轮确认窗是否真的发布过 PermissionRequested：只有发布过才补 PermissionResolved，
  // 否则入口即取消 / 登记失败会留下一条没有前驱的孤立终态事件。
  let requestedEmitted = false;
  const permissionWaitStartedAt = Date.now();
  // 重入：hook 把输入改写成仍需审批的内容时，不能拿改写前的批准去执行改写后的输入。
  // 这里关掉旧请求、按新输入重新走一次确认窗（新 requestId）。
  // 只重问一次：重问轮 skipHooks，hook 不会再表态、也就不可能再产出改写，循环必然收敛，
  // 因此不需要次数上限（旧的 MAX_PERMISSION_REENTRIES 分支永远不可达）。
  let askInput = executionInput;
  let askDecision = permissionDecision;
  let askApproval = approval;
  let reentry = false;
  for (;;) {
    requestedEmitted = false;
    try {
      // hook 链与 broker 并发竞速（内芯见 permission-responder-race.ts——串行 hook
      // 曾致确认窗点击全部被幂等丢弃的死亡路径注释在那里）。
      const raced = await runPermissionAskRace({
        deps,
        toolCall,
        entry,
        executionInput: askInput,
        permissionDecision: askDecision,
        suggestedPermissionUpdates,
        approval: askApproval,
        requestId,
        mode,
        projectRules,
        traceContext,
        permissionContext: runtimePermissionContext,
        // 重问轮不再问 hook：它上一轮已经把输入改写成现在这份，再问只会得到同一个改写。
        skipHooks: reentry,
        // 确认窗第一次可见的时刻是 broker 登记完应答方之后；事件在这里发，
        // 用户点得快也不会点在尚未登记的请求上。
        onBrokerRegistered: async () => {
          await emitPermissionRequested(
            deps,
            toolCall,
            askInput,
            requestId,
            askDecision.riskLevel,
            askDecision.reason,
            suggestedPermissionUpdates,
            traceContext,
            {
              ...askApproval,
              // 事件侧也要带上 approvalMode：只带 optionsPolicy 的话 UI/投影仍会给
              // 「始终允许 / Full access」，用户点了会得到 InvalidInput。
              ...(askDecision.approvalMode ? { approvalMode: askDecision.approvalMode } : {}),
            },
          );
          // 发布成功才算「确认窗出现过」：发布失败时补终态只会留下孤立 Resolved。
          requestedEmitted = true;
        },
        ...(signal === undefined ? {} : { signal }),
      });
      if (raced.rewriteInput !== undefined) {
        const nextRequestId = requestIdFor();
        deps.logger?.debug("Permission hook rewrote the input; asking again", {
          ...traceContextToLogContext(traceContext),
          event: "tool.permission.reentry",
          module: "core.tool.executor",
          newRequestId: nextRequestId,
          requestId,
          ruleId: raced.permissionDecision.ruleId,
          status: "waiting",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
        // 只有确认窗真的出现过才发配对终态；否则就是一个没有前驱的孤立
        // PermissionResolved（contracts reducer 会把工具行错置成 denied）。
        if (requestedEmitted) {
          await emitPermissionResolved(
            deps,
            toolCall,
            requestId,
            {
              decision: "deny",
              reason: "Input was rewritten by a hook; asking again for the rewritten input",
              resolvedAt: new Date(),
            },
            traceContext,
          );
        }
        askInput = raced.rewriteInput;
        // 改写后要重算「始终允许」的落盘建议：沿用改写前的那份会把被 hook 拦下的
        // 原始命令永久写进项目规则。字段缺省时保留入口算出的默认值。
        if (raced.suggestedPermissionUpdates !== undefined) {
          suggestedPermissionUpdates = raced.suggestedPermissionUpdates;
        }
        askDecision = raced.permissionDecision;
        askApproval = resolveToolApproval(
          deps,
          toolCall,
          entry,
          askInput,
          traceContext,
          askDecision.optionsPolicy,
          askDecision.approvalMode === "user-once",
        );
        requestId = nextRequestId;
        reentry = true;
        continue;
      }
      brokerResult = raced.brokerResult;
      normalizedHookModifiedInput = raced.normalizedHookModifiedInput;
      useNormalizedHookModifiedInput = raced.useNormalizedHookModifiedInput;
      permissionDecision = raced.permissionDecision;
      break;
    } catch (error) {
      const coreError = isCoreError(error)
        ? error
        : createCoreError(CoreErrorType.ToolExecutionFailed, "Permission request failed", {
            // broker 故障（桥接程序挂了、反向 RPC 断了）是基础设施错误，不能报成"用户拒绝"：
            // 模型会以为用户不批，UI 也会显示错误的拒绝理由。
            cause: error instanceof Error ? error : undefined,
            context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
            recoverable: true,
          });
      // 权限层的 catch 会把 broker 故障转成工具失败；不记日志的话，
      // 「基础设施挂了」与「用户拒绝」在权限日志里无法区分。
      deps.logger?.warn("Permission request failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: coreError.message,
        event: "tool.permission.request_failed",
        mode,
        module: "core.tool.executor",
        requestId,
        status: "failed",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      if (requestedEmitted) {
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
      }
      // Doom ask 无权限客户端/超时/故障：降级为拒绝；带停轮标记（防子代理死锁的
      // opencode #18108 教训——ask 永远不会有人应答时不悬挂）。
      const brokerFailedResult = createErrorResult(toolCall, coreError);
      return {
        allowed: false,
        result: doomLoopActive ? withDoomLoopTurnStop(brokerFailedResult) : brokerFailedResult,
      };
    }
  }

  const resolvedPermission = {
    ...brokerResult,
    resolvedAt: brokerResult.resolvedAt ?? new Date(),
  };
  // 应答形状校验的真正保护对象是「单次确认」和「这次不提供始终允许」，不是 guarded 这个
  // 模式本身：将来任何路径产出 user-once / no-always-allow 都必须过同一道闸门。
  const singleUse = isSingleUseDecision(permissionDecision);
  // 取更严者：askApproval.optionsPolicy 已经过工具声明与判定策略的收敛，但仍显式带上判定侧的
  // no-always-allow（Plan-MCP），避免只看一边漏掉工具级声明。
  const noAlwaysAllow =
    askApproval.optionsPolicy === "no-always-allow" ||
    permissionDecision.optionsPolicy === "no-always-allow";
  // no-always-allow 的 ask 在非 guarded 模式（Plan-MCP、工具级 allowAlways:false）下同样
  // 不允许应答夹带项目规则：只按 mode/singleUse 进门会让第三参成为死代码，TUI 仍能把规则永久写盘。
  if (mode === "guarded" || singleUse || noAlwaysAllow) {
    try {
      validatePermissionResponse(resolvedPermission, singleUse, { noAlwaysAllow });
    } catch (error) {
      const coreError = isCoreError(error)
        ? error
        : createCoreError(CoreErrorType.PermissionDenied, "Permission response rejected", {
            cause: error instanceof Error ? error : undefined,
            context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
            recoverable: true,
          });
      await emitPermissionResolved(
        deps,
        toolCall,
        requestId,
        { decision: "deny", reason: coreError.message, resolvedAt: new Date() },
        traceContext,
      );
      return { allowed: false, result: createErrorResult(toolCall, coreError) };
    }
  }
  const permissionWaitMs = Math.max(0, Math.round(Date.now() - permissionWaitStartedAt));
  await emitPermissionResolved(deps, toolCall, requestId, resolvedPermission, traceContext);
  // Doom ask 获允许且带「本会话总是允许」更新：登记会话级豁免，该工具不再触发门。
  // 入参就是 broker 合成的 PermissionUpdate[]（`{type:"addRules", behavior, rules}`），
  // 旧代码按 ruleId/decision/effect 猜字段导致谓词恒 false（豁免死代码），已按真实形状判定。
  if (doomLoopActive && deps.doomLoop && resolvedPermission.decision === "allow") {
    applyDoomLoopSessionUpdates(
      deps.doomLoop,
      toolCall.name,
      resolvedPermission.sessionPermissionUpdates,
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

  // guarded 下 broker 带回 modifiedInput 就按改写执行（不要求 decision 一定是 modify）：
  // 用户是照着确认窗里的新输入点的允许，再用旧输入执行就等于点了个寂寞。
  const brokerModifiedInput =
    resolvedPermission.decision === "modify" ||
    (mode === "guarded" && resolvedPermission.modifiedInput !== undefined);
  const approvedInput = brokerModifiedInput
    ? useNormalizedHookModifiedInput
      ? normalizedHookModifiedInput
      : normalizeToolExecutionInput({
          entry,
          input: resolvedPermission.modifiedInput ?? askInput,
          logger: deps.logger,
          source: "permission",
        })
    : useNormalizedHookModifiedInput
      ? normalizedHookModifiedInput
      : askInput;

  // 只有 broker 交回来的那份是"原始形状"的输入，能按 schema 再验一次；放行路径上的
  // executionInput 已经是工具 resolveInput 产出的解析结果，拿原始 schema 复核只会误判。
  if (brokerModifiedInput) {
    const approvedInputValidation = validateInput(approvedInput, entry);
    if (approvedInputValidation) {
      return {
        allowed: false,
        result: createErrorResult(toolCall, approvedInputValidation),
      };
    }
  }
  // 快照：handler 拿到的是冻结副本，事后谁再改这个对象都影响不到已批准的那份输入。
  const settledInput =
    brokerModifiedInput && mode === "guarded" ? snapshotPermissionInput(approvedInput) : approvedInput;

  // 确认窗里改过的设置（模型/并发上界等）：批准之后、handler 之前由工具自己落进入参。
  const adjusted = applyPermissionInputAdjustments({
    deps,
    entry,
    toolCall,
    executionInput: settledInput,
    adjustments: resolvedPermission.inputAdjustments,
    traceContext,
  });
  if (!adjusted.ok) return { allowed: false, result: adjusted.result };

  return {
    allowed: true,
    executionInput: adjusted.executionInput,
    permissionWaitMs,
    ...(adjusted.applied === undefined ? {} : { inputAdjustments: adjusted.applied }),
  };
}

/**
 * 单次确认（user-once）：审批只对这一次执行有效，应答里不能夹带任何规则。
 * 抽成谓词供应答校验与测试共用——判据是语义（approvalMode）而不是「当前在哪个模式」。
 */
export function isSingleUseDecision(decision: { approvalMode?: "user-once" }): boolean {
  return decision.approvalMode === "user-once";
}
