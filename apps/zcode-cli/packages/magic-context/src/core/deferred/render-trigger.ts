// FORK-DEFERRED(Batch2): `features/magic-context/mural/render-trigger.ts` 的 resolveMuralWire 摘录与 `features/magic-context/mural/resolve-mural.ts` 的 MuralWireOptions 类型摘录，Step 31 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The mural renderer turns project memories into
// a PNG data URL injected into `<memory-mural>`. Batch 2 (memory) is not in the
// fork's first version, and the render path additionally needs
// `models-dev-cache`'s vision probe and `render-mural`'s PNG encoder.
//
// SEMANTIC DECISION — `resolveMuralWire` returns `{ enabled, supportsVision:
// false }` (upstream's own "feature off" answer, `render-trigger.ts:228-230`),
// never throws. Reasoning from the call site: `inject-compartments.ts:2423-2431`
// gates the call on `options.muralEnabled` and forwards the result as
// `MuralWireOptions | undefined`; the consumer at `:2355` requires
// `enabled && supportsVision && dataUrl` before pushing the
// `MEMORY_MURAL_BLOCK` section. A `supportsVision: false` answer therefore drops
// the mural block cleanly through the existing path — which is precisely what a
// fork with no memory feature must serve, and it is the outcome the upstream
// function itself produces for a non-vision model.
//
// `MuralWireOptions` is reproduced verbatim because it is the type the m0/m1
// render options carry.
//
// Step 31: delete this file and repoint `inject-compartments.ts` back at
// `../../features/magic-context/mural/render-trigger.js` and
// `../../features/magic-context/mural/resolve-mural.js`.

import type { Database } from "../shared/sqlite.js";

/**
 * Wire options for the m0 mural image injection: whether the feature is on,
 * whether the fold's model accepts images, and (when both hold) the rendered
 * data URL plus its content hash. Produced by resolveMuralWire (render-trigger).
 *
 * Verbatim: `resolve-mural.ts:10-15`.
 */
export interface MuralWireOptions {
    enabled: boolean;
    supportsVision: boolean;
    dataUrl?: string;
    contentHash?: string;
}

/**
 * Resolve the mural WIRE options for the m0 injection path: gate on the mural
 * feature flag AND the outgoing model's vision capability, then ensure the
 * deterministic mural is rendered and return its data URL + content hash.
 *
 * Returns `{ enabled: false }` (no image) when the feature is off, the model
 * can't take images, or the cue pool is empty.
 *
 * Signature verbatim from `render-trigger.ts:221-227`; the body always takes
 * upstream's own "no image" arm — see the header note.
 */
export function resolveMuralWire(
    _db: Database,
    _projectIdentity: string | undefined,
    _modelKey: string | undefined,
    enabled: boolean,
    _budgetTokens?: number,
): MuralWireOptions {
    return { enabled, supportsVision: false };
}