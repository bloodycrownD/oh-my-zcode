/**
 * Step 20 — D-6: the ZCode `HiddenCompletionExecutor`.
 *
 * The historian needs a model to summarise a chunk of raw history into
 * compartments. Upstream (the OpenCode plugin) got that by SPAWNING A CHILD
 * SESSION and prompting it. This fork must not: D-6 settles that the historian
 * is a **side-car model request** — one in-process call through the same
 * primitive the native compactor used, reusing the `runSidecarModelRequest`
 * / `generateLiteExtraction` paradigm (that file is renamed and kept in Phase 2b
 * precisely so this dependency survives D-7).
 *
 * The four-stage shape is NOT a convenience — it is upstream's contract and this
 * executor keeps it verbatim:
 *
 *   open(run)                 → allocate a run slot (no I/O)
 *   attempt(handle, request)  → issue the ONE side-car request
 *   collect(handle, limit)    → read the settled result back
 *   close(handle, settlement) → always safe, always last, never re-sends
 *
 * Splitting `attempt` from `collect` is what keeps a read failure from re-sending
 * a historian prompt, and taking `handle: HiddenRunHandle | null` in `close` is
 * what lets the runner's `finally` close a run whose `open` threw. Both are
 * load-bearing and neither is negotiable for a second implementation.
 *
 * ── THE HARD CONSTRAINT ────────────────────────────────────────────────────
 *
 * `SidecarModelCallOptions.preserveProviderStreamBoundaries` is typed as the
 * literal `{ preserveProviderStreamBoundaries: true }` — a REQUIRED member with a
 * REQUIRED value. It cannot be omitted and it cannot be `false`, and the compiler
 * enforces both. This is deliberate and load-bearing:
 *
 *   `preserveProviderStreamBoundaries: true` is what makes the provider adapter
 *   emit `compact_stream_boundary` events (raw `provider_response_start` /
 *   `provider_content_block_*` / `provider_stop_reason` provenance). The sidecar
 *   primitive CONSUMES those events to decide whether a streamed content block was
 *   really committed — see `sidecar-model-request.ts`'s `compact_stream_boundary`
 *   case plus `applySidecarProviderBoundary` / `commitNormalizedContentBlock`.
 *   With the flag absent or false, the adapter stops emitting the provenance,
 *   `commitNormalizedContentBlock` falls back to the normalized end-of-block
 *   inference, and a tool call the provider had already committed can be
 *   re-submitted as if the stream died before commit.
 *
 *   That failure is SILENT. Nothing throws, no test fails, the run still
 *   completes — the tool-call commit verdict is just wrong. Which is exactly why a
 *   compile-time constraint is used here instead of a runtime default or a code
 *   comment: a runtime default cannot be forgotten silently, and by Step 25/26 the
 *   only remaining `true` producer in the whole repo (`compact-active.ts:401`) is
 *   gone, so a wiring mistake would have no second producer to fall back on.
 *
 *   `scripts/test-historian.mjs` pins this with a NEGATIVE typecheck (a fragment
 *   that must fail to compile if the flag is dropped or set to `false`).
 */

import type {
  HiddenCompletion,
  HiddenCompletionExecutor,
  HiddenRunHandle,
  HiddenRunIdentity,
  PromptArgs,
} from "../core/hooks/magic-context/compartment-runner-types.js";
import { HiddenCompletionRefusal } from "../core/hooks/magic-context/compartment-runner-types.js";
import { getHarness } from "../core/shared/harness.js";

/**
 * Options every sidecar call MUST carry.
 *
 * `{ preserveProviderStreamBoundaries: true }` is a required literal member: see
 * the hard-constraint note at the top of this file. Omitting it, passing `false`,
 * or widening the type to `boolean` are all compile errors, which is the point.
 */
export interface SidecarModelCallOptions {
  /**
   * MUST be `true`.
   *
   * With it unset or false the provider adapter stops emitting
   * `compact_stream_boundary`, and the sidecar primitive's tool-call commit
   * judgement silently degrades from "the provider really committed this block"
   * to "the SDK's normalized end-of-block suggests it did". No error is raised;
   * a committed tool call can be replayed. Not optional, not negotiable.
   */
  preserveProviderStreamBoundaries: true;
}

/** One sidecar model request, as the historian describes it. */
export interface SidecarModelRequest {
  /** The run identity the caller opened (`agent`, `kind`, `system`, `model`, …). */
  run: HiddenRunIdentity;
  /** The composed historian USER prompt (`<new_messages>` + bounded blocks). */
  prompt: string;
  /** Resolved by the executor's timeout budget; passed through to the transport. */
  abortSignal: AbortSignal;
}

/** What the sidecar primitive gives back. Mirrors `RuntimeModelTextResult`. */
export interface SidecarModelCallResult {
  text: string;
  reasoning?: string | null;
  /**
   * Mirrors `ModelUsage` (`contracts/src/model/index.ts:512`) in the same
   * optional-token shape, so a caller can pass the provider's usage object
   * through untouched and let `toTokenTotals` normalise it.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  finishReason?: string;
  /**
   * True when the provider stopped because the output cap was reached. The
   * historian treats a length-capped run with no text as a distinct failure
   * (`historianReasoningBudgetDiagnostic`), not as empty output.
   */
  lengthCapped?: boolean;
  providerId?: string;
  modelId?: string;
}

/**
 * The injected sidecar call. `options` is NOT optional and NOT partially
 * fillable — see `SidecarModelCallOptions`.
 *
 * The ZCode wiring (bootstrap / the turn-loop integration) implements this on top
 * of the renamed `runSidecarModelRequest` primitive, forwarding both
 * arguments through.
 */
export type SidecarModelCall = (
  request: SidecarModelRequest,
  options: SidecarModelCallOptions,
) => Promise<SidecarModelCallResult>;

/**
 * Provider-side failures that mean "this configuration can never work", mapped
 * from `ModelErrorCode` (`contracts/src/model/index.ts:119-133`). These are the
 * same codes the sidecar primitive treats as SETUP failures
 * (`SIDECAR_SETUP_ERROR_CODES`) — a second transport must not be tried to
 * paper over them, because the request never reached the provider at all.
 */
const SETUP_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_model_selection",
  "model_config_missing",
  "provider_not_found",
  "provider_not_configured",
  "model_not_found",
  "invalid_model_request",
  "model_request_auth_missing",
]);

/** Terminal refusals: retrying the same configuration cannot help. */
const TERMINAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "hidden_model_unsupported",
  "hidden_tools_unsupported",
  "unsupported_transport",
]);

/**
 * Turn a sidecar failure into a `HiddenCompletionRefusal` when it is a refusal,
 * or rethrow it unchanged when it is an ordinary transport failure (so the
 * runner's `isTransientHistorianPromptError` retry ladder still sees the message).
 */
export function classifySidecarFailure(
  error: unknown,
  context: { hasModel: boolean; transportWired: boolean },
): HiddenCompletionRefusal | undefined {
  if (error instanceof HiddenCompletionRefusal) return error;
  if (!context.transportWired) {
    return new HiddenCompletionRefusal(
      "unsupported_transport",
      "no sidecarModelCall is wired into the hidden completion executor",
    );
  }
  const code = readErrorCode(error);
  if (code && SETUP_ERROR_CODES.has(code)) {
    return new HiddenCompletionRefusal(
      "hidden_model_unsupported",
      `the historian model request was refused before reaching the provider (${code})`,
      true,
    );
  }
  if (!context.hasModel) {
    return new HiddenCompletionRefusal(
      "hidden_model_unsupported",
      "no historian model is configured for this run",
      true,
    );
  }
  return undefined;
}

/** Read a `ModelErrorCode`-shaped `code` off an error, if it has one. */
function readErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Normalise a `ModelUsage`-shaped record into the runner's `TokenTotals`. */
export function toTokenTotals(result: SidecarModelCallResult): HiddenCompletion["usage"] {
  const usage = result.usage ?? {};
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: usage.totalTokens ?? input + output + reasoning + cacheRead + cacheWrite,
  };
}

export interface HiddenCompletionExecutorOptions {
  /** The injected sidecar model call. Required — see the type's own doc. */
  sidecarModelCall?: SidecarModelCall;
  /**
   * Whether the transport can serve a tool-bearing hidden run. The historian
   * never asks for tools (`capabilities.tools` is read by nothing in the fork's
   * runner), so this exists for the refusal path: a transport that cannot serve
   * tools must refuse loudly rather than silently dropping the tool surface.
   */
  supportsTools?: boolean;
  /**
   * Overrides the executor's timeout budget when a run carries none. Upstream's
   * default (600s) lives in `compartment-runner-historian.ts`, which passes it on
   * every `open`, so this is only a safety net for a caller that builds a run
   * identity by hand.
   */
  defaultTimeoutMs?: number;
}

/** Upstream's `DEFAULT_HISTORIAN_TIMEOUT_MS`, restated for a hand-built run. */
export const DEFAULT_HIDDEN_RUN_TIMEOUT_MS = 600_000;

interface RunSlot {
  run: HiddenRunIdentity;
  controller: AbortController;
  /** Set by `attempt`, awaited by `collect`. Absent = no prompt was sent. */
  attempt?: Promise<SidecarModelCallResult>;
  timeout?: ReturnType<typeof setTimeout>;
}

/**
 * Build the ZCode `HiddenCompletionExecutor` over an injected sidecar call.
 *
 * One executor per process is enough (the runner serialises per session through
 * the compartment lease); the returned object holds only its own run slots, so
 * sharing it across sessions is safe.
 */
export function createHiddenCompletionExecutor(
  options: HiddenCompletionExecutorOptions,
): HiddenCompletionExecutor {
  const slots = new Map<string, RunSlot>();
  const supportsTools = options.supportsTools ?? false;

  const refuse = (
    code: ConstructorParameters<typeof HiddenCompletionRefusal>[0],
    message: string,
  ): HiddenCompletionRefusal =>
    new HiddenCompletionRefusal(code, message, TERMINAL_REFUSAL_CODES.has(code));

  return {
    // The fork's historian runs with zero tools: the system prompt asks for XML
    // and the schema fence lives in `compartment-runner-validation.ts`, not in
    // tool-call enforcement. `supportsTools` is reported honestly so a future
    // tool-bearing hidden run cannot assume otherwise.
    capabilities: { tools: supportsTools, harness: getHarness() },

    async open(run: HiddenRunIdentity): Promise<HiddenRunHandle> {
      if (!options.sidecarModelCall) {
        throw refuse(
          "unsupported_transport",
          "createHiddenCompletionExecutor was called without a sidecarModelCall",
        );
      }
      if (run.model === undefined && (run.configuredModels?.length ?? 0) === 0) {
        throw refuse(
          "hidden_model_unsupported",
          "historian run carries neither a model nor a configured fallback chain",
        );
      }
      if (!supportsTools && run.agent !== "historian" && run.agent !== "historian-editor") {
        throw refuse(
          "hidden_tools_unsupported",
          `transport cannot serve hidden runs for agent ${run.agent}`,
        );
      }

      const id = crypto.randomUUID();
      const controller = new AbortController();
      const timeoutMs = run.timeoutMs > 0 ? run.timeoutMs : (options.defaultTimeoutMs ?? DEFAULT_HIDDEN_RUN_TIMEOUT_MS);
      const slot: RunSlot = { run, controller };
      // The executor owns the clock so a hung provider socket cannot wedge the
      // historian's drain: the runner's own race is a second line of defence, but
      // this one fires first and unwinds the request properly.
      const timer = setTimeout(() => controller.abort(new Error(
        `hidden completion ${run.kind} exceeded its ${timeoutMs}ms timeout budget`,
      )), timeoutMs);
      timer.unref?.();
      slot.timeout = timer;
      slots.set(id, slot);
      return { id };
    },

    async attempt(handle: HiddenRunHandle, request: PromptArgs): Promise<void> {
      const slot = slots.get(handle.id);
      if (!slot) {
        throw new Error(`hidden completion attempt on an unknown or closed run: ${handle.id}`);
      }
      if (slot.attempt) {
        // A second attempt on the same handle means the caller believes the first
        // one did not settle. Re-sending is exactly what the four-stage contract
        // exists to prevent, so refuse rather than double-charge the user.
        throw new Error(
          `hidden completion run ${handle.id} already has a settled-or-pending prompt; refusing to re-send`,
        );
      }
      const call = options.sidecarModelCall;
      if (!call) {
        throw refuse("unsupported_transport", "the sidecar model call was un-wired mid-run");
      }
      const prompt = readPrompt(request);
      if (prompt.length === 0) {
        throw refuse("hidden_prompt_unrecognized", "the attempt carried no text part to send");
      }
      slot.attempt = call(
        {
          run: slot.run,
          prompt,
          abortSignal: slot.controller.signal,
        },
        // The hard constraint, stated at the only call site in the codebase that
        // can produce a historian model request. See the file header.
        { preserveProviderStreamBoundaries: true },
      ).catch((error: unknown) => {
        const refusal = classifySidecarFailure(error, {
          hasModel: slot.run.model !== undefined,
          transportWired: true,
        });
        throw refusal ?? error;
      });
    },

    async collect(handle: HiddenRunHandle, _limit: number): Promise<HiddenCompletion> {
      const slot = slots.get(handle.id);
      if (!slot) {
        throw new Error(`hidden completion collect on an unknown or closed run: ${handle.id}`);
      }
      if (!slot.attempt) {
        // Upstream's contract: a read must never resend a prompt, and it must not
        // invent one either. No attempt means the caller never sent anything.
        throw refuse(
          "hidden_prompt_unrecognized",
          "collect ran before any attempt settled a prompt for this run",
        );
      }
      const result = await slot.attempt;
      return {
        text: result.text,
        reasoning: result.reasoning ?? null,
        usage: toTokenTotals(result),
        lengthCapped: result.lengthCapped === true,
        providerId: result.providerId,
        modelId: result.modelId,
      };
    },

    async close(
      handle: HiddenRunHandle | null,
      settlement: {
        promptSettled: boolean;
        privacySensitive: boolean;
        context: string;
        log: (message: string) => void;
      },
    ): Promise<void> {
      if (!handle) return;
      const slot = slots.get(handle.id);
      if (!slot) return;
      slots.delete(handle.id);
      if (slot.timeout) clearTimeout(slot.timeout);
      if (slot.attempt && !settlement.promptSettled) {
        // The prompt never settled — cancel the provider request rather than let
        // an orphan stream keep billing. Swallowing the rejection is correct: the
        // runner is already unwinding and `attempt`'s error is what it will report.
        slot.controller.abort(new Error(`${settlement.context} run closed before the prompt settled`));
        void slot.attempt.catch(() => {});
      }
      settlement.log(
        `${settlement.context} sidecar run ${handle.id} closed (promptSettled=${settlement.promptSettled} privacySensitive=${settlement.privacySensitive})`,
      );
    },
  };
}

/**
 * Pull the user prompt out of a `PromptArgs` body.
 *
 * The historian prompt is always the single text part the runner built
 * (`{ type: "text", text, synthetic: true }`); the `synthetic` flag keeps it out
 * of any host-visible transcript and does not affect the wire.
 */
function readPrompt(request: PromptArgs): string {
  const parts = request.body?.["parts"];
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (part !== null && typeof part === "object") {
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        texts.push(candidate.text);
      }
    }
  }
  return texts.join("\n\n");
}