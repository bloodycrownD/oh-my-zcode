// ============================================================
// magic-context ctx_* Tool Registration (FORK)
// ============================================================
// 为什么单独成文件：`handlers/index.ts` 是上游 ZCode 的工具注册表全量清单，跟随
// 上游升级时改动概率高；ctx_* 四工具的「注册门 + prompt-surface 描述换档」是本 fork
// 独有的一整块逻辑，夹在清单里纯属冲突面。这里收掉三样东西：
//
//   1. 四个 entry 本身（顺序保持 reduce → expand → search → memory）；
//   2. 注册门（`includeMagicContextTools`）与 prompt-surface full/light 换档
//      （`magicContextToolDescription` + `magicContextModelKey`）共用的**唯一一份**
//      工具名集合；
//   3. 上述三项选项字段的形状（`MagicContextToolRegistrationOptions`）。
//
// 依赖方向：本文件 → 兄弟 handler（ctx-context.ts / ctx-memory.ts / ctx-search.ts）
// 与 `../types.js`；**不 import index.ts**（index.ts 是这里的单向上游），因此无环。
// 三个兄弟 handler 静态依赖的只有 `@zcode/contracts`，`@zcode/magic-context` 由它们
// 在 handler 内部**动态 import**。本文件不得对该包加静态 import——否则
// `features.magicContext` 关闭时「整棵模块图不进内存」（D-11 零行为不变式）当场破。

import {
  CTX_EXPAND_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
  CTX_REDUCE_TOOL_NAME,
  CTX_SEARCH_TOOL_NAME,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { ctxExpandToolEntry, ctxReduceToolEntry } from "./ctx-context.js";
import { ctxMemoryToolEntry } from "./ctx-memory.js";
import { ctxSearchToolEntry } from "./ctx-search.js";

/**
 * 四个 ctx_* 工具名的**唯一**集合：注册门与 prompt-surface 换档共用同一份。
 *
 * FORK（Step 14）：分档只作用于这四个工具——它们是 prompt-surface 唯一有 full/light
 * 两份文案的工具族（包侧 `ACTIVE_TOOL_IDS` 的同族集合）。
 *
 * 不留第二份名单是结构性的：漏一个名字意味着那个工具永远拿不到 light 描述，而多认
 * 一个非 ctx 工具则意味着描述求值器空转（包侧 `descriptionFor` 对未知 id 原样返回
 * 全文）。两种偏差在 prompt 面与工具表上都没有运行期信号，只有这份集合能兜住。
 */
const MAGIC_CONTEXT_TOOL_NAMES: ReadonlySet<string> = new Set([
  CTX_REDUCE_TOOL_NAME,
  CTX_EXPAND_TOOL_NAME,
  CTX_SEARCH_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
]);

/**
 * magic-context 上下文回收面（S21）与记忆面（Step 10：ctx_search=D4 检索 /
 * ctx_memory=D14 写入）的四个 entry。
 *
 * 只有 `features.magicContext` 打开的会话才注册（注册门见
 * {@link isMagicContextToolEnabled}）：默认态下模型看到的工具表里没有 ctx_*。handler
 * 都是动态 import 包的，所以 flag 关时整棵模块图不进内存。ctx_search 纯读记忆库，
 * ctx_memory 写本项目记忆库一行（幂等，见 handler 注释）。
 *
 * 顺序与原先内联在注册表里的数组一致（reduce → expand → search → memory）：同族相邻
 * 只为可读性，无运行期语义。
 */
export const magicContextToolEntries: readonly ToolEntry[] = [
  ctxReduceToolEntry,
  ctxExpandToolEntry,
  ctxSearchToolEntry,
  ctxMemoryToolEntry,
];

/**
 * ctx_* 四工具（`ctx_reduce` / `ctx_expand` / `ctx_search` / `ctx_memory`）的注册选项。
 * 由注册表接口 `RegisterBuiltInToolsOptions` extends 进来，结构不变。
 */
export interface MagicContextToolRegistrationOptions {
  /**
   * 上下文回收面与记忆面是否注册。
   *
   * **跟随 `features.magicContext`**（step 28 起默认开），理由与 `includeNodeRepl`
   * 同款但更强一层：这四个工具的实现在 `@zcode/magic-context` 里（ctx_search /
   * ctx_memory 的薄封装在 core），而 handler 是**动态 import** 它的，所以 flag 关时
   * 包整棵不会被拉进内存（zod schema + sqlite chokepoint + 迁移模块）——用户显式
   * 关掉后，「零行为」这条不变式（今天记作 D-11）才仍然成立。
   *
   * 由 `runtime/helpers/magic-context-tool-surface.ts` 从 `RuntimeConfig.magicContext.enabled` 推导。
   */
  includeMagicContextTools?: boolean;
  /**
   * FORK（bugfix-batch-20261011 / Step 14）：prompt-surface 的 preset 分档描述求值器。
   *
   * `prompt_surface.default` / `prompt_surface.models` 决定当前这届用 full 还是 light
   * 档 ctx_* 工具描述；light 档的紧凑文案在 `@zcode/magic-context` 的
   * `light-descriptions` 里（宿主不得自抄），因此这里收一个**求值器**而不是字面量表——
   * 由 bootstrap 侧（唯一 import 包的地方）把 `createPromptSurfaceRuntime().
   * resolveRegistration(config, modelKey).descriptionFor` 投影进来。
   *
   * 缺席 = 不换档，照原样注册 full 描述。求值器内部已经把「用户 tool_descriptions 覆盖
   * > light 目录 > full 原文」的优先级排好，注册侧不重复实现这套优先级。
   */
  magicContextToolDescription?: (input: {
    toolId: string;
    fullDescription: string;
    modelKey?: string;
  }) => string;
  /** preset 路由用的模型 key（`provider/model`）；缺席时只按 configured default 解析。 */
  magicContextModelKey?: string;
}

/**
 * ctx_* 注册门：**只有显式 true 才注册**；非 ctx 工具名恒为 true（不改循环语义）。
 *
 * 极性是硬不变量，不能写成 `!== false`。第二个注册入口
 * （`runtime/methods/embedded-search-branch.ts` 的 `refreshBranchAwareBuiltInTools`）
 * 刻意只传精简选项集、**不传** `includeMagicContextTools`：省略=跳过时，registry 里
 * 上一次装配的四个 entry 原样保留；若改成「缺席即注册」，那趟 shell 快照刷新就会把
 * flag 关着的 ctx_* 静默装回——`registry.register` 覆盖同名项，
 * `silentDuplicateWarnings` 还把告警吞掉，全程无声。
 */
export function isMagicContextToolEnabled(
  name: string,
  options: MagicContextToolRegistrationOptions,
): boolean {
  return !MAGIC_CONTEXT_TOOL_NAMES.has(name) || options.includeMagicContextTools === true;
}

/**
 * FORK（Step 14）：ctx_* 四工具的 preset 分档。只换 `metadata.description`，参数
 * schema / 权限 / 预算 / 超时一律不动——分档是「同一份能力的详简叙述」，不是第二个工具。
 * 与 Agent/Task 的灰度门同款纪律：首次装配与分支刷新走同一个 options 推导，两次产出的
 * 描述必然一致（否则一次刷新就会把换档结果悄悄翻回 full）。
 *
 * 两条原语义原样保留：
 *   - `description === undefined` 的工具不参与分档：分档是「同一份文案的详简两版」，
 *     没有原文就无从简化，也不该凭空造一段；
 *   - 求值结果与原文相同（`===`）时返回原 entry，只在描述真的变化时才换 entry。
 */
export function applyMagicContextToolDescription(
  entry: ToolEntry,
  options: MagicContextToolRegistrationOptions,
): ToolEntry {
  if (
    !MAGIC_CONTEXT_TOOL_NAMES.has(entry.metadata.name) ||
    options.magicContextToolDescription === undefined
  ) {
    return entry;
  }
  const fullDescription = entry.metadata.description;
  if (fullDescription === undefined) return entry;
  const description = options.magicContextToolDescription({
    toolId: entry.metadata.name,
    fullDescription,
    ...(options.magicContextModelKey === undefined
      ? {}
      : { modelKey: options.magicContextModelKey }),
  });
  if (description === fullDescription) return entry;
  return {
    ...entry,
    metadata: { ...entry.metadata, description },
  };
}
