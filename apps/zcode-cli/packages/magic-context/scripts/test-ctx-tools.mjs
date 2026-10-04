#!/usr/bin/env node
/**
 * Step 21 acceptance tests — D-group ctx tools + the six seams' real bodies.
 *
 * Covers:
 *   - `core/tools/ctx-reduce/**` and `core/tools/ctx-expand/**` executed for real
 *     against a throwaway `magic-context.db` (temp dir via `MAGIC_CONTEXT_DB_DIR`);
 *   - **T-M11 (first half)**: the same `commandId` (same toolCallId) repeated does
 *     NOT enqueue `pending_ops` a second time;
 *   - the seam replacements run for real rather than merely compiling:
 *     `protection-window` (pure walk + live read), `scheduler` (`parseCacheTtl` +
 *     `createScheduler`), `session-cache-ttl` / `model-cache-ttl` (freeze policy),
 *     `user-facing-codes` (renderers), `builtin-commands` (registry + argument gate).
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

const dbDir = mkdtempSync(join(tmpdir(), "magic-context-ctx-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

const { initializeMagicContextHost } = await import(dist("host/harness.js"));
initializeMagicContextHost();

const { openDatabase } = await import(dist("core/features/magic-context/storage-db.js"));
const { insertTag } = await import(dist("core/features/magic-context/storage-tags.js"));
const { getPendingOps } = await import(dist("core/features/magic-context/storage-ops.js"));
const { createCtxReduceTools } = await import(dist("core/tools/ctx-reduce/tools.js"));
const { createCtxExpandTools } = await import(dist("core/tools/ctx-expand/tools.js"));
const { resolveCtxExpandMode } = await import(dist("core/tools/ctx-expand/mode.js"));
const { parseRangeString } = await import(
  dist("core/features/magic-context/range-parser.js")
);
const { parseTagInput } = await import(dist("core/features/magic-context/tag-input.js"));
const {
  computeProtectionWindow,
  getProtectionWindowForSession,
} = await import(dist("core/features/magic-context/protection-window.js"));
const { createScheduler, parseCacheTtl } = await import(
  dist("core/features/magic-context/scheduler.js")
);
const { resolveSessionCacheTtl } = await import(
  dist("core/features/magic-context/session-cache-ttl.js")
);
const { resolveModelCacheTtl } = await import(dist("core/shared/model-cache-ttl.js"));
const {
  renderCapabilityRefusal,
  renderUserFacingFailure,
  USER_FACING_FAILURES,
} = await import(dist("core/shared/user-facing-codes.js"));
const { getMagicContextBuiltinCommands } = await import(
  dist("core/features/builtin-commands/commands.js")
);
const { acceptsMagicContextCommandArguments } = await import(
  dist("core/features/builtin-commands/command-arguments.js")
);

const db = openDatabase();
assert.ok(db, "openDatabase() must succeed against the temp store");

/** Seed a session with `count` tool tags numbered 1..count. */
function seedTags(sessionId, count, tokenCount = 100) {
  for (let n = 1; n <= count; n += 1) {
    insertTag(db, sessionId, `msg_${sessionId}_${n}`, "tool", 128, n, 0, "Bash", 0, `msg_${sessionId}_${n}`, null, {
      tokenCount,
    });
  }
}

// ── range / tag 解析 ──────────────────────────────────────────────────────────

test("parseRangeString handles singles, ranges, lists and copied §N§ handles", () => {
  assert.deepEqual(parseRangeString("5"), [5]);
  assert.deepEqual(parseRangeString("3-5"), [3, 4, 5]);
  assert.deepEqual(parseRangeString("1,2,9"), [1, 2, 9]);
  assert.deepEqual(parseRangeString("1-5,8,12-14"), [1, 2, 3, 4, 5, 8, 12, 13, 14]);
  assert.deepEqual(parseRangeString("§302§-§305§"), [302, 303, 304, 305]);
  assert.deepEqual(parseRangeString("[dropped §7§], tag 9"), [7, 9]);
  assert.throws(() => parseRangeString("5-1"), /must be <= end/);
  assert.throws(() => parseRangeString(""), /must not be empty/);
});

test("parseTagInput accepts only one positive integer", () => {
  assert.equal(parseTagInput(12), 12);
  assert.equal(parseTagInput("12"), 12);
  assert.equal(parseTagInput("§12§"), 12);
  assert.equal(parseTagInput("§12"), 12);
  assert.equal(parseTagInput("tag 12"), 12);
  assert.equal(parseTagInput("[dropped §12§]"), 12);
  assert.throws(() => parseTagInput("1 and 2"), /tag must be one positive integer/);
  assert.throws(() => parseTagInput(0), /tag must be one positive integer/);
});

// ── ctx_reduce ───────────────────────────────────────────────────────────────

test("ctx_reduce queues pending ops for known tags", async () => {
  const sessionId = "sess_reduce_basic";
  seedTags(sessionId, 5);
  const tools = createCtxReduceTools({ db, protectedSet: new Set() });

  const text = await tools.ctx_reduce.execute(
    { drop: "1,2" },
    { callID: "call-basic", sessionID: sessionId },
  );

  assert.match(text, /^Queued: drop §1§, §2§\./);
  assert.deepEqual(
    getPendingOps(db, sessionId).map((op) => op.tagId),
    [1, 2],
  );
});

test("ctx_reduce rejects unknown tags without touching the queue", async () => {
  const sessionId = "sess_reduce_unknown";
  seedTags(sessionId, 2);
  const tools = createCtxReduceTools({ db, protectedSet: new Set() });

  const text = await tools.ctx_reduce.execute(
    { drop: "1,9" },
    { callID: "call-unknown", sessionID: sessionId },
  );

  assert.match(text, /^Error: Unknown tag\(s\) §9§\./);
  assert.equal(getPendingOps(db, sessionId).length, 0);
});

test("ctx_reduce reports an invalid range as an ordinary field error", async () => {
  const sessionId = "sess_reduce_range";
  seedTags(sessionId, 2);
  const tools = createCtxReduceTools({ db, protectedSet: new Set() });

  const text = await tools.ctx_reduce.execute(
    { drop: "9-1" },
    { callID: "call-range", sessionID: sessionId },
  );

  assert.match(text, /^Error: Invalid range syntax\./);
  assert.equal(getPendingOps(db, sessionId).length, 0);
});

test("T-M11: the same commandId does not enqueue pending_ops twice", async () => {
  const sessionId = "sess_reduce_idempotent";
  seedTags(sessionId, 4);
  const tools = createCtxReduceTools({ db, protectedSet: new Set() });
  const context = { callID: "call-idempotent", sessionID: sessionId };

  const first = await tools.ctx_reduce.execute({ drop: "1-3" }, context);
  const afterFirst = getPendingOps(db, sessionId);
  const second = await tools.ctx_reduce.execute({ drop: "1-3" }, context);
  const afterSecond = getPendingOps(db, sessionId);

  assert.match(first, /^Queued: drop §1§, §2§, §3§\./);
  // 第二次回放的是第一次的确认文本：逐字节相同，模型看到的是稳定的确认。
  assert.equal(second, first);
  assert.equal(afterFirst.length, 3);
  assert.equal(afterSecond.length, 3, "a repeated commandId must not enqueue again");
  assert.deepEqual(
    afterSecond.map((op) => op.tagId),
    [1, 2, 3],
  );
});

test("T-M11: a different commandId over the same tags still enqueues nothing new", async () => {
  const sessionId = "sess_reduce_second_id";
  seedTags(sessionId, 3);
  const tools = createCtxReduceTools({ db, protectedSet: new Set() });

  await tools.ctx_reduce.execute(
    { drop: "1,2" },
    { callID: "call-a", sessionID: sessionId },
  );
  const second = await tools.ctx_reduce.execute(
    { drop: "1,2" },
    { callID: "call-b", sessionID: sessionId },
  );

  // 幂等不只靠 commandId：已排队的 tag 被 pre-filter 滤掉，第二次如实回答「无需动作」。
  assert.match(second, /All requested tags were already queued or processed\./);
  assert.equal(getPendingOps(db, sessionId).length, 2);
});

test("ctx_reduce holds tags inside the protected working set", async () => {
  const sessionId = "sess_reduce_held";
  seedTags(sessionId, 4);
  const tools = createCtxReduceTools({ db, protectedSet: new Set([1, 2]) });

  const text = await tools.ctx_reduce.execute(
    { drop: "1-4" },
    { callID: "call-held", sessionID: sessionId },
  );

  assert.match(text, /^Queued: drop §3§, §4§\./);
  assert.match(text, /Held: §1, §2 are inside the protected working set/);
  // held 的两个仍然入队（上游语义：held 只是「等更新的工作挤掉它」）。
  assert.equal(getPendingOps(db, sessionId).length, 4);
});

test("ctx_reduce without drop is an ordinary field error", async () => {
  const sessionId = "sess_reduce_nodrop";
  seedTags(sessionId, 1);
  const tools = createCtxReduceTools({ db, protectedSet: new Set() });
  const text = await tools.ctx_reduce.execute({}, { callID: "c", sessionID: sessionId });
  assert.equal(text, "Error: 'drop' must be provided.");
});

// ── ctx_expand ───────────────────────────────────────────────────────────────

test("resolveCtxExpandMode picks tag / message / range and rejects filler pairs", () => {
  assert.deepEqual(resolveCtxExpandMode({ tag: 12 }, "positive"), { kind: "tag", tag: 12 });
  assert.deepEqual(resolveCtxExpandMode({ message: 5 }, "positive"), {
    kind: "message",
    message: 5,
  });
  assert.deepEqual(resolveCtxExpandMode({ start: 3, end: 9 }, "positive"), {
    kind: "range",
    start: 3,
    end: 9,
    verbose: false,
  });
  // 必填字段被模型用占位符填满（start=end=0）时，具名 message 仍然胜出。
  assert.deepEqual(resolveCtxExpandMode({ message: 7, start: 0, end: 0 }, "positive"), {
    kind: "message",
    message: 7,
  });
  const mixed = resolveCtxExpandMode({ tag: 3, start: 4 }, "positive");
  assert.equal(mixed.kind, "error");
  assert.match(mixed.message, /use tag alone/);
  const empty = resolveCtxExpandMode({}, "positive");
  assert.equal(empty.kind, "error");
  assert.match(empty.message, /provide either message=<ordinal>, or start and end/);
});

test("ctx_expand reports a missing ordinal honestly", async () => {
  const sessionId = "sess_expand_missing";
  const tools = createCtxExpandTools({ db });
  const text = await tools.ctx_expand.execute(
    { message: 4242 },
    { callID: "c", sessionID: sessionId },
  );
  assert.match(text, /No message at ordinal 4242/);
});

test("ctx_expand reports an unknown tag with the ordinal hint", async () => {
  const sessionId = "sess_expand_tag";
  seedTags(sessionId, 2);
  const tools = createCtxExpandTools({ db });
  const text = await tools.ctx_expand.execute(
    { tag: 99 },
    { callID: "c", sessionID: sessionId },
  );
  assert.match(text, /no tag 99 in this session/);
  assert.match(text, /use message=99/);
});

// ── 缝替换真身：protection-window ─────────────────────────────────────────────

test("computeProtectionWindow is bounded by floor mass and the newest-3 minimum", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ tag_number: n, type: "tool", token_count: 10 }));
  // floor 远大于全部质量：质量走完整列 → mass_cutoff=1，再与 newest3(=3) 取 min → 1。
  const wide = computeProtectionWindow(rows, 1000);
  assert.equal(wide.cutoff, 1);
  assert.equal(wide.status.protectedCount, 5);
  // floor 只够最新两条：质量在 tag 4 处越过 → mass_cutoff=4，与 newest3(=3) 取 min → 3。
  const narrow = computeProtectionWindow(rows, 25);
  assert.equal(narrow.cutoff, 3);
  assert.deepEqual([...narrow.protectedTagNumbers].sort((a, b) => a - b), [3, 4, 5]);
  assert.equal(narrow.status.protectedCount, 3);
  assert.equal(narrow.isProtected({ tag_number: 2, type: "tool" }), false);
  assert.equal(narrow.isProtected({ tag_number: 5, type: "tool" }), true);
});

test("computeProtectionWindow is empty when no tool rows exist", () => {
  const window = computeProtectionWindow([{ tag_number: 1, type: "text", token_count: 5 }], 10);
  assert.equal(window.cutoff, null);
  assert.equal(window.isProtected({ tag_number: 1, type: "tool" }), false);
});

test("getProtectionWindowForSession reads the live store", () => {
  const sessionId = "sess_window";
  seedTags(sessionId, 4, 500);
  // floor 直接喂给函数参数（会话 meta 的 epoch floor 快照由 transform 侧负责冻结）。
  const window = getProtectionWindowForSession(db, sessionId, 100);
  assert.ok(window.cutoff !== null && window.cutoff > 0);
  assert.ok(window.protectedTagNumbers.has(4));
});

// ── 缝替换真身：scheduler / cache TTL ─────────────────────────────────────────

test("parseCacheTtl reads units, bare millis and the never sentinel", () => {
  assert.equal(parseCacheTtl("5m"), 300_000);
  assert.equal(parseCacheTtl("90s"), 90_000);
  assert.equal(parseCacheTtl("2h"), 7_200_000);
  assert.equal(parseCacheTtl("500"), 500);
  assert.equal(parseCacheTtl("never"), Number.POSITIVE_INFINITY);
  assert.throws(() => parseCacheTtl("soon"), /Invalid cache TTL format/);
});

test("createScheduler defers a brand-new session and executes over the threshold", () => {
  const scheduler = createScheduler({ executeThresholdPercentage: 50 });
  const fresh = { cacheTtl: "5m", lastResponseTime: 0 };
  const contextUsage = { inputTokens: 0, percentage: 0 };
  assert.equal(scheduler.shouldExecute(fresh, contextUsage), "defer");
  assert.equal(
    scheduler.shouldExecute({ cacheTtl: "5m", lastResponseTime: Date.now() }, {
      inputTokens: 9000,
      percentage: 80,
    }),
    "execute",
  );
  assert.equal(
    scheduler.shouldExecute({ cacheTtl: "5m", lastResponseTime: Date.now() }, {
      inputTokens: 1000,
      percentage: 10,
    }),
    "defer",
  );
});

test("cache TTL freezes per session once the model is known", () => {
  assert.equal(resolveModelCacheTtl(undefined, undefined).value, "5m");
  // 非 5m 的全局字符串是一条显式策略，优先于 provider 寿命表。
  assert.equal(resolveModelCacheTtl("45m", "openai/gpt-5.6-mini").value, "45m");
  assert.equal(resolveModelCacheTtl("45m", "openai/gpt-5.6-mini").source, "config");
  // 无显式策略时按 provider 文档化的寿命表给 GPT-5.6+。
  assert.equal(resolveModelCacheTtl(undefined, "openai/gpt-5.6").value, "30m");
  assert.equal(resolveModelCacheTtl(undefined, "openai/gpt-5.6").source, "OpenAI GPT-5.6+ default");
  assert.equal(resolveModelCacheTtl(undefined, "openai/gpt-4o").value, "5m");

  const sessionId = "sess_cache_ttl";
  const first = resolveSessionCacheTtl(db, sessionId, undefined, "openai/gpt-5.6-mini");
  assert.equal(first.value, "30m");
  // 重读必须拿到同一个冻结值，而不是按新 config 再推一次（这正是持久化它的理由）。
  assert.equal(resolveSessionCacheTtl(db, sessionId, "45m", "openai/gpt-5.6-mini").value, "30m");
});

// ── 缝替换真身：user-facing-codes / builtin-commands ──────────────────────────

test("user-facing renderers keep their stable codes", () => {
  assert.equal(USER_FACING_FAILURES.context_cleanup_paused.code, "MC-C05");
  assert.match(renderCapabilityRefusal("context_cleanup"), /\(MC-C05\)$/);
  assert.match(
    renderUserFacingFailure("history_boundary_unresolved", "plain"),
    /Run \/ctx-recomp to rebuild the history summary\. \(MC-H04\)$/,
  );
  // plain 档去掉 markdown 反引号。
  assert.ok(!renderUserFacingFailure("dreamer_tick_blocked", "plain").includes("`"));
});

test("builtin-commands registry and its argument gate", () => {
  const registry = getMagicContextBuiltinCommands();
  for (const name of ["ctx-status", "ctx-recomp", "ctx-wrapup", "ctx-flush", "ctx-dream", "ctx-embed"]) {
    assert.ok(Object.hasOwn(registry, name), `${name} must be registered`);
  }
  assert.match(getMagicContextBuiltinCommands(false)["ctx-recomp"].description, /Unavailable when/);
  assert.equal(acceptsMagicContextCommandArguments("ctx-status", ""), true);
  assert.equal(acceptsMagicContextCommandArguments("ctx-status", "diagnostics"), true);
  assert.equal(acceptsMagicContextCommandArguments("ctx-status", "rebuild"), false);
  assert.equal(acceptsMagicContextCommandArguments("ctx-recomp", ""), true);
  assert.equal(acceptsMagicContextCommandArguments("ctx-recomp", "10-20"), true);
  assert.equal(acceptsMagicContextCommandArguments("ctx-recomp", "20-10"), false);
  assert.equal(acceptsMagicContextCommandArguments("ctx-flush", "now"), false);
  assert.equal(acceptsMagicContextCommandArguments("ctx-embed", "pause"), true);
  assert.equal(acceptsMagicContextCommandArguments("ctx-embed", "purge"), false);
});

test.after(() => {
  // db 句柄仍开着时 Windows 会拒绝删除临时目录；残留一个临时目录不该把通过的套件变成失败的。
  try {
    rmSync(dbDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  } catch (error) {
    console.warn(`could not remove ${dbDir}: ${error && error.message}`);
  }
});