// FORK-DEFERRED(S21): `features/magic-context/scheduler.ts` 的 Scheduler 类型与 parseCacheTtl 函数摘录，Step 21 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. `createScheduler` needs
// `resolveExecuteThreshold` from `event-resolvers`, which is explicitly 不搬
// (not ported — it is the OpenCode event-resolution layer). The B group reaches
// exactly two things here, and both are reproduced verbatim:
//
//   - `parseCacheTtl`, called by `transform.ts:318` inside
//     `computeHardCacheExpired`. Its doc contract ("Strict > matches the Rust
//     scheduler's predicate exactly") makes byte-preservation load-bearing, so
//     it is copied as-is including the `never` sentinel and the bare-numeric
//     millisecond reading.
//   - the `Scheduler` interface, named by `transform.ts` and
//     `transform-context-state.ts` as a type.
//
// Step 21: delete this file and repoint `transform.ts` and
// `transform-context-state.ts` back at
// `../../features/magic-context/scheduler.js`.

import type { ContextUsage, SchedulerDecision, SessionMeta } from "../features/magic-context/types.js";

const TTL_PATTERN = /^(\d+)([smh])$/;
const NUMERIC_PATTERN = /^\d+$/;

const UNIT_TO_MS: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
};

/** Verbatim: `scheduler.ts:14-22`. */
export interface Scheduler {
    shouldExecute(
        sessionMeta: SessionMeta,
        contextUsage: ContextUsage,
        currentTime?: number,
        sessionId?: string,
        modelKey?: string,
        contextLimit?: number,
    ): SchedulerDecision;
}

/**
 * Verbatim: `scheduler.ts:30-56`.
 *
 * The `never` sentinel means lanes kept warm by an external keepwarm proxy —
 * the idle heuristic is disabled, so Magic Context never initiates a rebuild
 * based on elapsed time. Bare numeric strings are treated as milliseconds: the
 * setup CLI writes "5m" or "59m", so users do not encounter bare numbers through
 * normal config paths.
 */
export function parseCacheTtl(ttl: string): number {
    const normalizedTtl = ttl.trim();

    if (normalizedTtl.toLowerCase() === "never") {
        return Number.POSITIVE_INFINITY;
    }

    if (NUMERIC_PATTERN.test(normalizedTtl)) {
        return Number(normalizedTtl);
    }

    const match = normalizedTtl.match(TTL_PATTERN);
    if (!match) {
        throw new Error(`Invalid cache TTL format: ${ttl}`);
    }

    const value = Number(match[1]);
    const unit = match[2];
    return value * UNIT_TO_MS[unit];
}