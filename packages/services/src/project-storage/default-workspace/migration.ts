import type { DatabaseSync } from "node:sqlite";
import type { ProjectMigrationContext } from "#src/project-storage/contract.js";

// 原因：旧 settings 的 purpose 缺失/误标会把系统任务目录迁成项目。
// 限定首次迁移创建且未编辑的单 root 自动项目，不能按名称隐藏用户项目或任务。
//
// FORK(upgrade-316) 两套谓词的来源：
// - 上游数据根是 ~/.zcode，其 GLOB 谓词写 .zcode。该常量被 0007_default_workspace_tasks
//   的 sql 字段引用并计入 schema_migration 记账 checksum——真实库已按此字节记账，
//   冻结不改，否则启动即 checksum mismatch。
// - fork 数据根是 ~/.omz（paths.ts:47 getDataBaseDir）。0007 在 fork 库上 GLOB 永不命中、
//   修复静默空转；真正的修复由 0009_repair_default_workspace_predicate 用 omz 谓词重放。
export const DEFAULT_WORKSPACE_CANDIDATES_SQL = `
SELECT p.project_id FROM projects p JOIN project_roots r USING(project_id)
WHERE p.host_id=? AND p.deleted=0 AND p.name_overridden=0
  AND p.updated_at=p.created_at
  AND p.created_at<=(SELECT applied_at FROM schema_migration WHERE id='0005_projects')
  AND (SELECT count(*) FROM project_roots other WHERE other.project_id=p.project_id)=1
  AND replace(r.root_path, char(92), '/') GLOB '*/.zcode/workspace/default'
`;

// FORK(upgrade-316)：omz 品牌口径的谓词（数据根 ~/.omz/workspace/default），
// 仅用于 0009 修复迁移的 sql 与执行体，勿与上面的记账冻结常量合并。
export const DEFAULT_WORKSPACE_CANDIDATES_OMZ_SQL = `
SELECT p.project_id FROM projects p JOIN project_roots r USING(project_id)
WHERE p.host_id=? AND p.deleted=0 AND p.name_overridden=0
  AND p.updated_at=p.created_at
  AND p.created_at<=(SELECT applied_at FROM schema_migration WHERE id='0005_projects')
  AND (SELECT count(*) FROM project_roots other WHERE other.project_id=p.project_id)=1
  AND replace(r.root_path, char(92), '/') GLOB '*/.omz/workspace/default'
`;

export function migrateDefaultWorkspaceTasks(db: DatabaseSync, context: ProjectMigrationContext) {
  const ids = db.prepare(DEFAULT_WORKSPACE_CANDIDATES_OMZ_SQL).all(context.hostId ?? "local");
  const now = (context.now ?? Date.now)();
  for (const { project_id } of ids) {
    // 只交接组织归属；保留归档、置顶、未读、CLI 镜像及已固化的执行目录。
    db.prepare("UPDATE tasks SET project_id=NULL WHERE project_id=? AND host_id=?").run(
      String(project_id),
      context.hostId ?? "local",
    );
    db.prepare("UPDATE projects SET deleted=1,deleted_at=?,updated_at=? WHERE project_id=?").run(
      now,
      now,
      String(project_id),
    );
  }
}
