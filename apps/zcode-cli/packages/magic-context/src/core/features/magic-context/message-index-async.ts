// FORK-NOTE(S20): upstream `features/magic-context/message-index-async.ts` with
// the FTS reconciliation body removed. This file now lives at its upstream path
// and is the REAL module for the fork's message-index async surface.
//
// WHY THE RECONCILER IS STILL EMPTY. The reconciler rebuilds the FTS
// `message_history_index` from the raw session store. That is C group (Step 20)
// alongside the rest of the message-index family — but the fork's
// `storage-db.ts` does not create the FTS tables, so there is nothing to
// reconcile INTO. Landing the historian does not change that: FTS-backed
// `ctx_search` is Batch 2 (Step 31), and it is what needs the index.
//
// SEMANTIC DECISION — the schedule stays a no-op. The single call site
// (`transform.ts:781-785`) fires and forgets: it wraps the call in
// `withoutSqliteTransformPass(...)` and discards the result, with no `.catch()`
// and no read of any return value. Returning immediately is therefore exactly
// equivalent to "the reconciliation finished and changed nothing indexable", and
// it is the only choice that cannot leave a half-written index behind a pass
// that believes it succeeded. The alternative (throwing) would propagate out of
// a fire-and-forget call whose result nobody inspects.
//
// The `MessageReconciliationSource` type is reproduced verbatim because
// `transform.ts` threads it through `TransformDeps.hostMessageReconciliationSource`
// and `resolveTransformHostSeams`, which a host adapter will supply — and the
// historian's own raw-message reads go through that same seam family
// (`host/raw-message-provider.ts`).

import type { RawMessage } from "../../hooks/magic-context/read-session-raw.js";
import type { Database } from "../../shared/sqlite.js";

/** Verbatim: `message-index-async.ts:94-102`. A CALLABLE type, not an object. */
export type FullReadMessages = ((sessionId: string) => RawMessage[]) & {
    readPage?: (
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
    ) => RawMessage[];
    getCount?: (sessionId: string) => number;
};

/** Verbatim: `message-index-async.ts:104-112`. */
export interface BoundedMessageReconciliationSource {
    readPage(
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
    ): RawMessage[];
    getCount(sessionId: string): number;
}

/** Verbatim: `message-index-async.ts:114`. */
export type MessageReconciliationSource = FullReadMessages | BoundedMessageReconciliationSource;

/**
 * Schedule a background reconciliation of the session's message index.
 *
 * Signature verbatim from `message-index-async.ts:232-236`. No-op in this fork:
 * see the header note.
 */
export function scheduleReconciliation(
    _db: Database,
    _sessionId: string,
    _readMessages: MessageReconciliationSource,
): void {
    return;
}