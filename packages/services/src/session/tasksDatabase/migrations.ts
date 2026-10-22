import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTOMATION_SCHEMA,
  OFF_PEAK_SCHEMA,
  TASK_INDEX_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import { importLegacyAutomationSelections } from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";
// 0006 冻结 SQL 与上游同源（task-groups/migration-v6.ts 逐字节拷贝，含首尾换行）。
import { TASK_GROUP_ADMISSIONS_SQL } from "#src/task-groups/migration-v6.js";
// 两支专属 scope（R3 三期 Step 18）：SQL/冻结输入与上游同库账本逐字节可互换，
// 老库升级不得因品牌或实现差异触发 checksum mismatch。
import { CONTROLLER_REMOTE_SCHEMA_SQL } from "#src/session/tasksDatabase/controller-remote-schema-v4.js";
import {
  adoptSourceServerWorkspaceSchema,
  SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT,
} from "#src/session/tasksDatabase/source-server-schema-v5.js";

// 冻结历史列声明，不能以实时 Repo/schema 代替，否则新版构建会改变已应用 checksum。
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
const terminalStatuses = "'completed','failed','cancelled'";
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;
// 0004 的冻结输入：与上游 migrations.ts 逐字节一致（表/列对数组 + "nullable-text-v1"），
// 追加后 sha256(JSON.stringify(checksumInput)) 必须与上游同库账本可互换（老库升级不 mismatch）。
const executionColumns = [
  ["automations", "project_id"],
  ["automations", "host_id"],
  ["automations", "additional_directories"],
  ["off_peak_tasks", "project_id"],
  ["off_peak_tasks", "host_id"],
  ["off_peak_tasks", "additional_directories"],
] as const;

export type TasksDatabaseMigrationScope = "base" | "controller-remote" | "source-server";

interface TasksDatabaseMigrationDefinition {
  readonly id: string;
  readonly checksumInput: readonly unknown[];
  readonly touchedTables?: readonly string[];
  readonly apply: (db: DatabaseSync) => void;
}

// 与 Agent 同样是库级串行事务，但不跨域依赖其具体 adapter。TS 转换使用冻结语义版本，
// 禁用 function.toString 哈希：Electron/SEA 打包会改变函数文本而非迁移语义。
const definitions: readonly TasksDatabaseMigrationDefinition[] = [
  {
    id: "0001_adopt_task_schema",
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
    apply: adoptSchema,
  },
  {
    id: "0002_provider_selection",
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
    apply: importLegacyAutomationSelections,
  },
  {
    id: "0003_official_glm_selection",
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
    apply: (db) => db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL),
  },
  {
    id: "0004_project_execution_scopes",
    // 项目执行域（project/host/additional_directories）冻结输入；omz 侧不附带上游的
    // controller-remote/source-server 专属 scope，编号沿用上游原号避免同库账本撞号。
    checksumInput: [executionColumns, "nullable-text-v1"],
    apply: adoptExecutionScopes,
  },
  {
    id: "0006_task_group_admissions",
    // 分组登记表（task_group_admissions）冻结输入；0005 为 source-server scope，omz 不带。
    checksumInput: [TASK_GROUP_ADMISSIONS_SQL],
    apply: (db) => db.exec(TASK_GROUP_ADMISSIONS_SQL),
  },
];

// 两端专属迁移仍归同库账本（tasks_schema_migration）协调；scope 只裁剪本端清单，
// 不会为另一端创建无关表（对齐上游 prepareMigrations 语义）。
function prepareMigrations(
  scope: TasksDatabaseMigrationScope,
): readonly TasksDatabaseMigrationDefinition[] {
  if (scope === "base") return definitions;
  if (scope === "controller-remote") {
    return [
      {
        id: "0004_controller_remote_identity",
        checksumInput: [CONTROLLER_REMOTE_SCHEMA_SQL],
        touchedTables: ["controller_remote_identity_migrations"],
        apply: (db) => db.exec(CONTROLLER_REMOTE_SCHEMA_SQL),
      },
    ];
  }
  return [
    {
      id: "0005_source_server_workspace_schema",
      checksumInput: SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT,
      touchedTables: [
        "workspace_alias",
        "workspace_migration_schema_version",
        "workspace_migration_ledger",
        "workspace_migration_conflicts",
        "workspace_migration_ledger_v2",
        "workspace_migration_conflicts_v2",
      ],
      apply: adoptSourceServerWorkspaceSchema,
    },
  ];
}

function resolveMigrationScope(
  scope: string | TasksDatabaseMigrationScope | undefined,
): TasksDatabaseMigrationScope {
  return scope === "controller-remote" || scope === "source-server" ? scope : "base";
}

function migrationChecksum(checksumInput: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(checksumInput)).digest("hex");
}

/** 冻结基准出口（测试与诊断用）：scope 清单的 id→sha256 投影，不触库。 */
export function prepareTasksDatabaseMigrationDigests(
  scope: TasksDatabaseMigrationScope = "base",
): Map<string, string> {
  return new Map(
    prepareMigrations(resolveMigrationScope(scope)).map((migration) => [
      migration.id,
      migrationChecksum(migration.checksumInput),
    ]),
  );
}

export function runTasksDatabaseMigrations(
  db: DatabaseSync,
  scopeOrOptions?:
    | TasksDatabaseMigrationScope
    | {
        scope?: TasksDatabaseMigrationScope;
        transactionOpen?: boolean;
        migration?: DatabaseMigrationFacts;
        onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
      },
): void {
  const options =
    typeof scopeOrOptions === "string"
      ? { scope: resolveMigrationScope(scopeOrOptions) }
      : (scopeOrOptions ?? {});
  const scope = resolveMigrationScope(options.scope);
  const scopedDefinitions = prepareMigrations(scope);
  if (!options.transactionOpen) db.exec("BEGIN IMMEDIATE");
  const migrationFacts: DatabaseMigrationFacts = options.migration ?? {
    kind: "none",
    executedCount: 0,
    committedCount: 0,
  };
  let currentMigrationId: string | undefined;
  try {
    if (!options.migration) migrationFacts.kind = inspectTasksMigrationKind(db, scope);
    db.exec(`CREATE TABLE IF NOT EXISTS tasks_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    // 锁内、版本 SQL 之前采集；空账本是 none，异常编号不作为遥测原文发送。
    const baseline = db
      .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
      .get();
    migrationFacts.lastAppliedMigrationId = baseline
      ? databaseMigrationIdSchema.safeParse(baseline.id).data
      : null;
    for (const migration of scopedDefinitions) {
      currentMigrationId = migration.id;
      const checksum = migrationChecksum(migration.checksumInput);
      const applied = db
        .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
        .get(migration.id);
      if (applied) {
        if (applied.checksum !== checksum)
          throw Object.assign(
            new Error(`Task database migration checksum mismatch: ${migration.id}`),
            { kind: "checksum_mismatch" },
          );
        continue;
      }
      if (migrationFacts.kind === "none") migrationFacts.kind = "upgrade";
      options.onProgress?.("migrating", { ...migrationFacts });
      migration.apply(db);
      migrationFacts.executedCount++;
      db.prepare("INSERT INTO tasks_schema_migration VALUES(?,?,?)").run(
        migration.id,
        checksum,
        Date.now(),
      );
    }
    options.onProgress?.("committing", { ...migrationFacts });
    db.exec("COMMIT");
    migrationFacts.committedCount = migrationFacts.executedCount;
  } catch (error) {
    // 回滚也可能因 IO 失败，不能覆盖真正导致迁移失败的异常。
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* 调用方关闭连接恢复。 */
    }
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

function adoptSchema(db: DatabaseSync): void {
  db.exec(TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA);
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      db.exec("UPDATE automations SET scheduled_run_count=run_count");
    }
  }
  db.exec(indexes);
  // 沿用已裁决的旧重复绑定保留策略，但不再吞掉权限/语法/磁盘等真实 SQL 错误。
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
  if (!duplicate) db.exec(boundIndex);
}

/** 0004 执行域加列：调度器可独立打开 Repo，不能等待项目归属转换，也不能把新列写进上游冻结 schema。 */
function adoptExecutionScopes(db: DatabaseSync): void {
  for (const [table, column] of executionColumns) {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((entry) => entry.name === column)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
}

/** 交接只复用已完成初始化；每个新连接仍按冻结账本确认，替换/清空文件不能假 ready。 */
export function areTasksDatabaseMigrationsApplied(
  db: DatabaseSync,
  scopeOrOptions: TasksDatabaseMigrationScope = "base",
): boolean {
  const scope = resolveMigrationScope(scopeOrOptions);
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
      .get()
  )
    return false;
  for (const migration of prepareMigrations(scope)) {
    const row = db
      .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
      .get(migration.id);
    if (!row) return false;
    if (row.checksum !== migrationChecksum(migration.checksumInput))
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
      });
  }
  return true;
}

/** 只读账本的展示预检，不授权执行；迁移 runner 拿锁后仍复查每一项。 */
export function inspectTasksMigrationKind(
  db: DatabaseSync,
  scopeOrOptions: TasksDatabaseMigrationScope = "base",
): DatabaseMigrationFacts["kind"] {
  const scope = resolveMigrationScope(scopeOrOptions);
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
    .get();
  let pending = false;
  for (const migration of prepareMigrations(scope)) {
    const row = hasLedger
      ? db.prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?").get(migration.id)
      : undefined;
    if (!row) pending = true;
    else if (row.checksum !== migrationChecksum(migration.checksumInput))
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
        migrationId: migration.id,
      });
  }
  if (!pending) return "none";
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get()
    ? "upgrade"
    : "initialize";
}
