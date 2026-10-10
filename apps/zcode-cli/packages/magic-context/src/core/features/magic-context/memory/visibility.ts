// FORK-NOTE(Step 8 / bugfix-batch-20261011): upstream
// `features/magic-context/memory/visibility.ts` (7 lines) — NEW PORT
// (deferred had no seam for this file).
//
// Why it is needed: `storage-memory.ts`'s workspace filter
// (`buildWorkspaceMemorySqlFilter`) threads this SQL into every
// cross-project SELECT so render, delta, search and revocation share one
// visibility rule. It is a constant, not a module with dependencies.
/**
 * Canonical foreign-memory visibility predicate. Keep this text byte-identical to
 * mc-store's FOREIGN_VISIBLE_SQL so render, delta, search, and revocation use one rule.
 */
export const FOREIGN_VISIBLE_SQL =
    "status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > :now_ms) AND shareable = 1 AND scope IN ('project','ecosystem','universe') AND category IN (SELECT value FROM json_each(:share_categories)) AND project_path IN (SELECT project_path FROM workspace_members WHERE workspace_id = :workspace_id) AND project_path <> :reader_project";
