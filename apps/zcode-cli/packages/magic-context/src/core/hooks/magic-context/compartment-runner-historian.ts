// FORK-NOTE(S20): upstream `hooks/magic-context/compartment-runner-historian.ts`
// (1055 lines) reduced to the side-car transport the fork actually runs (D-6).
// Now at its upstream path and the REAL historian call path.
//
// WHAT IS UPSTREAM'S, UNCHANGED IN BEHAVIOUR:
//   - the four-stage executor drive (`open` → `attempt` → `collect` → `close`
//     with `close` in a `finally`), and the reason it is four stages: a read
//     failure must never re-send the prompt;
//   - the retry loop shape: `MAX_HISTORIAN_RETRIES` attempts, retrying ONLY
//     while `isTransientHistorianPromptError` says so, with the same two-step
//     backoff schedule;
//   - `runValidatedHistorianPass`'s escalation order — primary → repair prompt →
//     ordered fallback chain → last-ditch session model — with validation gating
//     EVERY candidate so an empty-but-successful primary escalates instead of
//     ending the pass;
//   - the optional editor pass falling back to the already-validated draft, and
//     its explicit refusal to iterate the fallback chain (audit finding #10: the
//     draft is already valid, so an editor no-op is cheaper and safer);
//   - `promptSettled` bookkeeping and the settlement passed to `close`.
//
// WHAT THE TRANSPORT CHANGE FORCED:
//   - No child session, no `shared` barrel (`normalizeSDKResponse`,
//     `promptSyncWithModelSuggestionRetry`, `runTokenLog`,
//     `child-session-spawn`, `child-session-teardown`,
//     `assistant-message-extractor`, `subagent-token-capture`): the fork's
//     `HiddenCompletionExecutor` (see `src/host/hidden-completion-executor.ts`)
//     issues ONE side-car model request and hands back text + usage. So
//     `runHistorianPrompt` calls `executor.attempt(...)` directly instead of
//     going through E group's model-suggestion retry transport, and reads the
//     completion straight off `executor.collect(...)`.
//   - No response dumps (`historianResponseDumpDir` wrote into
//     `<project>/.opencode/magic-context/historian/`, an OpenCode path this fork
//     does not have). A failed validation is still fully diagnosable: its reason
//     is returned in `ValidatedHistorianPassResult.error` and logged.
//   - No `subagent_invocations` row per pass. `storage-subagent-invocations.ts`
//     is A-group and available, but upstream keys it on an OpenCode child
//     session id this fork never has; the fork's attribution for a historian run
//     is the executor's own usage, which the caller logs.
//   - No producer-window admission (`historianPromptAdmissionFailure`). It needs
//     `models-dev-cache` context limits plus `resolveHistorianProducerLimits`,
//     and its refusal vocabulary is a second source of truth competing with the
//     sidecar's own. The chunk is already sized by `historianChunkTokens`.
//   - `DEFAULT_HISTORIAN_TIMEOUT_MS` is restated here at upstream's value
//     (600_000). E group deliberately left `timeout_ms` out of the hot-reload
//     whitelist (`host/config/schema.ts`), so no config value overrides it today;
//     `deps.historianTimeoutMs` still wins when a caller supplies one.
//   - The timeout is enforced HERE as well as inside the executor. Upstream
//     relied on the host transport's `timeoutMs`; a side-car executor could hang
//     on a provider socket, and a historian that never returns wedges the drain
//     forever, so the runner races the whole attempt against the budget and
//     fails it with a message the transient classifier recognises.
//
// NOT IN THIS FILE: `/ctx-recomp`'s `HISTORIAN_RECOMP_AGENT` runs. Those live in
// `compartment-runner-{recomp,partial-recomp}.ts`, which Step 22 rewrites.

import { HISTORIAN_AGENT, HISTORIAN_EDITOR_AGENT } from "../../agents/historian.js";
import { withContentLanguageDirective } from "../../agents/language-directive.js";
import { describeError, getErrorMessage } from "../../shared/error-message.js";
import { isTransientHistorianPromptError } from "./historian-transient-error.js";
import type { ModelInput } from "../../deferred/model-resolution.js";
import {
    buildHistorianEditorPrompt,
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "./compartment-prompt.js";
import type {
    HiddenCompletionExecutor,
    HiddenRunHandle,
    HistorianProgressCallbacks,
    HistorianRunResult,
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types.js";
import { HiddenCompletionRefusal } from "./compartment-runner-types.js";
import {
    buildHistorianRepairPrompt,
    type HistorianValidationChunk,
    validateHistorianOutput,
} from "./compartment-runner-validation.js";
import { sessionLog } from "../../shared/logger.js";

/**
 * Source: `config/schema/magic-context.ts` `DEFAULT_HISTORIAN_TIMEOUT_MS`.
 * Restated here because `config/` is the host adapter's layer and `core/` must
 * not import it (E group narrowed the schema and dropped this knob).
 */
export const DEFAULT_HISTORIAN_TIMEOUT_MS = 600_000;

/** Upstream's `MAX_HISTORIAN_RETRIES` (`compartment-runner-historian.ts:79`). */
const MAX_HISTORIAN_RETRIES = 2;

/**
 * D-6: the historian runs in-process, so the executor is always INJECTED. There
 * is no `createV1HiddenCompletionExecutor` fallback here — upstream built one on
 * an OpenCode SDK client, and this fork has no such client. A missing executor is
 * a wiring bug, and it must surface as a throw at the call site rather than as a
 * historian that silently never fires.
 */
export function resolveHiddenCompletionExecutor(
    executor: HiddenCompletionExecutor | undefined,
    entryPoint: string,
): HiddenCompletionExecutor {
    if (executor) return executor;
    throw new Error(
        `${entryPoint}: no HiddenCompletionExecutor is configured — the ZCode host must inject one (D-6 side-car model request)`,
    );
}

/** Model key of a `ModelInput`, for logging and fallback de-duplication. */
function toModelEntry(model: ModelInput | undefined): { model: string; qualifier?: string } | undefined {
    if (model == null) return undefined;
    if (typeof model === "string") return model.length > 0 ? { model } : undefined;
    return model.model.length > 0 ? model : undefined;
}

/**
 * Race `operation` against a deadline. Returns `{ timedOut: true }` instead of
 * rejecting so the caller can classify the failure with its own retry policy —
 * the timeout message deliberately contains `timeout` so
 * `isTransientHistorianPromptError` treats it as retryable.
 */
async function withTimeoutBudget<T>(
    timeoutMs: number,
    operation: () => Promise<T>,
): Promise<{ timedOut: false; value: T } | { timedOut: true; error: Error }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<{ timedOut: true; error: Error }>((resolve) => {
            timer = setTimeout(
                () =>
                    resolve({
                        timedOut: true,
                        error: new Error(
                            `historian attempt exceeded its ${timeoutMs}ms timeout budget`,
                        ),
                    }),
                timeoutMs,
            );
            timer.unref?.();
        });
        return await Promise.race([
            operation().then((value) => ({ timedOut: false as const, value })),
            timeout,
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export interface RunValidatedHistorianPassArgs {
    hiddenCompletionExecutor: HiddenCompletionExecutor;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: HistorianValidationChunk;
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    timeoutMs?: number;
    maxOutputTokens?: number;
    /** Active historian model entry, including its outbound request variant. */
    model?: ModelInput;
    fallbackModelId?: string;
    /**
     * Resolved historian fallback chain ("provider/modelID" entries). When the
     * primary historian model fails (auth, model-not-found, transient network),
     * each fallback is tried in order. Independent of `fallbackModelId` (which
     * is a last-ditch single-model retry against the active session model).
     */
    fallbackModels?: readonly ModelInput[];
    callbacks?: HistorianProgressCallbacks;
    /** When true, run a second editor pass after successful historian output
     *  to clean low-signal U: lines and cross-compartment duplicates. If editor
     *  validation fails, falls back to the draft (first-pass) result. */
    twoPass?: boolean;
    agentId?: string;
    language?: string;
}

/**
 * Primary → repair → fallback chain, validating every candidate.
 *
 * Upstream `runValidatedHistorianPass` with the two-pass editor folded in as
 * upstream does. The escalation order is the policy that matters: validation
 * gates EVERY candidate, so a model that returns no usable compartments
 * escalates to the next rather than failing the whole pass — which is exactly
 * the path a misconfigured primary needs, since an empty-but-successful
 * response never throws and so never triggers a throw-based chain.
 */
export async function runValidatedHistorianPass(
    args: RunValidatedHistorianPassArgs,
): Promise<ValidatedHistorianPassResult> {
    const firstRun = await runHistorianPrompt({
        ...args,
        modelOverride: args.model,
        agentId: args.agentId,
    });
    if (!firstRun.ok || !firstRun.result) {
        if (firstRun.refusal?.terminal)
            return { ok: false, error: firstRun.error ?? firstRun.refusal.message };
        return runFallbackHistorianPass({
            ...args,
            prompt: args.prompt,
            error: firstRun.error ?? "historian run failed",
        });
    }

    const firstValidation = validateHistorianOutput(
        firstRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (firstValidation.ok) {
        const finalResult = args.twoPass
            ? await runEditorPassOrFallback({
                  ...args,
                  draftXml: firstRun.result,
                  draftValidation: firstValidation,
              })
            : firstValidation;
        return finalResult;
    }

    await args.callbacks?.onRepairRetry?.(firstValidation.error ?? "invalid compartment output");
    const repairPrompt = buildHistorianRepairPrompt(
        args.prompt,
        firstRun.result,
        firstValidation.error ?? "invalid compartment output",
        args.language,
    );
    const repairRun = await runHistorianPrompt({
        ...args,
        prompt: repairPrompt,
        modelOverride: args.model,
        agentId: args.agentId,
    });
    if (!repairRun.ok || !repairRun.result) {
        if (repairRun.refusal?.terminal)
            return { ok: false, error: repairRun.error ?? repairRun.refusal.message };
        return runFallbackHistorianPass({
            ...args,
            prompt: repairPrompt,
            error: repairRun.error ?? "historian repair run failed",
        });
    }

    const repairValidation = validateHistorianOutput(
        repairRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (repairValidation.ok) {
        return args.twoPass
            ? await runEditorPassOrFallback({
                  ...args,
                  draftXml: repairRun.result,
                  draftValidation: repairValidation,
              })
            : repairValidation;
    }

    return runFallbackHistorianPass({
        ...args,
        prompt: repairPrompt,
        error: repairValidation.error ?? "invalid compartment output",
    });
}

/**
 * Run the historian-editor agent on a validated historian draft. Returns the
 * editor's validated result if successful; falls back to the draft on any
 * failure (editor call, validation, or invalid structure). Editor can never
 * regress behavior — worst case we return the same validated draft.
 *
 * Fallback-chain policy (Audit Finding #10 clarification): the editor pass
 * deliberately does NOT receive `fallbackModels`. If the configured editor
 * model fails (auth, model-not-found, transient network, or the editor's own
 * output fails validation), the function returns the already-validated draft
 * unchanged. Iterating through fallback models here would cost extra LLM
 * calls per chunk for no compression benefit — the draft is already known to
 * be valid and the editor pass is purely a polish step. Letting the editor
 * silently no-op back to the draft is the cheaper and safer behavior.
 */
async function runEditorPassOrFallback(args: RunValidatedHistorianPassArgs & {
    draftXml: string;
    draftValidation: ValidatedHistorianPassResult & { ok: true };
}): Promise<ValidatedHistorianPassResult> {
    sessionLog(args.parentSessionId, "historian two-pass: running editor on draft");
    const editorRun = await runHistorianPrompt({
        ...args,
        prompt: buildHistorianEditorPrompt(args.draftXml),
        agentId: HISTORIAN_EDITOR_AGENT,
        modelOverride: args.model,
    });

    if (!editorRun.ok || !editorRun.result) {
        sessionLog(args.parentSessionId, "historian two-pass: editor call failed", {
            error: editorRun.error,
        });
        // Editor failed → keep the validated draft.
        return args.draftValidation;
    }

    const editorValidation = validateHistorianOutput(
        editorRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (!editorValidation.ok) {
        sessionLog(args.parentSessionId, "historian two-pass: editor validation failed, falling back to draft", {
            error: editorValidation.error,
        });
        // Editor output was bad — keep the validated draft.
        return args.draftValidation;
    }

    sessionLog(args.parentSessionId, "historian two-pass: editor accepted");
    return editorValidation;
}

/** One executor lifecycle: open → attempt (with transient retries) → collect → close. */
async function runHistorianPrompt(args: {
    hiddenCompletionExecutor: HiddenCompletionExecutor;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    language?: string;
    modelOverride?: ModelInput;
    /** Agent identifier to route the request to. Defaults to HISTORIAN_AGENT.
     *  Use HISTORIAN_EDITOR_AGENT for the second pass in two-pass mode. */
    agentId?: string;
    /** Resolved historian fallback chain, forwarded to the run identity. */
    fallbackModels?: readonly ModelInput[];
}): Promise<HistorianRunResult> {
    const { parentSessionId, sessionDirectory, prompt, modelOverride, agentId = HISTORIAN_AGENT } =
        args;
    const executor = resolveHiddenCompletionExecutor(
        args.hiddenCompletionExecutor,
        "historian",
    );
    const timeoutMs = args.timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS;
    let handle: HiddenRunHandle | null = null;
    let promptSettled = false;
    let hadUnsettledPrompt = false;

    const system = withContentLanguageDirective(
        agentId === HISTORIAN_EDITOR_AGENT
            ? HISTORIAN_EDITOR_SYSTEM_PROMPT
            : COMPARTMENT_AGENT_SYSTEM_PROMPT,
        args.language,
    );

    try {
        sessionLog(
            parentSessionId,
            `historian: opening side-car run (agent=${toModelEntry(modelOverride)?.model ?? `agent:${agentId}`} timeoutMs=${timeoutMs})`,
        );
        handle = await executor.open({
            parentSessionId,
            agent: agentId,
            kind: agentId === HISTORIAN_EDITOR_AGENT ? "historian-editor" : "historian",
            system,
            maxOutputTokens: args.maxOutputTokens,
            model: modelOverride,
            configuredModels: [
                ...(modelOverride ? [modelOverride] : []),
                ...(args.fallbackModels ?? []),
            ],
            timeoutMs,
            title: "magic-context-compartment",
            directory: sessionDirectory,
            metadata: { agentId },
        });
        if (!handle.id) {
            return { ok: false, error: "Historian could not create its side-car run." };
        }
        // The retry transport closes over the opened run; bind it once so the
        // closure sees the resolved handle rather than the nullable slot.
        const opened = handle;

        for (let retryIndex = 0; retryIndex <= MAX_HISTORIAN_RETRIES; retryIndex += 1) {
            try {
                const outcome = await withTimeoutBudget(timeoutMs, async () => {
                    await executor.attempt(opened, {
                        path: { id: opened.id },
                        query: { directory: sessionDirectory },
                        body: {
                            agent: agentId,
                            // synthetic keeps this large internal prompt out of any
                            // host-visible transcript; the model still receives it.
                            parts: [{ type: "text", text: prompt, synthetic: true }],
                        },
                    });
                    return undefined;
                });
                if (outcome.timedOut) throw outcome.error;
                promptSettled = !hadUnsettledPrompt;
                sessionLog(
                    parentSessionId,
                    `historian: prompt completed (attempt ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES + 1})`,
                );
                break;
            } catch (error: unknown) {
                hadUnsettledPrompt = true;
                promptSettled = false;
                const errorMsg = getErrorMessage(error);
                sessionLog(
                    parentSessionId,
                    `historian: prompt attempt ${retryIndex + 1} failed: ${errorMsg}`,
                );
                const shouldRetry =
                    retryIndex < MAX_HISTORIAN_RETRIES &&
                    isTransientHistorianPromptError(errorMsg);
                if (!shouldRetry) {
                    throw error;
                }

                const backoffMs = getHistorianRetryBackoffMs(retryIndex);
                sessionLog(
                    parentSessionId,
                    `historian retry ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES} after ${backoffMs}ms: ${errorMsg}`,
                );
                await sleep(backoffMs);
            }
        }

        const completion = await executor.collect(opened, 50);
        const lengthCapped = completion.lengthCapped;
        const usage = completion.usage;
        sessionLog(
            parentSessionId,
            `historian response_chars=${(completion.text ?? completion.reasoning ?? "").length} input=${usage.input} output=${usage.output}`,
        );
        const textResult = completion.text;
        const reasoningResult = textResult ? null : completion.reasoning;
        const emptyError =
            !textResult && reasoningResult && lengthCapped
                ? historianReasoningBudgetDiagnostic(completion.usage.output)
                : !textResult && !reasoningResult
                  ? "Historian returned no assistant output."
                  : !textResult
                    ? "Historian returned reasoning but no assistant text."
                    : lengthCapped
                      ? "Historian returned length-capped output."
                      : null;
        if (emptyError) {
            return { ok: false, error: emptyError };
        }

        // The empty-output guard above returns when neither text nor reasoning came back.
        const result = textResult ?? reasoningResult;
        if (result == null) {
            return { ok: false, error: emptyError ?? "Historian returned no assistant output." };
        }
        return { ok: true, result };
    } catch (modelError: unknown) {
        const desc = describeError(modelError);
        sessionLog(
            parentSessionId,
            `historian prompt failed: ${desc.brief} promptLength=${prompt.length}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
        );
        return {
            ok: false,
            error: `Historian failed while processing this session: ${desc.brief}`,
            ...(modelError instanceof HiddenCompletionRefusal ? { refusal: modelError } : {}),
        };
    } finally {
        await executor.close(handle, {
            promptSettled,
            privacySensitive: false,
            context: "historian",
            log: (message) => sessionLog(parentSessionId, message),
        });
    }
}

async function runFallbackHistorianPass(
    args: RunValidatedHistorianPassArgs & { prompt: string; error: string },
): Promise<ValidatedHistorianPassResult> {
    // Ordered escalation that matches the intended fallback policy:
    //   configured fallback_models (in order)  →  live session model (last resort)
    // The primary model already ran (and was repaired) before we get here.
    const seen = new Set<string>();
    const chain: { model: string; qualifier?: string }[] = [];
    const primary = toModelEntry(args.model);
    for (const candidateInput of [
        ...(args.fallbackModels ?? []),
        ...(args.fallbackModelId ? [{ model: args.fallbackModelId }] : []),
    ]) {
        const candidate = toModelEntry(candidateInput);
        if (!candidate) continue;
        const key = `${candidate.model} ${candidate.qualifier ?? ""}`;
        if (!candidate.model || seen.has(key)) continue;
        // Do not repeat the primary attempt, but keep the same model when its
        // fallback intentionally selects a different variant.
        if (primary?.model === candidate.model && primary.qualifier === candidate.qualifier) {
            continue;
        }
        seen.add(key);
        chain.push(candidate);
    }
    if (chain.length === 0) {
        return { ok: false, error: args.error };
    }

    let lastError = args.error;
    for (let i = 0; i < chain.length; i += 1) {
        const modelOverride = chain[i];
        const modelId = modelOverride.model;
        const isSessionModelLastResort = modelId === args.fallbackModelId && i === chain.length - 1;
        sessionLog(
            args.parentSessionId,
            `compartment agent: retrying historian with ${modelId} (${
                isSessionModelLastResort ? "session-model last resort" : "configured fallback"
            } ${i + 1}/${chain.length})`,
        );
        args.callbacks?.onModelFallback?.(modelId, i + 1, chain.length);

        const fallbackRun = await runHistorianPrompt({
            ...args,
            modelOverride,
            agentId: args.agentId,
        });
        if (!fallbackRun.ok || !fallbackRun.result) {
            lastError = fallbackRun.error ?? lastError;
            continue;
        }

        const fallbackValidation = validateHistorianOutput(
            fallbackRun.result,
            args.parentSessionId,
            args.chunk,
            args.priorCompartments,
            args.sequenceOffset,
        );
        if (fallbackValidation.ok) {
            return fallbackValidation;
        }
        lastError = fallbackValidation.error ?? lastError;
        // Escalate to the next candidate.
    }

    return { ok: false, error: lastError };
}

/** Source: `compartment-runner-historian.ts:286-291`, minus the run-token-log tail. */
export function historianReasoningBudgetDiagnostic(outputTokens: number): string {
    return `historian ran out of output budget while reasoning (length-capped at ${outputTokens} tokens, no text) — set historian.maxTokens or route historian.model to a low-reasoning lane/variant`;
}

/** Source: `compartment-runner-historian.ts:993-999`. */
function getHistorianRetryBackoffMs(retryIndex: number): number {
    if (retryIndex === 0) {
        return 2_000 + Math.floor(Math.random() * 1_001);
    }

    return 6_000 + Math.floor(Math.random() * 2_001);
}

/** Source: `compartment-runner-historian.ts:1001-1005`. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}