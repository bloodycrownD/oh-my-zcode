// FORK-DEFERRED(S20): `hooks/magic-context/compartment-runner.ts` 的 ActiveCompartmentRun / getActiveCompartmentRun / startCompartmentAgent 摘录，Step 20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The runner acquires the compartment-state
// lease and dispatches to three runners the fork does not port
// (`compartment-runner-incremental`, `compartment-runner-partial-recomp`,
// `compartment-runner-recomp`). Step 20 owns the historian, so the whole runner
// closure is C-group surface.
//
// SEMANTIC DECISION — `startCompartmentAgent` throws, `getActiveCompartmentRun`
// always answers "no active run". The two call sites in
// `transform-compartment-phase.ts` (398 and 450) only reach the start call when
// `args.canRunCompartments && (args.client || args.hiddenCompletionExecutor)`
// and `sessionMeta.compartmentInProgress` is set; the flag is only set by a
// running compartment agent, so with no runner the branch is unreachable in the
// fork. Throwing (rather than silently returning) keeps that guarantee honest:
// if a future host ever sets the flag, the pass fails loudly instead of
// believing a historian is compressing history. `getActiveCompartmentRun`
// returning `undefined` is the truthful answer (the map is always empty) and is
// what keeps the 95%-blocking branch from awaiting a run that never starts.
//
// Step 20: delete this file and repoint
// `transform-compartment-phase.ts`, `transform-postprocess-phase.ts` and
// `transform.ts` back at `./compartment-runner.js`.

import type { HiddenCompartmentRunnerDeps } from "./compartment-runner-types.js";
import type { PluginContext } from "../plugin/types.js";
import type { Database } from "../shared/sqlite.js";

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

/**
 * Verbatim: `compartment-runner.ts:39-41`. The `activeRuns` map is always empty
 * in this fork because nothing ever registers into it, so the read is
 * unconditionally `undefined`.
 */
export function getActiveCompartmentRun(_sessionId: string): ActiveCompartmentRun | undefined {
    return undefined;
}

/**
 * Register a compartment-state-mutating promise with the active-runs map.
 *
 * Signature verbatim from `compartment-runner.ts:118-124`. Throws: the historian
 * child agent is C-group (Step 20) and this fork runs none, so any call means a
 * caller believed a historian could start when it cannot.
 */
export function startCompartmentAgent(
    _deps: Omit<HiddenCompartmentRunnerDeps, "client"> & {
        client: PluginContext["client"] | undefined;
        db: Database;
        sessionId: string;
    },
): void {
    throw new Error("FORK-DEFERRED(S20): compartment-runner 未接线——historian 子代理属 C 组");
}