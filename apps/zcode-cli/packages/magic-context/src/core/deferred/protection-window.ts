/**
 * Deferred seam — `features/magic-context/protection-window.ts` (upstream).
 *
 * The protection window is D group (Step 21). The A group's
 * `storage-meta-persisted.ts` reads the snapshotted epoch floor from
 * `session_meta`; that single read is reproduced here verbatim.
 *
 * Step 21: delete this file and point `storage-meta-persisted.ts` back at
 * `./protection-window.js`.
 */

import type { Database } from "../shared/sqlite.js";

/**
 * Read the snapshotted epoch floor from session_meta.
 * On defer passes this module reads the snapshot and never recomputes the floor.
 */
export function readEpochFloorSnapshot(db: Database, sessionId: string): number | null {
    try {
        const row = db
            .prepare("SELECT protected_tokens_effective FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { protected_tokens_effective?: number | null } | undefined;
        if (
            row &&
            typeof row.protected_tokens_effective === "number" &&
            Number.isFinite(row.protected_tokens_effective)
        ) {
            return row.protected_tokens_effective;
        }
    } catch {
        // Table or column may not exist in pre-migration database
    }
    return null;
}
