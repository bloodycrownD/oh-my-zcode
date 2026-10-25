#!/usr/bin/env node
/**
 * Step 10（C 章）/ T-U1 — `/ctx-status` 诊断字段 `lastUsageContextLimit` 的验收。
 *
 * 这个字段回答的是「那个占用百分比的分母是什么」：`session_meta.last_usage_context_limit`
 * 记录最近一次占用读数使用的 context limit——通常是模型原始上下文窗口，floor 拒绝路径
 * 可能是 usableSoft。本轮只读它，不重解析 geometry（见 SPEC open question 5）。
 *
 * 覆盖三条契约：
 *   1. **有值透传**：持久值原样出现在快照与文本输出里，且不影响既有读数
 *      （protected floor / 占用百分比 / input tokens）。
 *   2. **0 = 未观测**：列是 `NOT NULL DEFAULT 0`，新建会话（以及旧库补列后的 0）必须
 *      映射成 `null`、文本渲染成 `-`，不能让 0 冒充一个 0 token 的窗口。
 *   3. **显式写 0 同义**：清空/回填成 0 的会话与从未观测的会话同一语义。
 *
 * 只读诊断面：脚本自己只经宿主 recorder 的同一条写路径 `updateSessionMeta` 造
 * `session_meta` 行，不写 tag / compartment，也不碰 transform。
 *
 * Requires Node >= 24 (`node:sqlite`) and a prior `pnpm build` — it imports the
 * compiled `dist/`, like the other suites.
 *
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const dist = (p) => pathToFileURL(join(PKG_ROOT, "dist", p)).href;

const dbDir = mkdtempSync(join(tmpdir(), "magic-context-ctx-status-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

const { initializeMagicContextHost } = await import(dist("host/harness.js"));
initializeMagicContextHost();

const { openDatabase } = await import(dist("core/features/magic-context/storage-db.js"));
const { updateSessionMeta } = await import(dist("core/features/magic-context/storage-meta.js"));
const { formatMagicContextStatusSnapshot, readMagicContextStatusSnapshot } = await import(
  dist("host/ctx-status.js")
);

const db = openDatabase();
assert.ok(db, "openDatabase() must succeed against the temp store");

const OBSERVED_SESSION = "sess_status_diagnostics_observed";
const UNOBSERVED_SESSION = "sess_status_diagnostics_unobserved";

test("lastUsageContextLimit carries the persisted limit of the last usage reading", async () => {
  // 宿主 recorder 的落库那一半：`model_complete` → `updateSessionMeta`
  // （与 test-transform 的 b4 用例同一条写路径）。
  updateSessionMeta(db, OBSERVED_SESSION, {
    lastContextPercentage: 27,
    lastInputTokens: 54_000,
    lastUsageContextLimit: 200_000,
  });

  const snapshot = await readMagicContextStatusSnapshot({ db, sessionId: OBSERVED_SESSION });
  assert.ok(snapshot, "snapshot must be produced for an open db");
  assert.equal(snapshot.lastUsageContextLimit, 200_000);
  // 既有读数不得被这次改动带偏：本节点只加字段，不改查询语义。
  assert.equal(snapshot.contextPercentage, 27);
  assert.equal(snapshot.lastInputTokens, 54_000);

  const lines = formatMagicContextStatusSnapshot(snapshot).split("\n");
  assert.ok(lines.includes("  last usage context limit: 200000"), "文本快照必须带上那次读数的分母");
  // 分子与分母成对出现，读者才判得出「27% 是相对哪个窗口」。
  assert.ok(lines.includes("  last context usage: 27%"));
});

test("a session with no usage reading maps the NOT NULL DEFAULT 0 column to null", async () => {
  const snapshot = await readMagicContextStatusSnapshot({ db, sessionId: UNOBSERVED_SESSION });
  assert.ok(snapshot, "a never-transformed session still yields a snapshot");
  assert.equal(snapshot.lastUsageContextLimit, null, "0 是「未观测」，不是 0 token 的窗口");

  const lines = formatMagicContextStatusSnapshot(snapshot).split("\n");
  assert.ok(
    lines.includes("  last usage context limit: -"),
    "未观测渲染成 -，与 protected floor 的未知态同义",
  );
  assert.ok(
    !lines.some((line) => line.startsWith("  last usage context limit: 0")),
    "0 不能被当成一个真实读数打印出来",
  );
});

test("an explicit 0 write (reset / legacy backfill) is also treated as unobserved", async () => {
  updateSessionMeta(db, OBSERVED_SESSION, { lastUsageContextLimit: 0 });

  const snapshot = await readMagicContextStatusSnapshot({ db, sessionId: OBSERVED_SESSION });
  assert.ok(snapshot);
  assert.equal(snapshot.lastUsageContextLimit, null);
  // 其余读数仍在该行上，字段之间互不牵连。
  assert.equal(snapshot.contextPercentage, 27);
});

test("rewind 作废的 compartment 不计入 count，另列 invalidated", async () => {
  // P2-4：`getCompartments` 是**全量**读（含 rebase_status='unresolved' 的行），而
  // 注入面（readM0Compartments）会过滤掉它们。快照若直接 `compartments.length`，
  // rewind 后 `/ctx-status` 会报「count: 5」，而模型实际只看到 3 段。
  const sessionId = "sess_status_invalidated";
  const { appendCompartments } = await import(
    dist("core/features/magic-context/compartment-storage.js")
  );
  appendCompartments(
    db,
    sessionId,
    [0, 1, 2, 3, 4].map((sequence) => ({
      sequence,
      startMessage: sequence + 1,
      endMessage: sequence + 1,
      startMessageId: `m-${sequence}`,
      endMessageId: `m-${sequence}`,
      title: `segment-${sequence}`,
      content: `SUMMARY-${sequence}`,
      p1: `SUMMARY-${sequence}`,
    })),
  );
  // 后两段 = rewind 之后被标成 unresolved 的行（rewind-invalidation 的写形态）。
  db.prepare(
    "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence >= 3",
  ).run(sessionId);

  const snapshot = await readMagicContextStatusSnapshot({ db, sessionId });
  assert.ok(snapshot);
  assert.equal(snapshot.compartmentCount, 3, "只数仍会注入的段（作废行不参与）");
  assert.equal(snapshot.invalidatedCompartmentCount, 2, "作废段单独计数");

  const lines = formatMagicContextStatusSnapshot(snapshot).split("\n");
  assert.ok(lines.includes("  count: 3"), "count 必须与注入面一致");
  assert.ok(lines.includes("  invalidated: 2"), "作废段数必须在快照里可见");
});

test.after(() => {
  // db 句柄仍开着时 Windows 会拒绝删除临时目录；残留一个临时目录不该把通过的套件变成失败的。
  try {
    rmSync(dbDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  } catch (error) {
    console.warn(`could not remove ${dbDir}: ${error && error.message}`);
  }
});
