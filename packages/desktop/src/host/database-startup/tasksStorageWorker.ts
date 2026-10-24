import { parentPort, workerData } from "node:worker_threads";
import { tasksStorageWorkerDataSchema } from "./contract.js";
import { createSettingService, prepareTasksIndexStorage } from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@zcode/shared";

const data = tasksStorageWorkerDataSchema.parse(workerData);
try {
  // v1.0.22 事故修复：Worker 必须携带旧设置完成项目迁移，否则后续 Host 只能看到
  // 「账本已写、种子为空」的空项目库（老会话随之全部 project.host-mismatch）。
  const settings = await createSettingService().get();
  await prepareTasksIndexStorage(
    data.path,
    (phase, migration) => parentPort?.postMessage({ type: "progress", phase, migration }),
    settings,
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
