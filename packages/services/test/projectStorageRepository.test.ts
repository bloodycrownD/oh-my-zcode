// T-VS2（upstream-v316-fullsync §phase-vproj-storage Step 10）：ProjectRepository CRUD 与
// ProjectTree 装配关键路径（自上游 22 个 services 测试按 omz 形态精简重写，非全量）。
//
// 锁死的路径：
// 1) 建链：tasksDatabase 迁移 → projectStorage.migrate（hosts/projects/project_roots/
//    remote_project_entries + tasks 的 cli_* / 项目列）。
// 2) 项目 CRUD：saveProject 唯一命名与 roots 落库；initializeProjectRoot 空项目首 root；
//    deleteProject 软删（readTree 默认排除、includeDeleted 可见）；reorderProjects。
// 3) 任务装配：TaskIndexRepo 行经 admitTaskIdentity 补 CLI 事实后进入 readTree 的 tasks
//    投影（provider 边界 + projectId/hostId/pinned/archived），archiveInactive 按
//    cli_updated_at 归档且排除 activeTasks。
// 4) 会话目录：reserveCreatedTask 预留归属 + resolveSessionDirectories 读回一致。
//
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/projectStorageRepository.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { generateTraceId, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { projectStorage } from "../src/project-storage/index.js";
import type { ProjectTaskRef } from "../src/project-storage/contract.js";

async function withTempWorkspace(
  run: (context: {
    dir: string;
    db: DatabaseSync;
    repo: ReturnType<typeof projectStorage.repository>;
    indexRepo: TaskIndexRepo;
  }) => Promise<void>,
  seed?: (indexRepo: TaskIndexRepo, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omz-project-storage-"));
  const db = new DatabaseSync(join(dir, "tasks-index.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    runTasksDatabaseMigrations(db);
    // CLI 事实行必须在项目迁移之前存在：0005 的 reconcileLegacy 只为 host_id IS NULL 的
    // 存量行一次性补写 cli_* 镜像，之后的行走 admitTaskIdentity（不再生成 CLI 事实）。
    const indexRepo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"), 5000);
    await indexRepo.ensureReady();
    await seed?.(indexRepo, dir);
    indexRepo.close();
    const migrated = await projectStorage.migrate(db, {
      backupDirectories: [dir],
    });
    assert.deepEqual(migrated.applied, [
      "0005_projects",
      "0006_default_workspace_tasks",
      "0007_initial_workspace_order",
    ]);
    await run({ dir, db, repo: projectStorage.repository(db), indexRepo });
  } finally {
    db.close();
    // Windows 下 sqlite 连接刚关闭时文件锁可能滞后释放；清理是 best-effort，不影响断言。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function seedMeta(ref: ProjectTaskRef, updatedAt: number) {
  return {
    taskId: ref.taskId,
    traceId: generateTraceId(ref.taskId),
    title: `task-${ref.taskId}`,
    workspacePath: ref.workspacePath,
    workspaceIdentity: ref.workspaceIdentity,
    createdAt: updatedAt - 1000,
    updatedAt,
    mode: "build" as const,
    provider: ZCODE_AGENT_PROVIDER,
  };
}

test("T-VS2: 项目 CRUD 与 ProjectTree 装配（唯一命名/软删/重排）", async () => {
  await withTempWorkspace(async ({ dir, repo }) => {
    const saved = repo.saveProject({ roots: [join(dir, "alpha"), join(dir, "beta")] });
    assert.equal(saved.hostId, "local");
    assert.deepEqual(
      saved.roots.map((root) => root.rootPath),
      [join(dir, "alpha"), join(dir, "beta")],
    );
    assert.equal(saved.roots[0]?.isPrimary, true);

    // 同名去重：第二个同名项目获得后缀名。
    const renamed = repo.saveProject({ roots: [join(dir, "alpha")] });
    assert.equal(renamed.name, `${saved.name} (2)`);

    // 空项目首 root：写入事务内原子初始化，且不改已有 roots。
    const empty = repo.saveProject({ name: "empty-shell", roots: [] });
    const initialized = repo.initializeProjectRoot(empty.id, join(dir, "shell-root"));
    assert.deepEqual(
      initialized.roots.map((root) => root.rootPath),
      [join(dir, "shell-root")],
    );

    // 软删：默认树排除，includeDeleted 可见；恢复需同 roots。
    repo.deleteProject(renamed.id);
    const visible = repo.readTree().projects.map((project) => project.id);
    assert.ok(!visible.includes(renamed.id));
    const restored = repo.saveProject({
      restoreProjectId: renamed.id,
      roots: [join(dir, "alpha")],
    });
    assert.equal(restored.id, renamed.id);

    // 重排：按给定顺序落 position；未列入的行保留原 position（restore 行是负位排前），
    // 因此全量重排后断言精确顺序。
    repo.reorderProjects([empty.id, saved.id, restored.id]);
    const ordered = repo.readTree().projects;
    assert.deepEqual(
      ordered.map((project) => project.id),
      [empty.id, saved.id, restored.id],
    );
  });
});

test("T-VS2: 任务装配与自动归档——CLI 事实行进入 readTree，archiveInactive 排除 activeTasks", async () => {
  await withTempWorkspace(
    async ({ dir, repo }) => {
      const workspace = join(dir, "workspace-a");
      const stale: ProjectTaskRef = { workspacePath: workspace, taskId: "stale-1" };
      const fresh: ProjectTaskRef = { workspacePath: workspace, taskId: "fresh-1" };

      // 无匹配项目的历史任务保持 NULL 归属，readTree 的 tasks 仍可投影（组织态为最终合法态）。
      const tree = repo.readTree();
      assert.deepEqual(tree.projects, []);
      const seeded = tree.tasks.find((task) => task.taskId === stale.taskId);
      assert.ok(seeded, "CLI 事实行必须进入项目树任务投影");
      assert.equal(seeded.projectId, null);
      assert.equal(seeded.hostId, "local");
      assert.equal(seeded.archived, false);

      // 归档：stale 与 fresh 都在 cutoff 之前，但 stale 在 activeTasks 保护面内不归档，
      // fresh 被归档——activeTasks（运行中会话观察面）优先于时间判据。
      const archived = repo.archiveInactive({
        cutoff: 2_000,
        activeTasks: [stale],
      });
      assert.deepEqual(
        archived.map((ref) => ref.taskId),
        [fresh.taskId],
      );
      const after = repo.readTree().tasks;
      assert.equal(after.find((task) => task.taskId === stale.taskId)?.archived, false);
      assert.equal(after.find((task) => task.taskId === fresh.taskId)?.archived, true);
    },
    async (indexRepo, dir) => {
      const workspace = join(dir, "workspace-a");
      await indexRepo.syncTaskMeta({
        meta: seedMeta({ workspacePath: workspace, taskId: "stale-1" }, 1_000),
      });
      // fresh 也在 cutoff 之前，但会被 activeTasks 保护（activeTasks = 排除面）。
      await indexRepo.syncTaskMeta({
        meta: seedMeta({ workspacePath: workspace, taskId: "fresh-1" }, 1_500),
      });
    },
  );
});

test("T-VS2: reserveCreatedTask 预留归属与 resolveSessionDirectories 读回一致", async () => {
  await withTempWorkspace(async ({ dir, repo }) => {
    const project = repo.saveProject({ roots: [join(dir, "proj-root")] });
    const ref: ProjectTaskRef = {
      workspacePath: join(dir, "proj-root"),
      taskId: "reserved-1",
    };
    const directories = repo.reserveCreatedTask({
      task: ref,
      projectId: project.id,
      additionalDirectories: [join(dir, "extra-lib")],
    });
    assert.equal(directories.projectId, project.id);
    assert.deepEqual(directories.additionalDirectories, [join(dir, "extra-lib")]);

    const resolved = repo.resolveSessionDirectories(ref);
    assert.equal(resolved.workspacePath, join(dir, "proj-root"));
    assert.equal(resolved.projectId, project.id);
    // 执行快照不可变：恢复读取首次预留值，不随项目 roots 变化。
    repo.saveProject({ id: project.id, roots: [join(dir, "proj-root"), join(dir, "new-root")] });
    assert.deepEqual(repo.resolveSessionDirectories(ref).additionalDirectories, [
      join(dir, "extra-lib"),
    ]);

    // 缺 root 移动必须显式确认：目标项目的 roots 不含任务 cwd 时，未确认即拒绝。
    const other = repo.saveProject({ roots: [join(dir, "other-root")] });
    assert.throws(() => repo.moveTask({ task: ref, projectId: other.id }), {
      message: "project.root-confirmation-required",
    });
    repo.moveTask({ task: ref, projectId: other.id, addMissingRoot: true });
    assert.equal(repo.resolveSessionDirectories(ref).projectId, other.id);
  });
});
