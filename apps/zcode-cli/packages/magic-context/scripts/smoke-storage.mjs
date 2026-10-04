#!/usr/bin/env node
/**
 * Step 15 acceptance smoke — A-group storage port.
 *
 * Exercises the ported SQLite chokepoint end to end against a throwaway
 * database directory:
 *   1. point MAGIC_CONTEXT_DB_DIR at a fresh temp dir;
 *   2. open `magic-context.db` through the ported `openDatabase()` and let it run
 *      the full migration set on a brand-new store (D-5: schema starts clean, no
 *      legacy data);
 *   3. assert the schema fence agrees with the migration module's expected
 *      version — `LATEST_MIGRATION_VERSION` from migrations.ts versus
 *      `LATEST_SUPPORTED_VERSION` from storage-db.ts, and the version actually
 *      persisted in the file;
 *   4. close, reopen, and assert nothing re-runs (idempotence);
 *   5. shallow-import every ported storage module and print its exported
 *      function signatures, so a broken edge anywhere in the module graph shows
 *      up as a load error rather than as a latent runtime break.
 *
 * Requires Node >= 24 (`node:sqlite`) and a prior `pnpm build` — it imports the
 * compiled `dist/`, not the TypeScript sources.
 *
 * Exits 0 on success, 1 on any failed assertion or module load error.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const failures = [];
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const ok = actual === expected;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (expected ${String(expected)})`}`,
  );
  if (!ok) failures.push(`${label}: got ${String(actual)}, expected ${String(expected)}`);
  return ok;
}

function assert(label, condition, detail = "") {
  checks += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  return condition;
}

const DIST_ROOT = fileURLToPath(new URL("../dist/core/", import.meta.url));
const load = (rel) => import(pathToFileURL(join(DIST_ROOT, rel)).href);

const dbDir = mkdtempSync(join(tmpdir(), "magic-context-smoke-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.NODE_ENV;

let exitCode = 0;
try {
  const harness = await load("shared/harness.js");
  const dataPath = await load("shared/data-path.js");
  const migrations = await load("features/magic-context/migrations.js");
  const storageDb = await load("features/magic-context/storage-db.js");
  const sqlite = await load("shared/sqlite.js");

  // A real host locks the harness before it touches the database; do the same
  // so the rows this smoke writes are attributed the way production would be.
  harness.setHarness("zcode");

  console.log("== environment");
  console.log(`  node            ${process.version}`);
  console.log(`  sqlite runtime  ${sqlite.detectSqliteRuntime()}`);
  console.log(`  harness         ${harness.getHarness()}`);
  console.log(`  db dir          ${dbDir}`);

  console.log("== storage path resolution");
  const resolution = dataPath.getMagicContextStorageResolution();
  check("storage dir override honoured", resolution.source, "environment override");
  check("storage dir is the smoke temp dir", resolution.path, dbDir);
  const resolved = storageDb.resolveDatabasePath();
  check("db file name", resolved.dbPath, join(dbDir, "magic-context.db"));

  console.log("== fence / migration ledger agreement");
  check("LATEST_SUPPORTED_VERSION", storageDb.LATEST_SUPPORTED_VERSION, 94);
  check(
    "LATEST_MIGRATION_VERSION",
    migrations.LATEST_MIGRATION_VERSION,
    storageDb.LATEST_SUPPORTED_VERSION,
  );
  const pendingOnEmpty = (() => {
    const probe = new sqlite.Database(":memory:");
    try {
      return migrations.hasPendingMigrations(probe);
    } finally {
      probe.close();
    }
  })();
  check("fresh database reports pending migrations", pendingOnEmpty, true);

  console.log("== first open on a brand-new store");
  const first = storageDb.openDatabase();
  assert("openDatabase() returned a handle", first !== null);
  const firstVersion = storageDb.getPersistedSchemaVersion(first);
  check("persisted schema version", firstVersion, storageDb.LATEST_SUPPORTED_VERSION);
  check(
    "persisted version equals LATEST_MIGRATION_VERSION",
    firstVersion,
    migrations.LATEST_MIGRATION_VERSION,
  );
  check("no schema-fence rejection", storageDb.getSchemaFenceRejection(), null);
  check("no migration-on-open refusal", storageDb.getMigrationOnOpenRefusal(), null);
  check("persistence recorded", storageDb.isDatabasePersisted(first), true);
  check("database path tracked", storageDb.getDatabasePath(first), join(dbDir, "magic-context.db"));
  check("migrations exhausted", migrations.hasPendingMigrations(first), false);

  // The v85 / v87 OpenCode harness relabel pair is deliberately skipped for a
  // new store; prove the ledger skips those numbers rather than stalling on them.
  const appliedRows = first
    .prepare("SELECT version FROM schema_migrations WHERE version IN (85, 87)")
    .all();
  check("v85/v87 not in the ledger", appliedRows.length, 0);
  const maxRow = first
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get();
  check("ledger head", maxRow.version, migrations.LATEST_MIGRATION_VERSION);
  const tableCount = first
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
    .get();
  assert("schema created", tableCount.count > 20, `${tableCount.count} tables`);

  console.log("== close / reopen idempotence");
  // `openDatabase()` is the synchronous path and applies migrations inline (the
  // worker is only used by `openDatabaseAsync()`), so this counter is expected
  // to be non-zero here. What matters for this step is that it does not move on
  // the second open.
  const bodiesAfterFirstOpen = migrations.__getMainThreadMigrationBodyCountForTests();
  assert(
    "first open applied every migration body",
    bodiesAfterFirstOpen > 0,
    `${bodiesAfterFirstOpen} bodies`,
  );
  check(
    "applied body count equals the migration count",
    bodiesAfterFirstOpen,
    migrations.LATEST_MIGRATION_VERSION - 2,
  );
  const ledgerRowsFirst = first
    .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
    .get().count;
  storageDb.closeDatabase();
  const second = storageDb.openDatabase();
  assert("reopen returned a handle", second !== null);
  check(
    "persisted version stable across reopen",
    storageDb.getPersistedSchemaVersion(second),
    firstVersion,
  );
  check("nothing left to migrate", migrations.hasPendingMigrations(second), false);
  check(
    "no migration body re-ran on reopen",
    migrations.__getMainThreadMigrationBodyCountForTests(),
    bodiesAfterFirstOpen,
  );
  const secondMax = second
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get();
  check("ledger head unchanged", secondMax.version, firstVersion);
  const ledgerRowsSecond = second
    .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
    .get().count;
  check("ledger row count unchanged", ledgerRowsSecond, ledgerRowsFirst);
  storageDb.closeDatabase();

  console.log("== schema fence negative (T-M7)");
  // T-M7 的判据是**双向**的，而正向的那一半（两个常量相等）上面已经断言过了。
  // 这一段断言的是围栏本身的两条语义——它们都只在负向断言里才暴露：
  //
  //   ① 比本 build 更新的库必须被**拒绝**（不是被就地迁移）。把围栏写错成
  //      `!=` 或 `<` 的实现在这里会「通过」open，于是把一个未知 schema 当成
  //      自己的写——那正是 T-M7 要防的事故。
  //   ② 一个**更新的 build** 的围栏必须接受当前库。围栏是单向不等式
  //      `persisted > supported`，不是相等检查；写成相等会让每一次降级都
  //      变成「库不可用」。
  storageDb.closeDatabase();
  const staleFence = storageDb.openDatabase({
    latestSupportedVersion: storageDb.LATEST_SUPPORTED_VERSION - 1,
  });
  check("a database newer than this build's fence is refused", staleFence, null);
  const rejection = storageDb.getSchemaFenceRejection();
  check("fence rejection names the persisted version", rejection?.persistedVersion, firstVersion);
  check(
    "fence rejection names this build's ceiling",
    rejection?.supportedVersion,
    storageDb.LATEST_SUPPORTED_VERSION - 1,
  );
  check("a refused open leaves no migration-on-open refusal behind", storageDb.getMigrationOnOpenRefusal(), null);
  // The rejected attempt must not have cached a handle: a later, legitimate open
  // has to be a clean open rather than a cache hit on the refused connection.
  const newerFence = storageDb.openDatabase({
    latestSupportedVersion: storageDb.LATEST_SUPPORTED_VERSION + 1,
  });
  assert("a newer build's fence accepts this database", newerFence !== null);
  check(
    "the newer-fence open did not run any migration",
    migrations.__getMainThreadMigrationBodyCountForTests(),
    bodiesAfterFirstOpen,
  );
  check("no schema-fence rejection after a legal open", storageDb.getSchemaFenceRejection(), null);
  storageDb.closeDatabase();

  console.log("== module graph / exported function signatures");
  const featuresDir = join(DIST_ROOT, "features", "magic-context");
  const storageModules = readdirSync(featuresDir)
    .filter((name) => name.startsWith("storage") && name.endsWith(".js"))
    .sort();
  let exportedFunctions = 0;
  for (const name of storageModules) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(featuresDir, name)).href);
    } catch (error) {
      assert(`import ${name}`, false, String(error && error.message));
      continue;
    }
    const signatures = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([key, value]) => `${key}/${value.length}`);
    exportedFunctions += signatures.length;
    console.log(`  ${name}  [${signatures.length} fn]  ${signatures.join(" ")}`);
  }
  assert("storage modules imported", storageModules.length > 0, `${storageModules.length} modules`);
  assert(
    "exported functions discovered",
    exportedFunctions > 100,
    `${exportedFunctions} functions across ${storageModules.length} modules`,
  );

  for (const extra of [
    "features/magic-context/migration-worker-client.js",
    "plugin/boot-quiet.js",
  ]) {
    try {
      const mod = await load(extra);
      const signatures = Object.entries(mod)
        .filter(([, value]) => typeof value === "function")
        .map(([key, value]) => `${key}/${value.length}`);
      console.log(`  ${extra}  [${signatures.length} fn]  ${signatures.join(" ")}`);
      assert(`import ${extra}`, true);
    } catch (error) {
      assert(`import ${extra}`, false, String(error && error.message));
    }
  }
} catch (error) {
  failures.push(`unexpected throw: ${error && error.stack ? error.stack : String(error)}`);
  console.error(error);
} finally {
  try {
    rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    // A leftover temp dir must never turn a passing smoke into a failing one.
    console.warn(`could not remove ${dbDir}: ${error && error.message}`);
  }
}

console.log("");
if (failures.length === 0) {
  console.log(`SMOKE PASS — ${checks} checks, 0 failures`);
} else {
  exitCode = 1;
  console.log(`SMOKE FAIL — ${checks} checks, ${failures.length} failure(s)`);
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(exitCode);
