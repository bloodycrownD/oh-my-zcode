/**
 * FORK（magic-context 解耦）：core 运行时工具注册面上三处 MC 接线的推导实现。
 *
 * `runtime-tools.ts` 是上游本来就有的文件（在 `mc-upstream-surface.baseline.json`
 * 的冲突面清单里），跟随上游升级时每留在它里面一行 fork 代码就多一处可能冲突的段落。
 * 这里收掉原本内联在它里面的三块判断，让它只留三行调用：
 *
 *   1. `includeMagicContextTools` 注册门：`features.magicContext` 显式 true 才注册；
 *   2. `workflow_child` 对四个 ctx_* 工具的结构性禁用；
 *   3. prompt-surface 分档描述与 modelKey 的注册选项推导。
 *
 * 依赖方向：本文件 → `tool-allowlist.js`（turn 级名单）与 `@zcode/contracts` 的工具名
 * 常量；**不 import `@zcode/magic-context`**（与 `magic-context-prompt-section.ts` 同一条
 * 纪律：flag 关时整棵包模块图不进内存）。`tool-allowlist.ts` 不反向依赖本文件——那份
 * 追加刻意不塞进 `resolveRuntimeDisallowedTools`，理由见下面函数注释。
 *
 * 保留的原语义（逐字，不得顺带「统一」）：
 *   - 注册门是 `=== true`：`undefined` 也算关闭（decoupling spec 的 T-MC1 钉死了 core 侧
 *     三处 undefined 方向不一致，收口时不得静默改变其中一处）；
 *   - 结构性禁用只在 `taskType === "workflow_child"` 时追加，并与 turn 级名单合并成
 *     新数组，不修改调用方传入的配置；
 *   - 求值器缺席时返回空对象（不换档），modelKey 缺席时整个键省略（不能传 undefined
 *     覆盖默认解析）。
 */

import {
  CTX_EXPAND_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
  CTX_REDUCE_TOOL_NAME,
  CTX_SEARCH_TOOL_NAME,
} from "@zcode/contracts";

import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../types.js";
import { resolveRuntimeDisallowedTools } from "./tool-allowlist.js";

/** 见 `resolveRuntimeDisallowedToolsWithMagicContext` 的根因注释。 */
const MAGIC_CONTEXT_WORKFLOW_CHILD_DISALLOWED_TOOLS: readonly string[] = [
  CTX_REDUCE_TOOL_NAME,
  CTX_EXPAND_TOOL_NAME,
  // Step 10（D4/D14）同族加入。ctx_memory 是**跨会话持久写**：workflow child
  // 的工具交互只在 subagent 路径镜像到父会话，而一条记忆的影响远大于一次会话
  // （所有后续会话的 m0/m1 注入与 ctx_search 都会看见它），用户在父界面没有
  // 否决机会——与 ctx_reduce「盖章不可见」同属结构性禁用，不是权限档位问题。
  // ctx_search 读的是同一个 store，与 ctx_expand 同理禁掉。
  CTX_SEARCH_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
];

/**
 * magic-context 上下文回收面（S21）与记忆面（Step 10）的注册门取值。
 *
 * 门是 `config.magicContext?.enabled === true`（step 28 起默认 true）。ctx handler 是动态
 * import 包的，所以这道门同时决定了「模型看得见这四个工具吗」与「整棵 magic-context
 * 模块图进不进内存」——见 `handlers/index.ts` 的注释。
 *
 * 极性是硬不变量：写成 `!== false` 会让 `undefined` 变成开启，与 core 侧其余两处
 * 缺省方向（`magic-context-prompt-section.ts` 的 `!== true`）和配置装载的冻结值脱节。
 */
export function resolveMagicContextToolsIncluded(config: AgentRuntimeConfig): boolean {
  return config.magicContext?.enabled === true;
}

/**
 * workflow_child 额外不注册四个 ctx 工具。
 *
 * 根因与 `WORKFLOW_CHILD_DISALLOWED_TOOLS` 的第一条同源，但更硬：child 的工具交互
 * 事件只在 subagent 路径上镜像到父会话，一个 workflow child 在自己的会话里盖掉的
 * §N§ 标记，父会话与用户**都看不到**——用户会以为那段上下文还在，而它已经被排队
 * 清掉了。这不是「无窗可弹」，是「用户失去了否决的机会」，因此属于**结构性禁用**
 * 而不是权限档位问题。
 *
 * `ctx_expand` 也一并禁掉：它读的是同一个 store，读到被别的 actor 盖掉的 tag 只会
 * 让 child 拿到一份用户没批准过的视图。
 *
 * Step 10 起 `ctx_search` / `ctx_memory` 同族入列：前者读同一个记忆 store（同
 * ctx_expand 理由），后者是跨会话持久写——一条从 child 钉进去的记忆会影响之后
 * **所有**会话的注入与检索，比一次盖章的可见性缺口更大（见常量处的展开注释）。
 *
 * 这份追加刻意留在本文件而不是 `tool-allowlist.ts`：`resolveRuntimeDisallowedTools`
 * 是两个 child runtime 构造点共用的推导入口，而 ctx 这道门只跟「magic-context 开着」
 * 这件事有关，与 workflow child 的构造点无关。
 */
export function resolveRuntimeDisallowedToolsWithMagicContext(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const base = resolveRuntimeDisallowedTools(config);
  if (config.taskType !== "workflow_child") return base;
  const disallowed = new Set(base ?? []);
  for (const toolName of MAGIC_CONTEXT_WORKFLOW_CHILD_DISALLOWED_TOOLS) {
    disallowed.add(toolName);
  }
  return [...disallowed];
}

/**
 * FORK（bugfix-batch-20261011 / Step 14）：prompt-surface 分档描述的一组注册选项。
 *
 * 首次装配（`registerRuntimeBuiltInTools`）与分支刷新
 * （`refreshBranchAwareBuiltInTools`，embedded-search 分支的第二个注册入口）**必须**拿到
 * 同一个推导结果。后者只传一个精简选项集，漏传这一组的后果不是「保持原样」而是「把 light
 * 档描述翻回 full」——registry.register 覆盖同名项且 silentDuplicateWarnings 吞告警，
 * 全程无声。因此抽成这一个函数，两个入口各自调用（本文件是两处共用的唯一实现）。
 *
 * `modelKey` 取会话当前的模型选择：它是 preset 路由的输入（`prompt_surface.models` 的
 * per-model 键）。缺席（还没有活模型 / 无选择）时求值器自己按 configured default 解析——
 * 那是配置的事实，不是退化路径。
 */
export function resolveMagicContextPromptSurfaceOptions(runtime: AgentRuntimeInternal): {
  magicContextToolDescription?: NonNullable<AgentRuntimeDeps["magicContextToolDescription"]>;
  magicContextModelKey?: string;
} {
  const describe = runtime.magicContextToolDescription;
  if (describe === undefined) return {};
  const selection = runtime.config.modelSelection;
  const modelKey =
    selection === undefined ? undefined : `${selection.providerId}/${selection.modelId}`;
  return {
    magicContextToolDescription: describe,
    ...(modelKey === undefined ? {} : { magicContextModelKey: modelKey }),
  };
}
