/**
 * Step 12 — D7 全覆盖缝②：`shared/model-resolution.ts` 落位（壳 exports 已覆盖所需面）。
 *
 * 上游源：`.reference/magic-context/packages/plugin/src/shared/model-resolution.ts`
 * （244 行）。本 fork 只需要其中三个**结构性 type**，上游其余部分（`normalizeModelEntry` /
 * `resolveFallbackEntries` / `resolveHistorianModel` / `resolveDreamerTaskModel` /
 * `resolveOpenCodeAgentOverrides` / `resolveHistorianAgentOverrides` 六个 resolver）全部
 * 是对 `MagicContextConfig` 的 `historian` / `dreamer` harness 子树的解析，而 fork 的 E 组
 * 配置只有一套扁平 `historian`（Step 16 的 schema 已裁定不搬 OpenCode/Pi/OMP 三套并行
 * model-resolution 词汇，D-2 只保留 zcode.z.ai 一个后端）。因此**不复活**上游多出的
 * exports：本文件即 fork 的完整引用面。
 *
 * WHAT CHANGED VS THE SEAM IT REPLACES
 * ─────────────────────────────────────
 * 仅文件头注：原先 `deferred/` 的 FORK-DEFERRED(E) 裁剪壳改写成上面这条 FORK-NOTE；
 * 三个 type 的声明逐字不变（壳本身就是从上游 :1/:3-8/:10 摘的，`Verbatim:` 标注可对照）。
 * 引用方 4 处 import 改指本文件（`transform.ts` / `transform-compartment-phase.ts` /
 * `compartment-runner-historian.ts` / `compartment-runner-types.ts`）。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

/** Verbatim: `model-resolution.ts:1`. */
export type ModelHarness = "opencode" | "pi" | "omp";

/** Verbatim: `model-resolution.ts:3-8`. */
export interface ResolvedModelEntry {
    /** Canonical provider/model reference used for identity and model selection. */
    model: string;
    /** OpenCode variant or Pi thinking level, selected for the active entry only. */
    qualifier?: string;
}

/** Verbatim: `model-resolution.ts:10`. */
export type ModelInput = string | ResolvedModelEntry;
