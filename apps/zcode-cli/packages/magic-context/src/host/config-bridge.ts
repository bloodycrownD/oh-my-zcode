/**
 * Step 16 — E-group config port, push-based config bridge.
 *
 * Structural seam between ZCode's configuration store and magic-context. It is
 * deliberately declared against a local interface rather than `@zcode/contracts`:
 * the package must stay importable from tests and from any host without
 * dragging the ZCode package graph in, and the *shape* below is what Step 23
 * has to satisfy when it wires `ConfigPort.observe(ConfigKey.MagicContext)` to
 * this bridge. See the Step 16 handoff notes for the exact matching points.
 *
 * Adoption is fail-safe: a payload that does not validate never replaces the
 * live snapshot. The previous (last-known-good) configuration stays in force
 * and the reason is recorded in `getReloadFailure()` — a malformed write
 * degrades to "config change ignored", not to "feature off".
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  MagicContextConfigSchema,
  type MagicContextConfig,
} from "./config/schema.js";
import {
  computeConfigDigest,
  createInitialSnapshot,
  diffConfigKeys,
  type ConfigReloadFailure,
  type ConfigSnapshot,
} from "./config/snapshot.js";

/**
 * Where configuration comes from. Structurally satisfied by ZCode's config port
 * plus the `magicContext` domain projection Step 23 adds:
 *   - `read()`         -> the raw `magicContext` value (possibly `undefined`,
 *                        possibly a wrong shape — validation is this bridge's job)
 *   - `subscribe(fn)`  -> push notification on change, returns an unsubscribe
 */
export interface MagicContextConfigSource {
  read(): unknown;
  subscribe(listener: () => void): () => void;
}

export interface ConfigBridgeOptions {
  /** Injected clock; defaults to `Date.now`. Tests use a counter. */
  now?: () => number;
  /** Sink for the human-readable validation failure; defaults to silent. */
  onReloadFailure?: (failure: ConfigReloadFailure) => void;
}

export interface ConfigChangeEvent {
  readonly snapshot: ConfigSnapshot;
  /** Dotted paths that differ from the previous generation. */
  readonly changedKeys: readonly string[];
}

export interface ConfigBridge {
  getSnapshot(): ConfigSnapshot;
  /** Last failed reload, or `undefined` when the last read validated. */
  getReloadFailure(): ConfigReloadFailure | undefined;
  /** Dotted paths adopted by the current generation; empty for generation <= 1. */
  getChangedKeys(): readonly string[];
  onChange(listener: (event: ConfigChangeEvent) => void): () => void;
  /** Force a read; used by the initial sync and available for pull-shaped hosts. */
  refresh(): void;
  dispose(): void;
}

/**
 * Subscribes to `source` and republishes its `magicContext` domain as a
 * `ConfigSnapshot`. The first read happens synchronously during construction so
 * a consumer that never sees a notification still gets a usable snapshot.
 */
export function createConfigBridge(
  source: MagicContextConfigSource,
  opts: ConfigBridgeOptions = {},
): ConfigBridge {
  const now = opts.now ?? Date.now;
  const listeners = new Set<(event: ConfigChangeEvent) => void>();

  let snapshot: ConfigSnapshot = createInitialSnapshot(DEFAULT_MAGIC_CONTEXT_CONFIG);
  let changedKeys: readonly string[] = [];
  let failure: ConfigReloadFailure | undefined;
  let adopted = false;

  const emit = (): void => {
    // Copy first: a listener may unsubscribe itself from inside the callback,
    // and iterating the live Set would then skip its neighbour.
    for (const listener of Array.from(listeners)) listener({ snapshot, changedKeys });
  };

  const refresh = (): void => {
    const raw = source.read();
    const parsed = MagicContextConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      // Fail-safe: keep the last-known-good snapshot in force.
      failure = { error: formatIssues(parsed.error), at: now() };
      opts.onReloadFailure?.(failure);
      return;
    }
    const next: MagicContextConfig = parsed.data;
    const digest = computeConfigDigest(next);
    failure = undefined;
    // The first valid payload is always adopted, even when it happens to equal
    // the pre-load default; after that only a digest change counts.
    if (adopted && digest === snapshot.digest) return;
    adopted = true;
    const previous = snapshot.effective;
    changedKeys = diffConfigKeys(previous, next);
    snapshot = {
      generation: snapshot.generation + 1,
      digest,
      adoptedAt: now(),
      effective: next,
    };
    emit();
  };

  refresh();
  const unsubscribe = source.subscribe(refresh);

  return {
    getSnapshot: () => snapshot,
    getReloadFailure: () => failure,
    getChangedKeys: () => changedKeys,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    dispose: () => {
      unsubscribe();
      listeners.clear();
    },
  };
}

function formatIssues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}
