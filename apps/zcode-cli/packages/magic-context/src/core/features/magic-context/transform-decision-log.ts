// FORK-NOTE(S20): upstream `features/magic-context/transform-decision-log.ts`
// (527 lines) with the durable writer removed. This file now lives at its
// upstream path and is the REAL transform-decision module.
//
// WHAT IS VERBATIM. The pure reason-normaliser
// (`normalizeMaterializeReason`) and the two in-memory pending-decision
// accessors (`recordPendingTransformDecision`,
// `clearOpenCodePendingTransformDecision`), plus the
// `TransformSchedulerDecision` / `CanonicalMaterializeReason` /
// `PendingTransformDecision` shapes they thread.
//
// WHAT IS STILL ABSENT. Upstream also owns the `transform_decisions` durable
// writer: a side-car SQLite connection keyed by message id, plus its retention
// prune. Landing the historian did not change this — the historian's own
// attribution log is `historian_runs` (`storage-historian-runs.ts`, A group),
// and the `transform_decisions` rows describe the *transform pass's* own
// materialisation decision, which nothing in the fork writes. The A group does
// create the `transform_decisions` table (`migrations.ts`), so this is an
// ownership gap, not a schema one — a host that wants the side-car writer can
// add it back against a live table.
//
// The re-export below exists so a Step-20+ host can type a decision against the
// same unions the normaliser produces.

import type { ContextUsage, SchedulerDecision, SessionMeta } from "./types.js";

/** Verbatim: `transform-decision-log.ts:5`. */
export type TransformDecisionHarness = "opencode" | "pi";

/** Verbatim: `transform-decision-log.ts:6-13`. */
export type TransformSchedulerDecision =
    | "execute"
    | "defer"
    | "error"
    | "need_full_sync"
    | "parked"
    | "passthrough"
    | "unknown";

/** Verbatim: `transform-decision-log.ts:23-41`. */
export type CanonicalMaterializeReason =
    | "system_hash"
    | "model_change"
    | "project_memory_epoch"
    | "ttl_idle"
    | "explicit_flush"
    | "max_mutation_id"
    | "first_render"
    | "pressure_refold"
    | "upgrade_state"
    | "cached_m1_missing"
    | "project_change"
    | "compartment_render_epoch"
    | "m1_delta"
    | "ttl_expiry"
    | "epoch_change"
    | "coverage_fold"
    | "profile_transition"
    | "host_compaction";

/** Verbatim: `transform-decision-log.ts:43-90`. */
export interface PendingTransformDecision {
    tsMs: number;
    decision: TransformSchedulerDecision;
    materialized: boolean;
    materializeReason: CanonicalMaterializeReason | null;
    /**
     * `transform_decisions.system_hash_prev`: cached operand from a system-hash
     * comparison. NULL means this pass made no system-hash comparison; an empty
     * string is a real compared cached value and must remain distinct from NULL.
     */
    systemHashPrev: string | null;
    /**
     * `transform_decisions.system_hash_new`: live operand from a system-hash
     * comparison. NULL means this pass made no system-hash comparison.
     */
    systemHashNew: string | null;
    /**
     * `transform_decisions.m0_model_key_prev`: cached canonical model-key operand.
     * NULL means this pass made no model-key comparison; an empty string is a real
     * compared cached value and must remain distinct from NULL.
     */
    m0ModelKeyPrev: string | null;
    /**
     * `transform_decisions.m0_model_key_new`: live canonical model-key operand.
     * NULL means this pass made no model-key comparison.
     */
    m0ModelKeyNew: string | null;
    /**
     * `transform_decisions.m0_tool_set_hash_prev`: cached tool-set operand from an
     * observed comparison. NULL means this pass made no tool-set comparison; an
     * empty string is a real compared cached value.
     */
    m0ToolSetHashPrev?: string | null;
    /**
     * `transform_decisions.m0_tool_set_hash_new`: live tool-set operand from an
     * observed comparison. NULL means this pass made no tool-set comparison.
     */
    m0ToolSetHashNew?: string | null;
    emergency: boolean;
    /**
     * Nonnegative estimate persisted as `transform_decisions.dropped_tokens` for
     * diagnostics only. It does not drive budgeting or scheduler decisions.
     */
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    bustedThisPass: boolean;
}

/** Verbatim: `transform-decision-log.ts:104-135`. */
const canonicalReasons = new Set<string>([
    "system_hash",
    "model_change",
    "project_memory_epoch",
    "ttl_idle",
    "explicit_flush",
    "max_mutation_id",
    "first_render",
    "pressure_refold",
    "upgrade_state",
    "cached_m1_missing",
    "project_change",
    "compartment_render_epoch",
    "m1_delta",
    "ttl_expiry",
    "epoch_change",
    "coverage_fold",
    "profile_transition",
    "host_compaction",
]);

const piReasonAliases: Record<string, CanonicalMaterializeReason> = {
    project_memory_change: "project_memory_epoch",
    pending_mutations: "max_mutation_id",
    renderer_upgrade: "upgrade_state",
    cache_invalid: "cached_m1_missing",
    drift: "pressure_refold",
};

const sharedReasonAliases: Record<string, CanonicalMaterializeReason> = {
    model_key: "model_change",
    pressure: "pressure_refold",
};

/** Verbatim: `transform-decision-log.ts:138`. */
const pendingDecisionBySession = new Map<string, PendingTransformDecision>();

/** Verbatim: `transform-decision-log.ts:151-171`. */
export function normalizeMaterializeReason(
    harness: TransformDecisionHarness,
    reason: string | null | undefined,
    rematerialized: boolean,
): CanonicalMaterializeReason | null {
    const raw = typeof reason === "string" ? reason.trim() : "";
    if (raw.length > 0) {
        const alias =
            sharedReasonAliases[raw] ??
            (harness === "pi" ? piReasonAliases[raw] : undefined) ??
            undefined;
        if (alias) return alias;
        if (canonicalReasons.has(raw)) return raw as CanonicalMaterializeReason;
        return null;
    }

    // OpenCode's pressure refold flips rematerialized=true without changing
    // mustMaterialize().reason. Pi records the same path as "drift" above, but
    // keep this fallback for cross-harness parity and future callers.
    return rematerialized ? "pressure_refold" : null;
}

/** Verbatim: `transform-decision-log.ts:220-222`. */
export function clearOpenCodePendingTransformDecision(sessionId: string): void {
    pendingDecisionBySession.delete(sessionId);
}

/** Verbatim: `transform-decision-log.ts:231-240`. */
export function recordPendingTransformDecision(
    sessionId: string,
    decision: PendingTransformDecision,
): void {
    if (!decision.bustedThisPass) {
        pendingDecisionBySession.delete(sessionId);
        return;
    }
    pendingDecisionBySession.set(sessionId, decision);
}

/**
 * Re-exported so a Step-20 host can type a decision against the same unions the
 * normaliser produces. Declared `import type`-only to avoid a value cycle with
 * `types.ts` (which this file does not otherwise need).
 */
export type { ContextUsage, SchedulerDecision, SessionMeta };