// FORK-NOTE(Step 15 / bugfix-batch-20261011): upstream
// `features/magic-context/mural/mural-selection.ts` (31 lines) — NEW PORT.
//
// THE CIRCULAR IMPORT AT LINE 1 IS UPSTREAM'S OWN AND IS PRESERVED VERBATIM:
// `mural-selection` imports `trimMemoriesToBudgetV2` from
// `hooks/magic-context/inject-compartments`, and inject-compartments (through
// the mural render-trigger imported in this step) imports `mural-selection`.
// Upstream ships this cycle deliberately: the mural overflow set MUST be the
// exact complement of the same budget trim the m[0] injection runs — a second
// copy of the ranking would drift and the mural would show memories that are
// actually still injected. ESM handles the cycle because both modules only use
// the imports at call time (function bodies), never at module-evaluation time;
// both import sites are in-package and the graph is identical to upstream's.
//
// Import adaptation: the two specifiers gained explicit `.js` suffixes for
// NodeNext (including the inject-compartments one, above). No behavioral
// adaptation.
//
// MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
import { trimMemoriesToBudgetV2 } from "../../../hooks/magic-context/inject-compartments.js";
import type { Memory } from "../memory/types.js";

/**
 * The mural memory budget: the token budget the overflow set is computed
 * against. Callers pass the project's configured memory injection budget so the
 * mural shows exactly the memories the m0 injection dropped; this constant is
 * the fallback when no budget is supplied.
 */
export const DEFAULT_MURAL_MEMORY_BUDGET = 8_000;

/**
 * The mural overflow set: memories that did NOT fit the m0 memory budget. This
 * is the COMPLEMENT of the same rank-ordered budget trim the m0 injection path
 * runs, so the mural surfaces exactly what the budget pushed out — the material
 * the agent would otherwise never see. Selection is deterministic; nothing here
 * calls an LLM.
 */
export function muralOverflowMemories(
    memories: readonly Memory[],
    budgetTokens = DEFAULT_MURAL_MEMORY_BUDGET,
): Memory[] {
    const selected = trimMemoriesToBudgetV2(
        "mural-selection",
        [...memories],
        budgetTokens,
    ).selected;
    const selectedIds = new Set(selected.map((memory) => memory.id));
    return memories.filter((memory) => !selectedIds.has(memory.id));
}
