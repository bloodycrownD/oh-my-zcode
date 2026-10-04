/**
 * Verbatim port of `features/magic-context/dreamer/token-budget.ts` (upstream).
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 *
 * WHY IT IS IN THE FORK (S18 close-out). `hooks/magic-context/dropped-input-guard.ts`
 * — the module `tool-drop-target.ts` calls `droppedInputMarker()` from — reaches
 * this one through a single symbol, `refuseBudgetedToolCall`. Upstream marks
 * `dreamer/**` 「明确不移植」, so the S18 test harness staged BOTH files from the
 * reference tree under `node_modules/.cache` purely so `tool-drop-target` could
 * be loaded. This closes that hole: both files are now real, ported package
 * sources at their real paths, so the graph compiles and runs with no overlay.
 *
 * The module is self-contained (zero imports upstream), so the port is byte
 * identical. `dreamer/**` as a GROUP stays out of the fork — the child-agent
 * dream loop, its task registry, and its schedule are separate modules that no
 * ported file imports.
 */

export class DreamTokenBudgetExceeded extends Error {
    constructor(
        readonly sessionId: string,
        readonly spent: number,
    ) {
        super(`Dreamer child ${sessionId} spent ${spent} prompt tokens (token_budget)`);
        this.name = "DreamTokenBudgetExceeded";
    }
}

export const TOKEN_BUDGET_FINALIZE_MESSAGE =
    "You're out of token budget. Stop investigating: make no more tool calls and output your result now, covering only what you've already checked; leave the rest out.";
export const TOKEN_BUDGET_TOOL_REFUSAL =
    "Out of token budget: no more tool calls. Output your result now.";

/** Count only provider-reported prompt tokens. Output and reasoning do not replay
 * the accumulated context and must not be added to this cost guard. */
export interface DreamTokenBudgetState {
    readonly budget: number;
    readonly spent: number;
    readonly finalizeFired: boolean;
    readonly refusedCalls: number;
    readonly hardStopped: boolean;
}

const finalizingChildren = new Map<string, ReturnType<typeof createDreamTokenBudget>>();

/** The tool hook runs in the OpenCode plugin process, alongside child polling. */
export function registerBudgetFinalizeChild(
    sessionId: string,
    guard: ReturnType<typeof createDreamTokenBudget>,
): void {
    finalizingChildren.set(sessionId, guard);
}

export function releaseBudgetFinalizeChild(sessionId: string): void {
    finalizingChildren.delete(sessionId);
}

export function refuseBudgetedToolCall(
    sessionId: string,
): { message: string; hardStopped: boolean } | null {
    return finalizingChildren.get(sessionId)?.refuseTool() ?? null;
}

export function createDreamTokenBudget(budget: number) {
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Invalid token budget");
    let spent = 0;
    let finalizeFired = false;
    let refusedCalls = 0;
    let forcedStop = false;
    const snapshot = (): DreamTokenBudgetState => ({
        budget,
        spent,
        finalizeFired,
        refusedCalls,
        hardStopped: forcedStop || spent >= budget || refusedCalls >= 2,
    });
    return {
        snapshot,
        /** Call once per provider usage report; a host must deduplicate message IDs. */
        charge(
            input: number,
            cacheRead: number,
            cacheWrite: number,
            completed = false,
            canFinalize = true,
        ): "continue" | "finalize" | "stop" {
            for (const value of [input, cacheRead, cacheWrite]) {
                if (!Number.isSafeInteger(value) || value < 0)
                    throw new Error("Invalid prompt usage");
            }
            spent += input + cacheRead + cacheWrite;
            // Usage caps further investigation, not a finished answer already paid for.
            if (completed) return "continue";
            if (spent >= budget) return "stop";
            if (!completed && !finalizeFired && spent >= budget * 0.8) {
                if (!canFinalize) {
                    forcedStop = true;
                    return "stop";
                }
                finalizeFired = true;
                return "finalize";
            }
            return "continue";
        },
        refuseTool(): { message: string; hardStopped: boolean } | null {
            if (!finalizeFired && !snapshot().hardStopped) return null;
            refusedCalls += 1;
            return { message: TOKEN_BUDGET_TOOL_REFUSAL, hardStopped: snapshot().hardStopped };
        },
    };
}