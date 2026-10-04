/**
 * Step 21 真身替换：`deferred/scheduler.ts` 的摘录在此归位为源文件本体。
 *
 * 逐字来自 `.reference/magic-context/packages/plugin/src/features/magic-context/
 * scheduler.ts`（122 行），含此前缝里没有的 `createScheduler`。唯一改动：
 *
 *   - 相对导入加 `.js` 后缀；
 *   - `resolveExecuteThreshold` 来自 `../../deferred/event-resolvers.js` 而不是
 *     `../../hooks/magic-context/event-resolvers`。那个模块（OpenCode 事件解析层）
 *     按 SPEC 属于「不搬」，但它的成员已在包内逐字复现，`createScheduler` 因此可用；
 *     event-resolvers 若将来落地，只需改这一行。
 *
 * 为何值得逐字保真：`parseCacheTtl` 的文档契约（"Strict > matches the Rust
 * scheduler's predicate exactly"）让 `never` 哨兵与裸毫秒读法都是载荷语义。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { resolveExecuteThreshold } from "../../deferred/event-resolvers.js";
import { log, sessionLog } from "../../shared/logger.js";
import type { ContextUsage, SchedulerDecision, SessionMeta } from "./types.js";

const TTL_PATTERN = /^(\d+)([smh])$/;
const NUMERIC_PATTERN = /^\d+$/;

const UNIT_TO_MS: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
};

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

interface SchedulerConfig {
    executeThresholdPercentage: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
}

export function parseCacheTtl(ttl: string): number {
    const normalizedTtl = ttl.trim();

    // "never" sentinel: lanes kept warm by external keepwarm proxies — the idle
    // heuristic is disabled, so MC never initiates a rebuild based on elapsed time.
    if (normalizedTtl.toLowerCase() === "never") {
        return Number.POSITIVE_INFINITY;
    }

    // Intentional: bare numeric strings are treated as milliseconds. The setup CLI writes
    // "5m" or "59m" so users don't encounter bare numbers through normal config paths.
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

export function createScheduler(config: SchedulerConfig): Scheduler {
    return {
        shouldExecute(
            sessionMeta: SessionMeta,
            contextUsage: ContextUsage,
            currentTime: number = Date.now(),
            sessionId?: string,
            modelKey?: string,
            contextLimit?: number,
        ): SchedulerDecision {
            // Brand-new sessions (no usage, no baseline) have nothing to execute.
            // Skip the TTL check that would always fire due to lastResponseTime=0.
            if (contextUsage.percentage === 0 && sessionMeta.lastResponseTime === 0) {
                return "defer";
            }

            // Tokens-based config requires contextLimit to convert to effective %.
            // When the caller doesn't have it handy we derive it from usage:
            // contextLimit = inputTokens / (percentage / 100). This is the same
            // denominator event-handler used to compute contextUsage.percentage,
            // so both resolutions stay consistent on the same pass.
            const effectiveContextLimit =
                contextLimit ??
                (contextUsage.percentage > 0 && contextUsage.inputTokens > 0
                    ? contextUsage.inputTokens / (contextUsage.percentage / 100)
                    : undefined);

            const threshold = resolveExecuteThreshold(
                config.executeThresholdPercentage,
                modelKey,
                65,
                {
                    tokensConfig: config.executeThresholdTokens,
                    contextLimit: effectiveContextLimit,
                    sessionId,
                },
            );
            if (contextUsage.percentage >= threshold) {
                return "execute";
            }

            let ttlMs: number;
            try {
                ttlMs = parseCacheTtl(sessionMeta.cacheTtl);
            } catch (error) {
                if (sessionId) {
                    sessionLog(
                        sessionId,
                        `invalid cache_ttl "${sessionMeta.cacheTtl}"; falling back to default 5m`,
                        error,
                    );
                } else {
                    log(
                        `[magic-context] invalid cache_ttl "${sessionMeta.cacheTtl}"; falling back to default 5m`,
                        error,
                    );
                }
                ttlMs = parseCacheTtl("5m");
            }
            const elapsedTime = currentTime - sessionMeta.lastResponseTime;
            if (elapsedTime > ttlMs) {
                return "execute";
            }

            return "defer";
        },
    };
}