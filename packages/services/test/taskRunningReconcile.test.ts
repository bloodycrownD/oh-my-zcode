// T-RUN1（v1.0.26）：崩溃遗留的 task_status='running' 必须被对账收敛成 completed。
//
// 事故形状：进程被强杀时最后一次写入停在 task_status='running'；sessions-index 同步器
// 刻意不回放历史终态（zcodeTaskIndexSyncer.processSummary 的 becameTerminal 要求本轮
// 先见到非 running），因此这些任务永远显示「运行中」，实际没有轮在跑。
//
// 两条防线各锁一个用例：
// 1) reconcileStaleRunningTasks：只收敛「权威 summary 已终态」或「已不在 summary 集合」的行，
//    仍在跑的（summary 非终态且仍在集合里）必须原样保留。
// 2) markAllRunningTasksCompleted：进程启动期的一次性全量纠偏。
//
// 运行：node --import tsx --test packages/services/test/taskRunningReconcile.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

const WORKSPACE = "D:\\Dev\\Js\\omz-reconcile-test";

function taskMeta(taskId: string, status: ZCodeTaskMeta["status"]): ZCodeTaskMeta {
  const now = Date.now();
  return {
    createdAt: now,
    mode: "build",
    status,
    taskId,
    title: `task-${taskId}`,
    traceId: `trace-${taskId}` as ZCodeTaskMeta["traceId"],
    updatedAt: now,
    workspacePath: WORKSPACE,
  } as ZCodeTaskMeta;
}

async function withRepo(run: (repo: TaskIndexRepo) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omz-task-reconcile-"));
  const path = join(dir, "tasks-index.sqlite");
  const repo = new TaskIndexRepo(undefined, undefined, path, 1_000);
  try {
    await repo.ensureReady();
    await run(repo);
  } finally {
    try {
      repo.close();
    } catch {
      // Windows 文件锁滞后释放不拖垮断言。
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("T-RUN1 reconcileStaleRunningTasks 只收敛终态或已消失的 running", async () => {
  await withRepo(async (repo) => {
    await repo.seedTaskMetaIfMissing(taskMeta("terminal", "running"));
    await repo.seedTaskMetaIfMissing(taskMeta("vanished", "running"));
    await repo.seedTaskMetaIfMissing(taskMeta("still-live", "running"));

    const changed = await repo.reconcileStaleRunningTasks({
      knownTaskIds: ["terminal", "still-live"],
      terminalTaskIds: ["terminal"],
      workspacePath: WORKSPACE,
    });

    assert.equal(changed, 2, "终态 + 已消失的 running 都应被收敛");
    const byId = new Map(
      (await repo.listTaskMetas({ workspacePath: WORKSPACE })).map((meta) => [meta.taskId, meta]),
    );
    assert.equal(byId.get("terminal")?.status, "completed");
    assert.equal(byId.get("vanished")?.status, "completed");
    assert.equal(byId.get("still-live")?.status, "running", "仍在跑的轮不能被对账误伤");
  });
});

test("T-RUN1 markAllRunningTasksCompleted 启动期全量纠偏", async () => {
  await withRepo(async (repo) => {
    await repo.seedTaskMetaIfMissing(taskMeta("a", "running"));
    await repo.seedTaskMetaIfMissing(taskMeta("b", "running"));
    await repo.seedTaskMetaIfMissing(taskMeta("c", "completed"));

    const changed = await repo.markAllRunningTasksCompleted();
    assert.equal(changed, 2);

    const statuses = new Map(
      (await repo.listTaskMetas({ workspacePath: WORKSPACE })).map((meta) => [
        meta.taskId,
        meta.status,
      ]),
    );
    assert.equal(statuses.get("a"), "completed");
    assert.equal(statuses.get("b"), "completed");
    assert.equal(statuses.get("c"), "completed");
    assert.equal(await repo.markAllRunningTasksCompleted(), 0, "幂等：第二次无 running 可收");
  });
});
