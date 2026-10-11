// FORK-NOTE(Step 15 / bugfix-batch-20261011): SHELL SEAM ① — this file replaces
// the deferred seam `core/deferred/render-trigger.ts` (61 lines) with upstream
// `features/magic-context/mural/render-trigger.ts` (240 lines) in place, via
// `git mv` so the rename trajectory stays in history. Track: D5 in the batch
// spec's 裁定总表.
//
// WHAT THE SEAM USED TO BE. The seam kept only `MuralWireOptions` (now
// re-exported from the ported `./resolve-mural.js`, upstream's own home for the
// type) plus a `resolveMuralWire` stub that ALWAYS took upstream's
// "feature off" arm: `return { enabled, supportsVision: false }`. The seam's
// own header self-declared the reason — the fork had neither the memory write
// side (landed in Step 8) nor the render path, and the call site
// (`inject-compartments.ts` m0 materialization) requires
// `enabled && supportsVision && dataUrl` before pushing `MEMORY_MURAL_BLOCK`,
// so a `supportsVision: false` answer dropped the mural block cleanly.
//
// WHAT CHANGED VS THE SEAM IT REPLACED
// ─────────────────────────────────────
// ① The body is the upstream module (cache, coverage gate, change detection,
//    `ensureMuralRendered`, `resolveMuralWire`) — 240 lines, verbatim except
//    for the import specifiers and the vision gate below.
// ② ADAPTED — VISION GATE (the one behavioral fork adaptation, registered here
//    per spec Step 15). Upstream resolves vision through the package's own
//    `shared/models-dev-cache.ts:modelSupportsVision`, which reads the
//    `apiCache` warmed by `refreshModelLimitsFromApi` — and in this fork that
//    refresher has ZERO callers, so the cache is never populated and upstream's
//    own chain would answer `false` for every model (the "vision 恒 false"
//    breakage the spec records). The fork therefore injects the probe instead:
//    the host (bootstrap) registers a resolver backed by the STATIC model
//    catalog's `ModelInputFormatData.supportsImage`
//    (packages/shared/src/model-config.ts:51-59, the same static source
//    `contracts/src/model/media-policy.ts:40` already consumes for provider
//    media projection). Absent probe = unknown capability = no image, which is
//    upstream's own "missing cache entries fail closed (no image)" semantics.
//    `setMuralVisionProbe` is the seam's registration entry; it is a
//    process-global like the package's other injected seams
//    (`registerSlowWriteReporter`, `setRawMessageProvider`), which is correct
//    because the catalog is session-independent.
// ③ Import specifiers re-qualified with `.js` for NodeNext; the removed
//    `modelSupportsVision` import is the only import deleted (see ②).
//
// NOT PORTED from the upstream mural directory: `compress-cues.ts`,
// `compress-cues-prompt.ts`, `cue-validation.ts` — they belong to the dreamer
// compress-cues task, which is N3 (final "not doing"). `storage-mural-cues.ts`
// landed early in Step 8 (it is a storage-memory closure member); this step adds
// the remaining five files (resolve-mural / render-mural / mural-selection /
// storage-mural / mural-font.generated).
//
// MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.

import { createHash } from "node:crypto";

import { piModelRefToCanonical } from "../../../shared/harness-provider-map.js";
import { log } from "../../../shared/logger.js";
import type { Database } from "../../../shared/sqlite.js";
import { DEFAULT_MURAL_MEMORY_BUDGET } from "./mural-selection.js";
import { planMuralRender, renderPlannedMural } from "./render-mural.js";
import type { MuralWireOptions } from "./resolve-mural.js";
import { getMuralCoverage, resolveMural } from "./resolve-mural.js";
import { getMural, upsertMural } from "./storage-mural.js";

/**
 * FORK ADAPTATION (Step 15) — the injected vision probe. The host registers a
 * resolver backed by the static model catalog's `supportsImage`; see the
 * FORK-NOTE block above for why the upstream models.dev apiCache chain cannot
 * serve this in the fork (zero callers → permanently empty → vision always
 * false, which would make the whole ported render path dead code).
 */
export type MuralVisionProbe = (canonicalModelKey: string) => boolean;

let muralVisionProbe: MuralVisionProbe | undefined;

/** Register the host's vision resolver (process-global; pass undefined to clear). */
export function setMuralVisionProbe(probe: MuralVisionProbe | undefined): void {
    muralVisionProbe = probe;
}

/**
 * On-demand deterministic mural render. The weekly author task is gone: the
 * mural is now a pure function of the compressed cue pool, rendered when the m0
 * injection path needs it. Change detection is CHEAP — resolveMural plus a text
 * assembly hash, no PNG work — so an unchanged cue pool costs one resolve and a
 * hash compare. The PNG is only encoded and upserted when the resolved text
 * actually changed.
 *
 * The stored row still feeds `mural_manifest` for the dashboard (`get_mural`);
 * its `model` column becomes "deterministic" since no compressor model rendered
 * it (the compressor model is recorded per-cue, not per-render).
 */

export const DETERMINISTIC_MURAL_MODEL = "deterministic";
export const MIN_MURAL_CUED_MEMORIES = 15;
export const MIN_MURAL_COVERAGE = 0.5;

// Resolve the pool on every refresh, but retain at most sixteen exact render inputs
// per database. Weak ownership releases all PNGs when a database is discarded.
const renderCaches = new WeakMap<
    Database,
    Map<
        string,
        {
            key: string;
            image: Buffer;
            result: EnsureMuralResult;
        }
    >
>();

function rememberRender(
    db: Database,
    project: string,
    key: string,
    image: Buffer,
    result: EnsureMuralResult,
): EnsureMuralResult {
    let cache = renderCaches.get(db);
    if (!cache) {
        cache = new Map();
        renderCaches.set(db, cache);
    }
    cache.delete(project);
    const size = key.length * 2 + image.length + (result.dataUrl?.length ?? 0) * 2;
    if (size <= 16 * 1024 * 1024) {
        cache.set(project, {
            key,
            image: Buffer.from(image),
            result: { ...result, rerendered: false },
        });
    }
    const retainedBytes = () =>
        [...cache.values()].reduce(
            (sum, entry) =>
                sum +
                entry.key.length * 2 +
                entry.image.length +
                (entry.result.dataUrl?.length ?? 0) * 2,
            0,
        );
    while (cache.size > 16 || retainedBytes() > 16 * 1024 * 1024) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return result;
}

export interface EnsureMuralResult {
    /** True when a resolved cue pool exists (the mural block should be injected). */
    hasMural: boolean;
    /** data URL of the current mural PNG, when hasMural. */
    dataUrl?: string;
    /** SHA-256 of the deterministic layout text, used to identify the injected image. */
    contentHash?: string;
    /** True when this call re-rendered + upserted (the text changed or was new). */
    rerendered: boolean;
    /** Set when the coverage gate intentionally omitted the mural. */
    skipReason?: string;
    width?: number;
    height?: number;
}

/** A mural is useful with enough cues or broad enough pool coverage. */
export function muralCoverageGate(cuedMemoryCount: number, activeMemoryCount: number): boolean {
    return (
        cuedMemoryCount >= MIN_MURAL_CUED_MEMORIES ||
        cuedMemoryCount >= MIN_MURAL_COVERAGE * activeMemoryCount
    );
}

/**
 * Ensure the stored mural reflects the current compressed cue pool, rendering
 * and upserting only when the deterministic mural TEXT changed since the stored
 * render. Returns the wire data for the injection path.
 *
 * @param budgetTokens the project memory injection budget, so the overflow set
 *   matches exactly what the m0 path dropped.
 */
export function ensureMuralRendered(
    db: Database,
    projectIdentity: string,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
): EnsureMuralResult {
    const coverage = getMuralCoverage(db, projectIdentity);
    if (
        coverage.activeMemoryCount === 0 ||
        !muralCoverageGate(coverage.cuedMemoryCount, coverage.activeMemoryCount)
    ) {
        const skipReason =
            coverage.activeMemoryCount === 0
                ? "no active memories"
                : `only ${coverage.cuedMemoryCount}/${coverage.activeMemoryCount} active memories have current cues (requires ${MIN_MURAL_CUED_MEMORIES} cues or ${MIN_MURAL_COVERAGE * 100}% coverage)`;
        log(`[mural] skipped for ${projectIdentity}: ${skipReason}`);
        return { hasMural: false, rerendered: false, skipReason };
    }

    const entries = resolveMural(db, projectIdentity, budgetTokens);
    if (entries.length === 0) {
        // Empty overflow pool → no mural block. Leave any stale stored row alone
        // so the dashboard can still show the last render.
        return { hasMural: false, rerendered: false };
    }

    // Exact ordered entries cover ids, cues, category and importance after budget
    // selection. Re-resolving also observes deletions and stale cue content hashes.
    const key = JSON.stringify(entries);
    const existing = getMural(db, projectIdentity);
    const cached = renderCaches.get(db)?.get(projectIdentity);
    if (
        cached?.key === key &&
        existing &&
        existing.contentHash === cached.result.contentHash &&
        existing.width === cached.result.width &&
        existing.height === cached.result.height &&
        existing.image.equals(cached.image)
    ) {
        return { ...cached.result };
    }
    const plan = planMuralRender(entries);
    const textHash = createHash("sha256").update(plan.layout.text).digest("hex");
    if (
        existing &&
        existing.contentHash === textHash &&
        existing.width === plan.width &&
        existing.height === plan.height
    ) {
        // Unchanged: reuse the stored PNG (already the right bytes) without re-encoding.
        return rememberRender(db, projectIdentity, key, existing.image, {
            hasMural: true,
            dataUrl: `data:image/png;base64,${existing.image.toString("base64")}`,
            contentHash: existing.contentHash,
            rerendered: false,
            width: existing.width,
            height: existing.height,
        });
    }

    const rendered = renderPlannedMural(plan);
    upsertMural(db, {
        projectPath: projectIdentity,
        image: Buffer.from(rendered.png),
        // content_hash is the TEXT hash (the change-detection key), not a PNG
        // hash: identical text always yields identical PNG bytes, and hashing the
        // text is what lets the unchanged-pool fast path above skip re-encoding.
        contentHash: textHash,
        renderedAt: Date.now(),
        model: DETERMINISTIC_MURAL_MODEL,
        memoryIds: rendered.renderedIds,
        width: rendered.width,
        height: rendered.height,
    });

    return rememberRender(db, projectIdentity, key, Buffer.from(rendered.png), {
        hasMural: true,
        dataUrl: rendered.dataUrl,
        contentHash: textHash,
        rerendered: true,
        width: rendered.width,
        height: rendered.height,
    });
}

/** True only when the given model's cached provider metadata accepts images. A
 *  model key is `provider/model`; unknown capability means no image.
 *  Pi-native prefixes (`openai-codex/…`, `google-antigravity/…`) are translated
 *  to the canonical OpenCode form before the models.dev lookup so both harnesses
 *  share one vision gate. Missing cache entries fail closed (no image). */
export function modelKeyAcceptsImages(modelKey: string | undefined): boolean {
    if (!modelKey) return false;
    // FORK ADAPTATION (Step 15): the vision lookup itself is injected — upstream
    // reads the models.dev apiCache, which has zero producers in this fork. The
    // pi-native canonicalization stays upstream verbatim: the host's static
    // catalog is keyed by the canonical OpenCode form, so both harnesses share
    // one vision gate. Unknown capability (no probe / probe says false) = no
    // image, which is upstream's own fail-closed direction.
    const canonical = piModelRefToCanonical(modelKey);
    return muralVisionProbe?.(canonical) === true;
}

/**
 * Resolve the mural WIRE options for the m0 injection path: gate on the mural
 * feature flag AND the outgoing model's vision capability, then ensure the
 * deterministic mural is rendered and return its data URL + content hash. This
 * is the on-demand render trigger — called from the HARD-fold materialization so
 * the injected data-url only swaps on a natural fold (defer passes replay the
 * baked-in bytes), matching the existing inject-compartments cache rule.
 *
 * Returns `{ enabled: false }` (no image) when the feature is off, the model
 * can't take images, or the cue pool is empty.
 */
export function resolveMuralWire(
    db: Database,
    projectIdentity: string | undefined,
    modelKey: string | undefined,
    enabled: boolean,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
): MuralWireOptions {
    if (!enabled || !projectIdentity || !modelKeyAcceptsImages(modelKey)) {
        return { enabled, supportsVision: false };
    }
    const result = ensureMuralRendered(db, projectIdentity, budgetTokens);
    if (!result.hasMural) return { enabled: true, supportsVision: true };
    return {
        enabled: true,
        supportsVision: true,
        dataUrl: result.dataUrl,
        contentHash: result.contentHash,
    };
}
