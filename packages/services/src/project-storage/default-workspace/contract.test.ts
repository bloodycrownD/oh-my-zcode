import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fixture, port } from "#src/project-storage/test-fixture.js";
import { reconcileLegacy } from "#src/project-storage/legacy-tasks.js";
import { migrateProjects } from "#src/project-storage/migrate-projects.js";

describe("系统 default 项目纠偏", () => {
  it.each(["renamed", "multi-root", "newer"])("preserves a %s user project", async (scenario) => {
    const path = "/Users/test/.omz/workspace/default";
    const { db, add, context } = await fixture([path]);
    add("kept", path);
    migrateProjects(db, context);
    reconcileLegacy(db);
    db.exec(`CREATE TABLE schema_migration(id TEXT PRIMARY KEY,checksum TEXT,app_version TEXT,applied_at INTEGER);
      INSERT INTO schema_migration VALUES('0005_projects','ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da','3.12.0',10);`);
    const projectId = db.prepare("SELECT project_id FROM tasks").get()!.project_id!;
    if (scenario === "renamed")
      db.exec("UPDATE projects SET name='My project',name_overridden=1,updated_at=11");
    if (scenario === "multi-root")
      db.prepare("INSERT INTO project_roots VALUES(?,'/extra',1,0)").run(projectId);
    if (scenario === "newer") db.exec("UPDATE projects SET created_at=11,updated_at=11");
    await port.migrate(db, context);
    expect(db.prepare("SELECT project_id FROM tasks").get()!.project_id).toBe(projectId);
    expect(db.prepare("SELECT deleted FROM projects").get()!.deleted).toBe(0);
  });
  it.each(["/Users/test/.omz/workspace/default", "C:\\Users\\test\\.omz\\workspace\\default"])(
    "repairs an already migrated %s without changing task facts or other tables",
    async (path) => {
      const { db, add, context } = await fixture([path, "/repos/default"]);
      add("normal", path);
      add("archived", path);
      add("ordinary-default", "/repos/default");
      db.exec("UPDATE tasks SET archived=1,pinned=1,unread_at=7 WHERE task_id='archived'");
      // 真实旧迁移结果：purpose 缺失，系统目录被自动创建为项目。
      migrateProjects(db, context);
      reconcileLegacy(db);
      db.exec(`CREATE TABLE schema_migration(id TEXT PRIMARY KEY,checksum TEXT,app_version TEXT,applied_at INTEGER);
        INSERT INTO schema_migration VALUES('0005_projects','ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da','3.12.0',10);`);
      const originalId = db
        .prepare("SELECT project_id FROM tasks WHERE task_id='normal'")
        .get()!.project_id;
      // 同目录的手建项目不能仅按名称或路径被清理。
      db.prepare(
        "INSERT INTO projects VALUES('manual','local','Manual default',1,5,0,NULL,0,NULL,11,11)",
      ).run();
      db.prepare("INSERT INTO project_roots VALUES('manual',?,0,1)").run(path);
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'schema_migration'")
        .all();
      const hash = (name: string) =>
        createHash("sha256")
          .update(JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()))
          .digest("hex");
      const before = new Map(tables.map(({ name }) => [String(name), hash(String(name))]));
      const facts = () =>
        db
          .prepare("SELECT * FROM tasks ORDER BY task_id")
          .all()
          .map(({ project_id: _project, ...task }) => task);
      const taskFacts = facts();
      expect((await port.migrate(db, context)).applied).toEqual([
        "0007_default_workspace_tasks",
        "0008_initial_workspace_order",
        "0009_repair_default_workspace_predicate",
        "0010_connection_hosts",
        "0011_remote_entry_deleted_cache",
        "0012_session_creation_commands",
      ]);
      expect(
        db.prepare("SELECT project_id FROM tasks WHERE task_id IN ('normal','archived')").all(),
      ).toEqual([{ project_id: null }, { project_id: null }]);
      expect(
        db.prepare("SELECT deleted FROM projects WHERE project_id=?").get(originalId!),
      ).toEqual({ deleted: 1 });
      expect(db.prepare("SELECT deleted FROM projects WHERE project_id='manual'").get()).toEqual({
        deleted: 0,
      });
      expect(
        db.prepare("SELECT project_id FROM tasks WHERE task_id='ordinary-default'").get()!
          .project_id,
      ).not.toBeNull();
      expect(facts()).toEqual(taskFacts);
      // FORK(upgrade-316)：0008 补 initial_position、0011 补 cached_deleted，都只动
      // remote_project_entries 的列形状，不涉及本用例守的 tasks/projects 事实。
      for (const [name, value] of before)
        if (!["tasks", "projects", "remote_project_entries"].includes(name))
          expect(hash(name)).toBe(value);
      expect((await port.migrate(db, context)).applied).toEqual([]);
      expect(facts()).toEqual(taskFacts);
    },
  );
  // FORK(upgrade-316)：守护品牌口径——fork 数据根是 ~/.omz，上游的 ~/.zcode 路径不是
  // fork 系统容器，修复谓词不得把它清理（历史上 .zcode 谓词曾照搬上游，导致真库空转）。
  it("leaves upstream ~/.zcode workspace paths untouched under the omz data root", async () => {
    const path = "/Users/test/.zcode/workspace/default";
    const { db, add, context } = await fixture([path]);
    add("task", path);
    migrateProjects(db, context);
    reconcileLegacy(db);
    db.exec(`CREATE TABLE schema_migration(id TEXT PRIMARY KEY,checksum TEXT,app_version TEXT,applied_at INTEGER);
      INSERT INTO schema_migration VALUES('0005_projects','ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da','3.12.0',10);`);
    const projectId = db.prepare("SELECT project_id FROM tasks").get()!.project_id!;
    await port.migrate(db, context);
    expect(db.prepare("SELECT project_id FROM tasks").get()!.project_id).toBe(projectId);
    expect(db.prepare("SELECT deleted FROM projects").get()!.deleted).toBe(0);
  });
});
