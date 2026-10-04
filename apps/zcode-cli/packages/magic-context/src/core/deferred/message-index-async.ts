// FORK-DEFERRED(S20): `features/magic-context/message-index-async.ts` 的 MessageReconciliationSource / scheduleReconciliation 摘录，Step 20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The reconciler rebuilds the FTS
// `message_history_index` from the raw session store. That index is C group
// (Step 20) alongside the rest of the message-index family; the fork's
// `storage-db.ts` does not create the FTS tables, so there is nothing to
// reconcile into.
//
// SEMANTIC DECISION — the schedule is a no-op. The single call site
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
// and `resolveTransformHostSeams`, which a host adapter will supply.
//
// Step 20: delete this file and repoint `transform.ts` back at
// `../../features/magic-context/message-index-async.js`.

import type { RawMessage } from "../hooks/magic-context/read-session-raw.js";
import type { Database } from "../shared/sqlite.js";

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