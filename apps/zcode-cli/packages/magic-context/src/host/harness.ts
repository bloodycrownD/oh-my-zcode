/**
 * Step 17 — host adapter: the boot-time host identity.
 *
 * WHY THIS FILE EXISTS (S15 leftover #6). `core/shared/harness.ts` defaults
 * `currentHarness` to `"opencode"` and only pins it when a plugin entry point
 * calls `setHarness(...)`. Every session-scoped row magic-context writes carries
 * that value in its `harness` column, and it is read back to scope queries and to
 * disambiguate writers. A ZCode install that never calls `setHarness` therefore
 * attributes EVERY session row to OpenCode — silent cross-harness leakage, which
 * upstream calls "a correctness bug, not a feature".
 *
 * THE CONTRACT. `initializeMagicContextHost()` must be the FIRST thing the
 * bootstrap assembly does, before ANY DB write and before `openDatabase()` is
 * reachable. It is:
 *
 *   - IDEMPOTENT. Calling it twice, from two entry points, or after a host
 *     already pinned the harness, is a no-op that returns the same snapshot.
 *   - SELF-VERIFYING. It reads `getHarness()` back and throws if the value is not
 *     `"zcode"`, so a wiring mistake surfaces at boot instead of as a wrong
 *     `harness` column three sessions later.
 *   - COMPLETE. It also installs the storage-dir resolver from `storage-dir.ts`
 *     (S15 leftover #5) in the same call, so there is exactly ONE boot step to
 *     remember and no window where the harness is right but the artifact
 *     directory is not.
 *
 * S19b wiring: `bootstrap/src/app/create-app.ts` calls this before assembling
 * magic-context. It is deliberately NOT called from inside `core/` — a library
 * that renames its host behind the application's back is exactly the bug class
 * this file exists to prevent.
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { type HarnessId, getHarness, setHarness } from "../core/shared/harness.js";
import { getZCodeProjectMagicContextDir, setProjectDirResolver } from "./storage-dir.js";

/** This fork's harness id (`core/shared/harness.ts:32`). */
export const ZCODE_HARNESS_ID: HarnessId = "zcode";

/** What the boot step installed, for diagnostics and `/ctx-status`. */
export interface MagicContextHostSnapshot {
  harness: HarnessId;
  /** Project artifact directory the resolver hands out. */
  projectDirResolver: "zcode-home" | "custom";
}

let initializedSnapshot: MagicContextHostSnapshot | null = null;

/**
 * Install the ZCode host identity. MUST run before any DB write.
 *
 * Idempotent: the second call returns the first call's snapshot without touching
 * core state again. That matters because `setHarness` deliberately throws when a
 * LOCKED harness is asked to change, and a second boot path (e.g. a worker that
 * re-enters the plugin bootstrap) must not be able to trip it.
 */
export function initializeMagicContextHost(): MagicContextHostSnapshot {
  if (initializedSnapshot) return initializedSnapshot;

  // Pin the harness first: it is the one piece of state a wrong order corrupts
  // (rows written before this line are attributed to "opencode").
  setHarness(ZCODE_HARNESS_ID);

  // S15 leftover #5: retarget the project artifact directory off the user's
  // project tree. The default resolver is the fork's `~/.omz` location; a host
  // that wants its own calls `setProjectDirResolver` afterwards.
  setProjectDirResolver(getZCodeProjectMagicContextDir);

  const harness = getHarness();
  if (harness !== ZCODE_HARNESS_ID) {
    throw new Error(
      `magic-context host init failed: harness is "${harness}" after setHarness("${ZCODE_HARNESS_ID}")`,
    );
  }
  initializedSnapshot = { harness, projectDirResolver: "zcode-home" };
  return initializedSnapshot;
}

/**
 * Assert the host identity is installed. Cheap enough for the fail-closed gate
 * to call before it touches storage; returns the snapshot or throws with the fix.
 */
export function assertMagicContextHostInitialized(): MagicContextHostSnapshot {
  if (!initializedSnapshot) {
    throw new Error(
      "magic-context: initializeMagicContextHost() must run before any DB write (call it first in the bootstrap assembly)",
    );
  }
  const harness = getHarness();
  if (harness !== ZCODE_HARNESS_ID) {
    throw new Error(
      `magic-context: harness is "${harness}", expected "${ZCODE_HARNESS_ID}"; initializeMagicContextHost() must run before any DB write`,
    );
  }
  return initializedSnapshot;
}

/** Non-throwing probe. */
export function isMagicContextHostInitialized(): boolean {
  return initializedSnapshot !== null && getHarness() === ZCODE_HARNESS_ID;
}

/**
 * Test-only: forget the initialization snapshot WITHOUT touching core's harness
 * lock. Core exposes `_resetHarnessForTesting()` for the other half; tests that
 * need both call the two together. Never call from production code.
 */
export function __resetHostInitializationForTests(): void {
  initializedSnapshot = null;
}
