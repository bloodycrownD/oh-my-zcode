/**
 * Deferred seam — `features/magic-context/compartment-chunk-embedding.ts`
 * (upstream).
 *
 * Chunk embeddings are C group and the upstream module reaches the embedding
 * providers (`@cortexkit/subc-client`), which this fork does not take. The A
 * group's `storage-session-tables.ts` only needs the per-session cleanup of the
 * recorded backoff/window keys, so that statement and its two key prefixes are
 * reproduced here verbatim.
 *
 * Step 20: delete this file and point `storage-session-tables.ts` back at
 * `./compartment-chunk-embedding.js`.
 */

import type { Database } from "../shared/sqlite.js";

const BACKOFF_PREFIX = "chunk_embed_backoff:";
const WINDOW_SOURCE_PREFIX = "chunk_embed_windows:";

/** Also removes the session's recorded window sources (see recordChunkWindowSource). */
export function deleteChunkEmbedBackoffForSession(db: Database, sessionId: string): void {
    db.prepare(`DELETE FROM schema_migrations_meta WHERE key IN (
        SELECT ? || id FROM compartments WHERE session_id = ?
        UNION ALL
        SELECT ? || id FROM compartments WHERE session_id = ?
    )`).run(BACKOFF_PREFIX, sessionId, WINDOW_SOURCE_PREFIX, sessionId);
}
