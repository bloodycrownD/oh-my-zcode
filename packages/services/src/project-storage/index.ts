import { ProjectRepository } from "#src/project-storage/project-repository.js";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";
import type { ProjectStorageContract } from "#src/project-storage/contract.js";
import { reconcileLegacy, admitTaskIdentity } from "#src/project-storage/legacy-tasks.js";
import {
  migrateProjects,
  migrateConnectionHostsOnUpgrade,
} from "#src/project-storage/migrate-projects.js";
import {
  INITIAL_WORKSPACE_ORDER_SQL,
  applyInitialWorkspaceOrderSql,
  migrateInitialWorkspaceOrder,
} from "#src/project-storage/migration-order/migration.js";
import {
  DEFAULT_WORKSPACE_CANDIDATES_OMZ_SQL,
  DEFAULT_WORKSPACE_CANDIDATES_SQL,
  migrateDefaultWorkspaceTasks,
} from "#src/project-storage/default-workspace/migration.js";
import {
  PROJECT_MIGRATION_TABLES,
  PROJECT_SCHEMA_SQL,
  REMOTE_ENTRY_DELETED_CACHE_SQL,
  SESSION_CREATION_COMMANDS_SQL,
  TASK_PROJECT_COLUMNS,
  applyRemoteEntryDeletedCacheSql,
} from "#src/project-storage/schema.js";

export type {
  ProjectMigrationContext,
  ProjectStorageContract,
} from "#src/project-storage/contract.js";
export const projectStorage: ProjectStorageContract = {
  migrate: async (db, context) => {
    let firstProjectMigration = false;
    const result = await sqliteMigrations.migrate(
      db,
      [
        {
          id: "0005_projects",
          previousIds: ["0001_projects"],
          appVersion: "3.12.0",
          touchedTables: PROJECT_MIGRATION_TABLES,
          sql: `${PROJECT_SCHEMA_SQL}\n-- tasks columns: ${JSON.stringify(TASK_PROJECT_COLUMNS)}\n-- v3 workspace/group first assignment and CLI intent handoff`,
          apply: (database) => {
            migrateProjects(database, context);
            firstProjectMigration = true;
          },
        },
        {
          // FORK(upgrade-316)：上游原编号 0006_default_workspace_tasks，顺延为 0007。
          // 因果：tasks-index 与 project-storage 是同一 SQLite 文件的两张账本表
          // （tasks_schema_migration / schema_migration），id 互不可见、从不互校——
          // 「与 fork 的 0006_task_group_admissions 撞号」并不直接成立。真实动因是
          // 调试库曾按上游版 0006 记账，SQL 调整后同 id checksum mismatch 挡启动；
          // 顺延为新 id 规避，账本里的旧 0006 行成为无害孤儿（runner 只校验清单内 id）。
          // 注意：本条 sql 引用的 DEFAULT_WORKSPACE_CANDIDATES_SQL 是记账冻结字节（.zcode
          // 谓词），不能随品牌口径改写；fork 数据根 ~/.omz 下的真实修复由 0009 重放。
          id: "0007_default_workspace_tasks",
          appVersion: "3.12.0",
          touchedTables: ["tasks", "projects"],
          sql: `${DEFAULT_WORKSPACE_CANDIDATES_SQL}\n-- v1 clear project ownership and soft-delete the unedited system container; preserve task facts`,
          apply: (database) => migrateDefaultWorkspaceTasks(database, context),
        },
        {
          // FORK(upgrade-316)：原 0007_initial_workspace_order，随上一条顺延为 0008。
          id: "0008_initial_workspace_order",
          appVersion: "3.16.2",
          touchedTables: ["projects", "remote_project_entries"],
          sql: `${INITIAL_WORKSPACE_ORDER_SQL}\n-- seed mixed order only when 0005 runs in this transaction`,
          // FORK(upgrade-316)：fork 升级库已存在 initial_position 列，ADD COLUMN 需判列幂等。
          apply: (database) => {
            applyInitialWorkspaceOrderSql(database);
            if (firstProjectMigration) migrateInitialWorkspaceOrder(database, context);
          },
        },
        {
          // FORK(upgrade-316)：0007 的 sql 谓词按上游数据根 ~/.zcode 写死且已入账本
          // checksum（字节冻结），在 fork 数据根 ~/.omz 下 GLOB 永不命中——0007 在
          // 真实 fork 库上静默空转。本条用 omz 谓词重放同一修复（幂等：已纠偏过的
          // 项目不满足「未编辑」条件，重跑为 0 行）。全新库上 0007 的 apply 已直接
          // 用 omz 谓词生效，本条对其空转、无害。
          id: "0009_repair_default_workspace_predicate",
          appVersion: "3.16.2",
          touchedTables: ["tasks", "projects"],
          sql: `${DEFAULT_WORKSPACE_CANDIDATES_OMZ_SQL}\n-- FORK(upgrade-316): replay default-workspace repair under ~/.omz data root`,
          apply: (database) => migrateDefaultWorkspaceTasks(database, context),
        },
        {
          // FORK(upgrade-316)：fork v1.0.21-23 的存量库账本里已有旧编号 0008_connection_hosts
          // （当时的清单在 backlog-sweep 线，44728ff0 起字节未变），合并采用上游 v3.16.2
          // 清单时该条丢档。上游编号 0008 已被 initial_workspace_order 占用，故按新编号
          // 0010 重挂同一收敛逻辑；sql 必须与旧条目逐字节一致——runner 对 previousIds 命中
          // 的老账本行做 checksum 校验后只补记新 id、不重放 apply（老库天然 no-op，
          // hosts.membership_id 不会被重刷）。
          id: "0010_connection_hosts",
          previousIds: ["0008_connection_hosts"],
          appVersion: "3.16.2",
          touchedTables: ["hosts", "projects", "remote_project_entries"],
          sql: `-- existing databases: merge legacy connectionProfiles into stable remote:server:<id> hosts
-- and rewrite projects.host_id / remote_project_entries.host_id before dropping address-derived rows`,
          // 全新库在 0005 的 apply 里已内联完成 profile→hosts 归并，本条对其空转。
          apply: (database) => {
            if (firstProjectMigration) return;
            migrateConnectionHostsOnUpgrade(database, context);
          },
        },
        {
          // FORK(upgrade-316)：上游 0008_remote_entry_deleted_cache。上游的 0008/0009 编号
          // 在 fork 已被 initial_workspace_order / repair_default_workspace_predicate 占用，
          // 合并上游清单时这两条被丢弃，这里按 0011 补挂。sql 逐字节沿用上游常量
          // （checksum 与上游账本行同值）；ADD COLUMN 非幂等，apply 判列兜底曾按上游
          // 清单跑过、已建 cached_deleted 列的调试库，fresh 与 0010 存量库照常补列。
          id: "0011_remote_entry_deleted_cache",
          appVersion: "3.16.3",
          touchedTables: ["remote_project_entries"],
          sql: REMOTE_ENTRY_DELETED_CACHE_SQL,
          apply: (database) => applyRemoteEntryDeletedCacheSql(database),
        },
        {
          // FORK(upgrade-316)：上游 0009_session_creation_commands，同上因编号占用顺延为
          // 0012。CREATE TABLE IF NOT EXISTS 天然幂等，对已建表的库 no-op，原样执行上游
          // 字节即可；本条只建映射表，不重写历史任务（与上游 0009 语义一致）。
          id: "0012_session_creation_commands",
          appVersion: "3.16.3",
          touchedTables: ["session_creation_commands"],
          sql: SESSION_CREATION_COMMANDS_SQL,
        },
      ],
      {
        database: "tasks_index",
        backupDirectories: context.backupDirectories,
        now: context.now,
        onBackupSkipped: () => context.warn?.("项目迁移备份因可写卷空间不足跳过"),
      },
    );
    reconcileLegacy(db, context.hostId);
    return result;
  },
  admitTaskIdentity,
  repository: (db, hostId) => new ProjectRepository(db, hostId),
};
