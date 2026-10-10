/**
 * Step 13 — `## Magic Context` 段的端口定义与 core 侧装配助手（D1 的宿主侧注入缝）。
 *
 * ============================================================================
 * 这个文件**不 import `@zcode/magic-context` 的任何运行时值**，与
 * `magic-context-turn-transform.ts` 同一条纪律。
 * ============================================================================
 *
 * 211 行的段文案在上游逐字区（`core/agents/magic-context-prompt.ts`，Step 12 的壳缝①
 * 真身）。宿主要把它注入 system prompt，但 core 不能因此静态 import 那个包：
 * `features.magicContext === false` 时要求"零行为"——CLI 启动不该把整棵模块图
 * （zod schema + sqlite chokepoint + 迁移模块）拉进内存，而它们一个都不会被用到。
 *
 * 所以分工与 turn-loop 那条缝完全同构：
 *   - **core（本文件 + `context/sections/magic-context.ts`）**：声明端口类型、收集自己
 *     那份活值事实、段的落位与 token 记账、以及与原生 `# Memory` 段的互斥。零包依赖。
 *   - **bootstrap（`magic-context-turn-transform.ts` 的
 *     `createMagicContextPromptSectionResolver`）**：唯一 import 包的地方。它从
 *     ConfigPort 现读 `memory.enabled` 与 `prompt_surface`（那两个域的唯一所有者），
 *     连同 core 递来的事实一起装配 `buildMagicContextSection` 的 11 个参数。
 *
 * 端口是**同步函数**：context builder 的 `build()` 是同步的（改动它会波及每一条 context
 * 装配路径，包括子智能体与工作流子代理），因此「读配置」这件事必须发生在装配层。
 * 参数对象每次 context 前缀重算都会重新构造，所以 resolver 不可能靠闭包缓存到过期值——
 * 它每次都读 ConfigPort。
 */

import { CTX_REDUCE_TOOL_NAME } from "@zcode/contracts";

import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * resolver 的输入——**只有 core 才知道的那部分事实**。
 *
 * 刻意不含 `memory.enabled` / `prompt_surface`：那两个域由 resolver 自己从 ConfigPort
 * 现读。若这里也接一份，就会出现同一配置的两条写入路径与两份可能分叉的副本，而 core 又
 * 没有任何理由比 bootstrap 更早知道它们。
 */
export interface MagicContextPromptSectionInput {
    /**
     * 执行模型的 canonical key（`provider/model`）。缺席（还没有活模型）时 preset 只能
     * 落到 configured default——此时段文案仍然是诚实值，因为 resolver 自己按同一把
     * model-key walk 解析，分歧只会发生在 `${default}` 上，而那是配置的事实。
     */
    modelKey?: string;
    /** 实际提示词语言（runtime config 的 `language`，"auto" 已由装配层解析掉）。 */
    language?: string;
    /**
     * `ctx_reduce` 在**本次请求的工具表里真的注册了吗**。判据是注册事实而不是
     * `magicContext.enabled` flag：后者开着而工具因 allowlist / workflow_child 结构禁用
     * 缺席时，教模型「盖章」是在介绍一个它没有的工具。
     */
    ctxReduceCallable: boolean;
    /** 子智能体 runtime：段只保留 §N§ 机制（上游 subagent 分支）。 */
    subagentMode: boolean;
}

/** 返回段文本，或 `null` = 本会话不注入（无端口 / flag 关 / resolver 决定不注入）。 */
export type MagicContextPromptSectionResolver = (
    input: MagicContextPromptSectionInput,
) => string | null;

/** 子智能体 runtime 的任务类型判定（与 `resolveRuntimeDisallowedTools` 用的同一个字面量）。 */
function isSubagentRuntime(runtime: AgentRuntimeInternal): boolean {
    return runtime.config.taskType === "subagent_child";
}

/**
 * 收集 core 侧活值并调用 bootstrap 注入的 resolver。
 *
 * 返回 `null` = 不注入。三种情况都会返回 null，且都是**诚实**的而不是兜底：
 *   ① 没有端口（bootstrap 没装 magic-context，或装配期 import 失败）；
 *   ② `magicContext.enabled !== true`；
 *   ③ resolver 自己决定不注入（包不可用、配置域读失败、装配异常）；
 * 三条都不该影响其余 context 段——原生 `# Memory` 段按既有规则照常注入。
 */
export function resolveMagicContextPromptSection(
    runtime: AgentRuntimeInternal,
    model: Model | undefined,
): string | null {
    const resolver = runtime.magicContextPromptSection;
    if (!resolver) return null;
    if (runtime.config.magicContext?.enabled !== true) return null;

    return resolver({
        ...(model ? { modelKey: `${model.providerId}/${model.modelId}` } : {}),
        ...(runtime.config.language === undefined ? {} : { language: runtime.config.language }),
        ctxReduceCallable: runtime.getTools(model).some((tool) => tool.name === CTX_REDUCE_TOOL_NAME),
        subagentMode: isSubagentRuntime(runtime),
    });
}
