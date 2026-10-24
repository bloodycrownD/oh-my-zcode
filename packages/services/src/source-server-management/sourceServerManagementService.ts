/* eslint-disable max-lines -- Source/Profile/迁移三类管理操作共享同一快照、事件代际与错误语义。 */
// 照搬上游 v3.16.2 source-server-management/sourceServerManagementService.ts（backlog-sweep
// Step 7，P9-1）。
//
// omz 落位差异（相对上游）：上游把本文件放在 `packages/desktop/src/host/`，因为 Directory 与
// ConnectionManager 都是 host 类；本仓按 spec 落 `packages/services/src/`，因此这里只依赖
// **结构化端口**（directory / manager 各一组窄接口），由 desktop host 注入具体实例：
// - Directory 端口：持久化权威（profiles/servers/workspaceHistory + 单实体写方法）；
// - Manager 端口：连接状态机所有者（connect/update/disconnect/listStates/日志）。
// 这样 services 不反向 import desktop，契约与 RPC descriptor 也能留在同一个包。
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import type {
  ConnectionProfile,
  RemoteTarget,
  SourceServerConnectionStateSnapshot,
  SourceServerManagementDirectoryDelta,
  SourceServerManagementSnapshot,
  SourceServerManagementSnapshotRequest,
  SourceServerManagementStateDelta,
  SourceServerMigrationReport,
  SourceServerOperationLog,
  SourceServerRecord,
  SourceServerWorkspaceHistoryEntry,
  SourceServerUpdateRequest,
  SourceServerUpdateTarget,
} from "@zcode/shared";
import { getSourceServerUpdateTarget } from "@zcode/shared";
import type { IServiceAccessor } from "../accessor.js";
import { SourceServerMigrationCounts, sumMigrationCounts } from "./sourceServerMigrationCounts.js";
import type {
  ISourceServerManagementService,
  UpdateConnectionProfileInput,
} from "./sourceServerManagement.js";

/** Directory 快照形态与 desktop SourceServerDirectory.snapshot() 完全一致（结构化相容）。 */
export interface SourceServerManagementDirectorySnapshot {
  profiles: ConnectionProfile[];
  servers: SourceServerRecord[];
  workspaceHistory: SourceServerWorkspaceHistoryEntry[];
}

/**
 * Directory 端口。所有写方法都要求 Directory 在持久化成功后才 fire onDidChange；
 * 管理服务不自己伪造目录事件，避免出现「UI 已刷新、磁盘没写」的假成功。
 */
export interface SourceServerManagementDirectoryPort {
  readonly onDidChange: Event<void>;
  snapshot(): Promise<SourceServerManagementDirectorySnapshot>;
  resolveProfileTarget(
    profile: ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }>>;
  renameSource(sourceServerId: string, displayName: string): Promise<void>;
  renameProfile(profileId: string, displayName: string): Promise<void>;
  updateProfile(input: UpdateConnectionProfileInput): Promise<void>;
  setPreferredProfile(sourceServerId: string, profileId: string): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  removeSourceServer(sourceServerId: string): Promise<void>;
  recordConversationWorkspace(sourceServerId: string, workspacePath: string): Promise<void>;
}

/** Manager 端口；与 desktop SourceServerConnectionManager 的公开面结构化相容。 */
export interface SourceServerManagementConnectionPort {
  readonly onDidChangeState: Event<SourceServerConnectionStateSnapshot>;
  readonly onDidAppendOperationLog: Event<SourceServerOperationLog>;
  connect(input: {
    profile: Pick<ConnectionProfile, "profileId" | "transport" | "sourceServerId">;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    membershipIntent: "add" | "retain";
    allowInstall: boolean;
    confirmIdentityChange?: boolean;
  }): Promise<unknown>;
  updateServer(input: {
    profile: Pick<ConnectionProfile, "profileId" | "transport" | "sourceServerId">;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
  }): Promise<unknown>;
  disconnect(sourceServerId: string): void;
  removeProfile(profileId: string): void;
  listStates(): SourceServerConnectionStateSnapshot[];
  getOnlineConnection(sourceServerId: string):
    | {
        services: Pick<IServiceAccessor, "fileService" | "sourceServerWorkspaceService">;
      }
    | undefined;
  getRecentOperationLogs(profile: {
    profileId: string;
    sourceServerId?: string;
  }): SourceServerOperationLog[];
}

export interface CreateSourceServerManagementServiceOptions {
  directory: SourceServerManagementDirectoryPort;
  manager: SourceServerManagementConnectionPort;
  /**
   * 删除设备前的回调（backlog-sweep Step 8）：先撤 hosts 行与 source-settings attachment，
   * 再落 Directory 删除。抛错即中止删除——删除是不可逆操作，不能出现「远端设备已消失、
   * 本机 host 行还在」的半删状态。
   */
  onBeforeSourceServerRemoved?: (sourceServerId: string) => Promise<void>;
  now?: () => number;
  logWarn?: (message: string, error: Error) => void;
}

/** 管理服务实例额外持有事件订阅的释放面；RPC 面不暴露 dispose。 */
export interface SourceServerManagementService extends ISourceServerManagementService {
  dispose(): void;
}

const CONNECTION_UNAVAILABLE = "source-server.not-online";
const MIGRATION_UNAVAILABLE = "source-server.migration-unavailable";
const UPDATE_TARGET_CHANGED = "source-server.update-target-changed";

function requireActiveProfile(
  snapshot: SourceServerManagementDirectorySnapshot,
  profileId: string,
): ConnectionProfile {
  const profile = snapshot.profiles.find((item) => item.profileId === profileId);
  if (!profile) throw new Error(`Unknown Connection Profile: ${profileId}`);
  if (profile.lifecycleState === "retired")
    throw new Error(`Connection Profile is retired: ${profileId}`);
  return profile;
}

/** 只传 Manager 需要的三字段：凭据与展示名由 Directory/Manager 各自持有。 */
function toConnectProfile(profile: ConnectionProfile) {
  return {
    profileId: profile.profileId,
    transport: profile.transport,
    ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
  };
}

/**
 * 把持久化 target 归一成可比较的更新目标；WSL 线路未填全时归一失败，
 * 与 `isSameSourceServerUpdateTarget` 的 false 语义一致（一律按「目标已变化」处理）。
 */
function normalizedUpdateTarget(profile: ConnectionProfile): SourceServerUpdateTarget | undefined {
  const target = profile.target;
  try {
    switch (target.kind) {
      case "ssh":
        return getSourceServerUpdateTarget({
          kind: "ssh",
          host: target.host,
          port: target.port,
          username: target.username,
          ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        });
      case "wsl":
        return getSourceServerUpdateTarget({
          kind: "wsl",
          distro: target.distro,
          user: target.user,
        });
      case "docker":
        return getSourceServerUpdateTarget({ kind: "docker", container: target.container });
    }
  } catch {
    return undefined;
  }
}

class SourceServerManagementServiceImpl implements SourceServerManagementService {
  private generation = 0;
  private readonly stateEmitter = new Emitter<SourceServerManagementStateDelta>();
  private readonly directoryEmitter = new Emitter<SourceServerManagementDirectoryDelta>();
  private readonly counts: SourceServerMigrationCounts;
  private readonly subscriptions: IDisposable[];

  public readonly onDidChangeState: Event<SourceServerManagementStateDelta> =
    this.stateEmitter.event;
  public readonly onDidChangeDirectory: Event<SourceServerManagementDirectoryDelta> =
    this.directoryEmitter.event;
  public readonly onDidAppendOperationLog: Event<SourceServerOperationLog>;

  public constructor(private readonly options: CreateSourceServerManagementServiceOptions) {
    this.onDidAppendOperationLog = options.manager.onDidAppendOperationLog;
    this.counts = new SourceServerMigrationCounts({
      readCounts: async (sourceServerId) => {
        const workspaceService =
          options.manager.getOnlineConnection(sourceServerId)?.services
            .sourceServerWorkspaceService;
        if (!workspaceService) return { status: "requires-connection" };
        const [failedPathCount, abandonedPathCount] = await Promise.all([
          workspaceService.getFailedPathCount(),
          workspaceService.getAbandonedPathCount(),
        ]);
        return { status: "available", failedPathCount, abandonedPathCount };
      },
      onDidChange: () => this.publishDirectoryChange(),
      ...(options.logWarn ? { logWarn: options.logWarn } : {}),
    });
    this.subscriptions = [
      options.manager.onDidChangeState((state) => {
        this.generation += 1;
        this.stateEmitter.fire({ generation: this.generation, state });
      }),
      options.directory.onDidChange(() => {
        this.publishDirectoryChange();
      }),
    ];
  }

  public async getSnapshot(
    request?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot> {
    const directory = await this.options.directory.snapshot();
    const migrationCounts = this.counts.read(
      directory.servers.map((server) => server.sourceServerId),
      { refresh: request?.refreshMigrationCounts === true },
    );
    return {
      generation: this.generation,
      profiles: directory.profiles,
      servers: directory.servers,
      workspaceHistory: directory.workspaceHistory,
      states: this.options.manager.listStates(),
      ...sumMigrationCounts(migrationCounts),
      migrationCounts,
    };
  }

  public async getRecentOperationLogs(profileId: string): Promise<SourceServerOperationLog[]> {
    const directory = await this.options.directory.snapshot();
    const profile = directory.profiles.find((item) => item.profileId === profileId);
    return this.options.manager.getRecentOperationLogs({
      profileId,
      ...(profile?.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
    });
  }

  public async connectProfile(
    profileId: string,
    options: { retainedOnly?: boolean } = {},
  ): Promise<SourceServerManagementSnapshot> {
    const profile = requireActiveProfile(await this.options.directory.snapshot(), profileId);
    const target = await this.options.directory.resolveProfileTarget(profile);
    const retainedOnly = options.retainedOnly === true;
    await this.options.manager.connect({
      profile: toConnectProfile(profile),
      target,
      // 设置页「连接」是显式新增成员；项目入口的 retainedOnly 只恢复既有成员。
      membershipIntent: retainedOnly ? "retain" : "add",
      allowInstall: !retainedOnly,
    });
    return await this.getSnapshot();
  }

  public async confirmIdentityChange(profileId: string): Promise<SourceServerManagementSnapshot> {
    const profile = requireActiveProfile(await this.options.directory.snapshot(), profileId);
    const target = await this.options.directory.resolveProfileTarget(profile);
    await this.options.manager.connect({
      profile: toConnectProfile(profile),
      target,
      membershipIntent: "add",
      allowInstall: true,
      confirmIdentityChange: true,
    });
    return await this.getSnapshot();
  }

  public async disconnectSource(sourceServerId: string): Promise<SourceServerManagementSnapshot> {
    this.options.manager.disconnect(sourceServerId);
    return await this.getSnapshot();
  }

  public async ensureConversationWorkspace(sourceServerId: string) {
    const fileService =
      this.options.manager.getOnlineConnection(sourceServerId)?.services.fileService;
    if (!fileService) throw new Error(CONNECTION_UNAVAILABLE);
    const result = await fileService.ensureConversationWorkspace();
    // conversation backing workspace 只属于设备级 canonical path；Directory 在同一事务里
    // 清掉同 Source/path 的 strict project history。
    await this.options.directory.recordConversationWorkspace(sourceServerId, result.path);
    return result;
  }

  public async updateSource(
    input: SourceServerUpdateRequest,
  ): Promise<SourceServerManagementSnapshot> {
    const profile = requireActiveProfile(await this.options.directory.snapshot(), input.profileId);
    if (input.expectedTarget) {
      // 快照与点击之间用户可能改过线路；按已编辑目标更新会把凭据发给另一个设备。
      const current = normalizedUpdateTarget(profile);
      if (!current || JSON.stringify(current) !== JSON.stringify(input.expectedTarget))
        throw new Error(UPDATE_TARGET_CHANGED);
    }
    const target = await this.options.directory.resolveProfileTarget(profile);
    await this.options.manager.updateServer({
      profile: toConnectProfile(profile),
      target,
      force: input.force === true,
    });
    return await this.getSnapshot();
  }

  public async renameSource(
    sourceServerId: string,
    displayName: string,
  ): Promise<SourceServerManagementSnapshot> {
    await this.options.directory.renameSource(sourceServerId, displayName);
    return await this.getSnapshot();
  }

  public async renameProfile(
    profileId: string,
    displayName: string,
  ): Promise<SourceServerManagementSnapshot> {
    await this.options.directory.renameProfile(profileId, displayName);
    return await this.getSnapshot();
  }

  public async updateProfile(
    input: UpdateConnectionProfileInput,
  ): Promise<SourceServerManagementSnapshot> {
    await this.options.directory.updateProfile(input);
    return await this.getSnapshot();
  }

  public async setPreferredProfile(
    sourceServerId: string,
    profileId: string,
  ): Promise<SourceServerManagementSnapshot> {
    await this.options.directory.setPreferredProfile(sourceServerId, profileId);
    return await this.getSnapshot();
  }

  public async removeProfile(profileId: string): Promise<SourceServerManagementSnapshot> {
    // 先停连接与在途 flight，再从目录删除：反序会让 Manager 在删除后仍持有旧线路的凭据。
    this.options.manager.removeProfile(profileId);
    await this.options.directory.removeProfile(profileId);
    return await this.getSnapshot();
  }

  public async removeSourceServer(sourceServerId: string): Promise<SourceServerManagementSnapshot> {
    await this.options.onBeforeSourceServerRemoved?.(sourceServerId);
    this.options.manager.disconnect(sourceServerId);
    await this.options.directory.removeSourceServer(sourceServerId);
    return await this.getSnapshot();
  }

  public async getMigrationReport(sourceServerId: string): Promise<SourceServerMigrationReport> {
    return await this.requireWorkspaceService(sourceServerId).listMigrationReports();
  }

  public async exportMigrationReport(sourceServerId: string): Promise<string> {
    // 导出给客服/诊断工具粘贴使用：纯 JSON 文本，不额外包装时间戳等易读噪音。
    return JSON.stringify(await this.getMigrationReport(sourceServerId), null, 2);
  }

  public async abandonWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport> {
    return await this.requireWorkspaceService(sourceServerId).abandonFailedWorkspace({
      workspacePath,
      migrationId,
    });
  }

  public async retryWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport> {
    return await this.requireWorkspaceService(sourceServerId).retryWorkspaceMigration({
      workspacePath,
      migrationId,
    });
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.counts.dispose();
    this.stateEmitter.dispose();
    this.directoryEmitter.dispose();
  }

  private requireWorkspaceService(sourceServerId: string) {
    const workspaceService =
      this.options.manager.getOnlineConnection(sourceServerId)?.services
        .sourceServerWorkspaceService;
    // 旧 Source（未升级 wire）没有迁移通道：显式拒绝，不能伪造空报告骗过设置页。
    if (!workspaceService) throw new Error(MIGRATION_UNAVAILABLE);
    return workspaceService;
  }

  private publishDirectoryChange(): void {
    this.generation += 1;
    this.directoryEmitter.fire({ generation: this.generation });
  }
}

export function createSourceServerManagementService(
  options: CreateSourceServerManagementServiceOptions,
): SourceServerManagementService {
  return new SourceServerManagementServiceImpl(options);
}
