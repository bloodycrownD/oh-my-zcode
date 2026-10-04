// FORK-NOTE(S20): rewritten from upstream `features/magic-context/scheduler.ts`
// (122 lines) plus the fire-and-forget + drain + abort shape the spec points at
// (`core/src/runtime/helpers/project-memory-extraction.ts`,
// `core/src/memory/extraction.ts`).
//
// WHY A REWRITE AND NOT A PORT. Upstream's `scheduler.ts` is not the historian's
// scheduler at all — it is the per-session transform SCHEDULER: given a
// `ContextUsage` and `SessionMeta` it answers `execute | defer | park |
// passthrough`, i.e. "should this request rewrite its messages?". That decision
// belongs to `TransformDeps.scheduler` and is a B-group input the fork already
// carries through a seam. What upstream fires from it is the compartment agent,
// and THIS file is that firing half: the background drain the historian runs on
// after a turn succeeds.
//
// So the two are split deliberately, and this file owns exactly the half that was
// missing: a fire-and-forget queue with coalescing, a bounded drain for session
// close, and an abort that actually stops an in-flight provider request.
//
// THE CONTRACT, and why each part is there:
//   - `notifyTurnSuccess` is fire-and-forget. The turn that triggered it has
//     already returned its answer to the user; a historian that takes 30s must not
//     hold the UI. The caller never awaits it and never reads a return value.
//   - Coalescing: at most ONE pending run per process. A turn storm must not
//     queue ten historian passes over the same raw head — the second one would
//     find nothing new to compact and burn a full model call to learn that. The
//     newest request replaces the pending one; an already-RUNNING pass is never
//     replaced (it owns the compartment lease), so the newest request is simply
//     dropped and reported as `in_flight`.
//   - `drain()` is bounded by default. On session close the host must not block
//     on a model request that may be minutes old, so it races the drain against a
//     timeout; `drain(null)` waits unbounded for an explicit benchmark-style wait.
//   - `shutdown()` aborts. ZCode keeps running after one session closes, so a
//     scheduler that only stopped WAITING (upstream's older behaviour) would let a
//     closed session's historian keep requesting models and writing compartments.
//     The abort signal reaches the provider request through
//     `HiddenCompletionExecutor`.

import { sessionLog } from "../../shared/logger.js";
import type { HistorianNoFireCause } from "../../hooks/magic-context/historian-no-fire-cause.js";

/** Terminal outcome of one historian pass, as the scheduler reports it. */
export type HistorianRunStatus =
  /** Compartments published. */
  | "success"
  /** The runner decided not to fire (protected tail, drain budget, …). */
  | "no-op"
  /** The run threw or the pass failed validation. */
  | "error"
  /** Shutdown, or the run's own abort signal, stopped it. */
  | "aborted";

/** What `notifyTurnSuccess` carries. */
export interface HistorianTurnSuccess {
  sessionId: string;
  /**
   * Human-readable reason the scheduler did not fire, recorded on the no-fire
   * path. One of the closed `HistorianNoFireCause` union when the scheduler
   * itself declined (e.g. `in_flight`); free text when the runner declined.
   */
  noFireCause?: HistorianNoFireCause | string;
}

export interface HistorianScheduler {
  /**
   * Turn succeeded → drain this session's eligible raw head in the background.
   * Returns immediately; never rejects.
   */
  notifyTurnSuccess(request: HistorianTurnSuccess): void;
  /**
   * Wait for the in-flight run (and any pending one it picks up) to settle.
   * Resolves even on failure — failures are reported through `onError`, not
   * thrown at the caller. This is the UNBOUNDED wait; a host that must not block
   * on session close races it against `drainHistorianSchedulerWithTimeout`.
   */
  drain(): Promise<void>;
  /** True while a pass is running or a request is pending. */
  hasPendingWork(): boolean;
  /**
   * Stop scheduling and abort the in-flight pass. Idempotent. After this, the
   * scheduler is inert: `notifyTurnSuccess` is a no-op.
   */
  shutdown(): void;
  /** Last terminal status seen for a session, for `/ctx-status` and tests. */
  getLastStatus(sessionId: string): HistorianRunStatus | undefined;
  /** No-fire reason recorded for the session's most recent declined request. */
  getLastNoFireCause(sessionId: string): string | undefined;
}

/** Default bound on `drain()`, matching the extraction scheduler's 60s. */
export const DEFAULT_HISTORIAN_DRAIN_TIMEOUT_MS = 60_000;

export interface CreateHistorianSchedulerOptions {
  /**
   * Run one historian pass. Implementations MUST honour `signal` — it is the only
   * thing that makes `shutdown()` more than "stop waiting".
   */
  runSession(sessionId: string, signal: AbortSignal): Promise<HistorianRunStatus>;
  /** Bound for `drain()` when the caller passes no timeout. */
  drainTimeoutMs?: number;
  /** Observability for a failed pass. Must not throw. */
  onError?(sessionId: string, error: unknown): void;
}

export function createHistorianScheduler(
  options: CreateHistorianSchedulerOptions,
): HistorianScheduler {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_HISTORIAN_DRAIN_TIMEOUT_MS;
  const inFlight = new Set<string>();
  const lastStatus = new Map<string, HistorianRunStatus>();
  const lastNoFireCause = new Map<string, string>();

  let pending: Promise<HistorianTurnSuccess> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdownController = new AbortController();

  const noteNoFire = (request: HistorianTurnSuccess, cause: string): void => {
    lastNoFireCause.set(request.sessionId, cause);
    sessionLog(request.sessionId, `historian scheduler no-fire: reason=${cause}`);
  };

  const process = async (request: HistorianTurnSuccess): Promise<void> => {
    const sessionId = request.sessionId;
    // A run already in flight owns the compartment lease. Re-queueing would only
    // produce a second pass over the same raw head, so drop it and say why.
    if (inFlight.has(sessionId)) {
      noteNoFire(request, "in_flight");
      return;
    }
    inFlight.add(sessionId);
    try {
      const status = await options.runSession(sessionId, shutdownController.signal);
      lastStatus.set(sessionId, status);
      lastNoFireCause.delete(sessionId);
      if (status === "no-op") {
        sessionLog(sessionId, "historian scheduler: run declined by the runner");
      }
    } catch (error) {
      lastStatus.set(sessionId, shuttingDown ? "aborted" : "error");
      sessionLog(sessionId, "historian scheduler: run threw", { error });
      try {
        options.onError?.(sessionId, error);
      } catch {
        // Observability must never escalate a handled failure into an
        // unhandled rejection.
      }
    } finally {
      inFlight.delete(sessionId);
    }
  };

  const run = async (first: Promise<HistorianTurnSuccess>): Promise<void> => {
    try {
      let current: Promise<HistorianTurnSuccess> | undefined = first;
      while (current && !shuttingDown) {
        const request = await waitForRequestOrShutdown(current, shutdownController.signal);
        if (request === undefined || shuttingDown) break;
        await process(request);
        current = shuttingDown ? undefined : pending;
        pending = undefined;
      }
    } finally {
      if (shuttingDown) pending = undefined;
      running = undefined;
    }
  };

  return {
    notifyTurnSuccess(request: HistorianTurnSuccess): void {
      if (shuttingDown) {
        noteNoFire(request, "shutdown");
        return;
      }
      if (inFlight.has(request.sessionId)) {
        // Reported synchronously so a caller that fires on every turn can see the
        // coalescing happen instead of inferring it from a missing effect.
        noteNoFire(request, "in_flight");
        return;
      }
      if (request.noFireCause) {
        noteNoFire(request, request.noFireCause);
        return;
      }
      const acquisition = Promise.resolve(request);
      if (running) {
        // Coalesce: the newest turn supersedes any not-yet-started pass.
        pending = acquisition;
        return;
      }
      running = run(acquisition);
    },

    async drain(): Promise<void> {
      // Same shape as the extraction scheduler: loop, because a settling run can
      // pick up the coalesced `pending` request and start a second pass.
      while (running) {
        await running;
      }
    },

    hasPendingWork(): boolean {
      return running !== undefined || pending !== undefined;
    },

    shutdown(): void {
      if (shuttingDown) return;
      shuttingDown = true;
      pending = undefined;
      // Aborting, not merely abandoning: a closed session's historian must stop
      // requesting models and stop writing compartments.
      shutdownController.abort(new Error("historian scheduler shut down"));
    },

    getLastStatus(sessionId: string): HistorianRunStatus | undefined {
      return lastStatus.get(sessionId);
    },

    getLastNoFireCause(sessionId: string): string | undefined {
      return lastNoFireCause.get(sessionId);
    },
  };
}

/**
 * Bounded drain — what a host calls on session close.
 *
 * Mirrors `drainMemoryExtractions` (`core/src/runtime/helpers/project-memory-extraction.ts`):
 * race the drain against a timer so closing a session never blocks on a model
 * request that may be minutes old, and clear the timer on every exit path. Pass
 * `null` when an explicit unbounded wait is wanted (a benchmark, a manual
 * `/ctx-status` that promises "wait until compression finishes").
 *
 * `unref` on the timer keeps this from holding the process open.
 */
export async function drainHistorianSchedulerWithTimeout(
  scheduler: HistorianScheduler,
  timeoutMs: number | null = DEFAULT_HISTORIAN_DRAIN_TIMEOUT_MS,
): Promise<void> {
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Await a request, or resolve `undefined` the moment shutdown aborts.
 *
 * The `finally` matters: without it an aborted acquisition would leave a
 * dangling `.then` on a promise nobody reads, and a rejection there would
 * surface as an unhandled rejection during shutdown.
 */
function waitForRequestOrShutdown(
  acquisition: Promise<HistorianTurnSuccess>,
  signal: AbortSignal,
): Promise<HistorianTurnSuccess | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return Promise.race([
    acquisition.then((request) => request),
    new Promise<undefined>((resolve) => {
      signal.addEventListener(
        "abort",
        () => resolve(undefined),
        { once: true },
      );
    }),
  ]);
}