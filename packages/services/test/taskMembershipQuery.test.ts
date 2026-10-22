// T-VS4（upstream-v316-fullsync §phase-vproj-storage Step 12）：membership 语义与
// includeArchived 退役后的协议面编译断。
//
// 锁死四件事：
// 1) membership kind 查询三分支（pinned = pinned=1 AND archived=0 / archived = archived=1 /
//    timeline = pinned=0 AND archived=0）与归档/取消归档迁移的归属变化。
// 2) 协议面：zcodeSessionListParamsSchema 是 strict object 且不含 includeArchived——
//    旧客户端携带该字段必须被拒（「编译断」的运行时等价断言）。
// 3) v4 行级 membership 谓词 matchesTaskListMembershipKind 三分支语义。
// 4) 列表事件词表含 task_archived / task_unarchived（archive/unarchive 广播的 reason 面）。
//
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/taskMembershipQuery.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { taskRealtimeReasonSchema, type ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { zcodeSessionListParamsSchema } from "@zcode/shared";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

async function withTempIndex(
  run: (repo: TaskIndexRepo, workspacePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omz-membership-"));
  const path = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(path);
  try {
    runTasksDatabaseMigrations(db);
    db.close();
    const repo = new TaskIndexRepo(path, 5000);
    await repo.ensureReady();
    await run(repo, join(dir, "workspace-a"));
    repo.close();
  } finally {
    // Windows 下 sqlite 连接刚关闭时文件锁可能滞后释放；清理是 best-effort，不影响断言。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function meta(taskId: string, workspacePath: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: `task-${taskId}`,
    workspacePath,
    createdAt: 1000,
    updatedAt: 2000,
    mode: "build",
    provider: ZCODE_AGENT_PROVIDER,
  };
}

test("T-VS4: membership kind 三分支与归档/取消归档迁移", async () => {
  await withTempIndex(async (repo, workspacePath) => {
    const scopes = [{ workspacePath }];
    await repo.syncTaskMeta({ meta: meta("plain-1", workspacePath) });
    await repo.syncTaskMeta({ meta: meta("pinned-1", workspacePath), pinned: true });
    await repo.syncTaskMeta({ meta: meta("archived-1", workspacePath), archived: true });

    const ids = async (kind: "pinned" | "archived" | "timeline") =>
      (await repo.queryTaskList({ kind, workspaceScopes: scopes, sortBy: "updated" })).items.map(
        (item) => item.taskId,
      );
    assert.deepEqual((await ids("pinned")).sort(), ["pinned-1"]);
    assert.deepEqual((await ids("archived")).sort(), ["archived-1"]);
    assert.deepEqual((await ids("timeline")).sort(), ["plain-1"]);

    // 取消归档：archived 集合收缩，timeline 接纳。
    await repo.updateTaskState({
      workspacePath,
      taskId: "archived-1",
      patch: { archived: false },
    });
    assert.deepEqual(await ids("archived"), []);
    assert.deepEqual((await ids("timeline")).sort(), ["archived-1", "plain-1"]);

    // 归档普通任务：离开 timeline、进入 archived；置顶任务归档后按谓词先落在 archived。
    await repo.updateTaskState({
      workspacePath,
      taskId: "plain-1",
      patch: { archived: true },
    });
    assert.deepEqual((await ids("archived")).sort(), ["plain-1"]);
    // archived-1 已在前面取消归档，仍留 timeline。
    assert.deepEqual(await ids("timeline"), ["archived-1"]);
  });
});

test("T-VS4: 协议面编译断——zcodeSessionListParamsSchema 拒绝 includeArchived", () => {
  assert.equal(
    zcodeSessionListParamsSchema.safeParse({ includeArchived: true }).success,
    false,
    "strict schema 不再认识 includeArchived（字段已随 membership 语义删除）",
  );
  assert.equal(zcodeSessionListParamsSchema.safeParse({}).success, true);
  assert.equal(
    zcodeSessionListParamsSchema.safeParse({ sessionIds: ["s1"], limit: 10 }).success,
    true,
  );
});

test("T-VS4: v4 行级 membership 谓词三分支", () => {
  const kindOf = (pinned: boolean, archived: boolean) =>
    (["pinned", "archived", "timeline", "active"] as const).filter((kind) =>
      matchesTaskListMembershipKind({ pinned, archived }, kind),
    );
  assert.deepEqual(kindOf(true, false), ["pinned", "active"]);
  assert.deepEqual(kindOf(false, true), ["archived"]);
  assert.deepEqual(kindOf(false, false), ["timeline", "active"]);
  // active = 未归档（无论置顶）；置顶且归档的行只属于 archived 分区。
  assert.deepEqual(kindOf(true, true), ["archived"]);
});

test("T-VS4: 列表事件词表含 task_archived / task_unarchived", () => {
  const reasons = taskRealtimeReasonSchema.options;
  for (const reason of ["task_archived", "task_unarchived"] as const) {
    assert.ok(reasons.includes(reason), `事件词表缺少 ${reason}`);
  }
});
