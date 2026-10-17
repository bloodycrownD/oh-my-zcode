#!/usr/bin/env node
/**
 * Step 3（T-A1/T-A2）工具面验收 —— `ctx_memory` 的 archive 分支
 * （`../src/tool/handlers/ctx-memory.ts` → 包侧 `host/memory-admin.ts` 组合函数）。
 *
 * 覆盖：
 *   - **T-A1**：批量废弃的确认文案（`Archived memories [ID: ...] (reason).`）+
 *     `memories.status='archived'`（archive_reason 落 metadata_json）+
 *     `memory_mutation_log` 行与 ids 成对（mutationType="archive"）；同批重复废弃
 *     = 幂等（文案含 already archived、**不新增 mutation 行**）；
 *   - **T-A2**：superseded 行（status 已被 superseded 写路径同置 'archived'）→
 *     rejected + 上游 inactiveMemoryError 风格文案（判据里 superseded 先于
 *     already-archived）；跨项目（ownership）id 与不存在 id → **共用同一条不透明
 *     `was not found`**（防泄漏：不暴露外部项目记忆 id 的存在性）；authority 项目
 *     （`authority_managed` 标记）→ fail-visible 拒绝 + 整批回滚（无 mutation 行）；
 *   - 混合批次：archived + already + rejected + missing 一次投递，部分成功合法，
 *     mutation 行只对真正归档的 id 新增；
 *   - 边界与回归 smoke：`ids` 缺失的可自我纠正错误、重复 id 只写一条 mutation 行、
 *     action 缺省 = write 照旧（主回归在 test-ctx-search-memory）。
 *
 * 运行方式：`tsx --test scripts/test-ctx-memory-archive.mjs`
 * （必须 tsx：被测 handler 是 TypeScript 源码，与同目录 ctx-search-memory 测试
 *  同范式）。**前置构建**：`@zcode/contracts` 与 `@zcode/magic-context` 的 dist
 *  必须存在——handler 动态 import 的是包侧编译产物（barrel 的
 *  `archiveProjectMemories` 出口来自 Step 1）。
 *
 * 隔离：`mkdtemp` + 显式 `MAGIC_CONTEXT_DB_DIR` / `MAGIC_CONTEXT_LOG_PATH`，
 * `delete process.env.NODE_ENV`（node --test 会把 NODE_ENV 置为 test，包侧
 * data-path 会据此把存储重定向到 backstop 目录）。**绝不写真实 ~/.omz**。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dbDir = mkdtempSync(join(tmpdir(), "zcode-ctx-memory-archive-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

const { ctxMemoryToolEntry } = await import("../src/tool/handlers/ctx-memory.js");
const magicContext = await import("@zcode/magic-context");

magicContext.initializeMagicContextHost();

const WORK_DIR = mkdtempSync(join(tmpdir(), "zcode-ctx-archive-work-"));
/** 第二项目身份：T-A2 ownership 拒绝对照组（跨项目 id 必须走不透明文案）。 */
const FOREIGN_WORK_DIR = mkdtempSync(join(tmpdir(), "zcode-ctx-archive-foreign-"));
/** authority 项目目录：archive 必须 fail-visible 拒绝，不得绕过 authority 表写入。 */
const AUTHORITY_WORK_DIR = mkdtempSync(join(tmpdir(), "zcode-ctx-archive-authority-"));
const SESSION_ID = "sess_ctx_memory_archive";

// openDatabase 按路径缓存句柄：整个测试进程共用同一个 handle（与生产同语义），
// 因此**不 close**——关掉会毒化缓存，让后续 openDatabase 拿到已关闭的句柄。
const sharedDb = magicContext.openDatabase(magicContext.getMagicContextDatabasePath());
assert.ok(sharedDb, "openDatabase() must succeed against the temp store");

// 三个项目身份与 handler 内 `resolveProjectIdentityForSession(workingDirectory)` 同
// 空间：archive 的 ownership 判据（normalizeStoredProjectPath 归一后相等）靠它们成立。
const IDENTITY = magicContext.resolveProjectIdentityForSession(WORK_DIR);
assert.ok(IDENTITY, "本项目目录必须能解析 identity，否则全部用例空转");
const FOREIGN_IDENTITY = magicContext.resolveProjectIdentityForSession(FOREIGN_WORK_DIR);
assert.ok(FOREIGN_IDENTITY, "foreign 临时目录必须能解析 identity，否则 ownership 用例空转");
const AUTHORITY_IDENTITY = magicContext.resolveProjectIdentityForSession(AUTHORITY_WORK_DIR);
assert.ok(AUTHORITY_IDENTITY, "authority 临时目录必须能解析 identity，否则 authority 用例空转");

/** handler 的最小 ToolExecutionContext 投影（只用到三个字段）。 */
function toolContext(overrides = {}) {
  return {
    toolCallId: "call_ctx_memory_archive",
    sessionId: SESSION_ID,
    workingDirectory: WORK_DIR,
    workspaceRoot: WORK_DIR,
    abortSignal: new AbortController().signal,
    traceId: "trace_ctx_archive",
    ...overrides,
  };
}

let callSeq = 0;
/**
 * 每次逻辑调用默认拿一个**新的** toolCallId：commandId 账本按 toolCallId 记账，
 * 复用默认 id 会让第二次调用命中幂等回放（账本本身在 test-ctx-search-memory
 * 已有专测，这里只要绕过它拿真实执行结果）。
 */
async function callCtxMemory(args, overrides = {}) {
  callSeq += 1;
  const result = await ctxMemoryToolEntry.handler(
    args,
    toolContext({ toolCallId: `call_ctx_archive_${callSeq}`, ...overrides }),
  );
  return result.text;
}

/** 直插一条本项目记忆（绕过工具面，等价 historian 写路径）。 */
function insertMemory(content, overrides = {}) {
  const { memory } = magicContext.insertMemoryIdempotent(sharedDb, {
    projectPath: IDENTITY,
    category: "CONFIG_VALUES",
    content,
    sourceType: "historian",
    ...overrides,
  });
  return memory;
}

function readRow(id) {
  return sharedDb
    .prepare("SELECT id, status, superseded_by_memory_id, metadata_json FROM memories WHERE id = ?")
    .get(id);
}

/** 指定 target id 集上的 mutation 行（按写入序）——成对写的唯一证据面。 */
function mutationRowsFor(ids) {
  assert.ok(ids.length > 0, "mutationRowsFor 需要至少一个 id");
  const placeholders = ids.map(() => "?").join(", ");
  return sharedDb
    .prepare(
      `SELECT id, project_path, mutation_type, target_memory_id FROM memory_mutation_log
        WHERE target_memory_id IN (${placeholders}) ORDER BY id`,
    )
    .all(...ids);
}

/** archiveMemory(reason) 把 reason trim 后并入 metadata_json.archive_reason（D5）。 */
function archiveReasonOf(id) {
  const row = readRow(id);
  if (!row || row.metadata_json === null) return undefined;
  return JSON.parse(row.metadata_json).archive_reason;
}

process.on("exit", () => {
  // 先关句柄再删目录：Windows 上开着的 sqlite 句柄会让 rmSync 抛 EPERM。
  try {
    sharedDb.close();
  } catch {
    // 关闭失败不改变测试结论。
  }
  for (const dir of [dbDir, WORK_DIR, FOREIGN_WORK_DIR, AUTHORITY_WORK_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录残留不污染真实存储（MAGIC_CONTEXT_DB_DIR 已隔离）。
    }
  }
});

// ── T-A1：批量归档 + 幂等 ────────────────────────────────────────────────────

test("archive retires a batch: confirmation line, archived status, paired mutation rows", async () => {
  const alpha = insertMemory("Batch archive alpha: the export bucket is deprecated.");
  const beta = insertMemory("Batch archive beta: the legacy cron entry is deprecated.");

  const text = await callCtxMemory({
    action: "archive",
    ids: [alpha.id, beta.id],
    reason: "deprecated by the new retention policy",
  });
  // 上游同款确认文案（reason 非空带括号；多 id 用复数 memories）。
  assert.equal(
    text,
    `Archived memories [ID: ${alpha.id}, ${beta.id}] (deprecated by the new retention policy).`,
  );

  assert.equal(readRow(alpha.id).status, "archived");
  assert.equal(readRow(beta.id).status, "archived");
  assert.equal(archiveReasonOf(beta.id), "deprecated by the new retention policy");

  // 成对写：每个 id 恰好一条 mutation 行，类型 archive、project_path 用解析身份。
  const rows = mutationRowsFor([alpha.id, beta.id]);
  assert.deepEqual(
    rows.map((row) => [row.target_memory_id, row.mutation_type, row.project_path]),
    [
      [alpha.id, "archive", IDENTITY],
      [beta.id, "archive", IDENTITY],
    ],
  );
});

test("archive is idempotent per batch (T-A1): repeats report already archived with no new mutation rows", async () => {
  const gamma = insertMemory("Idempotency gamma: a fact archived once and seen twice.");
  const delta = insertMemory("Idempotency delta: a second fact archived once and seen twice.");

  const first = await callCtxMemory({ action: "archive", ids: [gamma.id, delta.id] });
  // reason 缺省 → 无括号确认行（上游同款分支）。
  assert.equal(first, `Archived memories [ID: ${gamma.id}, ${delta.id}].`);
  const rowsAfterFirst = mutationRowsFor([gamma.id, delta.id]);
  assert.equal(rowsAfterFirst.length, 2);

  const second = await callCtxMemory({ action: "archive", ids: [gamma.id, delta.id] });
  assert.equal(
    second,
    `Memory [ID: ${gamma.id}] is already archived.\nMemory [ID: ${delta.id}] is already archived.`,
  );
  // 幂等的关键断言：重复废弃不产生第二条 mutation 行（否则注入面会重复渲染撤回）。
  assert.equal(mutationRowsFor([gamma.id, delta.id]).length, rowsAfterFirst.length);
  assert.equal(readRow(gamma.id).status, "archived");
});

test("archive collapses repeated ids into one write (first-seen dedup)", async () => {
  const single = insertMemory("Dedup fact: archived once even when the batch repeats its id.");

  const text = await callCtxMemory({
    action: "archive",
    ids: [single.id, single.id, single.id],
    reason: "dedup check",
  });
  assert.equal(text, `Archived memory [ID: ${single.id}] (dedup check).`);
  assert.equal(mutationRowsFor([single.id]).length, 1, "同一 id 只允许一条 mutation 行");
});

// ── T-A2：superseded / ownership / authority 三种拒绝 ───────────────────────

test("archive rejects a superseded memory (T-A2) with the inactive-style message", async () => {
  const successor = insertMemory("Superseded successor: the consolidated replacement fact.");
  const target = insertMemory("Superseded target: the fact replaced by the successor.");
  // 复刻 superseded 写路径（storage-memory.ts:514）：superseded_by_memory_id 置位
  // 的同时 status 也被置为 'archived'——判据必须先判 superseded 再判 status。
  sharedDb
    .prepare("UPDATE memories SET superseded_by_memory_id = ?, status = 'archived' WHERE id = ?")
    .run(successor.id, target.id);

  const text = await callCtxMemory({ action: "archive", ids: [target.id], reason: "cleanup" });
  assert.equal(
    text,
    `Error: Memory with ID ${target.id} is archived or superseded; restore it before archiving.`,
  );
  // 拒绝 = 无副作用：不新增 mutation 行、归档时间戳不动。
  assert.equal(mutationRowsFor([target.id]).length, 0);
});

test("archive rejects foreign-project ids (T-A2) with the opaque not-found message", async () => {
  const foreign = insertMemory("Foreign project fact that must stay opaque to this project.", {
    projectPath: FOREIGN_IDENTITY,
  });

  const text = await callCtxMemory({ action: "archive", ids: [foreign.id] });
  // 防泄漏：与 missing 共用同一条不透明文案，不暴露外部记忆 id 的存在性。
  assert.equal(text, `Error: Memory with ID ${foreign.id} was not found.`);
  assert.equal(readRow(foreign.id).status, "active", "跨项目 id 不得被本项目归档");
  assert.equal(mutationRowsFor([foreign.id]).length, 0);
});

test("archive reports missing ids (T-A2) with the same opaque message as ownership", async () => {
  const missingId = 999_999;
  const present = sharedDb
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE id = ?")
    .get(missingId);
  assert.equal(present.count, 0, "本用例需要一个库内不存在的 id");

  const text = await callCtxMemory({ action: "archive", ids: [missingId] });
  assert.equal(text, `Error: Memory with ID ${missingId} was not found.`);
  assert.equal(mutationRowsFor([missingId]).length, 0);
});

test("archive refuses an authority-managed project (T-A2) and rolls the whole batch back", async () => {
  const first = insertMemory("Authority project fact one: managed by the memory module.", {
    projectPath: AUTHORITY_IDENTITY,
  });
  const second = insertMemory("Authority project fact two: managed by the memory module.", {
    projectPath: AUTHORITY_IDENTITY,
  });
  // authority 标记必须在插入记忆之后：标记一旦落表，同项目的 TS 侧写入即被拒。
  sharedDb
    .prepare(
      "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, ?, ?)",
    )
    .run(AUTHORITY_IDENTITY, "test-context-store-uuid", Date.now());

  const text = await callCtxMemory(
    { action: "archive", ids: [first.id, second.id], reason: "authority check" },
    { workingDirectory: AUTHORITY_WORK_DIR, workspaceRoot: AUTHORITY_WORK_DIR },
  );
  // fail-visible：明确拒绝，而不是绕过 authority 表写坏双源（Rust 模块托管项目）。
  assert.equal(
    text,
    "Error: Memory archives for this project are managed by the memory module (MEMORY_MODULE_AUTHORITY); refusing the TypeScript-side archive.",
  );
  // 事务整体回滚：两条都还在 active，mutation 行一条都没有。
  assert.equal(readRow(first.id).status, "active");
  assert.equal(readRow(second.id).status, "active");
  assert.equal(mutationRowsFor([first.id, second.id]).length, 0);
});

// ── 混合批次与边界 ──────────────────────────────────────────────────────────

test("mixed batch partially succeeds: confirmation + per-id lines, mutations only for archived ids", async () => {
  const eligible = insertMemory("Mixed batch: the one fresh id that must be retired.");
  const successor = insertMemory("Mixed batch: the successor of the superseded row.");
  const supersededTarget = insertMemory("Mixed batch: the superseded row.");
  sharedDb
    .prepare("UPDATE memories SET superseded_by_memory_id = ?, status = 'archived' WHERE id = ?")
    .run(successor.id, supersededTarget.id);
  const already = insertMemory("Mixed batch: the pre-archived row.");
  sharedDb.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(already.id);
  const foreign = insertMemory("Mixed batch: a foreign project row.", {
    projectPath: FOREIGN_IDENTITY,
  });
  const missingId = 999_998;

  const text = await callCtxMemory({
    action: "archive",
    ids: [eligible.id, already.id, supersededTarget.id, foreign.id, missingId],
    reason: "mixed batch cleanup",
  });
  assert.equal(
    text,
    [
      `Archived memory [ID: ${eligible.id}] (mixed batch cleanup).`,
      `Memory [ID: ${already.id}] is already archived.`,
      `Error: Memory with ID ${supersededTarget.id} is archived or superseded; restore it before archiving.`,
      `Error: Memory with ID ${foreign.id} was not found.`,
      `Error: Memory with ID ${missingId} was not found.`,
    ].join("\n"),
  );

  assert.equal(readRow(eligible.id).status, "archived");
  assert.equal(mutationRowsFor([eligible.id]).length, 1, "只有真正归档的 id 新增 mutation 行");
  assert.equal(mutationRowsFor([already.id, supersededTarget.id, foreign.id, missingId]).length, 0);
});

test("archive without ids keeps a self-correctable error", async () => {
  assert.equal(
    await callCtxMemory({ action: "archive" }),
    "Error: 'ids' must contain at least one integer memory ID when action is 'archive'.",
  );
});

// ── 回归 smoke：write 路径不受 archive 解锁影响 ─────────────────────────────

test("write stays the default action (regression smoke)", async () => {
  const text = await callCtxMemory({
    content: "Archive test smoke: the retry queue drains every ten seconds.",
    category: "ARCHITECTURE",
  });
  assert.match(text, /^Saved memory \[ID: \d+\] in ARCHITECTURE\.$/);

  // 显式 action:"write" 与缺省走同一条路径、同一确认文案。
  const explicit = await callCtxMemory({
    action: "write",
    content: "Archive test smoke: retries are capped at five attempts.",
    category: "CONSTRAINTS",
  });
  assert.match(explicit, /^Saved memory \[ID: \d+\] in CONSTRAINTS\.$/);
});
