// FORK-NOTE(S20): upstream `hooks/magic-context/compartment-runner.ts` with the
// `/ctx-recomp` half removed. This file now lives at its upstream path and is the
// REAL entry point for the historian — the thing the transform's compartment
// phase calls, and the thing `createHistorianScheduler` drives.
//
// WHAT IS VERBATIM. The `ActiveCompartmentRun` shape and its `notificationSent`
// contract, the `activeRuns` map, `getActiveCompartmentRun`,
// `markActiveCompartmentRunPublished`, `registerActiveCompartmentRun`,
// `withPublishedCallback`, `startLeaseRenewal`, and `startCompartmentAgent`'s
// whole no-op/lease/publish-registration body — including the synchronous
// no-op de-registration at the bottom, which is what stops a historian that
// no-op'd from starving the same pass's queued drop ops.
//
// WHAT IS NOT HERE, and why it is not a hole. `executeContextRecompWithResult`
// / `executeContextRecomp` dispatch into `compartment-runner-partial-recomp.ts`
// and `compartment-runner-recomp.ts`. Those are the `/ctx-recomp` surface, and
// the spec REWRITES `/ctx-recomp` in Step 22 (TUI/CLI text snapshot) instead of
// porting the 578- and 779-line recomp bodies and their `recomp_*` staging
// tables. Until Step 22 lands, `/ctx-recomp` has no implementation — which is
// the same state the fork is in today, where `deferred/compartment-runner.ts`
// threw. What Step 20 changes is that the INCREMENTAL historian (the part the
// transform trigger and the background scheduler actually need) now runs.

import {
    acquireCompartmentLease,
    COMPARTMENT_LEASE_RENEWAL_MS,
    getCompartmentLeaseBlocker,
    releaseCompartmentLease,
    releaseCompartmentLeaseBestEffort,
    renewCompartmentLease,
} from "../../features/magic-context/compartment-lease.js";
import { isWrapupInProgress, updateSessionMeta } from "../../features/magic-context/storage-meta.js";
import { sessionLog } from "../../shared/logger.js";
import { withoutSqliteTransformPass } from "../../shared/sqlite.js";
import { runCompartmentAgent } from "./compartment-runner-incremental.js";
import type { HiddenCompartmentRunnerDeps } from "./compartment-runner-types.js";

/** Verbatim: `compartment-runner.ts:23-35`. */
export interface ActiveCompartmentRun {
    promise: Promise<void>;
    published: boolean;
    kind?: "incremental" | "recomp" | "wrapup" | "other";
    /**
     * Set to true once the 95%-emergency user-facing notification has been
     * dispatched for this run. Prevents the notification from re-firing on
     * every subsequent transform pass while the same compartment run is
     * still active — which would otherwise persist a fresh ignored user
     * message every pass and drive OpenCode's runLoop break condition false.
     */
    notificationSent?: boolean;
}

const activeRuns = new Map<string, ActiveCompartmentRun>();

/** Verbatim: `compartment-runner.ts:39-41`. */
export function getActiveCompartmentRun(sessionId: string): ActiveCompartmentRun | undefined {
    return activeRuns.get(sessionId);
}

/** Verbatim: `compartment-runner.ts:43-46`. */
export function markActiveCompartmentRunPublished(sessionId: string): void {
    const activeRun = activeRuns.get(sessionId);
    if (activeRun) activeRun.published = true;
}

/**
 * Register a compartment-state-mutating promise with the active-runs map.
 *
 * Use this to serialize background compressor runs against historian/recomp
 * runs: both read-modify-write compartment rows, and while SQLite serializes
 * individual statements it does NOT serialize multi-step update cycles. If a
 * historian starts while a background compressor is still running, either
 * side's final write can overwrite the other's work.
 *
 * The registered promise is cleared from activeRuns on settle so later passes
 * can start a new run. If a run is already registered for the session, the
 * caller is expected to have checked getActiveCompartmentRun() first and
 * bailed — this function will overwrite silently if called anyway, which is
 * the desired behavior for the retry path.
 *
 * Verbatim: `compartment-runner.ts:63-83`.
 */
export function registerActiveCompartmentRun(
    sessionId: string,
    promise: Promise<void>,
    kind: ActiveCompartmentRun["kind"] = "other",
): ActiveCompartmentRun {
    const activeRun: ActiveCompartmentRun = {
        promise: Promise.resolve(),
        published: false,
        kind,
    };
    const wrapped = promise.finally(() => {
        // Only clear if this is still the current entry (another run may have
        // replaced us if the caller overwrote; don't stomp the replacement).
        if (activeRuns.get(sessionId)?.promise === wrapped) {
            activeRuns.delete(sessionId);
        }
    });
    activeRun.promise = wrapped;
    activeRuns.set(sessionId, activeRun);
    return activeRun;
}

/** Verbatim: `compartment-runner.ts:85-93`. */
function withPublishedCallback<T extends HiddenCompartmentRunnerDeps>(deps: T): T {
    return {
        ...deps,
        onCompartmentStatePublished: (sid) => {
            markActiveCompartmentRunPublished(sid);
            deps.onCompartmentStatePublished?.(sid);
        },
    };
}

/** Verbatim: `compartment-runner.ts:95-115`. */
function startLeaseRenewal(
    deps: HiddenCompartmentRunnerDeps,
    holderId: string,
): ReturnType<typeof setInterval> {
    return setInterval(() => {
        try {
            if (!renewCompartmentLease(deps.db, deps.sessionId, holderId)) {
                sessionLog(
                    deps.sessionId,
                    "compartment lease renewal failed; publish will be skipped if holder is stale",
                );
            }
        } catch (err) {
            // A missed renewal is safe because the compartment lease has a five-minute TTL.
            sessionLog(
                deps.sessionId,
                `compartment lease renewal threw; publish will be skipped if holder is stale (${err instanceof Error ? err.message : String(err)})`,
            );
        }
    }, COMPARTMENT_LEASE_RENEWAL_MS);
}

/**
 * Historian work and its lease timers remain background work even when a pass
 * starts them.
 *
 * Verbatim: `compartment-runner.ts:117-123`. `runAgent` stays an injectable
 * parameter so `scripts/test-historian.mjs` can drive the whole lease →
 * publish → deregister lifecycle against a stub runner, and so
 * `createHistorianScheduler` can substitute a runner without this module
 * depending on the call shape.
 */
export function startCompartmentAgent(
    deps: HiddenCompartmentRunnerDeps,
    runAgent: typeof runCompartmentAgent = runCompartmentAgent,
): void {
    withoutSqliteTransformPass(() => startBackgroundCompartmentAgent(deps, runAgent));
}

/** Verbatim: `compartment-runner.ts:125-223`. */
function startBackgroundCompartmentAgent(
    deps: HiddenCompartmentRunnerDeps,
    runAgent: typeof runCompartmentAgent,
): void {
    // Intentional: this check-then-set is safe in Bun's single-threaded event loop.
    // The synchronous code between activeRuns.get() and activeRuns.set() cannot interleave,
    // so another start for the same session cannot sneak in here.
    const existing = activeRuns.get(deps.sessionId);
    if (existing) {
        return;
    }

    if (isWrapupInProgress(deps.db, deps.sessionId)) {
        // /ctx-wrapup owns compartment-state publication while this marker is live.
        // The marker has a five-minute TTL renewed by wrapup, so a crashed wrapup
        // self-expires instead of suppressing trigger-fired historian runs forever.
        sessionLog(deps.sessionId, "compartment agent skipped: /ctx-wrapup is active");
        updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
        return;
    }

    const holderId = crypto.randomUUID();
    const lease = acquireCompartmentLease(deps.db, deps.sessionId, holderId);
    if (!lease) {
        const blocker = getCompartmentLeaseBlocker(deps.db, deps.sessionId);
        sessionLog(
            deps.sessionId,
            blocker
                ? `compartment agent skipped: compartment lease held by another process (holder=${blocker.holderId} pid=${blocker.ownerPid ?? "unknown"} expiresAt=${blocker.expiresAt})`
                : "compartment agent skipped: compartment lease held by another process (owner unavailable after acquisition race)",
        );
        // The DB lease is the cross-process authority. If this process set the
        // start-intent flag but did not win the lease, no local run will clear it;
        // release the intent so later passes can retry instead of starving.
        updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
        return;
    }
    if (isWrapupInProgress(deps.db, deps.sessionId)) {
        // Close the cross-process check/lease race: /ctx-wrapup may have published
        // its marker after the first check but before this process won the lease.
        sessionLog(deps.sessionId, "compartment agent skipped: /ctx-wrapup became active");
        releaseCompartmentLease(deps.db, deps.sessionId, holderId);
        updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
        return;
    }

    const renewal = startLeaseRenewal(deps, holderId);

    // Track the real underlying promise — NOT a raced wrapper.
    // This ensures activeRuns.has(sessionId) stays true until the historian run
    // actually completes, preventing duplicate runs even if an external await times out.
    let realRunStarted = false;
    const runnerDeps = withPublishedCallback({
        ...deps,
        compartmentLeaseHolderId: holderId,
        onHistorianRunStarted: () => {
            realRunStarted = true;
        },
    });
    const promise = runAgent(runnerDeps)
        .catch((err) => {
            sessionLog(deps.sessionId, "compartment agent: unhandled rejection:", err);
            // Ensure compartmentInProgress is cleared on any failure
            try {
                updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
            } catch {
                // best effort
            }
        })
        .finally(() => {
            // The `.catch` above has already run by the time this finalizer executes,
            // so anything thrown here would reject a promise nobody awaits. Contain
            // every step: cleanup must never become an unhandled rejection.
            try {
                clearInterval(renewal);
                releaseCompartmentLeaseBestEffort(deps.db, deps.sessionId, holderId, sessionLog);
                if (activeRuns.get(deps.sessionId)?.promise === promise) {
                    activeRuns.delete(deps.sessionId);
                }
            } catch (err) {
                sessionLog(deps.sessionId, "compartment agent: finalizer failed:", err);
            }
        });
    activeRuns.set(deps.sessionId, { promise, published: false, kind: "incremental" });
    // If the runner no-op'd synchronously (stale/empty snapshot, nothing to
    // compact, drain-quota), it returned before signalling onHistorianRunStarted
    // and before any `await`, so `promise` is already settling. It cleared
    // compartmentInProgress in its own finally, but the activeRuns entry above
    // would otherwise survive (cleared only by the microtask-scheduled
    // promise.finally) and make the SAME transform pass treat a non-running
    // historian as in-progress — deferring queued drop ops and starving them
    // turn after turn (the production livelock). Drop the registration
    // synchronously so pending ops can materialize this pass. The promise.finally
    // below still runs for interval/lease cleanup; its `=== promise` guard makes
    // the (now redundant) delete a no-op.
    if (!realRunStarted && activeRuns.get(deps.sessionId)?.promise === promise) {
        activeRuns.delete(deps.sessionId);
    }
}

export { runCompartmentAgent } from "./compartment-runner-incremental.js";