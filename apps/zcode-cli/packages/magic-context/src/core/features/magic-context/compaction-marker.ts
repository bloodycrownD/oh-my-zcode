// FORK-NOTE(S20): upstream `features/magic-context/compaction-marker.ts` with
// the OpenCode-only half removed. This file now lives at its upstream path and
// is the REAL module for the fork — but the fork keeps it this small on purpose,
// and this is the spec decision that makes that correct rather than an omission.
//
// WHY THE MODULE IS NOT PORTED IN FULL. Upstream is 1083 lines of OpenCode-DB
// marker row CRUD (`listSessionCompactionMarkers`, `replaceCompactionMarker`,
// `removeCompactionMarker`, `removeMcOwnedCompactionMarkers`, …) behind a
// `harnessOwnsOpenCodeStore` gate. The spec's "明确不搬" list names
// `compaction-marker*` explicitly: D-7 removes native compaction outright, and
// the magic-context fork's boundary marker is the compartment boundary the
// historian publishes — not a row in an OpenCode `compaction` part table. ZCode
// owns its own session store and never writes OpenCode markers, so every one of
// those row mutations would be dead code.
//
// WHAT SURVIVES, and why its `null` is the load-bearing answer.
// `compareOpenCodeMessagesByCanonicalOrder` compares two OpenCode messages by
// canonical store order. Upstream's body calls `getNonSummaryMessageSortKey`,
// which opens the OpenCode session DB; with no OpenCode store both keys are
// unconditionally absent, so the function returns its own documented
// "not comparable" value. `transform-postprocess-phase.ts` treats `null` as
// "cannot compare" and falls back to the ordinal-equality branch — the
// conservative path, which re-applies the marker rather than skipping it. That
// is also what the historian's publish path wants: it records the compartment
// boundary by ordinal and message id, never by OpenCode store position.

/**
 * Compare two OpenCode messages by canonical store order (time_created, then
 * id). Returns `null` when either message is absent from the store, so the
 * caller can distinguish "not comparable" from "equal".
 *
 * Verbatim shape of `compaction-marker.ts:314-327`. The upstream body calls
 * `getNonSummaryMessageSortKey`, which opens the OpenCode session DB; this fork
 * has no OpenCode store, so both keys are unconditionally absent and the
 * function returns its own "cannot compare" value.
 */
export function compareOpenCodeMessagesByCanonicalOrder(
    _sessionId: string,
    _leftMessageId: string,
    _rightMessageId: string,
): number | null {
    return null;
}