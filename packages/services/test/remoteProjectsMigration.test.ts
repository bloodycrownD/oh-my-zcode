// T-RP2 + T-RP5 + T-RP7（backlog-sweep Step 1 迁移回归，upgrade-316 按 0010 编号恢复）：
// T-RP2 — legacy connectionProfiles → hosts 稳定身份回填（别名合并、retired 过滤、
//         entries 按稳定 host_id 落行、重复执行不产生重复行）。
// T-RP5 — 迁移生产链接线：全新库经 `TaskIndexRepo.initialize`（Host 真实入口）后
//         hosts/projects/project_roots/remote_project_entries 四表存在且 0005/0010 在册；
//         已应用 0005 的存量库再次启动后 hosts 非空、同设备仅一行 host 且
//         projects/entries.host_id=稳定 id。
// T-RP7 — 0010 收敛撞唯一索引：两 host 同名未删项目 + 同 remote_project_id 入口时按去重口径
//         收敛（软删 legacy 项目、删 legacy 冲突入口），tasks.project_id 不改指、任务仍可见。
// T-OLD — fork v1.0.21-23 存量库账本带旧编号 0008_connection_hosts：runner 经 previousIds
//         只补记 0010、不重放 apply（hosts.membership_id 不被重刷，严格 no-op）。
// T-RP8 — 0011/0012（FORK(upgrade-316) 补挂上游 0008/0009）fresh 库等价性：
//         remote_project_entries 带 cached_deleted 列（INTEGER NOT NULL DEFAULT 0），
//         session_creation_commands 按上游主键形状可写、同键映射唯一。
// T-RP9 — 已按 0005-0010 初始化的存量库再跑 0011/0012 不炸：回滚两处结构 + 删账本行后
//         再次启动，列/表恢复、既有入口行原样保留、重复启动不重复记账。
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/remoteProjectsMigration.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import(
  "node:sqlite"
);
import { setDataBaseDir } from "../src/paths.js";
import { projectStorage } from "../src/project-storage/index.js";
import { migrateConnectionHostsOnUpgrade } from "../src/project-storage/migrate-projects.js";
import type { ProjectMigrationContext } from "../src/project-storage/contract.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { remoteProjectHostIdForTarget } from "../src/remote-projects/connection-membership.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const SSH_TARGET = { kind: "ssh" as const, host: "devbox", username: "omz", port: 22 };
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const RETIRED_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const RETIRED_SERVER_ID = "44444444-4444-4444-8444-444444444444";
const HOSTS_MIGRATION_ID = "0010_connection_hosts";
const HOSTS_MIGRATION_LEGACY_ID = "0008_connection_hosts";
const DELETED_CACHE_MIGRATION_ID = "0011_remote_entry_deleted_cache";
const SESSION_COMMANDS_MIGRATION_ID = "0012_session_creation_commands";

/** 旧设置：一条已握手 SSH 线路 + 一条退役线路（退役行不得进入 hosts）。 */
function legacySettings(
  overrides: Partial<NonNullable<ProjectMigrationContext["settings"]>> = {},
): NonNullable<ProjectMigrationContext["settings"]> {
  // 当前 AppSettings 的 Pick 要求 recentProjects 必填；Partial 覆盖片只能整体断言回契约类型。
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
  } as NonNullable<ProjectMigrationContext["settings"]>;
}

function query<T>(
  db: ReturnType<typeof openDatabase>,
  sql: string,
  ...params: (string | number | bigint | null)[]
): T[] {
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

test("T-RP5: 全新库经 TaskIndexRepo.initialize 建四表并在册 0005/0010", async () => {
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
        assert.ok(ledger.has(HOSTS_MIGRATION_ID), "存量库收敛迁移账本必须在册");
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

      // 模拟 0010 上线前的存量库：账本无 0010，host/projects/entries 仍挂在地址派生行上。
      const legacy = new DatabaseSync(path);
      try {
        legacy.prepare("DELETE FROM schema_migration WHERE id=?").run(HOSTS_MIGRATION_ID);
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
        const projects = query<{ host_id: string; deleted: number }>(
          db,
          "SELECT host_id,deleted FROM projects WHERE project_id=?",
          "legacy-project",
        );
        assert.equal(projects[0]?.host_id, stableId, "projects 必须显式重写到稳定 id");
        // 无同名冲突时去重 SQL 必须命中 0 行：软删只针对「稳定侧已有同名未删项目」这一形状。
        // 若去重子查询漏掉 `host_id=stable` 限定，会把全部 legacy 项目洗成 deleted=1，
        // 而只断言 host_id 的用例仍然全绿 —— 所以这条必须单独守着。
        assert.equal(projects[0]?.deleted, 0, "无同名冲突的 legacy 项目不得被去重逻辑软删");
        assert.equal(
          query(db, "SELECT 1 FROM schema_migration WHERE id=?", HOSTS_MIGRATION_ID).length,
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

test("T-OLD: 账本带旧编号 0008 的 v1.0.21-23 存量库，0010 只补记不重放（严格 no-op）", async () => {
  await withTempDir(async (dir) => {
    setDataBaseDir(dir);
    try {
      const path = join(dir, "tasks-index.sqlite");
      const settings = legacySettings();
      const first = new TaskIndexRepo(settings, undefined, path, 5000);
      await first.ensureReady();
      first.close();

      // 模拟 v1.0.21-23 老库：把 0010 账本行改写回旧编号 0008_connection_hosts
      // （checksum 与 0010 的 sql 逐字节一致，等价于老 runner 当年记的账），
      // 并在 hosts 上放哨兵，验证升级启动不会重放 apply。
      const legacy = new DatabaseSync(path);
      try {
        legacy
          .prepare(
            "INSERT INTO schema_migration(id,checksum,app_version,applied_at) SELECT ?,checksum,app_version,applied_at FROM schema_migration WHERE id=?",
          )
          .run(HOSTS_MIGRATION_LEGACY_ID, HOSTS_MIGRATION_ID);
        legacy.prepare("DELETE FROM schema_migration WHERE id=?").run(HOSTS_MIGRATION_ID);
        legacy
          .prepare("UPDATE hosts SET membership_id=? WHERE host_id<>'local'")
          .run("sentinel-membership");
      } finally {
        legacy.close();
      }

      const second = new TaskIndexRepo(settings, undefined, path, 5000);
      await second.ensureReady();
      second.close();

      const db = openDatabase(path);
      try {
        const ledger = new Set(
          query<{ id: string }>(db, "SELECT id FROM schema_migration").map((row) => row.id),
        );
        assert.ok(ledger.has(HOSTS_MIGRATION_ID), "previousIds 命中后必须补记新编号");
        assert.ok(ledger.has(HOSTS_MIGRATION_LEGACY_ID), "旧编号行作为孤儿保留，不得删除");
        assert.equal(
          query<{ membership_id: string }>(
            db,
            "SELECT membership_id FROM hosts WHERE host_id<>'local'",
          )[0]?.membership_id,
          "sentinel-membership",
          "老库不得重放 apply（重放会重刷 membership_id）",
        );
      } finally {
        db.close();
      }
    } finally {
      setDataBaseDir(null);
    }
  });
});

test("T-RP7: 0010 遇两 host 同名项目 + 同 remote_project_id 入口时去重收敛，任务仍可见", async () => {
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

      // 模拟 0010 上线前的存量库：地址派生 host 侧另有同名未删项目 + 同 remote_project_id
      // 入口，任务仍归属 legacy 项目。修复前直接 UPDATE host_id 会撞两条唯一索引，
      // runner 整体回滚导致 Host 起不来。
      const legacy = new DatabaseSync(path);
      try {
        legacy.prepare("DELETE FROM schema_migration WHERE id=?").run(HOSTS_MIGRATION_ID);
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
          query(db, "SELECT 1 FROM schema_migration WHERE id=?", HOSTS_MIGRATION_ID).length,
          1,
          "去重后 0010 必须落账本（不得整体回滚）",
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

test("T-RP8: 0011/0012 fresh 库等价于上游 0008/0009 的形态与行为", async () => {
  await withTempDir(async (dir) => {
    setDataBaseDir(dir);
    try {
      const path = join(dir, "tasks-index.sqlite");
      const repo = new TaskIndexRepo(legacySettings(), undefined, path, 5000);
      await repo.ensureReady();
      repo.close();
      const db = openDatabase(path);
      try {
        // 0011 = 上游 0008：cached_deleted 列存在且类型/非空/默认值逐项一致。
        // notnull 是 SQLite 关键字（NOT NULL 运算符），pragma 表值函数里必须加引号。
        const column = query<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string;
        }>(
          db,
          'SELECT name,type,"notnull" AS "notnull",dflt_value FROM pragma_table_info(\'remote_project_entries\') WHERE name=\'cached_deleted\'',
        );
        assert.equal(column.length, 1, "0011 必须给 remote_project_entries 补 cached_deleted 列");
        assert.equal(column[0]?.type, "INTEGER");
        assert.equal(column[0]?.notnull, 1, "上游 0008 语义：NOT NULL");
        assert.equal(column[0]?.dflt_value, "0", "上游 0008 语义：DEFAULT 0（未删）");
        // 迁移已落行的入口读回默认 0，且列可写（在线刷新写入删除态）。
        const entries = query<{ cached_deleted: number }>(
          db,
          "SELECT cached_deleted FROM remote_project_entries",
        );
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.cached_deleted, 0, "存量入口行默认未删");
        db.prepare("UPDATE remote_project_entries SET cached_deleted=1").run();
        assert.equal(
          query<{ cached_deleted: number }>(
            db,
            "SELECT cached_deleted FROM remote_project_entries",
          )[0]?.cached_deleted,
          1,
          "cached_deleted 必须可写（离线回退读取的写入面）",
        );

        // 0012 = 上游 0009：映射表主键形状 (workspace_key, client_id, command_id)。
        const primaryKey = query<{ name: string; pk: number }>(
          db,
          "SELECT name,pk FROM pragma_table_info('session_creation_commands') WHERE pk>0 ORDER BY pk",
        ).map((row) => row.name);
        assert.deepEqual(primaryKey, ["workspace_key", "client_id", "command_id"]);
        // 上游语义：同键重试读回原映射，不产生第二行。
        db.prepare("INSERT INTO session_creation_commands VALUES(?,?,?,?)").run(
          "remote:ssh:devbox:22:omz:/srv/app",
          "client-1",
          "cmd-1",
          "sess-1",
        );
        assert.throws(
          () =>
            db
              .prepare("INSERT INTO session_creation_commands VALUES(?,?,?,?)")
              .run("remote:ssh:devbox:22:omz:/srv/app", "client-1", "cmd-1", "sess-2"),
          /UNIQUE/,
          "同键映射必须唯一，重试不得改指新会话",
        );
        assert.equal(
          query<{ session_id: string }>(
            db,
            "SELECT session_id FROM session_creation_commands WHERE client_id='client-1'",
          )[0]?.session_id,
          "sess-1",
        );

        const ledger = new Set(
          query<{ id: string }>(db, "SELECT id FROM schema_migration").map((row) => row.id),
        );
        assert.ok(ledger.has(DELETED_CACHE_MIGRATION_ID), "0011 必须在册");
        assert.ok(ledger.has(SESSION_COMMANDS_MIGRATION_ID), "0012 必须在册");
      } finally {
        db.close();
      }
    } finally {
      setDataBaseDir(null);
    }
  });
});

test("T-RP9: 已按 0005-0010 初始化的库再跑 0011/0012 不炸且幂等", async () => {
  await withTempDir(async (dir) => {
    setDataBaseDir(dir);
    try {
      const path = join(dir, "tasks-index.sqlite");
      const first = new TaskIndexRepo(legacySettings(), undefined, path, 5000);
      await first.ensureReady();
      first.close();

      // 模拟 0011/0012 上线前的 0010 存量库：账本无两行新编号，结构回滚到补挂前
      // （DROP 列/表），并在入口行放哨兵验证升级不改既有数据。
      const legacy = new DatabaseSync(path);
      try {
        legacy
          .prepare("DELETE FROM schema_migration WHERE id IN (?,?)")
          .run(DELETED_CACHE_MIGRATION_ID, SESSION_COMMANDS_MIGRATION_ID);
        legacy.exec("DROP TABLE session_creation_commands");
        legacy.exec("ALTER TABLE remote_project_entries DROP COLUMN cached_deleted");
        legacy.prepare("UPDATE remote_project_entries SET cached_name=?").run("sentinel-entry");
        assert.equal(
          (
            legacy
              .prepare(
                "SELECT count(*) AS n FROM pragma_table_info('remote_project_entries') WHERE name='cached_deleted'",
              )
              .get() as { n: number }
          ).n,
          0,
          "前置：0010 库没有 cached_deleted 列",
        );
      } finally {
        legacy.close();
      }

      // 升级启动：不得抛 duplicate column name / table already exists。
      const second = new TaskIndexRepo(legacySettings(), undefined, path, 5000);
      await second.ensureReady();
      second.close();

      const db = openDatabase(path);
      try {
        const column = query<{ type: string; notnull: number; dflt_value: string }>(
          db,
          'SELECT type,"notnull" AS "notnull",dflt_value FROM pragma_table_info(\'remote_project_entries\') WHERE name=\'cached_deleted\'',
        );
        assert.equal(column.length, 1, "0011 必须给 0010 存量库补列");
        assert.deepEqual(
          [column[0]?.type, column[0]?.notnull, column[0]?.dflt_value],
          ["INTEGER", 1, "0"],
          "补列形状与上游 0008 一致",
        );
        const entries = query<{ cached_name: string; cached_deleted: number }>(
          db,
          "SELECT cached_name,cached_deleted FROM remote_project_entries",
        );
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.cached_name, "sentinel-entry", "升级不得改写既有入口行");
        assert.equal(entries[0]?.cached_deleted, 0, "补列后存量行读默认未删");
        assert.equal(
          query(
            db,
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_creation_commands'",
          ).length,
          1,
          "0012 必须重建映射表",
        );
        assert.equal(
          query(db, "SELECT 1 FROM schema_migration WHERE id=?", DELETED_CACHE_MIGRATION_ID).length,
          1,
          "0011 升级后必须记账",
        );
        assert.equal(
          query(
            db,
            "SELECT 1 FROM schema_migration WHERE id=?",
            SESSION_COMMANDS_MIGRATION_ID,
          ).length,
          1,
          "0012 升级后必须记账",
        );
      } finally {
        db.close();
      }

      // 再次启动：账本在册，两条迁移严格 no-op（不重复记账、不重放）。
      const third = new TaskIndexRepo(legacySettings(), undefined, path, 5000);
      await third.ensureReady();
      third.close();
      const reopened = openDatabase(path);
      try {
        assert.equal(
          query<{ n: number }>(
            reopened,
            "SELECT count(*) AS n FROM schema_migration WHERE id IN (?,?)",
            DELETED_CACHE_MIGRATION_ID,
            SESSION_COMMANDS_MIGRATION_ID,
          )[0]?.n,
          2,
          "重复启动不得重复记账",
        );
        assert.equal(
          query<{ cached_name: string }>(
            reopened,
            "SELECT cached_name FROM remote_project_entries",
          )[0]?.cached_name,
          "sentinel-entry",
          "重复启动不得改写既有入口行",
        );
      } finally {
        reopened.close();
      }
    } finally {
      setDataBaseDir(null);
    }
  });
});
