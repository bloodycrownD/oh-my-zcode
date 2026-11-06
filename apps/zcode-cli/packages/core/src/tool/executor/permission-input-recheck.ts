import {
  type CollaborationMode,
  type PermissionRuleset,
  type PermissionUpdate,
} from "@zcode/contracts";

import type { PermissionDecisionResult, PermissionContext } from "../../permission/service.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { applyMemoryFilePermission, targetsMemoryFile } from "./memory-file-permission.js";
import { resolveRuntimePermissionCapability } from "./permission-capability.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";

export interface PermissionHookInputRecheckResult {
  permissionDecision?: PermissionDecisionResult;
  /**
   * 按改写后的输入重算的「始终允许」落盘建议。仅 ask 分支返回：重问轮的确认窗要展示
   * 并落盘改写后的命令，不能沿用入口按原始输入算出的那份（否则会把被 hook 拦下的
   * 危险原文永久写进项目规则）。
   */
  suggestedPermissionUpdates?: PermissionUpdate[];
}

export function recheckPermissionHookModifiedInput(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  mode: CollaborationMode;
  modifiedInput: unknown;
  projectRules: PermissionRuleset | null;
  toolCall: ExecutableToolCall;
  /** 与首次判权同一份上下文（mode、bashShellSelection、cwd 快照），由 executor 构造并透传。 */
  context: ToolRuntimePermissionCapabilityContext & {
    workingDirectory: string;
    workspaceRoot: string;
  };
}): PermissionHookInputRecheckResult {
  // 根因（2026-09-17 review）：此前在此重新构造只含 runtimeScope/cwd 的缩减上下文，丢掉 mode 与
  // bashShellSelection；一旦 guarded 复用重判路径，matcher 会静默失效。上下文只能有一个构造点。
  const { context: runtimePermissionContext } = input;
  const { workingDirectory, workspaceRoot } = runtimePermissionContext;
  const permissionContext: PermissionContext = {
    input: input.modifiedInput,
    mode: input.mode,
    prePlanMode: input.deps.sessionModePort?.getPrePlanMode(),
    planEnabled: input.deps.sessionModePort?.isPlanEnabled?.(),
    riskLevel: input.entry.metadata.riskLevel,
    toolName: input.toolCall.name,
    // 与首次判定同源：hook 改过 input 之后，草稿免确认仍要按同一个工作目录复核。
    workingDirectory,
  };
  const rulePolicy = input.entry.resolvePermissionRulePolicy?.(
    input.modifiedInput,
    runtimePermissionContext,
  );
  let decision = input.deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(input.entry, input.modifiedInput, runtimePermissionContext),
    input.projectRules,
    rulePolicy,
  );
  decision = applyMemoryFilePermission({
    decision,
    executionInput: input.modifiedInput,
    memoryRoot: input.deps.getMemoryRoot?.(),
    toolName: input.toolCall.name,
    workingDirectory,
    workspaceRoot,
  });

  if (decision.decision === "deny") {
    return {
      permissionDecision: decision,
    };
  }
  // 改写后的输入仍需审批时，只有"hook 无权替你点头"的那几类要把结论交回去重新问：
  // 项目 ask 规则、Memory 目标，以及 guarded 的危险命令单次确认（user-once）。
  // 普通模式 ask（如 build 的 sideEffect）沿用旧语义：PermissionRequest hook 的
  // allow + 改写就是这次审批的答复，不再多弹一次窗。
  if (
    decision.decision !== "ask" ||
    (decision.approvalMode !== "user-once" &&
      decision.ruleId !== "rule.project.ask" &&
      !targetsMemoryFile({
        executionInput: input.modifiedInput,
        memoryRoot: input.deps.getMemoryRoot?.(),
        toolName: input.toolCall.name,
        workingDirectory,
        workspaceRoot,
      }))
  ) {
    return {};
  }

  // 仅返回旧模式需要保留的策略事实；请求登记/发布/终态全部由 executor 统一处理。
  // 落盘建议按**改写后**的输入重算（与首次判权同一表达式，含 buildDefaultPermissionUpdates
  // 兜底），重问轮用它替换入口按原始输入算出的那份。
  return {
    permissionDecision: decision,
    suggestedPermissionUpdates:
      rulePolicy?.suggestedPermissionUpdates ??
      buildDefaultPermissionUpdates(
        input.toolCall.name,
        input.modifiedInput,
        input.entry.permissionCapabilityGroup,
      ),
  };
}
