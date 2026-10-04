// Verbatim port of upstream `hooks/magic-context/historian-no-fire-cause.ts`
// (Step 20, C group). Byte-for-byte; the module has no imports.
//
// WHY IT IS A CLOSED UNION AND NOT A STRING. The historian is fire-and-forget,
// so "it didn't run" is invisible unless the reason is recorded. These are the
// only acceptable answers, and `RUNNER_REFUSAL_CANONICAL_CAUSES` names the four
// that mean the RUNNER could not be resolved at all (as opposed to "the runner
// decided not to fire") — those four are the ones the scheduler surfaces as a
// configuration problem rather than as normal backpressure.

export const HISTORIAN_NO_FIRE_CAUSES = [
    "in_flight",
    "cheap_skip",
    "no_new_raw_history",
    "raw_history_unavailable",
    "redundancy_skip",
    "protected_tail",
    "below_proactive_floor",
    "below_min_chunk",
    "drain_budget",
    "missing_boundary_snapshot",
    "stale_boundary_snapshot",
    "invalid_chunk_coverage",
    "credential_unavailable",
    "provider_unknown",
    "model_unknown",
    "runner_resolution_failed",
] as const;

export type HistorianNoFireCause = (typeof HISTORIAN_NO_FIRE_CAUSES)[number];

export const RUNNER_REFUSAL_CANONICAL_CAUSES = [
    "credential_unavailable",
    "provider_unknown",
    "model_unknown",
    "runner_resolution_failed",
] as const satisfies readonly HistorianNoFireCause[];

export type RunnerRefusalCanonicalCause = (typeof RUNNER_REFUSAL_CANONICAL_CAUSES)[number];