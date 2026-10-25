/**
 * FORK（spec phase-compartment-rewind / C1）：会话 rewind 后的 compartment 失效。
 *
 * ============================================================================
 * 为什么需要这个模块
 * ============================================================================
 *
 * `readM0Compartments` 过去按 session **全量**读 compartments（WHERE 只有
 * `session_id`），于是用户 rewind（v4 编辑重发 / 重试）之后，被裁轮次的旧摘要
 * 仍会渲染进 M0 的 `<session-history>`——模型看得见用户已经撤回的对话内容。
 * 只清缓存不够：M0 会从同一批旧行**重渲染**，旧摘要照旧复现。
 *
 * 本模块做三件事（host 侧一次调用）：
 *   1. **按水位标记**：`end_message >= anchorOrdinal` 的行写成
 *      `rebase_status = 'unresolved'`。`anchorOrdinal` = rewind 锚点（第一条被裁
 *      消息）在持久序里的 1-based 序号，与 compartments 的 `start_message` /
 *      `end_message` 同一坐标系（两者都由 host 的 `toStoredRows` 从
 *      `sessionStore.messages()` 编号）。
 *   2. **清持久缓存对**：`clearCachedM0M1` 抹掉 `cached_m0_bytes` /
 *      `cached_m1_bytes` / 全套 marker（含
 *      `cached_m0_last_baseline_end_message_id`）。不清的话 defer pass 会原样
 *      重放 rewind 前渲染的字节，绕过第 1 步。
 *   3. **清进程内注入缓存**：`clearInjectionCache`（`inject-compartments.ts`
 *      的 `injectionCache` + degraded re-anchor 计数），否则同一进程内的
 *      `preparedPrefix` 回放同样绕过第 1 步。
 *
 * 读侧过滤在 `inject-compartments.ts`：
 *   - `readM0Compartments` / `readNewCompartments` 的 WHERE 增加
 *     `rebase_status != 'unresolved'`（M0 与 M1 的增量块都不再引用被裁行）；
 *   - 重建路径（`getCompartments`）同样滤掉 unresolved；
 *   - `prepareCachedM0M1Replay` 拒绝重放「早于一次失效」的缓存对。
 * 两侧是双保险：host 侧不调（端口缺席 / 别的宿主形态）时，读侧仍不会把
 * 已标记的行注入进去；host 侧调了但读侧漏了，则标记形同虚设——所以两处都要在。
 *
 * 语义偏移（登记在 UPSTREAM-SYNC.md 第 3 节 Z4）：上游把 `rebase_status =
 * 'unresolved'` 保留给 store-generation rebase 的坐标失效；本 fork 的 rebase
 * walk 是移除的（见 `store-generation-rebase.ts` 文件头），该值**从不被写**，
 * 而既有读路径（`getLastCompartmentEndMessage(Id)`）本来就把 unresolved 行排除
 * 在外。这里复用它承载「rewind 水位之后」的语义，不新增列/迁移。
 */

import { clearInjectionCache } from "../../hooks/magic-context/inject-compartments.js";
import type { Database } from "../../shared/sqlite.js";
import { clearCachedM0M1 } from "./storage-meta-shared.js";

export interface CompartmentRewindInvalidation {
    /** 调用方给的水位（1-based 持久序）；非法时原样回传。 */
    anchorOrdinal: number;
    /** 本次从 `ok` 改成 `unresolved` 的行数。 */
    markedUnresolved: number;
    /** 水位之后本来就已经是 `unresolved` 的行数（幂等调用的证据）。 */
    alreadyInvalidated: number;
    /** 水位非法（非正整数）时非空：此时**不标记**，但缓存照旧清掉。 */
    skipped?: "invalid_anchor";
}

/** 水位是否可用：正整数。0/负数/NaN/Infinity 一律视为不可用。 */
function isUsableOrdinal(value: number): boolean {
    return Number.isInteger(value) && value > 0;
}

export function invalidateCompartmentsForRewind(
    db: Database,
    sessionId: string,
    anchorOrdinal: number,
): CompartmentRewindInvalidation {
    const usable = isUsableOrdinal(anchorOrdinal);
    let markedUnresolved = 0;
    let alreadyInvalidated = 0;

    if (usable) {
        const rows = db
            .prepare(
                `SELECT sequence, rebase_status
                   FROM compartments
                  WHERE session_id = ? AND end_message >= ?
                  ORDER BY sequence ASC`,
            )
            .all(sessionId, anchorOrdinal) as Array<{
            sequence: number;
            rebase_status: string | null;
        }>;
        const toMark: number[] = [];
        for (const row of rows) {
            if (row.rebase_status === "unresolved") alreadyInvalidated += 1;
            else toMark.push(Number(row.sequence));
        }
        if (toMark.length > 0) {
            const statement = db.prepare(
                `UPDATE compartments
                    SET rebase_status = 'unresolved'
                  WHERE session_id = ? AND sequence = ?`,
            );
            for (const sequence of toMark) {
                statement.run(sessionId, sequence);
            }
            markedUnresolved = toMark.length;
        }
    }

    // 缓存清理与标记同批：即使这次没有行可标（幂等重入 / 水位未知），rewind 也
    // 已经改写了可见历史，旧缓存对必须失效。
    clearCachedM0M1(db, sessionId);
    clearInjectionCache(sessionId);

    return {
        anchorOrdinal,
        markedUnresolved,
        alreadyInvalidated,
        ...(usable ? {} : { skipped: "invalid_anchor" as const }),
    };
}
