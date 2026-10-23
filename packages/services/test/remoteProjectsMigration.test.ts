// T-RP2 + T-RP5 + T-RP7（backlog-sweep Step 1，phase-sidebar-p3 blocking）：
// T-RP2 — legacy connectionProfiles → hosts 稳定身份回填（别名合并、retired 过滤、
//         entries 按稳定 host_id 落行、重复执行不产生重复行）。
// T-RP5 — 迁移生产链接线：全新库经 `TaskIndexRepo.initialize` / `prepareTasksIndexStorage`
//         （Worker 真实入口）后 hosts/projects/project_roots/remote_project_entries 四表存在
//         且 0005/0008 在册；已应用 0005 的存量库再次启动后 hosts 非空、同设备仅一行 host 且
//         projects/entries.host_id=稳定 id。
// T-RP7 — 0008 收敛撞唯一索引：两 host 同名未删项目 + 同 remote_project_id 入口时按去重口径
//         收敛（软删 legacy 项目、删 legacy 冲突入口），tasks.project_id 不改指、任务仍可见。
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/remoteProjectsMigration.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { setDataBaseDir } from "../src/paths.js";
import { projectStorage } from "../src/project-storage/index.js";
import { migrateConnectionHostsOnUpgrade } from "../src/project-storage/migrate-projects.js";
import type { ProjectMigrationContext } from "../src/project-storage/contract.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { prepareTasksIndexStorage } from "../src/storage-startup.js";
import { remoteProjectHostIdForTarget } from "../src/remote-projects/connection-membership.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const SSH_TARGET = { kind: "ssh" as const, host: "devbox", username: "omz", port: 22 };
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const RETIRED_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const RETIRED_SERVER_ID = "44444444-4444-4444-8444-444444444444";

/** 旧设置：一条已握手 SSH 线路 + 一条退役线路（退役行不得进入 hosts）。 */
function legacySettings(
  overrides: Partial<NonNullable<ProjectMigrationContext["settings"]>> = {},
): NonNullable<ProjectMigrationContext["settings"]> {
  return {
    sourceServers: [
      {
        sourceServerId: SERVER_ID,
        displayName: "devbox",
        preferredProfileId: PROFILE_ID,
        installState: "installed",
        declaredWorkspaces: [],
      },
    ],
    connectionProfiles: [
      {
        profileId: PROFILE_ID,
        sourceServerId: SERVER_ID,
        transport: "ssh",
        target: SSH_TARGET,
        createdAt: 1,
        lastConnectedAt: 10,
        lifecycleState: "active",
      },
      {
        profileId: RETIRED_PROFILE_ID,
        sourceServerId: RETIRED_SERVER_ID,
        transport: "ssh",
        target: { kind: "ssh", host: "retired-box", username: "omz" },
        createdAt: 1,
        lifecycleState: "retired",
      },
    ],
    lastWorkspaceSession: [
      {
        kind: "remote",
        workspacePath: "/srv/app",
        workspaceIdentity: "remote:ssh:devbox:22:omz:/srv/app",
        target: SSH_TARGET,
        lastOpenedAt: 5,
        lastConnectionStatus: "connected",
        workspacePurpose: "project",
      },
    ],
    ...overrides,
  };
}

function query<T>(db: ReturnType<typeof openDatabase>, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function openDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omz-remote-projects-migration-"));
  try {
    await run(dir);
  } finally {
    // Windows 下 sqlite 连接刚关闭时文件锁可能滞后释放；清理是 best-effort，不影响断言。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("T-RP2: legacy connectionProfiles → 稳定 host 身份回填，entries 按 alias 落行", async () => {
  await withTempDir(async (dir) => {
    const settings = legacySettings();
    const db = openDatabase(join(dir, "tasks-index.sqlite"));
    try {
      const result = await projectStorage.migrate(db, {
        settings,
        backupDirectories: [dir],
      });
      assert.ok(result.applied.includes("0005_projects"));
      const stableId = remoteProjectHostIdForTarget(SSH_TARGET, SERVER_ID);
      const hosts = query<{
        host_id: string;
        kind: string;
        target_json: string;
        membership_id: string;
      }>(db, "SELECT host_id,kind,target_json,membership_id FROM hosts WHERE host_id<>'local'");
      assert.equal(hosts.length, 1, "同一设备只允许一行 host（退役线路不建行）");
      assert.equal(hosts[0]?.host_id, stableId);
      assert.equal(hosts[0]?.kind, "ssh");
      assert.ok(hosts[0]?.membership_id, "迁移必须补齐 membership_id 不透明令牌");
      assert.equal(JSON.parse(String(hosts[0]?.target_json)).host, "devbox");
      const entries = query<{ host_id: string; cached_name: string }>(
        db,
        "SELECT host_id,cached_name FROM remote_project_entries",
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.host_id, stableId, "entries 必须挂稳定身份而非地址派生行");
      assert.equal(entries[0]?.cached_name, "app");

      // 幂等：再次执行只做别名归并，不新增 host 或入口行。
      migrateConnectionHostsOnUpgrade(db, { settings, backupDirectories: [dir] });
      assert.equal(
        query(db, "SELECT 1 FROM hosts WHERE host_id<>'local'").length,
        1,
        "重复执行不得产生第二行 host",
      );
      assert.equal(
        query(db, "SELECT 1 FROM remote_project_entries").length,
        1,
        "重复执行不得重复写入入口",
      );
    } finally {
      db.close();
    }
  });
});

test("T-RP2: 未握手线路保持地址派生身份，entries 与 host 身份一致", async () => {
  await withTempDir(async (dir) => {
    const settings = legacySettings({
      sourceServers: [],
      connectionProfiles: [
        {
          profileId: PROFILE_ID,
          transport: "ssh",
          target: SSH_TARGET,
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
    });
    const db = openDatabase(join(dir, "tasks-index.sqlite"));
    try {
      await projectStorage.migrate(db, { settings, backupDirectories: [dir] });
      const addressId = remoteProjectHostIdForTarget(SSH_TARGET);
      const hosts = query<{ host_id: string }>(
        db,
        "SELECT host_id FROM hosts WHERE host_id<>'local'",
      );
      assert.deepEqual(
        hosts.map((host) => host.host_id),
        [addressId],
      );
      const entries = query<{ host_id: string }>(db, "SELECT host_id FROM remote_project_entries");
      assert.equal(entries[0]?.host_id, addressId);
    } finally {
      db.close();
    }
  });
});

test("T-RP5: 全新库经 TaskIndexRepo.initialize 建四表并在册 0005/0008", async () => {
  await withTempDir(async (dir) => {
    setDataBaseDir(dir);
    try {
      const path = join(dir, "tasks-index.sqlite");
      const repo = new TaskIndexRepo(legacySettings(), undefined, path, 5000);
      await repo.ensureReady();
      repo.close();
      const db = openDatabase(path);
      try {
        const tables = new Set(
          query<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table'").map(
            (row) => row.name,
          ),
        );
        for (const table of ["hosts", "projects", "project_roots", "remote_project_entries"])
          assert.ok(tables.has(table), `迁移后必须存在 ${table} 表`);
        const ledger = new Set(
          query<{ id: string }>(db, "SELECT id FROM schema_migration").map((row) => row.id),
        );
        assert.ok(ledger.has("0005_projects"), "项目迁移账本必须在册");
        assert.ok(ledger.has("0008_connection_hosts"), "存量库收敛迁移账本必须在册");
        const hosts = query<{ host_id: string }>(
          db,
          "SELECT host_id FROM hosts WHERE host_id<>'local'",
        );
        assert.equal(hosts.length, 1, "启动迁移必须真建 host 行（不是只在测试里被调）");
        assert.equal(hosts[0]?.host_id, remoteProjectHostIdForTarget(SSH_TARGET, SERVER_ID));
      } finally {
        db.close();
      }
    } finally {
      setDataBaseDir(null);
    }
  });
});

test("T-RP5: 已应用 0005 的存量库再启动，hosts 非空且 projects/entries 收敛到稳定 id", async () => {
  await withTempDir(async (dir) => {
    setDataBaseDir(dir);
    try {
      const path = join(dir, "tasks-index.sqlite");
      const settings = legacySettings();
      const stableId = remoteProjectHostIdForTarget(SSH_TARGET, SERVER_ID);
      const addressId = remoteProjectHostIdForTarget(SSH_TARGET);
      const first = new TaskIndexRepo(settings, undefined, path, 5000);
      await first.ensureReady();
      first.close();

      // 模拟 0008 上线前的存量库：账本无 0008，host/projects/entries 仍挂在地址派生行上。
      const legacy = new DatabaseSync(path);
      try {
        legacy.prepare("DELETE FROM schema_migration WHERE id=?").run("0008_connection_hosts");
        legacy
          .prepare(
            "INSERT INTO hosts(host_id,kind,target_json,membership_id,position) SELECT ?,kind,target_json,membership_id,position FROM hosts WHERE host_id=?",
          )
          .run(addressId, stableId);
        legacy
          .prepare(
            "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run("legacy-project", addressId, "legacy", 0, 1, 1);
        legacy
          .prepare("UPDATE remote_project_entries SET host_id=? WHERE host_id=?")
          .run(addressId, stableId);
        legacy.prepare("DELETE FROM hosts WHERE host_id=?").run(stableId);
      } finally {
        legacy.close();
      }

      const second = new TaskIndexRepo(settings, undefined, path, 5000);
      await second.ensureReady();
      second.close();

      const db = openDatabase(path);
      try {
        const hosts = query<{ host_id: string; membership_id: string }>(
          db,
          "SELECT host_id,membership_id FROM hosts WHERE host_id<>'local'",
        );
        assert.equal(hosts.length, 1, "收敛后同一设备仅保留一行稳定 host");
        assert.equal(hosts[0]?.host_id, stableId);
        assert.ok(hosts[0]?.membership_id);
        assert.equal(
          query(db, "SELECT 1 FROM hosts WHERE host_id=?").length,
          0,
          "旧地址派生 host 行必须清理",
        );
        const entries = query<{ host_id: string }>(
          db,
          "SELECT host_id FROM remote_project_entries",
        );
        assert.equal(entries[0]?.host_id, stableId, "entries 必须显式重写到稳定 id");
        const projects = query<{ host_id: string }>(
          db,
          "SELECT host_id FROM projects WHERE project_id=?",
          "legacy-project",
        );
        assert.equal(projects[0]?.host_id, stableId, "projects 必须显式重写到稳定 id");
        assert.equal(
          query(db, "SELECT 1 FROM schema_migration WHERE id=?", "0008_connection_hosts").length,
          1,
          "收敛完成后账本必须记账，后续启动不再重复改绑",
        );
      } finally {
        db.close();
      }
    } finally {
      setDataBaseDir(null);
    }
  });
});

test("T-RP5: prepareTasksIndexStorage（Worker 生产入口）完成 0005/0008 并可早退", async () => {
  await withTempDir(async (dir) => {
    setDataBaseDir(dir);
    try {
      const path = join(dir, "tasks-index.sqlite");
      const phases: string[] = [];
      await prepareTasksIndexStorage(path, (phase) => phases.push(phase), legacySettings());
      assert.equal(phases.at(-1), "ready", "Worker 入口必须发布 ready 终态");

      const stableId = remoteProjectHostIdForTarget(SSH_TARGET, SERVER_ID);
      const inspect = () => {
        const db = openDatabase(path);
        try {
          return {
            ledger: new Set(
              query<{ id: string }>(db, "SELECT id FROM schema_migration").map((row) => row.id),
            ),
            hosts: query<{ host_id: string }>(
              db,
              "SELECT host_id FROM hosts WHERE host_id<>'local'",
            ).map((row) => row.host_id),
            projects: query<{ project_id: string; host_id: string; name: string }>(
              db,
              "SELECT project_id,host_id,name FROM projects WHERE deleted=0",
            ),
            entries: query<{ host_id: string }>(
              db,
              "SELECT host_id FROM remote_project_entries",
            ).map((row) => row.host_id),
          };
        } finally {
          db.close();
        }
      };

      const before = inspect();
      assert.ok(before.ledger.has("0005_projects"), "Worker 入口必须跑 0005");
      assert.ok(before.ledger.has("0008_connection_hosts"), "Worker 入口必须跑 0008");
      assert.deepEqual(before.hosts, [stableId]);
      assert.deepEqual(before.entries, [stableId], "0005 必须按 settings 建入口行");

      // 入口已 markTasksStoragePrepared：同进程业务连接走早退分支（F-1 事实），不再重复迁移。
      const repo = new TaskIndexRepo(legacySettings(), undefined, path, 5000);
      await repo.ensureReady();
      repo.close();
      assert.deepEqual(inspect(), before, "早退分支不得重复执行迁移或新增行");
    } finally {
      setDataBaseDir(null);
    }
  });
});

test("T-RP7: 0008 遇两 host 同名项目 + 同 remote_project_id 入口时去重收敛，任务仍可见", async () => {
  await withTempDir(async (dir) => {
    setDataBaseDir(dir);
    try {
      const path = join(dir, "tasks-index.sqlite");
      const settings = legacySettings();
      const stableId = remoteProjectHostIdForTarget(SSH_TARGET, SERVER_ID);
      const addressId = remoteProjectHostIdForTarget(SSH_TARGET);
      const first = new TaskIndexRepo(settings, undefined, path, 5000);
      await first.ensureReady();
      first.close();

      // 模拟 0008 上线前的存量库：地址派生 host 侧另有同名未删项目 + 同 remote_project_id
      // 入口，任务仍归属 legacy 项目。修复前直接 UPDATE host_id 会撞两条唯一索引，
      // runner 整体回滚导致 Host 起不来。
      const legacy = new DatabaseSync(path);
      try {
        legacy.prepare("DELETE FROM schema_migration WHERE id=?").run("0008_connection_hosts");
        legacy
          .prepare(
            "INSERT INTO hosts(host_id,kind,target_json,membership_id,position) VALUES(?,?,?,?,?)",
          )
          .run(addressId, "ssh", JSON.stringify(SSH_TARGET), "membership-legacy", 1);
        legacy
          .prepare("UPDATE remote_project_entries SET remote_project_id=? WHERE host_id=?")
          .run("project-a", stableId);
        // 两 host 各一行同名未删项目（stable 侧已收敛、legacy 侧待收敛），任务挂在 legacy 项目。
        legacy
          .prepare(
            "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run("stable-project", stableId, "app", 0, 1, 1);
        legacy
          .prepare(
            "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run("legacy-project", addressId, "app", 1, 1, 1);
        legacy
          .prepare(
            "INSERT INTO remote_project_entries(entry_id,host_id,remote_project_id,cached_name,cached_roots_json) VALUES(?,?,?,?,?)",
          )
          .run("legacy-entry", addressId, "project-a", "app", "[]");
        legacy
          .prepare(`INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,
            provider,created_at,updated_at,host_id,root_path,project_id,cli_created_at,cli_updated_at,cli_title)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            "remote:ssh:devbox:22:omz:/srv/app",
            "/srv/app",
            "remote:ssh:devbox:22:omz:/srv/app",
            "task-1",
            "旧任务",
            "glm",
            1,
            1,
            stableId,
            "/srv/app",
            "legacy-project",
            1,
            1,
            "旧任务",
          );
      } finally {
        legacy.close();
      }

      const second = new TaskIndexRepo(settings, undefined, path, 5000);
      await second.ensureReady();
      second.close();

      const db = openDatabase(path);
      try {
        assert.equal(
          query(db, "SELECT 1 FROM schema_migration WHERE id=?", "0008_connection_hosts").length,
          1,
          "去重后 0008 必须落账本（不得整体回滚）",
        );
        assert.deepEqual(
          query<{ host_id: string }>(db, "SELECT host_id FROM hosts WHERE host_id<>'local'").map(
            (row) => row.host_id,
          ),
          [stableId],
          "收敛后同一设备只保留稳定 host 一行",
        );
        // projects 侧：同名两条只保留稳定侧未删行，legacy 侧软删（与 deleteProject 同形）。
        const active = query<{ project_id: string; host_id: string; name: string }>(
          db,
          "SELECT project_id,host_id,name FROM projects WHERE name=? AND deleted=0",
          "app",
        );
        assert.equal(active.length, 1, "同名未删项目必须各剩一行");
        assert.equal(active[0]?.host_id, stableId);
        assert.equal(active[0]?.project_id, "stable-project", "必须保留稳定侧项目");
        const legacyProject = query<{
          host_id: string;
          deleted: number;
          deleted_at: number | null;
        }>(
          db,
          "SELECT host_id,deleted,deleted_at FROM projects WHERE project_id=?",
          "legacy-project",
        );
        assert.equal(legacyProject[0]?.host_id, stableId, "legacy 项目随 host 收敛改绑");
        assert.equal(legacyProject[0]?.deleted, 1, "legacy 侧同名项目必须软删而非硬删");
        assert.ok(legacyProject[0]?.deleted_at, "软删必须写 deleted_at");
        // entries 侧：同 remote_project_id 只保留稳定侧一行，判定与 bindHost 一致。
        const entries = query<{ host_id: string; entry_id: string }>(
          db,
          "SELECT host_id,entry_id FROM remote_project_entries",
        );
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.host_id, stableId);
        assert.notEqual(entries[0]?.entry_id, "legacy-entry");
        // tasks.project_id 不改指：任务行本身不丢，仍挂在（已软删的）legacy 项目上。
        const task = query<{ project_id: string; host_id: string; deleted: number }>(
          db,
          "SELECT project_id,host_id,deleted FROM tasks WHERE task_id=?",
          "task-1",
        );
        assert.equal(task.length, 1);
        assert.equal(task[0]?.project_id, "legacy-project");
        assert.equal(task[0]?.deleted, 0);

        // 项目树读取面：已删项目不出现，任务仍在列表（不能因 host 迁移丢任务）。
        const tree = projectStorage.repository(db, stableId).readTree();
        assert.deepEqual(
          tree.projects.map((project) => project.id),
          [active[0]!.project_id],
          "软删的 legacy 项目不进入项目树",
        );
        assert.deepEqual(
          tree.tasks.map((entry) => entry.taskId),
          ["task-1"],
          "软删 legacy 项目后其任务仍可见",
        );
        assert.equal(tree.tasks[0]?.projectId, "legacy-project");
      } finally {
        db.close();
      }
    } finally {
      setDataBaseDir(null);
    }
  });
});
