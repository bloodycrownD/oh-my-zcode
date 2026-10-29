/**
 * FORK（magic-context 解耦）：`## Magic Context` 段与原生记忆面的互斥裁定。
 *
 * `context/builder.ts` 是上游本来就有的文件（在 `mc-upstream-surface.baseline.json`
 * 的冲突面清单里），跟随上游升级时每留在它里面一行 fork 代码就多一处可能冲突的段落。
 * 它原本内联了「MC 段在场 → 原生 `# Memory` 段与 MEMORY.md 索引一起退场」的裁定，散在
 * build() 的四处：入口构造 + owns 布尔、Memory 段条件、meta_user 的 memoryIndexContent、
 * memoryRoot 传参。本文件把裁定收成一个纯函数，builder 只留「有 entry 就 push +
 * 用裁定后的 memoryRoot / memoryIndexContent」的接线。
 *
 * 为什么裁定不能上移到装配层（`runtime/methods/context.ts` 的三个入口共用）：
 * 「空串 / 纯空白 → null」是 `sections/magic-context.ts` 的端口契约，裁定极性依赖
 * **归一之后**的 entry——装配层只持有 resolver 的 raw string。若装配层按 `raw !== null`
 * 清 memoryRoot / memoryIndexContent，resolver 返回 `""` 时两边全丢（既不注入 MC，
 * 又杀掉原生记忆面）。要修只能复制 trim 规则（同一语义两处实现，分叉风险），或把
 * `ContextSection` 对象塞进 config 类型（types.ts 与 subagent/context-builder.ts 两处
 * 上游文件都要改类型，且 malformed heading 的抛错点从 build() 挪走）。裁定留在 core，
 * 与 entry 工厂相邻。
 *
 * 保留的原语义（逐字，不得顺带「统一」）：
 *   - entry === null（无段 / 空串 / 纯空白）时两字段原样透传，原生 `# Memory` 段与
 *     MEMORY.md 索引照常注入；
 *   - entry !== null 时两个字段**一起**缺席：两套记忆词汇表不能同处一个 system prompt
 *     （理由见 `sections/magic-context.ts` 文件头）；
 *   - `buildMagicContextSectionEntry` 的 malformed heading 抛错在本函数内原样冒泡，
 *     调用点仍在 build() 开头且无条件执行（customSystemPrompt 路径同样会抛）；
 *   - 每次 build() 求值一次、不缓存：builder 的 config 可被 setEnvInfo 换成新对象。
 *
 * 依赖方向：本文件 → `types.js`（type-only）与 `sections/magic-context.js`；
 * **不 import `@zcode/magic-context`**（flag 关时零行为、整棵包模块图不进内存，与
 * `runtime/helpers/magic-context-prompt-section.ts` 同一条纪律）。
 */

import type { ContextBuilderConfig, ContextSection } from "./types.js";
import { buildMagicContextSectionEntry } from "./sections/magic-context.js";

/**
 * 按 MC 段是否在场裁定本会话可用的记忆词汇表。
 *
 * entry 由调用方决定入栈位置与时机：主路径只在 `!hasCustomSystemPrompt` 分支里 push
 * （custom 路径历史上就不注入 MC 段，但 memoryIndexContent 的抑制仍在块外生效）；
 * 返回的 memoryRoot / memoryIndexContent 是消费方唯一该读的版本。
 */
export function resolveMemoryVocabularySurfaces(
  input: Pick<ContextBuilderConfig, "magicContextSection" | "memoryRoot" | "memoryIndexContent">,
): { entry: ContextSection | null; memoryRoot?: string; memoryIndexContent?: string } {
  const entry = buildMagicContextSectionEntry(input.magicContextSection);
  if (entry !== null) {
    return { entry };
  }

  return {
    entry: null,
    memoryRoot: input.memoryRoot,
    memoryIndexContent: input.memoryIndexContent,
  };
}
