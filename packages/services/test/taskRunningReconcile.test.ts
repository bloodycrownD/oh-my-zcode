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
  // FORK(upgrade-316)：上游 v3.16 把构造签名扩成 (migrationSettings?, storageHostId?,
  // startupDbPath?, busyTimeoutMs)。旧双参写法会把 path 错当 migrationSettings、库路径落空，
  // ensureReady 指向真实用户数据目录并抛 0006 checksum mismatch。路径走第三参。
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

test("T-RUN1 reconcileStaleRunningTasks 只收敛 summary 已终态的 running", async () => {
  await withRepo(async (repo) => {
    // FORK(upgrade-316)：seedTaskMetaIfMissing 已随上游拆分移除；applyCliFacts 是当前
    // 「插入缺失行」的入口（writeRecord 全量写入，status 随 meta），语义等价于种子写入。
    await repo.applyCliFacts({ meta: taskMeta("terminal", "running") });
    await repo.applyCliFacts({ meta: taskMeta("still-live", "running") });

    const changed = await repo.reconcileStaleRunningTasks({
      terminalTaskIds: ["terminal"],
      workspacePath: WORKSPACE,
    });

    assert.equal(changed, 1, "只有 summary 已终态的 running 应被收敛");
    const byId = new Map(
      (await repo.listTaskMetas({ workspacePath: WORKSPACE })).map((meta) => [meta.taskId, meta]),
    );
    assert.equal(byId.get("terminal")?.status, "completed");
    // FORK(upgrade-316)：上游把 status 权威改为 cli_last_outcome 派生，running 不落索引
    // （null = 无终态）。仍活着的轮断言「未被收敛成终态」，不钉死具体非终态值。
    assert.notEqual(byId.get("still-live")?.status, "completed", "仍在跑的轮不能被对账误伤");
  });
});

test("T-RUN1 markAllRunningTasksCompleted 启动期全量纠偏", async () => {
  await withRepo(async (repo) => {
    // FORK(upgrade-316)：c 是终态种子，走 lastOutcome 让上游读约定（cli_last_outcome 派生）
    // 读回 "completed"；a/b 不带终态（running 残留），留给 markAll 收敛。
    await repo.applyCliFacts({ meta: taskMeta("a", "running") });
    await repo.applyCliFacts({ meta: taskMeta("b", "running") });
    await repo.applyCliFacts({ meta: taskMeta("c", "completed"), lastOutcome: "completed" });

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
