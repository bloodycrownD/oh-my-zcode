// FORK-DEFERRED(Batch2): `features/magic-context/memory/storage-memory.ts` 的 getMemoriesByProject / getMemoriesByProjects / getMaxMemoryIdForProjects 摘录，Step 31 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. Batch 2 (memory) is not in the fork's first
// version: there is no `memories` table in the A group's schema, no write path,
// and no ctx_search tool. The B group nevertheless threads three reads through
// its memory plumbing, all of which are pure queries over that absent table.
//
// SEMANTIC DECISION — every read answers EMPTY, never throws. This is the
// S18-report risk #5 equivalence path, and it is the only safe answer:
//   - `getMemoriesByProject` → `[]`. `m0-token-breakdown.ts:131` and
//     `inject-compartments.ts`'s m0/m1 render both treat an empty memory set as
//     "no `<project-memory>` block", which is exactly what a fork with no memory
//     feature must serve. A throw here would fail the whole transform pass.
//   - `getMemoriesByProjects` → `[]`. Same reasoning; `inject-compartments.ts`
//     uses it only to feed the workspace-wide m0 selection, which an empty set
//     short-circuits.
//   - `getMaxMemoryIdForProjects` → `0`. This is the m0/m1 invalidation
//     watermark: "no memory has ever been written", the truthful answer when no
//     memory subsystem exists. Returning 0 keeps the cached baseline stable
//     across passes, which is the whole point of the watermark.
//
// Step 31: delete this file and repoint `inject-compartments.ts` and
// `m0-token-breakdown.ts` back at
// `../../features/magic-context/memory/storage-memory.js`.

import type { Database } from "../shared/sqlite.js";
import type { Memory, MemoryStatus } from "../features/magic-context/memory/types.js";

/**
 * Verbatim signature: `storage-memory.ts:694-723`. Always empty — see the
 * header note.
 */
export function getMemoriesByProject(
    _db: Database,
    _projectPath: string,
    _statuses: MemoryStatus[] = ["active", "permanent"],
    // Expiry cutoff. Defaults to live Date.now() for normal callers. The m[1]
    // render path passes a FROZEN cutoff (the m[0] materialization timestamp) so
    // defer passes render a byte-stable memory set.
    _expiryCutoff: number = Date.now(),
): Memory[] {
    return [];
}

/** Verbatim signature: `storage-memory.ts:798-806`. Always empty. */
export function getMemoriesByProjects(
    _db: Database,
    _projectPaths: readonly string[],
    _statuses: MemoryStatus[] = ["active", "permanent"],
    _expiryCutoff: number = Date.now(),
    _ownIdentities?: readonly string[],
    _shareCategories?: readonly string[] | null,
): Memory[] {
    return [];
}

/** Verbatim signature: `storage-memory.ts:879-886`. Always 0 ("nothing written"). */
export function getMaxMemoryIdForProjects(
    _db: Database,
    _projectPaths: readonly string[],
    _ownIdentities?: readonly string[],
    _shareCategories?: readonly string[] | null,
    _expiryCutoff: number = Date.now(),
): number {
    return 0;
}