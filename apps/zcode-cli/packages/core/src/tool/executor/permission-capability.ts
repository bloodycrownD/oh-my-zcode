import type { ModelToolSideEffectScope } from "@zcode/contracts";
import type { PermissionToolCapability } from "../../permission/service.js";
import type { ToolEntry, ToolRuntimePermissionCapabilityContext } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

export function resolveRuntimePermissionCapability(
  entry: ToolEntry,
  input: unknown,
  context: ToolRuntimePermissionCapabilityContext,
): PermissionToolCapability {
  const runtimeCapability = entry.resolvePermissionCapability?.(input, context);
  return {
    ...entry.metadata,
    ...runtimeCapability,
    // capability group is provenance, not a runtime/model-controlled override.
    permissionCapabilityGroup: entry.permissionCapabilityGroup,
    permission: {
      ...entry.permission,
      ...runtimeCapability?.permission,
    },
  };
}

/**
 * 一次调用**解析后**的副作用旗标，挂在 `ToolCallStarted` 上：与权限判定同一次解析，所以 Bash 的只读命令判定等运行时结论一并生效。
 * 订阅者（dynamic-workflow 的 driver）据它在 handler 动手之前判断这一笔是否会改写工作区。
 */
export function resolveToolCallCapabilityFlags(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  input: unknown,
): { readOnly?: boolean; sideEffectScope?: ModelToolSideEffectScope } {
  const capability = resolveRuntimePermissionCapability(
    entry,
    input,
    resolveRuntimePermissionContext(deps),
  );
  return { readOnly: capability.readOnly, sideEffectScope: capability.sideEffectScope };
}

export function resolveRuntimePermissionContext(
  deps: ToolExecutorDeps,
): ToolRuntimePermissionCapabilityContext {
  return {
    // 工具的运行时能力判定要按当前模式分叉：Bash 的 guarded 危险命令单次确认
    // （resolveBashPermissionCapability 的 `context?.mode === "guarded"`）与只读判定
    // 都靠这里。缺了 mode 会让 guarded 静默退回 YOLO——危险命令直接执行、不弹确认。
    mode: deps.getMode(),
    // 静态声明与 getter 并存：只声明 bashShellSelection 的 createToolExecutor 用法
    // 此前会退回 POSIX 文法（Windows 的 rd /S /Q、del /Q 匹配不到危险规则 → 直接放行）。
    bashShellSelection: deps.getBashShellSelection?.() ?? deps.bashShellSelection,
    runtimeScope: deps.runtimeScope,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  };
}
