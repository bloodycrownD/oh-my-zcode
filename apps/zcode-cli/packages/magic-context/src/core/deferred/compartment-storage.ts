// FORK-DEFERRED(S20): `features/magic-context/compartment-storage.ts` 的 Compartment/CompartmentInput/SessionFact/CompartmentDateRanges 类型与 escapeXmlAttr/escapeXmlContent/getCompartments/getLastCompartmentEndMessage/getLastCompartmentEndMessageId/isPartialCompartmentEnd/buildCompartmentBlock/appendCompartments 摘录，Step 20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The C group (Step 20) owns the compartment
// family. Upstream `compartment-storage.ts` is 893 lines and reaches the
// historian, the compaction lease, the compression-depth store, the M0 mutation
// log and the embed-drain state; porting it now would drag the whole historian
// closure into the package. What the B group (already ported) actually reaches is
// seven pure/SQL statements over the `compartments` + `session_facts` tables —
// both of which the A group's `storage-db.ts` already creates (lines 1190 and
// 1278). Those are reproduced here verbatim so the b3/b4 call sites type-check and
// behave identically against a real database.
//
// NOT reproduced (each needs C-group machinery and nothing in the fork calls it):
// replaceAllCompartmentState, replaceSessionFacts, saveRecompStagingPass,
// getRecompStaging, the `recomp_*` staging tables, and the historian-owned lease
// and M0 mutation side effects. `appendCompartments` therefore keeps its upstream
// shape but drops the `queueM0Mutation` / `invalidateAutoEmbedSession` calls that
// guard the historian's recomp publish path — the fork has no historian, so there
// is no publish whose mutation log or embed drain could go stale.
//
// Step 20: delete this file and repoint `compartment-trigger.ts`,
// `inject-compartments.ts`, `persist-filtered-noise.ts`,
// `protected-tail-boundary.ts`, `project-docs-hash.ts`, `transform.ts` and
// `transform-compartment-phase.ts` back at
// `../../features/magic-context/compartment-storage.js`.

import { isNoContentCompartment } from "../features/magic-context/no-content-compartment.js";
import { getHarness } from "../shared/harness.js";
import type { Database, Statement as PreparedStatement } from "../shared/sqlite.js";

const insertCompartmentStatements = new WeakMap<Database, PreparedStatement>();
const insertFactStatements = new WeakMap<Database, PreparedStatement>();

function getInsertCompartmentStatement(db: Database): PreparedStatement {
    let stmt = insertCompartmentStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness, start_block_index, end_block_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertCompartmentStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertFactStatement(db: Database): PreparedStatement {
    let stmt = insertFactStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
        );
        insertFactStatements.set(db, stmt);
    }
    return stmt;
}

/** Verbatim: `compartment-storage.ts:37-71`. */
export interface Compartment {
    id: number;
    sessionId: string;
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    /** NULL/absent covers a whole message; an indexed end keeps that message raw to preserve later blocks. */
    startBlockIndex?: number | null;
    endBlockIndex?: number | null;
    title: string;
    /** v2: P1 tier text (fullest). Legacy rows: flat v1 content. Always present (NOT NULL). */
    content: string;
    /** v2 paraphrase tiers (model B). NULL for legacy=1 rows. */
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    /** Decay-rate signal (1-100). Defaults to 50. */
    importance: number;
    /** Comma-separated activity types (e.g. "design,feature"). NULL for legacy rows. */
    episodeType: string | null;
    /** 1 = pre-v2 flat compartment (no tiers); 0 = v2 tiered. */
    legacy: number;
    createdAt: number;
    /**
     * `unresolved` when the store-projection rebase could not re-derive this
     * compartment's ordinals, because the message its endpoint id names does not
     * exist in the projection the running host serves. Such a row keeps its
     * summary text (readable by id) but is excluded from anything that treats
     * its ordinals as positions: range recovery, injection, and the boundary.
     * Re-evaluated on every later projection change, so an endpoint that comes
     * back returns the row to `ok`.
     */
    rebaseStatus: "ok" | "unresolved";
}

/** Verbatim: `compartment-storage.ts:75-82`. */
export interface SessionFact {
    id: number;
    sessionId: string;
    category: string;
    content: string;
    createdAt: number;
    updatedAt: number;
}

/** Verbatim: `compartment-storage.ts:167-183`. */
export interface CompartmentInput {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    /** NULL/absent covers a whole message; an indexed end keeps that message raw to preserve later blocks. */
    startBlockIndex?: number | null;
    endBlockIndex?: number | null;
    title: string;
    /** v2: P1 tier text. Legacy/compressor inserts: flat content. */
    content: string;
    /** v2 paraphrase tiers (model B). Omitted/null for legacy or compressor inserts — stored NULL. */
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    /** v2: decay-rate signal (1-100). Omitted — stored 50. */
    importance?: number | null;
    /** v2: comma-separated activity types. Omitted/null — stored NULL. */
    episodeType?: string | null;
}

interface CompartmentRow {
    id: number;
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    start_block_index?: number | null;
    end_block_index?: number | null;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    legacy: number | null;
    created_at: number;
    rebase_status?: string | null;
}

interface SessionFactRow {
    id: number;
    session_id: string;
    category: string;
    content: string;
    created_at: number;
    updated_at: number;
}

function isStringOrNullish(v: unknown): v is string | null | undefined {
    return v === null || v === undefined || typeof v === "string";
}

function isNumberOrNullish(v: unknown): v is number | null | undefined {
    return v === null || v === undefined || typeof v === "number";
}

function isCompartmentRow(row: unknown): row is CompartmentRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number" &&
        typeof candidate.start_message_id === "string" &&
        typeof candidate.end_message_id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.content === "string" &&
        // v2 tier columns are nullable (legacy rows store NULL). Tolerate absence
        // so a row is never rejected just for missing/null tier metadata.
        isStringOrNullish(candidate.p1) &&
        isStringOrNullish(candidate.p2) &&
        isStringOrNullish(candidate.p3) &&
        isStringOrNullish(candidate.p4) &&
        isNumberOrNullish(candidate.importance) &&
        isStringOrNullish(candidate.episode_type) &&
        isNumberOrNullish(candidate.legacy) &&
        typeof candidate.created_at === "number"
    );
}

function isSessionFactRow(row: unknown): row is SessionFactRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.category === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.created_at === "number" &&
        typeof candidate.updated_at === "number"
    );
}

function toCompartment(row: CompartmentRow): Compartment {
    return {
        id: row.id,
        sessionId: row.session_id,
        sequence: row.sequence,
        startMessage: row.start_message,
        endMessage: row.end_message,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        ...(row.start_block_index != null ? { startBlockIndex: row.start_block_index } : {}),
        ...(row.end_block_index != null ? { endBlockIndex: row.end_block_index } : {}),
        title: row.title,
        content: row.content,
        p1: row.p1 ?? null,
        p2: row.p2 ?? null,
        p3: row.p3 ?? null,
        p4: row.p4 ?? null,
        importance: typeof row.importance === "number" ? row.importance : 50,
        episodeType: row.episode_type ?? null,
        legacy: typeof row.legacy === "number" ? row.legacy : 0,
        createdAt: row.created_at,
        rebaseStatus: row.rebase_status === "unresolved" ? "unresolved" : "ok",
    };
}

function toSessionFact(row: SessionFactRow): SessionFact {
    return {
        id: row.id,
        sessionId: row.session_id,
        category: row.category,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Verbatim: `compartment-storage.ts:270-282`. */
export function getCompartments(db: Database, sessionId: string): Compartment[] {
    const rows = db
        // Audit note: SELECT * is intentional — the compartments table is owned by this plugin, columns are
        // validated by isCompartmentRow(), and all columns are needed for rendering and validation.
        .prepare("SELECT * FROM compartments WHERE session_id = ? ORDER BY sequence ASC")
        .all(sessionId)
        .filter(isCompartmentRow);
    return rows.map(toCompartment);
}

/**
 * Highest message ordinal any compartment covers — the line between compacted
 * history and the live tail.
 *
 * Rows the projection rebase could not re-derive are excluded: their stored
 * ordinals are positions in a message list the running host no longer serves,
 * so using one as the boundary would clamp recovery ranges and the protected
 * tail against an arbitrary message. Excluding them moves the boundary back to
 * the newest compartment that still resolves, which is recoverable, instead of
 * pointing confidently at the wrong place.
 *
 * Verbatim: `compartment-storage.ts:291-303`.
 */
export function getLastCompartmentEndMessage(db: Database, sessionId: string): number {
    const row = db
        .prepare(
            "SELECT MAX(end_message) as max_end FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved'",
        )
        .get(sessionId) as { max_end: number | null } | null;
    return row?.max_end ?? -1;
}

/**
 * The OpenCode message id at the boundary of the highest-sequence compartment —
 * i.e. the last raw message the compartment history (m[0]+m[1]) covers. A newer
 * compartment with no stored end id (a legacy row, or one carried into a forked
 * session) cannot be placed, so the boundary is the newest compartment that has
 * one: everything up to it is covered, and the rows after it stay raw. Returns
 * null when no compartment has an end id. Used to persist the m[1]-coverage boundary so a cold post-
 * restart pass trims the live tail to what the cached summary actually covers,
 * not to the latest compartment (which may be newer than the cached m[1]).
 *
 * Verbatim: `compartment-storage.ts:310-318`.
 */
export function getLastCompartmentEndMessageId(db: Database, sessionId: string): string | null {
    const row = db
        .prepare(
            "SELECT end_message_id FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved' AND end_message_id IS NOT NULL AND end_message_id != '' ORDER BY sequence DESC LIMIT 1",
        )
        .get(sessionId) as { end_message_id: string | null } | undefined;
    const id = row?.end_message_id;
    return id && id.length > 0 ? id : null;
}

/** Verbatim: `compartment-storage.ts:880-889`. */
export function isPartialCompartmentEnd(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    return Boolean(
        db
            .prepare(
                "SELECT 1 FROM compartments WHERE session_id=? AND end_message_id=? AND end_block_index IS NOT NULL LIMIT 1",
            )
            .get(sessionId, messageId),
    );
}

function insertCompartmentRows(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    now: number,
): void {
    const stmt = getInsertCompartmentStatement(db);
    for (const compartment of compartments) {
        // A compartment is v2 (legacy=0) iff it carries at least the P1 tier.
        // Compressor/legacy inserts pass no tiers — stored NULL + legacy=1.
        const hasTiers = typeof compartment.p1 === "string" && compartment.p1.length > 0;
        stmt.run(
            sessionId,
            compartment.sequence,
            compartment.startMessage,
            compartment.endMessage,
            compartment.startMessageId,
            compartment.endMessageId,
            compartment.title,
            compartment.content,
            compartment.p1 ?? null,
            compartment.p2 ?? null,
            compartment.p3 ?? null,
            compartment.p4 ?? null,
            typeof compartment.importance === "number" ? compartment.importance : 50,
            compartment.episodeType ?? null,
            hasTiers || isNoContentCompartment(compartment) ? 0 : 1,
            now,
            getHarness(),
            compartment.startBlockIndex ?? null,
            compartment.endBlockIndex ?? null,
        );
    }
}

function insertFactRows(
    db: Database,
    sessionId: string,
    facts: Array<{ category: string; content: string }>,
    now: number,
): void {
    const stmt = getInsertFactStatement(db);
    for (const fact of facts) {
        stmt.run(sessionId, fact.category, fact.content, now, now, getHarness());
    }
}

/**
 * Append new compartments without deleting existing ones.
 * Used by the incremental runner where existing compartments are preserved
 * and only new compartments for the latest chunk are added.
 *
 * Verbatim: `compartment-storage.ts:370-380`, minus the trailing
 * `invalidateAutoEmbedSession(sessionId)` (no embed drain in this fork).
 */
export function appendCompartments(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
): void {
    if (compartments.length === 0) return;
    const now = Date.now();
    db.transaction(() => {
        insertCompartmentRows(db, sessionId, compartments, now);
    }).immediate();
}

/** Verbatim: `compartment-storage.ts:852-864`. */
export function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** Verbatim: `compartment-storage.ts:866-868`. */
export function escapeXmlContent(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Verbatim: `compartment-storage.ts:494-497`. */
export interface CompartmentDateRanges {
    /** Map compartment id → `{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }` */
    byId: Map<number, { start: string; end: string }>;
}

/** Verbatim: `compartment-storage.ts:499-543`. */
export function buildCompartmentBlock(
    compartments: Compartment[],
    facts: SessionFact[],
    memoryBlock?: string,
    dateRanges?: CompartmentDateRanges,
): string {
    const lines: string[] = [];

    if (memoryBlock) {
        lines.push(memoryBlock);
        lines.push("");
    }

    for (const c of compartments) {
        if (isNoContentCompartment(c)) continue;
        const dates = dateRanges?.byId.get(c.id);
        const dateAttr = dates ? ` start-date="${dates.start}" end-date="${dates.end}"` : "";
        lines.push(
            `<compartment start="${c.startMessage}" end="${c.endMessage}"${dateAttr} title="${escapeXmlAttr(c.title)}">`,
        );
        lines.push(escapeXmlContent(c.content));
        lines.push("</compartment>");
        lines.push("");
    }

    const factsByCategory = new Map<string, string[]>();
    for (const f of facts) {
        const existing = factsByCategory.get(f.category) ?? [];
        existing.push(f.content);
        factsByCategory.set(f.category, existing);
    }

    for (const [category, items] of factsByCategory) {
        lines.push(`${category}:`);
        for (const item of items) {
            lines.push(`* ${escapeXmlContent(item)}`);
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

/** Verbatim: `compartment-storage.ts:390-400`. */
export function getSessionFacts(db: Database, sessionId: string): SessionFact[] {
    const rows = db
        .prepare("SELECT * FROM session_facts WHERE session_id = ? ORDER BY category ASC, id ASC")
        .all(sessionId)
        .filter(isSessionFactRow);
    return rows.map(toSessionFact);
}