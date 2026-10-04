// FORK-DEFERRED(S21): `features/magic-context/session-cache-ttl.ts` 的 SessionCacheTtl / readSessionCacheTtl / resolveSessionCacheTtl 摘录，Step 21 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The resolver freezes the provider cache TTL per
// session once the outgoing model is known (a real model switch still selects
// its own lifetime) and persists the decision in the extensible replay document
// so a restart does not re-derive it. That policy — and with it the
// `cache_ttl` config block — is D/E surface (Step 21).
//
// It is nevertheless reproduced VERBATIM, because all four of its dependencies
// are already in the package: `shared/model-cache-ttl` (above), `storage-db`'s
// `ContextDatabase`, `storage-meta`'s `getOrCreateSessionMeta`/`updateSessionMeta`,
// and `storage-replay-document`. There is nothing to stub, and its behaviour is
// load-bearing for provider cache hits (a re-derived TTL busts the cache).
//
// Step 21: delete this file and repoint `transform.ts` back at
// `../../features/magic-context/session-cache-ttl.js`.

import type { ContextDatabase } from "../features/magic-context/storage-db.js";
import { getOrCreateSessionMeta, updateSessionMeta } from "../features/magic-context/storage-meta.js";
import { readReplayEnvelope, updateReplayDocument } from "../features/magic-context/storage-replay-document.js";
import {
    type CacheTtlConfig,
    type ResolvedCacheTtl,
    resolveModelCacheTtl,
} from "./model-cache-ttl.js";

/** Verbatim: `session-cache-ttl.ts:10-12`. */
interface SessionCacheTtl extends ResolvedCacheTtl {
    config: CacheTtlConfig;
}

/** Verbatim: `session-cache-ttl.ts:14-22`. */
export function readSessionCacheTtl(
    db: ContextDatabase,
    sessionId: string,
): SessionCacheTtl | undefined {
    const saved = readReplayEnvelope(db, sessionId).cacheTtlPolicy as SessionCacheTtl | undefined;
    return saved && typeof saved.value === "string" && saved.config !== undefined
        ? saved
        : undefined;
}

/**
 * Freeze config once the model is known; a real model switch still selects its
 * own lifetime.
 *
 * Verbatim: `session-cache-ttl.ts:24-52`.
 */
export function resolveSessionCacheTtl(
    db: ContextDatabase,
    sessionId: string,
    config: CacheTtlConfig | undefined,
    modelKey: string | undefined,
): ResolvedCacheTtl {
    const meta = getOrCreateSessionMeta(db, sessionId);
    let saved = readSessionCacheTtl(db, sessionId);
    if (!modelKey) return saved ?? resolveModelCacheTtl(config ?? meta.cacheTtl, undefined);
    if (!saved || saved.modelKey !== modelKey) {
        const frozenConfig = saved?.config ?? config ?? meta.cacheTtl;
        const resolved = resolveModelCacheTtl(frozenConfig, modelKey);
        const next = { ...resolved, config: frozenConfig };
        // Reuse the extensible replay document so restart preserves the decision
        // without a schema migration or a process-local session cache.
        if (
            !updateReplayDocument(db, sessionId, (doc) => {
                doc.version = 2;
                doc.cacheTtlPolicy = next;
                return true;
            })
        )
            throw new Error("cannot persist session cache TTL policy");
        saved = next;
    }
    if (meta.cacheTtl !== saved.value) updateSessionMeta(db, sessionId, { cacheTtl: saved.value });
    return saved;
}