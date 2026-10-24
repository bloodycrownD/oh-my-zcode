// 照搬上游 v3.16.2 settings/sourceServerManagementPresentation.ts（33L，backlog-sweep Step 9）。
// 迁移报告的状态/阶段 → i18n 键映射唯一维护点；另含后台连接进度的 scope 回填。
import type {
  RemoteTarget,
  SourceServerManagementSnapshot,
  SourceServerMigrationReportRow,
} from "@zcode/shared";
import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";

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

interface RemoteConnectionProgressScope {
  sourceServerId?: string;
  profileId?: string;
}

/**
 * 向导发布的后台进度可能只带目标（用户从空态/项目入口新连，尚未落 Profile id）。
 * 面板用快照按目标回填 scope，横幅才会落到对应设备卡/未绑定连接行，而不是一律挤进
 * 顶部「未完成的连接」区；已带 id 的发布直接透传，不做额外推断。
 */
export function resolveRemoteConnectionProgressScope(
  progress:
    | { sourceServerId?: string; profileId?: string; target?: RemoteTarget | null }
    | null
    | undefined,
  snapshot: Pick<SourceServerManagementSnapshot, "profiles"> | null | undefined,
): RemoteConnectionProgressScope {
  if (!progress) return {};
  const profileById = progress.profileId
    ? snapshot?.profiles.find((profile) => profile.profileId === progress.profileId)
    : undefined;
  const matchedProfiles = progress.target
    ? (snapshot?.profiles.filter((profile) =>
        profileMatchesRemoteTarget(profile, progress.target!),
      ) ?? [])
    : [];
  const matchedProfile =
    profileById ??
    matchedProfiles.find((profile) => profile.lifecycleState !== "retired") ??
    matchedProfiles[0];
  return {
    sourceServerId: progress.sourceServerId ?? matchedProfile?.sourceServerId,
    profileId: progress.profileId ?? matchedProfile?.profileId,
  };
}
