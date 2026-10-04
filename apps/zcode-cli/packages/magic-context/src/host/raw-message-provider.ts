/**
 * Step 17 鈥?host adapter: the ZCode implementation of `RawMessageProvider`.
 *
 * WHAT THIS IS. magic-context's historian and compartment machinery never reads
 * a session store directly; it reads "raw session messages" through a
 * per-session provider registered with `setRawMessageProvider()`
 * (`read-session-chunk.ts:185-223`). Upstream, OpenCode owns that store and the
 * default reader is SQL; every other harness (Pi, OMP) registers a provider.
 * ZCode is exactly such a harness, and its provider has to serve TWO sources:
 *
 *   - the LIVE, in-memory history 鈥?`messageHistory.borrowReadOnlyRuntimeEntries()`,
 *     zero-copy and authoritative for the current request; and
 *   - the PERSISTED history 鈥?the SQLite session store at
 *     `~/.zcode/cli/db/db.sqlite`, which is what a cold start, a background
 *     historian run, and every by-id/ordinal lookup need.
 *
 * Both are injected (`RawMessageProviderDeps`) so this file has no ZCode import
 * and no filesystem access; `session-history.ts` supplies the persisted half.
 *
 * FORK (structural contract, S19b): `RawMessageProvider` below is a VERBATIM
 * copy of `hooks/magic-context/read-session-chunk.ts:128-158`, including the
 * optionality of every member. It is structurally equivalent to the same-named
 * interface the B group ports into `core/hooks/magic-context/read-session-chunk.ts`;
 * S19b wiring registers this object with the core `setRawMessageProvider` and
 * TypeScript's structural typing is the check 鈥?if the B-group copy ever gains a
 * required member, that assignment stops compiling and the seam is updated here.
 * Do NOT "improve" the member list here to match a local idea; copy the source.
 *
 * WHY EVERY MEMBER IS IMPLEMENTED. The source falls back through progressively
 * cheaper shapes when a provider omits a method (`read-session-chunk.ts:389-404`,
 * `736-756`): an omitted `readMessagePage` degrades to filtering the FULL history
 * on every page, which is O(session) per page. The spec's risk register (R7) calls
 * out exactly this mismatch, so this provider implements the complete surface and
 * every fallback stays unreachable.
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import {
  type RawMessage,
  type RawMessageOrdinalAnchor,
  type RawMessageOrdinalEntry,
  type RawMessageParts,
  messageLikeToRawMessage,
  projectRuntimeEntries,
  snapshotRuntimeEntries,
  type ZCodeRuntimeEntry,
} from "./types.js";

/**
 * VERBATIM copy of `hooks/magic-context/read-session-chunk.ts:128-158`.
 * Do not reorder, rename, or re-type a member 鈥?S19b relies on structural
 * equivalence with the core copy.
 */
export interface RawMessageProvider {
  readMessages(): RawMessage[];
  readMessagePage?: (
    afterOrdinal: number,
    limit: number,
    finalWatermark: number,
    after?: RawMessageOrdinalAnchor,
  ) => RawMessage[];
  /** A single source traversal; iterator cleanup must release resources on early exit. */
  iterateMessageRange?: (fromOrdinal: number, toOrdinal: number) => Iterable<RawMessage>;
  readMessageById?: (messageId: string) => RawMessage | null;
  readMessagePartsById?: (messageId: string) => RawMessageParts | null;
  hasMessageById?: (messageId: string) => boolean;
  readMessageOrdinalById?: (messageId: string) => number | null;
  readMessageIdOrdinals?: () => Map<string, number>;
  readMessageIdOrdinalsForRange?: (fromOrdinal: number, toOrdinal: number) => Map<string, number>;
  readMessageOrdinalPage?: (
    after: RawMessageOrdinalAnchor | null,
    limit: number,
  ) => RawMessageOrdinalEntry[];
  /** Optional fast count path; falls back to readMessages().length. */
  getMessageCount?: () => number;
  /** Stored row count including compaction summaries, used for ordinal drift detection. */
  getStoredMessageCount?: () => number;
  /**
   * Id of the row a request carries in place of a stored compartment boundary.
   * Only hosts that store rows they never serve by id implement it; null means
   * keep the stored id.
   */
  readServedBoundaryId?: (messageId: string) => string | null;
}

/**
 * Messages per page for the streaming visitors (`read-session-chunk.ts:471`).
 * The range reader uses 100 (`read-session-chunk.ts:421`); both are load-bearing
 * for peak heap on a long session, so they travel with the provider.
 */
export const RAW_MESSAGE_VISIT_PAGE_SIZE = 50;
export const RAW_MESSAGE_RANGE_PAGE_SIZE = 100;

/** One page of the persisted store, already decoded into raw messages. */
export interface StoredMessagePage {
  messages: RawMessage[];
  /** Absolute count of stored rows, when the source can answer it cheaply. */
  storedCount?: number;
}

export interface RawMessageProviderDeps {
  /**
   * `MessageHistory.borrowReadOnlyRuntimeEntries()`. MUST be synchronous and
   * MUST return the live array (zero-copy); the provider takes its own shallow
   * array snapshot before converting, which is the contract the core comment on
   * `borrowReadOnlyRuntimeEntries` states ("璺ㄥ紓姝ヨ竟鐣屾椂鐢辫皟鐢ㄦ柟鍋氭暟缁勬祬蹇収").
   */
  borrowRuntimeEntries(): readonly ZCodeRuntimeEntry[];

  /**
   * Paged read of the PERSISTED store, ordered exactly as the host session store
   * orders it (ZCode: `sequence is null, sequence, time_created, rowid` 鈥?see
   * `adapters/src/storage/session-store/repositories/messages.ts:226-233`), so
   * ordinals agree with `SessionStorePort.messages()`.
   *
   * Returns an EMPTY page once the range is exhausted. `after` is the
   * (time_created, id) anchor of the last row of the previous page; pass it
   * through verbatim so the source can resume past timestamp ties.
   */
  readStoredMessagePage(args: {
    sessionId: string;
    afterOrdinal: number;
    limit: number;
    finalWatermark: number;
    after?: RawMessageOrdinalAnchor;
  }): StoredMessagePage;

  /**
   * Stored row count including compaction summary rows. Bound to the session:
   * these deps are built per provider instance, so no call re-passes it.
   */
  getStoredMessageCount(): number;

  /**
   * Optional single-row lookup on the store's primary key. Without it the
   * provider walks ordinal pages until the id shows up, which is correct but
   * hydrates parts it will discard 鈥?a `where id = ?` lookup is one index seek.
   */
  readStoredMessageById?(messageId: string): RawMessage | null;

  /**
   * Optional ordinal-only page (ids + timestamps, no parts). Mirrors
   * `readRawSessionMessageOrdinalPageFromDb`; without it the provider
   * reconstructs the same rows from full pages.
   */
  readStoredOrdinalPage?(
    after: RawMessageOrdinalAnchor | null,
    limit: number,
  ): RawMessageOrdinalEntry[];

  /** Ordinals of the session this provider serves. */
  sessionId: string;
}

function rawMessagesFromEntries(
  deps: RawMessageProviderDeps,
  entries: readonly ZCodeRuntimeEntry[],
): RawMessage[] {
  const projected = projectRuntimeEntries(entries, { sessionId: deps.sessionId });
  return projected.map((message, index) => messageLikeToRawMessage(message, index + 1));
}

/**
 * Live history as raw messages.
 *
 * The snapshot is synchronous and array-shallow: a caller that keeps the result
 * across an `await` still sees the same length and order, even if the host keeps
 * streaming new entries into its own array afterwards.
 */
function readLiveMessages(deps: RawMessageProviderDeps): RawMessage[] {
  return rawMessagesFromEntries(deps, snapshotRuntimeEntries(deps.borrowRuntimeEntries()));
}

/** Page the live array directly when no persisted source answered. */
function sliceLivePage(
  messages: readonly RawMessage[],
  afterOrdinal: number,
  limit: number,
  finalWatermark: number,
): RawMessage[] {
  return messages
    .filter((message) => message.ordinal > afterOrdinal && message.ordinal <= finalWatermark)
    .slice(0, Math.max(0, Math.floor(limit)));
}

function ordinalEntries(messages: readonly RawMessage[]): RawMessageOrdinalEntry[] {
  return messages.map((message) => ({
    id: message.id,
    timeCreated: message.createdAt ?? message.ordinal,
    contributesOrdinal: true,
    hasValidInfo: message.role !== "unknown",
  }));
}

function afterAnchorOf(page: readonly RawMessage[]): RawMessageOrdinalAnchor | undefined {
  const last = page[page.length - 1];
  return last ? { timeCreated: last.createdAt ?? 0, id: last.id } : undefined;
}

/**
 * Walk [fromOrdinal, toOrdinal] through the persisted source one bounded page at
 * a time. Mirrors `readRawSessionMessageRangeFromSource`
 * (`read-session-chunk.ts:423-468`): the page walk, the `after` anchor derived
 * from the previous page's last row, and the no-progress break.
 */
function readRangeFromSource(
  deps: RawMessageProviderDeps,
  fromOrdinal: number,
  toOrdinal: number,
  pageSize = RAW_MESSAGE_RANGE_PAGE_SIZE,
): RawMessage[] {
  const from = Math.max(1, Math.floor(fromOrdinal));
  const to = Math.floor(toOrdinal);
  if (to < from) return [];

  const messages: RawMessage[] = [];
  let afterOrdinal = from - 1;
  let after: RawMessageOrdinalAnchor | undefined;
  while (afterOrdinal < to) {
    const limit = Math.min(pageSize, to - afterOrdinal);
    const page = deps.readStoredMessagePage({
      sessionId: deps.sessionId,
      afterOrdinal,
      limit,
      finalWatermark: to,
      ...(after === undefined ? {} : { after }),
    }).messages;
    if (page.length === 0) break;
    let nextOrdinal = afterOrdinal;
    for (const message of page) {
      if (message.ordinal < from || message.ordinal > to) continue;
      messages.push(message);
      nextOrdinal = Math.max(nextOrdinal, message.ordinal);
    }
    if (nextOrdinal <= afterOrdinal) break;
    afterOrdinal = nextOrdinal;
    after = afterAnchorOf(page);
  }
  return messages;
}

/**
 * Build the ZCode raw-message provider for ONE session scope.
 *
 * Scope discipline is the caller's (the core `withRawMessageProvider` helper
 * registers and unregisters around one historian/trigger evaluation); this
 * factory holds no module state, so two providers for two sessions can coexist.
 */
export function createRawMessageProvider(deps: RawMessageProviderDeps): RawMessageProvider {
  const provider: RawMessageProvider = {
    readMessages(): RawMessage[] {
      return readLiveMessages(deps);
    },

    readMessagePage(
      afterOrdinal: number,
      limit: number,
      finalWatermark: number,
      after?: RawMessageOrdinalAnchor,
    ): RawMessage[] {
      const page = deps.readStoredMessagePage({
        sessionId: deps.sessionId,
        afterOrdinal,
        limit,
        finalWatermark,
        ...(after === undefined ? {} : { after }),
      }).messages;
      if (page.length > 0) return page;
      // The persisted store ends before the live history does (this turn's
      // entries are not flushed yet), so fall back to the in-memory array rather
      // than reporting a short session.
      return sliceLivePage(readLiveMessages(deps), afterOrdinal, limit, finalWatermark);
    },

    *iterateMessageRange(fromOrdinal: number, toOrdinal: number): Iterable<RawMessage> {
      const from = Math.max(1, Math.floor(fromOrdinal));
      const to = Math.floor(toOrdinal);
      if (to < from) return;
      yield* readRangeFromSource(deps, from, to);
    },

    readMessageById(messageId: string): RawMessage | null {
      const found = readLiveMessages(deps).find((message) => message.id === messageId);
      if (found) return found;
      if (deps.readStoredMessageById) {
        return deps.readStoredMessageById(messageId);
      }
      // Fallback: walk pages until the id appears. Only reached when the host did
      // not supply the primary-key lookup.
      for (const message of readRangeFromSource(deps, 1, deps.getStoredMessageCount())) {
        if (message.id === messageId) return message;
      }
      return null;
    },

    readMessagePartsById(messageId: string): RawMessageParts | null {
      const message = provider.readMessageById?.(messageId) ?? null;
      return message ? message : null;
    },

    hasMessageById(messageId: string): boolean {
      return provider.readMessageById?.(messageId) !== null;
    },

    readMessageOrdinalById(messageId: string): number | null {
      return provider.readMessageIdOrdinals?.().get(messageId) ?? null;
    },

    readMessageIdOrdinals(): Map<string, number> {
      const ordinals = new Map<string, number>();
      for (const message of readRangeFromSource(deps, 1, deps.getStoredMessageCount())) {
        ordinals.set(message.id, message.ordinal);
      }
      // Live entries whose ordinal the persisted walk could not reach still need
      // an answer, otherwise a message created this turn has no ordinal at all.
      for (const message of readLiveMessages(deps)) {
        if (!ordinals.has(message.id)) ordinals.set(message.id, message.ordinal);
      }
      return ordinals;
    },

    readMessageIdOrdinalsForRange(fromOrdinal: number, toOrdinal: number): Map<string, number> {
      const from = Math.max(1, Math.floor(fromOrdinal));
      const to = Math.floor(toOrdinal);
      if (to < from) return new Map();
      const ranged = new Map<string, number>();
      for (const message of readRangeFromSource(deps, from, to)) {
        ranged.set(message.id, message.ordinal);
      }
      if (ranged.size === 0) {
        for (const message of readLiveMessages(deps)) {
          if (message.ordinal < from || message.ordinal > to) continue;
          ranged.set(message.id, message.ordinal);
        }
      }
      return ranged;
    },

    readMessageOrdinalPage(
      after: RawMessageOrdinalAnchor | null,
      limit: number,
    ): RawMessageOrdinalEntry[] {
      const pageSize = Math.max(1, Math.floor(limit));
      const stored = deps.readStoredOrdinalPage
        ? deps.readStoredOrdinalPage(after, pageSize)
        : ordinalEntries(readRangeFromSource(deps, 1, Number.MAX_SAFE_INTEGER)).filter(
            (row) =>
              !after ||
              row.timeCreated > after.timeCreated ||
              (row.timeCreated === after.timeCreated && row.id > after.id),
          );
      // Live entries whose ordinal the persisted walk could not reach still need
      // an answer: this turn's messages are not flushed yet.
      const merged = new Map<string, RawMessageOrdinalEntry>();
      for (const row of stored) merged.set(row.id, row);
      for (const row of ordinalEntries(readLiveMessages(deps))) {
        if (!merged.has(row.id)) merged.set(row.id, row);
      }
      return [...merged.values()]
        .filter(
          (row) =>
            !after ||
            row.timeCreated > after.timeCreated ||
            (row.timeCreated === after.timeCreated && row.id > after.id),
        )
        .sort(
          (left, right) => left.timeCreated - right.timeCreated || left.id.localeCompare(right.id),
        )
        .slice(0, pageSize);
    },

    getMessageCount(): number {
      const live = readLiveMessages(deps);
      if (live.length === 0) return deps.getStoredMessageCount();
      return live.reduce((maximum, message) => Math.max(maximum, message.ordinal), live.length);
    },

    getStoredMessageCount(): number {
      return deps.getStoredMessageCount();
    },

    /**
     * Every ZCode stored row is served by its real id, so this is the identity
     * mapping (`read-session-chunk.ts:191-194` calls it the identity for such
     * hosts). Returning the id unchanged is what keeps a compartment boundary
     * resolvable after a rewind.
     */
    readServedBoundaryId(messageId: string): string | null {
      return messageId.length === 0 ? null : messageId;
    },
  };

  return provider;
}
