/**
 * Step 17 — host adapter: storage locations.
 *
 * Two jobs, both of them "where does this fork write".
 *
 * (a) THE MAIN DATABASE. Step 15 already retargeted it through
 *     `core/shared/data-path.ts` (`~/.omz/cli/db/magic-context.db`, honoring
 *     `MAGIC_CONTEXT_DB_DIR` and the test-isolation ladder). This file does NOT
 *     re-derive that: it re-exports the core resolution so callers have ONE
 *     documented entry point, and adds the fork's only override knob
 *     (`MAGIC_CONTEXT_DB_PATH`, a full file path) which core's directory-level
 *     knob cannot express.
 *
 * (b) THE PROJECT-SCOPED ARTIFACT DIRECTORY — S15 leftover #5.
 *     `core/shared/data-path.ts:106` still returns
 *     `<project>/.cortexkit/magic-context`, which in oh-my-zcode would write
 *     INSIDE THE USER'S PROJECT REPO. Two reasons that must not stand:
 *       1. ZCode has no `external_directory` permission prompt that makes
 *          project-local writes attractive in the first place (that was an
 *          OpenCode-only constraint).
 *       2. Writing transient historian dumps into a user's repo dirties a tree
 *          they may not even own (the ZCode install is global; the project is
 *          not), and would require mutating the project's `.gitignore`.
 *     The target is `~/.omz/cli/magic-context/projects/<projectKey>/` where
 *     `projectKey` is the SAME key algorithm core's storage already uses for
 *     project-scoped paths — `sha256(projectDirectoryKey(directory))`, the
 *     construction in `core/features/magic-context/memory/project-identity-cache.ts:11-14`.
 *
 * (b) HAS A WIRING CAVEAT, AND IT IS THE POINT OF THIS COMMENT. Core's
 * `getProjectMagicContextDir(directory)` is a plain function with a direct
 * `return path.join(...)`; there is no injection seam to retarget from the
 * outside, and Step 17 is not allowed to edit `src/core/**`. So this file ships
 * the seam (`setProjectDirResolver`) plus the target (`resolveProjectMagicContextDir`)
 * and Step 20 wires it, in ONE of two equivalent ways:
 *
 *   - Preferred (no core change at all): the C-group historian / recomp artifact
 *     writers import `resolveProjectMagicContextDir` from this file instead of
 *     `getProjectMagicContextDir`. They are new files landing in Step 20, so this
 *     costs nothing.
 *   - If a consumer that already exists must be retargeted, the S20 change is a
 *     two-line edit inside `core/shared/data-path.ts:106` that consults the
 *     resolver registered here. That import is a cycle (`data-path` → `storage-dir`
 *     → `data-path`), and it is SAFE: `storage-dir` only touches the core binding
 *     inside function bodies, never at module top level, so the live binding is
 *     always initialized before any call. Verified reasoning, not yet executed —
 *     Step 20 must land a smoke test with it.
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  type MagicContextStorageResolution,
  getDataDir,
  getMagicContextStorageResolution,
} from "../core/shared/data-path.js";
import { projectDirectoryKey } from "../core/shared/project-directory-key.js";

/**
 * The store's file name. Core owns the value (`storage-db.ts:167`); it is
 * restated here on purpose rather than imported, because importing it drags
 * `storage-db.ts` — the migrations + sqlite-chokepoint + logger closure — into
 * every consumer of a *path*, including the S19b wiring tests and any code that
 * must resolve a directory without touching storage. One string, one owner:
 * DRIFT GUARD — if `storage-db.ts:167` changes, change it here in the same
 * commit; `scripts/test-host.mjs` asserts the two agree on a real resolution.
 */
export const MAGIC_CONTEXT_DB_FILE_NAME = "magic-context.db";

export interface MagicContextDatabaseLocation {
  /** Directory holding `magic-context.db`. */
  dbDir: string;
  /** Absolute path of `magic-context.db`. */
  dbPath: string;
  /** Which layer of the resolution ladder answered. */
  source: MagicContextStorageResolution["source"];
}

/**
 * Resolve the main store.
 *
 * Precedence (identical to core's, plus one fork-only knob on top):
 *   1. `MAGIC_CONTEXT_DB_PATH` — a FULL FILE path. Fork-only: core's knob is
 *      directory-shaped (`MAGIC_CONTEXT_DB_DIR`) because upstream's store lived
 *      in a directory with sidecars; the fork still uses sidecars, but tests and
 *      one-off diagnostics benefit from naming the file. Must be absolute, so two
 *      processes on one host can never select different stores.
 *   2. `MAGIC_CONTEXT_DB_DIR` + test isolation + `NODE_ENV` backstop, all of which
 *      live in `getMagicContextStorageResolution()`.
 *   3. `~/.omz/cli/db`.
 */
export function getMagicContextDatabaseLocation(): MagicContextDatabaseLocation {
  const override = process.env.MAGIC_CONTEXT_DB_PATH?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error("MAGIC_CONTEXT_DB_PATH must be an absolute path");
    }
    return {
      dbDir: dirname(resolve(override)),
      dbPath: resolve(override),
      source: "environment override",
    };
  }
  const resolution = getMagicContextStorageResolution();
  return {
    dbDir: resolution.path,
    dbPath: join(resolution.path, MAGIC_CONTEXT_DB_FILE_NAME),
    source: resolution.source,
  };
}

/** Convenience: just the file path. */
export function getMagicContextDatabasePath(): string {
  return getMagicContextDatabaseLocation().dbPath;
}

/**
 * The project key for a project directory — the SAME construction core's storage
 * uses (`project-identity-cache.ts:11-14`): SHA-256 over the normalized
 * directory spelling. Two spellings of one directory therefore share one
 * artifact directory, and the path component stays filesystem-safe on every
 * platform (a raw Windows path is neither).
 */
export function getProjectKey(directory: string): string {
  return createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
}

/** Root of the fork's project-scoped artifact tree. */
export function getProjectArtifactsRoot(): string {
  // `~/.omz/cli/magic-context/projects/` — a sibling of `cli/db/`, not a child:
  // `cli/db/` is the SQLite directory (db.sqlite + WAL sidecars), and a per-project
  // tree does not belong inside it.
  return join(getDataDir(), "cli", "magic-context", "projects");
}

/**
 * The redirected project artifact directory (S15 leftover #5).
 *
 * Replaces core's `<project>/.cortexkit/magic-context`. Never writes inside the
 * user's project directory.
 */
export function getZCodeProjectMagicContextDir(directory: string): string {
  return join(getProjectArtifactsRoot(), getProjectKey(directory));
}

/** Historian artifact subdirectory, mirroring core's historian layout. */
export function getZCodeProjectMagicContextHistorianDir(directory: string): string {
  return join(getZCodeProjectMagicContextDir(directory), "historian");
}

/** A host may retarget the project directory wholesale. */
export type ProjectDirResolver = (directory: string) => string;

let projectDirResolver: ProjectDirResolver | null = null;

/**
 * Install (or clear) the process-wide project-dir resolver.
 *
 * Idempotent and re-callable; passing `undefined` restores the fork default.
 * Registration happens once, from `initializeMagicContextHost()` (see
 * `harness.ts`), so no consumer has to remember to do it.
 */
export function setProjectDirResolver(resolver?: ProjectDirResolver | null): void {
  projectDirResolver = resolver ?? null;
}

/**
 * The one call every artifact writer must make. Returns whatever resolver is
 * installed — the fork's `~/.omz` location by default.
 *
 * This is the S20 wiring point; see the header comment.
 */
export function resolveProjectMagicContextDir(directory: string): string {
  return projectDirResolver
    ? projectDirResolver(directory)
    : getZCodeProjectMagicContextDir(directory);
}

/** Whether a custom resolver is installed. Diagnostics / `/ctx-status`. */
export function hasProjectDirResolver(): boolean {
  return projectDirResolver !== null;
}

/**
 * Test-only: restore the default resolver. Never call from production paths —
 * a resolver swap after the first artifact write splits one project's artifacts
 * across two directories.
 */
export function __resetProjectDirResolverForTests(): void {
  projectDirResolver = null;
}
