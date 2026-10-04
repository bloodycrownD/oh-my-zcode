// FORK-DEFERRED(S20): `hooks/magic-context/compartment-runner-types.ts` 的 RecompProgress / HiddenRunIdentity / HiddenRunHandle / HiddenCompletion / HiddenCompletionExecutor / CompartmentRunnerDeps / HiddenCompartmentRunnerDeps / CandidateCompartment / HistorianRunResult 摘录，Step 20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. Every member here is a TYPE — the module has
// no runtime body. Two of its imports are themselves deferred seams
// (`../shared/model-resolution.js` and `./send-session-notification.js`, both
// reached from this file's own signatures), and two more reach modules the fork
// does not port (`../../shared/model-suggestion-retry`'s `PromptArgs`,
// `../../features/magic-context/subagent-token-capture`'s `TokenTotals`). The
// structural shapes are reproduced verbatim; the leaf types those signatures
// mention are declared locally with the same shape, since no fork call site ever
// constructs one.
//
// WHAT THE B GROUP ACTUALLY USES. `live-session-state.ts` needs `RecompProgress`
//; `transform-compartment-phase.ts` needs `HiddenCompartmentRunnerDeps` (only its
// `compactionMarkerStrategy` member) and `HiddenCompletionExecutor`; `embed-
// session-state.ts` needs the `Pick<RecompProgress, "kind" | "phase" | "message">`
// projection. Nothing constructs a `HiddenCompletion`.
//
// Step 20: delete this file and repoint `live-session-state.ts`,
// `transform.ts` and `transform-compartment-phase.ts` back at
// `./compartment-runner-types.js`.

import type { PluginContext } from "../plugin/types.js";
import type { HarnessId } from "../shared/harness.js";
import type { ModelInput } from "./model-resolution.js";
import type { NotificationParams } from "./send-session-notification.js";
import type { Database } from "../shared/sqlite.js";
import type {
    BoundarySnapshotValidationResult,
    ProtectedTailBoundarySnapshot,
} from "../hooks/magic-context/protected-tail-boundary.js";

/**
 * Local stand-in for `../../shared/model-suggestion-retry`'s `PromptArgs`
 * (upstream `model-suggestion-retry.ts:36-40`). That module is E group; only
 * `HiddenCompletionExecutor.attempt` names it, and no fork call site builds one.
 */
export interface PromptArgs {
    path: { id: string };
    body: Record<string, unknown>;
    signal?: AbortSignal;
    [key: string]: unknown;
}

/**
 * Local stand-in for `../../features/magic-context/subagent-token-capture`'s
 * `TokenTotals`. Same reasoning as `PromptArgs` above: only
 * `HiddenCompletion.usage` names it.
 */
export interface TokenTotals {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

/**
 * Live progress for a running recomp, surfaced in the TUI sidebar + /ctx-status
 * so users can watch a long rebuild instead of staring at a single "started"
 * toast. Lives in `LiveSessionState.recompProgressBySession`
 * (process-local, in-memory — if the process restarts mid-recomp the recomp
 * itself is interrupted, so losing the progress entry is correct).
 *
 *  - phase "recomp"    → rebuilding compartments; `processedMessages/totalMessages` drives the bar.
 *  - phase "migration" → recomp done, re-organizing project memories (indeterminate).
 *  - phase "done"      → finished successfully; `message` holds the summary. Auto-cleared after a grace period.
 *  - phase "failed"    → stopped without publishing; `message` holds the reason. Retained until next run.
 *
 * Verbatim: `compartment-runner-types.ts:26-59`.
 */
export interface RecompProgress {
    sessionId: string;
    /** Which user-facing flow this progress belongs to, so the sidebar/status
     *  wording follows the flow that started the run instead of hardcoding one
     *  verb for all of them (dogfood 2026-06-04: a plain recomp showed
     *  "Recomp / ✗ Upgrade failed", a self-contradiction). Optional + defaults
     *  to "recomp" so runner-emitted per-pass entries (which don't know the
     *  flow) inherit the kind set by setRecompStarting. "upgrade" is no longer
     *  produced — the session-upgrade flow is gone — and the renderers keep its
     *  arm only so an in-flight entry from an older process still labels. */
    kind?: "recomp" | "upgrade" | "embed" | "wrapup";
    /** "skipped" is a TRANSIENT non-failure outcome: the incremental historian
     *  briefly held the compartment-state lease (or another process is mutating
     *  it), so the run no-op'd. It renders neutrally with retry guidance and
     *  auto-clears, unlike red "failed" which persists. */
    phase: "recomp" | "migration" | "done" | "failed" | "skipped";
    /** Raw messages processed so far (the recomp loop's `offset`). */
    processedMessages: number;
    /** Total raw messages to reprocess (protected-tail start − 1). */
    totalMessages: number;
    /** Successful historian passes completed. */
    passCount: number;
    /** Compartments rebuilt so far this run. */
    compartmentsCreated: number;
    startedAt: number;
    updatedAt: number;
    /** Terminal summary/reason (done | failed). */
    message?: string;
    /** Transient status line for the active phase — e.g. "Starting…", "Running
     *  historian…", "Primary returned nothing — trying fallback sonnet-4.6…",
     *  "Repair retry…". Surfaced under the progress bar so a long/retrying pass
     *  shows live activity instead of a frozen bar. */
    note?: string;
}

/** Verbatim: `compartment-runner-types.ts:76-97`. */
export interface HiddenRunIdentity {
    parentSessionId?: string;
    parentInvocationId?: number | null;
    agent: string;
    kind: "historian" | "historian-editor" | "dreamer-task";
    system: string;
    model?: ModelInput;
    configuredModels?: readonly ModelInput[];
    timeoutMs: number;
    /**
     * Output cap the user configured for this run (`historian.maxTokens`), or
     * absent when they configured none.
     */
    maxOutputTokens?: number;
    title: string;
    directory: string;
    metadata?: Record<string, unknown>;
}

/** Verbatim: `compartment-runner-types.ts:99-102`. */
export interface HiddenRunHandle {
    id: string;
    childSessionId?: string;
}

/**
 * Verbatim: `compartment-runner-types.ts:104-114`. Upstream types `tokenLog` as
 * `import("../../shared/run-token-log").RunTokenLog`; that module is not ported,
 * so the member is typed as an opaque record here.
 */
export interface HiddenCompletion {
    text: string | null;
    reasoning?: string | null;
    usage: TokenTotals;
    lengthCapped: boolean;
    tokenLog?: Record<string, unknown>;
    /** Original host messages are retained only by transports that expose them. */
    messages?: unknown[];
    providerId?: string;
    modelId?: string;
}

/** Verbatim: `compartment-runner-types.ts:116-131`. */
export interface HiddenCompletionExecutor {
    readonly capabilities: { tools: boolean; harness: HarnessId };
    open(run: HiddenRunIdentity): Promise<HiddenRunHandle>;
    attempt(handle: HiddenRunHandle, request: PromptArgs): Promise<void>;
    /** Kept separate from prompt settlement so read failures never resend a historian prompt. */
    collect(handle: HiddenRunHandle, limit: number): Promise<HiddenCompletion>;
    close(
        handle: HiddenRunHandle | null,
        settlement: {
            promptSettled: boolean;
            privacySensitive: boolean;
            context: string;
            log: (message: string) => void;
        },
    ): Promise<void>;
}

/** Verbatim: `compartment-runner-types.ts:133-234`. */
export interface CompartmentRunnerDeps<
    Client extends PluginContext["client"] | undefined = PluginContext["client"],
> {
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    compactionMarkerStrategy?: {
        setPending?: (
            db: Database,
            sessionId: string,
            state: Parameters<
                typeof import("../features/magic-context/storage.js").setPendingCompactionMarkerState
            >[2],
        ) => void;
        publish?: (
            db: Database,
            sessionId: string,
            lastCompartmentEnd: number,
            directory?: string,
        ) => boolean;
    };
    client: Client;
    db: Database;
    sessionId: string;
    /**
     * Historian chunk budget — how much raw history historian processes per
     * call. Bounded by the HISTORIAN model's context window, not main's.
     * Derived via `deriveHistorianChunkTokens(historianContextLimit)`.
     */
    historianChunkTokens: number;
    historianTimeoutMs?: number;
    /** Immutable protected-tail boundary resolved by the trigger/force path. Tests may omit it and use the default-snapshot factory. */
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
    /** Optional stale-snapshot refresh hook. Manual wrapup uses this so stale
     *  snapshots re-resolve with the keep-watermark override instead of falling
     *  back to normal pressure math. */
    refreshBoundarySnapshot?: (
        snapshot: ProtectedTailBoundarySnapshot,
        validation: BoundarySnapshotValidationResult,
    ) => ProtectedTailBoundarySnapshot | null;
    /** Current resolved main-model context limit used to reject stale boundary snapshots after model switches. */
    currentContextLimit?: number;
    /** Active OpenCode historian entry, including its request variant. */
    model?: ModelInput;
    /** Known context limit for the same resolved historian model. Unknown means no producer guard. */
    historianContextLimit?: number;
    /** Output reservation configured on the historian agent request. */
    historianMaxOutputTokens?: number;
    /** Resolved fallback chain for historian-family calls (historian + compressor). */
    fallbackModels?: readonly ModelInput[];
    language?: string;
    directory: string;
    historyBudgetTokens?: number;
    fallbackModelId?: string;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    getNotificationParams?: () => NotificationParams;
    /** When true, extract user behavior observations from historian output */
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock dates on compartments in <session-history>. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run an editor pass after successful historian output to clean
     *  low-signal U: lines and cross-compartment duplicates. */
    historianTwoPass?: boolean;
    /**
     * Cross-session memory feature gate (`memory.enabled` config). When false,
     * historian/recomp must NOT promote session facts into project memories
     * and must NOT generate or store embeddings. Issue #44.
     */
    memoryEnabled?: boolean;
    /**
     * Automatic-promotion gate (`memory.auto_promote` config). When false (and
     * memory is otherwise enabled), tools and search still work, but historian
     * does not auto-promote session facts to memories. Users can still write
     * memories explicitly via `ctx_memory write`. Issue #44.
     */
    autoPromote?: boolean;
    /**
     * Called after compartment state is published. The runner marks the active
     * run as published before invoking this callback.
     */
    onCompartmentStatePublished?: (sessionId: string) => void;
    /** Live recomp-phase progress callback (sidebar / status). The runner emits
     *  "recomp"-phase updates (start + each pass); the caller owns the migration
     *  and terminal (done/failed) phases. Best-effort, never throws into the loop. */
    onRecompProgress?: (progress: RecompProgress) => void;
    /**
     * When true, publication preserves the in-memory injection cache until a
     * later materializing pass consumes the deferred refresh.
     */
    preserveInjectionCacheUntilConsumed?: boolean;
    /**
     * Plan v6 §4: Called when historian/recomp publication wrote a pending
     * compaction-marker row in-transaction (deferring marker application to a
     * later materializing pass).
     */
    onDeferredMarkerPending?: (sessionId: string) => void;
    /** Holder id for the DB-backed compartment-state lease guarding publish paths. */
    compartmentLeaseHolderId?: string;
    /**
     * Called synchronously the moment the runner commits to a REAL historian
     * pass — after every no-op early-return. Lets `startCompartmentAgent`
     * distinguish a fire-and-forget run that actually started from one that
     * no-op'd synchronously.
     */
    onHistorianRunStarted?: () => void;
    /** Manual wrapup bypasses the pressure-window quota but keeps the no-progress breaker. */
    forceDrainQuota?: boolean;
    /** Persist a weak-lookahead final compartment for coverage, but skip durable promotion. */
    forceKeepLastCompartment?: boolean;
}

/** Verbatim: `compartment-runner-types.ts:236-238`. */
export type HiddenCompartmentRunnerDeps = CompartmentRunnerDeps<
    PluginContext["client"] | undefined
>;

/** Verbatim: `compartment-runner-types.ts:240-262`. */
export interface CandidateCompartment {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    startBlockIndex?: number | null;
    endBlockIndex?: number | null;
    title: string;
    /** v2: P1 tier text (mirror). v1/compressor: flat content. */
    content: string;
    /** v2 paraphrase tiers (model B). Null/undefined for v1/flat compartments.
     *  Nullability matches CompartmentInput so candidates and staging rows
     *  round-trip through each other without type friction. */
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    /** v2 decay-rate signal (1-100). Null/undefined for v1/flat. */
    importance?: number | null;
    /** v2 comma-separated activity types. Null/undefined for v1/flat. */
    episodeType?: string | null;
}