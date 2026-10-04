// FORK-NOT-PORTED: `features/magic-context/dreamer/task-registry.ts` 的 DreamTaskName / CurateMemoryCategory / DreamTaskProgress 类型摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. The dreamer is the background maintenance agent (map memories,
// curate, verify diffs, propose docs). It is C/E surface and the fork runs no
// dreamer child. `task-registry.ts` itself is the registry of canonical task
// names plus their progress/backlog shapes.
//
// The B group reaches exactly one member, as a type: `live-session-state.ts`
// declares a `dreamTaskProgressBySession` map whose value is `DreamTaskProgress`,
// and that map is process-local state the fork never writes (the only writer would
// be the dreamer task executor). Reproduced verbatim — two string unions and one
// five-field interface, both of which upstream declares in terms of each other.
//
// `DreamTaskName` and `CurateMemoryCategory` are declared here rather than
// imported because upstream imports `CurateMemoryCategory` from
// `../curate-category-rotation` (a dreamer module) and derives `DreamTaskName`
// from the `CANONICAL_DREAM_TASKS` table. Only the members the progress shape
// names are needed here; Step 21 replaces this file with the real module and the
// unions come back in full.
//
// Step 21: delete this file and repoint `live-session-state.ts` back at
// `../../features/magic-context/dreamer/task-registry.js`.

/** Verbatim member set of upstream's `CurateMemoryCategory`. */
export type CurateMemoryCategory =
    | "preference"
    | "pattern"
    | "correction"
    | "decision"
    | "gotcha";

/**
 * Verbatim member set of upstream's `CANONICAL_DREAM_TASKS` keys
 * (`task-registry.ts`'s `DreamTaskName`).
 */
export type DreamTaskName =
    | "map_memories"
    | "expire_memories"
    | "verify_diff"
    | "promote_primers"
    | "curate_category"
    | "docs_proposals"
    | "retrospective";

/** Process-local progress for the task currently applying a run chunk. */
export interface DreamTaskProgress {
    task: DreamTaskName;
    processed: number;
    total: number;
    startedAt: number;
    /** Curate's one-category scope. */
    category?: CurateMemoryCategory;
    /** Update/archive verdicts refused by host-side verification safety gates during the current run. */
    refused?: number;
}