// T-VS3（upstream-v316-fullsync §phase-vproj-storage Step 11）：tasksDatabase 换代融合。
//
// 锁死三件事（DB 迁移 checksum_mismatch 是本迭代最高风险项，见 spec 风险表）：
// 1) 五个迁移的账本 checksum 与移植时从上游 v3.16.2 源码逐字节推导的基准一致——
//    0004/0006 是本次追加的冻结输入；0001-0003 是 omz 存量链，「禁改 checksumInput 常量」
//    红线的机械断言（任一常量漂移都会让老库启动即炸）。
// 2) 老库升级路径：带 0001-0003 既有账本、缺 0004/0006 schema 的库，追加迁移后
//    applied=[0004,0006]、列/表齐备、无 checksum_mismatch。
// 3) 幂等与冻结守卫：重复执行零副作用；账本被篡改即抛 checksum_mismatch。
//
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/tasksMigrationsUpgrade.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import {
  areTasksDatabaseMigrationsApplied,
  runTasksDatabaseMigrations,
} from "../src/session/tasksDatabase/migrations.js";

// 移植基准（2026-10-23 自上游 v3.16.2 快照逐字节推导，公式 sha256(JSON.stringify(checksumInput))）。
const FROZEN_CHECKSUMS: Record<string, string> = {
  "0001_adopt_task_schema": "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17",
  "0002_provider_selection": "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc",
  "0003_official_glm_selection": "8987adb50ae412a46c294141c1af89ccfc252f22d41351bdf4c7528f56edc8b4",
  "0004_project_execution_scopes":
    "caae5e91fc3abfeee6508f782890ad8d67cebeb80611775d39dc13a7e6fea3f0",
  "0006_task_group_admissions": "0af559d04bb3f1a1dab12d6533d59292d232b09ea3ef3ef6ca3c9373bd663019",
};

async function withTempDb(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omz-tasks-migrations-"));
  const path = join(dir, "tasks-index.sqlite");
  try {
    await run(path);
  } finally {
    // Windows 文件锁滞后释放时不因清理失败拖垮测试。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function ledger(db: DatabaseSync): Array<{ id: string; checksum: string }> {
  return db
    .prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY rowid")
    .all() as Array<{ id: string; checksum: string }>;
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  );
}

test("T-VS3: 新库迁移链账本与上游冻结基准逐字节一致；0004/0006 schema 落齐", async () => {
  await withTempDb(async (path) => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    runTasksDatabaseMigrations(db);
    const rows = ledger(db);
    assert.deepEqual(
      rows.map((row) => row.id),
      Object.keys(FROZEN_CHECKSUMS),
      "迁移 id 序列保持上游原号（base scope 无 0005：source-server 专属迁移走同名 scope 清单，见 remoteSchemaMigrations.test.ts）",
    );
    for (const row of rows) {
      assert.equal(
        row.checksum,
        FROZEN_CHECKSUMS[row.id],
        `${row.id} checksum 冻结断言失败——冻结常量被改动会让老库启动即炸`,
      );
    }
    for (const table of ["automations", "off_peak_tasks"]) {
      const columns = columnNames(db, table);
      for (const column of ["project_id", "host_id", "additional_directories"]) {
        assert.ok(columns.has(column), `${table}.${column} 未落列`);
      }
    }
    const admissions = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_group_admissions'")
      .get() as { sql: string };
    assert.match(admissions.sql, /PRIMARY KEY \(workspace_key, task_id\)/);
    assert.ok(areTasksDatabaseMigrationsApplied(db));
    db.close();
  });
});

test("T-VS3: 老库升级——带 0001-0003 既有账本的库追加 0004/0006 不 checksum_mismatch", async () => {
  await withTempDb(async (path) => {
    // 构造「旧版本安装」：先跑满当前链，再退掉 0004/0006 的 schema 与账本行——
    // 剩余 schema 与 0001-0003 账本即旧版本存量形态（0001-0003 checksum 从未变更）。
    const oldDb = new DatabaseSync(path);
    oldDb.exec("PRAGMA foreign_keys = ON");
    runTasksDatabaseMigrations(oldDb);
    const baseline = new Map(ledger(oldDb).map((row) => [row.id, row.checksum] as const));
    oldDb.exec("DROP TABLE task_group_admissions");
    oldDb.exec("ALTER TABLE automations DROP COLUMN project_id");
    oldDb.exec("ALTER TABLE automations DROP COLUMN host_id");
    oldDb.exec("ALTER TABLE automations DROP COLUMN additional_directories");
    oldDb.exec("ALTER TABLE off_peak_tasks DROP COLUMN project_id");
    oldDb.exec("ALTER TABLE off_peak_tasks DROP COLUMN host_id");
    oldDb.exec("ALTER TABLE off_peak_tasks DROP COLUMN additional_directories");
    oldDb
      .prepare("DELETE FROM tasks_schema_migration WHERE id IN (?, ?)")
      .run("0004_project_execution_scopes", "0006_task_group_admissions");

    // 老库升级：追加 0004/0006 成功，0001-0003 记账原样未动。
    runTasksDatabaseMigrations(oldDb);
    const rows = ledger(oldDb);
    assert.deepEqual(
      rows.map((row) => row.id),
      Object.keys(FROZEN_CHECKSUMS),
    );
    for (const row of rows) {
      assert.equal(row.checksum, baseline.get(row.id), `${row.id} 记账不得重写`);
      assert.equal(row.checksum, FROZEN_CHECKSUMS[row.id]);
    }
    assert.ok(columnNames(oldDb, "automations").has("project_id"));
    assert.ok(columnNames(oldDb, "off_peak_tasks").has("additional_directories"));
    oldDb.close();
  });
});

test("T-VS3: 幂等——重复执行零新增；账本被篡改即抛 checksum_mismatch", async () => {
  await withTempDb(async (path) => {
    const db = new DatabaseSync(path);
    runTasksDatabaseMigrations(db);
    const before = ledger(db);
    // 幂等：再次全量执行不抛错、不新增账本行、不重写 checksum。
    // （omz runner 收尾仍会发布一次 committing 进度；只有 "migrating" 代表真实执行。）
    runTasksDatabaseMigrations(db, {
      onProgress: (phase) => {
        assert.notEqual(phase, "migrating", "幂等重放不得进入迁移执行阶段");
      },
    });
    assert.deepEqual(ledger(db), before);

    // 冻结守卫：账本行被篡改后，ready 探测与执行路径都必须拒绝。
    db.prepare("UPDATE tasks_schema_migration SET checksum='drifted' WHERE id=?").run(
      "0004_project_execution_scopes",
    );
    assert.throws(
      () => areTasksDatabaseMigrationsApplied(db),
      (error: unknown) => (error as { kind?: string }).kind === "checksum_mismatch",
    );
    assert.throws(
      () => runTasksDatabaseMigrations(db),
      (error: unknown) => (error as { kind?: string }).kind === "checksum_mismatch",
    );
    db.close();
  });
});
