// Source settings attachment 的裁剪服务集（照搬上游 v3.16.2
// desktop/host/sourceSettingsServiceCollection.ts，backlog-sweep Step 8 补齐真实读数面）。
//
// omz 落位差异：上游把它放在 desktop host（Directory/Manager 都是 host 类）；本仓只依赖
// 结构化 accessor / ServiceCollection，由 desktop host 注入在线 Source 的服务访问面，因此
// 放在 services 侧——desktop 的实现不能被 services 反向 import。
import type { IServiceAccessor } from "../accessor.js";
import { ServiceCollection } from "../collection.js";
import { ICommandsService } from "../commands/commands.js";
import { ICredentialService } from "../credential/credential.js";
import type { ServiceDescriptor } from "../descriptors.js";
import { IHooksService } from "../hooks/hooks.js";
import { IMcpSyncService } from "../mcp-sync/mcpSync.js";
import { IMemoryService } from "../memory/memory.js";
import { IPluginSyncService } from "../plugin-sync/pluginSync.js";
import { IPluginManagementService } from "../plugins/pluginManagement.js";
import { IPluginsService } from "../plugins/plugins.js";
import { ISettingService } from "../setting/setting.js";
import { ISettingsSyncService } from "../settings-sync/settingsSync.js";
import { ISkillSyncService } from "../skill-sync/skillSync.js";
import { ISkillsService } from "../skills/skills.js";
import { ISourceServerWorkspaceService } from "../source-server-workspace/sourceServerWorkspace.js";
import { ISubagentsService } from "../subagents/subagents.js";
import { ISystemService } from "../system/system.js";

/**
 * 远端配置面缺服务时的错误码：装配期就拒绝，避免把 undefined / 本机服务当成远端事实。
 * UI 侧按错误码区分「设备离线」和「设备旧版本没有该配置通道」。
 */
export const SOURCE_SETTINGS_UNAVAILABLE_ERROR_CODE = "source-server.settings-unavailable";

interface CreateSourceSettingsServiceCollectionOptions {
  /** 仅用于错误定位，不参与服务读取，也不做任何本机回退。 */
  sourceServerId?: string;
}

type SourceSettingsServiceSource = IServiceAccessor | ServiceCollection;

function describeUnavailable(
  descriptor: ServiceDescriptor<unknown>,
  options: CreateSourceSettingsServiceCollectionOptions,
): string {
  const scope = options.sourceServerId ? ` (${options.sourceServerId})` : "";
  return `${SOURCE_SETTINGS_UNAVAILABLE_ERROR_CODE}: ${descriptor.channelName}${scope}`;
}

function readService<T>(
  services: SourceSettingsServiceSource,
  descriptor: ServiceDescriptor<T>,
  readFromAccessor: (accessor: IServiceAccessor) => T | undefined,
): T | undefined {
  const service =
    services instanceof ServiceCollection
      ? services.getOptional(descriptor)
      : readFromAccessor(services);
  if (service === undefined || service === null) return undefined;
  // 与 legacy remote workspace 契约校验同口径：RPC proxy 可能是函数对象，只排除真空值。
  if (typeof service !== "object" && typeof service !== "function") return undefined;
  return service;
}

/**
 * Source settings attachment 只暴露 skills/MCP/plugins/hooks/settings-sync 等远端配置面。
 * 模型 Provider 设置永远绑定本地 Environment，远端 Provider 事实只经 Provisioning 单向下发，
 * 因此这里不注册 provider-settings / model-selection。
 *
 * 任一必需通道缺失都抛 {@link SOURCE_SETTINGS_UNAVAILABLE_ERROR_CODE}，不注册空实现：
 * 设置面板读到空列表会伪装成「远端确实没有配置」。
 */
export function createSourceSettingsServiceCollection(
  services: SourceSettingsServiceSource,
  options: CreateSourceSettingsServiceCollectionOptions = {},
): ServiceCollection {
  const require = <T>(
    descriptor: ServiceDescriptor<T>,
    readFromAccessor: (accessor: IServiceAccessor) => T | undefined,
  ): T => {
    const service = readService(services, descriptor, readFromAccessor);
    if (service === undefined) throw new Error(describeUnavailable(descriptor, options));
    return service;
  };

  const collection = new ServiceCollection()
    .register(
      ICredentialService,
      require(ICredentialService, (a) => a.credentialService),
    )
    .register(
      ISettingService,
      require(ISettingService, (a) => a.settingService),
    )
    .register(
      ISystemService,
      require(ISystemService, (a) => a.systemService),
    )
    .register(
      ISkillsService,
      require(ISkillsService, (a) => a.skillsService),
    )
    .register(
      ISkillSyncService,
      require(ISkillSyncService, (a) => a.skillSyncService),
    )
    .register(
      IMcpSyncService,
      require(IMcpSyncService, (a) => a.mcpSyncService),
    )
    .register(
      IPluginSyncService,
      require(IPluginSyncService, (a) => a.pluginSyncService),
    )
    .register(
      IPluginsService,
      require(IPluginsService, (a) => a.pluginsService),
    )
    .register(
      IPluginManagementService,
      require(IPluginManagementService, (a) => a.pluginManagementService),
    )
    .register(
      ICommandsService,
      require(ICommandsService, (a) => a.commandsService),
    )
    .register(
      IHooksService,
      require(IHooksService, (a) => a.hooksService),
    )
    .register(
      ISubagentsService,
      require(ISubagentsService, (a) => a.subagentsService),
    )
    .register(
      IMemoryService,
      require(IMemoryService, (a) => a.memoryService),
    )
    .register(
      ISettingsSyncService,
      require(ISettingsSyncService, (a) => a.settingsSyncService),
    );

  // 身份解析通道在旧 Source / 旧 deployServer 链上可能缺席（accessor 上也是 optional）。
  // 缺席时保持通道不存在，让调用方拿到明确的 unknown-channel 错误；不注册空实现冒充
  // 「工作区已解析」。
  const sourceServerWorkspaceService = readService(
    services,
    ISourceServerWorkspaceService,
    (a) => a.sourceServerWorkspaceService,
  );
  if (sourceServerWorkspaceService) {
    collection.register(ISourceServerWorkspaceService, sourceServerWorkspaceService);
  }
  return collection;
}
