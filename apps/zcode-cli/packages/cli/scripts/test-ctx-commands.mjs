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
 *   - **MF-06**：`handleCtxCommand` 的 effective 门——off 态四条命令全回
 *     UNAVAILABLE 且**一条 db 都不建**；on 态 `/ctx-reduce` 写出的
 *     `pending_ops.harness` 归一为 `"zcode"`（自建工具路径不经过装配层的
 *     `initializeMagicContextHost()`）。
 *
 * 与 S21 的 `scripts/test-ctx-tools.mjs` 共用同一套「临时 db + dist」跑法；本文件
 * 需要 CLI 侧的 TS 源码，故用仓库根的 `tsx` 装载器跑（`node --import tsx`）。
 *
 * Requires Node >= 24 and a prior `pnpm build` of @zcode/magic-context.
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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

// harness 归一要断言的是「自建工具路径写出的行归到 zcode」，所以这里要能把 harness
// 打回默认的 "opencode" 再让命令面自己归一——否则断言的是文件顶部的初始化，纯同义反复。
const { _resetHarnessForTesting } = await import(dist("core/shared/harness.js"));
const { __resetHostInitializationForTests } = await import(dist("host/harness.js"));

// CLI 侧的纯函数与解析器（TS 源码，经 tsx 装载）。
const CLI_SRC = fileURLToPath(new URL("../src/command-center/", import.meta.url));
const { parseSlashCommand } = await import(pathToFileURL(join(CLI_SRC, "slash-commands.ts")).href);
const { parseExpandArgs, parseRecompArgs, formatCtxStatus, handleCtxCommand } = await import(
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

// ── Step 30 / D-13：宿主侧排版 ────────────────────────────────────────────────
//
// 包侧的 `formatMagicContextStatusSnapshot` 保留不动（它仍是被断言的包内渲染）；命令
// 真正打给用户的那段文本从 Step 30 起由 CLI 侧的 `formatCtxStatus` 产出。这一节钉住
// 「同一份快照、同一批数字、只是更好读」，而不是另造一份数据。

test("formatCtxStatus renders the same snapshot in aligned sections", async () => {
  const snapshot = await readMagicContextStatusSnapshot({ db, sessionId: SESSION });
  assert.ok(snapshot);
  const lines = formatCtxStatus(snapshot).split("\n");

  assert.equal(lines[0], "Magic Context status");
  assert.equal(lines[1], `session  ${SESSION}`);
  assert.equal(lines[2], "");
  // 三段标题各占一段，段间恰好一个空行。
  assert.deepEqual(
    lines.filter((line) => line === ""),
    ["", "", ""],
  );
  const titles = lines.filter((line) => ["BUDGET", "COMPARTMENTS", "TAGS"].includes(line));
  assert.deepEqual(titles, ["BUDGET", "COMPARTMENTS", "TAGS"]);

  // 数字与包侧渲染逐条一致，只是加了千分位并按段对齐。
  assert.ok(lines.includes("  protected floor     4,096"));
  assert.ok(lines.includes("  last context usage  42%"));
  assert.ok(lines.includes("  last input tokens   12,345"));
  assert.ok(lines.includes("  count                   2"));
  assert.ok(lines.includes("  last compacted message  40"));
  assert.ok(lines.includes("  pending operations      1"));
  assert.ok(lines.includes("  active     4 (400 tokens)"));
  assert.ok(lines.includes("  dropped    2 (1,000 tokens)"));
  assert.ok(lines.includes("  compacted  0 (0 tokens)"));

  // 同一段里的值列起始位置一致——这正是 Step 30 要的可读性。
  const valueColumnOf = (line) => line.length - line.trimStart().length + line.trim().search(/\S\S+/);
  for (const title of ["BUDGET", "COMPARTMENTS", "TAGS"]) {
    const start = lines.indexOf(title) + 1;
    const body = lines.slice(start).filter((line) => line.startsWith("  "));
    const columns = new Set(body.map(valueColumnOf));
    assert.equal(columns.size, 1, `${title} 段内的值列必须对齐（实际 ${[...columns]}）`);
  }
});

test("formatCtxStatus prints an em-dash-style unknown and one line when nothing is readable", async () => {
  const snapshot = await readMagicContextStatusSnapshot({ db, sessionId: "sess_never_seen" });
  assert.ok(snapshot);
  assert.equal(snapshot.protectedTokensFloor, null);
  const lines = formatCtxStatus(snapshot).split("\n");
  assert.ok(lines.includes("  protected floor     -"), "未知值统一渲染成 -");
  assert.ok(lines.includes("  last compacted message  -1"), "从未压缩过的会话是 -1，不是 0");

  const unavailable = formatCtxStatus(null);
  assert.equal(unavailable, "Magic Context status unavailable for this session.");
  assert.equal(unavailable.split("\n").length, 1);
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

// ── MF-06：effective 开关 + harness 归一 ─────────────────────────────────────
//
// 命令面**不开库**的 off 态、以及 `/ctx-reduce` 自建工具路径上的 harness 归一，都只能
// 从命令这一层观测：单测里没有 turn-loop，也没有真实 features 配置。effective 的值
// 由 `app.isMagicContextEnabled?.()` 给（MF-01 在 create-app 里填的同一个求值结果）。

const UNAVAILABLE_RE = /Magic Context is not available in this session/;

/** 造一份最小 deps：`getApp` 给出一个只声明自己能力面的 app。 */
function depsForApp(app) {
  return { getApp: async () => app };
}

test("off 态：四条 /ctx-* 都回 UNAVAILABLE，且一条 db 都不建", async () => {
  // 指向一条谁也没碰过的路径：命令面若偷跑 openDatabase，这里就会多出文件。
  const virginDbPath = join(mkdtempSync(join(tmpdir(), "magic-context-ctxcmd-off-")), "off.db");
  const previousOverride = process.env.MAGIC_CONTEXT_DB_PATH;
  process.env.MAGIC_CONTEXT_DB_PATH = virginDbPath;

  try {
    for (const enabled of [false, undefined]) {
      const app = {
        sessionId: "sess_ctx_off",
        ...(enabled === undefined ? {} : { isMagicContextEnabled: () => enabled }),
      };
      const deps = depsForApp(app);
      // 参数也给足：`/ctx-reduce` 无参走的是用法提示分支，off 态不该从那里漏出去。
      for (const [name, args] of [
        ["ctx-status", ""],
        ["ctx-reduce", "3-5"],
        ["ctx-expand", "10-20"],
        ["ctx-recomp", "full"],
      ]) {
        const result = await handleCtxCommand(name, args, deps);
        assert.match(result.response, UNAVAILABLE_RE, `${name} 在 off 态必须回 UNAVAILABLE`);
        // 连 usage 都不给：功能没开的时候讲用法是噪音。
        assert.doesNotMatch(result.response, /Usage: \/ctx-/);
      }
    }

    assert.equal(
      existsSync(virginDbPath),
      false,
      "off 态不许建库——openDatabase 一旦发生，这里就会多出 off.db（可能还有 -wal/-shm）",
    );
  } finally {
    if (previousOverride === undefined) delete process.env.MAGIC_CONTEXT_DB_PATH;
    else process.env.MAGIC_CONTEXT_DB_PATH = previousOverride;
    rmSync(dirname(virginDbPath), { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("off 态的 effective 只认 app.isMagicContextEnabled，不看别的", async () => {
  // 能力缺席（旧嵌入方）按「关」处理：`getApp` 抛错同样按「关」处理。
  const absent = await handleCtxCommand(
    "ctx-status",
    "",
    depsForApp({ sessionId: "sess_ctx_off" }),
  );
  assert.match(absent.response, UNAVAILABLE_RE);

  const failing = await handleCtxCommand("ctx-status", "", {
    getApp: async () => {
      throw new Error("app not ready");
    },
  });
  assert.match(failing.response, UNAVAILABLE_RE);

  // 开了才放行——放行后的落点由下一条用例兜。
  const on = await handleCtxCommand(
    "ctx-status",
    "",
    depsForApp({
      isMagicContextEnabled: () => true,
      sessionId: SESSION,
    }),
  );
  assert.doesNotMatch(on.response, UNAVAILABLE_RE);
});

test("on 态：/ctx-reduce 的 pending_ops.harness 归一为 zcode", async () => {
  // 把 harness 打回 core 的默认值 "opencode"，模拟「自建工具路径先于装配层跑到」的
  // 那一瞬；命令面必须自己在碰库之前把身份装回去。
  _resetHarnessForTesting();
  __resetHostInitializationForTests();

  const sessionId = "sess_ctx_reduce_harness";
  insertTag(db, sessionId, "msg_1", "text", 64, 1, 0, null, 0, null, null, { tokenCount: 10 });

  const deps = depsForApp({ isMagicContextEnabled: () => true, sessionId });
  const result = await handleCtxCommand("ctx-reduce", "1", deps);
  assert.match(result.response, /Queued: drop/, `/ctx-reduce 应排队而不是报错：${result.response}`);

  const rows = db
    .prepare("SELECT harness FROM pending_ops WHERE session_id = ? ORDER BY id")
    .all(sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].harness, "zcode", "pending_ops 必须归到 zcode，而不是 core 默认的 opencode");

  // 归一之后留在进程里的也必须是 zcode（幂等、不回退）。
  const { getHarness } = await import(dist("core/shared/harness.js"));
  assert.equal(getHarness(), "zcode");
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
