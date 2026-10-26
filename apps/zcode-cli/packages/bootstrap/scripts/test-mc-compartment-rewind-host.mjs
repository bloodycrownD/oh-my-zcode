#!/usr/bin/env node
/**
 * FORK（spec phase-compartment-rewind / C1）：宿主侧 rewind → compartment 失效的
 * 水位换算与调用契约。
 *
 * 钉死什么：
 *   H1 — **持久序换算**：`anchorMessageId` 在 `sessionStore.messages()` 里的
 *        1-based 位置就是水位（与 compartments 的 `end_message` 同一坐标系），
 *        `end_message >= 水位` 的行被写成 `unresolved`，cached_m0/m1 被清空。
 *   H2 — **兜底水位**：锚点不在持久序里时回落到 `keptMessageCount + 1`，并且
 *        日志的 `ordinalSource = "kept_count_fallback"` 必须显式暴露这条路径
 *        （否则「走了兜底」在生产里不可见）。
 *   H3 — **失败方向**：store 读失败 / 包内标记抛错都**不抛**——rewind 已提交，
 *        收尾失败只能变成 warn；读侧过滤是独立的第二道闸。
 *
 * 隔离：MAGIC_CONTEXT_DB_DIR 指 OS 临时目录，进程退出即清理。
 * dist 前置：`pnpm --dir apps/zcode-cli/packages/magic-context build` 与
 * `pnpm --dir apps/zcode-cli/packages/bootstrap build`。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName === null) return nextResolve(specifier, context);
    const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
    const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
    for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
      try {
        statSync(candidate);
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      } catch {
        // 试下一个候选
      }
    }
    throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
  },
});

const BOOTSTRAP_DIST = new URL("../dist/app/magic-context/storage.js", import.meta.url);
try {
  statSync(fileURLToPath(BOOTSTRAP_DIST));
} catch {
  throw new Error(
    "dist 前置缺失 bootstrap dist/app/magic-context/storage.js —— 先 pnpm --dir apps/zcode-cli/packages/bootstrap build",
  );
}

const { openDatabase } = await import("@zcode/magic-context");
const { invalidateMagicContextCompartmentsForRewind } = await import(BOOTSTRAP_DIST.href);

const dbDir = mkdtempSync(join(tmpdir(), "mc-rewind-host-db-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");

const db = openDatabase({ dbPath: join(dbDir, "magic-context.db") });
if (!db) throw new Error("openDatabase() failed");

process.on("exit", () => {
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响结论
  }
});

const INSERT = db.prepare(
  `INSERT INTO compartments
     (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
      title, content, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function seed(sessionId, rows) {
  for (const row of rows) {
    INSERT.run(
      sessionId,
      row.sequence,
      row.startMessage,
      row.endMessage,
      row.startMessageId,
      row.endMessageId,
      `segment-${row.sequence}`,
      row.content ?? `content-${row.sequence}`,
      Date.now(),
    );
  }
  // 缓存列必须有非空值，才能证明 invalidation 真的把它们清掉了。
  db.prepare(
    `INSERT INTO session_meta (session_id, counter, cached_m0_bytes, cached_m1_bytes,
                               cached_m0_last_baseline_end_message_id, cached_m0_max_compartment_seq)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       cached_m0_bytes = excluded.cached_m0_bytes,
       cached_m1_bytes = excluded.cached_m1_bytes,
       cached_m0_last_baseline_end_message_id = excluded.cached_m0_last_baseline_end_message_id,
       cached_m0_max_compartment_seq = excluded.cached_m0_max_compartment_seq`,
  ).run(
    sessionId,
    Buffer.from("<session-history>old</session-history>"),
    Buffer.from("m1"),
    "m-2",
    2,
  );
}

function statuses(sessionId) {
  return db
    .prepare(
      "SELECT sequence, rebase_status FROM compartments WHERE session_id = ? ORDER BY sequence ASC",
    )
    .all(sessionId)
    .map((row) => [row.sequence, row.rebase_status]);
}

function meta(sessionId) {
  return db
    .prepare(
      `SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1,
              cached_m0_last_baseline_end_message_id AS boundary
         FROM session_meta WHERE session_id = ?`,
    )
    .get(sessionId);
}

function createLogger() {
  const infos = [];
  const warns = [];
  return {
    infos,
    warns,
    logger: {
      info: (message, fields) => infos.push({ message, fields }),
      warn: (message, fields) => warns.push({ message, fields }),
      error: () => {},
      debug: () => {},
      child() {
        return this;
      },
    },
  };
}

function storeOf(ids) {
  return {
    messages: async () => ids.map((id) => ({ info: { id, role: "user" }, parts: [] })),
  };
}

test("H1 水位 = 锚点在持久序里的 1-based 位置；>= 水位的行作废并清空缓存对", async () => {
  const sessionId = "ses_h1";
  seed(sessionId, [
    { sequence: 0, startMessage: 1, endMessage: 1, startMessageId: "m-1", endMessageId: "m-1" },
    { sequence: 1, startMessage: 2, endMessage: 2, startMessageId: "m-2", endMessageId: "m-2" },
    { sequence: 2, startMessage: 3, endMessage: 3, startMessageId: "m-3", endMessageId: "m-3" },
  ]);
  const { infos, logger } = createLogger();

  await invalidateMagicContextCompartmentsForRewind(
    { db, sessionId, sessionStore: storeOf(["m-1", "m-2", "m-3", "m-4"]), logger },
    { anchorMessageId: "m-3", keptMessageCount: 2 },
  );

  assert.deepEqual(statuses(sessionId), [
    [0, "ok"],
    [1, "ok"],
    [2, "unresolved"],
  ]);
  const cleared = meta(sessionId);
  assert.equal(cleared.m0, null, "cached_m0_bytes 必须清空");
  assert.equal(cleared.m1, null, "cached_m1_bytes 必须清空");
  assert.equal(cleared.boundary, null, "基线边界必须清空");
  const event = infos.find(
    (entry) => entry.fields?.event === "magic_context.compartments_invalidated",
  );
  assert.ok(event, "必须发 compartments_invalidated 事件");
  assert.equal(event.fields.anchorOrdinal, 3, "锚点 m-3 在持久序里是第 3 条 ⇒ 水位 3");
  assert.equal(event.fields.ordinalSource, "session_store");
  assert.equal(event.fields.markedUnresolved, 1);
});

test("H2 锚点不在持久序里 ⇒ 回落 keptMessageCount + 1，且日志显式标注来源", async () => {
  const sessionId = "ses_h2";
  seed(sessionId, [
    { sequence: 0, startMessage: 1, endMessage: 1, startMessageId: "m-1", endMessageId: "m-1" },
    { sequence: 1, startMessage: 2, endMessage: 2, startMessageId: "m-2", endMessageId: "m-2" },
    { sequence: 2, startMessage: 3, endMessage: 3, startMessageId: "m-3", endMessageId: "m-3" },
  ]);
  const { infos, logger } = createLogger();

  await invalidateMagicContextCompartmentsForRewind(
    { db, sessionId, sessionStore: storeOf(["m-1"]), logger },
    { anchorMessageId: "m-not-in-store", keptMessageCount: 1 },
  );

  assert.deepEqual(statuses(sessionId), [
    [0, "ok"],
    [1, "unresolved"],
    [2, "unresolved"],
  ]);
  const event = infos.find(
    (entry) => entry.fields?.event === "magic_context.compartments_invalidated",
  );
  assert.equal(event.fields.ordinalSource, "kept_count_fallback");
  assert.equal(event.fields.anchorOrdinal, 2, "keptMessageCount=1 ⇒ 水位 2");
});

test("H3 store 读失败 / 标记失败都只 warn，不抛（rewind 已提交，收尾失败不得让命令失败）", async () => {
  const sessionId = "ses_h3";
  seed(sessionId, [
    { sequence: 0, startMessage: 1, endMessage: 1, startMessageId: "m-1", endMessageId: "m-1" },
    { sequence: 1, startMessage: 2, endMessage: 2, startMessageId: "m-2", endMessageId: "m-2" },
  ]);
  const { warns, logger } = createLogger();

  await invalidateMagicContextCompartmentsForRewind(
    {
      db,
      sessionId,
      sessionStore: {
        messages: async () => {
          throw new Error("store offline");
        },
      },
      logger,
    },
    { anchorMessageId: "m-2", keptMessageCount: 1 },
  );

  assert.ok(
    warns.some(
      (entry) =>
        entry.fields?.event === "magic_context.compartments_invalidation_store_read_failed",
    ),
    "store 读失败必须留 warn",
  );
  // 兜底水位仍然生效：seq1（end_message=2）被作废。
  assert.deepEqual(statuses(sessionId), [
    [0, "ok"],
    [1, "unresolved"],
  ]);

  // 包内抛错（此处用已关闭的 db 模拟）⇒ 只 warn，不 reject。
  const closedSessionId = "ses_h3_closed";
  seed(closedSessionId, [
    { sequence: 0, startMessage: 1, endMessage: 1, startMessageId: "m-1", endMessageId: "m-1" },
  ]);
  const failingDb = {
    prepare() {
      throw new Error("database is closed");
    },
    exec() {
      throw new Error("database is closed");
    },
  };
  await invalidateMagicContextCompartmentsForRewind(
    { db: failingDb, sessionId: closedSessionId, sessionStore: storeOf(["m-1", "m-2"]), logger },
    { anchorMessageId: "m-2", keptMessageCount: 1 },
  );
  assert.ok(
    warns.some((entry) => entry.fields?.event === "magic_context.compartments_invalidation_failed"),
    "标记失败必须留 warn，而不是抛出",
  );
});
