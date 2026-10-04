/**
 * Deferred seam — `config/schema/magic-context.ts` (upstream).
 *
 * Step 16 rewrites the magic-context config domain as a field-whitelisted zod v4
 * schema in `adapters/src/config/schema.ts` (D-12/E group) rather than porting
 * the upstream file, which embeds dreamer/mural/memory/rust/profile subtrees.
 * `storage-meta-persisted.ts` needs exactly one derivation from it — the default
 * `protected_tokens` formula — so it is reproduced here verbatim to keep the
 * persisted meta projection byte-identical.
 *
 * Step 16: delete this file and point `storage-meta-persisted.ts` back at the
 * E-group schema module.
 */

/**
 * Derived default protected_tokens formula:
 * clamp(round(0.05 × usableSoft), min(16000, round(0.08 × usableSoft)), 64000)
 *
 * Sizing table:
 *   100k -> 8,000
 *   200k -> 16,000
 *   372k -> 18,600
 *   872k -> 43,600
 *   1M   -> 50,000
 */
export function deriveDefaultProtectedTokens(usableSoft: number): number {
    const clampedUsable = Math.max(0, usableSoft);
    const lowerBound = Math.min(16_000, Math.round(0.08 * clampedUsable));
    const target = Math.round(0.05 * clampedUsable);
    return Math.min(64_000, Math.max(lowerBound, target));
}
