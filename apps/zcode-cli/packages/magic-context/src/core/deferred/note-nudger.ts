// FORK-NOT-PORTED: `hooks/magic-context/note-nudger.ts` 的 onNoteTrigger / peekNoteNudgeText / markNoteNudgeDelivered 与 `hooks/magic-context/note-visibility.ts` 的 hasVisibleNoteReadCall 摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. The note nudge surfaces `<ctx_note>` intentions to the agent
// at a work boundary. The fork ships no `ctx_note` tool, so there is no note to
// nudge; the `ctx-search-hint`/`ctx-note` tool surface is ZCode's.
//
// SEMANTIC DECISION — the peek returns `null` and the visibility probe returns
// `false`, and the delivery marker answers "already present". Reasoning from the
// two call sites (`transform-postprocess-phase.ts:1153-1179` and `:3170-3199`):
//
//   - `peekNoteNudgeText(...) === null` makes both `if (deferredNoteText)` blocks
//     skip entirely, so no `<instruction name="deferred_notes">` is ever appended
//     and `markNoteNudgeDelivered` is never reached. That is the truthful answer
//     for a fork with no notes: no nudge text, no wire mutation.
//   - `hasVisibleNoteReadCall(...) === false` is upstream's own "no visible read"
//     answer and feeds only the suppression argument to the peek, so the pair is
//     self-consistent.
//   - `markNoteNudgeDelivered` returns `{ok: true, kind: "already-present"}` —
//     upstream's own no-anchor arm, which is what a caller that placed nothing
//     should be told. Returning `{ok: false}` instead would make the caller log
//     a CAS failure and record a `note-nudge-cas-failure` degradation on a pass
//     that in fact did nothing wrong.
//   - `onNoteTrigger` is a no-op: upstream's body only stages a durable
//     `triggerPending` flag that the peek reads, and the peek no longer reads it.
//
// Step 21: delete this file and repoint
// `transform-postprocess-phase.ts` back at `./note-nudger.js` /
// `./note-visibility.js`, or — if ctx_note stays out of the fork — delete the
// four imports outright.

import { isRecord } from "../shared/record-type-guard.js";
import type { Database } from "../shared/sqlite.js";
import type { NoteNudgeDeliveryOutcome } from "../features/magic-context/storage-meta-persisted.js";
import { isSentinel } from "../hooks/magic-context/sentinel.js";
import type { MessageLike } from "../hooks/magic-context/tag-messages.js";

/** The three triggers that fire a note nudge; only the log line names them. */
export type NoteNudgeTrigger = "commit_detected" | "todo_cleared" | "wrapup";

/**
 * Signal that a trigger event occurred.
 *
 * No-op: see the header note. Signature verbatim from `note-nudger.ts:76`.
 */
export function onNoteTrigger(
    _db: Database,
    _sessionId: string,
    _trigger: NoteNudgeTrigger,
): void {
    return;
}

/**
 * Peek at whether a note nudge should be injected during this transform pass.
 * Returns the nudge text if yes, null if no.
 *
 * Always null — see the header note. Signature verbatim from
 * `note-nudger.ts:105-111`.
 */
export function peekNoteNudgeText(
    _db: Database,
    _sessionId: string,
    _currentUserMessageId?: string | null,
    _projectIdentity?: string,
    _noteReadStillVisible?: boolean,
): string | null {
    return null;
}

/**
 * Mark the note nudge as delivered after successful placement.
 *
 * Reports "already present" — upstream's own no-anchor arm. Signature verbatim
 * from `note-nudger.ts:290-295`.
 */
export function markNoteNudgeDelivered(
    _db: Database,
    _sessionId: string,
    _text: string,
    _messageId: string | null,
): NoteNudgeDeliveryOutcome {
    return { ok: true, kind: "already-present" };
}

const NOTE_TOOL_NAMES = new Set(["ctx_note"]);
const READ_ACTION = "read";

/**
 * Returns true if the messages array contains at least one non-stripped
 * `ctx_note(action="read")` tool call/result pair.
 *
 * Always false — see the header note. Body verbatim from
 * `note-visibility.ts:49-56`.
 */
export function hasVisibleNoteReadCall(_messages: MessageLike[]): boolean {
    return false;
}

/**
 * Detect a `ctx_note(action="read")` tool call across the three OpenCode part
 * shapes. Verbatim from `note-visibility.ts:74-116`; retained so the seam keeps
 * the upstream predicate available for Step 21 without another trip upstream.
 */
export function isVisibleNoteReadPart(part: unknown): boolean {
    if (!isRecord(part)) return false;

    if (part.type === "tool" && typeof part.tool === "string" && NOTE_TOOL_NAMES.has(part.tool)) {
        const state = part.state;
        if (isRecord(state) && isRecord(state.input)) {
            return state.input.action === READ_ACTION;
        }
        return false;
    }

    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        NOTE_TOOL_NAMES.has(part.name)
    ) {
        if (isRecord(part.input)) {
            return part.input.action === READ_ACTION;
        }
        return false;
    }

    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        NOTE_TOOL_NAMES.has(part.toolName)
    ) {
        const argsCandidate = part.args ?? part.input;
        if (isRecord(argsCandidate)) {
            return argsCandidate.action === READ_ACTION;
        }
        return false;
    }

    return false;
}

// `isSentinel` is imported so the seam keeps the exact part-shape filter the
// upstream predicate applies before dispatching; a caller porting the real
// `hasVisibleNoteReadCall` needs it and must not have to re-derive the import.
export { isSentinel };