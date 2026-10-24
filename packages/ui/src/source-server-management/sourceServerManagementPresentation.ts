// 照搬上游 v3.16.2 settings/sourceServerManagementPresentation.ts（33L，backlog-sweep Step 9）。
// 迁移报告的状态/阶段 → i18n 键映射唯一维护点。
import type { SourceServerMigrationReportRow } from "@zcode/shared";

const SOURCE_MIGRATION_STATUS_MESSAGE_IDS = {
  running: "settings.source.migrationStatus.running",
  completed: "settings.source.migrationStatus.completed",
  failed: "settings.source.migrationStatus.failed",
  abandoned: "settings.source.migrationStatus.abandoned",
  "abandoned-diverged": "settings.source.migrationStatus.abandonedDiverged",
} as const satisfies Record<SourceServerMigrationReportRow["status"], string>;

const SOURCE_MIGRATION_PHASE_MESSAGE_IDS = {
  preflight: "settings.source.migrationPhase.preflight",
  "backups-created": "settings.source.migrationPhase.backupsCreated",
  "task-db-merged": "settings.source.migrationPhase.taskDbMerged",
  "session-db-merged": "settings.source.migrationPhase.sessionDbMerged",
  "config-dirs-merged": "settings.source.migrationPhase.configDirsMerged",
  "alias-published": "settings.source.migrationPhase.aliasPublished",
  completed: "settings.source.migrationPhase.completed",
} as const;

export function getSourceMigrationStatusMessageId(
  status: SourceServerMigrationReportRow["status"],
): string {
  return SOURCE_MIGRATION_STATUS_MESSAGE_IDS[status];
}

export function getSourceMigrationPhaseMessageId(phase: string): string | null {
  return (
    SOURCE_MIGRATION_PHASE_MESSAGE_IDS[phase as keyof typeof SOURCE_MIGRATION_PHASE_MESSAGE_IDS] ??
    null
  );
}
