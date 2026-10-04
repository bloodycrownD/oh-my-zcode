// FORK-NOTE(S20): upstream `hooks/magic-context/compartment-runner-types.ts`.
// Now at its upstream path and the REAL module — every C-group runner file
// imports its types from here, and `src/host/hidden-completion-executor.ts`
// implements `HiddenCompletionExecutor` against it.
//
// WHAT IS VERBATIM. `RecompProgress`, `HiddenCompletionRefusal`,
// `HiddenRunIdentity`, `HiddenRunHandle`, `HiddenCompletion`,
// `HiddenCompletionExecutor`, `CompartmentRunnerDeps`,
// `HiddenCompartmentRunnerDeps`, `CandidateCompartment`, `HistorianRunResult`,
// `ValidatedHistorianPassResult`, `StoredCompartmentRange` and
// `HistorianProgressCallbacks` are upstream's shapes.
//
// THE SUBSTITUTIONS, each forced by a module the fork does not port:
//   1. `TokenTotals` — upstream imports it from
//      `features/magic-context/subagent-token-capture` (the child-session token
//      capture, which exists only to attribute an OpenCode child's usage). The
//      fork has no child sessions: the historian is a SIDE-CAR model request,
//      so its usage comes straight off the sidecar response. Declared locally
//      with the same six members, because `HiddenCompletion.usage` names it and
//      `src/host/hidden-completion-executor.ts` fills it.
//   2. `PromptArgs` — upstream imports it from `shared/model-suggestion-retry`
//      (E group). Only `HiddenCompletionExecutor.attempt` names it, and in the
//      fork the attempt body is the sidecar request, so this is the request
//      shape `host/hidden-completion-executor.ts` accepts.
//   3. `compactionMarkerStrategy` — upstream types its two slots with
//      `typeof import(...)` against modules the fork trims. The structural
//      shapes below match the fork's `compaction-marker-manager.ts` and
//      `storage.ts` signatures exactly, so no behaviour rides on the difference.

import type { ParsedEvent } from "./compartment-parser.js";
import type { PluginContext } from "../../plugin/types.js";
import type { HarnessId } from "../../shared/harness.js";
import type { ModelInput } from "../../deferred/model-resolution.js";
import type { NotificationParams } from "../../deferred/send-session-notification.js";
import type { Database } from "../../shared/sqlite.js";
import type {
    BoundarySnapshotValidationResult,
    ProtectedTailBoundarySnapshot,
} from "./protected-tail-boundary.js";

/**
 * Local stand-in for `features/magic-context/subagent-token-capture`'s
 * `TokenTotals`. Same six members, same names: `src/host/hidden-completion-executor.ts`
 * populates this from the sidecar response's usage, and nothing in the fork ever
 * sums an OpenCode child's messages, which is what upstream's helper was for.
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
 * The request shape `HiddenCompletionExecutor.attempt` receives.
 *
 * Upstream types this as `shared/model-suggestion-retry`'s `PromptArgs`; the
 * fork declares the structural fields the executor itself reads (`path`, `body`,
 * `signal`) so the host adapter can build one from a historian run without
 * pulling in E group's model-suggestion retry loop.
 */
export interface PromptArgs {
    path: { id: string };
    body: Record<string, unknown>;
    signal?: AbortSignal;
    [key: string]: unknown;
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

/** Verbatim: `compartment-runner-types.ts:61-74`. */
export class HiddenCompletionRefusal extends Error {
    constructor(
        readonly code:
            | "hidden_model_unsupported"
            | "hidden_tools_unsupported"
            | "hidden_prompt_unrecognized"
            | "unsupported_transport",
        message: string,
        readonly terminal = false,
    ) {
        super(`${code}: ${message}`);
        this.name = "HiddenCompletionRefusal";
    }
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
     * absent when they configured none. The OpenCode 2 carrier turns a present
     * value into a wire parameter, so the OpenCode 2 lane must pass the
     * configured value through unchanged instead of substituting a fallback:
     * some backends reject the parameter outright, and the chunk-sizing
     * arithmetic that reserves output room supplies its own default separately.
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

/**
 * Verbatim: `compartment-runner-types.ts:116-131`. The four-stage contract the
 * historian drives, and the shape `src/host/hidden-completion-executor.ts`
 * implements (D-6: a side-car model request, NOT a spawned child session).
 *
 * `open`/`attempt`/`collect`/`close` stay separate on purpose: a read failure
 * in `collect` must never cause the historian prompt to be re-sent by `attempt`,
 * and `close` must be safe with a null handle so the caller's `finally` cannot
 * leak a run whose `open` threw.
 */
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
                typeof import("../../features/magic-context/storage.js").setPendingCompactionMarkerState
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

/** Verbatim: `compartment-runner-types.ts:264-271`. */
export interface HistorianRunResult {
    refusal?: HiddenCompletionRefusal;
    ok: boolean;
    result?: string;
    error?: string;
    dumpPath?: string;
    invocationId?: number;
}

/** Verbatim: `compartment-runner-types.ts:273-298`. */
export type ValidatedHistorianPassResult =
    | {
          ok: true;
          compartments: CandidateCompartment[];
          facts: Array<{ category: string; content: string }>;
          droppedFactBlocks?: number;
          droppedFacts?: number;
          userObservations?: string[];
          /** Durable standing-question candidates for Primers v1 (stored side-table only).
           *  `originCompartmentIndex` is the 1-based index into THIS publish's
           *  emitted compartments (same convention as `<events>` at_compartment);
           *  undefined → emission falls back to the chunk span. */
          primerCandidates?: Array<{ question: string; originCompartmentIndex?: number }>;
          /** v2: historian-extracted events (stored, not rendered). */
          events?: ParsedEvent[];
          /**
           * Subagent-invocation id of the model attempt that actually produced
           * this validated output (primary, repair, editor, or fallback). The
           * caller uses it as the exact `historian_runs.subagent_invocation_id`
           * FK so the telemetry row joins to the right tokens/model — a kind-
           * filtered "latest invocation" lookup mislinks recomp passes (recorded
           * under subagent='recomp') to a stale subagent='historian' row.
           */
          invocationId?: number | null;
      }
    | { ok: false; error: string; invocationId?: number | null };

/** Verbatim: `compartment-runner-types.ts:300-303`. */
export interface StoredCompartmentRange {
    startMessage: number;
    endMessage: number;
}

/** Verbatim: `compartment-runner-types.ts:305-312`. */
export interface HistorianProgressCallbacks {
    onRepairRetry?: (error: string) => Promise<void>;
    /** Fired before each fallback model attempt in `runFallbackHistorianPass`
     *  (after the primary + repair failed). `modelId` is the model about to be
     *  tried; `index`/`total` describe its position in the fallback chain. Lets
     *  the caller surface "trying fallback X…" in live progress. */
    onModelFallback?: (modelId: string, index: number, total: number) => void;
}