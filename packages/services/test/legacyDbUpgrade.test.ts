// T-MIG1（P0 回归，v1.0.22 事故）：老库（v1.0.22 及更早的 schema）在项目存储迁移
// 尚未落账前，任何老会话都必须还能解析目录，不能因为「host_id 整列不存在」被判成
// project.host-mismatch；跑完 projectStorage.migrate 后必须补齐 hosts/projects 并把
// 存量行收养到本机 host，之后新建/恢复会话不再遇 "no such table: hosts"。
//
// 事故形态（真机复现于 2026-10-24）：v1.0.22 发布了项目存储（hosts/projects/tasks.host_id）
// 但生产启动链没接 projectStorage.migrate，老库因此停在「无 hosts 表 + tasks 无 host_id 列」，
// 打开任何老会话 → resolveDirectories 把 undefined 当跨 Host → project.host-mismatch。
//
// 运行：node --import tsx --test packages/services/test/legacyDbUpgrade.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { projectStorage } from "../src/project-storage/index.js";

const LEGACY_WORKSPACE = "D:\\legacy\\workspace";
const LEGACY_TASK_ID = "sess_legacy_0001";

function seedLegacyDatabase(db: DatabaseSync): void {
  // v1.0.22 的启动链只跑 tasksDatabase 迁移（0001-0004/0006），项目存储列/表都不存在。
  runTasksDatabaseMigrations(db);
  db.prepare(
    `INSERT INTO tasks(workspace_key,workspace_path,task_id,title,task_status,provider,mode,created_at,updated_at,pinned,archived,deleted,title_overridden,meta_json,searchable_text)
     VALUES(?,?,?,?,?,?,?,?,?,0,0,0,0,'{}','')`,
  ).run(
    LEGACY_WORKSPACE,
    LEGACY_WORKSPACE,
    LEGACY_TASK_ID,
    "legacy task",
    "completed",
    ZCODE_AGENT_PROVIDER,
    "build",
    Date.now() - 60_000,
    Date.now(),
  );
}

test("T-MIG1: 迁移前老库解析老会话不抛 project.host-mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omz-legacy-db-"));
  const db = new DatabaseSync(join(dir, "tasks-index.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    seedLegacyDatabase(db);
    const columns = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    assert.equal(columns.includes("host_id"), false, "老库不应已含 host_id 列");

    const repo = projectStorage.repository(db);
    const directories = repo.resolveSessionDirectories({
      taskId: LEGACY_TASK_ID,
      workspacePath: LEGACY_WORKSPACE,
    });
    assert.equal(directories.workspacePath, LEGACY_WORKSPACE);
    assert.equal(directories.projectId, null);
    assert.deepEqual(directories.additionalDirectories, []);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("T-MIG1: 迁移补齐 hosts/projects 并把存量行收养到本机 host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omz-legacy-db-"));
  const db = new DatabaseSync(join(dir, "tasks-index.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    seedLegacyDatabase(db);

    const migrated = await projectStorage.migrate(db, { backupDirectories: [dir] });
    assert.deepEqual(migrated.applied, [
      "0005_projects",
      "0006_default_workspace_tasks",
      "0007_initial_workspace_order",
      "0008_connection_hosts",
    ]);

    const hosts = db.prepare("SELECT host_id,kind FROM hosts").all() as {
      host_id: string;
      kind: string;
    }[];
    assert.ok(
      hosts.some((row) => row.host_id === "local" && row.kind === "local"),
      "迁移后必须存在本机 host 行（否则 ensureHost 会抛 no such table: hosts）",
    );

    const adopted = db
      .prepare("SELECT host_id,project_id FROM tasks WHERE task_id=?")
      .get(LEGACY_TASK_ID) as { host_id: string | null; project_id: string | null };
    assert.equal(adopted.host_id, "local", "存量任务行必须被收养到本机 host");
    assert.equal(adopted.project_id, null);

    // 迁移后同一个 resolve 仍可用（本轮既有行为），且不再依赖「列缺失」兜底。
    const repo = projectStorage.repository(db);
    assert.equal(
      repo.resolveSessionDirectories({ taskId: LEGACY_TASK_ID, workspacePath: LEGACY_WORKSPACE })
        .workspacePath,
      LEGACY_WORKSPACE,
    );

    // 写入路径（reserveCreatedTask → ensureHost）在迁移后可用，等价于「新建/恢复会话」。
    const reserved = repo.reserveCreatedTask({
      task: { taskId: "sess_legacy_0002", workspacePath: join(LEGACY_WORKSPACE, "sub") },
      projectId: null,
    });
    assert.equal(reserved.workspacePath, join(LEGACY_WORKSPACE, "sub"));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// 这条是事故根因断言：迁移函数有测试、但没人断言它**从生产启动链被调用**。
// TaskIndexRepo.ensureReady 是 Host/Worker 打开 tasks-index 的唯一入口，它必须在
// 打开老库时把项目存储迁移落账（v1.0.22 缺失这一步 → 老项目全部打不开）。
test("T-MIG1: 业务连接 ensureReady 会自行跑项目迁移（生产接线断言）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omz-legacy-db-"));
  const path = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    seedLegacyDatabase(db);
  } finally {
    db.close();
  }
  // 四参顺序：(settings, hostId, path, busyTimeout)；老库无设置投影时前两参为空。
  const indexRepo = new TaskIndexRepo(undefined, undefined, path, 5000);
  try {
    await indexRepo.ensureReady();
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      const ledger = verify
        .prepare("SELECT id FROM schema_migration")
        .all()
        .map((row) => String((row as { id: unknown }).id));
      assert.ok(
        ledger.includes("0005_projects"),
        "ensureReady 必须把 0005_projects 落账（否则老库永远没有 hosts/projects）",
      );
      const hosts = verify.prepare("SELECT count(*) AS n FROM hosts").get() as { n: number };
      assert.equal(hosts.n > 0, true);
      const adopted = verify
        .prepare("SELECT host_id FROM tasks WHERE task_id=?")
        .get(LEGACY_TASK_ID) as { host_id: string | null };
      assert.equal(adopted.host_id, "local");
    } finally {
      verify.close();
    }
  } finally {
    indexRepo.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
