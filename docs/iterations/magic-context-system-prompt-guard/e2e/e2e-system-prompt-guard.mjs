#!/usr/bin/env node
/**
 * e2e-heal — magic-context-system-prompt-guard 真机语义验证。
 *
 * 三个场景共用同一个隔离临时目录（真实库的拷贝），按顺序执行：
 *
 *   E2E-0  老库升级：真实库（~100MB）三件套只读拷贝 → node:sqlite 记录迁移前
 *          PRAGMA/版本 → 经 dist 的 openDatabase() 自动迁移 → 断言 v10000 落地、
 *          读侧 getPersistedSchemaVersion() 全量 MAX=10000、真实数据行数无损、
 *          关库重开幂等。
 *   E2E-1  受损会话自愈：在已迁移的隔离库上造 sess_e2e_damaged（3 条 system
 *          tag + 2 条 user 对照组，全部 dropped/full，source_contents 保留原文，
 *          message_role 为 NULL 模拟升级过渡期），驱动真实
 *          tagMessages() → applyFlushedStatuses() 一个 pass，断言防线三把 system
 *          tag 修回 active + 打标点回填 message_role='system' + wire 恢复原文；
 *          对照组仍 dropped 且 wire 为占位符；第二个 pass 幂等。
 *   E2E-2  防线一真机语义：经 dist 的 createCtxReduceTools({db}) 调
 *          ctx_reduce.execute({drop:'1-3'})，断言整体拒绝且 pending_ops 零行。
 *
 * 约束：
 *   - 真实库只作为 copyFileSync 的源，绝不打开、绝不写入；
 *   - 所有写操作只作用于临时目录里的拷贝；
 *   - MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 必须在 dynamic import dist
 *     之前设置（data-path 惰性解析，用 await import() 动态加载）；
 *   - 可重复执行：每次 mkdtemp 生成独立目录（MC_E2E_KEEP=1 保留现场）。
 *
 * 用法：
 *   node docs/iterations/magic-context-system-prompt-guard/e2e/e2e-system-prompt-guard.mjs
 *   MC_E2E_REAL_DB_DIR=<dir> MC_E2E_KEEP=1 node ...
 *
 * 退出码：0 = 全部断言通过；1 = 存在失败断言/致命错误。
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

// 本脚本位于 <repo>/docs/iterations/magic-context-system-prompt-guard/e2e/。
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const PKG = join(REPO, "apps", "zcode-cli", "packages", "magic-context");
const dist = (relative) => pathToFileURL(join(PKG, "dist", relative)).href;

const REAL_DB_DIR =
  process.env.MC_E2E_REAL_DB_DIR ??
  join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".omz", "cli", "db");
const REAL_DB_PATH = join(REAL_DB_DIR, "magic-context.db");
const KEEP = process.env.MC_E2E_KEEP === "1";

// ── 断言账本 ─────────────────────────────────────────────────────────────────

const cases = [];
let failed = 0;

/** 记录一条断言；expected/actual 用 JSON 序列化后做严格相等比较。 */
function check(scenario, id, name, expected, actual) {
  const expectedText = formatValue(expected);
  const actualText = formatValue(actual);
  const pass = expectedText === actualText;
  if (!pass) failed += 1;
  cases.push({ scenario, id, name, expected: expectedText, actual: actualText, pass });
  console.log(`  ${pass ? "ok  " : "FAIL"} ${id} ${name}`);
  if (!pass) {
    console.log(`        期望: ${truncate(expectedText)}`);
    console.log(`        实际: ${truncate(actualText)}`);
  }
  return pass;
}

/** 直接按布尔条件记录断言（用于谓词型判断）。 */
function checkThat(scenario, id, name, pass, expectedText, actualText) {
  return check(scenario, id, name, expectedText, pass ? expectedText : actualText);
}

function formatValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function truncate(text, max = 220) {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length} chars)`;
}

function fatal(message, error) {
  failed += 1;
  console.error(`\nFATAL: ${message}`);
  if (error) console.error(error);
  finish(1);
}

// ── 临时目录与真实库只读拷贝 ─────────────────────────────────────────────────

const dbDir = mkdtempSync(join(tmpdir(), `mc-e2e-${Date.now()}-`));
const dbPath = join(dbDir, "magic-context.db");

// 必须在任何 dynamic import(dist) 之前设置：data-path 是惰性解析，
// NODE_ENV=test 会让存储走 test backstop 而忽略 MAGIC_CONTEXT_DB_DIR。
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

console.log("=".repeat(78));
console.log("magic-context-system-prompt-guard / e2e-heal");
console.log(`仓库: ${REPO}`);
console.log(`隔离目录: ${dbDir}`);
console.log(`真实库源: ${REAL_DB_PATH}（只读拷贝）`);
console.log("=".repeat(78));

for (const required of [
  join(PKG, "dist", "index.js"),
  join(PKG, "dist", "core", "features", "magic-context", "storage-db.js"),
]) {
  if (!existsSync(required)) {
    fatal(`dist 不完整，先执行 pnpm --dir apps/zcode-cli --filter @zcode/magic-context build（缺 ${required}）`);
  }
}

if (!existsSync(REAL_DB_PATH)) {
  fatal(`真实库不存在: ${REAL_DB_PATH}（可用 MC_E2E_REAL_DB_DIR 覆盖）`);
}

// 三件套按 db → -wal → -shm 顺序拷贝。源库可能正被真实 CLI 持有，
// copyFileSync 只读源文件；拷贝下来的快照由 SQLite 在打开时按 WAL 恢复。
const copied = [];
for (const suffix of ["", "-wal", "-shm"]) {
  const source = `${REAL_DB_PATH}${suffix}`;
  if (!existsSync(source)) {
    if (suffix === "") fatal(`真实库主文件不存在: ${source}`);
    console.log(`  提示: 源侧不存在 ${source}，跳过`);
    continue;
  }
  const target = `${dbPath}${suffix}`;
  copyFileSync(source, target);
  copied.push({ suffix: suffix || "(main)", bytes: statSync(target).size });
}
console.log("\n拷贝结果:");
for (const item of copied) {
  console.log(`  ${item.suffix.padEnd(6)} ${(item.bytes / 1024 / 1024).toFixed(1)} MiB`);
}

// ── E2E-0 迁移前取证（直接用 node:sqlite 读拷贝） ─────────────────────────────

const pre = new DatabaseSync(dbPath);
const preColumns = pre
  .prepare("PRAGMA table_info(tags)")
  .all()
  .map((column) => column.name);
const preMaxVersion = pre
  .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
  .get().version;
const preCounts = {
  tags: pre.prepare("SELECT COUNT(*) AS n FROM tags").get().n,
  source_contents: pre.prepare("SELECT COUNT(*) AS n FROM source_contents").get().n,
  session_meta: pre.prepare("SELECT COUNT(*) AS n FROM session_meta").get().n,
};
pre.close();

console.log("\n迁移前状态:");
console.log(`  tags 列: ${preColumns.join(", ")}`);
console.log(`  schema_migrations MAX(version) = ${preMaxVersion}`);
console.log(
  `  行数: tags=${preCounts.tags} source_contents=${preCounts.source_contents} session_meta=${preCounts.session_meta}`,
);

console.log("\n[E2E-0] 老库迁移 + 读侧");
check("E2E-0", "0-pre-1", "迁移前 tags 无 message_role 列", false, preColumns.includes("message_role"));
check("E2E-0", "0-pre-2", "迁移前 MAX(version) = 94", 94, preMaxVersion);

// ── 加载 dist（env 已就位） ──────────────────────────────────────────────────

const hostHarness = await import(dist("host/harness.js"));
hostHarness.initializeMagicContextHost();

const storageDbModule = await import(dist("core/features/magic-context/storage-db.js"));
const { openDatabase, closeDatabase, getPersistedSchemaVersion } = storageDbModule;
const { getMagicContextDatabasePath } = await import(dist("host/storage-dir.js"));

let db = null;
try {
  check("E2E-0", "0-1", "getMagicContextDatabasePath 指向隔离目录", dbPath, getMagicContextDatabasePath());
  db = openDatabase(getMagicContextDatabasePath());
} catch (error) {
  fatal("openDatabase() 抛错", error);
}
if (!db) fatal("openDatabase() 返回 null（storage unavailable）");

const postColumns = db
  .prepare("PRAGMA table_info(tags)")
  .all()
  .map((column) => column.name);
const postMaxVersion = db
  .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
  .get().version;
const forkRowCount = db
  .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 10000")
  .get().n;
const ledgerRowCountAfterFirstOpen = db
  .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
  .get().n;
const postCounts = {
  tags: db.prepare("SELECT COUNT(*) AS n FROM tags").get().n,
  source_contents: db.prepare("SELECT COUNT(*) AS n FROM source_contents").get().n,
  session_meta: db.prepare("SELECT COUNT(*) AS n FROM session_meta").get().n,
};

check("E2E-0", "0-2", "迁移后 tags 含 message_role 列", true, postColumns.includes("message_role"));
check("E2E-0", "0-3", "schema_migrations 含且仅含一条 version=10000", 1, forkRowCount);
check("E2E-0", "0-4", "迁移后 MAX(version) = 10000", 10000, postMaxVersion);
check(
  "E2E-0",
  "0-5",
  "getPersistedSchemaVersion() = 10000（读侧全量 MAX）",
  10000,
  getPersistedSchemaVersion(db),
);
check("E2E-0", "0-6", "真实数据无损：tags 行数", preCounts.tags, postCounts.tags);
check(
  "E2E-0",
  "0-7",
  "真实数据无损：source_contents 行数",
  preCounts.source_contents,
  postCounts.source_contents,
);
check("E2E-0", "0-8", "真实数据无损：session_meta 行数", preCounts.session_meta, postCounts.session_meta);

// 关库重开：证明迁移幂等（不新增 ledger 行、不报错、版本不回退）。
closeDatabase();
let reopened = null;
try {
  reopened = openDatabase(getMagicContextDatabasePath());
} catch (error) {
  fatal("关库重开抛错", error);
}
if (!reopened) fatal("关库重开返回 null");
const reopenMaxVersion = reopened
  .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
  .get().version;
const reopenForkRowCount = reopened
  .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 10000")
  .get().n;
const reopenLedgerRowCount = reopened
  .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
  .get().n;
const reopenCounts = {
  tags: reopened.prepare("SELECT COUNT(*) AS n FROM tags").get().n,
  source_contents: reopened.prepare("SELECT COUNT(*) AS n FROM source_contents").get().n,
  session_meta: reopened.prepare("SELECT COUNT(*) AS n FROM session_meta").get().n,
};
check("E2E-0", "0-9", "重开后 MAX(version) 仍为 10000", 10000, reopenMaxVersion);
check("E2E-0", "0-10", "重开不重复写 v10000 行", 1, reopenForkRowCount);
check(
  "E2E-0",
  "0-11",
  "重开不新增迁移 ledger 行",
  ledgerRowCountAfterFirstOpen,
  reopenLedgerRowCount,
);
check("E2E-0", "0-12", "重开后 tags 行数不变", preCounts.tags, reopenCounts.tags);
check(
  "E2E-0",
  "0-13",
  "重开后 source_contents 行数不变",
  preCounts.source_contents,
  reopenCounts.source_contents,
);
check("E2E-0", "0-14", "重开后 session_meta 行数不变", preCounts.session_meta, reopenCounts.session_meta);

db = reopened;

// ── E2E-1 受损会话自愈 ───────────────────────────────────────────────────────

console.log("\n[E2E-1] 受损会话自愈（防线三 + 存量 role 回填）");

const { createTagger } = await import(dist("core/features/magic-context/tagger.js"));
const { tagMessages } = await import(dist("core/hooks/magic-context/tag-messages.js"));
const { applyFlushedStatuses } = await import(
  dist("core/hooks/magic-context/transform-operations.js")
);
const { insertTag, updateTagStatus, updateTagDropMode, getTagById, stampTagMessageRole } =
  await import(dist("core/features/magic-context/storage-tags.js"));
const { saveSourceContent } = await import(dist("core/features/magic-context/storage-source.js"));
const { ensureSessionMetaRow } = await import(
  dist("core/features/magic-context/storage-meta-shared.js")
);

const SESSION = "sess_e2e_damaged";
const TAG_SPECS = [
  {
    tagNumber: 1,
    messageId: "mc1",
    role: "system",
    text: "E2E SYSTEM SEGMENT ONE — original protected instruction; must survive a dropped tag.",
  },
  {
    tagNumber: 2,
    messageId: "mc2",
    role: "system",
    text: "E2E SYSTEM SEGMENT TWO — original protected instruction; must survive a dropped tag.",
  },
  {
    tagNumber: 3,
    messageId: "mc3",
    role: "system",
    text: "E2E SYSTEM SEGMENT THREE — original protected instruction; must survive a dropped tag.",
  },
  {
    tagNumber: 4,
    messageId: "msg_4",
    role: "user",
    text: "E2E USER INJECTION FOUR — control group, stays dropped by design.",
  },
  {
    tagNumber: 5,
    messageId: "msg_5",
    role: "user",
    text: "E2E USER INJECTION FIVE — control group, stays dropped by design.",
  },
];
const ASSISTANT_TEXT = "E2E ASSISTANT REPLY — baseline turn for the pass.";

function makeMessage(messageId, role, text, created) {
  return {
    info: {
      id: messageId,
      role,
      sessionID: SESSION,
      time: { created },
      synthetic: false,
    },
    parts: [{ type: "text", text }],
  };
}

// 模拟事故现场：tag 1..5 全部 dropped/full，原文在 source_contents，
// message_role 为 NULL（升级过渡期，读侧列刚迁移完尚未回填）。
ensureSessionMetaRow(db, SESSION);
for (const spec of TAG_SPECS) {
  insertTag(
    db,
    SESSION,
    `${spec.messageId}:p0`,
    "message",
    Buffer.byteLength(spec.text, "utf8"),
    spec.tagNumber,
  );
  updateTagStatus(db, SESSION, spec.tagNumber, "dropped");
  updateTagDropMode(db, SESSION, spec.tagNumber, "full");
  saveSourceContent(db, SESSION, spec.tagNumber, spec.text);
}

const messages = [
  makeMessage("mc1", "system", TAG_SPECS[0].text, 1000),
  makeMessage("mc2", "system", TAG_SPECS[1].text, 1001),
  makeMessage("mc3", "system", TAG_SPECS[2].text, 1002),
  makeMessage("msg_4", "user", TAG_SPECS[3].text, 2000),
  makeMessage("msg_5", "user", TAG_SPECS[4].text, 2001),
  makeMessage("msg_6", "assistant", ASSISTANT_TEXT, 3000),
];

function tagStatus(tagNumber) {
  return getTagById(db, SESSION, tagNumber)?.status ?? "(missing)";
}
function tagRole(tagNumber) {
  return getTagById(db, SESSION, tagNumber)?.messageRole ?? null;
}
function tagCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ?").get(SESSION).n;
}

function runPass() {
  const tagger = createTagger();
  tagger.initFromDb(SESSION, db);
  const result = tagMessages(SESSION, messages, tagger, db);
  // apply 之前：tagMessages 已把 system 段从 source_contents 恢复成 §N§ 原文，
  // 对照组也恢复成 §N§ 原文（占位符是 apply 阶段重放出来的）。
  const preApplySystemWire = [1, 2, 3].map((n) => result.targets.get(n)?.getContent?.() ?? null);
  const preApplyControlWire = [4, 5].map((n) => result.targets.get(n)?.getContent?.() ?? null);
  const mutated = applyFlushedStatuses(SESSION, db, result.targets);
  return { result, mutated, preApplySystemWire, preApplyControlWire };
}

// 自愈前的现场断言：1..5 全部 dropped/full，message_role 全 NULL。
const beforeStatuses = TAG_SPECS.map((spec) => tagStatus(spec.tagNumber));
const beforeRoles = TAG_SPECS.map((spec) => tagRole(spec.tagNumber));
check(
  "E2E-1",
  "1-pre-1",
  "受损现场：tag 1..5 全部 dropped",
  ["dropped", "dropped", "dropped", "dropped", "dropped"],
  beforeStatuses,
);
check(
  "E2E-1",
  "1-pre-2",
  "过渡期现场：tag 1..5 message_role 全为 NULL",
  [null, null, null, null, null],
  beforeRoles,
);

const firstPass = runPass();
const firstTargets = firstPass.result.targets;

const systemWire = [1, 2, 3].map((n) => firstTargets.get(n)?.getContent?.() ?? "(no target)");
const expectedSystemWire = [1, 2, 3].map(
  (n) => `§${n}§ ${TAG_SPECS.find((spec) => spec.tagNumber === n).text}`,
);
const controlWire = [4, 5].map((n) => firstTargets.get(n)?.getContent?.() ?? "(no target)");

check(
  "E2E-1",
  "1-1",
  "防线三：tag 1/2/3 修回 active",
  ["active", "active", "active"],
  [1, 2, 3].map(tagStatus),
);
check(
  "E2E-1",
  "1-2",
  "打标点回填：tag 1/2/3 message_role='system'",
  ["system", "system", "system"],
  [1, 2, 3].map(tagRole),
);
check("E2E-1", "1-3", "system wire 为原文（带 §N§ 前缀，非占位符）", expectedSystemWire, systemWire);
check(
  "E2E-1",
  "1-4",
  "system wire 不含 [dropped 占位符",
  [false, false, false],
  systemWire.map((text) => text.includes("[dropped")),
);
check(
  "E2E-1",
  "1-5",
  "对照组 tag 4/5 仍为 dropped",
  ["dropped", "dropped"],
  [4, 5].map(tagStatus),
);
check(
  "E2E-1",
  "1-6",
  "对照组 wire 为 [dropped §N§] 占位符",
  ["[dropped §4§]", "[dropped §5§]"],
  controlWire,
);
check(
  "E2E-1",
  "1-7",
  "对照组 message_role 回填为 user",
  ["user", "user"],
  [4, 5].map(tagRole),
);
check("E2E-1", "1-8", "首 pass 确实改写了 wire（对照组走占位符替换）", true, firstPass.mutated);
check("E2E-1", "1-9", "打标缓存：tag 1..5 全部进入 targets", 5, [1, 2, 3, 4, 5].filter((n) => firstTargets.has(n)).length);

const tagsAfterFirstPass = tagCount();
const firstSystemWireSnapshot = [1, 2, 3].map((n) => firstTargets.get(n)?.getContent?.() ?? null);

// 第二个 pass：模拟下一轮进程/请求。wire 已是 §N§ 原文（system）与占位符（对照组）。
const secondPass = runPass();
const secondTargets = secondPass.result.targets;
const secondSystemWire = [1, 2, 3].map((n) => secondTargets.get(n)?.getContent?.() ?? "(no target)");
const secondControlWire = [4, 5].map((n) => secondTargets.get(n)?.getContent?.() ?? "(no target)");

check(
  "E2E-1",
  "1-10",
  "第二 pass 幂等：tag 1/2/3 仍 active",
  ["active", "active", "active"],
  [1, 2, 3].map(tagStatus),
);
check(
  "E2E-1",
  "1-11",
  "第二 pass 幂等：system wire 与首 pass 逐字节一致",
  firstSystemWireSnapshot,
  secondSystemWire,
);
check(
  "E2E-1",
  "1-12",
  "第二 pass 幂等：对照组仍 dropped 且仍为占位符",
  ["dropped", "dropped", "[dropped §4§]", "[dropped §5§]"],
  [4, 5].map(tagStatus).concat(secondControlWire),
);
check(
  "E2E-1",
  "1-13",
  "第二 pass：apply 前后 system wire 逐字节一致（防线三不重写 system）",
  secondPass.preApplySystemWire,
  secondSystemWire,
);
check(
  "E2E-1",
  "1-14",
  "第二 pass：true 仅来自对照组占位符重放（设计内 replay 语义）",
  { mutated: true, controlBefore: [4, 5].map((n) => `§${n}§ ${TAG_SPECS.find((spec) => spec.tagNumber === n).text}`), controlAfter: ["[dropped §4§]", "[dropped §5§]"] },
  { mutated: secondPass.mutated, controlBefore: secondPass.preApplyControlWire, controlAfter: secondControlWire },
);
check("E2E-1", "1-15", "第二 pass 不新增 tag 行", tagsAfterFirstPass, tagCount());
check(
  "E2E-1",
  "1-16",
  "role 稳定后 stampTagMessageRole 零写（R4）",
  [0, 0, 0],
  [1, 2, 3].map((n) => stampTagMessageRole(db, SESSION, n, "system")),
);

// ── E2E-2 防线一真机语义 ─────────────────────────────────────────────────────

console.log("\n[E2E-2] 防线一：ctx_reduce 拒绝 system 段");

const { createCtxReduceTools } = await import(dist("core/tools/ctx-reduce/tools.js"));
const { getPendingOps } = await import(dist("core/features/magic-context/storage-ops.js"));

const tools = createCtxReduceTools({ db, protectedSet: new Set() });
let reduceText = "";
try {
  reduceText = await tools.ctx_reduce.execute(
    { drop: "1-3" },
    { callID: "e2e-heal-defense-one", sessionID: SESSION },
  );
} catch (error) {
  fatal("ctx_reduce.execute 抛错", error);
}

check(
  "E2E-2",
  "2-1",
  "返回 Refusing to drop 文案（交集点名 1-3）",
  "Error: Refusing to drop §1§, §2§, §3§ — system prompt segments are protected and never archivable.",
  reduceText,
);
check("E2E-2", "2-2", "拒绝后 pending_ops 为 0 行", 0, getPendingOps(db, SESSION).length);
check(
  "E2E-2",
  "2-3",
  "拒绝无副作用：tag 1/2/3 仍 active",
  ["active", "active", "active"],
  [1, 2, 3].map(tagStatus),
);

// ── 汇总 ────────────────────────────────────────────────────────────────────

finish(failed === 0 ? 0 : 1);

function finish(exitCode) {
  console.log("\n" + "=".repeat(78));
  console.log("断言矩阵");
  console.log("=".repeat(78));
  console.log(
    `${"场景".padEnd(6)} ${"断言".padEnd(9)} ${"结果".padEnd(5)} ${"期望".padEnd(38)} 实际`,
  );
  for (const item of cases) {
    console.log(
      `${item.scenario.padEnd(6)} ${item.id.padEnd(9)} ${(item.pass ? "PASS" : "FAIL").padEnd(5)} ${truncate(item.expected, 38).padEnd(38)} ${truncate(item.actual, 60)}`,
    );
  }
  const passed = cases.length - failed;
  console.log("-".repeat(78));
  console.log(`合计: ${cases.length} 条断言, ${passed} 通过, ${failed} 失败`);

  if (exitCode === 0 && !KEEP) {
    try {
      closeDatabase();
    } catch {
      // 关库失败不改变判定。
    }
    try {
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      console.log(`已清理隔离目录: ${dbDir}`);
    } catch (error) {
      console.log(`提示: 隔离目录清理失败（${error?.code ?? "unknown"}），保留: ${dbDir}`);
    }
  } else {
    console.log(`隔离目录保留: ${dbDir}`);
  }

  process.exit(exitCode);
}
