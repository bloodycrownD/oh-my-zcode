#!/usr/bin/env node
/**
 * Step 2 / phase-row-manifest —— turn 行清单仓储的自动化验证。
 *
 * ============================================================================
 * 这一步新出现的失效面
 * ============================================================================
 * manifest 是「全序计数」的唯一权威，它的错误不是崩溃而是**静默错位**：
 *
 *   A. **单调性**：同一 turn 的 query 集合会被整批替换（steer 被回滚后条目要少），
 *      增量合并会留下幽灵目录条目。
 *   B. **代次**：rewind 把保留前缀复制到新代次，row_count 一律不重算（重算 = 重读正文）。
 *      源代次缺行时**不能**写一个「少几轮」的新代次——那会让读取方把缺行当成真实全序
 *      （totalCount 偏小、rowId base 整体前移），比降级全量物化更糟。
 *   C. **账目修正**：已物化窗口给出的真实行数与 manifest 不一致时只改 row_count，
 *       后续 turn 的 base 因累加自动平移；重复修正必须幂等（第二次 adjusted=false）。
 *   D. **空分支**：totalCount=0 / firstRowId=null，不是 firstRowId=1。
 *   E. **版本**：projection_schema_version 不一致必须能被读出来（整表重建的前提）。
 *   F. **清单缺项**（Step 3）：ordinal 空洞 / 有 turn 未登记 / manifest 指向索引里不存在的
 *      消息 → 一律 `inconsistent` 走整表重建。这三种都**不能**用账目修正糊过去：修正只改
 *      「已登记 turn 的行数」，补不了缺的 turn 或错的分支——糊过去的结果是 totalCount
 *      偏小 / rowId base 整体前移（静默错位，不是报错）。
 *
 * 运行方式：`node --import tsx --test scripts/test-turn-manifest-store.mjs`
 * （走 tsx 因为被测代码是 `src/` 的 TypeScript；仓储本身只依赖 node:sqlite 与本地模块。）
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const { SQLITE_MIGRATIONS } = await import(
  new URL("../src/storage/session-store/migrations.ts", import.meta.url).href
);
const {
  deriveTurnManifestTotals,
  readTurnManifest,
  rewriteTurnManifestBranch,
  upsertTurnManifest,
} = await import(
  new URL("../src/storage/session-store/repositories/turn-manifest.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 2 turn manifest store (phase-row-manifest)"
      : `TEST FAIL — Step 2 turn manifest store (exit code ${code})`,
  );
});

const SESSION = "ses_manifest_store";
const VERSION = 1;

/** 跑完整迁移链的 :memory: 库（顺带验证 0023 已登记进 SQLITE_MIGRATIONS）。 */
function migratedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  // runner 会先建账本再逐条执行；0022 在 SQL 里 JOIN 了 schema_migration，缺它必然报错。
  db.exec(`create table if not exists schema_migration (
    id text primary key, checksum text not null, app_version text, time_applied integer not null
  )`);
  for (const migration of SQLITE_MIGRATIONS) db.exec(migration.sql);
  return db;
}

function emptyDb() {
  // 只重建两张表：验证仓储行为时不必背整条迁移链的开销。
  const db = new DatabaseSync(":memory:");
  const migration = SQLITE_MIGRATIONS.find((item) => item.id === "0023_session_turn_manifest");
  assert.ok(migration, "0023_session_turn_manifest 必须登记进 SQLITE_MIGRATIONS");
  db.exec(migration.sql);
  return db;
}

function turn(turnId, ordinal, rowCount, extra = {}) {
  return {
    turnId,
    ordinal,
    messageIds: [`${turnId}-m1`, `${turnId}-m2`],
    firstMessageId: `${turnId}-m1`,
    lastMessageId: `${turnId}-m2`,
    rowCount,
    rowCountSource: "live",
    projectionSchemaVersion: VERSION,
    ...extra,
  };
}

function query(turnId, ordinal, rowId, rowCount, extra = {}) {
  return {
    turnId,
    queryOrdinalInTurn: ordinal,
    queryMessageId: ordinal === 0 ? `${turnId}-q` : null,
    queryRowId: rowId,
    rowCount,
    queryPreview: `${turnId} query ${ordinal}`,
    assistantPreview: `${turnId} answer`,
    assistantPreviewKind: "text",
    ...extra,
  };
}

async function seedThreeTurns(db) {
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turn("t1", 0, 3),
    queries: [query("t1", 0, 2, 2)],
  });
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turn("t2", 1, 5),
    queries: [query("t2", 0, 11, 2), query("t2", 1, 14, 3)],
  });
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turn("t3", 2, 4),
    queries: [query("t3", 0, 21, 1)],
  });
}

// ── A: 迁移与表形状 ─────────────────────────────────────────────────────────

test("A1: 0023 建出两张表，且完整迁移链可以一次跑通", () => {
  const db = migratedDb();
  const tables = db
    .prepare("select name from sqlite_master where type = 'table' and name like 'session_turn%'")
    .all()
    .map((row) => row.name)
    .sort();
  assert.deepEqual(tables, ["session_turn_manifest", "session_turn_query_manifest"]);
  const indexes = db
    .prepare(
      "select name from sqlite_master where type = 'index' and name like 'session_turn%' order by name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(indexes, [
    "session_turn_manifest_session_idx",
    "session_turn_query_manifest_row_idx",
    "session_turn_query_manifest_turn_idx",
  ]);
  db.close();
});

// ── B: 写入 → 读取 ──────────────────────────────────────────────────────────

test("B1: 三轮写入后 totalCount / firstRowId / realUserQueryTotal 与行事实一致", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);

  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.equal(result.status, "ok");
  const { snapshot } = result;
  assert.equal(snapshot.totalCount, 3 + 5 + 4);
  assert.equal(snapshot.firstRowId, 1, "rowId base 从 1 起");
  assert.equal(snapshot.realUserQueryTotal, 4, "同一 turn 的两条 steer 各自成条");
  assert.deepEqual(
    snapshot.turns.map((item) => [item.turnId, item.ordinal, item.rowCount]),
    [
      ["t1", 0, 3],
      ["t2", 1, 5],
      ["t3", 2, 4],
    ],
  );
  assert.deepEqual(snapshot.turns[0].messageIds, ["t1-m1", "t1-m2"]);
  assert.equal(snapshot.turns[0].firstMessageId, "t1-m1");
  assert.equal(snapshot.turns[0].lastMessageId, "t1-m2");
  // 目录顺序 = turn 顺序 + turn 内 query 顺序。
  assert.deepEqual(
    snapshot.queries.map((item) => item.queryRowId),
    [2, 11, 14, 21],
  );
  assert.equal(snapshot.manifestAdjusted, false);
  db.close();
});

test("B2: 同一 turn 重写是整批替换（query 变少时不留幽灵条目）", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turn("t2", 1, 4),
    queries: [query("t2", 0, 11, 1)],
  });

  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.snapshot.totalCount, 3 + 4 + 4);
  assert.deepEqual(
    result.snapshot.queries.map((item) => item.queryRowId),
    [2, 11, 21],
  );
  db.close();
});

test("B3: 空 active 分支的派生口径是 totalCount=0 / firstRowId=null", () => {
  assert.deepEqual(deriveTurnManifestTotals([], []), {
    totalCount: 0,
    firstRowId: null,
    realUserQueryTotal: 0,
  });
  // 有行但 row_count 全为 0 也必须是 null（不能给 1，否则 UI 会显示有一条更早的历史）。
  assert.deepEqual(deriveTurnManifestTotals([turn("t0", 0, 0)], []), {
    totalCount: 0,
    firstRowId: null,
    realUserQueryTotal: 0,
  });
});

test("B4: 该代次没有任何行 → missing（不得当成空分支）", async () => {
  const db = emptyDb();
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 7,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.deepEqual(result, { status: "missing" });
  db.close();
});

// ── C: 账目修正 ─────────────────────────────────────────────────────────────

test("C1: 已物化行数不一致时就地修正 row_count，并置 manifestAdjusted", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);

  const first = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedRowCounts: new Map([
      ["t2", 7],
      ["t3", 4],
    ]),
  });
  assert.equal(first.status, "ok");
  assert.equal(first.snapshot.manifestAdjusted, true);
  assert.deepEqual(first.snapshot.adjustedTurnIds, ["t2"], "只改真正不一致的 turn");
  assert.equal(first.snapshot.totalCount, 3 + 7 + 4, "后续 turn 的 base 因累加自动平移");
  assert.equal(first.snapshot.turns[1].rowCount, 7);

  // 幂等：同样的观测再读一次不再修正。
  const second = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedRowCounts: new Map([["t2", 7]]),
  });
  assert.equal(second.status, "ok");
  assert.equal(second.snapshot.manifestAdjusted, false);
  db.close();
});

test("C2: observedRowCounts 里 manifest 未登记的 turn 不改任何东西", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedRowCounts: new Map([["ghost", 99]]),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.snapshot.manifestAdjusted, false);
  assert.equal(result.snapshot.totalCount, 12);
  db.close();
});

// ── D: 版本 ─────────────────────────────────────────────────────────────────

test("D1: projection_schema_version 不匹配 → schemaMismatch（整表重建的前提）", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION + 1,
  });
  assert.equal(result.status, "schemaMismatch");
  assert.equal(result.expectedVersion, VERSION + 1);
  assert.deepEqual(result.foundVersions, [VERSION]);
  db.close();
});

// ── E: rewind 的分支重写 ────────────────────────────────────────────────────

test("E1: rewind 把保留前缀复制到新代次，row_count 原样不动，ordinal 重排", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);

  const rewrite = await rewriteTurnManifestBranch(db, {
    sessionID: SESSION,
    branchGeneration: 1,
    sourceGeneration: 0,
    keptTurnIds: ["t1", "t2"],
  });
  assert.deepEqual(rewrite, { applied: true, keptTurnCount: 2 });

  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 1,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.snapshot.turns.map((item) => [item.turnId, item.ordinal, item.rowCount]),
    [
      ["t1", 0, 3],
      ["t2", 1, 5],
    ],
  );
  assert.equal(result.snapshot.totalCount, 8);
  assert.deepEqual(
    result.snapshot.queries.map((item) => item.queryRowId),
    [2, 11, 14],
  );
  // 旧代次被清掉：读旧代次只能降级重建，不会读到一份过期全序。
  const old = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.deepEqual(old, { status: "missing" });
  db.close();
});

test("E2: 源代次缺保留 turn → applied:false，且目标代次保持缺失", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);

  const rewrite = await rewriteTurnManifestBranch(db, {
    sessionID: SESSION,
    branchGeneration: 1,
    sourceGeneration: 0,
    keptTurnIds: ["t1", "t9"],
  });
  assert.equal(rewrite.applied, false);
  assert.equal(rewrite.reason, "sourceIncomplete");
  assert.deepEqual(rewrite.missingTurnIds, ["t9"]);

  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 1,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.deepEqual(result, { status: "missing" });
  // 源代次不被动过：降级重建仍可从当前代次取到完整全序。
  const source = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.equal(source.status, "ok");
  assert.equal(source.snapshot.turns.length, 3);
  db.close();
});

test("E3: 同代次原地过滤（旧语义 rewind 不换代次）同样重排 ordinal", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);
  const rewrite = await rewriteTurnManifestBranch(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    sourceGeneration: 0,
    keptTurnIds: ["t1"],
  });
  assert.deepEqual(rewrite, { applied: true, keptTurnCount: 1 });

  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.snapshot.turns.map((item) => item.turnId),
    ["t1"],
  );
  assert.deepEqual(
    result.snapshot.queries.map((item) => item.queryRowId),
    [2],
  );
  db.close();
});

test("E4: 重写到零保留 turn（rewind 到首条）后该代次读作 missing，不伪造全序", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);
  const rewrite = await rewriteTurnManifestBranch(db, {
    sessionID: SESSION,
    branchGeneration: 1,
    sourceGeneration: 0,
    keptTurnIds: [],
  });
  assert.deepEqual(rewrite, { applied: true, keptTurnCount: 0 });
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 1,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.deepEqual(result, { status: "missing" });
  db.close();
});

test("E5: 同一 ordinal 被新 turn 占用时，旧分支残留被逐出（不撞主键）", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);
  // 模拟旧语义 rewind 后新 turn 复用 ordinal 1（manifest 还没来得及重写）。
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turn("t-new", 1, 6),
    queries: [query("t-new", 0, 40, 1)],
  });
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.snapshot.turns.map((item) => item.turnId),
    ["t1", "t-new", "t3"],
  );
  // 被逐出的 t2 的 query 行也一并清掉。
  assert.deepEqual(
    result.snapshot.queries.map((item) => item.queryRowId),
    [2, 40, 21],
  );
  db.close();
});

// ── F: 清单缺项 → 整表重建（Step 3 的「未登记 turn」检测）────────────────────

test("F1: ordinal 出现空洞 → inconsistent/ordinalGap，且不做账目修正", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);
  // 中间轮次的登记行没写进去（detached 写入丢失）。t3 的 ordinal 仍是 2 → 0,2 空洞。
  db.prepare("delete from session_turn_manifest where session_id = ? and turn_id = ?").run(
    SESSION,
    "t2",
  );
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    // 账目修正不能把「缺一整轮」糊过去：先判缺项，再谈行数偏差。
    observedRowCounts: new Map([["t1", 99]]),
  });
  assert.equal(result.status, "inconsistent");
  assert.equal(result.reason, "ordinalGap");
  assert.deepEqual(result.turnIds, []);
  assert.deepEqual(result.missingMessageIds, []);
  const untouched = db
    .prepare("select row_count from session_turn_manifest where session_id = ? and turn_id = ?")
    .get(SESSION, "t1");
  assert.equal(untouched.row_count, 3, "判缺项时不得顺手改 row_count");
  db.close();
});

test("F2: 观察到的 turn 里有 manifest 未登记的 → inconsistent/unregisteredTurns", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);

  const complete = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedTurnIds: ["t1", "t2", "t3"],
  });
  assert.equal(complete.status, "ok", "子集观察不得误判");

  const missing = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedTurnIds: ["t1", "t2", "t3", "t4", "t4", "t9"],
  });
  assert.equal(missing.status, "inconsistent");
  assert.equal(missing.reason, "unregisteredTurns");
  // 去重且保序：重复观察不能把同一个 turn 报两遍。
  assert.deepEqual(missing.turnIds, ["t4", "t9"]);
  db.close();
});

test("F3: manifest 的 messageId 不在消息索引里 → inconsistent/messageIndexMismatch", async () => {
  const db = emptyDb();
  await seedThreeTurns(db);

  const complete = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedMessageIds: ["t1-m1", "t1-m2", "t2-m1", "t2-m2", "t3-m1", "t3-m2", "unrelated"],
  });
  assert.equal(complete.status, "ok", "索引多出无关行不算失配");

  const missing = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedMessageIds: ["t1-m1", "t1-m2", "t2-m1", "t2-m2", "t3-m1"],
  });
  assert.equal(missing.status, "inconsistent");
  assert.equal(missing.reason, "messageIndexMismatch");
  assert.deepEqual(missing.missingMessageIds, ["t3-m2"]);
  db.close();
});

test("F4: messageIndexMismatch 的诊断列表截断到 20 条（不把日志打爆）", async () => {
  const db = emptyDb();
  const messageIds = Array.from({ length: 40 }, (_value, index) => `bulk-m${index}`);
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turn("t1", 0, 40, {
      messageIds,
      firstMessageId: messageIds[0],
      lastMessageId: messageIds[39],
    }),
    queries: [],
  });
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedMessageIds: [],
  });
  assert.equal(result.status, "inconsistent");
  assert.equal(result.reason, "messageIndexMismatch");
  assert.equal(result.missingMessageIds.length, 20);
  db.close();
});
