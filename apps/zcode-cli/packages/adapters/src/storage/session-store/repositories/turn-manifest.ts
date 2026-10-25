import type { DatabaseSync } from "node:sqlite";
import type {
  SessionId,
  TurnManifestBranchRewriteInput,
  TurnManifestBranchRewriteResult,
  TurnManifestQueryRecord,
  TurnManifestReadInput,
  TurnManifestReadResult,
  TurnManifestSnapshot,
  TurnManifestTurnRecord,
  TurnManifestWrite,
} from "@zcode/contracts";
import { decodeJson, encodeJson } from "../json.js";
import type { TurnManifestRow, TurnQueryManifestRow } from "../rows.js";

/**
 * turn 行清单仓储（`session_turn_manifest` + `session_turn_query_manifest`）。
 *
 * 唯一职责是持久与回读**行事实**，不解释投影规则：
 * - `row_count` 是活投影终态的行数（`row_count_source='live'`）或冷物化回写的行数
 *   （`'cold'`），仓储只存不算；
 * - `rowId` 不落库（base = 1 + Σ 前序 rowCount，由读方累加），所以 rewind 复制前缀时
 *   不需要重算；
 * - 账目修正只改不一致的 `row_count`，不读 message/part 正文。
 */

function decodeMessageIds(value: string): string[] {
  const parsed = decodeJson<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === "string");
}

function toTurnRecord(row: TurnManifestRow): TurnManifestTurnRecord {
  return {
    turnId: row.turn_id,
    ordinal: row.ordinal,
    messageIds: decodeMessageIds(row.message_ids_json),
    firstMessageId: row.first_message_id as TurnManifestTurnRecord["firstMessageId"],
    lastMessageId: row.last_message_id as TurnManifestTurnRecord["lastMessageId"],
    rowCount: row.row_count,
    rowCountSource: row.row_count_source,
    projectionSchemaVersion: row.projection_schema_version,
  };
}

function toQueryRecord(row: TurnQueryManifestRow): TurnManifestQueryRecord {
  return {
    turnId: row.turn_id,
    queryOrdinalInTurn: row.query_ordinal_in_turn,
    queryMessageId: row.query_message_id as TurnManifestQueryRecord["queryMessageId"],
    queryRowId: row.query_row_id,
    rowCount: row.row_count,
    queryPreview: row.query_preview,
    assistantPreview: row.assistant_preview,
    assistantPreviewKind: row.assistant_preview_kind,
  };
}

function insertTurnRow(
  db: DatabaseSync,
  sessionID: SessionId,
  branchGeneration: number,
  turn: TurnManifestTurnRecord,
  now: number,
): void {
  // 同一 ordinal 上若还留着**另一个** turn，它就是被 rewind 截掉的分支残留：
  // 投影是 ordinal 的权威，先逐出它（连同其 query 行）再写入，避免主键撞车。
  const evicted = db
    .prepare(
      `select turn_id from session_turn_manifest
        where session_id = ? and branch_generation = ? and ordinal = ? and turn_id <> ?`,
    )
    .get(sessionID, branchGeneration, turn.ordinal, turn.turnId) as { turn_id: string } | undefined;
  if (evicted) {
    db.prepare(
      `delete from session_turn_query_manifest
        where session_id = ? and branch_generation = ? and turn_id = ?`,
    ).run(sessionID, branchGeneration, evicted.turn_id);
    db.prepare(
      `delete from session_turn_manifest
        where session_id = ? and branch_generation = ? and turn_id = ?`,
    ).run(sessionID, branchGeneration, evicted.turn_id);
  }
  db.prepare(
    `insert into session_turn_manifest (
        session_id, branch_generation, ordinal, turn_id,
        first_message_id, last_message_id, message_ids_json,
        row_count, row_count_source, projection_schema_version,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(session_id, branch_generation, turn_id) do update set
        ordinal = excluded.ordinal,
        first_message_id = excluded.first_message_id,
        last_message_id = excluded.last_message_id,
        message_ids_json = excluded.message_ids_json,
        row_count = excluded.row_count,
        row_count_source = excluded.row_count_source,
        projection_schema_version = excluded.projection_schema_version,
        time_updated = excluded.time_updated`,
  ).run(
    sessionID,
    branchGeneration,
    turn.ordinal,
    turn.turnId,
    turn.firstMessageId,
    turn.lastMessageId,
    encodeJson(turn.messageIds) ?? "[]",
    turn.rowCount,
    turn.rowCountSource,
    turn.projectionSchemaVersion,
    now,
    now,
  );
}

function insertQueryRow(
  db: DatabaseSync,
  sessionID: SessionId,
  branchGeneration: number,
  query: TurnManifestQueryRecord,
  now: number,
): void {
  db.prepare(
    `insert into session_turn_query_manifest (
        session_id, branch_generation, turn_id, query_ordinal_in_turn,
        query_message_id, query_row_id, row_count,
        query_preview, assistant_preview, assistant_preview_kind,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionID,
    branchGeneration,
    query.turnId,
    query.queryOrdinalInTurn,
    query.queryMessageId,
    query.queryRowId,
    query.rowCount,
    query.queryPreview,
    query.assistantPreview,
    query.assistantPreviewKind,
    now,
    now,
  );
}

function deleteGeneration(db: DatabaseSync, sessionID: SessionId, branchGeneration: number): void {
  db.prepare(
    "delete from session_turn_query_manifest where session_id = ? and branch_generation = ?",
  ).run(sessionID, branchGeneration);
  db.prepare(
    "delete from session_turn_manifest where session_id = ? and branch_generation = ?",
  ).run(sessionID, branchGeneration);
}

function resetGeneration(
  db: DatabaseSync,
  sessionID: SessionId,
  branchGeneration: number,
  turns: readonly TurnManifestTurnRecord[],
  queriesByTurn: ReadonlyMap<string, TurnManifestQueryRecord[]>,
  now: number,
): void {
  deleteGeneration(db, sessionID, branchGeneration);
  turns.forEach((turn, index) => {
    insertTurnRow(db, sessionID, branchGeneration, { ...turn, ordinal: index }, now);
    for (const query of queriesByTurn.get(turn.turnId) ?? []) {
      insertQueryRow(db, sessionID, branchGeneration, query, now);
    }
  });
}

/**
 * 整 turn 替换写入：turn 行 upsert + 该 turn 的 query 行整批替换。
 *
 * 幂等但不是合并——同一 turn 的 query 集合可能变少（steer 被回滚），增量合并会留下幽灵条目。
 * 写入点只有活投影终态（`onTurnComplete` / `onTurnError`）与冷物化回写。
 */
export async function upsertTurnManifest(
  db: DatabaseSync,
  input: TurnManifestWrite,
): Promise<void> {
  const now = Date.now();
  db.exec("begin immediate");
  try {
    insertTurnRow(db, input.sessionID, input.branchGeneration, input.turn, now);
    db.prepare(
      `delete from session_turn_query_manifest
        where session_id = ? and branch_generation = ? and turn_id = ?`,
    ).run(input.sessionID, input.branchGeneration, input.turn.turnId);
    for (const query of input.queries) {
      insertQueryRow(db, input.sessionID, input.branchGeneration, query, now);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * rewind 的分支重写：把保留前缀搬到目标代次（同代次则原地过滤），ordinals 按
 * `keptTurnIds` 的给定顺序重建，`row_count` 一律不重算。
 *
 * 源代次缺任何一个保留 turn → 不写目标代次并回报 `sourceIncomplete`。这是刻意的：
 * 老会话/代次不匹配时 manifest 本来就不完整，写一个「少几轮」的新代次会让读端
 * 把缺行当成真实全序（totalCount 偏小、rowId base 整体前移），比走降级全量物化更糟。
 * 成功后清掉更早代次——它们不可达（读端只按当前代次读，缺失即降级重建）。
 */
export async function rewriteTurnManifestBranch(
  db: DatabaseSync,
  input: TurnManifestBranchRewriteInput,
): Promise<TurnManifestBranchRewriteResult> {
  const now = Date.now();
  const sourceRows = db
    .prepare(
      `select * from session_turn_manifest
        where session_id = ? and branch_generation = ?
        order by ordinal asc`,
    )
    .all(input.sessionID, input.sourceGeneration) as unknown as TurnManifestRow[];
  const sourceByTurnId = new Map(sourceRows.map((row) => [row.turn_id, row]));
  const missingTurnIds = input.keptTurnIds.filter((turnId) => !sourceByTurnId.has(turnId));
  if (missingTurnIds.length > 0) {
    // 目标代次不能留半份：删干净，读端按 missing 降级。
    db.exec("begin immediate");
    try {
      deleteGeneration(db, input.sessionID, input.branchGeneration);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    return { applied: false, reason: "sourceIncomplete", missingTurnIds };
  }

  const keptTurns = input.keptTurnIds.map((turnId) => toTurnRecord(sourceByTurnId.get(turnId)!));
  const queriesByTurn = new Map<string, TurnManifestQueryRecord[]>();
  if (keptTurns.length > 0) {
    const queryRows = db
      .prepare(
        `select * from session_turn_query_manifest
          where session_id = ? and branch_generation = ?`,
      )
      .all(input.sessionID, input.sourceGeneration) as unknown as TurnQueryManifestRow[];
    const turnOrdinal = new Map(keptTurns.map((turn) => [turn.turnId, turn.ordinal]));
    for (const row of queryRows) {
      if (!turnOrdinal.has(row.turn_id)) continue;
      const list = queriesByTurn.get(row.turn_id) ?? [];
      list.push(toQueryRecord(row));
      queriesByTurn.set(row.turn_id, list);
    }
    for (const list of queriesByTurn.values()) {
      list.sort((left, right) => left.queryOrdinalInTurn - right.queryOrdinalInTurn);
    }
  }

  db.exec("begin immediate");
  try {
    resetGeneration(db, input.sessionID, input.branchGeneration, keptTurns, queriesByTurn, now);
    db.prepare(
      `delete from session_turn_query_manifest
        where session_id = ? and branch_generation < ?`,
    ).run(input.sessionID, input.branchGeneration);
    db.prepare(
      "delete from session_turn_manifest where session_id = ? and branch_generation < ?",
    ).run(input.sessionID, input.branchGeneration);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return { applied: true, keptTurnCount: keptTurns.length };
}

/**
 * 读取一个代次的行清单。
 *
 * - 该代次没有行 → `missing`（与「空 active 分支」同义：读端降级全量物化，空分支的
 *   全量物化本来就是一次空读）；
 * - `projection_schema_version` 不一致 → `schemaMismatch`（必须整表重建，否则 rowId 整体漂移）；
 * - 清单本身缺项/指向不存在的消息 → `inconsistent`（整表重建，**不做**账目修正）：
 *   - `ordinalGap`：登记行 ordinal 出现空洞 = 中间某轮从未登记；
 *   - `unregisteredTurns`：调用方给出的权威 turn 里有未登记的（尾部丢失只能靠它抓——
 *     消息索引没有 turn 维度）；
 *   - `messageIndexMismatch`：manifest 的 messageId 不在消息索引里（消息被删/换库）。
 * - `observedRowCounts` 给出时做账目修正：只改不一致的 `row_count` 并置 `manifestAdjusted`，
 *   后续 turn 的 base 因累加而自动平移，不重读正文。
 */
export async function readTurnManifest(
  db: DatabaseSync,
  input: TurnManifestReadInput,
): Promise<TurnManifestReadResult> {
  db.exec("begin immediate");
  try {
    const rows = db
      .prepare(
        `select * from session_turn_manifest
          where session_id = ? and branch_generation = ?
          order by ordinal asc`,
      )
      .all(input.sessionID, input.branchGeneration) as unknown as TurnManifestRow[];
    if (rows.length === 0) {
      db.exec("commit");
      return { status: "missing" };
    }
    const foundVersions = [...new Set(rows.map((row) => row.projection_schema_version))];
    if (foundVersions.some((version) => version !== input.expectedProjectionSchemaVersion)) {
      db.exec("commit");
      return {
        status: "schemaMismatch",
        expectedVersion: input.expectedProjectionSchemaVersion,
        foundVersions,
      };
    }

    // 清单缺项优先于账目修正：修正只处理「已登记 turn 的行数偏差」，补不了缺的 turn。
    // ordinal 是写入口按投影给的连续序号（rewind 重写时按 keptTurnIds 重排），
    // 出现空洞只可能是 detached 写入丢失 —— 那正是「有 turn 从未登记」。
    const ordinalGap = rows.some((row, index) => row.ordinal !== index);
    if (ordinalGap) {
      db.exec("commit");
      return { status: "inconsistent", reason: "ordinalGap", turnIds: [], missingMessageIds: [] };
    }
    if (input.observedTurnIds && input.observedTurnIds.length > 0) {
      const registered = new Set(rows.map((row) => row.turn_id));
      const unregistered = [...new Set(input.observedTurnIds)].filter(
        (turnId) => !registered.has(turnId),
      );
      if (unregistered.length > 0) {
        db.exec("commit");
        return {
          status: "inconsistent",
          reason: "unregisteredTurns",
          turnIds: unregistered,
          missingMessageIds: [],
        };
      }
    }
    if (input.observedMessageIds) {
      const indexed = new Set<string>(input.observedMessageIds);
      const missing: string[] = [];
      for (const row of rows) {
        for (const messageId of decodeMessageIds(row.message_ids_json)) {
          if (!indexed.has(messageId)) missing.push(messageId);
        }
      }
      if (missing.length > 0) {
        db.exec("commit");
        return {
          status: "inconsistent",
          reason: "messageIndexMismatch",
          turnIds: [],
          // 只留前 20 条：这是诊断信息，不是清单（拉全量会把日志打爆）。
          missingMessageIds: [...new Set(missing)].slice(0, 20),
        };
      }
    }

    const adjustedTurnIds: string[] = [];
    const observed = input.observedRowCounts;
    if (observed && observed.size > 0) {
      const update = db.prepare(
        `update session_turn_manifest
            set row_count = ?, time_updated = ?
          where session_id = ? and branch_generation = ? and turn_id = ?`,
      );
      const now = Date.now();
      for (const row of rows) {
        const observedCount = observed.get(row.turn_id);
        if (observedCount === undefined || observedCount === row.row_count) continue;
        update.run(observedCount, now, input.sessionID, input.branchGeneration, row.turn_id);
        row.row_count = observedCount;
        adjustedTurnIds.push(row.turn_id);
      }
    }

    const turns = rows.map(toTurnRecord);
    const turnOrdinal = new Map(turns.map((turn) => [turn.turnId, turn.ordinal]));
    const queries = (
      db
        .prepare(
          `select * from session_turn_query_manifest
            where session_id = ? and branch_generation = ?`,
        )
        .all(input.sessionID, input.branchGeneration) as unknown as TurnQueryManifestRow[]
    )
      .filter((row) => turnOrdinal.has(row.turn_id))
      .map(toQueryRecord)
      // 目录顺序 = turn 顺序 + turn 内 query 顺序；不依赖 queryRowId（rewind 后 base 会复用）。
      .sort(
        (left, right) =>
          (turnOrdinal.get(left.turnId) ?? 0) - (turnOrdinal.get(right.turnId) ?? 0) ||
          left.queryOrdinalInTurn - right.queryOrdinalInTurn,
      );
    db.exec("commit");

    return {
      status: "ok",
      snapshot: {
        branchGeneration: input.branchGeneration,
        turns,
        queries,
        ...deriveTurnManifestTotals(turns, queries),
        manifestAdjusted: adjustedTurnIds.length > 0,
        adjustedTurnIds,
      },
    };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * 全序计数的唯一派生口径（`Σ row_count` / `firstRowId` / `realUserQueryTotal`）。
 *
 * 空 active 分支必须得到 `totalCount = 0` + `firstRowId = null`，**不是** `firstRowId = 1`：
 * `snapshot.ts` 的 totalCount 不可空、firstRowId 可空，publisher 的
 * `totalCount=0 / firstRowId=null` 契约与 `apply.test.ts` 都按这一对判「已到顶」。
 * 冷开降级全量物化（重建 manifest 之前）也走同一函数，两条路径才不会对「空分支」给出
 * 两个答案。
 */
export function deriveTurnManifestTotals(
  turns: readonly TurnManifestTurnRecord[],
  queries: readonly TurnManifestQueryRecord[],
): Pick<TurnManifestSnapshot, "totalCount" | "firstRowId" | "realUserQueryTotal"> {
  return {
    totalCount: turns.reduce((sum, turn) => sum + turn.rowCount, 0),
    // rowId base 恒从 1 起（base = 1 + Σ 前序 active turn 的 rowCount）。
    firstRowId: turns.some((turn) => turn.rowCount > 0) ? 1 : null,
    realUserQueryTotal: queries.length,
  };
}
