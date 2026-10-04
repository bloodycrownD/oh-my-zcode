// FORK-NOTE(S20): upstream `features/magic-context/store-generation-rebase.ts`
// (1432 lines) with the rebase walk removed. This file now lives at its upstream
// path and is the REAL coordinate-generation module.
//
// WHAT IS VERBATIM. `readCoordinateGeneration` — one SELECT over
// `session_meta.coordinate_generation`, and that column is part of the A group's
// schema — plus the `CoordinateGeneration` union and the outcome shape.
//
// WHAT IS STILL ABSENT, and why. The rebase re-derives every saved coordinate
// when the host switches message-table projections (`message`/`part` →
// `session_message`); its `rebaseSteps` walk over compartments, tags and the
// message index is C-group machinery that drives the FTS reconciler, which the
// fork still does not have (see `message-index-async.ts`). `recompSteps` and
// `recoverUnresolvedCompartments` ride on the same walk. Landing the historian
// did not change this: ZCode serves exactly ONE projection of the session
// store, so there is nothing to switch between.
//
// SEMANTIC DECISION — `readCoordinateGeneration` is real, the rebase THROWS.
// Its single call site (`transform.ts:756-778`) is already guarded by
// `deps.storeGeneration !== undefined`, wrapped in try/catch, and funnels a
// throw into `failPass("store-generation-rebase-failure", …)` — i.e. upstream's
// own contract for "the rebase could not run". A ZCode host never sets
// `storeGeneration`, so the branch is dead in the fork; if a host ever does set
// it, throwing routes the pass through the documented fail-closed path instead
// of silently serving stale coordinates. Returning a fake `unchanged` outcome
// would be the one answer that is actively wrong. This is the same reason the
// historian's compartments carry a `rebase_status` column that the fork only
// ever writes as `ok`: an `unresolved` row is unreachable, and the read paths
// already exclude it defensively.

import type { Database } from "../../shared/sqlite.js";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw.js";

/**
 * Which projection of the OpenCode store a session's saved coordinates were
 * derived against. `v1` is the `message`/`part` reader, `v2` is the
 * `session_message` reader.
 *
 * Verbatim: `store-generation-rebase.ts:21`.
 */
export type CoordinateGeneration = "v1" | "v2";

/**
 * Verbatim: `store-generation-rebase.ts:23-42`, trimmed to the members a caller
 * reads. `rebaseSteps`'s walk over compartments, tags and the message index is
 * C-group machinery and is not reproduced.
 */
export interface StoreGenerationRebaseOutcome {
    /**
     * `unchanged` — the session's recorded projection already matches the running
     *  host, so nothing was read or written.
     *  `stamped` — the projection was recorded for the first time (or changed) but
     *  no saved coordinate actually moved, so only the stamp was written.
     *  `rebased` — coordinates moved and were re-derived.
     *  `repaired` — the projection already matched, but unresolved compartments
     *  left behind by an older build were placed from their neighbours.
     */
    status: "unchanged" | "stamped" | "rebased" | "repaired";
    generation: CoordinateGeneration;
    previousGeneration: CoordinateGeneration | null;
    compartmentsRebased: number;
    compartmentsUnresolved: number;
    /** Compartments placed `ok` with at least one end taken from a neighbour. */
    compartmentsDerived: number;
    compartmentsResolvedAgain: number;
}

/**
 * Verbatim: `store-generation-rebase.ts:168-177`.
 */
export function readCoordinateGeneration(
    db: Database,
    sessionId: string,
): CoordinateGeneration | null {
    const row = db
        .prepare("SELECT coordinate_generation FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { coordinate_generation?: unknown } | null | undefined;
    const value = row?.coordinate_generation;
    return value === "v1" || value === "v2" ? value : null;
}

/** Verbatim: the argument shape of `store-generation-rebase.ts:761`. */
export interface RebaseSessionCoordinatesArgs {
    db: Database;
    sessionId: string;
    generation: CoordinateGeneration;
    readMessages: (sessionId: string) => RawMessage[];
}

/**
 * Re-derive a session's saved coordinates against the running host's projection.
 *
 * Signature verbatim from `store-generation-rebase.ts:761-763`. Throws: see the
 * header note — the caller routes this into its documented fail-closed path.
 */
export async function rebaseSessionCoordinatesAsync(
    _args: RebaseSessionCoordinatesArgs,
): Promise<StoreGenerationRebaseOutcome> {
    throw new Error(
        "FORK-NOTE(S20): store-generation-rebase walk not ported — the ZCode host serves a single message projection",
    );
}