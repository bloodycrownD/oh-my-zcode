/**
 * Step 15 / bugfix-batch-20261011 (D5): the memory-directory barrel.
 *
 * WHY THIS FILE EXISTS. Upstream's mural import closure reads
 * `getMemoriesByProject` from `"../memory"` (this directory index), and the
 * fork's ported `mural/resolve-mural.ts` preserves that import 1:1 (re-qualified
 * to `"../memory/index.js"` for NodeNext). Porting the mural five-piece set
 * therefore REQUIRES this barrel: without it the only way to satisfy the import
 * would be editing the upstream-verbatim import line in the new port, which is
 * exactly the kind of silent divergence this fork's port discipline forbids.
 *
 * The second consumer is the fork itself: `hooks/magic-context/
 * compartment-runner-incremental.ts` (the historian compartment runner) reached
 * into `memory/promotion.js` and `memory/storage-memory.js` by file path.
 * Those two imports now come through this barrel — the runner no longer encodes
 * the memory directory's file layout, and its import surface is reviewable in
 * one place. `inject-compartments.ts` deliberately KEEPS its direct imports
 * (upstream-verbatim zone; only its two mural import lines change in this step).
 *
 * WHAT CHANGED VS THE UPSTREAM BARREL (pruned to the fork's real closure;
 * re-exports here would otherwise force every mural-path import to load
 * heavyweight transitive graphs):
 *   - `./embedding`, `./embedding-backfill`, `./storage-memory-verifications`,
 *     `./verification-paths` — not ported at all (N1: embedding runtime is a
 *     final "not doing" for this fork, see spec 裁定表 N1).
 *   - `./embedding-cache`, `./storage-memory-embeddings`, `./embedding-failure`
 *     — ported (Step 8) but deliberately NOT re-exported: they are the N1
 *     embedding face. The barrel must not hand them to new consumers;
 *     storage-memory keeps its private import of embedding-cache.
 *   - `./promotion`: upstream re-exports `embedPromotedFacts` too — that symbol
 *     does not exist in the fork (embedPromotedFacts + embedAndStoreMemory were
 *     removed with the N1 裁定 in Step 8, FORK-NOTE in promotion.ts). Only
 *     `promoteSessionFactsDurable` and the `PromotedMemoryRef` type go out.
 *   - `./project-identity` — upstream exports it here; the fork does NOT. The
 *     fork's project-identity carries test hooks and spawns `git` via
 *     `node:child_process`; the mural path has no use for identity resolution
 *     (it receives a resolved `projectIdentity` from the m0 materialization) and
 *     must not pay for (or inherit) that graph. Its real consumers
 *     (host/index barrel) import the file directly, unchanged.
 *   - `./visibility`, `./memory-selection` — upstream keeps them out of the
 *     barrel; the fork matches that (inject-compartments imports them directly,
 *     upstream-verbatim).
 *
 * MURAL EXPORT SURFACE. Through this barrel the mural chain reaches exactly one
 * symbol — `getMemoriesByProject` (resolve-mural's overflow-set selection,
 * `mural/resolve-mural.ts:26`) — plus `getMemoryCategoryOrder` from
 * `./constants.js` for the entry ordering. Nothing in `mural/**` imports the
 * memory WRITE face (insertMemory / insertMemoryIdempotent): murals are
 * read-only renderings of memories the historian/ctx_memory already wrote.
 *
 * FORK 纪律 (spec): barrel expansion carries this comment block; hosts must not
 * re-implement these symbols. Batch: bugfix-batch-20261011 / Step 15.
 */

export * from "./constants.js";
export * from "./normalize-hash.js";
export type { PromotedMemoryRef } from "./promotion.js";
export { promoteSessionFactsDurable } from "./promotion.js";
export * from "./storage-memory.js";
export * from "./storage-memory-fts.js";
export * from "./types.js";
