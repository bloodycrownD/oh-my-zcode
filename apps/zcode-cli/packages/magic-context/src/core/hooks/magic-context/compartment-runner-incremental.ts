// FORK-NOTE(S20): upstream `hooks/magic-context/compartment-runner-incremental.ts`
// (1434 lines) reduced to the publish spine the fork runs. Now at its upstream
// path and the REAL incremental historian.
//
// THE SPINE IS VERBATIM, AND IT IS THE WHOLE POINT OF THIS FILE. Every step
// below appears in upstream in this order, with these guards:
//
//   1. no raw provider → no-op (`hasRawMessageProvider`);
//   2. stored compartments validated before anything is read (`validateStoredCompartments`);
//   3. `offset` = last stored `endMessage + 1`, else 1 — the historian only ever
//      moves FORWARD, which is what makes a half-finished run resumable;
//   4. an immutable protected-tail boundary is REQUIRED; without one the runner
//      no-ops rather than compacting into the live tail (`missing_boundary_snapshot`);
//   5. a stale snapshot is re-resolved once from live state and adopted only if
//      it still exposes a runnable head — the fix for the production livelock
//      where a snapshot captured at trigger time goes stale every turn and the
//      runner no-ops forever while drop ops starve;
//   6. chunk coverage validated BEFORE any `await`, so a gap in the chunk is a
//      cheap synchronous failure rather than a wasted model call;
//   7. `onHistorianRunStarted` fires only after every no-op early return — this is
//      what lets `startCompartmentAgent` deregister a synchronously-no-op'd run
//      instead of starving the same pass's queued drops;
//   8. discard-last healing, forward-progress check, and the dangling-boundary
//      re-check just before COMMIT (the raw snapshot may have moved under a long
//      model call);
//   9. ONE publish transaction: lease re-check, `appendCompartments`, event
//      inserts, and the drop queue, all committing together. A crash cannot leave
//      compartments published without their drops, or drops without compartments.
//
// WHAT IS NOT HERE, each because the module it needs is unported:
//   - prompt fitting (`historian-prompt-fit.ts` → `reference-retrieval`) and the
//     producer-window admission. The chunk is sized by `historianChunkTokens`
//     alone, so the `<compartment_examples_from_other_projects>` /
//     `<session_references>` / `<project-memory>` blocks are empty strings. That is
//     a real quality reduction (cross-project dedup seeds are gone) but not a
//     correctness one: it is the same prompt with three optional blocks omitted.
//   - durable fact promotion, embeddings, primer candidates and user-memory
//     candidates (`memory/`, `compartment-embedding`, `user-memory/` — Batch 2,
//     gated upstream on `memory.enabled` / `memory.auto_promote`).
//   - the `historian_runs` telemetry row (`storage-historian-runs.ts` is available,
//     but upstream's row is keyed on the subagent invocation of an OpenCode child
//     session this fork never creates; writing a row with a permanently-null FK
//     would look like coverage that does not exist).
//   - `v2NonNarrativeStoredGapRanges` / `recoverUnresolvedCompartments`: both ride
//     the `store-generation-rebase` walk, which the fork does not port (a ZCode
//     host serves one projection, so `rebase_status` is always `ok`).

import { insertCompartmentEvents } from "../../features/magic-context/compartment-events.js";
import { isCompartmentLeaseHeld } from "../../features/magic-context/compartment-lease.js";
import { appendCompartments, getCompartments } from "../../features/magic-context/compartment-storage.js";
import {
    clearEmergencyDrainLatch,
    clearEmergencyRecovery,
    clearHistorianDrainFailure,
    clearHistorianFailureState,
    describeProtectedTailDrainBudgetSkip,
    getOverflowState,
    incrementHistorianFailure,
    isWrapupInProgress,
    recordHistorianDrainFailure,
    recordProtectedTailNoEligibleHead,
    recordProtectedTailPublicationFloor,
    reserveProtectedTailDrainTokens,
    rollbackProtectedTailDrainReservation,
    setPendingCompactionMarkerState,
} from "../../features/magic-context/storage.js";
import { sendStatusNotification } from "../../deferred/send-session-notification.js";
import { updateSessionMeta } from "../../features/magic-context/storage-meta.js";
import { describeError } from "../../shared/error-message.js";
import { sessionLog } from "../../shared/logger.js";
import { beginSqliteWriterAsync } from "../../shared/sqlite.js";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing.js";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager.js";
import { buildCompartmentAgentPrompt, COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt.js";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue.js";
import { resolveHiddenCompletionExecutor, runValidatedHistorianPass } from "./compartment-runner-historian.js";
import type { HiddenCompartmentRunnerDeps } from "./compartment-runner-types.js";
import {
    buildHistorianFailureNotice,
    buildStoredCompartmentsInvalidNotice,
    HISTORIAN_BOUNDARY_HEALING_SLACK,
    shouldDiscardLastHistorianCompartment,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation.js";
import { producerSourceLocalBudget } from "./derive-budgets.js";
import {
    finishHistorianPublishStage,
    startHistorianPublishStage,
} from "./historian-publish-stage-logger.js";
import { snapTerminalCompartmentToServedRow } from "./host-served-rows.js";
import { clearInjectionCache } from "./inject-compartments.js";
import { persistFilteredNoise } from "./persist-filtered-noise.js";
import {
    createDefaultBoundarySnapshotForTests,
    describeBoundaryDiagnostics,
    hasRunnableCompartmentWindow,
    selectPerRunCap,
    validateBoundarySnapshot,
} from "./protected-tail-boundary.js";
import {
    getRawSessionTagKeysThrough,
    hasRawMessageProvider,
    hasRawSessionMessageById,
    readSessionChunk,
} from "./read-session-chunk.js";
import { estimateTokens } from "./read-session-formatting.js";

export interface DanglingPublicationBoundary {
    sequence: number;
    side: "start" | "end";
    messageId: string;
}

/** Re-resolve the message IDs recorded in the historian snapshot immediately before
 * publishing so concurrent history changes cannot persist stale boundaries.
 *
 * Verbatim: `compartment-runner-incremental.ts:198-224`. */
export function findDanglingPublicationBoundary(
    sessionId: string,
    compartments: ReadonlyArray<{
        sequence: number;
        startMessageId: string;
        endMessageId: string;
    }>,
    messageExists: (sessionId: string, messageId: string) => boolean = hasRawSessionMessageById,
): DanglingPublicationBoundary | null {
    for (const compartment of compartments) {
        if (!messageExists(sessionId, compartment.startMessageId)) {
            return {
                sequence: compartment.sequence,
                side: "start",
                messageId: compartment.startMessageId,
            };
        }
        if (!messageExists(sessionId, compartment.endMessageId)) {
            return {
                sequence: compartment.sequence,
                side: "end",
                messageId: compartment.endMessageId,
            };
        }
    }
    return null;
}

/**
 * The incremental historian pass: read the eligible raw head, summarise it into
 * compartments, and publish them in one transaction.
 *
 * See the file header for the exact upstream steps this preserves and the exact
 * modules whose absence reduces scope rather than correctness.
 */
export async function runCompartmentAgent(deps: HiddenCompartmentRunnerDeps): Promise<void> {
    const { db, sessionId, directory, historianTimeoutMs, getNotificationParams } = deps;
    const providerHistorianChunkTokens = deps.historianChunkTokens;
    const producerKey =
        (typeof deps.model === "string" ? deps.model : deps.model?.model) ?? deps.fallbackModelId;
    const historianChunkTokens = producerSourceLocalBudget(providerHistorianChunkTokens, producerKey);

    let completedSuccessfully = false;
    // Set at COMMIT of the publish transaction. From then on the new compartments are
    // durable and already signaled, so a later throw is a failed side step, not a
    // failed historian run.
    let publishCommitted = false;
    let retainDrainReservationForRetryThrottle = false;
    let issueNotified = false;
    let drainReservation: ReturnType<typeof reserveProtectedTailDrainTokens>["reservation"] = null;

    const executor = resolveHiddenCompletionExecutor(deps.hiddenCompletionExecutor, "historian");

    const notifyHistorianIssue = async (message: string): Promise<void> => {
        issueNotified = true;
        await sendStatusNotification(deps.client, sessionId, message, getNotificationParams?.() ?? {});
    };

    const truncateHistorianInputIfNeeded = (text: string, budget: number): string => {
        if (estimateTokens(text) <= budget) return text;
        let lo = 0;
        let hi = text.length;
        let best = 0;
        const marker = "\n[… tokens truncated by Magic Context to fit the historian window …]";
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (estimateTokens(text.slice(0, mid) + marker) <= budget) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return text.slice(0, best) + marker;
    };

    const rollbackDrainReservation = (): void => {
        if (drainReservation) {
            rollbackProtectedTailDrainReservation(db, drainReservation);
            drainReservation = null;
        }
    };

    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        if (!hasRawMessageProvider(sessionId)) {
            sessionLog(sessionId, "historian no-fire: reason=raw_history_unavailable");
            return;
        }

        let priorCompartments = getCompartments(db, sessionId);
        const existingValidationError = validateStoredCompartments(priorCompartments);
        if (existingValidationError) {
            sessionLog(
                sessionId,
                `historian failure: source=existing-validation reason="${existingValidationError}"`,
            );
            // This is a real failure (stored compartments are corrupt) — record it
            // so `/ctx-status` and the >=95% abort path can see it.
            const failCount = incrementHistorianFailure(db, sessionId, existingValidationError);
            await notifyHistorianIssue(buildStoredCompartmentsInvalidNotice());
            void failCount;
            return;
        }

        const offset =
            priorCompartments.length > 0
                ? priorCompartments[priorCompartments.length - 1].endMessage + 1
                : 1;

        let boundarySnapshot =
            deps.boundarySnapshot ??
            (process.env.NODE_ENV === "test"
                ? createDefaultBoundarySnapshotForTests(sessionId)
                : null);
        if (!boundarySnapshot) {
            sessionLog(
                sessionId,
                "historian no-op: missing protected-tail boundary snapshot from trigger decision",
            );
            rollbackDrainReservation();
            return;
        }
        let validation =
            boundarySnapshot.rawRangeFingerprint.length > 0
                ? validateBoundarySnapshot({
                      db,
                      snapshot: boundarySnapshot,
                      currentContextLimit:
                          deps.currentContextLimit ?? boundarySnapshot.contextLimit,
                  })
                : { ok: true };
        // In an active session the protected tail's newest message changes every turn
        // (a fresh user/assistant message lands), so a snapshot captured at trigger
        // time goes stale on the "last ordinal id" check by the time the historian
        // actually runs — even though the ELIGIBLE HEAD (offset → eligibleEnd) it
        // would compact is untouched. Left as-is the runner no-ops forever while the
        // trigger refires each turn, and queued drop ops starve. Re-resolve the
        // boundary ONCE through the caller's refresh hook and adopt the fresh
        // snapshot when it still exposes a runnable head. This does NOT weaken the
        // protected-tail guarantee: a refreshed snapshot recomputes
        // protectedTailStart/eligibleEnd from the live messages, so the head can
        // never include a message that now belongs to the current protected tail.
        if (!validation.ok && validation.reason === "stale_snapshot") {
            const refreshed = deps.refreshBoundarySnapshot?.(boundarySnapshot, validation);
            if (refreshed && hasRunnableCompartmentWindow(refreshed)) {
                sessionLog(
                    sessionId,
                    `historian: refreshed stale protected-tail snapshot at run time (was: ${validation.detail ?? "stale"}) — eligible head ${refreshed.offset}-${refreshed.eligibleEndOrdinal - 1}`,
                );
                boundarySnapshot = refreshed;
                validation = { ok: true };
            }
        }
        if (!validation.ok) {
            sessionLog(
                sessionId,
                `historian no-op: stale protected-tail snapshot (${validation.detail ?? validation.reason ?? "unknown"})`,
            );
            rollbackDrainReservation();
            return;
        }

        const protectedTailStart = Math.min(
            boundarySnapshot.protectedTailStart,
            boundarySnapshot.rawMessageCountAtTrigger + 1,
        );
        const eligibleEndOrdinal = Math.min(
            boundarySnapshot.eligibleEndOrdinal,
            protectedTailStart,
        );
        if (protectedTailStart <= offset || eligibleEndOrdinal <= offset) {
            sessionLog(
                sessionId,
                `historian no-op: protectedTailStart=${protectedTailStart} eligibleEnd=${eligibleEndOrdinal} <= offset=${offset} — nothing to compact; ${describeBoundaryDiagnostics(boundarySnapshot)}`,
            );
            if (boundarySnapshot.usagePercentage < 80 && !boundarySnapshot.emergencyTailScale) {
                if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            } else {
                const count = recordProtectedTailNoEligibleHead(db, sessionId);
                sessionLog(
                    sessionId,
                    `historian high-pressure no-op: recovery remains armed (noEligibleHeadCount=${count})`,
                );
            }
            clearEmergencyDrainLatch(db, sessionId);
            rollbackDrainReservation();
            return;
        }

        const perRunCap = selectPerRunCap(boundarySnapshot);
        const usable = Math.max(
            1,
            Math.round(
                (boundarySnapshot.contextLimit * boundarySnapshot.executeThresholdPercentage) / 100,
            ),
        );
        const reserve = deps.forceDrainQuota
            ? { ok: true as const, reservation: null }
            : reserveProtectedTailDrainTokens({
                  db,
                  sessionId,
                  runId: crypto.randomUUID(),
                  trueRawTokens: boundarySnapshot.trueRawEligibleTokens,
                  usagePercentage: boundarySnapshot.usagePercentage,
                  usable,
                  perRunCap,
                  executeThresholdPercentage: boundarySnapshot.executeThresholdPercentage,
              });
        if (!reserve.ok) {
            sessionLog(sessionId, describeProtectedTailDrainBudgetSkip(reserve));
            return;
        }
        drainReservation = reserve.reservation;

        const chunk = readSessionChunk(sessionId, historianChunkTokens, offset, eligibleEndOrdinal);
        const forceKeepLastCompartmentForChunk =
            deps.forceKeepLastCompartment === true && !chunk.hasMore;
        if (!chunk.text || chunk.messageCount === 0) {
            if (persistFilteredNoise(db, sessionId, chunk, eligibleEndOrdinal)) {
                rollbackDrainReservation();
                return;
            }
            sessionLog(
                sessionId,
                `historian no-op: chunk empty after filtering (messageCount=${chunk.messageCount}, textLen=${chunk.text?.length ?? 0}) range=${offset}-${eligibleEndOrdinal - 1}`,
            );
            if (boundarySnapshot.usagePercentage < 80 && !boundarySnapshot.emergencyTailScale) {
                if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            } else {
                recordProtectedTailNoEligibleHead(db, sessionId);
            }
            clearEmergencyDrainLatch(db, sessionId);
            rollbackDrainReservation();
            return;
        }
        const chunkText = truncateHistorianInputIfNeeded(chunk.text, historianChunkTokens);

        const chunkCoverageError = validateChunkCoverage(chunk);
        if (chunkCoverageError) {
            const reason = `chunk-coverage: ${chunkCoverageError}`;
            sessionLog(
                sessionId,
                `historian failure: source=chunk-coverage reason="${chunkCoverageError}" chunkRange=${chunk.startIndex}-${chunk.endIndex}`,
            );
            incrementHistorianFailure(db, sessionId, chunkCoverageError);
            await notifyHistorianIssue(
                buildHistorianFailureNotice(1, chunkCoverageError),
            );
            rollbackDrainReservation();
            return;
        }

        // Past every synchronous no-op early-return and immediately before the
        // first `await`: we are now committed to a real historian pass. Signal the
        // caller so startCompartmentAgent keeps the active-run registration.
        deps.onHistorianRunStarted?.();

        // The v2 bounded reference blocks (`<compartment_examples_from_other_projects>`,
        // `<session_references>`, `<project-memory>`) are produced by
        // `historian-prompt-fit.ts`, whose `reference-retrieval` dependency is
        // unported. They are optional in the prompt builder, so the prompt is the
        // same contract with three bounded blocks absent.
        const prompt = buildCompartmentAgentPrompt({
            seedExamples: "",
            sessionReferences: "",
            projectMemory: "",
            inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunkText}`,
            memoryEnabled: deps.memoryEnabled !== false,
        });

        // Defensive: use MAX(sequence) + 1 rather than .length. These only differ when
        // the current DB state has a gap or non-zero-indexed sequences. Using
        // .length would pick a sequence that collides with an existing row and trigger
        // "UNIQUE constraint failed: compartments.session_id, compartments.sequence".
        const maxExistingSequence = priorCompartments.reduce(
            (max, c) => (c.sequence > max ? c.sequence : max),
            -1,
        );
        const sequenceOffset = priorCompartments.length === 0 ? 0 : maxExistingSequence + 1;

        retainDrainReservationForRetryThrottle = true;
        const validatedPass = await runValidatedHistorianPass({
            hiddenCompletionExecutor: executor,
            parentSessionId: sessionId,
            sessionDirectory: directory,
            prompt,
            chunk,
            priorCompartments,
            sequenceOffset,
            timeoutMs: historianTimeoutMs,
            maxOutputTokens: deps.historianMaxOutputTokens,
            model: deps.model,
            fallbackModelId: deps.fallbackModelId,
            fallbackModels: deps.fallbackModels,
            twoPass: deps.historianTwoPass,
            language: deps.language,
        });
        // A window refusal here comes from a fallback model (the primary was sized
        // above). Treat it like any other failed pass: count it, notify, and keep
        // the reserved drain budget spent so the next trigger does not retry at once.
        if (!validatedPass.ok) {
            sessionLog(
                sessionId,
                `historian failure: source=validation reason="${validatedPass.error}" chunkRange=${chunk.startIndex}-${chunk.endIndex} fallbackModel=${deps.fallbackModelId ?? "<none>"} twoPass=${deps.historianTwoPass ? "true" : "false"}`,
            );
            const failCount = incrementHistorianFailure(db, sessionId, validatedPass.error);
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, validatedPass.error));
            return;
        }
        retainDrainReservationForRetryThrottle = false;

        const emittedCompartments = validatedPass.compartments;

        // Discard-last boundary healing: the LAST compartment of a greedy-consume
        // run was decided WITHOUT lookahead (historian can't see past the chunk), so
        // its boundary is structurally unreliable — unlike every earlier compartment,
        // which the messages that followed it validated. If historian consumed ~the
        // whole chunk (≤ BOUNDARY_HEALING_SLACK messages of lookahead past the last
        // compartment), drop that provisional last compartment so it is re-derived
        // next run with real following context. The existing
        // `offset = lastCompartment.end + 1` logic then re-reads its range at the
        // head — zero extra plumbing. Guards:
        //   - at least two compartments were emitted, so one remains and publication
        //     advances;
        //   - the retained boundary cannot split a completed invocation/result pair.
        // Self-healing: a wrong discard re-derives the same compartment next run (now
        // non-last → persisted), so erring toward more slack is safe.
        const inEmergency = getOverflowState(db, sessionId).needsEmergencyRecovery;
        let persistedCompartments = emittedCompartments;
        if (
            !inEmergency &&
            !forceKeepLastCompartmentForChunk &&
            shouldDiscardLastHistorianCompartment(emittedCompartments, chunk)
        ) {
            const lastEmitted = emittedCompartments[emittedCompartments.length - 1];
            const lookaheadMargin = chunk.endIndex - lastEmitted.endMessage;
            persistedCompartments = emittedCompartments.slice(0, -1);
            sessionLog(
                sessionId,
                `historian discard-last: dropped provisional compartment ${lastEmitted.startMessage}-${lastEmitted.endMessage} (lookaheadMargin=${lookaheadMargin} <= ${HISTORIAN_BOUNDARY_HEALING_SLACK}); will re-derive from raw next run`,
            );
        }

        // The historian may end its last compartment on a row the host never serves
        // by id (an OpenCode 2 instruction update). A request can never be trimmed at
        // such a boundary, so end on the nearest served row and leave the unserved
        // rows for the next run.
        const servedBoundary = snapTerminalCompartmentToServedRow(persistedCompartments, chunk.lines);
        if (servedBoundary.snapped) {
            const before = persistedCompartments[persistedCompartments.length - 1];
            const after = servedBoundary.compartments[servedBoundary.compartments.length - 1];
            sessionLog(
                sessionId,
                `historian boundary moved off a row the host does not serve: ${before?.startMessage}-${before?.endMessage} -> ${after ? `${after.startMessage}-${after.endMessage}` : "(dropped)"}`,
            );
            persistedCompartments = servedBoundary.compartments;
        }

        const newCompartments = persistedCompartments;

        const lastNewEnd = newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
        if (lastNewEnd + 1 <= offset) {
            const reason = `no forward progress beyond raw message ${offset - 1}`;
            sessionLog(
                sessionId,
                `historian failure: source=no-progress reason="historian returned compartments that did not advance past raw message ${offset - 1}" newCompartmentCount=${newCompartments.length} lastNewEnd=${lastNewEnd} priorEnd=${offset - 1}`,
            );
            sessionLog(sessionId, "historian output discarded: reason=no_forward_progress");
            const failCount = incrementHistorianFailure(db, sessionId, reason);
            await notifyHistorianIssue(
                buildHistorianFailureNotice(
                    failCount,
                    `historian made no forward progress beyond raw message ${offset - 1}`,
                ),
            );
            return;
        }

        retainDrainReservationForRetryThrottle = false;

        // Plan v6 §4: when the runner is preserving the injection cache, defer marker
        // movement until a later materializing transform pass. We persist a pending
        // blob INSIDE the same publish transaction so a crash between publish and
        // drain cannot leave the marker out of sync — either both land or neither
        // does. The drain in transform-postprocess-phase consumes the blob via
        // `applyDeferredCompactionMarker`.
        const deferMarkerApplication = deps.preserveInjectionCacheUntilConsumed === true;

        const lastCompartmentEnd = lastNewEnd;
        const lastNewEndMessageId = newCompartments[newCompartments.length - 1]?.endMessageId;

        // Append new compartments (existing stay untouched in DB) and publish all
        // synchronous durable side effects atomically. BEGIN IMMEDIATE ensures the
        // lease holder check and subsequent writes share one fresh write-locked
        // snapshot across sibling processes.
        const holderId = deps.compartmentLeaseHolderId;
        if (!holderId) {
            sessionLog(sessionId, "historian publish skipped: missing compartment lease holder");
            sessionLog(
                sessionId,
                "historian output discarded: reason=missing_compartment_lease_holder",
            );
            rollbackDrainReservation();
            return;
        }
        const boundaryCheckStarted = startHistorianPublishStage(
            sessionId,
            "dangling-boundary-check",
            `compartments=${newCompartments.length}`,
        );
        const danglingBoundary = findDanglingPublicationBoundary(sessionId, newCompartments);
        if (danglingBoundary) {
            const reason = `compartment boundary disappeared before publication (sequence=${danglingBoundary.sequence} side=${danglingBoundary.side} missing_id=${danglingBoundary.messageId})`;
            finishHistorianPublishStage(
                sessionId,
                "dangling-boundary-check",
                boundaryCheckStarted,
                "discarded",
                `missing_id=${danglingBoundary.messageId}`,
            );
            sessionLog(
                sessionId,
                `historian publish refused: sequence=${danglingBoundary.sequence} side=${danglingBoundary.side} missing_id=${danglingBoundary.messageId}; raw snapshot changed during the historian run`,
            );
            sessionLog(sessionId, "historian output discarded: reason=dangling_boundary");
            const failCount = incrementHistorianFailure(db, sessionId, reason);
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, reason));
            rollbackDrainReservation();
            return;
        }
        finishHistorianPublishStage(
            sessionId,
            "dangling-boundary-check",
            boundaryCheckStarted,
            "completed",
        );
        const dropsStarted = startHistorianPublishStage(
            sessionId,
            "post-publish-drops",
            `range=${offset}-${lastCompartmentEnd}`,
        );
        const compartmentTagKeys = await getRawSessionTagKeysThrough(
            sessionId,
            lastCompartmentEnd,
            { db, fromMessageIndex: offset },
        );
        let persistedIds: number[] = [];
        let published = false;
        const transactionStartedAt = startHistorianPublishStage(sessionId, "publish-txn");
        const lockAcquiredAt = await beginSqliteWriterAsync(db, "historian-publish");
        try {
            if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
                db.exec("ROLLBACK");
                rollbackDrainReservation();
                sessionLog(
                    sessionId,
                    "historian publish skipped: compartment lease no longer held",
                );
                sessionLog(sessionId, "historian output discarded: reason=compartment_lease_lost");
                finishHistorianPublishStage(
                    sessionId,
                    "publish-txn",
                    transactionStartedAt,
                    "discarded",
                    "reason=compartment_lease_lost",
                );
                return;
            }
            appendCompartments(db, sessionId, persistedCompartments);
            // Resolve durable ids for the compartments we just appended. They are the
            // last `persistedCompartments.length` rows by sequence (appendCompartments
            // inserts at the tail). Used for event anchoring.
            persistedIds = getCompartments(db, sessionId)
                .slice(-persistedCompartments.length)
                .map((c) => c.id);

            // v2 (E2): persist historian-extracted events (stored, NOT rendered).
            // Independent of memory flags — events are a separate corpus for a future
            // dreamer aggregation feature. Best-effort and re-derivable, so an event
            // failure logs and does NOT abort the boundary.
            const publishedEvents = validatedPass.events ?? [];
            if (publishedEvents.length > 0) {
                try {
                    insertCompartmentEvents(db, sessionId, publishedEvents, persistedIds);
                    sessionLog(
                        sessionId,
                        `stored ${publishedEvents.length} compartment event(s)`,
                    );
                } catch (error) {
                    sessionLog(sessionId, "failed to store compartment events:", error);
                }
            }

            queueDropsForCompartmentalizedMessages(
                db,
                sessionId,
                lastCompartmentEnd,
                compartmentTagKeys,
                offset,
            );
            finishHistorianPublishStage(
                sessionId,
                "post-publish-drops",
                dropsStarted,
                "completed",
                `range=${offset}-${lastCompartmentEnd}`,
            );

            clearHistorianFailureState(db, sessionId);
            // Healthy historian progress — clear the drain-failure backoff so the
            // emergency catch-up latch can bypass the budget freely again.
            clearHistorianDrainFailure(db, sessionId);
            recordProtectedTailPublicationFloor(db, sessionId, lastCompartmentEnd + 1);
            if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            drainReservation = null;
            if (deferMarkerApplication && lastNewEndMessageId) {
                (deps.compactionMarkerStrategy?.setPending ?? setPendingCompactionMarkerState)(
                    db,
                    sessionId,
                    {
                        ordinal: lastCompartmentEnd,
                        endMessageId: lastNewEndMessageId,
                        publishedAt: Date.now(),
                    },
                );
            }
            db.exec("COMMIT");
            published = true;
            publishCommitted = true;
            finishHistorianPublishStage(
                sessionId,
                "publish-txn",
                transactionStartedAt,
                "completed",
                `compartments=${persistedCompartments.length}`,
            );
            logSlowWriteTransaction("historian-publish", lockAcquiredAt);
        } catch (error) {
            finishHistorianPublishStage(sessionId, "publish-txn", transactionStartedAt, "failed");
            throw error;
        } finally {
            if (!published) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // Transaction may already be closed by an early rollback.
                }
            }
        }
        // Background publication normally preserves the injection cache until a
        // materializing pass can rebuild history and apply queued drops together.
        // Explicit recomp paths leave preserve=false and invalidate immediately.
        if (deps.preserveInjectionCacheUntilConsumed !== true) {
            clearInjectionCache(sessionId);
        }

        // Signal publication immediately after COMMIT. All publish-visible durable
        // state is already in the transaction above.
        deps.onCompartmentStatePublished?.(sessionId);

        // When deferring (plan v6 §4), the pending blob was already written
        // in-transaction and `onDeferredMarkerPending` signals the drain set. When NOT
        // deferring, fall back to the direct-apply path.
        if (deferMarkerApplication) {
            deps.onDeferredMarkerPending?.(sessionId);
        } else {
            try {
                (deps.compactionMarkerStrategy?.publish ?? updateCompactionMarkerAfterPublication)(
                    db,
                    sessionId,
                    lastCompartmentEnd,
                    directory,
                );
            } catch (error) {
                // Same outcome as the update reporting false: the compartments stand and
                // the marker catches up on a later publication.
                sessionLog(sessionId, "compaction-marker update after publish failed:", error);
            }
        }

        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        completedSuccessfully = true;

        sessionLog(
            sessionId,
            `historian publish completed: compartments=${persistedCompartments.length} range=${offset}-${lastCompartmentEnd}`,
        );
    } catch (error: unknown) {
        const desc = describeError(error);
        if (publishCommitted) {
            // The publication is durable and was signaled right after COMMIT. Counting
            // this as a historian failure would warn the user about a run that
            // succeeded and feed the failure backoff.
            sessionLog(
                sessionId,
                `historian post-publish step failed; publication stands: ${desc.brief}`,
            );
            return;
        }
        // Historian runs are fail-closed because they update durable compartment state.
        sessionLog(
            sessionId,
            `historian failure: source=exception ${desc.brief}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
        );
        if (!issueNotified) {
            const failCount = incrementHistorianFailure(db, sessionId, desc.brief);
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, desc.brief));
        }
    } finally {
        if (!completedSuccessfully) {
            if (!retainDrainReservationForRetryThrottle) {
                rollbackDrainReservation();
            } else {
                // A genuine historian failure (model error / no output / invalid
                // output) — the same condition that retains the drain reservation as
                // a retry throttle. Record it so the emergency catch-up latch's bypass
                // is suppressed for a short backoff and a broken historian can't
                // retry-thrash every pass under the latch.
                recordHistorianDrainFailure(db, sessionId);
            }
            updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        }
    }
}

