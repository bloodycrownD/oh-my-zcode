// T-RUN1（v1.0.26）：崩溃遗留的 task_status='running' 必须被对账收敛成 completed。
//
// 事故形状：进程被强杀时最后一次写入停在 task_status='running'；sessions-index 同步器
// 刻意不回放历史终态（zcodeTaskIndexSyncer.processSummary 的 becameTerminal 要求本轮
// 先见到非 running），因此这些任务永远显示「运行中」，实际没有轮在跑。
//
// 两条防线各锁一个用例：
// 1) reconcileStaleRunningTasks：只收敛「权威 summary 已终态」的行，仍在跑的
//    （summary 非终态）必须原样保留。本仓刻意不把「已不在 summary 集合里」当作收敛
//    依据——首帧快照是否包含 subagent 派生会话没有代码保证，按「已消失」收敛可能误伤
//    正在跑的任务。
// 2) markAllRunningTasksCompleted：进程启动期的一次性全量纠偏。
//
// 运行：pnpm --dir packages/services run test:task-running-reconcile
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
  // v1.0.20 的构造器只有 (startupDbPath, startupBusyTimeoutMs) 两个参数。
  const repo = new TaskIndexRepo(path, 1_000);
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

test("T-RUN1 reconcileStaleRunningTasks 只收敛 summary 已终态的 running", async () => {
  await withRepo(async (repo) => {
    await repo.seedTaskMetaIfMissing(taskMeta("terminal", "running"));
    await repo.seedTaskMetaIfMissing(taskMeta("still-live", "running"));

    const changed = await repo.reconcileStaleRunningTasks({
      terminalTaskIds: ["terminal"],
      workspacePath: WORKSPACE,
    });

    assert.equal(changed, 1, "只有 summary 已终态的 running 应被收敛");
    const byId = new Map(
      (await repo.listTaskMetas({ workspacePath: WORKSPACE })).map((meta) => [meta.taskId, meta]),
    );
    assert.equal(byId.get("terminal")?.status, "completed");
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
