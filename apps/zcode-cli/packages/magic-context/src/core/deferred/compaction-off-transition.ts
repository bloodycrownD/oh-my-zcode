// FORK-NOT-PORTED: `hooks/magic-context/compaction-off-transition.ts` 的 CompactionModeTransitionResult / McOwnedMarkerCleanupResult 类型与 reconcileCompactionMode / commitCompactionModeRecord 函数摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. Compaction-off mode (upstream issue #266) is the operator
// escape hatch for hosts where Magic Context must not own compaction at all. Its
// transition work is defined entirely in terms of OpenCode marker rows
// (`removeMcOwnedCompactionMarkers`) that this fork never writes, so there is
// nothing to clean up and nothing to reconcile.
//
// SEMANTIC DECISION — `reconcileCompactionMode` answers upstream's own
// `NO_TRANSITION` with `recordToWrite: "on"`, and `commitCompactionModeRecord`
// writes that record through the A group's own `setCompactionModeRecord`. This is
// NOT a no-op stub: it is upstream's documented steady state. Reasoning from the
// call site (`transform.ts:863-925`):
//
//   - `hasTransitionEffects` is computed from `recordToWrite !== null || notice !==
//     null || invalidatedM0Baseline || clearedCompartmentInProgress ||
//     historianCatchUpSignaled`. Answering `recordToWrite: "on"` with everything
//     else false/empty makes that expression FALSE, so the whole notice-delivery
//     and baseline-invalidation block is skipped and the pass falls straight
//     through — no notification, no `sendStatusNotification` result check, no
//     commit. That is upstream's own first-arm return for `no record + on`
//     (`compaction-off-transition.ts:192`), which is exactly the fork's state:
//     compaction is on and there is no prior transition.
//   - The write is not skipped silently: upstream writes "on" for a session that
//     has no record, so a ZCode host that flips `compaction.enabled` later still
//     finds a durable record to reconcile against rather than a NULL that would
//     read as "never configured".
//
// Throwing instead would be caught by `transform.ts`'s try/catch and turned into
// a `compaction-mode-transition-failure` pass degradation on EVERY pass.
//
// Step 21: delete this file and repoint `transform.ts` back at
// `./compaction-off-transition.js`, or — if compaction-off stays unsupported —
// delete the two imports and the surrounding block outright.

import {
    type CompactionModeRecord,
    getCompactionModeRecord,
    resolveCompactionModeRecord,
    setCompactionModeRecord,
} from "../features/magic-context/storage-meta-persisted.js";
import type { Database } from "../shared/sqlite.js";

/** Verbatim: `compaction-off-transition.ts`'s `McOwnedMarkerCleanupResult`. */
export interface McOwnedMarkerCleanupResult {
    verified: boolean;
    removedLineages: number;
    removedRows: number;
    retainedLineages: number;
}

/**
 * Verbatim shape: the result `reconcileCompactionMode` returns. Every member is
 * read by `transform.ts:872-924`.
 */
export interface CompactionModeTransitionResult {
    /** Durable record to write AFTER the transition work and notice, or null. */
    recordToWrite: CompactionModeRecord | null;
    /** Out-of-band notice text for the caller to deliver, or null. */
    notice: string | null;
    /** True when the cached m[0]/m[1] baseline must be dropped. */
    invalidatedM0Baseline: boolean;
    /** True when the historian catch-up signal was raised. */
    historianCatchUpSignaled: boolean;
    /** True when a stale compartmentInProgress flag was cleared. */
    clearedCompartmentInProgress: boolean;
    /** True when any durable state changed. */
    clearedSomething: boolean;
    /** Marker cleanup outcome, when the transition ran it. */
    markerCleanup?: McOwnedMarkerCleanupResult;
}

/** Verbatim: `compaction-off-transition.ts`'s `NO_TRANSITION`. */
const NO_TRANSITION: CompactionModeTransitionResult = {
    recordToWrite: null,
    notice: null,
    invalidatedM0Baseline: false,
    historianCatchUpSignaled: false,
    clearedCompartmentInProgress: false,
    clearedSomething: false,
};

/**
 * Reconcile a session's durable compaction-mode record against the boot-resolved
 * mode. See the header note: this always reports upstream's steady-state
 * "no transition, compaction on" outcome.
 *
 * Signature verbatim from `compaction-off-transition.ts:164-174`.
 */
export function reconcileCompactionMode(args: {
    db: Database;
    sessionId: string;
    /** Boot-resolved mode for this process. */
    compactionOff: boolean;
    /** False when historian.disable=true; conditions the on-transition signal. */
    historianRunnable: boolean;
    /** Pass-local session meta (drives the stale compartmentInProgress clear). */
    compartmentInProgress: boolean;
    cleanupMarkers?: (sessionId: string) => McOwnedMarkerCleanupResult;
}): CompactionModeTransitionResult {
    // A pending notice wins over a newly resolved configuration, mirroring
    // upstream's ordering (`compaction-off-transition.ts:178-187`). The fork never
    // stages a notice (see `deferred/send-session-notification.ts`), so this arm
    // is unreachable; it is kept so the durable record semantics stay identical if
    // a host ever supplies the notification seam.
    const stored = getCompactionModeRecord(args.db, args.sessionId);
    if (stored === "on_notice_pending") {
        return { ...NO_TRANSITION, recordToWrite: "on", notice: null };
    }
    return { ...NO_TRANSITION, recordToWrite: stored === null ? "on" : null };
}

/**
 * Commit the mode record AFTER transition work + notice emission. Kept
 * separate so the caller controls the at-least-once notice ordering.
 *
 * Verbatim: `compaction-off-transition.ts:353-359`.
 */
export function commitCompactionModeRecord(
    db: Database,
    sessionId: string,
    record: CompactionModeRecord,
): void {
    setCompactionModeRecord(db, sessionId, record);
}

// `resolveCompactionModeRecord` is re-exported so the seam's steady-state check
// can be tightened to upstream parity when the marker-cleanup arm is ported.
export { resolveCompactionModeRecord };