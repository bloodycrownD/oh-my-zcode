// T-VS1（upstream-v316-fullsync §phase-vproj-storage Step 9）：sqlite-migrations runner。
//
// 锁死四件事：
// 1) 默认 schema_migration 账本带 app_version；tasks_schema_migration 特判保留 omz 既有
//    三列形状（time_applied、无 app_version）——这是老任务库升级路径的兼容面。
// 2) 幂等：同库二次 migrate 返回 applied=[]，不重复执行也不重写账本。
// 3) checksum 冻结：同 id 改 SQL → MigrationChecksumError（任何 SQL 写入前拒绝）。
// 4) 表级备份/恢复闭环：备份目录产出 backup.json + tables.sqlite，restore 后行集合一致
//    且对应 migration 记录被清理；legacy 应用原语（schema_migration + omz_database_identity）
//    在事务内记账并可幂等重入。
//
// 运行形态：worktree 根 `node --import tsx --test packages/shared/test/sqliteMigrationsRunner.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MigrationChecksumError,
  SESSION_DATABASE_IDENTITY_MIGRATION,
  SqliteSchemaMigrationChecksumError,
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
  sqliteMigrations,
} from "../src/sqlite-migrations/index.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omz-sqlite-migrations-"));
  try {
    await run(dir);
  } finally {
    // Windows 文件锁滞后释放时不因清理失败拖垮测试。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const baseMigration = {
  id: "0001_example",
  appVersion: "1.0.0",
  touchedTables: ["example"],
  sql: "CREATE TABLE IF NOT EXISTS example (id TEXT PRIMARY KEY, title TEXT)",
};

test("T-VS1: 默认账本带 app_version，幂等二次执行返回空 applied", async () => {
  await withTempDir(async (dir) => {
    const db = new DatabaseSync(":memory:");
    const result = await sqliteMigrations.migrate(db, [baseMigration], {
      database: "tasks_index",
      backupDirectories: [dir],
    });
    assert.deepEqual(result.applied, ["0001_example"]);
    const journal = db
      .prepare("SELECT id, checksum, app_version, applied_at FROM schema_migration WHERE id=?")
      .get("0001_example") as { id: string; checksum: string; app_version: string };
    assert.equal(journal.app_version, "1.0.0");
    assert.match(journal.checksum, /^[0-9a-f]{64}$/);
    const second = await sqliteMigrations.migrate(db, [baseMigration], {
      database: "tasks_index",
      backupDirectories: [dir],
    });
    assert.deepEqual(second.applied, []);
    // 无待执行迁移时不产生备份；backupSkipped=false 表示「未需要」，不是「空间不足跳过」。
    assert.equal(second.backupSkipped, false);
    const after = db
      .prepare("SELECT checksum, app_version FROM schema_migration WHERE id=?")
      .get("0001_example") as { checksum: string; app_version: string };
    // node:sqlite 行对象是 null 原型，逐字段比较。
    assert.equal(after.checksum, journal.checksum);
    assert.equal(after.app_version, "1.0.0");
    db.close();
  });
});

test("T-VS1: tasks_schema_migration 特判——三列历史形状（time_applied，无 app_version）", async () => {
  await withTempDir(async (dir) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE legacy_data (id TEXT PRIMARY KEY)");
    const result = await sqliteMigrations.migrate(
      db,
      [
        {
          ...baseMigration,
          touchedTables: ["legacy_data"],
          sql: "ALTER TABLE legacy_data ADD COLUMN title TEXT",
        },
      ],
      {
        database: "tasks_schema",
        journalTable: "tasks_schema_migration",
        backupDirectories: [dir],
      },
    );
    assert.deepEqual(result.applied, ["0001_example"]);
    const columns = (
      db.prepare("PRAGMA table_info(tasks_schema_migration)").all() as { name: string }[]
    ).map((row) => row.name);
    assert.ok(columns.includes("time_applied"));
    assert.ok(!columns.includes("app_version"));
    db.close();
  });
});

test("T-VS1: checksum 冻结——同 id 改 SQL 抛 MigrationChecksumError", async () => {
  await withTempDir(async (dir) => {
    const db = new DatabaseSync(":memory:");
    await sqliteMigrations.migrate(db, [baseMigration], {
      database: "tasks_index",
      backupDirectories: [dir],
    });
    await assert.rejects(
      sqliteMigrations.migrate(db, [{ ...baseMigration, sql: `${baseMigration.sql} -- drifted` }], {
        database: "tasks_index",
        backupDirectories: [dir],
      }),
      (error: unknown) => error instanceof MigrationChecksumError,
    );
    db.close();
  });
});

test("T-VS1: 表级备份产出元数据与快照库，restore 复原行集合并清理对应 migration 记录", async () => {
  await withTempDir(async (dir) => {
    const source = new DatabaseSync(":memory:");
    source.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)");
    source.prepare("INSERT INTO notes VALUES(?,?)").run("n1", "hello");
    const first = await sqliteMigrations.migrate(
      source,
      [
        {
          ...baseMigration,
          id: "0002_add_column",
          appVersion: "1.1.0",
          touchedTables: ["notes"],
          sql: "ALTER TABLE notes ADD COLUMN extra TEXT",
        },
      ],
      { database: "tasks_index", backupDirectories: [dir] },
    );
    assert.ok(first.backupPath, "有历史表的迁移必须落备份");
    const metadata = JSON.parse(await readFile(join(first.backupPath!, "backup.json"), "utf8")) as {
      version: number;
      database: string;
      migrations: string[];
    };
    assert.equal(metadata.version, 1);
    assert.deepEqual(metadata.migrations, ["0002_add_column"]);

    const target = new DatabaseSync(":memory:");
    target.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)");
    target.exec(
      "CREATE TABLE schema_migration (id text primary key, checksum text not null, app_version text, applied_at integer not null)",
    );
    target
      .prepare(
        "INSERT INTO schema_migration (id, checksum, app_version, applied_at) VALUES(?,?,?,?)",
      )
      .run("0002_add_column", "stale-checksum", "1.0.0", 1);
    await sqliteMigrations.restore(target, first.backupPath!);
    // node:sqlite 行对象是 null 原型，经 JSON 归一后比较。
    assert.equal(
      JSON.stringify(target.prepare("SELECT id, body FROM notes").all()),
      JSON.stringify([{ id: "n1", body: "hello" }]),
    );
    // 恢复语义：对应 migration 记录被清理，目标库可重新升级。
    const journal = target
      .prepare("SELECT id FROM schema_migration WHERE id=?")
      .get("0002_add_column");
    assert.equal(journal, undefined);
    source.close();
    target.close();
  });
});

test("T-VS1: legacy 应用原语在事务内记账，identity 迁移幂等且冻结表名 omz_database_identity", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("BEGIN IMMEDIATE");
  ensureSqliteSchemaMigrationTable(db);
  applySqliteSchemaMigration(db, SESSION_DATABASE_IDENTITY_MIGRATION);
  db.exec("COMMIT");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)")
    .all("omz_database_identity", "zcode_database_identity") as { name: string }[];
  // omz 品牌口径：identity 表名随数据根改为 omz_database_identity，不得残留上游品牌表名。
  assert.deepEqual(
    tables.map((row) => row.name),
    ["omz_database_identity"],
  );
  // 幂等重入：已记账时不重复执行、不抛错。
  db.exec("BEGIN IMMEDIATE");
  applySqliteSchemaMigration(db, SESSION_DATABASE_IDENTITY_MIGRATION);
  db.exec("COMMIT");
  // 冻结校验：同 id 改 SQL 抛 SqliteSchemaMigrationChecksumError。
  db.exec("BEGIN IMMEDIATE");
  assert.throws(
    () =>
      applySqliteSchemaMigration(db, {
        ...SESSION_DATABASE_IDENTITY_MIGRATION,
        sql: "CREATE TABLE IF NOT EXISTS drift (id TEXT)",
      }),
    (error: unknown) => error instanceof SqliteSchemaMigrationChecksumError,
  );
  db.exec("ROLLBACK");
  db.close();
});
