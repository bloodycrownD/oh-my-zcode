// FORK-NOTE(Step 8 / bugfix-batch-20261011): upstream
// `features/magic-context/memory/promotion.ts` (145 lines) — NEW PORT (deferred
// had no seam for this file) with the N1 embedding tail DELETED. This is the
// D13 durable write entry: the historian calls `promoteSessionFactsDurable`
// INSIDE its publish transaction (`hooks/magic-context/compartment-runner-
// incremental.ts`), so a crash cannot advance the boundary floor past facts
// that never became project memories.
//
// WHAT IS VERBATIM. `promoteSessionFactsDurable` and its result/ref types —
// every line above the deleted section is upstream's, including the
// transaction contract (storage failures propagate so the enclosing publish
// rolls back; malformed/unpromotable facts are validation skips that do not
// abort the publish).
//
// WHAT IS DELETED, AND WHY (N1 final decision). Upstream `embedPromotedFacts`
// and its private `embedAndStoreMemory` (upstream :96-145) are REMOVED: they
// dispatch vectors through the embedding runtime, which the fork's dependency-
// exclusion order forbids (onnxruntime/transformers/@cortexkit/subc-client;
// see spec 裁定表 N1). With them go four now-dead imports:
// `embedTextForProject` (memory/embedding.ts — not ported),
// `saveEmbeddingIfHashMatches` (memory/storage-memory-embeddings.ts — ported,
// but its only caller was the deleted function), `sessionLog`
// (../../../shared/logger.js — only used by the deleted error log) and
// `getMemoryById` (storage-memory — its only call site was the deleted
// hash-before-embed capture; the remaining insert/dedup path never reads a
// row back by id). `PromotedMemoryRef` stays exported because it is part of
// the durable result shape the runner records, even though no vector work
// follows it.
import type { Database } from "../../../shared/sqlite.js";
import { CATEGORY_DEFAULT_TTL, PROMOTABLE_CATEGORIES } from "./constants.js";
import { computeNormalizedHash } from "./normalize-hash.js";
import {
    getMemoryByHash,
    insertMemory,
    updateMemorySeenCount,
} from "./storage-memory.js";
import type { MemoryCategory, MemoryInput } from "./types.js";

interface SessionFact {
    category: string;
    content: string;
}

export interface PromotedMemoryRef {
    memoryId: number;
    content: string;
}

export interface PromoteSessionFactsDurableResult {
    /** Newly inserted memories that still need embedding. */
    newMemoryRefs: PromotedMemoryRef[];
    /** Valid promotable facts that inserted a row or updated an existing row. */
    factsPromoted: number;
}

function isPromotableCategory(category: string): category is MemoryCategory {
    return PROMOTABLE_CATEGORIES.some((promotableCategory) => promotableCategory === category);
}

function resolveExpiresAt(category: MemoryCategory): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : Date.now() + ttl;
}

/**
 * Synchronously promote eligible session facts to cross-session memories.
 *
 * Transaction contract: callers may run this inside their publish transaction.
 * Storage failures deliberately propagate so the enclosing publication rolls
 * back atomically with the boundary; malformed/unpromotable facts are validation
 * skips and do not abort the publish.
 */
export function promoteSessionFactsDurable(
    db: Database,
    sessionId: string,
    projectPath: string,
    facts: SessionFact[],
): PromoteSessionFactsDurableResult {
    const newMemoryRefs: PromotedMemoryRef[] = [];
    let factsPromoted = 0;
    for (const fact of facts) {
        if (
            !fact ||
            typeof fact.category !== "string" ||
            typeof fact.content !== "string" ||
            fact.content.trim().length === 0
        ) {
            continue;
        }
        if (!isPromotableCategory(fact.category)) {
            continue;
        }

        const normalizedHash = computeNormalizedHash(fact.content);
        const existingMemory = getMemoryByHash(db, projectPath, fact.category, normalizedHash);

        if (existingMemory) {
            updateMemorySeenCount(db, existingMemory.id);
            factsPromoted += 1;
            continue;
        }

        const memoryInput: MemoryInput = {
            projectPath,
            category: fact.category,
            content: fact.content,
            sourceSessionId: sessionId,
            sourceType: "historian",
            expiresAt: resolveExpiresAt(fact.category),
        };

        const memory = insertMemory(db, memoryInput);
        newMemoryRefs.push({ memoryId: memory.id, content: memory.content });
        factsPromoted += 1;
    }

    return { newMemoryRefs, factsPromoted };
}
