// FORK-NOT-PORTED: `hooks/magic-context/event-resolvers.ts` 的 escalationBands / MAX_EXECUTE_THRESHOLD / resolveModelKey / resolveExecuteThreshold / resolveExecuteThresholdDetail / historyBudgetPolicyIdentity / resolveContextWindowGeometry / resolveTrustedContextLimit 摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED (BUT VERBATIM). `event-resolvers.ts` is the OpenCode
// event-resolution layer: it maps an event's provider/model onto a context
// window using the models.dev catalog, a user provider override, the detected
// overflow limit, and the session's own measured high-water mark. The fork's
// window resolution belongs to the host adapter. The SPEC nonetheless lists
// `event-resolvers` under 不搬 — "not ported", not "not load-bearing".
//
// Because it is not ported BUT its members are already load-bearing in ported
// code, this seam reproduces the resolvers VERBATIM rather than stubbing them.
// Concretely, `transform.ts` calls, on every pass:
//
//   - `resolveExecuteThreshold` (:1524, :1647, :3204) to size the execute band,
//   - `escalationBands` (:1534) to derive the force-materialization percentage,
//   - `historyBudgetPolicyIdentity` (:1552) to key the cached m[0] prefix,
//   - `resolveModelKey` (:1134) to compare the outgoing model against the last
//     measured one,
//   - `resolveContextWindowGeometry` / `resolveTrustedContextLimit` (:1418, :1424)
//     to resolve the usable window,
//   and `lkg-replay-fit.ts` calls `resolveTrustedContextLimit` for the replay
//   fit bound.
//
// A stub at any of these would silently change which pass compacts and which
// rows are protected. The full resolution chain is reproducible here because all
// six of its dependencies are already in the package: `storage`'s
// `ContextDatabase`/`updateSessionMeta`, `storage-meta-persisted`'s
// `getOverflowState`/`loadPersistedUsage`, `shared/escalation-bands`,
// `shared/harness-provider-map`, `shared/logger`, `shared/models-dev-cache` and
// `shared/window-geometry`. Only `resolveModelCacheTtl` is deferred, and the two
// members that need it (`resolveCacheTtl`, `resolveContextLimit`'s cache-ttl
// sibling) are not referenced by any fork call site, so `resolveCacheTtl` is
// omitted.
//
// Step 21: delete this file and repoint `transform.ts` and
// `lkg-replay-fit.ts` back at `./event-resolvers.js`.

import {
    type ContextDatabase,
    updateSessionMeta,
} from "../features/magic-context/storage.js";
import {
    getOverflowState,
    loadPersistedUsage,
} from "../features/magic-context/storage-meta-persisted.js";
import { escalationBands, MAX_EXECUTE_THRESHOLD } from "../shared/escalation-bands.js";
import { modelRefLookupOrder, piModelRefToCanonical } from "../shared/harness-provider-map.js";
import { log, sessionLog } from "../shared/logger.js";
import {
    getSdkContextLimit,
    getSdkWindowGeometry,
    isSaneLimit,
} from "../shared/models-dev-cache.js";
import { applyProvenInputFloor, hasTrustedAbsoluteWall } from "../shared/window-geometry.js";

export { escalationBands, MAX_EXECUTE_THRESHOLD };

/** Verbatim: `event-resolvers.ts:18`. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

function modelMatchedPersistedUsage(
    db: ContextDatabase | undefined,
    sessionID: string | undefined,
    modelKey: string | undefined,
): NonNullable<ReturnType<typeof loadPersistedUsage>> | undefined {
    if (!db || !sessionID || !modelKey) return undefined;
    try {
        const persisted = loadPersistedUsage(db, sessionID);
        if (
            persisted !== null &&
            piModelRefToCanonical(persisted.lastObservedModelKey ?? "") ===
                piModelRefToCanonical(modelKey)
        ) {
            return persisted;
        }
    } catch {
        // Persisted usage is best-effort; the normal resolver remains available.
    }
    return undefined;
}

function modelMatchedProvenContextLimit(
    db: ContextDatabase | undefined,
    sessionID: string | undefined,
    modelKey: string | undefined,
): number | undefined {
    const persisted = modelMatchedPersistedUsage(db, sessionID, modelKey);
    return isSaneLimit(persisted?.observedSafeInputTokens)
        ? persisted.observedSafeInputTokens
        : undefined;
}

function applySessionProvenFloor(
    geometry: NonNullable<ReturnType<typeof getSdkWindowGeometry>>,
    persisted: NonNullable<ReturnType<typeof modelMatchedPersistedUsage>> | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
) {
    const provenLimit = isSaneLimit(persisted?.observedSafeInputTokens)
        ? persisted.observedSafeInputTokens
        : undefined;
    const result = applyProvenInputFloor(geometry, provenLimit);
    if (result.refused && ctx?.db && ctx.sessionID) {
        const impossiblePressure = persisted?.usage.inputTokens
            ? persisted.usage.inputTokens > result.refused.absoluteWall
            : false;
        updateSessionMeta(ctx.db, ctx.sessionID, {
            observedSafeInputTokens: 0,
            cacheAlertSent: false,
            lastUsageContextLimit: geometry.usableSoft,
            lastInputTokens: impossiblePressure ? 0 : persisted?.usage.inputTokens,
            lastContextPercentage: impossiblePressure ? 0 : persisted?.usage.percentage,
        });
        sessionLog(
            ctx.sessionID,
            `persisted proven floor ${result.refused.reading} exceeds trusted absolute wall ${result.refused.absoluteWall}; cleared and re-resolved to ${geometry.usableSoft}`,
        );
    }
    return result.geometry;
}

/** Verbatim: `event-resolvers.ts:80-110`. */
export function resolveContextWindowGeometry(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
) {
    if (!providerID || !modelID) return undefined;
    const modelKey = resolveModelKey(providerID, modelID);
    let detected: number | undefined;
    let detectedLimitProvenance: "prompt_only" | "combined" | "unknown" = "unknown";
    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
            if (overflow.detectedContextLimit > 0) {
                detected = overflow.detectedContextLimit;
                detectedLimitProvenance = overflow.detectedContextLimitProvenance;
            }
        } catch {
            // Geometry resolution remains best-effort when session metadata is unavailable.
        }
    }
    const geometry = getSdkWindowGeometry(providerID, modelID, detected, {
        detectedLimitProvenance,
        harness: "opencode",
    });
    if (!geometry || detected !== undefined) return geometry;
    return applySessionProvenFloor(
        geometry,
        modelMatchedPersistedUsage(ctx?.db, ctx?.sessionID, modelKey),
        ctx,
    );
}

/**
 * Like resolveContextLimit, but returns a limit ONLY when it is TRUSTED for the
 * current model, rather than the generic 200K `DEFAULT_CONTEXT_LIMIT`.
 *
 * Verbatim: `event-resolvers.ts:188-235`.
 */
export function resolveTrustedContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
): number | undefined {
    const modelKey = resolveModelKey(providerID, modelID);
    let detected: number | undefined;
    let detectedLimitProvenance: "prompt_only" | "combined" | "unknown" = "unknown";
    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
            if (overflow.detectedContextLimit > 0) {
                detected = overflow.detectedContextLimit;
                detectedLimitProvenance = overflow.detectedContextLimitProvenance;
            }
        } catch {
            // best-effort; ignore
        }
    }

    // Apply measured wire truth to the matching resolver arm. Comparing a
    // combined detection against an already-reserved budget would double-count
    // output, while a prompt-only detection must not reserve output again.
    const fromModelsDev =
        providerID && modelID
            ? getSdkContextLimit(providerID, modelID, detected, {
                  detectedLimitProvenance,
              })
            : undefined;
    if (detected !== undefined) {
        return typeof fromModelsDev === "number" && fromModelsDev > 0 ? fromModelsDev : detected;
    }

    // A successful request is a lower bound on the usable window. Keep that
    // model-scoped proof when a later catalog response regresses below it.
    const provenLimit = modelMatchedProvenContextLimit(ctx?.db, ctx?.sessionID, modelKey);
    if (typeof fromModelsDev === "number" && fromModelsDev > 0) {
        return isSaneLimit(provenLimit) ? Math.max(fromModelsDev, provenLimit) : fromModelsDev;
    }
    if (isSaneLimit(provenLimit)) return provenLimit;

    // Unknown models still need the prior usage-derived denominator for token
    // thresholds even when no successful high-water mark has been recorded.
    const persisted = modelMatchedPersistedUsage(ctx?.db, ctx?.sessionID, modelKey);
    return isSaneLimit(persisted?.lastUsageContextLimit)
        ? persisted.lastUsageContextLimit
        : undefined;
}

/** Verbatim: `event-resolvers.ts:241-244`. */
type ExecuteThresholdConfig = number | { default: number; [modelKey: string]: number };
type ExecuteThresholdTokensConfig =
    | { default?: number; [modelKey: string]: number | undefined }
    | undefined;

/** Verbatim: `event-resolvers.ts:246-255`. */
export interface ExecuteThresholdOptions {
    /** Optional tokens-based threshold config. When matched for the given modelKey,
     *  overrides the percentage-based threshold. */
    tokensConfig?: ExecuteThresholdTokensConfig;
    /** Required when `tokensConfig` is provided — used to convert tokens → percentage
     *  and to clamp values above 90% × context_limit. */
    contextLimit?: number;
    /** Session ID for warn logs when clamping. If absent, warns to global log. */
    sessionId?: string;
}

/** Verbatim: `event-resolvers.ts:257`. */
export type ExecuteThresholdMode = "percentage" | "tokens";

/** Verbatim: `event-resolvers.ts:259-282`. */
export interface ExecuteThresholdDetail {
    /** Effective execute threshold as a percentage (0–90). Downstream math keys off this. */
    percentage: number;
    /** Which source was authoritative: tokens config (when matched + valid context) or percentage. */
    mode: ExecuteThresholdMode;
    /** When mode is "tokens", the absolute token value after clamping (≤ 90% × contextLimit). */
    absoluteTokens?: number;
    /** The config key that matched, if any (for display/debugging). `"default"` when default fallback. */
    matchedKey?: string;
    /**
     * True when the user's configured value exceeded the safe cap and was reduced.
     * Display surfaces read this to tell the user their value was clamped instead of
     * silently ignoring it (#241).
     */
    clamped?: boolean;
    /**
     * The raw configured value before clamping — a token count in tokens mode, a
     * percentage in percentage mode.
     */
    configuredValue?: number;
}

// Module-level dedupe for clamp warnings. Key: `${sessionId}|${modelKey}|${tokenVal}|${cap}`.
// The hot transform path may call resolveExecuteThreshold many times per second; without dedupe
// an over-cap token config would spam the log file continuously until the user fixes it.
/** Verbatim: `event-resolvers.ts:287`. */
const clampWarnSeen = new Set<string>();

/**
 * Return true iff `v` is a finite positive number.
 *
 * Verbatim: `event-resolvers.ts:295-297`.
 */
function isFinitePositive(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Yield progressively-less-specific lookup keys for a given `provider/model`.
 *
 * Verbatim: `event-resolvers.ts:314-329`.
 */
function* modelKeyLookupOrder(modelKey: string): Generator<string> {
    const slash = modelKey.indexOf("/");
    const providerRefs = slash >= 0 ? modelRefLookupOrder(modelKey) : [];
    let modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;

    while (modelId.length > 0) {
        for (const providerRef of providerRefs) {
            const providerSlash = providerRef.indexOf("/");
            yield `${providerRef.slice(0, providerSlash)}/${modelId}`;
        }
        yield modelId;
        const lastDash = modelId.lastIndexOf("-");
        if (lastDash <= 0) break;
        modelId = modelId.slice(0, lastDash);
    }
}

/**
 * Single source of truth for execute-threshold resolution.
 *
 * Verbatim: `event-resolvers.ts:339-452`.
 */
export function resolveExecuteThresholdDetail(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
    options?: ExecuteThresholdOptions,
): ExecuteThresholdDetail {
    // 1. Tokens-based resolution takes precedence when configured.
    if (options?.tokensConfig && isFinitePositive(options.contextLimit)) {
        const contextLimit = options.contextLimit;
        const tokenMatch = resolveTokensMatchWithKey(options.tokensConfig, modelKey);
        // Also guard the matched token value — must be a finite positive number.
        if (tokenMatch && isFinitePositive(tokenMatch.value)) {
            const cap = contextLimit * (MAX_EXECUTE_THRESHOLD / 100);
            const effectiveTokens = Math.min(tokenMatch.value, cap);
            if (effectiveTokens < tokenMatch.value) {
                // Dedupe: only warn once per (session, modelKey, token value, cap) tuple.
                const dedupeKey = `${options.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${tokenMatch.value}|${cap}`;
                if (!clampWarnSeen.has(dedupeKey)) {
                    clampWarnSeen.add(dedupeKey);
                    const msg = `execute_threshold_tokens clamped: ${tokenMatch.value} → ${effectiveTokens} (${MAX_EXECUTE_THRESHOLD}% of ${contextLimit}) for ${modelKey ?? "default"}`;
                    if (options.sessionId) {
                        sessionLog(options.sessionId, `WARN: ${msg}`);
                    } else {
                        log(`[magic-context] WARN: ${msg}`);
                    }
                }
            }
            const percentage = (effectiveTokens / contextLimit) * 100;
            const detail: ExecuteThresholdDetail = {
                percentage: Math.min(percentage, MAX_EXECUTE_THRESHOLD),
                mode: "tokens",
                absoluteTokens: Math.floor(effectiveTokens),
                matchedKey: tokenMatch.matchedKey,
            };
            if (effectiveTokens < tokenMatch.value) {
                detail.clamped = true;
                detail.configuredValue = tokenMatch.value;
            }
            return detail;
        }
    }

    // 2. Fall through to percentage-based resolution.
    let resolved: number;
    let matchedKey: string | undefined;

    if (typeof config === "number") {
        resolved = config;
    } else if (modelKey) {
        let matched: number | undefined;
        for (const candidate of modelKeyLookupOrder(modelKey)) {
            if (typeof config[candidate] === "number") {
                matched = config[candidate];
                matchedKey = candidate;
                break;
            }
        }
        if (matched === undefined && typeof config.default === "number") {
            resolved = config.default;
            matchedKey = "default";
        } else {
            resolved = matched ?? fallback;
        }
    } else if (typeof config.default === "number") {
        resolved = config.default;
        matchedKey = "default";
    } else {
        resolved = fallback;
    }

    // Guard against non-finite/negative config values that could bypass schema.
    if (!Number.isFinite(resolved) || resolved < 0) {
        resolved = fallback;
    }

    // Cap at 90% of the output-reserved safe window.
    const cappedPercentage = Math.min(resolved, MAX_EXECUTE_THRESHOLD);
    const percentageClamped = cappedPercentage < resolved;
    if (percentageClamped) {
        const dedupeKey = `pct|${options?.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${resolved}`;
        if (!clampWarnSeen.has(dedupeKey)) {
            clampWarnSeen.add(dedupeKey);
            const msg = `execute_threshold clamped ${resolved}% → ${MAX_EXECUTE_THRESHOLD}% for ${modelKey ?? "default"} (capped against the output-reserved safe window; 10% remains for mid-turn growth before the absolute 95% wall)`;
            if (options?.sessionId) {
                sessionLog(options.sessionId, `WARN: ${msg}`);
            } else {
                log(`[magic-context] WARN: ${msg}`);
            }
        }
    }
    const detail: ExecuteThresholdDetail = {
        percentage: cappedPercentage,
        mode: "percentage",
        matchedKey,
    };
    if (percentageClamped) {
        detail.clamped = true;
        detail.configuredValue = resolved;
    }
    return detail;
}

/**
 * Backward-compatible wrapper around `resolveExecuteThresholdDetail`.
 *
 * Verbatim: `event-resolvers.ts:458-465`.
 */
export function resolveExecuteThreshold(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
    options?: ExecuteThresholdOptions,
): number {
    return resolveExecuteThresholdDetail(config, modelKey, fallback, options).percentage;
}

/** Verbatim: `event-resolvers.ts:468-490`. */
function resolveTokensMatchWithKey(
    tokensConfig: ExecuteThresholdTokensConfig,
    modelKey: string | undefined,
): { value: number; matchedKey: string } | undefined {
    if (!tokensConfig) {
        return undefined;
    }

    if (modelKey) {
        for (const candidate of modelKeyLookupOrder(modelKey)) {
            const value = tokensConfig[candidate];
            if (typeof value === "number") {
                return { value, matchedKey: candidate };
            }
        }
    }

    if (typeof tokensConfig.default === "number") {
        return { value: tokensConfig.default, matchedKey: "default" };
    }

    return undefined;
}

/** Verbatim: `event-resolvers.ts:492-501`. */
export function resolveModelKey(
    providerID: string | undefined,
    modelID: string | undefined,
): string | undefined {
    if (!providerID || !modelID) {
        return undefined;
    }

    return piModelRefToCanonical(`${providerID}/${modelID}`);
}

/**
 * Identify the configured history fraction and selected execute threshold used
 * to size history. Catalog refreshes and accepted-input measurements can change
 * the available window without a user config edit, so they must not invalidate
 * the cached m[0] prefix. Actual rendering still budgets against that live window.
 *
 * Verbatim: `event-resolvers.ts:532-549`.
 */
export function historyBudgetPolicyIdentity(
    historyBudgetPercentage: number | undefined,
    executeThresholdPercentage: ExecuteThresholdConfig | undefined,
    modelKey: string | undefined,
    executeThresholdTokens?: ExecuteThresholdTokensConfig,
): string {
    if (!historyBudgetPercentage) return "pdefault";
    // Select the configured token override with the existing per-model lookup,
    // but avoid the resolver's window-dependent cap in this config identity.
    // History rendering and pressure checks apply that cap using the real limit.
    const threshold = resolveExecuteThresholdDetail(
        executeThresholdPercentage ?? 65,
        modelKey,
        65,
        { tokensConfig: executeThresholdTokens, contextLimit: Number.MAX_SAFE_INTEGER },
    );
    return `p${historyBudgetPercentage}:${threshold.mode}:${threshold.absoluteTokens ?? threshold.percentage}`;
}