// T-RU1/T-RU2（upstream-v316-fullsync §phase-remote-ux Step 18）：R3 三期存储面。
//
// 锁死四件事：
// 1) 两支专属 scope 迁移（0004_controller_remote_identity / 0005_source_server_workspace_schema）
//    的账本 checksum 与移植时从上游 v3.16.2 逐字节 schema 文件推导的基准一致；
//    冻结常量任一漂移都会让同库账本与上游互换性（老库升级）即刻断裂。
// 2) scope 裁剪语义：base 链不含两支专属迁移（沿用上游 prepareMigrations 三分）；
//    controller-remote 只落审计表；source-server 只落 6 表。
// 3) controller-remote 身份迁移改写规则：migrateControllerRemoteWorkspaceIdentity
//    把 workspace_key/identity 列从 legacy 键改写到 stable 键，meta_json.workspaceIdentity
//    同步重写，审计账本落 completed 一行。
// 4) aliasRepo 装配：构造即按 source-server scope 建库；canonical 解析在无别名/无迁移时
//    无副作用返回，失败/放弃统计恒可读。
//
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/remoteSchemaMigrations.test.ts`
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
  prepareTasksDatabaseMigrationDigests,
  runTasksDatabaseMigrations,
} from "../src/session/tasksDatabase/migrations.js";
import { migrateControllerRemoteWorkspaceIdentity } from "../src/session/controllerRemoteIdentityMigration.js";
import { SourceServerWorkspaceAliasRepo } from "../src/session/sourceServerWorkspaceAliasRepo.js";
import {
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";

// 冻结基准（2026-10-24 自上游 v3.16.2 快照逐字节 schema 文件推导，
// 公式 sha256(JSON.stringify(checksumInput))；文件字节级比对见提交批注）。
const FROZEN_SCOPE_CHECKSUMS: Record<string, string> = {
  "0004_controller_remote_identity":
    "16dc0d2cf0df9b4556f8d34afecbc3a7b628522926286d363a4edc039015c09a",
  "0005_source_server_workspace_schema":
    "f9b295f500cfe949e54b77fe512f7d9f2cdd752436ab5f39dae2ceee61d3ed8c",
};

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omz-remote-schema-"));
  try {
    await run(root);
  } finally {
    // Windows 文件锁滞后释放时不因清理失败拖垮测试。
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function ledgerIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT id FROM tasks_schema_migration ORDER BY rowid").all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

function tableNames(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
}

test("T-RU1: base 链不含两支专属迁移，账本仍与既有冻结基准一致", async () => {
  await withTempDir(async (root) => {
    const db = new DatabaseSync(join(root, "tasks.sqlite"));
    runTasksDatabaseMigrations(db, "base");
    assert.deepEqual(
      ledgerIds(db),
      [
        "0001_adopt_task_schema",
        "0002_provider_selection",
        "0003_official_glm_selection",
        "0004_project_execution_scopes",
        "0006_task_group_admissions",
      ],
      "base scope 不得引入 controller-remote/source-server 专属迁移（同库账本撞号防护）",
    );
    assert.ok(areTasksDatabaseMigrationsApplied(db, "base"));
    assert.ok(!areTasksDatabaseMigrationsApplied(db, "controller-remote"));
    assert.ok(!areTasksDatabaseMigrationsApplied(db, "source-server"));
    db.close();
  });
});

test("T-RU1: 两支专属迁移 checksum 与上游冻结基准逐字节一致且各自落表", async () => {
  const controllerDigests = prepareTasksDatabaseMigrationDigests("controller-remote");
  const sourceServerDigests = prepareTasksDatabaseMigrationDigests("source-server");
  for (const [id, checksum] of Object.entries(FROZEN_SCOPE_CHECKSUMS)) {
    const digests = id.startsWith("0004") ? controllerDigests : sourceServerDigests;
    assert.equal(
      digests.get(id),
      checksum,
      `${id} checksum 冻结断言失败——schema 常量漂移会破坏与上游账本互换性`,
    );
  }
  await withTempDir(async (root) => {
    const audit = new DatabaseSync(join(root, "audit.sqlite"));
    runTasksDatabaseMigrations(audit, "controller-remote");
    assert.deepEqual(ledgerIds(audit), ["0004_controller_remote_identity"]);
    assert.ok(tableNames(audit).has("controller_remote_identity_migrations"));
    assert.ok(areTasksDatabaseMigrationsApplied(audit, "controller-remote"));
    audit.close();

    const ws = new DatabaseSync(join(root, "workspace.sqlite"));
    runTasksDatabaseMigrations(ws, "source-server");
    assert.deepEqual(ledgerIds(ws), ["0005_source_server_workspace_schema"]);
    for (const table of [
      "workspace_alias",
      "workspace_migration_schema_version",
      "workspace_migration_ledger",
      "workspace_migration_conflicts",
    ]) {
      assert.ok(tableNames(ws).has(table), `${table} 未落表`);
    }
    assert.ok(areTasksDatabaseMigrationsApplied(ws, "source-server"));
    ws.close();
  });
});

test("T-RU2: controller-remote 身份迁移把 legacy 键改写到 stable 键并重写 meta_json", async () => {
  await withTempDir(async (root) => {
    const dbPath = join(root, "tasks-index.sqlite");
    const seed = new DatabaseSync(dbPath);
    runTasksDatabaseMigrations(seed);
    seed
      .prepare(`INSERT INTO tasks
        (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, meta_json)
        VALUES (?, '/repo', ?, 'task-1', 'legacy task', 1, 2, ?)`)
      .run(
        "remote:ssh:old:22:u:/repo",
        "remote:ssh:old:22:u:/repo",
        '{"workspaceIdentity":"remote:ssh:old:22:u:/repo"}',
      );
    seed.close();
    const report = await migrateControllerRemoteWorkspaceIdentity({
      dbPath,
      oldWorkspaceKey: "remote:ssh:old:22:u:/repo",
      newWorkspaceKey: "remote:server:source:/repo",
    });
    assert.equal(report.status, "completed");
    assert.equal(report.before.tasks, 1);
    assert.equal(report.after.tasks, 1);

    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT workspace_key, workspace_identity, meta_json FROM tasks WHERE task_id = ?")
      .get("task-1") as {
      workspace_key: string;
      workspace_identity: string;
      meta_json: string;
    };
    assert.equal(row.workspace_key, "remote:server:source:/repo");
    assert.equal(row.workspace_identity, "remote:server:source:/repo");
    assert.deepEqual(JSON.parse(row.meta_json), {
      workspaceIdentity: "remote:server:source:/repo",
    });
    const legacy = db
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE workspace_key = ?")
      .get("remote:ssh:old:22:u:/repo") as { count: number };
    assert.equal(legacy.count, 0, "legacy 键行必须清零，否则重连会重复触发迁移");
    const audit = db
      .prepare("SELECT status FROM controller_remote_identity_migrations")
      .all() as Array<{ status: string }>;
    assert.deepEqual(
      audit.map((row) => row.status),
      ["completed"],
      "审计账本须落唯一 completed 行",
    );
    db.close();
  });
});

test("T-RU2: remote:server identity 形态构造/解析/hostId 往返（omz 拍板键形态）", () => {
  const identity = buildServerRemoteWorkspaceIdentity({
    serverId: "8f0e-ad0B.zx_01",
    workspacePath: "\\srv\\repo\\",
  });
  assert.equal(identity, "remote:server:8f0e-ad0b.zx_01:/srv/repo");
  const parsed = parseRemoteWorkspaceIdentity(identity);
  assert.deepEqual(parsed, {
    kind: "server",
    sourceServerId: "8f0e-ad0b.zx_01",
    workspacePath: "/srv/repo",
  });
  assert.ok(isRemoteWorkspaceIdentity(identity));
  // hostId 裁剪只发生一次路径段：buildRemoteHostWorkspaceIdentity 反解必须还原 hostId。
  const hostId = remoteHostIdFromWorkspaceIdentity(identity);
  assert.equal(hostId, "remote:server:8f0e-ad0b.zx_01");
  assert.equal(
    buildRemoteHostWorkspaceIdentity(hostId, "/srv/repo"),
    identity,
    "hostId + path 重建必须还原同一 identity",
  );
  // 非法形态：serverId 空白、缺 path 段、非法 kind 一律拒绝。
  assert.throws(() => buildServerRemoteWorkspaceIdentity({ serverId: " / ", workspacePath: "/r" }));
  assert.equal(parseRemoteWorkspaceIdentity("remote:server:only-id"), null);
  assert.equal(parseRemoteWorkspaceIdentity("remote:server:id:not-a-path"), null);
  assert.equal(parseRemoteWorkspaceIdentity("remote:ssh:1:2:3:no-lead-slash"), null);
});

test("T-RU2: aliasRepo 构造即按 source-server scope 建库，canonical 解析写 alias 且失败统计恒可读", async () => {
  await withTempDir(async (root) => {
    const repo = new SourceServerWorkspaceAliasRepo({
      taskDbPath: join(root, "tasks-index.sqlite"),
      sessionDbPath: join(root, "session.sqlite"),
      backupRoot: join(root, "backups"),
    });
    // 新 Source Server workspace 首解析必须携带 legacy 路由提示（稳定 server identity 锚定）；
    // 无提示的全新路径直接抛错，防止空键写入 alias 表。
    await assert.rejects(
      repo.resolveCanonicalWorkspaceKey({ workspacePath: "/repo" }),
      /legacyRouteHint/,
    );
    const result = await repo.resolveCanonicalWorkspaceKey({
      workspacePath: "/repo",
      legacyRouteHint: "remote:ssh:old:22:u:/repo",
    });
    assert.equal(result.canonicalKey, "remote:ssh:old:22:u:/repo");
    assert.deepEqual(result.mergedKeys, []);
    assert.deepEqual(await repo.listMigrationReports().then((r) => r.rows), []);
    const [failed, abandoned] = await Promise.all([
      repo.getFailedPathCount(),
      repo.getAbandonedPathCount(),
    ]);
    assert.equal(failed, 0);
    assert.equal(abandoned, 0);
  });
});
