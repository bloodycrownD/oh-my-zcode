#!/usr/bin/env node
/**
 * Step 22 acceptance tests — `/ctx-*` 本地命令。
 *
 * Covers:
 *   - **T-M11 (second half)**: `/ctx-status` 的快照输出格式。temp db 经包 API 造出
 *     一份确定的状态（budget / compartments / dropped / pending），再断言渲染出的
 *     文本逐段包含正确的数字，且段序固定。
 *   - `handlers/ctx.ts` 的两个纯参数解析器（`parseExpandArgs` / `parseRecompArgs`），
 *     以及 `slash-commands.ts` 对四个 `/ctx-*` 名字的识别（**不**回落成 unknown，
 *     也不**不**被转发给 submitPrompt——这就是替代 Effect 204 sentinel 的落点）。
 *
 * 与 S21 的 `scripts/test-ctx-tools.mjs` 共用同一套「临时 db + dist」跑法；本文件
 * 需要 CLI 侧的 TS 源码，故用仓库根的 `tsx` 装载器跑（`node --import tsx`）。
 *
 * Requires Node >= 24 and a prior `pnpm build` of @zcode/magic-context.
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const MC_DIST_ROOT = fileURLToPath(new URL("../../magic-context/dist/", import.meta.url));
const dist = (p) => pathToFileURL(join(MC_DIST_ROOT, p)).href;

const dbDir = mkdtempSync(join(tmpdir(), "magic-context-ctxcmd-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

const { initializeMagicContextHost } = await import(dist("host/harness.js"));
initializeMagicContextHost();

const { openDatabase } = await import(dist("core/features/magic-context/storage-db.js"));
const { insertTag } = await import(dist("core/features/magic-context/storage-tags.js"));
const { queuePendingOp, getPendingOps } = await import(
  dist("core/features/magic-context/storage-ops.js")
);
const { updateSessionMeta } = await import(dist("core/features/magic-context/storage-meta.js"));
const { appendCompartments } = await import(
  dist("core/features/magic-context/compartment-storage.js")
);
const { formatMagicContextStatusSnapshot, readMagicContextStatusSnapshot } = await import(
  dist("host/ctx-status.js")
);
const {
  isMagicContextRecompRunnerRegistered,
  requestMagicContextRecompute,
  setMagicContextRecompRunner,
} = await import(dist("host/ctx-recomp.js"));

// CLI 侧的纯函数与解析器（TS 源码，经 tsx 装载）。
const CLI_SRC = fileURLToPath(new URL("../src/command-center/", import.meta.url));
const { parseSlashCommand } = await import(pathToFileURL(join(CLI_SRC, "slash-commands.ts")).href);
const { parseExpandArgs, parseRecompArgs } = await import(
  pathToFileURL(join(CLI_SRC, "handlers", "ctx.ts")).href
);

const db = openDatabase();
assert.ok(db, "openDatabase() must succeed against the temp store");

const SESSION = "sess_ctx_status";

// ── T-M11 后半：/ctx-status 快照输出格式 ──────────────────────────────────────

test("readMagicContextStatusSnapshot reads budget / compartments / dropped from the store", async () => {
  updateSessionMeta(db, SESSION, {
    lastContextPercentage: 42,
    lastInputTokens: 12_345,
  });
  db.prepare("UPDATE session_meta SET protected_tokens_effective = 4096 WHERE session_id = ?").run(
    SESSION,
  );

  // 6 个 tag：4 active / 2 dropped，token 各 100 / 500。
  for (let n = 1; n <= 6; n += 1) {
    insertTag(db, SESSION, `msg_${n}`, n <= 4 ? "text" : "tool", 64, n, 0, null, 0, null, null, {
      tokenCount: n <= 4 ? 100 : 500,
    });
  }
  db.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number > 4").run(
    SESSION,
  );
  queuePendingOp(db, SESSION, 3, "drop", 1_000);

  appendCompartments(db, SESSION, [
    {
      content: "compacted block one",
      endMessage: 20,
      endMessageId: "msg_end_1",
      sequence: 1,
      startMessage: 1,
      startMessageId: "msg_start_1",
      title: "first",
    },
    {
      content: "compacted block two",
      endMessage: 40,
      endMessageId: "msg_end_2",
      sequence: 2,
      startMessage: 21,
      startMessageId: "msg_start_2",
      title: "second",
    },
  ]);

  const snapshot = await readMagicContextStatusSnapshot({ db, sessionId: SESSION });
  assert.ok(snapshot, "snapshot must be produced for an open db");
  assert.equal(snapshot.sessionId, SESSION);
  assert.equal(snapshot.protectedTokensFloor, 4096);
  assert.equal(snapshot.contextPercentage, 42);
  assert.equal(snapshot.lastInputTokens, 12_345);
  assert.equal(snapshot.compartmentCount, 2);
  assert.equal(snapshot.lastCompartmentEndMessage, 40);
  assert.deepEqual(snapshot.tags.active, { count: 4, tokens: 400 });
  assert.deepEqual(snapshot.tags.dropped, { count: 2, tokens: 1000 });
  assert.deepEqual(snapshot.tags.compacted, { count: 0, tokens: 0 });
  assert.equal(snapshot.pendingOps, 1);

  const text = formatMagicContextStatusSnapshot(snapshot);
  const lines = text.split("\n");
  // 段序固定：标题 / Budget / Compartments / Tags。
  assert.equal(lines[0], "Magic Context status");
  assert.equal(lines[1], `session: ${SESSION}`);
  assert.equal(lines[3], "Budget");
  assert.equal(lines[8], "Compartments");
  assert.equal(lines[12], "Tags");
  // 每段的数字逐条断言——这就是 T-M11 后半要的东西。
  assert.ok(lines.includes("  protected floor: 4096"));
  assert.ok(lines.includes("  last context usage: 42%"));
  assert.ok(lines.includes("  last input tokens: 12345"));
  assert.ok(lines.includes("  count: 2"));
  assert.ok(lines.includes("  last compacted message: 40"));
  assert.ok(lines.includes("  active: 4 (400 tokens)"));
  assert.ok(lines.includes("  dropped: 2 (1000 tokens)"));
  assert.ok(lines.includes("  compacted: 0 (0 tokens)"));
  assert.ok(lines.includes("  pending operations: 1"));
});

test("formatMagicContextStatusSnapshot says so when the store cannot be opened", () => {
  const text = formatMagicContextStatusSnapshot(null);
  assert.match(text, /Magic Context status is temporarily unavailable\./);
  assert.match(text, /MC-S01/);
});

// ── /ctx-recomp 简化语义 ─────────────────────────────────────────────────────

test("/ctx-recomp reports the pre-rebuild state while the runner is unwired", async () => {
  setMagicContextRecompRunner(undefined);
  assert.equal(isMagicContextRecompRunnerRegistered(), false);

  const outcome = await requestMagicContextRecompute({ db, sessionId: SESSION });
  assert.equal(outcome.runner, "unavailable");
  assert.equal(outcome.recompacted, 0);
  assert.equal(outcome.compartmentsBefore, 2);
  assert.deepEqual(outcome.scope, { kind: "full" });
});

test("/ctx-recomp runs the real runner once one is installed", async () => {
  const calls = [];
  setMagicContextRecompRunner(async (input) => {
    calls.push(input);
    return 7;
  });
  assert.equal(isMagicContextRecompRunnerRegistered(), true);

  const outcome = await requestMagicContextRecompute({
    db,
    scope: { end: 40, kind: "partial", start: 21 },
    sessionId: SESSION,
  });
  assert.equal(outcome.runner, "host");
  assert.equal(outcome.recompacted, 7);
  assert.deepEqual(calls, [{ db, range: { end: 40, start: 21 }, sessionId: SESSION }]);

  // runner 抛错也是一条 outcome，不是 rejection。
  setMagicContextRecompRunner(() => {
    throw new Error("historian not wired");
  });
  const failed = await requestMagicContextRecompute({ db, sessionId: SESSION });
  assert.equal(failed.runner, "unavailable");
  assert.equal(failed.recompacted, 0);
  setMagicContextRecompRunner(undefined);
});

// ── handlers 解析 ─────────────────────────────────────────────────────────────

test("parseSlashCommand recognises the four /ctx-* names as known local commands", () => {
  for (const name of ["ctx-status", "ctx-reduce", "ctx-expand", "ctx-recomp"]) {
    assert.deepEqual(parseSlashCommand(`/${name}`), {
      args: "",
      name,
      rawName: name,
      type: "known",
    });
  }
  // 带参数：参数与命令名分开，交给 handler 解析。
  assert.deepEqual(parseSlashCommand("/ctx-reduce 3-5, 8"), {
    args: "3-5, 8",
    name: "ctx-reduce",
    rawName: "ctx-reduce",
    type: "known",
  });
  // 大小写归一化照旧。
  assert.equal(parseSlashCommand("/CTX-Status")?.type, "known");
  // 不是 slash 命令仍然是 null，交给普通 prompt 路径。
  assert.equal(parseSlashCommand("ctx-status"), null);
});

test("parseExpandArgs accepts tag=/message=/ranges/verbose and rejects junk", () => {
  assert.deepEqual(parseExpandArgs("tag=12"), { args: { tag: 12 } });
  assert.deepEqual(parseExpandArgs("tag=§12§"), { args: { tag: "§12§" } });
  assert.deepEqual(parseExpandArgs("message=42"), { args: { message: 42 } });
  assert.deepEqual(parseExpandArgs("10-25"), { args: { end: 25, start: 10 } });
  assert.deepEqual(parseExpandArgs("10-25 verbose"), {
    args: { end: 25, start: 10, verbose: true },
  });
  // 裸数字按 message ordinal 读（tag 必须显式 tag=）。
  assert.deepEqual(parseExpandArgs("42"), { args: { message: 42 } });
  const empty = parseExpandArgs("");
  assert.ok("error" in empty);
  assert.match(empty.error, /Usage: \/ctx-expand/);
  const junk = parseExpandArgs("last tuesday");
  assert.ok("error" in junk);
  assert.match(junk.error, /cannot parse "last"/);
  const badNumber = parseExpandArgs("message=abc");
  assert.ok("error" in badNumber);
  assert.match(badNumber.error, /message must be an integer/);
});

test("parseRecompArgs accepts full / --upgrade / a valid range and rejects the rest", () => {
  assert.deepEqual(parseRecompArgs(""), { kind: "full" });
  assert.deepEqual(parseRecompArgs("full"), { kind: "full" });
  assert.deepEqual(parseRecompArgs("--upgrade"), { kind: "full" });
  assert.deepEqual(parseRecompArgs("10-20"), { end: 20, kind: "partial", start: 10 });
  assert.deepEqual(parseRecompArgs("10 - 20"), { end: 20, kind: "partial", start: 10 });
  const reversed = parseRecompArgs("20-10");
  assert.ok("error" in reversed);
  assert.match(reversed.error, /End must be >= start/);
  const zero = parseRecompArgs("0-10");
  assert.ok("error" in zero);
  assert.match(zero.error, /Start must be >= 1/);
  const junk = parseRecompArgs("everything");
  assert.ok("error" in junk);
  assert.match(junk.error, /Invalid \/ctx-recomp arguments/);
});

// pending_ops 只读断言：/ctx-status 不写库（除了 A 组 getOrCreateSessionMeta 建行）。
test("/ctx-status leaves the pending queue exactly as it found it", async () => {
  const before = getPendingOps(db, SESSION).length;
  await readMagicContextStatusSnapshot({ db, sessionId: SESSION });
  assert.equal(getPendingOps(db, SESSION).length, before);
});

test.after(() => {
  try {
    rmSync(dbDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  } catch (error) {
    console.warn(`could not remove ${dbDir}: ${error && error.message}`);
  }
});
