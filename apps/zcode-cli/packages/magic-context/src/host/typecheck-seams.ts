/**
 * Step 18 close-out — compile-time proof of the host ↔ core structural seams.
 *
 * WHAT THIS FILE IS. A pure type-level assertion file. It exports NOTHING at
 * runtime and MUST NOT: its only job is to make `tsc` fail when a structural
 * contract between `src/host/` (the ZCode adapter) and `src/core/` (the ported
 * upstream) drifts. Every statement below is a variable annotation whose only
 * content is a cast; if the two sides stop being mutually assignable, the
 * annotation stops compiling.
 *
 * WHY IT IS NEEDED. Step 17 landed `src/host/` BEFORE the B group existed, so
 * `raw-message-provider.ts` carries a hand-written copy of the core
 * `RawMessageProvider` interface and `types.ts` carries hand-written copies of
 * `RawMessage` / `RawMessageParts` / `RawMessageOrdinalAnchor` /
 * `RawMessageOrdinalEntry`. Both files document "copy the source, do not improve
 * it" — but a comment is not a check. Now that `src/core/hooks/magic-context/
 * read-session-chunk.ts` and `read-session-raw.ts` exist, TypeScript's structural
 * typing IS the check: the provider a host registers is assigned to the core
 * registry, and that assignment stops compiling the moment either copy gains,
 * loses, or re-types a member.
 *
 * THE TWO DIRECTIONS ARE BOTH REQUIRED. `RawMessageProvider` has one required
 * member and fourteen optional ones, so a one-way check would pass even after a
 * required member was added to the CORE copy (the host object would still satisfy
 * it structurally if the new member is optional) or after a required member was
 * added to the HOST copy (the core registry would reject it). Assigning in both
 * directions closes both holes:
 *
 *   - core → host: proves every member the HOST promises, the core also declares.
 *   - host → core: proves every member the CORE declares, the host also satisfies.
 *
 * The asymmetry only shows up for REQUIRED members, which is exactly the set
 * where drift is a bug. Optional members are allowed to differ in the direction
 * the code actually uses them (the core falls back through progressively cheaper
 * shapes when a provider omits a method, per `read-session-chunk.ts:389-404`);
 * `raw-message-provider.ts` implements the complete surface anyway, so the fork
 * currently has none.
 *
 * WHEN A CHECK FAILS. Fix the CORE (source-position) copy, not the host copy —
 * `src/core/` is the verbatim port and is authoritative; `src/host/` is the
 * replica. If the core genuinely changed upstream, port the new member into the
 * core file first, then mirror it here in the same commit.
 *
 * This file is compiled by `pnpm --filter @zcode/magic-context build` (the
 * package's `tsc` covers `src/**`), so a drift breaks the package build and, via
 * turbo, `cd apps/zcode-cli && pnpm typecheck`.
 */

import type { RawMessageProvider as CoreRawMessageProvider } from "../core/hooks/magic-context/read-session-chunk.js";
import type {
  RawMessage as CoreRawMessage,
  RawMessageOrdinalAnchor as CoreRawMessageOrdinalAnchor,
  RawMessageOrdinalEntry as CoreRawMessageOrdinalEntry,
  RawMessageParts as CoreRawMessageParts,
} from "../core/hooks/magic-context/read-session-raw.js";
import type { MessageLike as CoreMessageLike } from "../core/hooks/magic-context/tag-messages.js";
import type {
  RawMessage as HostRawMessage,
  RawMessageOrdinalAnchor as HostRawMessageOrdinalAnchor,
  RawMessageOrdinalEntry as HostRawMessageOrdinalEntry,
  RawMessageParts as HostRawMessageParts,
} from "./types.js";
import type { RawMessageProvider as HostRawMessageProvider } from "./raw-message-provider.js";
import type { MessageLike as HostMessageLike } from "./types.js";

// ── RawMessageProvider: the seam S19b registers against ──────────────────────
//
// core → host and host → core. See the header for why both directions matter.
const _providerCoreToHost: HostRawMessageProvider = null as unknown as CoreRawMessageProvider;
const _providerHostToCore: CoreRawMessageProvider = null as unknown as HostRawMessageProvider;

// ── The message shapes the provider's signatures are written in ─────────────
//
// `RawMessageProvider` is a function of `RawMessage`, `RawMessageOrdinalAnchor`
// and `RawMessageOrdinalEntry`. The provider interfaces above are mutually
// assignable only if those ELEMENT types are too (TypeScript compares method
// signatures parameter-by-parameter), so the four are checked directly as well —
// that is what makes the check above a real check rather than a vacuous one
// (two interfaces with the same member NAMES but incompatible member TYPES would
// still be mutually assignable under `any`, and these are not `any`).
const _partsCoreToHost: HostRawMessageParts = null as unknown as CoreRawMessageParts;
const _partsHostToCore: CoreRawMessageParts = null as unknown as HostRawMessageParts;

const _messageCoreToHost: HostRawMessage = null as unknown as CoreRawMessage;
const _messageHostToCore: CoreRawMessage = null as unknown as HostRawMessage;

const _anchorCoreToHost: HostRawMessageOrdinalAnchor =
  null as unknown as CoreRawMessageOrdinalAnchor;
const _anchorHostToCore: CoreRawMessageOrdinalAnchor =
  null as unknown as HostRawMessageOrdinalAnchor;

const _entryCoreToHost: HostRawMessageOrdinalEntry = null as unknown as CoreRawMessageOrdinalEntry;
const _entryHostToCore: CoreRawMessageOrdinalEntry = null as unknown as HostRawMessageOrdinalEntry;

// ── MessageLike: the projection's input and output ───────────────────────────
//
// `types.ts` projects ZCode runtime entries to `MessageLike`
// (`projectRuntimeEntries`) and back to `RawMessage` (`messageLikeToRawMessage`).
// Both directions of that conversion are typed, so the seam is checked in both
// directions here: the fork never imports `@zcode/contracts`, which means these
// local copies are the only thing standing between a ZCode field change and a
// silently-wrong projection.
const _messageLikeCoreToHost: HostMessageLike = null as unknown as CoreMessageLike;
const _messageLikeHostToCore: CoreMessageLike = null as unknown as HostMessageLike;

// Keep every binding referenced so `noUnusedLocals` cannot quietly delete the
// assertions and turn this file into a no-op. `void` is the cheapest expression
// that still counts as a read.
void [
  _providerCoreToHost,
  _providerHostToCore,
  _partsCoreToHost,
  _partsHostToCore,
  _messageCoreToHost,
  _messageHostToCore,
  _anchorCoreToHost,
  _anchorHostToCore,
  _entryCoreToHost,
  _entryHostToCore,
  _messageLikeCoreToHost,
  _messageLikeHostToCore,
];
