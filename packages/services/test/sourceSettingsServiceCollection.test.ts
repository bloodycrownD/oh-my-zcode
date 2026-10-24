// T-SS1（backlog-sweep Step 8）：Source settings 裁剪服务集——只透出远端配置面，
// 必需通道缺席时显式报 source-server.settings-unavailable，不注册空实现/本机服务。
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/sourceSettingsServiceCollection.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import type { IServiceAccessor } from "../src/accessor.js";
import { ServiceCollection } from "../src/collection.js";
import { ICommandsService } from "../src/commands/commands.js";
import { ICredentialService } from "../src/credential/credential.js";
import type { ServiceDescriptor } from "../src/descriptors.js";
import { IHooksService } from "../src/hooks/hooks.js";
import { IMcpSyncService } from "../src/mcp-sync/mcpSync.js";
import { IMemoryService } from "../src/memory/memory.js";
import { IPluginSyncService } from "../src/plugin-sync/pluginSync.js";
import { IPluginManagementService } from "../src/plugins/pluginManagement.js";
import { IPluginsService } from "../src/plugins/plugins.js";
import { ISettingService } from "../src/setting/setting.js";
import { ISettingsSyncService } from "../src/settings-sync/settingsSync.js";
import { ISkillSyncService } from "../src/skill-sync/skillSync.js";
import { ISkillsService } from "../src/skills/skills.js";
import { ISourceServerWorkspaceService } from "../src/source-server-workspace/sourceServerWorkspace.js";
import {
  createSourceSettingsServiceCollection,
  SOURCE_SETTINGS_UNAVAILABLE_ERROR_CODE,
} from "../src/source-server-management/sourceSettingsServiceCollection.js";
import { ISubagentsService } from "../src/subagents/subagents.js";
import { ISystemService } from "../src/system/system.js";
import { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

type FakeService = { channel: string };

/** 远端配置面必需通道；顺序与实现里的注册顺序一致。 */
const REQUIRED_CHANNELS: ReadonlyArray<readonly [string, ServiceDescriptor<unknown>]> = [
  ["credentialService", ICredentialService],
  ["settingService", ISettingService],
  ["systemService", ISystemService],
  ["skillsService", ISkillsService],
  ["skillSyncService", ISkillSyncService],
  ["mcpSyncService", IMcpSyncService],
  ["pluginSyncService", IPluginSyncService],
  ["pluginsService", IPluginsService],
  ["pluginManagementService", IPluginManagementService],
  ["commandsService", ICommandsService],
  ["hooksService", IHooksService],
  ["subagentsService", ISubagentsService],
  ["memoryService", IMemoryService],
  ["settingsSyncService", ISettingsSyncService],
];

function createRemoteConfigCollection(params: { skip?: string } = {}): {
  collection: ServiceCollection;
  services: Map<string, FakeService>;
} {
  const collection = new ServiceCollection();
  const services = new Map<string, FakeService>();
  for (const [name, descriptor] of REQUIRED_CHANNELS) {
    if (name === params.skip) continue;
    const service: FakeService = { channel: name };
    services.set(name, service);
    collection.register(descriptor, service);
  }
  return { collection, services };
}

function createRemoteConfigAccessor(params: { skip?: string } = {}): {
  accessor: IServiceAccessor;
  services: Map<string, FakeService>;
} {
  const accessor: Record<string, FakeService> = {};
  const services = new Map<string, FakeService>();
  for (const [name] of REQUIRED_CHANNELS) {
    if (name === params.skip) continue;
    const service: FakeService = { channel: name };
    accessor[name] = service;
    services.set(name, service);
  }
  return { accessor: accessor as unknown as IServiceAccessor, services };
}

test("T-SS1 只暴露远端配置面：ServiceCollection 输入逐一透传，不夹带 agent/file", () => {
  const { collection, services } = createRemoteConfigCollection();
  const settings = createSourceSettingsServiceCollection(collection, {
    sourceServerId: "source-1",
  });
  for (const [name, descriptor] of REQUIRED_CHANNELS) {
    assert.equal(settings.getOptional(descriptor), services.get(name), `${name} 必须原样透传`);
  }
  // Provider/Model 与 agent/file 面不在配置裁剪集内：设备面板不能借这个 attachment
  // 读写远端模型选择或跑 agent 命令。
  assert.equal(settings.getOptional(IZCodeAgentService), undefined);
});

test("T-SS1 accessor 输入：同样按通道读取远端服务", () => {
  const { accessor, services } = createRemoteConfigAccessor();
  const settings = createSourceSettingsServiceCollection(accessor);
  for (const [name, descriptor] of REQUIRED_CHANNELS) {
    assert.equal(settings.getOptional(descriptor), services.get(name));
  }
});

test("T-SS1 必需通道缺席：显式错误，不注册空实现", () => {
  const { collection } = createRemoteConfigCollection({ skip: "settingService" });
  assert.throws(
    () => createSourceSettingsServiceCollection(collection, { sourceServerId: "source-1" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(SOURCE_SETTINGS_UNAVAILABLE_ERROR_CODE));
      // 错误里用 channelName（setting），不是 accessor 属性名（settingService）。
      assert.match(error.message, /: setting \(source-1\)$/);
      return true;
    },
  );
});

test("T-SS1 完全空的 accessor：装配期即拒绝，不伪造默认配置", () => {
  assert.throws(
    () => createSourceSettingsServiceCollection({} as IServiceAccessor),
    (error: unknown) =>
      error instanceof Error &&
      error.message === `${SOURCE_SETTINGS_UNAVAILABLE_ERROR_CODE}: credential`,
  );
});

test("T-SS1 sourceServerWorkspaceService：存在才注册，缺席保持 unknown-channel", () => {
  const { collection } = createRemoteConfigCollection();
  const withoutWorkspace = createSourceSettingsServiceCollection(collection);
  assert.equal(withoutWorkspace.getOptional(ISourceServerWorkspaceService), undefined);

  const workspaceService = {
    resolveWorkspace: async () => ({ workspacePath: "/work", workspaceIdentity: "/work" }),
  };
  collection.register(
    ISourceServerWorkspaceService,
    workspaceService as unknown as ISourceServerWorkspaceService,
  );
  const withWorkspace = createSourceSettingsServiceCollection(collection);
  assert.equal(withWorkspace.get(ISourceServerWorkspaceService), workspaceService);
});
