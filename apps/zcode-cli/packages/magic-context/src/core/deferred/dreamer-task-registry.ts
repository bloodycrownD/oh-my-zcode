// FORK-NOT-PORTED(N3 终局 / Step 17 / bugfix-batch-20261011): `features/magic-context/dreamer/task-registry.ts` 的 DreamTaskName / CurateMemoryCategory / DreamTaskProgress 类型摘录，N3 终局不做，保留本壳并以此头注登记
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
// names are needed here; N3 终局不做（Step 17）后该文件不会归位，两个 union
// 保持裁剪态。
//
// N3 终局裁定（spec Step 17，不做）：dreamer 后台整理终局不做——理由=上游 cron
// 型后台记忆整理，ZCode agent 进程无对应宿主（desktopCronScheduler 属 Electron
// main，不属 agent 进程）；不影响使用=记忆质量由 selection 排序 + 读时强化维持，
// 读写链完整、缺席不阻断。本壳保留（`live-session-state.ts` 的
// `dreamerProgressByProject` 值类型唯一载体），头注即终局登记；
// docs/.iteration-state.yaml bugfix-batch-20261011 节同步。

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