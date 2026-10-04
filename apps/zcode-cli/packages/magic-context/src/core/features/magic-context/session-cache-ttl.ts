/**
 * Step 21 真身替换：`deferred/session-cache-ttl.ts` 的摘录在此归位为源文件本体。
 *
 * 逐字来自 `.reference/magic-context/packages/plugin/src/features/magic-context/
 * session-cache-ttl.ts`（52 行），唯一改动是相对导入加上 `.js` 后缀。四个上游依赖
 * （`shared/model-cache-ttl`、`storage-db`、`storage-meta`、`storage-replay-document`）
 * 在包内全部存在。
 *
 * 为何值得逐字保真：模型一旦已知就把 provider cache TTL **冻结**进可扩展的 replay
 * 文档里，重启不重算；重新推导出来的 TTL 会击穿缓存。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import {
    type CacheTtlConfig,
    type ResolvedCacheTtl,
    resolveModelCacheTtl,
} from "../../shared/model-cache-ttl.js";
import type { ContextDatabase } from "./storage-db.js";
import { getOrCreateSessionMeta, updateSessionMeta } from "./storage-meta.js";
import { readReplayEnvelope, updateReplayDocument } from "./storage-replay-document.js";

interface SessionCacheTtl extends ResolvedCacheTtl {
    config: CacheTtlConfig;
}

export function readSessionCacheTtl(
    db: ContextDatabase,
    sessionId: string,
): SessionCacheTtl | undefined {
    const saved = readReplayEnvelope(db, sessionId).cacheTtlPolicy as SessionCacheTtl | undefined;
    return saved && typeof saved.value === "string" && saved.config !== undefined
        ? saved
        : undefined;
}

/** Freeze config once the model is known; a real model switch still selects its own lifetime. */
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