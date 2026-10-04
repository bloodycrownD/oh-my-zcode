// FORK-DEFERRED(Batch2): `features/magic-context/user-memory/storage-user-memory.ts` 的 UserMemorySourceProvenance / UserMemory 类型与 getActiveUserMemories 摘录，Step 31 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. User memories are the cross-session profile the
// historian promotes session facts into. Batch 2 (memory) is not in the fork's
// first version, and nothing writes these rows.
//
// SEMANTIC DECISION — `getActiveUserMemories` returns `[]`, never throws. The
// call site (`inject-compartments.ts:2057-2064`, `safeGetActiveUserMemories`)
// already wraps the read in a try/catch that swallows only
// `no such table: user_memories` and rethrows everything else — so a stub that
// threw would fail the transform pass on the one code path the fork has no
// business taking. `[]` is the truthful answer ("no promoted profile exists") and
// drives the consumer at `:2268` (`renderUserProfileBlock`) to emit no
// `<user-profile>` block, which is what a fork with no user-memory feature must
// serve. The A group DOES create `user_memories` and `user_memory_candidates`
// (`migrations.ts:388, 398`), so the table exists and an empty read is honest
// rather than a schema workaround.
//
// `UserMemory` is reproduced verbatim because `inject-compartments.ts` threads
// it through the m0/m1 render types.
//
// Step 31: delete this file and repoint `inject-compartments.ts` back at
// `../../features/magic-context/user-memory/storage-user-memory.js`.

import type { Database } from "../shared/sqlite.js";

/** Verbatim: `storage-user-memory.ts:21-26`. */
export interface UserMemorySourceProvenance {
    candidateId: number;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
}

/** Verbatim: `storage-user-memory.ts:28-37`. */
export interface UserMemory {
    id: number;
    content: string;
    status: "active" | "dismissed";
    promotedAt: number;
    sourceCandidateIds: number[];
    sourceProvenance: UserMemorySourceProvenance[] | null;
    createdAt: number;
    updatedAt: number;
}

/** Verbatim signature: `storage-user-memory.ts:195`. Always empty — see the header note. */
export function getActiveUserMemories(_db: Database): UserMemory[] {
    return [];
}