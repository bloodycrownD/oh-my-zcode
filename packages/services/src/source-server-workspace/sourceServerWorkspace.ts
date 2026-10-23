// 照搬上游 v3.16.2 source-server-workspace/sourceServerWorkspace.ts（upstream-v316-fullsync P7 续批，identity 绑定回执通道契约）。
import type {
  SourceServerResolveWorkspaceRequest,
  SourceServerResolveWorkspaceResult,
  SourceServerMigrationPathAction,
  SourceServerMigrationReport,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISourceServerWorkspaceService {
  resolveWorkspace(
    request: SourceServerResolveWorkspaceRequest,
  ): Promise<SourceServerResolveWorkspaceResult>;
  getFailedPathCount(): Promise<number>;
  getAbandonedPathCount(): Promise<number>;
  listMigrationReports(): Promise<SourceServerMigrationReport>;
  abandonFailedWorkspace(
    request: SourceServerMigrationPathAction,
  ): Promise<SourceServerMigrationReport>;
  retryWorkspaceMigration(
    request: SourceServerMigrationPathAction,
  ): Promise<SourceServerMigrationReport>;
}

export const ISourceServerWorkspaceService = createServiceDescriptor<ISourceServerWorkspaceService>(
  ServiceChannels.SourceServerWorkspace,
);
