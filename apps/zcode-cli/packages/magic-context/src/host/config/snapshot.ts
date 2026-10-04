/**
 * Step 16 — E-group config port, `ConfigSnapshot` semantics.
 *
 * The reference's `config/live-snapshot.ts` publishes this exact record shape,
 * but its producer is a `.cortexkit/` two-file *poller* (`LiveConfigReader`),
 * which is the opposite direction from D-12's push-based `ConfigPort.observe`
 * subscription. So only the contract is ported: the record, the digest, the
 * `changedKeys` difference, and the fail-safe reload-failure report. The
 * polling implementation, the jsonc loader, and the `.cortexkit/` path family
 * are not.
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../../core/shared/stable-json.js";
import type { MagicContextConfig } from "./schema.js";

/** One adopted configuration, immutable once published. */
export interface ConfigSnapshot {
  /** Bumped by exactly 1 on every adoption; 1 for the first successful load. */
  readonly generation: number;
  /** sha256 hex of the stable-JSON form of `effective`. */
  readonly digest: string;
  /** `Date.now()` (or the injected clock) at adoption. */
  readonly adoptedAt: number;
  readonly effective: MagicContextConfig;
}

/**
 * The last reload that did not validate. Recorded instead of throwing so a bad
 * write cannot take the feature down: the previous snapshot stays in force
 * (last-known-good) and consumers can surface the reason.
 */
export interface ConfigReloadFailure {
  readonly error: string;
  readonly at: number;
}

/**
 * Content digest of a configuration. Normalized through `stableStringify`
 * (code-point-sorted keys), so key order in the source object is irrelevant and
 * the same logical config always hashes the same.
 */
export function computeConfigDigest(config: MagicContextConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dotted-path difference between two configurations, sorted. Values are
 * compared as stable JSON so `undefined` vs absent and key order do not count
 * as changes. Arrays compare whole (a reordered fallback list is a change).
 */
export function diffConfigKeys(prev: MagicContextConfig, next: MagicContextConfig): string[] {
  const changed: string[] = [];
  const walk = (a: unknown, b: unknown, prefix: string): void => {
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key], b[key], prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    if (stableStringify(a) !== stableStringify(b)) changed.push(prefix);
  };
  walk(prev, next, "");
  return changed.sort();
}

/** The pre-first-load snapshot: generation 0, no adoption yet. */
export function createInitialSnapshot(effective: MagicContextConfig): ConfigSnapshot {
  return { generation: 0, digest: computeConfigDigest(effective), adoptedAt: 0, effective };
}
