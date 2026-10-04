// FORK-NOT-PORTED: `hooks/magic-context/auto-search-runner.ts` 的 AutoSearchOutcome / AutoSearchRunnerOptions 类型与 runAutoSearchHint 函数摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. The auto-search runner embeds the user's own prompt, searches
// the project's memories, and appends a "vague recall" hint. It needs
// `features/magic-context/search` (unifiedSearch), `memory/embedding`, and the
// caveman compressor's rule table — none of which the fork ships, and no
// `ctx_search` tool exists on the ZCode side.
//
// SEMANTIC DECISION — `runAutoSearchHint` returns `{ ok: true }`, upstream's own
// `AUTO_SEARCH_OK` constant (`auto-search-runner.ts:49`), which is what the
// upstream function returns on all six of its own no-op exits (feature disabled,
// no meaningful user message, hint already decided, non-tail pass, and the two
// reconciliation outcomes). The call site
// (`transform-postprocess-phase.ts:3292-3320`) reads only `autoSearchOutcome.ok`
// — `false` would record an `auto-search-<kind>` degradation on a pass where
// nothing went wrong — and the whole call already sits inside a try/catch that
// records `auto-search-internal-failure`. A throw would be caught and turned into
// a pass degradation for a feature the fork does not have.
//
// Step 21: delete this file and repoint
// `transform-postprocess-phase.ts` back at `./auto-search-runner.js`, or — if
// ctx_search stays out of the fork — delete the import outright.

import type { Database } from "../shared/sqlite.js";
import type { CavemanWordRules } from "../hooks/magic-context/caveman.js";
import type { MessageLike } from "../hooks/magic-context/transform-operations.js";

/** Verbatim: `auto-search-runner.ts:45-47`. */
export type AutoSearchOutcome =
    | { ok: true }
    | { ok: false; kind: "timeout" | "search-failure" | "cas-exhaustion" };

/**
 * Verbatim: `auto-search-runner.ts:51-70`, minus the `AutoSearchRunnerOptions`
 * members whose types come from unported modules.
 *
 * `visibleMemoryIds` is typed `ReadonlySet<number>` to match the ported caller:
 * `inject-compartments.ts`'s `getVisibleMemoryIds` returns a `Set<number>` and
 * `transform-postprocess-phase.ts:3289` forwards it unchanged. Upstream widens
 * the runner's own signature only to an array; the fork's caller is the
 * authoritative shape here, and no fork code iterates this field.
 */
export interface AutoSearchRunnerOptions {
    enabled: boolean;
    scoreThreshold: number;
    minPromptChars: number;
    directory?: string;
    projectPath: string;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    gitCommitsEnabled?: boolean;
    /** Memory ids already visible in message[0]; the runner drops hints for them. */
    visibleMemoryIds?: ReadonlySet<number>;
    wordRules?: CavemanWordRules;
}

/**
 * Entry point. Called from transform post-processing. No-op when disabled,
 * when there is no meaningful user message, when prompt is too short, when
 * search returns nothing strong enough, or when the hint has already been
 * appended for this turn.
 *
 * Signature verbatim from `auto-search-runner.ts:205-210`; always takes
 * upstream's own OK exit — see the header note.
 */
export async function runAutoSearchHint(_args: {
    sessionId: string;
    db: Database;
    messages: MessageLike[];
    options: AutoSearchRunnerOptions;
}): Promise<AutoSearchOutcome> {
    return { ok: true };
}