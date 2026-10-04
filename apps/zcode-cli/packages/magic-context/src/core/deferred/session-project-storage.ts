// FORK-DEFERRED(S20): `features/magic-context/session-project-storage.ts` 的 recordSessionProjectIdentity / hasRecordedSessionProjectIdentity 摘录，Step 20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The module also owns the mis-scoped
// compartment-chunk-embedding repair (`findMisScopedCompartmentChunkEmbeddingIdsForProject`,
// `repairMisScopedCompartmentChunkEmbeddingsForProject`), which belongs to the C
// group's embedding backfill. The two session→project binding statements the B
// group reaches touch only `session_projects`, a table the A group already
// creates (`storage-db.ts:1641`), so they are reproduced verbatim.
//
// NOT reproduced: the `compartment_chunk_embeddings` repair statements. They run
// inside `recordSessionProjectIdentity` upstream, but this fork performs no
// embedding backfill, so there are no chunk rows to re-stamp.
//
// Step 20: delete this file and repoint `transform.ts` back at
// `../../features/magic-context/session-project-storage.js`.

import { isUserHomeDirectory } from "../features/magic-context/memory/project-identity.js";
import { getHarness } from "../shared/harness.js";
import type { Database, Statement as PreparedStatement } from "../shared/sqlite.js";

const SESSION_CHUNK_REPAIR_BATCH_SIZE = 100;

const upsertSessionProjectStatements = new WeakMap<Database, PreparedStatement>();
const repairSessionChunkProjectStatements = new WeakMap<Database, PreparedStatement>();

function getUpsertSessionProjectStatement(db: Database): PreparedStatement {
    let stmt = upsertSessionProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id, harness) DO UPDATE SET
                 project_path = excluded.project_path,
                 updated_at = excluded.updated_at
             WHERE session_projects.project_path <> excluded.project_path`,
        );
        upsertSessionProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getRepairSessionChunkProjectStatement(db: Database): PreparedStatement {
    let stmt = repairSessionChunkProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `UPDATE compartment_chunk_embeddings
             SET project_path = ?
             WHERE id IN (
                 SELECT id
                 FROM compartment_chunk_embeddings
                 WHERE session_id = ?
                   AND harness = ?
                   AND project_path <> ?
                   LIMIT ?
             )`,
        );
        repairSessionChunkProjectStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Persist the immutable session→project binding resolved from the host session.
 * Chunk backfills use this mapping as the project-scope authority: without it, a
 * project-wide drain cannot safely distinguish same-process sessions from other
 * projects and must not stamp arbitrary compartments with its own identity.
 *
 * Verbatim: `session-project-storage.ts:86-116`.
 */
export function recordSessionProjectIdentity(
    db: Database,
    sessionId: string,
    projectPath: string | undefined,
): void {
    if (!sessionId || !projectPath) return;
    // A session started exactly at the user's home directory is not a project.
    // The guard is repeated here because background backfills can call this
    // function without passing through the transform resolver.
    if (
        !projectPath.startsWith("git:") &&
        !projectPath.startsWith("dir:") &&
        isUserHomeDirectory(projectPath)
    )
        return;
    const harness = getHarness();
    const now = Date.now();
    db.transaction(() => {
        getUpsertSessionProjectStatement(db).run(sessionId, harness, projectPath, now);
        // Repair a bounded slice of chunks stamped with a project other than the
        // session's recorded owner. Repeated observations resume the repair
        // without making transform wait on an unbounded update. A no-op in this
        // fork (no embedding backfill), kept so the statement cache stays warm
        // for the fork's own future backfill.
        getRepairSessionChunkProjectStatement(db).run(
            projectPath,
            sessionId,
            harness,
            projectPath,
            SESSION_CHUNK_REPAIR_BATCH_SIZE,
        );
    }).immediate();
}

/**
 * Whether a project binding has been stored for this session. Bindings are
 * stored only from a directory the host returned for the session. A session
 * without one has only ever been rendered with the directory OpenCode was
 * launched from, which the transform falls back to when the host gives none.
 *
 * Verbatim: `session-project-storage.ts:124-129`.
 */
export function hasRecordedSessionProjectIdentity(db: Database, sessionId: string): boolean {
    const row = db
        .prepare("SELECT 1 AS found FROM session_projects WHERE session_id = ? AND harness = ?")
        .get(sessionId, getHarness()) as { found: number } | null;
    return row?.found === 1;
}