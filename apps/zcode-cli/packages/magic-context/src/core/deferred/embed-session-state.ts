// FORK-NOT-PORTED: `hooks/magic-context/embed-session-state.ts` 的 EmbedDrainUiStatus 类型摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. The module is the process-local state of the `/ctx-embed`
// background drain: the pause set, the AbortController per running drain, and
// the completed-attempt / provider-identity ledger. The fork ships no embedding
// provider, so no drain ever starts and every one of those maps is permanently
// empty. The whole file is 56 lines with one external dependency — the
// `RecompProgress` type — which is itself a deferred seam.
//
// The B group reaches exactly one member, as a type:
// `format-embed-status.ts` imports `EmbedDrainUiStatus` to type the status it
// renders. Reproduced verbatim.
//
// Step 21: delete this file and repoint `format-embed-status.ts` back at
// `./embed-session-state.js`, or — if embedding stays out of the fork — replace
// the type import with the local four-member union the renderer already switches
// on.

import type { RecompProgress } from "../hooks/magic-context/compartment-runner-types.js";

/** Verbatim: `embed-session-state.ts:19`. */
export type EmbedDrainUiStatus = "idle" | "running" | "paused" | "stopped";

/**
 * Verbatim: `embed-session-state.ts:26-48`. Always `"idle"`, because no drain
 * ever starts in this fork — `embedPauseBySession` and `embedRunStateBySession`
 * have no writer, and no `RecompProgress` with `kind: "embed"` is ever emitted
 * (the compartment runner that would emit it throws FORK-DEFERRED(S20)).
 *
 * Kept rather than hard-coded to `{status: "idle"}` so the `detail` arm stays
 * visible to a Step-21 port and so the shape is provably identical to upstream.
 */
export function getEmbedDrainUiStatus(
    _sessionId: string,
    _progress: Pick<RecompProgress, "kind" | "phase" | "message"> | undefined,
): { status: EmbedDrainUiStatus; detail?: string } {
    return { status: "idle" };
}