/**
 * Step 16（bugfix-batch-20261011 / D9-D10 波次的收口件）：`protected_tokens` 的
 * 派生默认公式原先在 `core/deferred/magic-context-schema.ts` 壳里逐字摘录，
 * 本步删除该壳、公式在此归位为源文件本体。
 *
 * 上游：`.reference/magic-context/packages/plugin/src/config/schema/
 * magic-context.ts` 的同名函数（逐字保真，含注释与 sizing table）。
 *
 * 为何落 `core/shared` 而不是 spec Step 16 原文与 r4 P0-2 提到的
 * `host/config/schema.ts`（登记为 spec 勘误，交由 Step 19/spec-check 收口）：
 *   ① 消费者 `storage-meta-persisted.ts` 是 core 逐字区文件；core → host 的
 *      依赖方向与包内既有方向（host/config/schema.ts → core/shared/
 *      prompt-surface.js，host 消费 core）相反；
 *   ② B/A 组测试基建（scripts/test-transform.mjs 的 `stage()`）刻意只暂存
 *      `src/core/**` 并排除 host sibling layer，core → host import 会让该
 *      套件运行期 ERR_MODULE_NOT_FOUND；该测试文件属 Step 18 并行禁触面，
 *      不由本步适配；
 *   ③ r4 P0-2 的关注意图是「先落类型再改指、防止 repoint 目标缺失」——单一
 *      事实先落在 core 树内，引用侧改指到本文件，意图等价满足。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

/**
 * Derived default protected_tokens formula:
 * clamp(round(0.05 × usableSoft), min(16000, round(0.08 × usableSoft)), 64000)
 *
 * Sizing table:
 *   100k -> 8,000
 *   200k -> 16,000
 *   372k -> 18,600
 *   872k -> 43,600
 *   1M   -> 50,000
 */
export function deriveDefaultProtectedTokens(usableSoft: number): number {
    const clampedUsable = Math.max(0, usableSoft);
    const lowerBound = Math.min(16_000, Math.round(0.08 * clampedUsable));
    const target = Math.round(0.05 * clampedUsable);
    return Math.min(64_000, Math.max(lowerBound, target));
}
