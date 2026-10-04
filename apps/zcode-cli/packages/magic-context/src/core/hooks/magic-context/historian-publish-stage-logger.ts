// Verbatim port of upstream `hooks/magic-context/historian-publish-stage-logger.ts`
// (Step 20, C group). Byte-for-byte apart from the `.js` import specifier.
//
// Historian work is background work: nothing waits on it, so the only trace of
// where a slow run spent its time is this log. `startHistorianPublishStage`
// returns a `performance.now()` stamp the caller threads into the matching
// `finish…` call, which is why the two are separate exports rather than one
// wrapping callback.

import { sessionLog } from "../../shared/logger.js";

export function startHistorianPublishStage(
    sessionId: string,
    stage: string,
    extra?: string,
): number {
    const suffix = extra ? ` ${extra}` : "";
    sessionLog(
        sessionId,
        `historian publish stage: stage=${stage} status=started elapsed=0.0ms${suffix}`,
    );
    return performance.now();
}

export function finishHistorianPublishStage(
    sessionId: string,
    stage: string,
    startMs: number,
    status: "completed" | "discarded" | "failed" | "scheduled" = "completed",
    extra?: string,
): void {
    const elapsed = (performance.now() - startMs).toFixed(1);
    const suffix = extra ? ` ${extra}` : "";
    sessionLog(
        sessionId,
        `historian publish stage: stage=${stage} status=${status} elapsed=${elapsed}ms${suffix}`,
    );
}