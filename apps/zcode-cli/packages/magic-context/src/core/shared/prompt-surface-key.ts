/**
 * FORK（magic-context-decoupling / phase-zero-load / Step 5）：
 * `isValidPromptSurfaceModelKey` 的**零依赖叶子**。
 *
 * ============================================================================
 * 为什么不留在 `prompt-surface.ts` 里
 * ============================================================================
 *
 * 上游把该函数内联在 `core/shared/prompt-surface.ts`（真身 `:56`），而那个文件
 * 顶部有 `import { modelRefLookupOrder } from "./harness-provider-map.js"`。于是任何
 * 只想做「prompt_surface.models 的 key 校验」的消费者（宿主侧 `host/config/schema.ts:51`）
 * 都会连带解析 `prompt-surface.js` + `harness-provider-map.js` 两个与校验无关的文件。
 *
 * 宿主的 `adapters/src/config/schema.ts` 在**模块顶层**求值
 * `MagicContextConfigSchema.optional()`（配置装载必经路径，早于任何开关判定），
 * 所以这条闭包的大小直接决定「关闭态到底加载了多少 MC 模块」（spec IM1 / 口径①）。
 * 抽成零 import 叶子后，`host/config/schema` 窄子路径的闭包 = `schema.js` +
 * `language.js` + 本文件 = **3 个文件**（+ zod 4.6.5 闭包，属 M0）。
 *
 * 函数体**逐字**取自 `prompt-surface.ts`（同一份上游实现，无行为改动）；该文件改为
 * 从本叶子 re-export，对外导出面不变（`src/index.ts` 仍从 `prompt-surface.js` 取
 * 该符号）。
 *
 * ============================================================================
 * 升级 magic-context 时的 rebase 点
 * ============================================================================
 *
 * 1. 逐字重放上游 `core/shared/prompt-surface.ts` 后，上游版本里该函数仍内联在
 *    文件内 → 重新把它抽到本文件（保持函数体逐字），并把 `prompt-surface.ts` 里
 *    的函数定义改回 `export { isValidPromptSurfaceModelKey } from
 *    "./prompt-surface-key.js";`。
 * 2. 若上游改了这个函数的校验规则，**只改本文件**，`prompt-surface.ts` 的
 *    re-export 不动；反之若上游把 `harness-provider-map` 的依赖从
 *    `prompt-surface.ts` 里去掉，本前导说明的第二段失效，可评估把两者合并回去
 *    （合并的前提是 `host/config/schema` 的闭包不再变大）。
 * 3. 登记处：仓库根 `UPSTREAM-SYNC.md` 第 3 节「插件化偏离点（rebase 登记）」。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

/**
 * Validate bare model, provider/model, and provider/* routing keys.
 *
 * 逐字取自上游 `core/shared/prompt-surface.ts::isValidPromptSurfaceModelKey`。
 */
export function isValidPromptSurfaceModelKey(key: string): boolean {
  if (key.length === 0 || key.trim() !== key) return false;

  const slash = key.indexOf("/");
  if (slash < 0) return !key.includes("*");
  if (slash === 0 || slash === key.length - 1) return false;

  const provider = key.slice(0, slash);
  const modelID = key.slice(slash + 1);
  if (
    provider.trim() !== provider ||
    modelID.trim() !== modelID ||
    provider.includes("*") ||
    (modelID.includes("*") && modelID !== "*")
  ) {
    return false;
  }
  if (modelID === "*") return true;

  return (
    modelID.length > 0 &&
    !modelID.startsWith("/") &&
    !modelID.endsWith("/") &&
    !modelID.includes("//")
  );
}
