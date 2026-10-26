#!/usr/bin/env node
/**
 * Step 7（T-R1/T-R2）—— 设置页「记忆」管理区的两条 workspace RPC 契约测试。
 * 被测对象：`../src/zcode-protocol/magic-context-memories.js`（dist）的
 * `listMagicContextMemories` / `archiveMagicContextMemories` 两个 handler。
 *
 * 覆盖（spec 测试策略）：
 *
 *   T-R1 —— list 契约：
 *     - 参数/结果信封 strict（limit 1..200 缺省 200、offset ≥0、memoryIds 1..100、
 *       reason ≤4096、entry 未知键拒、outcome 四值、`supported` 缺省 true、
 *       `expiresAt`/`supersededByMemoryId` 的 null 放行）；
 *     - 行为：三 status 全回（merged 行 status 也是 archived，靠
 *       supersededByMemoryId 判定）、跨项目行按身份隔离、category 过滤只裁
 *       entries、offset/limit 分页 + truncated 语义、counts 五桶与
 *       `getMemoryCountsByStatus` 对账（各自口径，含登记的「死行」口径差①）；
 *     - 降级：effective 门关着 → `available:false, reason:"disabled"` 且**不建库**。
 *
 *   T-R2 —— archive 契约：
 *     - 逐 id 四值直通（archived / already-archived / missing / rejected）、
 *       rejected 两态文案（superseded → inactive 风格；ownership → 不透明
 *       「was not found」防泄漏）；
 *     - 正常废弃 = `memories.status='archived'` + `memory_mutation_log` 行成对；
 *       重复废弃幂等（already-archived、**不新增 mutation 行**）；
 *     - `rejectionReason`（宿主内部子因）不得出现在 wire entry 上（schema strict +
 *       运行时断言双保险）；authority 托管项目 → 可读 ProtocolRequestError。
 *
 *   T-R3 —— 降级/失败分支常驻覆盖（G-2）：
 *     - 身份解析失败 ×2：list → `available:false, reason:"unavailable"` 信封；
 *       archive → -32010 可读错误（fail-visible，无 outcomes 无 mutation 行）；
 *     - openDatabase 回 null（schema fence）×2：list → unavailable 信封；
 *       archive → 可读 -32010（与开库 **throw** 的原文透传是两种可观察行为）。
 *     - 业务符号（barrel）加载失败 ×2（ZL-4 注入缝 `loadRuntime`，T-MC5 第三态）：
 *       list → unavailable 信封且不建库；archive → 可读 -32010（带底层原因）。
 *     - 跨包副本的 authority 错误（ZL-6）：`instanceof` 失效时仍转可读 -32010。
 *
 *   T-R3b —— 存储端口三态与 blocked 文案（cr-func 第 2 轮 P1-2 / 第 3 轮 P1-1+P2-6）：
 *     - 端口回 `null`（装配没装成）→ list `reason:"unavailable"`、archive -32010
 *       （建议重试/重启，**不**建议开会话）；
 *     - `absent`（零 session，生产可达）→ list `reason:"no-app-port"`（与上一条分开，
 *       面板才能给出可执行引导）、archive -32010 建议「先在本工作区开会话」；
 *     - 两条 -32010 文案都不得带实现名（`getMagicContextStorage` / `workspace-level RPC`）。
 *
 *   T-R4 —— dispatch 源守卫（G-1，四处手工对齐坐标 ③）：
 *     - server.ts 剥注释后必须各有且仅有一处 list/archive 的 `case`，且紧跟
 *       对应 handler 的 `return await …(this.context, request.params);` 字面量
 *       （契约测试直调 handler、services 降级测试走假 app-server，均不经本层
 *       dispatch——本断言是这条路由的常驻自动化证据）。
 *
 * 隔离：全部磁盘写入落在 `mkdtemp` 临时树——数据库经 `MAGIC_CONTEXT_DB_PATH`
 * （绝对路径覆盖，优先级最高）注入，日志经 `MAGIC_CONTEXT_LOG_PATH`；config.json
 * 走 `dependencies.configPath` 注入口。**绝不触碰真实 `~/.omz`**。
 *
 * 前置构建：`@zcode/shared`（schema 出口）、`@zcode/model-option-map`（shared dist
 * 运行时会 import 它，registerHooks 直读其 dist；缺了会抛 `no compiled dist`）、
 * `@zcode/magic-context`（组合函数/存储原语）、`@zcode/contracts`/`@zcode/adapters`
 * 与 `bootstrap` 自身的 dist（本脚本 import 的是
 * `../dist/zcode-protocol/magic-context-memories.js`）。
 *
 * 运行方式：`node scripts/test-magic-context-memories-rpc.mjs`（同
 * `test-magic-context-ui-config.mjs` 的先例：不经 `--test` 聚合器，脚本自带
 * node:test 断言与退出码）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

// ── 隔离：临时库 + 临时日志 + 临时 config 文件（真实 ~/.omz 一个字节都不碰） ──

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "zcode-mc-memories-rpc-"));
const MAIN_DB_PATH = join(TEMP_ROOT, "magic-context.db");
process.env.MAGIC_CONTEXT_DB_PATH = MAIN_DB_PATH;
process.env.MAGIC_CONTEXT_DB_DIR = TEMP_ROOT;
process.env.MAGIC_CONTEXT_LOG_PATH = join(TEMP_ROOT, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

const ENABLED_CONFIG = join(TEMP_ROOT, "enabled.json");
const DISABLED_CONFIG = join(TEMP_ROOT, "disabled.json");
writeFileSync(ENABLED_CONFIG, JSON.stringify({ magicContext: { enabled: true } }), "utf-8");
writeFileSync(DISABLED_CONFIG, JSON.stringify({ magicContext: { enabled: false } }), "utf-8");

// 「打不开的库」用现成目录冒充 DB 文件（openDatabase 必然失败）；父目录指向自己的
// 临时目录，避免 ensureSecureStorageDir 去 chmod 系统共享的临时根。
const BAD_STORE_PARENT = mkdtempSync(join(tmpdir(), "zcode-mc-rpc-badstore-"));
const BAD_DB_PATH = join(BAD_STORE_PARENT, "as-directory");
mkdirSync(BAD_DB_PATH);

const { ConfigKey } = await import("@zcode/contracts");
const { createConfigPort } = await import("@zcode/adapters/config");
const magicContext = await import("@zcode/magic-context");
const { MagicContextConfigSchema } = magicContext;
const {
  zcodeWorkspaceListMagicContextMemoriesParamsSchema,
  zcodeWorkspaceListMagicContextMemoriesResultSchema,
  zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema,
  zcodeWorkspaceArchiveMagicContextMemoriesResultSchema,
} = await import("@zcode/shared");
const { listMagicContextMemories, archiveMagicContextMemories } = await import(
  new URL("../dist/zcode-protocol/magic-context-memories.js", import.meta.url).href
);

// 每个行为用例一个独立项目目录（身份互不干扰，counts 断言才可能是精确值）。
const DIRS = {
  list: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-list-")),
  cross: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-cross-")),
  filter: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-filter-")),
  page: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-page-")),
  archive: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-archive-")),
  mix: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-mix-")),
  authority: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-authority-")),
  authorityCopy: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-authority-copy-")),
  foreign: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-foreign-")),
  fence: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-fence-")),
  // D4（存储端口）：专供「装配层没有可用库」两例的项目目录。
  portNull: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-port-null-")),
  // D5/D6（端口：absent 生产态 / installed 真句柄）共用的项目目录。
  portInstalled: mkdtempSync(join(tmpdir(), "zcode-mc-rpc-port-installed-")),
};

magicContext.initializeMagicContextHost();
// openDatabase 按路径缓存句柄：整个测试进程共用一个 handle（与生产同语义），
// 所以 seed 写入与 handler 读的是同一个库；退出时统一关闭再删临时树。
const seedDb = magicContext.openDatabase(magicContext.getMagicContextDatabasePath());
assert.ok(seedDb, "openDatabase() 必须能在临时库上成功，否则全部行为用例空转");

process.on("exit", (code) => {
  // 先关句柄再删目录：Windows 上开着的 sqlite 句柄会让 rmSync 抛 EPERM。
  try {
    seedDb.close();
  } catch {
    // 关闭失败不改变测试结论。
  }
  for (const dir of [TEMP_ROOT, BAD_STORE_PARENT, ...Object.values(DIRS)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录残留不污染真实存储（DB_PATH 已隔离）。
    }
  }
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 7 T-R1/T-R2 magic-context memories RPC contract"
      : `TEST FAIL — Step 7 T-R1/T-R2 magic-context memories RPC contract (exit code ${code})`,
  );
});

// ── 公共脚手架 ───────────────────────────────────────────────────────────────

/** 纯 schema 用例用的占位 workspace（不落盘，只过信封）。 */
const SCHEMA_WORKSPACE = { workspacePath: "D:/tmp/project", workspaceKey: "ws_schema" };
/** host/memory-admin 的管理视图口径（三 status 全回），对账时直读同值。 */
const ADMIN_STATUSES = ["active", "permanent", "archived"];
const ZERO_COUNTS = { total: 0, active: 0, permanent: 0, archived: 0, merged: 0 };

function workspaceRef(dir) {
  return { workspacePath: dir, workspaceKey: `ws_${basename(dir)}` };
}

function contextWith(...records) {
  return { sessions: new Map(records.map((record, index) => [`ses_${index}`, record])) };
}

/** 一个只暴露 getConfigPort 的最小 session record。 */
function sessionRecord(configPort) {
  return configPort === undefined ? {} : { app: { getConfigPort: () => configPort } };
}

function identityOf(dir) {
  const identity = magicContext.resolveProjectIdentityForSession(dir);
  assert.ok(identity, `临时目录必须能解析出项目身份：${dir}`);
  return identity;
}

/**
 * 直构夹具的显式注入（cr-func 第 2 轮 P1-2）：本文件的行为用例用**空 sessions** 的
 * context 直调 handler，那在生产上是 `absent` 态（workspace 级 RPC + 零 session），
 * 而 `absent` 现在一律不自开库。夹具要自己开库必须显式声明，不许靠「端口方法不在」
 * 推断——那条推断正是生产可达缺陷的入口。
 */
const DIRECT_OPEN = { allowDirectOpen: true };

function listRpc(dir, params = {}, options = {}) {
  return listMagicContextMemories(
    options.context ?? contextWith(),
    { workspace: workspaceRef(dir), ...params },
    { ...DIRECT_OPEN, configPath: options.configPath ?? ENABLED_CONFIG },
  );
}

function archiveRpc(dir, memoryIds, options = {}) {
  return archiveMagicContextMemories(
    options.context ?? contextWith(),
    {
      workspace: workspaceRef(dir),
      memoryIds,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
    { ...DIRECT_OPEN, configPath: options.configPath ?? ENABLED_CONFIG },
  );
}

/**
 * 一个**必然失败**的业务符号加载器（ZL-4 注入缝）：模拟「包在 manifest 里、但
 * barrel 加载不出来」。生产路径上这是不可构造的，所以经 `dependencies.loadRuntime`
 * 注入；它只换「怎么加载」，不换失败语义。
 */
function failingRuntime(message = "simulated: magic-context barrel unavailable") {
  return async () => {
    throw new Error(message);
  };
}

/** 临时把 DB 路径换成新文件（effective 门用例要证明「连文件都不产生」）。 */
async function withDatabasePath(nextPath, run) {
  const previous = process.env.MAGIC_CONTEXT_DB_PATH;
  process.env.MAGIC_CONTEXT_DB_PATH = nextPath;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MAGIC_CONTEXT_DB_PATH;
    else process.env.MAGIC_CONTEXT_DB_PATH = previous;
  }
}

/** 直插一条记忆（绕过工具面，等价 historian 写路径）。 */
function insertRow(projectIdentity, category, content, overrides = {}) {
  const { memory } = magicContext.insertMemoryIdempotent(seedDb, {
    projectPath: projectIdentity,
    category,
    content,
    sourceType: "historian",
    ...overrides,
  });
  return memory;
}

function setRowStatus(id, status) {
  seedDb.prepare("UPDATE memories SET status = ? WHERE id = ?").run(status, id);
}

// 复刻 superseded 写路径（storage-memory.ts:514）：superseded_by 置位的同时 status
// 也置 'archived'——判据必须先判 superseded 再判 status（否则「被取代」会误报成
// 「已归档」）。列表侧（merged 行判定）与归档侧（rejected 的 superseded 子因）都吃这一行。
function markSuperseded(id, successorId) {
  seedDb
    .prepare("UPDATE memories SET superseded_by_memory_id = ?, status = 'archived' WHERE id = ?")
    .run(successorId, id);
}

function readRow(id) {
  return seedDb
    .prepare("SELECT id, status, superseded_by_memory_id, metadata_json FROM memories WHERE id = ?")
    .get(id);
}

/** 指定 target id 集上的 mutation 行（按写入序）——成对写的唯一证据面。 */
function mutationRowsFor(ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return seedDb
    .prepare(
      `SELECT id, project_path, mutation_type, target_memory_id FROM memory_mutation_log
        WHERE target_memory_id IN (${placeholders}) ORDER BY id`,
    )
    .all(...ids);
}

/** 全表 mutation 行数（失败分支「零持久化」断言的读面，不新增任何行）。 */
function mutationRowCount() {
  return seedDb.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get().count;
}

/** archiveMemory(reason) 把 reason trim 后并入 metadata_json.archive_reason（D5）。 */
function archiveReasonOf(id) {
  const row = readRow(id);
  if (!row || row.metadata_json === null) return undefined;
  return JSON.parse(row.metadata_json).archive_reason;
}

// ══ A. T-R1 schema 侧：信封 strict 与字段域 ═══════════════════════════════════

test("T-R1（schema）：list 参数信封——limit 1..200（缺省 200）、offset ≥ 0、信封 strict", () => {
  const schema = zcodeWorkspaceListMagicContextMemoriesParamsSchema;
  const parsed = schema.parse({ workspace: SCHEMA_WORKSPACE });
  assert.equal(parsed.limit, 200, "limit 缺席必须补默认 200");
  assert.equal(parsed.offset, undefined);
  assert.equal(parsed.category, undefined);

  assert.equal(
    schema.safeParse({
      workspace: SCHEMA_WORKSPACE,
      category: "ARCHITECTURE",
      limit: 200,
      offset: 0,
    }).success,
    true,
  );
  for (const [label, bad] of [
    ["limit 越上限（201）", { workspace: SCHEMA_WORKSPACE, limit: 201 }],
    ["limit 非正（0）", { workspace: SCHEMA_WORKSPACE, limit: 0 }],
    ["limit 非整数", { workspace: SCHEMA_WORKSPACE, limit: 1.5 }],
    ["offset 为负", { workspace: SCHEMA_WORKSPACE, offset: -1 }],
    ["offset 非整数", { workspace: SCHEMA_WORKSPACE, offset: 2.5 }],
    ["信封未知键", { workspace: SCHEMA_WORKSPACE, unknown: 1 }],
    ["workspace 缺键", { workspaceKey: "ws_schema" }],
    ["category 非字符串", { workspace: SCHEMA_WORKSPACE, category: 7 }],
  ]) {
    assert.equal(schema.safeParse(bad).success, false, `必须拒绝：${label}`);
  }
});

test("T-R1（schema）：archive 参数信封——memoryIds 1..100、reason ≤ 4096、信封 strict", () => {
  const schema = zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema;
  const ids100 = Array.from({ length: 100 }, (_, index) => index + 1);

  assert.equal(
    schema.safeParse({ workspace: SCHEMA_WORKSPACE, memoryIds: [1, 2, 3] }).success,
    true,
  );
  assert.equal(schema.safeParse({ workspace: SCHEMA_WORKSPACE, memoryIds: ids100 }).success, true);
  assert.equal(
    schema.safeParse({ workspace: SCHEMA_WORKSPACE, memoryIds: [1], reason: "x".repeat(4096) })
      .success,
    true,
    "reason 上限 4096（与工具面 CtxMemoryInputSchema.reason 同值）",
  );

  for (const [label, bad] of [
    ["memoryIds 缺席", { workspace: SCHEMA_WORKSPACE }],
    ["memoryIds 为空", { workspace: SCHEMA_WORKSPACE, memoryIds: [] }],
    ["memoryIds 超上限（101）", { workspace: SCHEMA_WORKSPACE, memoryIds: [...ids100, 101] }],
    ["memoryIds 非整数元素", { workspace: SCHEMA_WORKSPACE, memoryIds: [1.5] }],
    ["memoryIds 字符串元素", { workspace: SCHEMA_WORKSPACE, memoryIds: ["1"] }],
    [
      "reason 超上限（4097）",
      { workspace: SCHEMA_WORKSPACE, memoryIds: [1], reason: "x".repeat(4097) },
    ],
    ["信封未知键", { workspace: SCHEMA_WORKSPACE, memoryIds: [1], bogus: true }],
  ]) {
    assert.equal(schema.safeParse(bad).success, false, `必须拒绝：${label}`);
  }
});

test("T-R1（schema）：list 结果信封——supported 缺省 true、entry strict、null 字段放行", () => {
  const schema = zcodeWorkspaceListMagicContextMemoriesResultSchema;
  const base = {
    workspace: SCHEMA_WORKSPACE,
    available: true,
    entries: [],
    counts: ZERO_COUNTS,
    truncated: false,
    total: 0,
  };
  assert.equal(schema.parse(base).supported, true, "supported 缺省必须解析为 true");
  assert.equal(
    schema.parse({ ...base, supported: false, available: false, reason: "disabled" }).supported,
    false,
    "旧 CLI 降级信封（supported:false）必须合法",
  );

  const entry = {
    id: 7,
    category: "ARCHITECTURE",
    content: "c",
    importance: 75,
    status: "archived",
    seenCount: 3,
    createdAt: 1,
    updatedAt: 2,
    expiresAt: null,
    supersededByMemoryId: null,
  };
  assert.equal(
    schema.safeParse({ ...base, entries: [entry] }).success,
    true,
    "expiresAt / supersededByMemoryId 为 null 必须放行",
  );
  assert.equal(
    schema.safeParse({ ...base, entries: [{ ...entry, archiveReason: "why" }] }).success,
    true,
  );
  assert.equal(
    schema.safeParse({ ...base, entries: [{ ...entry, supersededByMemoryId: 9 }] }).success,
    true,
    "merged 行：supersededByMemoryId 为 number 同样合法",
  );

  for (const [label, bad] of [
    ["entry 未知键", { ...base, entries: [{ ...entry, rejectionReason: "ownership" }] }],
    [
      "entry 缺 supersededByMemoryId",
      { ...base, entries: [{ ...entry, supersededByMemoryId: undefined }] },
    ],
    ["entry 缺 expiresAt", { ...base, entries: [{ ...entry, expiresAt: undefined }] }],
    ["counts 未知键", { ...base, counts: { ...ZERO_COUNTS, bogus: 1 } }],
    ["counts 负数", { ...base, counts: { ...ZERO_COUNTS, merged: -1 } }],
    [
      "truncated 缺席",
      { workspace: SCHEMA_WORKSPACE, available: true, entries: [], counts: ZERO_COUNTS, total: 0 },
    ],
    ["total 缺席", { ...base, total: undefined }],
    ["total 负数", { ...base, total: -1 }],
    ["total 非整数", { ...base, total: 1.5 }],
    ["available 缺席", { ...base, available: undefined }],
  ]) {
    assert.equal(schema.safeParse(bad).success, false, `必须拒绝：${label}`);
  }
});

test("T-R1（schema）：archive 结果信封——outcome 四值直通、bogus 拒、rejectionReason 不得过线", () => {
  const schema = zcodeWorkspaceArchiveMagicContextMemoriesResultSchema;
  const base = { workspace: SCHEMA_WORKSPACE, outcomes: [] };
  assert.equal(schema.safeParse(base).success, true);

  for (const outcome of ["archived", "already-archived", "missing", "rejected"]) {
    assert.equal(
      schema.safeParse({ ...base, outcomes: [{ id: 1, outcome }] }).success,
      true,
      `必须放行 outcome=${outcome}`,
    );
    assert.equal(
      schema.safeParse({ ...base, outcomes: [{ id: 1, outcome, message: "m" }] }).success,
      true,
    );
  }

  assert.equal(
    schema.safeParse({ ...base, outcomes: [{ id: 1, outcome: "bogus" }] }).success,
    false,
    "四值枚举之外必须拒绝",
  );
  assert.equal(
    schema.safeParse({
      ...base,
      outcomes: [{ id: 1, outcome: "archived", rejectionReason: "ownership" }],
    }).success,
    false,
    "rejectionReason 是宿主内部子因（工具面选文案用），wire entry strict 直接拒",
  );
  assert.equal(schema.safeParse({ ...base, outcomes: [{ id: 1 }] }).success, false, "outcome 必填");
  assert.equal(
    schema.safeParse({ ...base, outcomes: [{ outcome: "archived" }] }).success,
    false,
    "id 必填",
  );
});

// ══ B. T-R1 行为侧：列表 / 计数 / 过滤 / 分页 ═════════════════════════════════

test("T-R1：列表三 status 全回（merged 行判定）+ counts 与 getMemoryCountsByStatus 对账", async () => {
  const identity = identityOf(DIRS.list);
  const active = insertRow(
    identity,
    "ARCHITECTURE",
    "list fixture: the export pipeline retries once.",
    {
      importance: 75,
    },
  );
  const permanent = insertRow(identity, "ARCHITECTURE", "list fixture: indentation is two spaces.");
  setRowStatus(permanent.id, "permanent");
  const config = insertRow(identity, "CONFIG_VALUES", "list fixture: the default port is 4021.");
  const naming = insertRow(
    identity,
    "NAMING",
    "list fixture: the retry helper is called backoff().",
  );
  const successor = insertRow(
    identity,
    "ARCHITECTURE",
    "list fixture: successor of the merged row.",
  );
  const merged = insertRow(identity, "ARCHITECTURE", "list fixture: the merged-away duplicate.");
  markSuperseded(merged.id, successor.id);
  const archived = insertRow(identity, "PROJECT_RULES", "list fixture: a retired project rule.");
  setRowStatus(archived.id, "archived");
  // 口径差①（spec 兼容性节）：expires_at=0 的死行——counts 看得见，cutoff=0 的列表
  // 看不见。本仓 TS 写入侧只产 null 或 now+ttl，该行是「外部/历史数据」的复刻。
  const dead = insertRow(identity, "ARCHITECTURE", "list fixture: legacy row with a zero expiry.", {
    expiresAt: 0,
  });

  const result = await listRpc(DIRS.list);
  assert.equal(result.supported, true);
  assert.equal(result.available, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.truncated, false);

  // 列表口径 = listProjectMemoriesForAdmin（三 status、expiryCutoff=0）——直读对账。
  const directIds = magicContext
    .getMemoriesByProject(seedDb, identity, ADMIN_STATUSES, 0)
    .map((memory) => memory.id)
    .sort((left, right) => left - right);
  assert.deepEqual(
    result.entries.map((entry) => entry.id).sort((left, right) => left - right),
    directIds,
  );
  // 落表 8 行：active / permanent / config / naming / successor（5 行 active 桶，
  // 含死行）+ merged（superseded，归 merged 桶）+ archived（1 行）——列表回 7 行
  // （死行被 cutoff=0 滤掉），counts 回 8。
  assert.equal(result.entries.length, 7);
  assert.equal(
    result.entries.some((entry) => entry.id === dead.id),
    false,
    "死行（expires_at=0）不进列表",
  );

  const byId = new Map(result.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(active.id).status, "active");
  assert.equal(byId.get(active.id).expiresAt, null, "无 TTL 类目的 expiresAt 以 null 过线");
  assert.equal(byId.get(active.id).importance, 75, "importance 是行值直通");
  // seenCount 是行值直通（wire 不做重解释；语义是「重复写入计数」，不是使用次数）。
  const activeRow = seedDb.prepare("SELECT seen_count FROM memories WHERE id = ?").get(active.id);
  assert.equal(byId.get(active.id).seenCount, activeRow.seen_count);
  assert.equal(byId.get(permanent.id).status, "permanent");
  assert.equal(byId.get(config.id).category, "CONFIG_VALUES");
  assert.equal(byId.get(naming.id).category, "NAMING");
  assert.equal(byId.get(archived.id).status, "archived");
  // merged 行：status 同样显示 archived（superseded 写路径把 status 置 archived），
  // 靠 supersededByMemoryId 判定/展示（面板「已合并」徽章）。
  assert.equal(byId.get(merged.id).status, "archived");
  assert.equal(byId.get(merged.id).supersededByMemoryId, successor.id);

  // counts 五桶（getMemoryCountsByStatus 口径：superseded 归 merged 不进 archived、无过期过滤）。
  assert.deepEqual(result.counts, { total: 8, active: 5, permanent: 1, archived: 1, merged: 1 });
  const directCounts = magicContext.getMemoryCountsByStatus(seedDb, identity);
  assert.deepEqual(result.counts, {
    total: directCounts.total,
    active: directCounts.active,
    permanent: directCounts.permanent,
    archived: directCounts.archived,
    merged: directCounts.merged,
  });
  assert.equal(result.counts.total, result.entries.length + 1, "口径差①：死行进 counts 不进列表");
});

test("T-R1：跨项目行按身份隔离——不进列表也不计 counts", async () => {
  const own = insertRow(identityOf(DIRS.cross), "ARCHITECTURE", "cross fixture: own project row.");
  const foreign = insertRow(
    identityOf(DIRS.foreign),
    "ARCHITECTURE",
    "cross fixture: foreign row.",
  );

  const result = await listRpc(DIRS.cross);
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    [own.id],
  );
  assert.equal(
    result.entries.some((entry) => entry.id === foreign.id),
    false,
    "外部项目行不得泄漏",
  );
  assert.deepEqual(result.counts, { total: 1, active: 1, permanent: 0, archived: 0, merged: 0 });
});

test("T-R1：category 过滤只裁 entries，counts 保持项目级汇总", async () => {
  const identity = identityOf(DIRS.filter);
  const archA = insertRow(identity, "ARCHITECTURE", "filter fixture: architecture A.");
  const archB = insertRow(identity, "ARCHITECTURE", "filter fixture: architecture B.");
  insertRow(identity, "CONFIG_VALUES", "filter fixture: config A.");

  const all = await listRpc(DIRS.filter);
  assert.equal(all.entries.length, 3);
  assert.equal(all.total, 3, "无过滤时 total = 全集合");

  const filtered = await listRpc(DIRS.filter, { category: "ARCHITECTURE" });
  assert.equal(filtered.total, 2, "total 随 category 过滤收窄（区别于 counts.total）");
  assert.deepEqual(
    filtered.entries.map((entry) => entry.id).sort((left, right) => left - right),
    [archA.id, archB.id].sort((left, right) => left - right),
  );
  assert.equal(
    filtered.entries.every((entry) => entry.category === "ARCHITECTURE"),
    true,
  );
  assert.equal(filtered.truncated, false);
  assert.deepEqual(filtered.counts, all.counts, "counts 是项目级汇总，不随 category 过滤收窄");
  assert.equal(filtered.counts.total, 3);

  const empty = await listRpc(DIRS.filter, { category: "USER_DIRECTIVES" });
  assert.deepEqual(empty.entries, [], "无行分类回空页而不是空项目");
  assert.equal(empty.truncated, false);
  assert.equal(empty.total, 0, "过滤后零命中 → total 0");
  assert.equal(empty.counts.total, 3);

  const paged = await listRpc(DIRS.filter, { category: "ARCHITECTURE", limit: 1 });
  assert.equal(paged.entries.length, 1);
  assert.equal(paged.truncated, true, "truncated 按过滤后的集合算");
  assert.equal(paged.total, 2, "total 不受 limit/offset 影响");
});

test("T-R1：offset/limit 分页与 truncated 语义（当页取尽 → false）", async () => {
  const identity = identityOf(DIRS.page);
  const first = insertRow(identity, "ARCHITECTURE", "page fixture: the first page row.");
  const second = insertRow(identity, "ARCHITECTURE", "page fixture: the second page row.");
  const third = insertRow(identity, "ARCHITECTURE", "page fixture: the third page row.");
  // 列表 SQL 的排序是 (category ASC, updated_at DESC, id ASC)：同分类下显式钉住
  // updated_at，分页断言就不依赖插入的毫秒时序。
  const setUpdatedAt = (id, value) =>
    seedDb.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(value, id);
  setUpdatedAt(first.id, 9_003);
  setUpdatedAt(second.id, 9_002);
  setUpdatedAt(third.id, 9_001);

  const pageOne = await listRpc(DIRS.page, { limit: 2 });
  assert.deepEqual(
    pageOne.entries.map((entry) => entry.id),
    [first.id, second.id],
  );
  assert.equal(pageOne.truncated, true, "本页之后还有条目 → true");

  const pageTwo = await listRpc(DIRS.page, { limit: 2, offset: 2 });
  assert.deepEqual(
    pageTwo.entries.map((entry) => entry.id),
    [third.id],
  );
  assert.equal(pageTwo.truncated, false, "恰好取完 → false");

  const exactly = await listRpc(DIRS.page, { limit: 3 });
  assert.equal(exactly.entries.length, 3);
  assert.equal(exactly.truncated, false);

  const defaultLimit = await listRpc(DIRS.page);
  assert.deepEqual(
    defaultLimit.entries.map((entry) => entry.id),
    [first.id, second.id, third.id],
    "limit 缺省 200：一次取完",
  );
  assert.equal(defaultLimit.truncated, false);

  const beyond = await listRpc(DIRS.page, { offset: 5 });
  assert.deepEqual(beyond.entries, []);
  assert.equal(beyond.truncated, false, "offset 越过末尾不是「还有下一页」");

  // 越界参数在 parseParams 就被拒（-32602），不会进入宿主逻辑（schema 侧已在 A 组钉住）。
  await assert.rejects(
    () => listRpc(DIRS.page, { limit: 201 }),
    (error) => error.name === "ProtocolRequestError" && error.code === -32602,
  );
  await assert.rejects(
    () => listRpc(DIRS.page, { offset: -1 }),
    (error) => error.name === "ProtocolRequestError" && error.code === -32602,
  );
});

// ══ C. T-R2：archive 契约（逐 id 四值直通 / 幂等 / 成对写） ═══════════════════

test("T-R2：正常废弃 → archived + mutation 行成对；重复废弃幂等（already-archived、无新行）", async () => {
  const identity = identityOf(DIRS.archive);
  const firstRow = insertRow(
    identity,
    "CONFIG_VALUES",
    "archive fixture: the legacy flag is retired.",
  );
  const secondRow = insertRow(
    identity,
    "CONFIG_VALUES",
    "archive fixture: the old queue is retired.",
  );

  const result = await archiveRpc(DIRS.archive, [firstRow.id, secondRow.id], {
    reason: "retention cleanup",
  });
  assert.deepEqual(result.workspace, workspaceRef(DIRS.archive));
  assert.deepEqual(
    result.outcomes.map((entry) => [entry.id, entry.outcome]),
    [
      [firstRow.id, "archived"],
      [secondRow.id, "archived"],
    ],
  );
  for (const entry of result.outcomes) {
    assert.equal(typeof entry.message, "string");
    assert.equal(entry.message.length > 0, true);
    // wire entry 只允许 id/outcome/message 三个键（schema strict 的运行时侧对照）。
    assert.deepEqual(Object.keys(entry).sort(), ["id", "message", "outcome"]);
  }

  // 落盘：status + reason（D5：reason 存 metadata_json）+ 成对 mutation 行。
  assert.equal(readRow(firstRow.id).status, "archived");
  assert.equal(readRow(secondRow.id).status, "archived");
  assert.equal(archiveReasonOf(firstRow.id), "retention cleanup");
  assert.deepEqual(
    mutationRowsFor([firstRow.id, secondRow.id]).map((row) => [
      row.target_memory_id,
      row.mutation_type,
      row.project_path,
    ]),
    [
      [firstRow.id, "archive", identity],
      [secondRow.id, "archive", identity],
    ],
    "archive 必须与 mutation 行同生（注入面 <removed/> 渲染读 mutation）",
  );

  // 幂等：第二次全部 already-archived，mutation 行不增。
  const rowsBefore = mutationRowsFor([firstRow.id, secondRow.id]).length;
  const repeated = await archiveRpc(DIRS.archive, [firstRow.id, secondRow.id]);
  assert.deepEqual(
    repeated.outcomes.map((entry) => [entry.id, entry.outcome]),
    [
      [firstRow.id, "already-archived"],
      [secondRow.id, "already-archived"],
    ],
  );
  assert.match(repeated.outcomes[0].message, /already archived/);
  assert.equal(
    mutationRowsFor([firstRow.id, secondRow.id]).length,
    rowsBefore,
    "重复废弃不得新增 mutation 行",
  );

  // 列表侧闭环：archived 行进列表且带 archiveReason；counts 归 archived 桶。
  const listed = await listRpc(DIRS.archive);
  const entry = listed.entries.find((item) => item.id === firstRow.id);
  assert.ok(entry, "archived 行必须仍出现在管理列表里");
  assert.equal(entry.status, "archived");
  assert.equal(entry.archiveReason, "retention cleanup");
  assert.equal(listed.counts.archived, 2);
  assert.equal(listed.counts.merged, 0);

  // 首见序去重：同批重复 id 只处理一次（host 组合函数契约）。
  const dedupRow = insertRow(identity, "NAMING", "archive fixture: the dedup target.");
  const dedup = await archiveRpc(DIRS.archive, [dedupRow.id, dedupRow.id]);
  assert.deepEqual(
    dedup.outcomes.map((item) => [item.id, item.outcome]),
    [[dedupRow.id, "archived"]],
  );
  assert.equal(mutationRowsFor([dedupRow.id]).length, 1, "同一 id 只允许一条 mutation 行");
});

test("T-R2：逐 id 四值直通（missing / 跨项目 rejected / superseded rejected / 已归档 already）", async () => {
  const identity = identityOf(DIRS.mix);
  const eligible = insertRow(identity, "ARCHITECTURE", "mix fixture: the one fresh eligible row.");
  const successor = insertRow(
    identity,
    "ARCHITECTURE",
    "mix fixture: successor of the superseded row.",
  );
  const superseded = insertRow(identity, "ARCHITECTURE", "mix fixture: the superseded row.");
  markSuperseded(superseded.id, successor.id);
  const preArchived = insertRow(identity, "ARCHITECTURE", "mix fixture: the pre-archived row.");
  setRowStatus(preArchived.id, "archived");
  const foreign = insertRow(
    identityOf(DIRS.foreign),
    "ARCHITECTURE",
    "mix fixture: a foreign project row.",
  );
  const missingId = 999_999;
  assert.equal(
    seedDb.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = ?").get(missingId).count,
    0,
    "本用例需要一个库内不存在的 id",
  );

  const result = await archiveRpc(
    DIRS.mix,
    [eligible.id, preArchived.id, superseded.id, foreign.id, missingId],
    { reason: "mixed batch cleanup" },
  );
  assert.deepEqual(
    result.outcomes.map((entry) => [entry.id, entry.outcome]),
    [
      [eligible.id, "archived"],
      [preArchived.id, "already-archived"],
      [superseded.id, "rejected"],
      [foreign.id, "rejected"],
      [missingId, "missing"],
    ],
    "outcomes 必须按首见序逐 id 直通组合函数四值枚举",
  );

  const messageById = new Map(result.outcomes.map((entry) => [entry.id, entry.message]));
  assert.equal(
    messageById.get(superseded.id),
    `Memory with ID ${superseded.id} is archived or superseded; restore it before archiving.`,
    "superseded → 上游 inactiveMemoryError 风格",
  );
  assert.equal(
    messageById.get(foreign.id),
    `Memory [ID: ${foreign.id}] was not found.`,
    "ownership 拒绝 → 不透明 was not found（防泄漏：不暴露外部项目 id 的存在性）",
  );
  assert.equal(messageById.get(missingId), `Memory [ID: ${missingId}] was not found.`);
  for (const entry of result.outcomes) {
    assert.equal("rejectionReason" in entry, false, "rejectionReason 不进 wire");
    assert.equal(
      Object.keys(entry).every((key) => ["id", "outcome", "message"].includes(key)),
      true,
    );
  }
  // 结果信封可被协议 schema 收下（strict 面的端到端复验）。
  assert.doesNotThrow(() => zcodeWorkspaceArchiveMagicContextMemoriesResultSchema.parse(result));

  // 副作用边界：只有 eligible 真正落盘；跨项目行保持 active 且无 mutation 行。
  assert.equal(readRow(eligible.id).status, "archived");
  assert.equal(readRow(foreign.id).status, "active", "跨项目 id 不得被本项目归档");
  assert.equal(mutationRowsFor([eligible.id]).length, 1);
  assert.equal(mutationRowsFor([preArchived.id, superseded.id, foreign.id, missingId]).length, 0);
});

test("T-R2：authority 托管项目 → 可读 ProtocolRequestError 且整批回滚", async () => {
  const identity = identityOf(DIRS.authority);
  const firstRow = insertRow(identity, "PROJECT_RULES", "authority fixture: first managed row.");
  const secondRow = insertRow(identity, "PROJECT_RULES", "authority fixture: second managed row.");
  // authority 标记必须在插入记忆之后：标记一旦落表，同项目的 TS 侧写入即被拒。
  seedDb
    .prepare(
      "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, ?, ?)",
    )
    .run(identity, "test-context-store-uuid", Date.now());

  await assert.rejects(
    () => archiveRpc(DIRS.authority, [firstRow.id, secondRow.id], { reason: "authority check" }),
    (error) => {
      assert.equal(error.name, "ProtocolRequestError");
      assert.equal(error.code, -32010);
      assert.match(error.message, /managed by the memory module/i);
      return true;
    },
  );
  assert.equal(readRow(firstRow.id).status, "active", "fail-visible：整批回滚");
  assert.equal(readRow(secondRow.id).status, "active");
  assert.equal(mutationRowsFor([firstRow.id, secondRow.id]).length, 0);
});

test("T-R2 / ZL-6：跨包副本的 authority 错误仍转可读 -32010（instanceof 失效时）", async () => {
  const identity = identityOf(DIRS.authorityCopy);
  const row = insertRow(identity, "PROJECT_RULES", "authority cross-copy fixture: a managed row.");

  // 构造「两份包副本」的等价条件：错误对象的 name/code 与真类逐字一致，但原型链
  // 不是本进程这一份 `ModuleMemoryAuthorityError`——这正是动态 import 跨越两份副本
  // 时 `instanceof` 的失败形态（旧写法会把 authority 拒绝原文透传成内部报错）。
  const foreignError = new Error(
    `memory writes for module-managed project ${identity} must use the Rust ctx_memory module facade`,
  );
  foreignError.name = "ModuleMemoryAuthorityError";
  foreignError.code = "MEMORY_MODULE_AUTHORITY";
  assert.equal(
    foreignError instanceof magicContext.ModuleMemoryAuthorityError,
    false,
    "构造前提：跨副本时 instanceof 必须为 false（否则测的不是鸭子类型分支）",
  );

  // 用注入缝把组合函数换成「抛跨副本错误」——handler 的捕获段原样执行。
  const crossCopyModule = {
    ...magicContext,
    archiveProjectMemories() {
      throw foreignError;
    },
  };
  await assert.rejects(
    () =>
      archiveMagicContextMemories(
        contextWith(),
        { workspace: workspaceRef(DIRS.authorityCopy), memoryIds: [row.id] },
        { ...DIRECT_OPEN, configPath: ENABLED_CONFIG, loadRuntime: async () => crossCopyModule },
      ),
    (error) => {
      assert.equal(error.name, "ProtocolRequestError");
      assert.equal(error.code, -32010);
      assert.match(error.message, /managed by the memory module/i);
      assert.match(
        error.message,
        /MEMORY_MODULE_AUTHORITY/,
        "message 必须带上稳定的 code 标记（不是 undefined）",
      );
      return true;
    },
  );
  // 组合函数在写入前就抛了；跨副本判据只决定「怎么报」，不改变持久化结果。
  assert.equal(readRow(row.id).status, "active");
});

// ══ D. 降级：effective 门（关着不建库）与库打不开 ════════════════════════════

test("降级：magicContext 关闭（文件侧）→ available:false，且连库文件都不产生", async () => {
  const drillDbPath = join(TEMP_ROOT, "disabled-drill.db");
  await withDatabasePath(drillDbPath, async () => {
    const result = await listRpc(DIRS.list, {}, { configPath: DISABLED_CONFIG });
    assert.equal(result.supported, true, "supported 说的是「CLI 有这个能力」，与开关无关");
    assert.equal(result.available, false);
    assert.equal(result.reason, "disabled");
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.counts, ZERO_COUNTS);
    assert.equal(result.truncated, false);
    assert.equal(existsSync(drillDbPath), false, "effective 门关着时禁止建库（关掉不建库纪律）");
    assert.equal(existsSync(`${drillDbPath}-wal`), false);
  });
});

test("降级：ConfigPort 优先——disabled 短路；文件说 disabled 但 ConfigPort enabled 时照常开库", async () => {
  // ① ConfigPort 说 disabled（设置页刚提交的那份配置）→ 同一零值信封、不建库。
  const disabledDbPath = join(TEMP_ROOT, "disabled-config-port.db");
  const disabledPort = createConfigPort({});
  disabledPort.set(ConfigKey.MagicContext, MagicContextConfigSchema.parse({ enabled: false }));
  await withDatabasePath(disabledDbPath, async () => {
    const result = await listRpc(
      DIRS.list,
      {},
      { context: contextWith(sessionRecord(disabledPort)), configPath: ENABLED_CONFIG },
    );
    assert.equal(result.available, false);
    assert.equal(result.reason, "disabled");
    assert.equal(existsSync(disabledDbPath), false);
  });

  // ② 文件说 disabled、ConfigPort 说 enabled → 以 ConfigPort 为准（D-12 热推语义）。
  const enabledPort = createConfigPort({});
  enabledPort.set(ConfigKey.MagicContext, MagicContextConfigSchema.parse({ enabled: true }));
  const result = await listRpc(
    DIRS.list,
    {},
    { context: contextWith(sessionRecord(enabledPort)), configPath: DISABLED_CONFIG },
  );
  assert.equal(
    result.available,
    true,
    "resident session 的 ConfigPort 才是运行时真正在用的那份配置",
  );
  assert.equal(result.supported, true);
});

test("降级：库打不开 → list 收敛 available:false(unavailable)；archive 原文透传（BUSY 转译依赖）", async () => {
  await withDatabasePath(BAD_DB_PATH, async () => {
    const listed = await listRpc(DIRS.list);
    assert.equal(listed.available, false);
    assert.equal(listed.reason, "unavailable");
    assert.deepEqual(listed.entries, []);
    assert.deepEqual(listed.counts, ZERO_COUNTS);

    // archive 侧刻意不吞原文：services 层的 SQLITE_BUSY 可重试转译靠 message 匹配
    // （Step 5 的 isSqliteBusyError），这里重包一层会把可重试信号吃掉。
    await assert.rejects(
      () => archiveRpc(DIRS.archive, [1]),
      (error) => {
        assert.notEqual(error.name, "ProtocolRequestError");
        assert.match(error.message, /storage unavailable|unable to open/i);
        return true;
      },
    );
  });
});

test("降级：关闭态 archive 反射式拒绝（-32010 可读错误）且不建库；参数校验先于 effective 门", async () => {
  const drillDbPath = join(TEMP_ROOT, "disabled-archive.db");
  await withDatabasePath(drillDbPath, async () => {
    await assert.rejects(
      () => archiveRpc(DIRS.archive, [1], { configPath: DISABLED_CONFIG, reason: "must not land" }),
      (error) => {
        assert.equal(error.name, "ProtocolRequestError");
        assert.equal(error.code, -32010);
        assert.match(error.message, /disabled/i);
        return true;
      },
      "archive 的结果信封没有 available 位，空 outcomes 会被 UI 读成「什么都没发生」，必须抛可读错误",
    );
    assert.equal(existsSync(drillDbPath), false, "拒绝路径不得建库");
  });

  // 空 memoryIds 在 parseParams（schema min(1)）就被拒——先于 effective 门。
  await assert.rejects(
    () => archiveRpc(DIRS.archive, []),
    (error) => error.name === "ProtocolRequestError" && error.code === -32602,
  );
});

// ══ D2. 降级/失败分支（G-2）：身份解析失败 ×2 与 openDatabase null ×2 ═════════

test("降级：身份解析失败——list 收敛 unavailable 信封（家目录不视为项目，只读探测不写盘）", async () => {
  // 家目录是 resolveProjectIdentityForSession 刻意拒绝的目录：homeProjectPermission
  // 默认 false，且全仓无 setHomeProjectPermission 调用者（project-identity.ts:717-747）。
  const home = homedir();
  assert.equal(
    magicContext.resolveProjectIdentityForSession(home),
    undefined,
    "构造前提：家目录必须解析不出项目身份（否则本用例测的不是该分支）",
  );

  const result = await listRpc(home);
  assert.equal(result.supported, true, "supported 说的是「CLI 有这个能力」，与失败分支无关");
  assert.equal(
    result.available,
    false,
    "身份解析不出 → 占位态；回空列表会误导成「本项目没有记忆」",
  );
  assert.equal(result.reason, "unavailable");
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.counts, ZERO_COUNTS);
  assert.equal(result.truncated, false);
});

test("降级：身份解析失败——archive fail-visible（-32010 可读错误，无 outcomes、零 mutation 行）", async () => {
  const mutationsBefore = mutationRowCount();

  await assert.rejects(
    () => archiveRpc(homedir(), [1, 2], { reason: "must not land" }),
    (error) => {
      assert.equal(error.name, "ProtocolRequestError");
      assert.equal(error.code, -32010);
      assert.match(error.message, /no usable project identity/);
      assert.equal(
        "outcomes" in error,
        false,
        "拒绝必须是错误而不是空 outcomes 结果（空 outcomes 会被 UI 读成「什么都没发生」）",
      );
      return true;
    },
  );
  assert.equal(
    mutationRowCount(),
    mutationsBefore,
    "身份解析失败必须在任何持久化之前拒绝（零 mutation 行）",
  );
});

test("降级：openDatabase 回 null（schema fence）→ list 收敛 unavailable 信封；archive 给可读错误（null 分支，区别于 throw 的原文透传）", async () => {
  const fenceDbPath = join(TEMP_ROOT, "schema-fence.db");
  await withDatabasePath(fenceDbPath, async () => {
    // 专用库 P：先正常建库并挂进进程级句柄缓存（与生产长活进程复用句柄同语义）。
    const fenceDb = magicContext.openDatabase(magicContext.getMagicContextDatabasePath());
    assert.ok(fenceDb, "构造前提：专用库 P 必须能正常建起来");

    // node:sqlite 直连 P，把 ledger 全量 MAX（本 build 的 head = fork 车道 10000）
    // 整体 +1。读侧修复后 getPersistedSchemaVersion 读全量 MAX（不再过滤
    // version < 10000），伪造的 10001 越过 LATEST_SUPPORTED_VERSION=10000 即触发
    // fence；旧的「只抬 <10000 窗口 MAX」构造会被 v10000 行淹没而恒放行。
    const raw = new DatabaseSync(fenceDbPath);
    const readMaxVersion = () =>
      raw.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()
        .version;
    let versionBefore;
    let versionAfter;
    try {
      versionBefore = readMaxVersion();
      raw.exec(
        "UPDATE schema_migrations SET version = version + 1 WHERE version = (SELECT MAX(version) FROM schema_migrations)",
      );
      versionAfter = readMaxVersion();
    } finally {
      raw.close();
    }
    assert.equal(versionBefore, 10000, "构造前提：本 build 的 ledger head 是 fork 车道 v10000");
    assert.equal(versionAfter, 10001, "构造前提：必须把全量 MAX 行抬到 fence 之上");

    // 仍以同一路径 P 调 list：existing 分支（storage-db.ts:2689-2692）再次 fence → null，
    // 有 available:false 信封承载，收敛 unavailable（不是抛 -32603 冒泡）。
    const listed = await listRpc(DIRS.fence);
    assert.equal(listed.supported, true);
    assert.equal(listed.available, false);
    assert.equal(listed.reason, "unavailable");
    assert.deepEqual(listed.entries, []);
    assert.deepEqual(listed.counts, ZERO_COUNTS);
    assert.equal(listed.truncated, false);

    const fence = magicContext.getSchemaFenceRejection();
    assert.ok(fence, "list 的 unavailable 必须来自 schema fence 拒绝（而不是别的开库失败）");
    assert.equal(fence.persistedVersion, versionAfter);
    assert.equal(fence.supportedVersion, versionBefore);
    assert.equal(fence.persistedVersion > fence.supportedVersion, true);

    // archive 同路径同分支：null 是确定性打不开 → 可读 -32010；与「openDatabase throw
    // （BUSY/不可写）原文透传」是两种可观察行为（throw 分支在「库打不开」用例已钉住）。
    await assert.rejects(
      () => archiveRpc(DIRS.fence, [1]),
      (error) => {
        assert.equal(error.name, "ProtocolRequestError");
        assert.equal(error.code, -32010);
        assert.match(error.message, /storage is unavailable right now/i);
        return true;
      },
    );

    try {
      fenceDb.close();
    } catch {
      // 关闭失败只影响临时树清理，不改变测试结论。
    }
  });
});

// ══ D3. T-MC5 第三态：业务符号（barrel）加载失败 —— ZL-4 注入缝 ═══════════════
//
// `magic-context-memories.ts:275-333` 的两条「业务符号取不到」分支此前**无法测试**：
// 生产路径上包在 manifest 里，`import("@zcode/magic-context")` 不会抛；没有注入点就
// 只能靠读代码相信它。下面两例经 `dependencies.loadRuntime` 构造该态。

test("降级：业务符号加载失败——list 收敛 unavailable 信封（T-MC5 第三态）", async () => {
  const drillDbPath = join(TEMP_ROOT, "runtime-load-failed-list.db");
  await withDatabasePath(drillDbPath, async () => {
    const result = await listMagicContextMemories(
      contextWith(),
      { workspace: workspaceRef(DIRS.list) },
      { ...DIRECT_OPEN, configPath: ENABLED_CONFIG, loadRuntime: failingRuntime() },
    );
    assert.equal(result.supported, true, "supported 说的是「CLI 有这个能力」，与加载失败无关");
    assert.equal(result.available, false);
    assert.equal(
      result.reason,
      "unavailable",
      "业务符号取不到必须是 unavailable 信封而不是 -32603（T-MC5 的口径）",
    );
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.counts, ZERO_COUNTS);
    assert.equal(result.truncated, false);
    assert.equal(result.total, 0);
    assert.equal(existsSync(drillDbPath), false, "业务符号没取到就在开库之前收敛，不得建库");
  });
});

test("降级：业务符号加载失败——archive 抛可读 -32010（T-MC5 第三态）", async () => {
  const drillDbPath = join(TEMP_ROOT, "runtime-load-failed-archive.db");
  await withDatabasePath(drillDbPath, async () => {
    await assert.rejects(
      () =>
        archiveMagicContextMemories(
          contextWith(),
          { workspace: workspaceRef(DIRS.archive), memoryIds: [1] },
          { ...DIRECT_OPEN, configPath: ENABLED_CONFIG, loadRuntime: failingRuntime() },
        ),
      (error) => {
        assert.equal(error.name, "ProtocolRequestError");
        assert.equal(error.code, -32010);
        assert.match(error.message, /not installed in this build/i);
        assert.match(
          error.message,
          /simulated: magic-context barrel unavailable/,
          "底层错误原因必须带上（可读，不是空壳消息）",
        );
        assert.equal("outcomes" in error, false, "拒绝必须是错误而不是空 outcomes 结果");
        return true;
      },
    );
    assert.equal(existsSync(drillDbPath), false, "加载失败发生在开库之前，不得建库");
  });
});

// ══ D4. 存储端口（spec phase-zero-load / W2 / 变更点 #11）：装配没装成 → 不自开库 ══

/**
 * 一个「参与了装配、但没有可用库」的 App，等价于生产上的 db_null / 装配抛错 /
 * import_failed：端口在场，`getMagicContextStorage()` 回 `null`。
 */
function sessionRecordWithStorage(getStorage) {
  return { app: { getMagicContextStorage: getStorage } };
}

test("端口：getMagicContextStorage()=null → list 回 unavailable，且不建库、不加载 barrel", async () => {
  const dbPath = join(TEMP_ROOT, "port-null-list.db");
  let runtimeLoaded = 0;
  await withDatabasePath(dbPath, async () => {
    const result = await listMagicContextMemories(
      contextWith(sessionRecordWithStorage(() => null)),
      { workspace: workspaceRef(DIRS.portNull) },
      {
        configPath: ENABLED_CONFIG,
        loadRuntime: async () => {
          runtimeLoaded += 1;
          throw new Error("the port already answered unavailable; the barrel must not load");
        },
      },
    );
    assert.equal(result.supported, true, "信封承载「没装成」，绝不冒泡成 -32603");
    assert.equal(result.available, false);
    assert.equal(result.reason, "unavailable");
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.counts, ZERO_COUNTS);
    assert.equal(result.truncated, false);
    assert.equal(runtimeLoaded, 0, "端口已给 unavailable，连业务符号都不该加载");
    assert.equal(
      existsSync(dbPath),
      false,
      "**不得创建库文件**：旧行为会在这里 openDatabase（创建 + 迁移）——那正是端口要根治的缺陷",
    );
  });
});

test("端口：getMagicContextStorage()=null → archive 抛可读 -32010，且不建库", async () => {
  const dbPath = join(TEMP_ROOT, "port-null-archive.db");
  let runtimeLoaded = 0;
  await withDatabasePath(dbPath, async () => {
    await assert.rejects(
      () =>
        archiveMagicContextMemories(
          contextWith(sessionRecordWithStorage(() => null)),
          { workspace: workspaceRef(DIRS.portNull), memoryIds: [1] },
          {
            configPath: ENABLED_CONFIG,
            loadRuntime: async () => {
              runtimeLoaded += 1;
              throw new Error("the port already answered unavailable; the barrel must not load");
            },
          },
        ),
      (error) => {
        assert.equal(error.name, "ProtocolRequestError");
        assert.equal(error.code, -32010);
        assert.match(error.message, /cannot be archived right now/i);
        // 两条 blocked 文案必须**互不串台**（cr-func 第 3 轮 P2-6）：端口回 null 是
        // 装配没装成 → 建议重试/重启；说「开会话」在这里是假建议（开了也没用）。
        assert.match(error.message, /retry in a moment or restart the CLI/i);
        assert.doesNotMatch(error.message, /open or resume a session in this workspace first/i);
        assert.doesNotMatch(error.message, /getMagicContextStorage|workspace-level RPC/i);
        return true;
      },
    );
    assert.equal(runtimeLoaded, 0);
    assert.equal(existsSync(dbPath), false, "写路径同样不得在装配缺席时把库造出来");
  });
});

// ══ D5. absent 的生产可达性（cr-func 第 2 轮 P1-2）════════════════════════════
//
// `context.sessions` 构造时为空（server.ts:256）、closeSession 会 delete
// （server-operations.ts:2581），而这两条 RPC 是 **workspace 级**、不接 sessionId。
// 于是「冷启动 CLI」或「会话全关后在设置里打开记忆面板」就是 `absent` 态——旧实现
// 在这一态保留自开库兜底，等于生产上一条只读 RPC 会创建并迁移数据库。

test("absent（零 session，workspace 级 RPC）→ list 回 no-app-port 且不建库、不加载 barrel", async () => {
  const dbPath = join(TEMP_ROOT, "absent-prod-list.db");
  let runtimeLoaded = 0;
  await withDatabasePath(dbPath, async () => {
    const result = await listMagicContextMemories(
      // 空 sessions = 生产上「冷启动 / 会话全关」的形态。
      contextWith(),
      { workspace: workspaceRef(DIRS.portNull) },
      {
        configPath: ENABLED_CONFIG,
        loadRuntime: async () => {
          runtimeLoaded += 1;
          throw new Error("absent must be rejected before the barrel loads");
        },
      },
    );
    assert.equal(result.supported, true);
    assert.equal(result.available, false);
    assert.equal(
      result.reason,
      "no-app-port",
      "absent 必须单独过线（cr-func 第 3 轮 P1-1）：与「装配没装成」共用 unavailable 时，面板只能写「稍后重试」——而这一态下重试永远不会成功",
    );
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.counts, ZERO_COUNTS);
    assert.equal(runtimeLoaded, 0, "absent 门排在 barrel 之前，业务符号一律不加载");
    assert.equal(
      existsSync(dbPath),
      false,
      "**不得创建库文件**：这是 P1-2 的原始缺陷（冷启动打开记忆面板 = 建库 + 迁移）",
    );
    assert.equal(existsSync(`${dbPath}-wal`), false);
  });
});

test("absent（零 session）→ archive 抛可读 -32010 且不建库（写路径更不自开库）", async () => {
  const dbPath = join(TEMP_ROOT, "absent-prod-archive.db");
  let runtimeLoaded = 0;
  await withDatabasePath(dbPath, async () => {
    await assert.rejects(
      () =>
        archiveMagicContextMemories(
          contextWith(),
          { workspace: workspaceRef(DIRS.portNull), memoryIds: [1] },
          {
            configPath: ENABLED_CONFIG,
            loadRuntime: async () => {
              runtimeLoaded += 1;
              throw new Error("absent must be rejected before the barrel loads");
            },
          },
        ),
      (error) => {
        assert.equal(error.name, "ProtocolRequestError");
        assert.equal(error.code, -32010);
        assert.match(error.message, /cannot be archived right now/i);
        assert.match(
          error.message,
          /open or resume a session in this workspace first/i,
          "absent 的错误必须给出可执行动作（cr-func 第 3 轮 P2-6）：开会话是这一态唯一的解法",
        );
        // 用户可见串不得带实现名（旧文案是「no app exposes getMagicContextStorage
        // (workspace-level RPC with zero live sessions: …)」——嵌套括号、内部机制、不可操作）。
        assert.doesNotMatch(error.message, /getMagicContextStorage|workspace-level RPC/i);
        assert.doesNotMatch(
          error.message,
          /retry in a moment or restart the CLI/i,
          "「稍后重试 / 重启」是装配没装成那一条的建议；absent 照抄就是假建议",
        );
        return true;
      },
    );
    assert.equal(runtimeLoaded, 0);
    assert.equal(existsSync(dbPath), false, "absent 的写路径不得把库造出来");
  });
});

test("absent + 显式 allowDirectOpen → 才走直构夹具的自开库（口子只剩这一条）", async () => {
  const dbPath = join(TEMP_ROOT, "absent-direct-open.db");
  await withDatabasePath(dbPath, async () => {
    const result = await listMagicContextMemories(
      contextWith(),
      { workspace: workspaceRef(DIRS.portInstalled) },
      { ...DIRECT_OPEN, configPath: ENABLED_CONFIG },
    );
    assert.equal(result.available, true, "显式标记是直构夹具唯一的自开库通路");
    assert.equal(existsSync(dbPath), true, "显式标记下确实由 handler 自己把库开出来");
  });
});

// ══ D6. installed 态：装配层句柄被真正消费（cr-func 第 2 轮 P1-3 / P2-7）══════

test("installed：端口给出的句柄被直接使用——不自开库、不读目标路径", async () => {
  const identity = identityOf(DIRS.portInstalled);
  const row = insertRow(
    identity,
    "ARCHITECTURE",
    "port fixture: served from the assembly handle, not from openDatabase().",
  );
  const probePath = join(TEMP_ROOT, "installed-should-not-open.db");
  let runtimeLoaded = 0;
  await withDatabasePath(probePath, async () => {
    const result = await listMagicContextMemories(
      contextWith(sessionRecordWithStorage(() => ({ db: seedDb }))),
      { workspace: workspaceRef(DIRS.portInstalled) },
      {
        configPath: ENABLED_CONFIG,
        // 业务符号仍需加载（列表投影在包内），但**开库**必须用端口句柄。
        loadRuntime: async () => {
          runtimeLoaded += 1;
          return magicContext;
        },
      },
    );
    assert.equal(result.available, true);
    assert.equal(runtimeLoaded, 1);
    assert.deepEqual(
      result.entries.map((entry) => entry.id),
      [row.id],
      "读到的必须是端口句柄那个库里的行（证明 installed 分支被走到）",
    );
    assert.equal(
      existsSync(probePath),
      false,
      "installed 态不得再 openDatabase：目标路径连文件都不该出现",
    );
  });
});

test("installed：多个 App 里第一个回 null、第二个有句柄 → 用第二个（任一有句柄即用）", async () => {
  const identity = identityOf(DIRS.portInstalled);
  const row = insertRow(
    identity,
    "NAMING",
    "multi-app fixture: the second app's handle must be the one that serves this row.",
  );
  const probePath = join(TEMP_ROOT, "multi-app-should-not-open.db");
  await withDatabasePath(probePath, async () => {
    const result = await listMagicContextMemories(
      // 顺序是刻意的：第一个持有端口但回 null（临时 workspace app），第二个才有句柄。
      contextWith(
        sessionRecordWithStorage(() => null),
        sessionRecordWithStorage(() => ({ db: seedDb })),
      ),
      { workspace: workspaceRef(DIRS.portInstalled) },
      { configPath: ENABLED_CONFIG, loadRuntime: async () => magicContext },
    );
    assert.equal(
      result.available,
      true,
      "第一个端口回 null 不得让整体判 unavailable——另一个 App 真有句柄（P2-7）",
    );
    assert.ok(
      result.entries.some((entry) => entry.id === row.id),
      "必须用第二个 App 的句柄读到那一行（证明不是「第一个说了算」）",
    );
    assert.equal(existsSync(probePath), false);
  });
});

// ══ E. 源守卫：dispatch 路由（四处手工对齐坐标 ③ 的常驻证据，G-1） ══════════

test("源守卫：server.ts dispatch 必须保留两条 case 与 return 字面量（四处手工对齐坐标 ③）", () => {
  const serverPath = fileURLToPath(new URL("../src/zcode-protocol/server.ts", import.meta.url));
  // 剥注释再匹配（T-O1 先例）：块注释与 `// case …` 行注释都不得误命中。
  const source = readFileSync(serverPath, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const caseFamilies = [
    ...source.matchAll(
      /^\s*case zcodeProtocolMethods\.workspace(List|Archive)MagicContextMemories:\s*$/gm,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    caseFamilies.sort(),
    ["Archive", "List"],
    "四处手工对齐坐标 ③（CLI switch case）失守：server.ts 剥注释后必须各有且仅有一处 list/archive 的 case",
  );

  for (const [family, handlerName] of [
    ["List", "listMagicContextMemories"],
    ["Archive", "archiveMagicContextMemories"],
  ]) {
    const call = `return await ${handlerName}(this.context, request.params);`;
    assert.ok(
      source.includes(call),
      `四处手工对齐坐标 ③（CLI switch case）失守：server.ts 缺少字面量「${call}」`,
    );
    assert.match(
      source,
      new RegExp(
        `case zcodeProtocolMethods\\.workspace${family}MagicContextMemories:\\s+` +
          call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      `四处手工对齐坐标 ③（CLI switch case）失守：workspace${family}MagicContextMemories 的 case 后必须直接 return「${call}」`,
    );
  }
});
