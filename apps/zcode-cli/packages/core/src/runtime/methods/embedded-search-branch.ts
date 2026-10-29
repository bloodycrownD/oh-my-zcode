import type { ModelToolContract } from "../deps.js";
import { registerBuiltInTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "../helpers/tool-allowlist.js";
import { resolveMagicContextPromptSurfaceOptions } from "../helpers/magic-context-tool-surface.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";

export function resolveRuntimeEmbeddedSearchEnabled(runtime: AgentRuntimeInternal): boolean {
  const builtInToolAllowlist = resolveBuiltInToolAllowlist(runtime.config);
  const decision = resolveEmbeddedSearchBranchCapability({
    bashAvailable:
      (builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash")) &&
      !isToolNameDisallowed("Bash", runtime.config.toolDisallowlist),
  });
  return decision.useEmbeddedSearchBranch;
}

export function refreshBranchAwareBuiltInTools(runtime: AgentRuntimeInternal): void {
  const embeddedSearchEnabled = resolveRuntimeEmbeddedSearchEnabled(runtime);
  if (embeddedSearchEnabled) {
    runtime.registry.unregister("Glob");
    runtime.registry.unregister("Grep");
  }

  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    embeddedSearchEnabled,
    // 本函数是**第二个**
    // 注册入口，且刻意只传一个精简选项集。对「只有 true 才注册」的门（Cron / Workflow…）
    // 省略是安全的；但动态工作流灰度门的极性相反——「缺席即开启」，省略等于把首次装配剃掉的
    // 十个工具在 shell 快照初始化时原样加回来（registry.register 会覆盖同名项，
    // silentDuplicateWarnings 还把告警吞掉，所以全程无声）。推导因此必须与 runtime-tools.ts
    // 共用同一个 helper，不能在这里重写一遍判断。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime.config),
    agentProfiles: runtime.config.subagents?.profiles,
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    disallowedTools: runtime.config.toolDisallowlist,
    // FORK（Step 14）：prompt-surface 分档描述必须与首次装配同源。这里用的是同一个
    // helper（magic-context-tool-surface.ts 的 resolveMagicContextPromptSurfaceOptions），因为本函数
    // 是**第二个**注册入口且只传精简选项集——漏传不会「保持原样」，而会把 light 档描述
    // 静默翻回 full。
    ...resolveMagicContextPromptSurfaceOptions(runtime),
    silentDuplicateWarnings: true,
  });
  runtime.cachedTools = null;
}

export function filterEmbeddedSearchRuntimeVisibleTools(
  runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  if (!resolveRuntimeEmbeddedSearchEnabled(runtime)) return tools;
  return tools.filter((tool) => tool.name !== "Glob" && tool.name !== "Grep");
}
