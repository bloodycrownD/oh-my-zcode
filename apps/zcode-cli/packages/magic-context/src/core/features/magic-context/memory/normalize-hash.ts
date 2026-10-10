// FORK-NOTE(Step 8 / bugfix-batch-20261011): upstream
// `features/magic-context/memory/normalize-hash.ts` (13 lines) — NEW PORT
// (deferred had no seam for this file).
//
// Why it is needed: the memory dedup hash. `promotion.ts` computes it
// before every insert, `storage-memory.ts` recomputes it on content
// updates, and the idempotent insert path matches rows by it. Zero
// imports outside `node:crypto`, so it carries no embedding runtime with
// it — the MD5 is over NORMALIZED TEXT, not a vector.
import { createHash } from "node:crypto";

export function normalizeMemoryContent(content: string): string {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeNormalizedHash(content: string): string {
    const normalized = normalizeMemoryContent(content);
    // node:crypto's MD5 produces the exact same hex digest as Bun.CryptoHasher("md5"),
    // so existing memory hashes remain stable across the runtime swap.
    return createHash("md5").update(normalized).digest("hex");
}
