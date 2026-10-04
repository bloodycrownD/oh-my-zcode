// FORK-NOT-PORTED: `hooks/magic-context/send-session-notification.ts` 的 NotificationParams / NotificationDeliveryDisposition 类型与 sendStatusNotification 函数摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. Status lines reach the user through OpenCode's RPC
// `pushNotification("toast", …)` plus a queue that holds notifications until
// `session.idle`. ZCode has its own TUI notification channel, and the host
// adapter supplies it — the fork's own `TransformDeps` already carries the seam
// (`hostRefusalNotice`, and `getNotificationParams` for the params bag).
//
// SEMANTIC DECISION — `sendStatusNotification` returns `"skipped"`, never throws.
// This is the one seam where the choice matters most, because seven call sites
// branch on the result:
//
//   - `transform.ts:218` (project-identity warning) and `:1363` / `:1807` (overflow
//     recovery, historian recovery) discard the result inside
//     `void withoutSqliteTransformPass(...)`; `"skipped"` is inert there.
//   - `transform.ts:405` (`sendEmergencyRefusalNotice`) throws unless the result is
//     `"sent"` or `"queued"`. `"skipped"` therefore makes that path throw — which
//     is correct: the fork cannot deliver an emergency refusal notice, and the
//     caller at `:2829` must fail the turn rather than silently claim the user
//     was told. The host adapter replaces this seam via `hostRefusalNotice`.
//   - `transform.ts:910` (compaction-mode notice) compares `=== "sent"` before
//     committing the settled mode record. `"skipped"` means the record is not
//     committed and the transition retries next pass — the upstream at-least-once
//     contract, preserved.
//   - `transform-compartment-phase.ts:503` discards the result.
//
// `"skipped"` is upstream's own disposition for "held nothing, delivered
// nothing" (`send-session-notification.ts:18`). Throwing instead would convert
// three `void`-discarded sites into unhandled rejections and would break the
// `"sent"`-gated branch differently, so `"skipped"` is the faithful answer.
//
// Step 21: delete this file and repoint `transform.ts` and
// `transform-compartment-phase.ts` back at
// `./send-session-notification.js`, or — once the ZCode host supplies its own
// notification seam — delete the import and route every call through
// `TransformDeps`.

// `TransformDeps` supplies the ZCode notification seam, so no host import is
// needed here; the signature keeps `unknown` for the client exactly as upstream
// does (`send-session-notification.ts:600`).

/** Verbatim: `send-session-notification.ts:7-16`. */
export interface NotificationParams {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
    /** TUI toast lifetime in milliseconds (default: 5000). */
    toastDurationMs?: number;
    /** Runs after this notification is delivered, including after a queued flush. */
    onDelivered?: () => void;
}

/** Verbatim: `send-session-notification.ts:18`. */
export type NotificationDeliveryDisposition = "sent" | "queued" | "skipped" | "failed";

/**
 * Publish passive status through RPC only: a noReply user row is still input to
 * host run scheduling.
 *
 * Always `"skipped"` — see the header note. Signature verbatim from
 * `send-session-notification.ts:599-604`.
 */
export async function sendStatusNotification(
    _client: unknown,
    _sessionId: string,
    _text: string,
    _params: NotificationParams,
): Promise<NotificationDeliveryDisposition> {
    return "skipped";
}