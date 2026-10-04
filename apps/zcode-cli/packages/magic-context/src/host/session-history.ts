/**
 * Step 17 — host adapter: session-history read facade over ZCode's store.
 *
 * This file replaces `hooks/magic-context/read-session-db.ts`, which upstream is
 * "OpenCode's own session DB". Two things live here:
 *
 *   1. THE FACADE (`SessionHistory`): the turn-state and recovery queries the
 *      hooks call — `assistantAwaitingTools`, `shouldHoldIgnoredNotification`,
 *      `latestPersistedMessageForRecovery`, `hasNewerRealUserMessage`,
 *      `getMessageTimes`, `findLastAssistantModel`. Each one is a
 *      *best-effort probe*: upstream every caller wraps it in a try/catch and
 *      degrades (a missing store must never break a turn), and that behaviour is
 *      preserved here — the facade catches, records, and answers "unknown".
 *   2. THE ZCode READER (`createZCodeSessionHistory`): the SQL. It is injected
 *      through `SessionStoreHandle`, a structural subset of `node:sqlite`'s
 *      `DatabaseSync`, so this file imports neither ZCode's adapters nor
 *      `node:sqlite` itself and stays testable against a fake.
 *
 * WHERE THE SCHEMA CAME FROM (read off the real `~/.omz/cli/db/db.sqlite`):
 *
 *   message(id, session_id, time_created, time_updated, data, sequence)
 *   part(id, message_id, session_id, time_created, time_updated, data, sequence)
 *
 * Both `data` columns are TEXT JSON blobs, exactly as the spec's `session-history`
 * row anticipated ("ZCode 表：message/part（part.data 为 TEXT JSON）"). Two schema
 * differences from OpenCode v1 are load-bearing:
 *
 *   - ORDER. ZCode owns a `sequence` column and orders by
 *     `sequence is null, sequence, time_created, rowid`
 *     (`adapters/.../repositories/messages.ts:226-233`). OpenCode orders by
 *     `time_created, id`. Raw-message ORDINALS are therefore numbered over ZCode's
 *     order here, so an ordinal means the same thing to the historian as it does
 *     to `SessionStorePort.messages()`.
 *   - TOOL RESULTS ARE NOT SEPARATE ROWS. In the real store an assistant row
 *     carries its own completed tool parts (`{type:"tool",callID,tool,state}`),
 *     the same shape OpenCode uses. There is no `role:"tool"` message to skip.
 *
 * Every query here is READ-ONLY by contract. The handle is documented as such and
 * the smoke test opens the user's real `db.sqlite` with `readOnly: true`.
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import {
  type RawMessage,
  type RawMessageOrdinalAnchor,
  type RawMessageOrdinalEntry,
  projectStoredMessage,
} from "./types.js";
import type { StoredMessagePage } from "./raw-message-provider.js";

// ─────────────────────────────────────────────────────────────────────────────
// structural handle
// ─────────────────────────────────────────────────────────────────────────────

/** One prepared statement; the subset of `node:sqlite` this file uses. */
export interface SessionStoreStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/**
 * Structural subset of `node:sqlite`'s `DatabaseSync`. Satisfied by the real
 * `DatabaseSync`; a test can pass a hand-written fake.
 */
export interface SessionStoreHandle {
  prepare(sql: string): SessionStoreStatement;
}

/** How the facade gets a handle, and whether it may try at all. */
export interface SessionHistoryDeps {
  /** Resolve the read-only session store, or throw when it is unavailable. */
  openSessionStore(): SessionStoreHandle;
  /** Cheap existence probe; defaults to "try to open". */
  sessionStoreExists?(): boolean;
  /** Diagnostics sink. Defaults to silent. */
  onProbeFailure?(message: string, error: unknown): void;
}

export interface LatestPersistedMessage {
  id: string;
  role: string;
  parentID?: string;
  completedAt?: number;
  error?: unknown;
}

/** SQL. ZCode's `finish` lives on the assistant row's `data` blob. */
const LATEST_ASSISTANT_SQL = `
  SELECT id,
         json_extract(data, '$.finish') as finish,
         time_created as timeCreated
    FROM message
   WHERE session_id = ?
     AND json_extract(data, '$.role') = 'assistant'
   ORDER BY sequence is null, sequence, time_created, rowid
   LIMIT 1
`;

const TOOL_PARTS_SQL = "SELECT data FROM part WHERE session_id = ? AND message_id = ?";

/**
 * Real-user predicate.
 *
 * Ported from `read-session-db.ts:474-517` and then ADAPTED to ZCode, because
 * ZCode answers this question directly and the source's part-join heuristic is
 * only its fallback. Measured on the real `db.sqlite` (132k rows):
 *
 *   `message.data.semantics.origin` ∈ {`real_user` (2494), `agent_runtime`
 *   (11636), `system` (1)}, alongside a legacy top-level `synthetic` flag
 *   (11600 rows).
 *
 * So a row counts as real when EITHER it declares `semantics.origin =
 * 'real_user'`, OR it predates the semantics field and falls back to the
 * source's all-parts-machine-generated test — kept intact, including the
 * vacuous-ALL fence: a partless row satisfies "every part is machine-generated"
 * trivially, so it counts as REAL.
 */
const NEWER_REAL_USER_SQL = `
  SELECT 1 as one
    FROM message m
   WHERE m.session_id = ?
     AND m.time_created > ?
     AND json_extract(m.data, '$.role') = 'user'
     AND (
       COALESCE(json_extract(m.data, '$.semantics.origin'), '') = 'real_user'
       OR (
         json_extract(m.data, '$.semantics.origin') IS NULL
         AND COALESCE(json_extract(m.data, '$.synthetic'), 0) NOT IN (1, 'true')
         AND NOT (
           EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id)
           AND NOT EXISTS (
             SELECT 1 FROM part p
              WHERE p.message_id = m.id
                AND COALESCE(json_extract(p.data, '$.synthetic'), 0) NOT IN (1, 'true')
                AND json_extract(p.data, '$.metadata.marker.kind') IS NULL
                AND COALESCE(json_extract(p.data, '$.ignored'), 0) NOT IN (1, 'true')
           )
         )
       )
     )
   LIMIT 1
`;

interface AssistantRow {
  id?: string;
  finish?: string | null;
  timeCreated?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return asRecord(JSON.parse(value) as unknown);
}

function truthyStoredFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

/**
 * Finish values that mean the assistant turn is over. Ported from the source's
 * "empty / tool-calls / unknown is unfinished" test, widened to ZCode's real
 * vocabulary (measured: `tool-calls` 113k, `stop` 2.4k, `completed` 1.5k,
 * `stream_recovery_discarded` 712, `other` / `length` / `failed` / empty). A
 * discarded-by-recovery row is NOT a pending turn, so treating it as unfinished
 * would hold every notice forever in a rewound session.
 */
const ZCODE_TERMINAL_FINISHES: ReadonlySet<string> = new Set([
  "stop",
  "completed",
  "other",
  "length",
  "failed",
]);

function latestAssistantRow(db: SessionStoreHandle, sessionId: string): AssistantRow | null {
  const row = db.prepare(LATEST_ASSISTANT_SQL).get(sessionId) as AssistantRow | undefined;
  return row ?? null;
}

export function hasNewerRealUserMessage(
  db: SessionStoreHandle,
  sessionId: string,
  latestAssistantTimeCreated: unknown,
): boolean {
  if (typeof latestAssistantTimeCreated !== "number") return false;
  const row = db.prepare(NEWER_REAL_USER_SQL).get(sessionId, latestAssistantTimeCreated) as
    | { one?: number }
    | undefined;
  return row?.one === 1;
}

function hasUnfinishedAssistant(db: SessionStoreHandle, sessionId: string): boolean {
  const latest = latestAssistantRow(db, sessionId);
  if (typeof latest?.id !== "string") return false;
  const finish = latest.finish;
  if (typeof finish !== "string" || finish.length === 0) return true;
  return !ZCODE_TERMINAL_FINISHES.has(finish);
}

function hasUnansweredRealUser(db: SessionStoreHandle, sessionId: string): boolean {
  const latest = latestAssistantRow(db, sessionId);
  return hasNewerRealUserMessage(
    db,
    sessionId,
    typeof latest?.timeCreated === "number" ? latest.timeCreated : -1,
  );
}

/** Whether the newest assistant row still waits on a locally executed tool. */
export function assistantAwaitingToolsFromStore(
  db: SessionStoreHandle,
  sessionId: string,
): boolean {
  const latest = latestAssistantRow(db, sessionId);
  if (typeof latest?.id !== "string") return false;
  if (hasNewerRealUserMessage(db, sessionId, latest.timeCreated)) return false;
  if (latest.finish === "tool-calls") return true;
  const rows = db.prepare(TOOL_PARTS_SQL).all(sessionId, latest.id);
  return rows.some((row) => {
    const part = asRecord(asRecord(row)?.data);
    return part?.type === "tool" && part.providerExecuted !== true;
  });
}

/**
 * Whether a no-reply / ignored status notice must be held instead of appended.
 * Ported from `read-session-db.ts:387-395`: a run in flight (awaiting tools or an
 * unfinished assistant) or an unanswered real user prompt must both hold.
 */
export function shouldHoldIgnoredNotificationFromStore(
  db: SessionStoreHandle,
  sessionId: string,
): boolean {
  if (assistantAwaitingToolsFromStore(db, sessionId)) return true;
  if (hasUnfinishedAssistant(db, sessionId)) return true;
  if (hasUnansweredRealUser(db, sessionId)) return true;
  return false;
}

/**
 * The newest persisted row, for last-known-good recovery after a failed
 * transform (`read-session-db.ts:440-472`). ZCode orders by the same
 * `sequence is null, sequence, time_created, rowid` the reader uses.
 */
export function latestPersistedMessageFromStore(
  db: SessionStoreHandle,
  sessionId: string,
): LatestPersistedMessage | null {
  const row = db
    .prepare(
      `SELECT id, data
         FROM message
        WHERE session_id = ?
        ORDER BY sequence is null, sequence DESC, time_created DESC, rowid DESC
        LIMIT 1`,
    )
    .get(sessionId) as { id?: string; data?: string } | undefined;
  if (typeof row?.id !== "string" || typeof row.data !== "string") return null;
  const data = parseJsonRecord(row.data);
  if (!data || typeof data.role !== "string") return null;
  const time = asRecord(data.time);
  return {
    id: row.id,
    role: data.role,
    ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
    ...(typeof time?.completed === "number" ? { completedAt: time.completed } : {}),
    ...(data.error === undefined ? {} : { error: data.error }),
  };
}

/**
 * Wall-clock creation time per message id. Used by temporal awareness to date
 * compartment headings (`read-session-db.ts:575-603`). Missing ids are omitted.
 */
export function getMessageTimesFromStore(
  db: SessionStoreHandle,
  sessionId: string,
  messageIds: readonly string[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (messageIds.length === 0) return result;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, time_created FROM message WHERE session_id = ? AND id IN (${placeholders})`,
    )
    .all(sessionId, ...messageIds) as Array<{ id?: string; time_created?: number }>;
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row.time_created === "number") {
      result.set(row.id, row.time_created);
    }
  }
  return result;
}

/**
 * Provider/model of the newest assistant row, used when the in-memory map is
 * cold (e.g. `/ctx-status` before any transform pass). ZCode stores
 * `providerId`/`modelId` on the row (not nested under `model` as OpenCode v1
 * does), so the JSON paths differ from the source's `queryV1`; null for a
 * session with no assistant turn yet.
 */
export function findLastAssistantModelFromStore(
  db: SessionStoreHandle,
  sessionId: string,
): { providerId: string; modelId: string; agent?: string } | null {
  const row = db
    .prepare(
      `SELECT json_extract(data, '$.providerId') as providerId,
              json_extract(data, '$.modelId') as modelId,
              json_extract(data, '$.agent') as agent
         FROM message
        WHERE session_id = ?
          AND json_extract(data, '$.role') = 'assistant'
          AND json_extract(data, '$.providerId') IS NOT NULL
          AND json_extract(data, '$.modelId') IS NOT NULL
        ORDER BY sequence is null, sequence, time_created, rowid
        LIMIT 1`,
    )
    .get(sessionId) as { providerId?: string; modelId?: string; agent?: string | null } | undefined;
  if (typeof row?.providerId !== "string" || typeof row.modelId !== "string") return null;
  const agent = typeof row.agent === "string" && row.agent.length > 0 ? row.agent : undefined;
  return { providerId: row.providerId, modelId: row.modelId, ...(agent ? { agent } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// facade
// ─────────────────────────────────────────────────────────────────────────────

/** Best-effort turn-state / recovery probes. Every method answers, never throws. */
export interface SessionHistory {
  /** True when this process may read the session store at all. */
  isStoreAvailable(): boolean;
  /** Newest assistant row still waiting on a locally executed tool. */
  assistantAwaitingTools(sessionId: string): boolean;
  /** Hold an ignored/no-reply notice instead of appending it. */
  shouldHoldIgnoredNotification(sessionId: string): boolean;
  /** Newest persisted row, or null when unknown. */
  latestPersistedMessageForRecovery(sessionId: string): LatestPersistedMessage | null;
  /** Creation time per message id; missing ids are omitted. */
  getMessageTimes(sessionId: string, messageIds: readonly string[]): Map<string, number>;
  /** Newest assistant row's provider/model, or null. */
  findLastAssistantModel(
    sessionId: string,
  ): { providerId: string; modelId: string; agent?: string } | null;
}

function defaultStoreExists(deps: SessionHistoryDeps): boolean {
  try {
    deps.openSessionStore();
    return true;
  } catch (error) {
    deps.onProbeFailure?.("session store unavailable", error);
    return false;
  }
}

function probe<T>(
  deps: SessionHistoryDeps,
  label: string,
  run: (db: SessionStoreHandle) => T,
  fallback: T,
): T {
  try {
    return run(deps.openSessionStore());
  } catch (error) {
    deps.onProbeFailure?.(`session-history probe failed: ${label}`, error);
    return fallback;
  }
}

/**
 * Build the facade over an injected store.
 *
 * `MAGIC_CONTEXT_NOTICE_GATE` keeps upstream's test escape hatch
 * (`read-session-db.ts:398-399`): `bypass` forces the notice gate open, `hold`
 * forces it closed.
 */
export function createSessionHistory(deps: SessionHistoryDeps): SessionHistory {
  const exists = deps.sessionStoreExists ?? (() => defaultStoreExists(deps));
  return {
    isStoreAvailable: exists,

    assistantAwaitingTools(sessionId: string): boolean {
      if (!exists()) return false;
      return probe(
        deps,
        "assistantAwaitingTools",
        (db) => assistantAwaitingToolsFromStore(db, sessionId),
        false,
      );
    },

    shouldHoldIgnoredNotification(sessionId: string): boolean {
      const gate = process.env.MAGIC_CONTEXT_NOTICE_GATE?.trim();
      if (gate === "bypass") return false;
      if (gate === "hold") return true;
      if (!exists()) return false;
      return probe(
        deps,
        "shouldHoldIgnoredNotification",
        (db) => shouldHoldIgnoredNotificationFromStore(db, sessionId),
        false,
      );
    },

    latestPersistedMessageForRecovery(sessionId: string): LatestPersistedMessage | null {
      if (!exists()) return null;
      return probe(
        deps,
        "latestPersistedMessageForRecovery",
        (db) => latestPersistedMessageFromStore(db, sessionId),
        null,
      );
    },

    getMessageTimes(sessionId: string, messageIds: readonly string[]): Map<string, number> {
      if (!exists() || messageIds.length === 0) return new Map();
      return probe(
        deps,
        "getMessageTimes",
        (db) => getMessageTimesFromStore(db, sessionId, messageIds),
        new Map(),
      );
    },

    findLastAssistantModel(
      sessionId: string,
    ): { providerId: string; modelId: string; agent?: string } | null {
      if (!exists()) return null;
      return probe(
        deps,
        "findLastAssistantModel",
        (db) => findLastAssistantModelFromStore(db, sessionId),
        null,
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// the ZCode reader: persisted raw-message paging
// ─────────────────────────────────────────────────────────────────────────────

interface StoredMessageRow {
  id?: string;
  time_created?: number;
  time_updated?: number;
  data?: string;
}

interface StoredPartRow {
  message_id?: string;
  data?: string;
}

/**
 * ZCode's canonical row order, one place so paging and full reads cannot drift.
 * Mirrors `adapters/.../repositories/messages.ts:226-233` exactly.
 */
export const ZCODE_MESSAGE_ORDER_SQL = "sequence is null, sequence, time_created, rowid";

/**
 * One bounded page of raw messages.
 *
 * Semantics copied from `readRawSessionMessagePageFromDb`
 * (`read-session-raw.ts:194-271`):
 *   - `afterOrdinal` is only used by the FIRST page of a range; later pages
 *     resume after the `after` anchor, which is what makes a resumed page skip
 *     rows with equal `time_created` correctly.
 *   - `finalWatermark` bounds the walk so a concurrent append cannot make a page
 *     reader loop forever.
 *   - the page size is `min(limit, finalWatermark - afterOrdinal)`.
 *
 * FORK: OpenCode's compaction filter (`summary = 1 AND finish = 'stop'`) is kept.
 * ZCode has no such row today (its compaction boundary is a `compaction` /
 * `timeline` PART, not a summary message), so the predicate is inert here — but
 * it is the port's contract if a summary row is ever written, and dropping it
 * would silently feed historian its own output.
 */
export function readStoredMessagePageFromStore(
  db: SessionStoreHandle,
  args: {
    sessionId: string;
    afterOrdinal: number;
    limit: number;
    finalWatermark?: number;
    after?: RawMessageOrdinalAnchor;
  },
): StoredMessagePage {
  const finalWatermark = Number.isFinite(args.finalWatermark)
    ? Math.floor(args.finalWatermark as number)
    : Number.MAX_SAFE_INTEGER;
  const afterOrdinal = Math.floor(args.afterOrdinal);
  const remaining = Math.max(0, finalWatermark - afterOrdinal);
  const pageSize = Math.min(Math.max(1, Math.floor(args.limit)), remaining);
  if (pageSize === 0) return { messages: [] };

  const params: unknown[] = [args.sessionId];
  let sql = `SELECT id, data, time_created, time_updated FROM message WHERE session_id = ?`;
  if (args.after) {
    params.push(
      args.after.timeCreated,
      args.after.timeCreated,
      args.after.timeCreated,
      args.after.id,
    );
    sql += ` AND time_created >= ? AND (time_created > ? OR (time_created = ? AND id > ?))`;
  }
  sql += ` AND NOT (
      CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
      AND CASE WHEN json_valid(data) = 1 THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop'
    )
    ORDER BY ${ZCODE_MESSAGE_ORDER_SQL}
    LIMIT ?`;
  params.push(pageSize);
  if (!args.after) {
    // Only the FIRST page of a range seeks by ordinal; later pages resume after
    // the `after` anchor, which is what makes them skip equal-time_created rows
    // correctly (mirrors `readRawMessagePageRows`, read-session-raw.ts:246-261).
    sql += ` OFFSET ?`;
    params.push(Math.max(0, afterOrdinal));
  }

  const rows = db.prepare(sql).all(...params) as StoredMessageRow[];
  if (rows.length === 0) return { messages: [] };

  const placeholders = rows.map(() => "?").join(", ");
  const partRows = db
    .prepare(
      `SELECT message_id, data FROM part
        WHERE session_id = ? AND message_id IN (${placeholders})
        ORDER BY message_id, sequence is null, sequence, time_created, id`,
    )
    .all(args.sessionId, ...rows.map((row) => String(row.id))) as StoredPartRow[];

  const partsByMessageId = new Map<string, unknown[]>();
  for (const row of partRows) {
    const messageId = typeof row.message_id === "string" ? row.message_id : null;
    if (messageId === null || typeof row.data !== "string") continue;
    let part: unknown;
    try {
      part = JSON.parse(row.data) as unknown;
    } catch {
      continue;
    }
    const list = partsByMessageId.get(messageId) ?? [];
    list.push(part);
    partsByMessageId.set(messageId, list);
  }

  const messages: RawMessage[] = [];
  rows.forEach((row, index) => {
    if (typeof row.id !== "string") return;
    const info = parseJsonRecord(row.data);
    const time = asRecord(info?.time);
    const projected = projectStoredMessage({
      id: row.id,
      role: typeof info?.role === "string" ? info.role : "unknown",
      parts: partsByMessageId.get(row.id) ?? [],
      sessionId: args.sessionId,
      ...(typeof row.time_created === "number" ? { createdAt: row.time_created } : {}),
      ...(typeof time?.completed === "number" ? { completedAt: time.completed } : {}),
      ...(info?.summary === undefined ? {} : { summary: info.summary === true }),
      ...(info?.finish === undefined ? {} : { finish: String(info.finish) }),
      ...(info?.error === undefined ? {} : { error: info.error }),
    });
    messages.push({
      ordinal: afterOrdinal + index + 1,
      id: row.id,
      role: projected.info.role ?? "unknown",
      parts: projected.parts,
      createdAt: typeof row.time_created === "number" ? row.time_created : null,
      ...(typeof row.time_updated === "number" ? { version: row.time_updated } : {}),
    });
  });
  return { messages };
}

/** Stored row count, compaction summaries included (ordinal drift detection). */
export function getStoredMessageCountFromStore(db: SessionStoreHandle, sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM message WHERE session_id = ?")
    .get(sessionId) as { count?: number } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

/** Primary-key lookup — one index seek instead of a page walk. */
export function readStoredMessageByIdFromStore(
  db: SessionStoreHandle,
  sessionId: string,
  messageId: string,
): RawMessage | null {
  const row = db
    .prepare(
      `SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?`,
    )
    .get(sessionId, messageId) as StoredMessageRow | undefined;
  if (typeof row?.id !== "string") return null;
  const partRows = db.prepare(TOOL_PARTS_SQL).all(sessionId, row.id) as StoredPartRow[];
  const parts: unknown[] = [];
  for (const partRow of partRows) {
    if (typeof partRow.data !== "string") continue;
    try {
      parts.push(JSON.parse(partRow.data) as unknown);
    } catch {
      // A corrupt part blob drops that part, not the message.
    }
  }
  const info = parseJsonRecord(row.data);
  return {
    ordinal: 0,
    id: row.id,
    role: typeof info?.role === "string" ? info.role : "unknown",
    parts,
    createdAt: typeof row.time_created === "number" ? row.time_created : null,
    ...(typeof row.time_updated === "number" ? { version: row.time_updated } : {}),
  };
}

/**
 * Ordinal-only page: ids + timestamps with no parts hydrated. The ordinal space
 * matches `readStoredMessagePageFromStore` (same order, same compaction filter),
 * which is the whole point — a walker must be able to count ordinals without
 * paying for tool outputs.
 */
export function readStoredOrdinalPageFromStore(
  db: SessionStoreHandle,
  sessionId: string,
  after: RawMessageOrdinalAnchor | null,
  limit: number,
): RawMessageOrdinalEntry[] {
  const pageSize = Math.max(1, Math.floor(limit));
  const params: unknown[] = [sessionId];
  let sql = `SELECT id, data, time_created FROM message WHERE session_id = ?`;
  if (after) {
    params.push(after.timeCreated, after.timeCreated, after.timeCreated, after.id);
    sql += ` AND (time_created > ? OR (time_created = ? AND id > ?))`;
  }
  sql += ` ORDER BY time_created, id LIMIT ?`;
  params.push(pageSize);
  const rows = db.prepare(sql).all(...params) as StoredMessageRow[];
  return rows.map((row) => ({
    id: typeof row.id === "string" ? row.id : "",
    timeCreated: typeof row.time_created === "number" ? row.time_created : 0,
    contributesOrdinal: true,
    hasValidInfo: parseJsonRecord(row.data) !== null,
  }));
}

/**
 * The ZCode reader, ready to hand to `createRawMessageProvider`.
 *
 * `sessionId` is bound here so the returned deps object is per-session, exactly
 * like the per-session provider registration it feeds.
 */
export function createZCodeSessionReader(args: {
  sessionId: string;
  openSessionStore: () => SessionStoreHandle;
}): {
  getStoredMessageCount(): number;
  readStoredMessageById(messageId: string): RawMessage | null;
  readStoredOrdinalPage(
    after: RawMessageOrdinalAnchor | null,
    limit: number,
  ): RawMessageOrdinalEntry[];
} {
  const withDb = <T>(run: (db: SessionStoreHandle) => T, fallback: T): T => {
    try {
      return run(args.openSessionStore());
    } catch {
      // A store that cannot be opened reads as an empty session; the provider's
      // own live path still serves the current turn.
      return fallback;
    }
  };
  return {
    getStoredMessageCount: () =>
      withDb((db) => getStoredMessageCountFromStore(db, args.sessionId), 0),
    readStoredMessageById: (messageId: string) =>
      withDb((db) => readStoredMessageByIdFromStore(db, args.sessionId, messageId), null),
    readStoredOrdinalPage: (after, limit) =>
      withDb((db) => readStoredOrdinalPageFromStore(db, args.sessionId, after, limit), []),
  };
}

/** Re-exported so the provider's deps type stays in one import site. */
export type { StoredMessagePage };
