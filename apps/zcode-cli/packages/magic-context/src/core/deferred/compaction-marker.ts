// FORK-DEFERRED(S20): `features/magic-context/compaction-marker.ts` 的 compareOpenCodeMessagesByCanonicalOrder 摘录，Step 20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. `compaction-marker.ts` is 1083 lines of
// OpenCode-DB marker row CRUD (`listSessionCompactionMarkers`,
// `replaceCompactionMarker`, `removeCompactionMarker`, …) plus a
// `harnessOwnsOpenCodeStore` gate. ZCode owns its own session store and never
// writes OpenCode compaction markers, so the whole module is C-group surface.
//
// WHAT THE B GROUP REACHES. `transform-postprocess-phase.ts:1341` calls
// `compareOpenCodeMessagesByCanonicalOrder` to decide whether a persisted
// compaction marker already reflects a pending one. The comparator reads the
// OpenCode store; with no OpenCode store there is no row to read, so the
// upstream function's own documented "unknown" answer — `null` — is what the
// seam returns. The single caller treats `null` as "cannot compare" and falls
// back to the ordinal equality branch, which is the conservative path (it
// re-applies the marker rather than skipping it).
//
// Step 20: delete this file and repoint
// `transform-postprocess-phase.ts` back at
// `../../features/magic-context/compaction-marker.js`.

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