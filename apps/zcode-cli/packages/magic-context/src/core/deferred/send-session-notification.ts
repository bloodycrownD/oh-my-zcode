// FORK-NOT-PORTED(N4 终局 / Step 17 / bugfix-batch-20261011): `hooks/magic-context/send-session-notification.ts` 的 NotificationParams / NotificationDeliveryDisposition 类型与 sendStatusNotification 函数摘录，N4 终局不做，保留本壳并以此头注登记
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
//   - `transform.ts:910` (compaction-mode notice) — **已随 N5 终局删除**
//     （Step 17：compaction-off transition 段整体退场，该 notice 投递点不复
//     存在）；`"sent"`-gated 分支在 fork 当前无调用点。
//   - `transform-compartment-phase.ts:503` discards the result.
//
// `"skipped"` is upstream's own disposition for "held nothing, delivered
// nothing" (`send-session-notification.ts:18`). Throwing instead would convert
// three `void`-discarded sites into unhandled rejections and would break the
// `"sent"`-gated branch differently, so `"skipped"` is the faithful answer.
//
// N4 终局裁定（spec Step 17，不做）：send-session-notification（通知面）终局不
// 做——理由=上游走 OpenCode RPC pushNotification，ZCode 等价缝 steerTurn 接入
// 需干预 turn-loop，风险/收益失衡；不影响使用=「跳过折叠」等信息由日志 + 时间线
// + `ZCODE_MAGIC_CONTEXT_DEBUG_WIRE=1` 覆盖；紧急拒绝路径保持 fail-visible
// throw 是正确语义（本头注 SEMANTIC DECISION）。收口动作=本壳头注登记 +
// `TransformDeps.hostRefusalNotice` 预留端口保持预留态并注释指向本裁定；
// docs/.iteration-state.yaml bugfix-batch-20261011 节同步。

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