// FORK-NOTE(S20): upstream `hooks/magic-context/compaction-marker-manager.ts`
// (735 lines) with the OpenCode marker-row half removed. This file now lives at
// its upstream path and is the REAL manager — and it IS called on the historian
// publish path now, via
// `updateCompactionMarkerAfterPublication` (the `compactionMarkerStrategy.publish`
// slot in `compartment-runner-types.ts`).
//
// WHY THE ROW-MUTATING HALF IS NOT PORTED. Upstream coordinates OpenCode
// compaction marker rows (`replaceCompactionMarker`,
// `listSessionCompactionMarkers`, `removeMcOwnedCompactionMarkers`) with historian
// publication. Per the spec's "明确不搬" list, `compaction-marker*` is replaced by
// D-7's removal logic: ZCode owns its own session store, never writes OpenCode
// markers, and its context boundary is the compartment boundary the historian
// publishes — recorded in `compartments` + `session_meta`, not in an OpenCode
// `compaction` part row. So the *row* half is dead code here, while the
// *coordination* half below is live: it is what the publish path calls, and what
// the postprocess pending-marker drain calls.
//
// SEMANTIC DECISION — the drain reports "nothing to do".
// `applyDeferredCompactionMarker` is called from the postprocess pending-marker
// drain. Every upstream outcome (`applied` / `already-current` / `stale-skip`)
// makes the caller CAS-clear the pending blob and continue; only
// `retryable-failure` keeps it. Returning `stale-skip` — the "target is gone or
// superseded" outcome — is therefore the only answer that cannot wedge the drain
// (a `retryable-failure` would keep re-entering it forever) and cannot fabricate
// a boundary the host never wrote. It is deliberately NOT a silent throw: the
// drain's switch statement has no default arm, so a throw would escape the
// transform pass entirely.
//
// `reconcileForkOrphanedCompactionMarkers` returns `{removed: 0, failed: false}`
// — literally upstream's own early return for a non-`opencode` harness
// (`compaction-marker-manager.ts:542-544`); the fork's harness id is `zcode`, so
// the upstream body would take that same arm.
//
// `updateCompactionMarkerAfterPublication` returns `false` for the same reason:
// there is no OpenCode marker row to move. The compartments still publish — the
// caller treats a `false` return as "the marker catches up on a later
// publication", never as a reason to roll back.

import type { Database } from "../../shared/sqlite.js";
import type { PendingCompactionMarker } from "../../features/magic-context/storage-meta-persisted.js";

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
 * Signature verbatim from `compaction-marker-manager.ts:370-375`. This IS on the
 * fork's historian publish path — `compartment-runner-incremental.ts` calls it
 * through the `compactionMarkerStrategy.publish` slot (or the direct import when
 * no strategy is injected). It returns `false` because the fork has no OpenCode
 * marker row to move; see the header note for why that is a settled outcome
 * rather than a gap.
 */
export function updateCompactionMarkerAfterPublication(
    _db: Database,
    _sessionId: string,
    _lastCompartmentEnd: number,
    _directory?: string,
): boolean {
    return false;
}