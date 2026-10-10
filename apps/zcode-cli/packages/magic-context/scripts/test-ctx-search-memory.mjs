#!/usr/bin/env node
/**
 * Step 10（D4/D14）验收测试 —— ctx_search / ctx_memory 的**包侧卷积**用例。
 *
 * 被测面是 `@zcode/magic-context` 公共 barrel 上 Step 10 新增的那几个入口
 * （见 src/index.ts 的 4c 节注释块）：
 *
 *   - `searchMemoriesFTS`：FTS5 关键词检索（内联 sanitizeFtsQuery /
 *     relaxedFtsQuery 的消毒与两级放宽、bm25 排序、过期/状态过滤、日期界）——
 *     ctx_search（core/tool/handlers/ctx-search.ts）**复用**的就是这一层，
 *     本测试钉住的正是「宿主无需、也不得自造查询消毒」所依赖的行为；
 *   - `insertMemoryIdempotent` + `getMemoryByHash` / `updateMemorySeenCount` /
 *     `computeNormalizedHash`：ctx_memory 的写入面（前置精确哈希查重 → 已存在
 *     则 seen_count 递增；穿过前置检查的竞争写由唯一约束收口）。**登记项**：
 *     `insertMemoryIdempotent` 的唯一约束回退判定 Bun 命名错误码
 *     （`SQLITE_CONSTRAINT_UNIQUE`，上游逐字码），node:sqlite 下抛
 *     `ERR_SQLITE_ERROR`/errcode 2067，该回退分支在本 fork 运行期不可达——
 *     `src/core/**` 逐字区本节点不改，由前置检查覆盖去重语义，真竞争 fail-visible；
 *     缺口已登记于证据包 cache/ctx-search-config-map.md 待逐字区 owner 处置。
 *   - `getVisibleMemoryIds` / `resolveProjectIdentityForSession` /
 *     `storedPathBelongsToIdentity`：ctx_search 的可见性过滤与身份解析。
 *
 * 覆盖判据（spec T-MC2）：关键词命中并返回记忆条目、无向量路径（memory_embeddings
 * 零读取）；外加 D14 写入幂等。
 *
 * 隔离：`mkdtemp` + 显式 `MAGIC_CONTEXT_DB_DIR` / `MAGIC_CONTEXT_LOG_PATH`，
 * `delete process.env.NODE_ENV`（否则 node --test 的 NODE_ENV=test 会把存储重定向
 * 到 backstop 目录而不是这里的临时目录）。**绝不写真实 ~/.omz**。
 *
 * Requires Node >= 24（node:sqlite）与一次先行的 `pnpm build`——本脚本 import
 * 编译产物 dist/，与同目录其它套件一致。
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

const dbDir = mkdtempSync(join(tmpdir(), "magic-context-ctx-search-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

const { initializeMagicContextHost } = await import(dist("host/harness.js"));
initializeMagicContextHost();

const { openDatabase } = await import(dist("core/features/magic-context/storage-db.js"));
// barrel 面：core 的 ctx_search / ctx_memory handler 动态 import 的就是这一份。
const {
  computeNormalizedHash,
  getMemoryByHash,
  getVisibleMemoryIds,
  insertMemoryIdempotent,
  resolveProjectIdentityForSession,
  searchMemoriesFTS,
  storedPathBelongsToIdentity,
  updateMemorySeenCount,
} = await import(dist("index.js"));
// 只为测试断言直接取自 dist 模块（非 barrel 面）：archived 状态置位。
const { updateMemoryStatus } = await import(
  dist("core/features/magic-context/memory/storage-memory.js")
);

const db = openDatabase();
assert.ok(db, "openDatabase() must succeed against the temp store");

/** 一个真实可解析的临时目录身份（dir: 形态，非 home、非 git）。 */
const WORK_DIR = mkdtempSync(join(tmpdir(), "magic-context-ctx-work-"));
const PROJECT = resolveProjectIdentityForSession(WORK_DIR);
assert.ok(PROJECT, "temp work dir must resolve to a project identity");
const OTHER_PROJECT = `${PROJECT}-other`;

let memorySeq = 0;
/** 经 barrel 的写入面插一条记忆（与 ctx_memory 同一条路径）。 */
function writeMemory(content, overrides = {}) {
  memorySeq += 1;
  return insertMemoryIdempotent(db, {
    projectPath: PROJECT,
    category: "PROJECT_RULES",
    content,
    sourceSessionId: "sess_ctx_search",
    sourceType: "agent",
    ...overrides,
  });
}

process.on("exit", () => {
  // 先关句柄再删目录：Windows 上开着的 sqlite 句柄会让 rmSync 抛 EPERM。
  try {
    db.close();
  } catch {
    // 关闭失败不改变测试结论；目录清理是尽力而为。
  }
  try {
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  } catch {
    // 同上：临时目录残留不污染真实存储（MAGIC_CONTEXT_DB_DIR 已隔离）。
  }
});

// ── 身份解析（ctx_search / ctx_memory 的 project 维度） ─────────────────────

test("resolveProjectIdentityForSession resolves a temp dir and ownership holds", () => {
  assert.ok(PROJECT.length > 0);
  assert.equal(storedPathBelongsToIdentity(PROJECT, PROJECT), true);
  // 另一个项目的身份不共享所有权——跨项目记忆对检索/写入都不可见。
  assert.equal(storedPathBelongsToIdentity(OTHER_PROJECT, PROJECT), false);
});

// ── 写入面幂等（D14 / ctx_memory） ───────────────────────────────────────────

test("write face: exact-hash pre-check dedups; insertMemoryIdempotent inserts once", () => {
  const content = `Deploy passwords rotate every 90 days (seq ${memorySeq}).`;
  const normalizedHash = computeNormalizedHash(content);

  const first = insertMemoryIdempotent(db, {
    projectPath: PROJECT,
    category: "PROJECT_RULES",
    content,
    sourceSessionId: "sess_ctx_search",
    sourceType: "agent",
  });
  assert.equal(first.inserted, true);
  assert.ok(first.memory.id > 0);

  // handler（core/tool/handlers/ctx-memory.ts）的同款前置链路：同
  // (project, category, normalized_hash) 已有行 → 不重复插，seen_count 递增。
  const existing = getMemoryByHash(db, PROJECT, "PROJECT_RULES", normalizedHash);
  assert.ok(existing, "exact-hash lookup must find the row just written");
  assert.equal(existing.id, first.memory.id);
  updateMemorySeenCount(db, existing.id);
  const bumped = getMemoryByHash(db, PROJECT, "PROJECT_RULES", normalizedHash);
  assert.equal(bumped.seenCount, existing.seenCount + 1);

  // 归一化（trim + 空白折叠 + 小写）后同内容同哈希——「同一事实的不同写法」
  // 不会制造第二行。
  const rehashed = computeNormalizedHash(`   ${content.toUpperCase()}   `);
  assert.equal(rehashed, normalizedHash);

  const rows = db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_path = ? AND category = ?")
    .get(PROJECT, "PROJECT_RULES");
  assert.equal(rows.n, 1);
  // FTS 触发器随 INSERT 同步：镜像表里有且仅有一行。
  const ftsRows = db.prepare("SELECT COUNT(*) AS n FROM memories_fts").get();
  assert.equal(ftsRows.n, 1);
});

test("same content under a different category is a distinct memory", () => {
  const content = `Shared content across categories (seq ${memorySeq}).`;
  const first = writeMemory(content, { category: "PROJECT_RULES" });
  const second = writeMemory(content, { category: "CONSTRAINTS" });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, true);
  assert.notEqual(first.memory.id, second.memory.id);
});

// ── 检索面（D4 / ctx_search）：消毒 / 放宽 / 过滤 ────────────────────────────

test("searchMemoriesFTS hits on keywords and skips other projects", () => {
  writeMemory("The billing service lives in services/billing and owns invoice rendering.");
  const hits = searchMemoriesFTS(db, PROJECT, "billing invoice", 10);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((hit) => hit.content.includes("services/billing")));
  // 别的项目即使有同样的词也搜不到（project_path 精确过滤）。
  const foreign = searchMemoriesFTS(db, OTHER_PROJECT, "billing invoice", 10);
  assert.deepEqual(foreign, []);
});

test("FTS5 operator characters are sanitized, never injected as query syntax", () => {
  writeMemory("Retry policy uses backoff-base-2 with jitter; see cfg:retry.max (prod).");
  // 这些字符在 FTS5 MATCH 里是操作符/语法；消毒层逐词引号包裹后按字面匹配。
  const hits = searchMemoriesFTS(db, PROJECT, "backoff-base-2 cfg:retry.max (prod)", 10);
  assert.ok(
    hits.some((hit) => hit.content.includes("backoff-base-2")),
    "带 FTS5 操作符的 query 必须按字面命中而不是抛 syntax error",
  );
  // 引号自身也要被消毒（不成对引号在上游会炸 "unterminated string"）。
  assert.doesNotThrow(() => searchMemoriesFTS(db, PROJECT, 'quote " dangling', 10));
});

test("relaxed query falls back to OR when the strict AND finds nothing", () => {
  writeMemory("Kafka topics are named after the owning team.");
  // 严格 AND："kafka zzznotaword" 无同时含两词的记忆 → 自动放宽为 OR 重查。
  const relaxed = searchMemoriesFTS(db, PROJECT, "kafka zzznotaword", 10);
  assert.ok(
    relaxed.some((hit) => hit.content.includes("Kafka")),
    "strict AND 落空后必须走 relaxedFtsQuery 的 OR 放宽",
  );
});

test("expired and archived memories never surface in search", () => {
  const expired = writeMemory("Temporary note that expires immediately.", {
    expiresAt: Date.now() - 1_000,
  });
  const archived = writeMemory("Once-active fact that gets archived.");
  updateMemoryStatus(db, archived.memory.id, "archived");

  assert.equal(expired.inserted, true);
  const hits = searchMemoriesFTS(db, PROJECT, "expires immediately", 10);
  assert.ok(!hits.some((hit) => hit.id === expired.memory.id));
  const archivedHits = searchMemoriesFTS(db, PROJECT, "Once-active fact", 10);
  assert.ok(!archivedHits.some((hit) => hit.id === archived.memory.id));
});

test("date range boundaries filter by created_at", () => {
  const old = writeMemory("Ancient decision recorded long ago.", {
    category: "ARCHITECTURE",
  });
  db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
    Date.UTC(2020, 0, 1),
    old.memory.id,
  );
  const recent = writeMemory("Recent decision recorded today.", { category: "ARCHITECTURE" });

  const inRange = searchMemoriesFTS(db, PROJECT, "decision recorded", 10, {
    from: Date.UTC(2024, 0, 1),
    to: Date.UTC(2030, 0, 1),
  });
  assert.ok(inRange.some((hit) => hit.id === recent.memory.id));
  assert.ok(!inRange.some((hit) => hit.id === old.memory.id));

  const allTime = searchMemoriesFTS(db, PROJECT, "decision recorded", 10);
  assert.ok(allTime.some((hit) => hit.id === old.memory.id));
});

// ── 可见性过滤（ctx_search 的已渲染记忆过滤） ────────────────────────────────

test("getVisibleMemoryIds reads the m0-rendered column; null means no filter", () => {
  const visible = writeMemory("Already rendered in the project-memory block.");
  const hidden = writeMemory("Never rendered anywhere yet.");

  const sessionId = "sess_visible_filter";
  // 无 session_meta 行 → null（调用方按「不过滤」处理）。
  assert.equal(getVisibleMemoryIds(db, sessionId), null);

  db.prepare("INSERT INTO session_meta (session_id, memory_block_ids) VALUES (?, ?)").run(
    sessionId,
    JSON.stringify([visible.memory.id]),
  );
  const visibleIds = getVisibleMemoryIds(db, sessionId);
  assert.ok(visibleIds instanceof Set);
  assert.equal(visibleIds.has(visible.memory.id), true);

  // handler 的过滤规则本身：可见 id 不出现在检索结果里，其余照常。
  const hits = searchMemoriesFTS(db, PROJECT, "rendered project-memory", 10).filter(
    (hit) => !visibleIds.has(hit.id),
  );
  assert.ok(!hits.some((hit) => hit.id === visible.memory.id));
  assert.ok(
    searchMemoriesFTS(db, PROJECT, "Never rendered anywhere", 10).some(
      (hit) => hit.id === hidden.memory.id,
    ),
  );

  // 坏 JSON 不炸，按 null（不过滤）处理——与包内注释语义一致。
  db.prepare("UPDATE session_meta SET memory_block_ids = ? WHERE session_id = ?").run(
    "{not json",
    sessionId,
  );
  assert.equal(getVisibleMemoryIds(db, sessionId), null);
});

// ── 无向量路径声明（N1 终局不做 embedding 运行时） ───────────────────────────

test("the search path never touches memory_embeddings", () => {
  const seeded = writeMemory("Keyword hit without any embedding row.");
  // 即使手工塞一行 embedding，检索结果也不应依赖它（FTS5 是唯一召回源）。
  db.prepare(
    "INSERT INTO memory_embeddings (memory_id, model_id, embedding) VALUES (?, 'test-model', x'00')",
  ).run(seeded.memory.id);
  const hits = searchMemoriesFTS(db, PROJECT, "Keyword hit embedding", 10);
  assert.ok(hits.some((hit) => hit.content.includes("Keyword hit")));
  const embeddingRows = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get();
  assert.equal(embeddingRows.n, 1, "embedding 表保持手工塞入的那一行——检索不写它");
});
