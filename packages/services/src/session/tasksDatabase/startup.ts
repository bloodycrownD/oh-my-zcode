import type { DatabaseMigrationFacts } from "@zcode/shared";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  runTasksDatabaseMigrations,
  inspectTasksMigrationKind,
} from "#src/session/tasksDatabase/migrations.js";
import {
  markTasksStorageMigrated,
  markTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("tasks-storage-startup");

type TasksStoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";
const LOCK_WAIT_MS = 60 * 60_000;

/** 由 Host Worker 调用，SQL 和迁移后修复与旧 Repo 共用，只有获取写锁异步等待。 */
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
): Promise<void> {
  // 回调拿到的是当时事实，不共享后续执行会继续递增的内部对象。
  const report = (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) =>
    onProgress(phase, migration ? { ...migration } : undefined);
  report("checking");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let failure: unknown;
  let migration: DatabaseMigrationFacts | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 25");
    db.exec("PRAGMA foreign_keys = ON");
    const deadline = Date.now() + LOCK_WAIT_MS;
    const acquire = async (operation: string | (() => void)) => {
      // 预检前后可分别遇锁；确认迁移后的等待需要重新发布可见状态。
      let waiting = false;
      for (;;) {
        try {
          if (typeof operation === "string") db.exec(operation);
          else operation();
          return;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
          if (Date.now() >= deadline)
            throw Object.assign(new Error("Task storage lock wait expired", { cause: error }), {
              kind: "lock_timeout",
            });
          if (!waiting) {
            waiting = true;
            report("waiting_for_lock", migration);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    await acquire("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    await acquire(() => {
      migration = { kind: inspectTasksMigrationKind(db), executedCount: 0, committedCount: 0 };
    });
    report("checking", migration);
    await acquire("BEGIN IMMEDIATE");
    runTasksDatabaseMigrations(db, { transactionOpen: true, migration, onProgress: report });
    // COMMIT 已成功，先发布事实；后续 close 失败不能把已提交误报为未提交。
    report("maintaining", migration);
  } catch (error) {
    failure = error;
    // 失败事实随原异常交给 Worker，不倒退发布 checking/migrating，也不覆盖首因。
    if (migration && error && typeof error === "object") {
      try {
        Object.assign(error, { startupMigration: { ...migration } });
      } catch {
        /* 不可扩展异常仍保留原错误。 */
      }
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
  markTasksStorageMigrated(path);
  const repos = [new TaskIndexRepo(path, LOCK_WAIT_MS), new AutomationRepo(path, LOCK_WAIT_MS)];
  let preparationFailure: unknown;
  try {
    // 这些是原本就在初始化时执行的修复，不创建新的迁移或改变已有事务边界。
    for (const repo of repos) await repo.ensureReady();
    for (const repo of repos) {
      if (!(repo instanceof TaskIndexRepo)) continue;
      // 崩溃/强杀会留下 task_status=running 的假「运行中」会话；本进程刚启动不可能有本地轮
      // 在跑，所以这里做一次性全量收敛。对账失败只告警、绝不向上抛：它属于附加修复，
      // 一旦阻断存储准备会让整个应用起不来（存储本身已就绪）。
      try {
        const reconciled = await repo.markAllRunningTasksCompleted();
        if (reconciled > 0) {
          logger.info(undefined, `启动对账收敛崩溃遗留 running → completed count=${reconciled}`);
        }
      } catch (error) {
        logger.warn(undefined, "启动期 running 任务对账失败，已跳过（不阻断存储准备）", error);
      }
    }
  } catch (error) {
    preparationFailure = error;
    throw error;
  } finally {
    let closeFailure: unknown;
    for (const repo of repos) {
      try {
        repo.close({ throwOnError: true });
      } catch (error) {
        closeFailure ??= error;
      }
    }
    if (!preparationFailure && closeFailure) throw closeFailure;
  }
  markTasksStoragePrepared(path);
  report("ready", migration);
}
