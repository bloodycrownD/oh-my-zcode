#!/usr/bin/env node
/**
 * 冷开文件变更摘要缓存（`session_file_change_summaries`）的仓储级验证。
 *
 * ============================================================================
 * 为什么要有这道测试
 * ============================================================================
 * 真机取证（2026-10-26）：摘要现算 291 条物化消息 → 2088ms，占 `mergeMs` 94%。
 * 改成「算一次落库、之后批量读」以后，这条缓存本身成了**正确性关键路径**：
 * 它读错了不会崩，只会静默给出错误的角标或永远不命中（每次冷开又回到 2 秒）。
 *
 * 四个必须钉住的失效面：
 *
 *   A. **往返一致**：upsert 后再按 messageId 读回必须逐值相同（含 items 数组顺序）。
 *   B. **负缓存**：`null` 表示「算过、这一轮本来没有变更」，必须能被读成 `null`
 *      （而不是「不存在」）——否则这些 messageId 每次冷开都被当成未命中重算一遍，
 *      而它们恰恰是多数（没有 checkpoint 的轮次）。
 *   C. **版本隔离**：summaryVersion 进主键。口径一变就换版本号，旧行自然读不到，
 *      不必写迁移去改历史行；反过来旧版本行也不能污染新版本读取。
 *   D. **分批不截断**：窗口化首屏一次可带上千条 messageId，而 SQLite 旧构建的绑定变量
 *      上限是 999。分批必须合并结果——截断会静默少读，表现成「部分轮次角标莫名消失」。
 *
 * 运行方式：`node --import tsx --test scripts/test-file-change-summaries.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const { SESSION_FILE_CHANGE_SUMMARIES_MIGRATION_SQL } = await import(
  "../src/storage/session-store/migrations/0024-session-file-change-summaries.ts"
);
const {
  DEFAULT_FILE_CHANGE_SUMMARY_VERSION,
  readFileChangeSummaries,
  upsertFileChangeSummaries,
} = await import("../src/storage/session-store/repositories/file-change-summaries.ts");

const SESSION = "sess_file_change_cache";

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SESSION_FILE_CHANGE_SUMMARIES_MIGRATION_SQL);
  return db;
}

const SAMPLE = {
  additions: 12,
  deletions: 3,
  files: 2,
  items: [
    { additions: 10, deletions: 1, path: "a.ts", toolNames: ["edit"], writeCount: 2 },
    { additions: 2, deletions: 2, path: "b.ts", toolNames: ["write"], writeCount: 1 },
  ],
};

test("A. upsert 后按 messageId 读回逐值一致（含 items 顺序）", () => {
  const db = createDb();
  upsertFileChangeSummaries(db, {
    sessionId: SESSION,
    records: [{ computedAt: 1, messageId: "msg-1", summary: SAMPLE }],
  });
  const read = readFileChangeSummaries(db, { sessionId: SESSION, messageIds: ["msg-1"] });
  assert.deepEqual(read.get("msg-1"), SAMPLE);
  db.close();
});

test("B. 负缓存：写入 null 必须能读成 null，且与「没有这一行」区分开", () => {
  const db = createDb();
  upsertFileChangeSummaries(db, {
    sessionId: SESSION,
    records: [
      { computedAt: 1, messageId: "msg-empty", summary: null },
      // 有结果的对照项：证明同一次写入里两种 kind 都成立。
      { computedAt: 1, messageId: "msg-has", summary: SAMPLE },
    ],
  });
  const read = readFileChangeSummaries(db, {
    sessionId: SESSION,
    messageIds: ["msg-empty", "msg-has", "msg-never-computed"],
  });
  assert.equal(read.has("msg-empty"), true, "负缓存行必须存在");
  assert.equal(read.get("msg-empty"), null, "负缓存行的值必须是 null");
  assert.deepEqual(read.get("msg-has"), SAMPLE);
  assert.equal(
    read.has("msg-never-computed"),
    false,
    "从未算过的 messageId 不能出现在结果里——否则会被当成「已覆盖」而永远不再补算",
  );
  db.close();
});

test("C. 版本隔离：旧版本行不能被新版本读到，也不会覆盖旧行", () => {
  const db = createDb();
  upsertFileChangeSummaries(
    db,
    { sessionId: SESSION, records: [{ computedAt: 1, messageId: "msg-1", summary: SAMPLE }] },
    DEFAULT_FILE_CHANGE_SUMMARY_VERSION,
  );
  const asNewVersion = readFileChangeSummaries(
    db,
    { sessionId: SESSION, messageIds: ["msg-1"] },
    DEFAULT_FILE_CHANGE_SUMMARY_VERSION + 1,
  );
  assert.equal(asNewVersion.size, 0, "换版本号后旧行必须读不到（由后台重新填）");

  upsertFileChangeSummaries(
    db,
    {
      sessionId: SESSION,
      records: [{ computedAt: 2, messageId: "msg-1", summary: { ...SAMPLE, files: 9 } }],
    },
    DEFAULT_FILE_CHANGE_SUMMARY_VERSION + 1,
  );
  const oldRow = readFileChangeSummaries(
    db,
    { sessionId: SESSION, messageIds: ["msg-1"] },
    DEFAULT_FILE_CHANGE_SUMMARY_VERSION,
  );
  assert.equal(oldRow.get("msg-1")?.files, 2, "新版本写入不得覆盖旧版本行（回滚要能读回旧值）");
  db.close();
});

test("D. 超过绑定变量上限时分批合并，不截断", () => {
  const db = createDb();
  const count = 1000;
  const ids = Array.from({ length: count }, (_, index) => `msg-${index}`);
  upsertFileChangeSummaries(db, {
    sessionId: SESSION,
    records: ids.map((messageId, index) => ({
      computedAt: index,
      messageId,
      summary: { ...SAMPLE, files: index },
    })),
  });
  const read = readFileChangeSummaries(db, { sessionId: SESSION, messageIds: ids });
  assert.equal(read.size, count, `1000 条必须全部读回，实际 ${read.size}`);
  assert.equal(read.get("msg-0")?.files, 0);
  assert.equal(read.get("msg-999")?.files, 999);
  db.close();
});

test("E. 会话隔离：别的 session 的同名 messageId 不串味", () => {
  const db = createDb();
  upsertFileChangeSummaries(db, {
    sessionId: SESSION,
    records: [{ computedAt: 1, messageId: "msg-1", summary: SAMPLE }],
  });
  const other = readFileChangeSummaries(db, {
    sessionId: "sess_other",
    messageIds: ["msg-1"],
  });
  assert.equal(other.size, 0);
  db.close();
});
