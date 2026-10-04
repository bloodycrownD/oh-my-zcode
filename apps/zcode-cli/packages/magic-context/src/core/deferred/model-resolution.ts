// FORK-DEFERRED(E): `shared/model-resolution.ts` 的 ModelHarness / ResolvedModelEntry / ModelInput 摘录，S20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. `model-resolution.ts` is 244 lines, but only
// three of its exports are structural TYPES; the rest are resolvers over
// `MagicContextConfig`'s `harness` blocks, which is the E group's config schema
// (already rewritten by S16 as `src/host/config/schema.ts`). The B group names
// `ModelInput` as a type in eight signatures (`transform.ts`,
// `transform-compartment-phase.ts`, `compartment-runner-types.ts`); none of them
// constructs one.
//
// Step 20: delete this file and repoint `transform.ts`,
// `transform-compartment-phase.ts` and `compartment-runner-types.ts` back at
// `../../shared/model-resolution.js`.

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