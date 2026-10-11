// FORK-NOT-PORTED(N4 终局 / Step 17 / bugfix-batch-20261011): `hooks/magic-context/channel2-cycle.ts` 的 rearmChannel2AfterCoverageAdvancingHardFold / rearmChannel2AfterMeasuredCollapse 摘录，N4 终局不做，保留本壳并以此头注登记
//
// WHY NOT PORTED. Channel 2 is the ctx_reduce nudge that fires when a
// coverage-advancing HARD fold lands or when the measured tail collapses. It
// exists only to rearm a nudge for a tool this fork does not ship.
//
// The two upstream bodies are four lines each and their whole effect is the
// single `casChannel2NudgeState(db, sessionId, "delivered", "")` call — which is
// a write the fork's Channel-2 lane has no consumer for. Rather than
// reproduce a write whose reader does not exist, both answer `false` (upstream's
// own "nothing was rearmed" answer) without touching the database.
//
// SEMANTIC DECISION — return `false`, do not throw. Both call sites
// (`transform-postprocess-phase.ts:1956` and `:3838`) already wrap the call in
// try/catch with an explicit "ignored" log, so a throw would fill the log with a
// per-pass warning for a feature that does not exist; `false` is silently the
// no-rearm outcome and matches what the caller does with the return value (it is
// discarded at both sites).
//
// N4 终局裁定（spec Step 17，不做）：channel2-cycle + send-session-notification
// （通知/nudge 闭环）终局不做——理由=上游走 OpenCode RPC pushNotification，
// ZCode 等价缝 steerTurn 接入需干预 turn-loop，风险/收益失衡；不影响使用=「跳过
// 折叠」等信息由日志 + 时间线 + `ZCODE_MAGIC_CONTEXT_DEBUG_WIRE=1` 覆盖；紧急
// 拒绝路径的 fail-visible throw 是正确语义（见 send-session-notification 壳头注
// SEMANTIC DECISION）。收口动作=两缝头注登记 + `TransformDeps.hostRefusalNotice`
// 预留端口保持预留态并注释指向本裁定；docs/.iteration-state.yaml
// bugfix-batch-20261011 节同步。

import { casChannel2NudgeState } from "../features/magic-context/storage-meta-persisted.js";
import type { Database } from "../shared/sqlite.js";
import type { Channel2PredicateBaseline } from "../hooks/magic-context/ctx-reduce-nudge.js";

/** No rearm: see the header note. Signature verbatim from `channel2-cycle.ts:6-13`. */
export function rearmChannel2AfterCoverageAdvancingHardFold(_input: {
    db: Database;
    sessionId: string;
    foldExecuted: boolean;
    compactionOff: boolean;
    previousCoverage: number | null;
    currentCoverage: number | null;
}): boolean {
    return false;
}

/** No rearm: see the header note. Signature verbatim from `channel2-cycle.ts:26-33`. */
export function rearmChannel2AfterMeasuredCollapse(_input: {
    db: Database;
    sessionId: string;
    baseline: Channel2PredicateBaseline;
}): boolean {
    return false;
}

// `casChannel2NudgeState` is re-exported so Step 21 can wire the real bodies
// without a second import edit; the fork's own barrel already declares it.
export { casChannel2NudgeState };