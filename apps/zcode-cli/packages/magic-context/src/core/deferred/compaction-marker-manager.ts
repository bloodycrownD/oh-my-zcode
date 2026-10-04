// FORK-DEFERRED(S20): `hooks/magic-context/compaction-marker-manager.ts` 的 MARKER_SUMMARY_TEXT / MarkerUpdateOutcome / applyDeferredCompactionMarker / reconcileForkOrphanedCompactionMarkers / updateCompactionMarkerAfterPublication 摘录，Step 20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The manager coordinates OpenCode compaction
// marker rows (`replaceCompactionMarker`, `listSessionCompactionMarkers`,
// `removeMcOwnedCompactionMarkers`) with historian publication. ZCode owns its
// own store and never writes OpenCode markers, so the row-mutating half is
// C-group surface.
//
// SEMANTIC DECISION — the drain reports "nothing to do". `applyDeferredCompactionMarker`
// is called from the postprocess pending-marker drain. Every upstream outcome
// (`applied` / `already-current` / `stale-skip`) makes the caller
// CAS-clear the pending blob and continue; only `retryable-failure` keeps it.
// This seam returns `stale-skip`, i.e. the "target is gone or superseded"
// outcome: with no OpenCode marker rows there is by definition nothing to move
// the boundary to, so the pending blob is cleared and the pass continues. This
// is the outcome that cannot wedge the drain (a `retryable-failure` would keep
// re-entering it forever) and cannot fabricate a boundary the host never wrote.
// The seam is deliberately NOT silent-throwing: the drain's switch statement has
// no default arm, so a throw would escape the transform pass entirely.
//
// `reconcileForkOrphanedCompactionMarkers` returns `{removed: 0, failed: false}`
// — literally upstream's own early return for a non-`opencode` harness
// (`compaction-marker-manager.ts:542-544`); the fork's harness id is `zcode`, so
// the upstream body would take that same arm.
//
// Step 20: delete this file and repoint
// `transform-postprocess-phase.ts`, `transform.ts` and
// `transform-compartment-phase.ts` back at
// `./compaction-marker-manager.js`.

import type { Database } from "../shared/sqlite.js";
import type { PendingCompactionMarker } from "../features/magic-context/storage-meta-persisted.js";

/** Verbatim: `compaction-marker-manager.ts:52-53`. */
export const MARKER_SUMMARY_TEXT =
    "[Compacted by magic-context — session history is managed by the plugin]";

/**
 * Verbatim: `compaction-marker-manager.ts:181-196`.
 *
 * `retryable-failure` carries an `error` (not a `reason`): both drain sites
 * persist it as `lastInjectError` and log it, so the member name is load-bearing
 * and is preserved exactly.
 */
export type MarkerUpdateOutcome =
    | {
          kind: "applied";
          markerOrdinal: number;
      }
    | { kind: "already-current" }
    | {
          kind: "stale-skip";
          reason: "compartment-boundary-gone" | "superseded-by-later-publication";
      }
    | { kind: "retryable-failure"; error: Error };

/** Verbatim: `compaction-marker-manager.ts:238-242`. */
export interface TrustedMaterializedCompactionBoundary {
    rowVersion: number;
    ordinal: number;
    endMessageId: string;
}

/** Verbatim: `compaction-marker-manager.ts:214-216`. */
export interface OrphanMarkerReconcileResult {
    removed: number;
    failed: boolean;
}

/**
 * Apply a deferred compaction-marker mutation owned by a specific pending blob.
 *
 * The seam's whole body is `stale-skip`; see the header note for why.
 * Signature and parameter list are verbatim from
 * `compaction-marker-manager.ts:244-250`.
 */
export function applyDeferredCompactionMarker(
    _db: Database,
    _sessionId: string,
    _pending: PendingCompactionMarker,
    _directory?: string,
    _trustedBoundary?: TrustedMaterializedCompactionBoundary,
): MarkerUpdateOutcome {
    return { kind: "stale-skip", reason: "compartment-boundary-gone" };
}

/**
 * Fork-orphan compaction-marker hygiene. This is upstream's own non-`opencode`
 * early return (`compaction-marker-manager.ts:542-544`).
 */
export function reconcileForkOrphanedCompactionMarkers(
    _db: Database,
    _sessionId: string,
): OrphanMarkerReconcileResult {
    return { removed: 0, failed: false };
}

/**
 * After historian publishes new compartments, inject or move the compaction
 * marker. Only moves the boundary forward; summary text is a static placeholder.
 *
 * Signature verbatim from `compaction-marker-manager.ts:370-375`. No fork caller
 * invokes it (the historian publish path is C group); it exists because
 * `compartment-runner-types.ts` and `transform.ts` name it in a
 * `compactionMarkerStrategy.publish` slot.
 */
export function updateCompactionMarkerAfterPublication(
    _db: Database,
    _sessionId: string,
    _lastCompartmentEnd: number,
    _directory?: string,
): boolean {
    return false;
}