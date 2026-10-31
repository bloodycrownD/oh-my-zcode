/* eslint-disable max-lines -- 远程 workspace 服务注册需集中维护，以保持依赖注入顺序 */
import {
  ServiceCollection,
  IFileService,
  IGenUiService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IBotsService,
  IFileWatcherService,
  IModelSelectionService,
  IProviderSettingsService,
  ISourceServerWorkspaceService,
  IUsageStatsService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  IPromptAttachmentTransferService,
  type ServiceDescriptor,
  type IServiceAccessor,
} from "@zcode/services";
import {
  createLegacySingleRootProjectService,
  createRemoteProjectService,
  createServiceLogger,
  createSettingService,
} from "@zcode/services/node";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type ZCodeSessionRuntimePreferencesResult,
} from "@zcode/shared";
import type { RemoteTarget } from "@zcode/shared";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

// fork 移除了官方账号（OAuth）、coding plan 计费与 conversation share 云端链路，
// 因此这里只登记桌面 Host 仍会转发/自建的 channel。契约版本与上游保持同号。
// TODO(upgrade-316): 上游新增的 remoteWorkspaceRpcContract.ts 仍把
// conversationShareService / oauthService / codingPlanSubscriptionService 列为必需 channel，
// 而 fork 的 IServiceAccessor 已无这些通道；本文件因此改为用上面的 registrations 清单做双向校验。
// 共享契约文件需要同步裁剪（不在本分片范围内）。
export const REMOTE_WORKSPACE_RPC_CONTRACT_VERSION = 1 as const;

/**
 * 全转发集合必须与真实注册逐项一致：Host 只做 RPC 转接，
 * 漏注册会让远端调用在二次暴露时变成 Unknown channel。
 */
export const REMOTE_WORKSPACE_RPC_REGISTRATIONS = [
  ["fileService", IFileService],
  ["genUiService", IGenUiService],
  ["mediaPreviewService", IMediaPreviewService],
  ["gitService", IGitService],
  ["gitCheckpointService", IGitCheckpointService],
  ["systemService", ISystemService],
  ["terminalService", ITerminalService],
  ["settingService", ISettingService],
  ["onboardingRecordService", IOnboardingRecordService],
  ["credentialService", ICredentialService],
  ["broadcastService", IBroadcastService],
  ["zcodeTaskService", IZCodeTaskService],
  ["zcodeAgentService", IZCodeAgentService],
  ["zcodeSessionService", IZCodeSessionService],
  ["botsService", IBotsService],
  ["fileWatcherService", IFileWatcherService],
  ["providerSettingsService", IProviderSettingsService],
  ["modelSelectionService", IModelSelectionService],
  ["sourceServerWorkspaceService", ISourceServerWorkspaceService],
  ["usageStatsService", IUsageStatsService],
  ["clientScenesService", IClientScenesService],
  ["skillsService", ISkillsService],
  ["skillSyncService", ISkillSyncService],
  ["mcpSyncService", IMcpSyncService],
  ["pluginSyncService", IPluginSyncService],
  ["pluginsService", IPluginsService],
  ["pluginManagementService", IPluginManagementService],
  ["subagentsService", ISubagentsService],
  ["commandsService", ICommandsService],
  ["hooksService", IHooksService],
  ["memoryService", IMemoryService],
  ["outputStyleService", IOutputStyleService],
  ["settingsSyncService", ISettingsSyncService],
  ["promptAttachmentTransferService", IPromptAttachmentTransferService],
] as const satisfies readonly [keyof IServiceAccessor, ServiceDescriptor<unknown>][];

type RemoteWorkspaceRpcContract = {
  readonly [K in (typeof REMOTE_WORKSPACE_RPC_REGISTRATIONS)[number][0]]: NonNullable<
    IServiceAccessor[K]
  >;
};

function assertRemoteWorkspaceRpcContract(
  value: Partial<IServiceAccessor>,
): asserts value is Partial<IServiceAccessor> & RemoteWorkspaceRpcContract {
  const missing = REMOTE_WORKSPACE_RPC_REGISTRATIONS.filter(([channel]) => {
    const service = value[channel];
    return (typeof service !== "object" || service === null) && typeof service !== "function";
  }).map(([channel]) => channel);
  if (missing.length > 0) {
    throw new Error(
      `Remote workspace RPC v${REMOTE_WORKSPACE_RPC_CONTRACT_VERSION} channel 不完整: ${missing.join(", ")}`,
    );
  }
}

const runtimePreferencesLogger = createServiceLogger("remote-runtime-preferences");

/**
 * desktop-attached remote 的 Agent 运行在远端（serviceAuthorityMode=desktop-attached-remote），
 * 运行期偏好由 desktop 侧裁决：CLI 通过 dynamic event 把请求回传给窗口 Host。
 * 上游 3.16.2 的 Source Server 重构没有带走这段桥，fork 侧继续保留，否则远端会话
 * 的 memory/search/shell 偏好只能等 CLI 侧 15s 超时后回退默认值。
 *
 * TODO(upgrade-316): 上游重写远程装配后不再有桌面侧 runtime-preferences 应答方；
 * 先按 fork 保留（应答方=窗口 Host），需人工确认上游是否已把该职责迁到别处。
 */
function attachRemoteRuntimePreferencesBridge(params: {
  zcodeAgentService: IZCodeAgentService;
  settingService: ISettingService;
}): void {
  params.zcodeAgentService.onDynamicSessionRuntimePreferencesRequest()((request) => {
    const startedAt = Date.now();
    const requestContext = {
      event: "zcode_protocol.runtime_preferences.host_request_received",
      module: "desktop.host.remote_workspace",
      requestId: request.requestId,
      scope: request.scope,
      sessionId: request.sessionId,
    };
    // 诊断：Agent 侧超时只能说明没有拿到响应；这里记录 Host 是否收到请求，
    // 用“收到但无 response”区分 transport 丢包和设置读取卡住。
    runtimePreferencesLogger.info(
      undefined,
      "runtime preferences host request received",
      requestContext,
    );
    void (async () => {
      const trackStage = <T>(stage: string, promise: Promise<T>): Promise<T> => {
        const stageStartedAt = Date.now();
        return promise.then(
          (value) => {
            runtimePreferencesLogger.debug(
              undefined,
              "runtime preferences host stage completed",
              {
                ...requestContext,
                durationMs: Math.max(0, Date.now() - stageStartedAt),
                stage,
              },
            );
            return value;
          },
          (error: unknown) => {
            runtimePreferencesLogger.warn(undefined, "runtime preferences host stage failed", {
              ...requestContext,
              durationMs: Math.max(0, Date.now() - stageStartedAt),
              error: error instanceof Error ? error.message : String(error),
              stage,
            });
            throw error;
          },
        );
      };
      let resolution:
        | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
        | { status: "failed"; message: string };
      try {
        // 与本地 Host 同源：固定预算不依赖配置网关，远程/手机偏好响应不再串行等待网络。
        const settings = await trackStage("settings", params.settingService.get());
        const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
        resolution = {
          status: "resolved",
          preferences: {
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
            toolSearchMode: settings.toolSearchMode ?? "off",
            memoryEnabled: settings.memoryEnabled === true,
            modelContextBudgetStrategy,
            // remote workspace 与本地 Host 保持同一 scope 边界，首次执行不得再次等待 client config。
            ...(request.scope === "user-execution" && settings.integratedTerminalShell
              ? { integratedTerminalShell: settings.integratedTerminalShell }
              : {}),
          },
        };
      } catch (error) {
        resolution = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
        runtimePreferencesLogger.warn(undefined, "runtime preferences host resolution failed", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: resolution.message,
        });
      }
      // 只把设置读取失败编码为 -32603；发送失败交给最终 catch 记录，不能重试同一请求。
      await params.zcodeAgentService.respondSessionRuntimePreferences({
        requestId: request.requestId,
        resolution,
      });
      runtimePreferencesLogger.info(undefined, "runtime preferences host response sent", {
        ...requestContext,
        durationMs: Math.max(0, Date.now() - startedAt),
        resolutionStatus: resolution.status,
      });
    })().catch((error: unknown) => {
      runtimePreferencesLogger.warn(undefined, "runtime preferences host response failed", {
        ...requestContext,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

export function resolveServerProjectService(params: {
  connectionServices: IServiceAccessor;
  serverId: string;
  virtualProjects?: boolean;
  sourceServices?: ServiceCollection;
}): IProjectService {
  if (params.virtualProjects) {
    if (!params.connectionServices.projectService)
      throw new Error("Remote virtual-project RPC registration incomplete");
    return params.connectionServices.projectService;
  }
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: params.serverId, workspacePath: "/" }),
  )!;
  return createLegacySingleRootProjectService({
    hostId,
    directories: {
      info: () => params.connectionServices.systemService.info(),
      read: (input) => params.connectionServices.fileService.readdir(input),
    },
    readSettings: () => params.connectionServices.settingService.get(),
    readKnownWorkspaces: async () => {
      const directory = await params.sourceServices
        ?.getOptional(IRemoteProjectService)
        ?.readDirectory();
      return (directory?.entries ?? [])
        .filter((entry) => entry.hostId === hostId)
        .flatMap((entry) =>
          entry.roots.length
            ? entry.roots.map((root) => ({ workspacePath: root.rootPath }))
            : entry.legacyWorkspace
              ? [
                  {
                    workspacePath: entry.legacyWorkspace.workspacePath,
                    workspacePurpose: entry.legacyWorkspace.workspacePurpose,
                  },
                ]
              : [],
        );
    },
    readTasks: ({ workspacePath, kind }) => {
      const tasks = params.connectionServices.zcodeTaskService;
      const scope = { workspacePath };
      return kind === "pinned"
        ? tasks.listPinnedTasks(scope)
        : kind === "archived"
          ? tasks.listArchivedTasks(scope)
          : tasks.listTasks(scope);
    },
    ensureConversation: async () =>
      (await params.connectionServices.fileService.ensureConversationWorkspace()).path,
  });
}

export function createServerRemoteWorkspaceServiceCollection(params: {
  connectionServices: IServiceAccessor;
  virtualProjects?: boolean;
  serverId?: string;
  targetKind: RemoteTarget["kind"];
  /** 本机 Local Host 服务；提供 Provider Provisioning Source，缺失时 Provisioning 按 unsupported 处理。 */
  sourceServices?: ServiceCollection;
}): ServiceCollection {
  assertRemoteWorkspaceRpcContract(params.connectionServices);
  // Server remote 连接的是一个已经运行的完整 ZCode server。
  // Host 只做 RPC 转接，不替 server 决定 workspace/runtime/provider 归属；
  // Provider 配置只经 Host 私有的 Provisioning executor 从本机单向下发到远端。
  const remoteProviderProvisioningExecutor =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);
  // fork 保留：远端 Agent 的运行期偏好必须由窗口 Host 裁决（见 bridge 注释）。
  attachRemoteRuntimePreferencesBridge({
    zcodeAgentService: params.connectionServices.zcodeAgentService,
    settingService: params.sourceServices?.getOptional(ISettingService) ?? createSettingService(),
  });
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    // 根因：客户端已有 gen-ui 代理，但 Host 漏转发使远端读取成为 Unknown channel。
    // 复用 Source 的读取与输出目录校验；桌面状态/沙箱仍由 base services 提供。
    .register(IGenUiService, params.connectionServices.genUiService)
    .register(IMediaPreviewService, params.connectionServices.mediaPreviewService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, params.connectionServices.settingService)
    // Bug 原因：远程集合曾漏注册此通道，手机重建 Root 后调用失败，回退 settings 判定而误弹引导。
    // 引导记录必须与该入口的 settings 同源：R3 下四种 transport 都由 Source 持有，不借用本机记录。
    .register(IOnboardingRecordService, params.connectionServices.onboardingRecordService)
    .register(ICredentialService, params.connectionServices.credentialService)
    .register(IBroadcastService, params.connectionServices.broadcastService)
    .register(IZCodeTaskService, params.connectionServices.zcodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, params.connectionServices.zcodeSessionService)
    .register(IBotsService, params.connectionServices.botsService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    // Provider/Model 事实属于目标 Environment。远端 workspace 的选择和设置视图
    // 必须直接读取远端 Registry，不能继续显示 Desktop 本地 Provider。
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(ISourceServerWorkspaceService, params.connectionServices.sourceServerWorkspaceService)
    .register(IUsageStatsService, params.connectionServices.usageStatsService)
    .register(IClientScenesService, params.connectionServices.clientScenesService)
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    // Bug 原因：RPC 合同已经要求 plugin-sync，但旧全转发集合漏注册，远端插件同步会在 Host
    // 二次暴露时变成 Unknown channel。全转发集合必须与合同逐项一致。
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ISubagentsService, params.connectionServices.subagentsService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, params.connectionServices.memoryService)
    .register(IOutputStyleService, params.connectionServices.outputStyleService)
    .register(ISettingsSyncService, params.connectionServices.settingsSyncService)
    .register(
      IPromptAttachmentTransferService,
      params.connectionServices.promptAttachmentTransferService,
    );
  // 新频道必须以握手能力为准；客户端总能生成 proxy，不能用对象存在性判断旧 Server 支持。
  if (params.virtualProjects) {
    if (
      !params.connectionServices.projectService ||
      !params.connectionServices.remoteProjectService
    )
      throw new Error("Remote virtual-project RPC registration incomplete");
    services.register(IProjectService, params.connectionServices.projectService);
    services.register(IRemoteProjectService, params.connectionServices.remoteProjectService);
  } else if (params.serverId) {
    services.register(
      IProjectService,
      resolveServerProjectService({ ...params, serverId: params.serverId }),
    );
    services.register(
      IRemoteProjectService,
      createRemoteProjectService({
        controller: false,
        database: async () => {
          throw new Error("remote-project.controller-only");
        },
      }),
    );
  }
  const controllerGroups = params.sourceServices?.getOptional(ITaskGroupService);
  const controllerBroadcast = params.sourceServices?.getOptional(IBroadcastService);
  if (controllerGroups) services.register(ITaskGroupService, controllerGroups);
  if (controllerGroups && controllerBroadcast) {
    const remoteBroadcast = params.connectionServices.broadcastService;
    services.register(IBroadcastService, {
      send: (message) =>
        (message.channel === "state:task-groups" ? controllerBroadcast : remoteBroadcast).send(
          message,
        ),
      acquireClaim: (key) => remoteBroadcast.acquireClaim(key),
      commitClaim: (lease) => remoteBroadcast.commitClaim(lease),
      releaseClaim: (lease) => remoteBroadcast.releaseClaim(lease),
      tryClaim: (key) => remoteBroadcast.tryClaim(key),
      onMessage: (listener) => {
        const remote = remoteBroadcast.onMessage((event) => {
          if (event.channel !== "state:task-groups") listener(event);
        });
        const local = controllerBroadcast.onMessage((event) => {
          if (event.channel === "state:task-groups") listener(event);
        });
        return {
          dispose: () => {
            remote.dispose();
            local.dispose();
          },
        };
      },
    });
  }
  // 入参 accessor 与最终集合都必须覆盖同一份 channel 清单：前者防止握手缺项，
  // 后者防止组装漏注册（旧实现两处各用一份列表，漏项时只有远端调用才发现）。
  const missing = [
    ...REMOTE_WORKSPACE_RPC_REGISTRATIONS.filter(([channel]) => {
      const service = params.connectionServices[channel];
      return (typeof service !== "object" || service === null) && typeof service !== "function";
    }).map(([channel]) => channel),
    ...REMOTE_WORKSPACE_RPC_REGISTRATIONS.filter(
      ([, descriptor]) =>
        services.getOptional(descriptor as ServiceDescriptor<unknown>) === undefined,
    ).map(([channel]) => channel),
  ];
  if (missing.length > 0) {
    throw new Error(`Remote workspace RPC registration incomplete: ${missing.join(", ")}`);
  }
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningExecutor);
  return services;
}
