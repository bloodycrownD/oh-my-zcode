#!/usr/bin/env node
/**
 * ⑤ boot busy 有界重试 + transform_absent 事件面（bugfix-batch-20261009，5a/5b/5e/5f）。
 *
 * ============================================================================
 * 这一步要钉死什么
 * ============================================================================
 *
 * 桌面端「压缩停机且完全静默」的修复由三块机制组成，本脚本覆盖其中两块的可观测
 * 一面与重试一面：
 *
 *   T1 占锁 → 退避重试 → 解锁后装配成功。子进程以 `BEGIN IMMEDIATE` 握住写锁，
 *      驱动**真实的** bootstrap 装配工厂（生产退避序列 1s/2s/4s/8s），断言前几次
 *      尝试失败、重试事件带 attempt/retryInMs、解锁后工厂返回 transform——且这条
 *      路径**不**产生 transform_absent（它缺席过，但恢复了）。
 *   T2 锁不释放 → 重试耗尽后仍 throw（fail-closed 不被偷换成静默降级），且抛出
 *      的错误在 cause 链上保留底层 busy 类型（5e 的 `{ cause }` + 分类函数）。
 *   T3 确定性失败不重试；分类只认 cause 不认 message（5e 契约的反向断言）。
 *   T4 enabled=false：发 `magic_context.transform_absent`（reason=disabled）后
 *      return undefined，且**不开库**。
 *   T5 db_null + fail_closed_blocking=false：发事件（reason=db_null:fence）后降级。
 *   T6 db_null + fail_closed_blocking=true：**先发事件、再 throw**（事件不能因为
 *      fail-closed 而缺席）。
 *
 * 隔离（硬规矩）：所有库写入只落在 `<repo>/node_modules/.cache` 下的 mkdtemp 临时
 * 目录（显式 `MAGIC_CONTEXT_DB_DIR`，日志同步改指 `MAGIC_CONTEXT_LOG_PATH`），
 * **绝不触碰用户真实的 `~/.omz`**（RULE.md 已登记 S30 事故；data-path.ts 的
 * TEST-ISOLATION GUARD 注释记载了两次未隔离测试迁移真实库的事故）。
 *
 * 依赖已构建的 dist：`@zcode/magic-context`（本包）与
 * `apps/zcode-cli/packages/bootstrap`（5a 的重试装配在 bootstrap 的
 * `magic-context-turn-transform.ts`）。本脚本按 bootstrap 侧测试的手法用
 * registerHooks 把发布原始 TypeScript 的 `@zcode/shared` /
 * `@zcode/model-option-map` / `@zcode/provider` 改指到它们的编译产物。
 *
 * Exits 0 on success, 1 on any failed assertion（node:test 自行置退出码）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const NODE = process.execPath;

// @zcode/shared / @zcode/model-option-map / @zcode/provider 的包入口发布的是原始
// TypeScript（`exports["."] = "./src/index.ts"`），裸 node 既无法把内部 `.js`
// 说明符改指到 `.ts`，也会在 strip-only 模式下拒绝参数属性。与
// bootstrap/scripts/test-magic-context-*.mjs 同一手法：只改解析，不桩被测代码。
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map", "@zcode/provider"]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO}packages/${packageName.slice("@zcode/".length)}/dist/`;
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

const {
  getMagicContextDatabasePath,
  initializeMagicContextHost,
  isTransientStorageOpenError,
  openDatabase,
} = await import("@zcode/magic-context");

// 5a 的重试装配在 bootstrap 的 app 层（工厂 + 导出的重试 helper）。与
// bootstrap 自己的脚本一样按文件路径加载 dist。
const BOOTSTRAP_TRANSFORM_DIST = join(
  REPO,
  "apps",
  "zcode-cli",
  "packages",
  "bootstrap",
  "dist",
  "app",
  "magic-context-turn-transform.js",
);
if (!existsSync(BOOTSTRAP_TRANSFORM_DIST)) {
  throw new Error(
    `missing ${BOOTSTRAP_TRANSFORM_DIST} — run \`pnpm --filter @zcode/bootstrap build\` first`,
  );
}
const { createMagicContextTurnTransform, openMagicContextStorageWithBusyRetry } = await import(
  pathToFileURL(BOOTSTRAP_TRANSFORM_DIST).href
);

// S15 遗留 #6 的契约入口（idempotent）：在任何 DB 写之前锁定 harness。生产路径由
// 装配工厂负责，本脚本绕开工厂直接调 openDatabase 的用例（T2/T3）必须先过一次。
initializeMagicContextHost();

// ── 隔离 ────────────────────────────────────────────────────────────────────

const CACHE_ROOT = join(REPO, "node_modules", ".cache");
const tempDirs = [];

/**
 * 新建一个临时库目录并让本进程的 magic-context 解析指向它。
 *
 * `getMagicContextStorageResolution()` 每次调用现读 env，因此不必重启进程；但目录
 * **必须**在本仓 node_modules/.cache 下（见文件头硬规矩），这里的 assert 是自检：
 * 真把它指到别处（比如 ~/.omz），测试会在真实库上跑迁移。
 */
function newDbDir(prefix) {
  const dir = mkdtempSync(join(CACHE_ROOT, `magic-context-${prefix}-`));
  assert.ok(
    dir.startsWith(CACHE_ROOT),
    `isolation violation: ${dir} is not under ${CACHE_ROOT}`,
  );
  tempDirs.push(dir);
  process.env.MAGIC_CONTEXT_DB_DIR = dir;
  process.env.MAGIC_CONTEXT_LOG_PATH = join(dir, "magic-context.log");
  return dir;
}

// ── 持锁子进程 ──────────────────────────────────────────────────────────────

/**
 * 持写锁的对手进程。`BEGIN IMMEDIATE` 在空库上即可取到 RESERVED 锁（实证：锁在
 * 手时任何写语句都会以 SQLITE_BUSY 失败），本进程不做 busy 等待——它的职责就是
 * 把锁握牢，让对手看到 busy。
 *
 * holdMs > 0：到点自行退出（解锁）；holdMs = 0：持到父进程 SIGKILL。
 */
const HOLDER_SOURCE = `import { DatabaseSync } from "node:sqlite";
const [dbPath, holdMsText] = process.argv.slice(2);
const holdMs = Number.parseInt(holdMsText, 10);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");
// 就绪信号：写锁已到手，父进程可以开始尝试开库了。
process.stdout.write("LOCK-READY\\n");
if (Number.isFinite(holdMs) && holdMs > 0) {
    // 到点自行退出（解锁）。ref 住的 timer 把事件循环吊住，进程才会活着持锁。
    setTimeout(() => process.exit(0), holdMs);
} else {
    // 持到父进程 SIGKILL。空事件循环会让 node 立刻退出、锁就放了，所以用一个
    // ref 住的 interval 保活（没有任何其它可 await 的东西）。
    setInterval(() => {}, 1_000);
}
`;

const holders = new Set();

function spawnHolder(dbPath, holdMs) {
  const holderPath = join(process.env.MAGIC_CONTEXT_DB_DIR, "holder.mjs");
  writeFileSync(holderPath, HOLDER_SOURCE);
  const child = spawn(NODE, ["--no-warnings", holderPath, dbPath, String(holdMs)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  holders.add(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk);
      if (!buffer.includes("LOCK-READY")) return;
      settled = true;
      child.stdout?.off("data", onData);
      resolve(child);
    };
    child.stdout?.on("data", onData);
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`lock holder exited before taking the lock (code ${code})`));
      }
    });
  });
}

function killHolder(child) {
  holders.delete(child);
  try {
    child.kill("SIGKILL");
  } catch {
    // 已经退了。
  }
}

/** 等持锁子进程退出；已经退了就立即 resolve（退出事件不会二次触发）。 */
function whenHolderExits(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.on("exit", resolve));
}

/** 伪造成「库比本 build 新」：schema_migrations 里放一条高于 fence(94) 的上游 lane 版本。 */
function seedFencedDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    db.exec(
      "INSERT INTO schema_migrations (version, description, applied_at) VALUES (94, 'fork-test baseline', 0), (95, 'fork-test future version', 0)",
    );
  } finally {
    db.close();
  }
}

// ── 捕获型 logger ────────────────────────────────────────────────────────────

function capturingLogger() {
  const entries = [];
  const logger = {
    info() {},
    debug() {},
    warn(message, context) {
      entries.push({ level: "warn", message, context });
    },
    error(message, _error, context) {
      entries.push({ level: "error", message, context });
    },
    child() {
      return logger;
    },
  };
  return { logger, entries };
}

const eventsOf = (entries, event) => entries.filter((entry) => entry.context?.event === event);

// ── 用例 ─────────────────────────────────────────────────────────────────────

test("T1 占锁 → 退避重试 → 解锁后装配成功（工厂端到端，真实退避序列）", async () => {
  const dir = newDbDir("boot-busy-retry");
  const dbPath = join(dir, "magic-context.db");
  // 持锁 5s。生产序列 [1s,2s,4s,8s] 的尝试时刻约为 0s/1s/3s/7s/15s，前 3 次必撞锁，
  // 第 4 次（约 7s）锁已释放 ⇒ 至少 3 次重试后成功。
  const holder = await spawnHolder(dbPath, 5_000);
  const { logger, entries } = capturingLogger();
  let close;
  let transform;
  try {
    transform = await createMagicContextTurnTransform({
      enabled: true,
      sessionId: "ses_boot_busy_retry",
      workingDirectory: dir,
      logger,
      registerClose: (fn) => {
        close = fn;
      },
    });
  } finally {
    // MF-05 收口链：drain → shutdown → dispose，别把在飞句柄留给下一个用例。
    if (close) await close();
  }
  assert.ok(transform, "重试成功后工厂必须返回 transform，而不是 undefined");
  assert.equal(typeof transform.isEnabled, "function");
  const retryEvents = eventsOf(entries, "magic_context.storage_open_retry");
  assert.ok(
    retryEvents.length >= 3,
    `占锁 5s 期间至少应发生 3 次退避重试，实际 ${retryEvents.length} 次`,
  );
  assert.equal(retryEvents[0].context?.reason, "storage_busy_retry");
  assert.equal(retryEvents[0].context?.attempt, 1, "第一次重试事件应标记 attempt=1");
  assert.equal(retryEvents[1].context?.attempt, 2);
  assert.equal(retryEvents[0].context?.retryInMs, 1_000, "第一档退避必须是 1s");
  // 这条路径最终没有缺席：恢复后不允许留下 transform_absent。
  assert.deepEqual(eventsOf(entries, "magic_context.transform_absent"), []);
  await whenHolderExits(holder);
  assert.equal(holder.exitCode, 0, "到点后持锁子进程应自行退出");
});

test("T2 锁不释放 → 重试耗尽后仍 throw，且错误带 cause（5e 分类可用）", async () => {
  const dir = newDbDir("boot-busy-exhaust");
  const dbPath = join(dir, "magic-context.db");
  const holder = await spawnHolder(dbPath, 0);
  const { logger, entries } = capturingLogger();
  let caught;
  try {
    // 注入短退避序列（与包内 runMigrationsWithRetry 的 retryDelaysMs 测试缝同一
    // 手法）：autocommit 路径的短 busy_timeout 让每次尝试只花几十毫秒，序列总耗时
    // 远小于生产序列的 15s。控制流与生产逐行相同。
    await openMagicContextStorageWithBusyRetry(() => openDatabase(getMagicContextDatabasePath()), {
      logger,
      delaysMs: [10, 20, 40, 80],
    });
  } catch (error) {
    caught = error;
  } finally {
    killHolder(holder);
  }
  assert.ok(caught instanceof Error, "重试上界后必须抛错，而不是静默降级");
  assert.match(
    caught.message,
    /^\[magic-context\] storage unavailable: /,
    "上界后仍维持既有的 fail-closed 文案",
  );
  // 5e：catch 用 `{ cause }` 保留了底层 busy 错误（原始 sqlite 错误 errcode=5），
  // 判定函数必须能在 cause 链上认出它——否则 5a 的重试分类就是空话。
  assert.equal(isTransientStorageOpenError(caught), true, "包装后的错误必须保留 busy 类型");
  const retryEvents = eventsOf(entries, "magic_context.storage_open_retry");
  assert.equal(retryEvents.length, 4, "注入 4 档退避 ⇒ 恰好 4 次重试事件后上界 throw");
  assert.equal(retryEvents.at(-1).context?.attempt, 4);
});

test("T3 确定性失败不重试；忙分类只认 cause 不认 message", async () => {
  const { logger, entries } = capturingLogger();
  const deterministic = new Error(
    "[magic-context] storage unavailable: file is not a database. Magic Context is disabled for this run; check log for details.",
  );
  await assert.rejects(
    () =>
      openMagicContextStorageWithBusyRetry(
        () => {
          throw deterministic;
        },
        { logger, delaysMs: [10, 20] },
      ),
    (error) => error === deterministic,
    "确定性失败必须原样上抛",
  );
  assert.deepEqual(
    eventsOf(entries, "magic_context.storage_open_retry"),
    [],
    "确定性失败一次都不该重试",
  );

  // 5e 契约的正/反两面：光有 busy 文案没有 cause ⇒ 不是 busy（禁止 message 分类）；
  // cause 链上的 code / errcode ⇒ 是 busy。
  assert.equal(
    isTransientStorageOpenError(new Error("storage unavailable: database is locked")),
    false,
    "只有 message 特征的普通 Error 不得被判为 busy",
  );
  const busyErrcode = Object.assign(new Error("database is locked"), { errcode: 5 });
  assert.equal(
    isTransientStorageOpenError(Object.assign(new Error("wrapped"), { cause: busyErrcode })),
    true,
  );
  const busyCode = Object.assign(new Error("writer acquisition remained busy"), {
    code: "SQLITE_BUSY",
  });
  assert.equal(
    isTransientStorageOpenError(Object.assign(new Error("wrapped"), { cause: busyCode })),
    true,
  );
});

test("T4 enabled=false：发 transform_absent(disabled) 且不开库", async () => {
  const dir = newDbDir("boot-absent-disabled");
  const { logger, entries } = capturingLogger();
  const transform = await createMagicContextTurnTransform({
    enabled: false,
    sessionId: "ses_boot_disabled",
    workingDirectory: dir,
    logger,
  });
  assert.equal(transform, undefined);
  const absent = eventsOf(entries, "magic_context.transform_absent");
  assert.equal(absent.length, 1, "关着也要留一条可观测事件");
  assert.equal(absent[0].context?.reason, "disabled");
  assert.equal(absent[0].context?.module, "bootstrap");
  assert.equal(
    existsSync(join(dir, "magic-context.db")),
    false,
    "关着时不允许创建/打开数据库",
  );
});

test("T5 db_null:fence + fail_closed_blocking=false：先发事件再降级", async () => {
  const dir = newDbDir("boot-absent-fence");
  seedFencedDatabase(join(dir, "magic-context.db"));
  const { logger, entries } = capturingLogger();
  const transform = await createMagicContextTurnTransform({
    enabled: true,
    sessionId: "ses_boot_fence",
    workingDirectory: dir,
    logger,
    configDomain: { fail_closed_blocking: false },
  });
  assert.equal(transform, undefined, "关不断言：db_null 且不 fail-closed ⇒ return undefined");
  const absent = eventsOf(entries, "magic_context.transform_absent");
  assert.equal(absent.length, 1);
  assert.equal(absent[0].context?.reason, "db_null:fence");
  assert.match(absent[0].context?.detail, /schema fence rejected/);
  // 既有诊断行仍在：5a 只补事件面，不替换原有日志。
  assert.equal(eventsOf(entries, "magic_context.storage_unavailability").length, 1);
});

test("T6 db_null:fence + fail_closed_blocking=true：事件先于 throw 发出", async () => {
  const dir = newDbDir("boot-absent-fence-block");
  seedFencedDatabase(join(dir, "magic-context.db"));
  const { logger, entries } = capturingLogger();
  await assert.rejects(
    () =>
      createMagicContextTurnTransform({
        enabled: true,
        sessionId: "ses_boot_fence_block",
        workingDirectory: dir,
        logger,
      }),
    /fail_closed_blocking=true/,
    "默认档必须 loud block",
  );
  const absent = eventsOf(entries, "magic_context.transform_absent");
  assert.equal(
    absent.length,
    1,
    "fail-closed throw 之前事件必须已经发出（「带着原因响亮地失败」）",
  );
  assert.equal(absent[0].context?.reason, "db_null:fence");
});

// ── 收尾 ─────────────────────────────────────────────────────────────────────

// Windows 宿主（杀软/索引器）可能在退出后仍短暂持有临时目录的句柄，EPERM/EBUSY
// 清理失败不应把全绿的测试判成失败；残留目录由下次运行复用前清掉。
function bestEffortRmSync(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EBUSY" || error.code === "ENOTEMPTY")) {
      console.log(`  note  cleanup deferred (${error.code}): ${path}`);
    } else {
      throw error;
    }
  }
}

test.after(() => {
  for (const child of holders) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退了。
    }
  }
  holders.clear();
  for (const dir of tempDirs) bestEffortRmSync(dir);
});
