#!/usr/bin/env node
/**
 * Step 10（D4+D14）handler 层验收 —— `ctx_search` / `ctx_memory` 的 ZCode 侧
 * 薄封装（`../src/tool/handlers/ctx-search.ts` / `ctx-memory.ts`）与注册链。
 *
 * 覆盖：
 *   - **T-MC2（auto 部分）**：ctx_search 关键词命中并返回记忆条目；无向量路径；
 *   - **D14**：ctx_memory 写入面——首插确认、commandId 幂等（同 toolCallId 重放
 *     不二次写入、不涨 seen_count）、内容级去重（insertMemoryIdempotent）；
 *   - **注册链**：`builtInTools` 名册含两个新工具；`includeMagicContextTools`
 *     门语义（false = 四个 ctx 工具全部缺席，true = 全部在场）；
 *   - **drift guard**：contracts 的 `CTX_MEMORY_CATEGORIES` 与包内
 *     `V2_MEMORY_CATEGORIES` 一致（改一边必须同步另一边，否则模型会拿到一个
 *     storage-memory 写不进去的分类）。
 *
 * 运行方式：`npx tsx --test scripts/test-ctx-search-memory.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码，与同目录 ctx-tool-descriptions 测试
 *  同范式）。**前置构建**：`@zcode/contracts` 与 `@zcode/magic-context` 的 dist
 *  必须存在——handler 动态 import 的是包侧编译产物。
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

const dbDir = mkdtempSync(join(tmpdir(), "zcode-ctx-search-memory-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

const {
  CTX_EXPAND_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
  CTX_MEMORY_CATEGORIES,
  CTX_REDUCE_TOOL_NAME,
  CTX_SEARCH_TOOL_NAME,
} = await import("@zcode/contracts");
const { builtInTools, registerBuiltInTools } = await import("../src/tool/handlers/index.js");
const { ctxMemoryToolEntry } = await import("../src/tool/handlers/ctx-memory.js");
const { ctxSearchToolEntry } = await import("../src/tool/handlers/ctx-search.js");
const magicContext = await import("@zcode/magic-context");

magicContext.initializeMagicContextHost();

const WORK_DIR = mkdtempSync(join(tmpdir(), "zcode-ctx-work-"));
/** MF-CTX-3：第二个项目身份，用于 id 短路路的跨项目不可见断言。 */
const FOREIGN_WORK_DIR = mkdtempSync(join(tmpdir(), "zcode-ctx-foreign-"));
const SESSION_ID = "sess_ctx_search_memory";

// openDatabase 按路径缓存句柄：整个测试进程共用同一个 handle（与生产同语义），
// 因此**不 close**——关掉会毒化缓存，让后续 openDatabase 拿到已关闭的句柄。
const sharedDb = magicContext.openDatabase(magicContext.getMagicContextDatabasePath());
assert.ok(sharedDb, "openDatabase() must succeed against the temp store");

function readMemories() {
  return sharedDb
    .prepare("SELECT id, project_path, category, content, seen_count FROM memories ORDER BY id")
    .all();
}

/** handler 的最小 ToolExecutionContext 投影（只用到三个字段）。 */
function toolContext(overrides = {}) {
  return {
    toolCallId: "call_ctx_search_memory",
    sessionId: SESSION_ID,
    workingDirectory: WORK_DIR,
    workspaceRoot: WORK_DIR,
    abortSignal: new AbortController().signal,
    traceId: "trace_ctx",
    ...overrides,
  };
}

let callSeq = 0;
/**
 * 每次逻辑调用默认拿一个**新的** toolCallId：commandId 账本按 toolCallId 记，
 * 复用默认 id 会让第二次写入被误判成重放。需要验证重放的用例显式传同一个 id。
 */
async function write(handler, args, overrides = {}) {
  callSeq += 1;
  const result = await handler(
    args,
    toolContext({ toolCallId: `call_ctx_${callSeq}`, ...overrides }),
  );
  return result.text;
}

process.on("exit", () => {
  // 先关句柄再删目录：Windows 上开着的 sqlite 句柄会让 rmSync 抛 EPERM。
  try {
    sharedDb.close();
  } catch {
    // 关闭失败不改变测试结论。
  }
  for (const dir of [dbDir, WORK_DIR, FOREIGN_WORK_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录残留不污染真实存储（MAGIC_CONTEXT_DB_DIR 已隔离）。
    }
  }
});

// ── 注册链 ───────────────────────────────────────────────────────────────────

test("registration: builtInTools carries both new ctx tools beside the existing pair", () => {
  const names = builtInTools.map((entry) => entry.metadata.name);
  for (const name of [
    CTX_REDUCE_TOOL_NAME,
    CTX_EXPAND_TOOL_NAME,
    CTX_SEARCH_TOOL_NAME,
    CTX_MEMORY_TOOL_NAME,
  ]) {
    assert.ok(names.includes(name), `${name} must be in builtInTools`);
  }
  assert.equal(ctxSearchToolEntry.metadata.name, CTX_SEARCH_TOOL_NAME);
  assert.equal(ctxMemoryToolEntry.metadata.name, CTX_MEMORY_TOOL_NAME);
});

test("registration: includeMagicContextTools gates all four ctx tools together", () => {
  const register = (options) => {
    const registered = [];
    registerBuiltInTools({ register: (entry) => registered.push(entry.metadata.name) }, options);
    return registered;
  };

  const off = register({ includeMagicContextTools: false });
  for (const name of [
    CTX_REDUCE_TOOL_NAME,
    CTX_EXPAND_TOOL_NAME,
    CTX_SEARCH_TOOL_NAME,
    CTX_MEMORY_TOOL_NAME,
  ]) {
    assert.ok(!off.includes(name), `${name} must stay out when the gate is off`);
  }
  // 门关时其余工具不受影响（只过滤 ctx_*）。
  assert.ok(off.includes("Read"));

  const on = register({ includeMagicContextTools: true });
  for (const name of [
    CTX_REDUCE_TOOL_NAME,
    CTX_EXPAND_TOOL_NAME,
    CTX_SEARCH_TOOL_NAME,
    CTX_MEMORY_TOOL_NAME,
  ]) {
    assert.ok(on.includes(name), `${name} must register when the gate is on`);
  }
});

test("drift guard: contracts category enum matches the package's V2 list", () => {
  // 契约层枚举与包内写入面分类集必须一致：模型拿到一个 storage-memory 写不进去
  // 的分类，就是一次必然失败的调用。
  assert.deepEqual([...CTX_MEMORY_CATEGORIES], [...magicContext.V2_MEMORY_CATEGORIES]);
});

// ── ctx_memory 写入面（D14） ─────────────────────────────────────────────────

test("ctx_memory writes one memory and confirms with its id", async () => {
  const text = await write(ctxMemoryToolEntry.handler, {
    content: "The staging database is wiped every Sunday at 03:00 UTC.",
    category: "CONFIG_VALUES",
  });
  assert.match(text, /^Saved memory \[ID: \d+\] in CONFIG_VALUES\.$/);

  const rows = readMemories();
  const written = rows.find((row) => row.content.includes("staging database"));
  assert.ok(written, "the memory row must exist in the store");
  assert.equal(written.category, "CONFIG_VALUES");
  assert.equal(written.seen_count, 1);
});

test("ctx_memory is idempotent per toolCallId: a replay writes nothing new", async () => {
  // 显式复用同一个 toolCallId = 模拟 provider 重试 / executor 重放的同一笔调用。
  const callId = "call_ctx_memory_replay";
  const args = {
    content: "Feature flags are read from flags.json at boot.",
    category: "CONFIG_VALUES",
  };
  const first = await write(ctxMemoryToolEntry.handler, args, { toolCallId: callId });
  const rowsAfterFirst = readMemories().filter((row) => row.content.includes("flags.json"));

  const replay = await write(ctxMemoryToolEntry.handler, args, { toolCallId: callId });
  assert.equal(replay, first);

  const rowsAfterReplay = readMemories().filter((row) => row.content.includes("flags.json"));
  assert.equal(rowsAfterReplay.length, rowsAfterFirst.length);
  assert.equal(rowsAfterReplay[0].seen_count, rowsAfterFirst[0].seen_count);
});

test("ctx_memory dedups by content across toolCallIds (seen count bumps once)", async () => {
  const first = await write(ctxMemoryToolEntry.handler, {
    content: "All HTTP calls go through the shared retry client.",
    category: "CONSTRAINTS",
  });
  assert.match(first, /^Saved memory/);

  const second = await write(ctxMemoryToolEntry.handler, {
    // 归一化只做 trim + 空白折叠 + 小写：大小写不同、标点相同 → 同一事实。
    content: "all http calls go through the shared retry client.",
    category: "CONSTRAINTS",
  });
  assert.match(
    second,
    /^Memory already exists \[ID: \d+\] in CONSTRAINTS \(seen count incremented\)\.$/,
  );

  const rows = readMemories().filter((row) => row.content.includes("retry client"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seen_count, 2);
});

test("ctx_memory rejects missing fields with self-correctable errors", async () => {
  assert.match(
    await write(ctxMemoryToolEntry.handler, { category: "NAMING" }),
    /Error: 'content' is required when action is 'write'\./,
  );
  assert.match(
    await write(ctxMemoryToolEntry.handler, { content: "A fact without a category." }),
    /Error: 'category' is required when action is 'write'\./,
  );
  // 显式 action:"write" 与省略 action 走同一条路径。
  assert.match(
    await write(ctxMemoryToolEntry.handler, {
      action: "write",
      content: "Tables are named in snake_case plural.",
      category: "NAMING",
    }),
    /^Saved memory/,
  );
});

// ── ctx_search 检索面（D4 / T-MC2） ──────────────────────────────────────────

test("ctx_search returns the written memory by keywords", async () => {
  await write(ctxMemoryToolEntry.handler, {
    content: "The invoice PDF template lives at templates/invoice.hbs.",
    category: "CONFIG_VALUES",
  });

  const text = await write(ctxSearchToolEntry.handler, { query: "invoice PDF template" });
  assert.match(text, /^Found 1 result for "invoice PDF template":/);
  assert.match(text, /templates\/invoice\.hbs/);
  assert.match(text, /\[1\] \[memory\] id=#\d+ category=CONFIG_VALUES/);
});

test("ctx_search resolves an id-shaped query directly and ignores other projects", async () => {
  await write(ctxMemoryToolEntry.handler, {
    content: "Cron schedule for the nightly export is 02:15.",
    category: "CONFIG_VALUES",
  });
  const rows = readMemories();
  const target = rows.find((row) => row.content.includes("nightly export"));
  assert.ok(target);

  const byHash = await write(ctxSearchToolEntry.handler, { query: `#${target.id}` });
  assert.match(byHash, new RegExp(`id=#${target.id}`));
  assert.match(byHash, /nightly export/);

  // MF-CTX-3：用例名的 "ignores other projects" 必须有断言在场。id 短路路的
  // 身份过滤由 storedPathBelongsToIdentity 完成（getMemoriesByIds 不做任何
  // 过滤，见 storage-memory.ts:980-986）——foreign 项目的同 id 行不得因
  // 「数字解析成功」漏回来。
  const foreignIdentity = magicContext.resolveProjectIdentityForSession(FOREIGN_WORK_DIR);
  assert.ok(
    foreignIdentity !== undefined,
    "foreign 临时目录必须能解析 identity，否则本断言空转",
  );
  const foreign = magicContext
    .insertMemoryIdempotent(sharedDb, {
      projectPath: foreignIdentity,
      category: "CONFIG_VALUES",
      content: "Foreign project secret: rotate the build token every Friday.",
      sourceType: "historian",
    })
    .memory.id;
  const foreignById = await write(ctxSearchToolEntry.handler, { query: `#${foreign}` });
  assert.match(
    foreignById,
    /No results found/,
    "foreign 项目的 id 不得经本项目的 id 直查可见（身份过滤必须在场）",
  );

  // MF-CTX-1 验收：id 短路路的可见性谓词必须与 FTS 路一致（修复前三值枚举
  // 恒真，archived 会被短路路捞回）。archived / expired → No results found；
  // active → 直查命中。
  const identity = magicContext.resolveProjectIdentityForSession(WORK_DIR);
  assert.ok(identity !== undefined, "本项目目录必须能解析 identity");
  const archivedId = magicContext
    .insertMemoryIdempotent(sharedDb, {
      projectPath: identity,
      category: "NAMING",
      content: "Archived fact: legacy module layout naming.",
      sourceType: "historian",
    })
    .memory.id;
  sharedDb.prepare("UPDATE memories SET status = ? WHERE id = ?").run("archived", archivedId);
  assert.match(
    await write(ctxSearchToolEntry.handler, { query: `#${archivedId}` }),
    /No results found/,
    "archived 记忆不得经 id 短路捞回（与 FTS 的 status 过滤一致）",
  );

  const expiredId = magicContext
    .insertMemoryIdempotent(sharedDb, {
      projectPath: identity,
      category: "NAMING",
      content: "Expired fact: temporary naming during the migration.",
      sourceType: "historian",
      expiresAt: 1,
    })
    .memory.id;
  assert.match(
    await write(ctxSearchToolEntry.handler, { query: `#${expiredId}` }),
    /No results found/,
    "expired 记忆不得经 id 短路捞回（expires_at 已过）",
  );

  // 纯数字 query 在 id 解析不到时落回 FTS（不是错误）。
  const fallback = await write(ctxSearchToolEntry.handler, { query: "999999" });
  assert.match(fallback, /No results found/);
});

test("ctx_search honors limit, date range and reports visible suppression", async () => {
  await write(ctxMemoryToolEntry.handler, {
    content: "Alpha convention: modules export one public entry.",
    category: "PROJECT_RULES",
  });
  const rows = readMemories();
  const alpha = rows.find((row) => row.content.includes("Alpha convention"));
  assert.ok(alpha);

  // MF-CTX-3：用例名的 "honors limit" 必须有断言在场——limit 对两条以上命中
  // 做截断（FTS 路与 id 短路路同一 limit 语义）。
  await write(ctxMemoryToolEntry.handler, {
    content: "First schedule fact: nightly export runs at 02:15 UTC.",
    category: "CONFIG_VALUES",
  });
  await write(ctxMemoryToolEntry.handler, {
    content: "Second schedule fact: the backup window opens at 04:00 UTC.",
    category: "CONFIG_VALUES",
  });
  const limited = await write(ctxSearchToolEntry.handler, { query: "schedule", limit: 1 });
  assert.match(limited, /^Found 1 result for "schedule":/, "limit=1 必须截断到单条命中");
  const unlimited = await write(ctxSearchToolEntry.handler, { query: "schedule" });
  assert.match(unlimited, /^Found ([2-9]|\d\d+) results? for "schedule":/, "去掉 limit 必须回多条");

  // MF-CTX-3：合法 from/to 的闭区间过滤（坏日期分支见下，这里补「好日期」）。
  const bounded = await write(ctxSearchToolEntry.handler, {
    query: "schedule",
    from: "2020-01-01",
    to: "2030-12-31",
  });
  assert.match(
    bounded,
    /^Found ([1-9]|\d\d+) results? for "schedule":/,
    "覆盖 created_at 的合法区间必须命中",
  );
  const beforeAll = await write(ctxSearchToolEntry.handler, {
    query: "schedule",
    from: "1999-01-01",
    to: "1999-12-31",
  });
  assert.match(beforeAll, /No results found/, "created_at 之前的合法区间必须无命中");

  // 坏日期得到可自我纠正的错误，而不是一次 provider 侧 schema 拒绝。
  assert.match(
    await write(ctxSearchToolEntry.handler, { query: "convention", from: "2026/01/01" }),
    /Error: Invalid date '2026\/01\/01' — expected YYYY-MM-DD\./,
  );

  // 空 query 的错误语义与 ctx_reduce 的 drop 同款。
  assert.match(await write(ctxSearchToolEntry.handler, {}), /Error: 'query' is required\./);

  // 把命中标记为「已渲染」后，检索不再回它，并在输出里说明抑制了一条。
  sharedDb
    .prepare("INSERT INTO session_meta (session_id, memory_block_ids) VALUES (?, ?)")
    .run(SESSION_ID, JSON.stringify([alpha.id]));

  const suppressed = await write(ctxSearchToolEntry.handler, { query: "Alpha convention" });
  assert.match(suppressed, /No results found/);
  assert.match(suppressed, /suppressed because it is already visible/);
  assert.match(suppressed, new RegExp(`id #${alpha.id}`));
});
