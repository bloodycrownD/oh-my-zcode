/* eslint-disable max-lines -- MCP store 集中维护配置加载、持久化、状态刷新与运行时状态合并，拆分会增加跨状态同步复杂度。 */
/**
 * MCP (Model Context Protocol) UI State Store
 */
import { create } from "zustand";
import type {
  ZCodeAgentMcpServer,
  CliMcpSource,
  McpConfig,
  McpScope,
  McpServerConfig,
  McpServerStatus,
  McpSource,
  NativeMcpServerRecord,
  ZCodeMcpListMode,
  ZCodeMcpServerStatusSnapshot,
  ZCodeMcpServer,
} from "@zcode/shared";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  fetchNativeMcpServers,
  migrateLegacyCommonMcpFromDesktop,
  persistCliMcpToUserDirectory,
  type McpDirectoryService,
  type McpPlatformService,
  type MigrateLegacyResult,
} from "@/store/mcpStoreDesktop.js";
import {
  importLegacyCommonServersToZCodeAgent,
  migrateStoredCommonMcpToZCodeAgent,
} from "@/store/mcpStoreMigration.js";
import {
  buildServerList,
  DEFAULT_MCP_CONFIG,
  getServerPriority,
  loadPersistedConfig,
  makeServerId,
  MCP_DELETED_PRELOAD_KEY,
  safeReadJson,
  safeWriteJson,
} from "@/store/mcpStoreHelpers.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { mergeMcpServerStatusSnapshots } from "@/store/mcpStoreStatusList.js";

let mcpPlatformService: McpPlatformService | null = null;

/**
 * 目录服务持有者类别：Source 端口是设备 user scope 的权威读写面；App 级 workspace
 * 登记只是常驻壳层的兜底。端口持有期间不能被 App 的重跑静默覆盖。
 */
export type McpStoreDirectoryServiceOwnerKind = "workspace" | "source-port";

interface McpDirectoryServiceClaim {
  kind: McpStoreDirectoryServiceOwnerKind;
  sequence: number;
  service: McpDirectoryService;
}

/**
 * 目录服务槽位的所有权登记表。
 *
 * 过去是「一个模块级变量 + 谁卸载谁置 null」：设置页端口面板 cleanup 会连同 App 级
 * useEnsureWorkspaceMcpLoaded 的登记一起抹掉，而那个 hook 依赖未变不会重跑，槽位此后
 * 恒为 null，远端 workspace 的 MCP 写入就落到本机 platform.saveMcpToUserDirectory。
 *
 * 现在所有持有者（App 壳层、Source 端口面板）用稳定实例令牌 claim/release：
 * - 同一 owner 重复 claim 视为续期（Map 覆盖），不会让计数虚增；
 * - 任一方 release 只删除自己的登记，登记表大小即活跃持有者数量；
 * - 只有登记表归零后槽位才真正为空。
 */
const mcpDirectoryServiceClaims = new Map<object, McpDirectoryServiceClaim>();
let mcpDirectoryServiceClaimSequence = 0;

export function setMcpStorePlatform(platform: McpPlatformService | null): void {
  mcpPlatformService = platform;
}

/** 登记一个目录服务持有者；`owner` 必须是调用方组件实例的稳定令牌（useRef）。 */
export function claimMcpStoreDirectoryService(
  owner: object,
  service: McpDirectoryService,
  kind: McpStoreDirectoryServiceOwnerKind = "workspace",
): void {
  mcpDirectoryServiceClaimSequence += 1;
  mcpDirectoryServiceClaims.set(owner, {
    kind,
    sequence: mcpDirectoryServiceClaimSequence,
    service,
  });
}

/** 释放持有者登记；其他持有者仍有效时槽位保持不变，全部释放后才回落到 null。 */
export function releaseMcpStoreDirectoryService(owner: object): void {
  mcpDirectoryServiceClaims.delete(owner);
}

/**
 * 当前生效的目录服务：Source 端口持有者优先（Source user scope 的权威读写面），
 * 同类持有者取最近一次 claim；登记表为空（未加载 / 已全部释放）时返回 null，
 * 调用方随即可回落到本机 platform 行为。
 */
export function getMcpStoreDirectoryService(): McpDirectoryService | null {
  let effective: McpDirectoryServiceClaim | null = null;
  for (const claim of mcpDirectoryServiceClaims.values()) {
    if (
      !effective ||
      (claim.kind === "source-port" && effective.kind !== "source-port") ||
      (claim.kind === effective.kind && claim.sequence > effective.sequence)
    ) {
      effective = claim;
    }
  }
  return effective?.service ?? null;
}

/**
 * 隔离读取目标：按 scopeKey（Source 设置账本键）给设备 user scope 建一份独立投影。
 *
 * `directoryService` 必须由调用方显式传入，不能回落到模块级 claim：设置页覆盖期间
 * App 级常驻持有者仍在登记表里，回落会把设备读取混到当前 workspace 的读写面上。
 */
export interface McpIsolatedScopeTarget {
  scopeKey: string;
  directoryService: McpDirectoryService;
  /**
   * 该设备已打开 workspace 的锚点路径（没有锚点时省略）。
   *
   * user scope 面板本身不需要项目路径；但 mcp/list 的 connect 语义会用显式下发的
   * `mcpServers` 替换运行态集合（见 CLI 的 `explicitMcpServersProvided` 分支）。
   * 因此读取时带上真实锚点，把该 workspace 的项目级 MCP 一并投影进隔离快照，
   * 状态刷新时才能像旧行为一样同时覆盖 user + 该 workspace 的配置。
   */
  workspacePath?: string;
}

/**
 * 一个隔离 scope 的完整投影。与全局 `currentProjectPath` / `currentWorkspaceIdentity` /
 * `nativeServers` / `servers` 完全无关：设备侧读取只落在这里，设置页关闭后不会改变
 * App 级 store 对当前 workspace 的判断，也不会把设备 MCP 的 env/header 下发给本机 Agent。
 */
interface McpIsolatedServerSnapshot {
  nativeServers: NativeMcpServerRecord[];
  servers: ZCodeMcpServer[];
  /** 读取时使用的设备 workspace 锚点；workspace scope 条目只在它匹配时下发。 */
  workspacePath?: string;
  /** 该 scope 内的启停覆盖（按 serverId）；同名服务器在不同设备之间互不影响。 */
  enabledStates: Record<string, boolean>;
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot>;
}

const MCP_ISOLATED_EMPTY_SNAPSHOT: McpIsolatedServerSnapshot = {
  nativeServers: [],
  servers: [],
  enabledStates: {},
  statusSnapshots: {},
};

interface UpdateServerStatusOptions {
  invalidateStatusListRequests?: boolean;
}

interface McpStoreState {
  config: McpConfig;
  nativeServers: NativeMcpServerRecord[];
  servers: ZCodeMcpServer[];
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot>;
  currentProjectPath: string;
  currentWorkspaceIdentity?: string;
  enabledStates: Record<string, boolean>;
  deletedPreloadMcpServers: Set<string>;
  isConfigLoaded: boolean;
  currentSessionId: string | null;
  loadConfig: () => void;
  loadMcpFromUserDirectory: (
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  ensureLoadedForWorkspace: (
    workspacePath?: string,
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  saveConfig: () => void;
  addMcpServer: (name: string, config: McpServerConfig) => void;
  updateMcpServer: (name: string, config: McpServerConfig) => void;
  deleteMcpServer: (name: string) => void;
  addScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  updateScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  deleteScopedMcpServer: (source: McpSource, name: string, projectPath?: string) => void;
  addZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteZCodeAgentMcpServer: (name: string, projectPath?: string) => void;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  updateServerStatus: (
    id: string,
    status: McpServerStatus,
    error?: string,
    options?: UpdateServerStatusOptions,
  ) => void;
  beginServerStatusListRefresh: (mode?: ZCodeMcpListMode) => number;
  markServerStatusListRefreshFailed: (
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: "connect" | "status",
  ) => void;
  getServer: (id: string) => ZCodeMcpServer | undefined;
  setCurrentProjectPath: (
    path: string,
    workspaceIdentity?: string,
    directoryService?: McpDirectoryService | null,
  ) => void;
  getEnabledMcpServersForZCode: (provider: string) => ZCodeAgentMcpServer[];
  checkAllServerStatus: (
    tester: (config: McpServerConfig) => Promise<{ success: boolean; error?: string }>,
  ) => Promise<void>;
  mergePreloadedMcpServers: (preloaded: Record<string, McpServerConfig>) => void;
  deletePreloadedMcpServer: (source: McpSource, name: string) => void;
  setCurrentSessionId: (sessionId: string | null) => void;
  migrateLegacyCommonMcp: () => Promise<MigrateLegacyResult>;
  /** 按 scopeKey 隔离的设备 user scope 投影；不参与全局 current* 的匹配。 */
  isolatedServerSnapshots: Record<string, McpIsolatedServerSnapshot>;
  loadIsolatedMcpServers: (target: McpIsolatedScopeTarget) => Promise<boolean>;
  addIsolatedMcpServer: (
    target: McpIsolatedScopeTarget,
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  updateIsolatedMcpServer: (
    target: McpIsolatedScopeTarget,
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  deleteIsolatedMcpServer: (
    target: McpIsolatedScopeTarget,
    source: McpSource,
    name: string,
    projectPath?: string,
  ) => Promise<void>;
  toggleIsolatedServer: (
    target: McpIsolatedScopeTarget,
    id: string,
    enabled: boolean,
  ) => Promise<void>;
  getIsolatedEnabledMcpServers: (scopeKey: string, provider: string) => ZCodeAgentMcpServer[];
  beginIsolatedServerStatusListRefresh: (scopeKey: string, mode?: ZCodeMcpListMode) => number;
  markIsolatedServerStatusListRefreshFailed: (
    scopeKey: string,
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeIsolatedServerStatusSnapshots: (
    scopeKey: string,
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: "connect" | "status",
  ) => void;
}

export const useMcpStore = create<McpStoreState>((set, get) => {
  let loadMcpPromise: Promise<boolean> | null = null;
  let loadMcpWorkspaceKey: string | null = null;
  const statusListEpochs: Record<ZCodeMcpListMode, number> = {
    connect: 0,
    status: 0,
  };
  // 隔离 scope 的 epoch 与请求去重必须各自独立：全局 workspace 与设备 user scope
  // 同时在刷新时，任何一方的 begin/invalidate 都不能作废另一方的在途结果。
  const isolatedStatusListEpochs = new Map<string, Record<ZCodeMcpListMode, number>>();
  const isolatedLoadPromises = new Map<string, Promise<boolean>>();
  // 同一 scope 的锚点路径可能切换；晚返回的旧读取不能覆盖新锚点的快照。
  const latestIsolatedLoadKey = new Map<string, string>();

  function invalidateStatusListRequests(): void {
    statusListEpochs.connect += 1;
    statusListEpochs.status += 1;
  }

  function getIsolatedStatusListEpochs(scopeKey: string): Record<ZCodeMcpListMode, number> {
    let epochs = isolatedStatusListEpochs.get(scopeKey);
    if (!epochs) {
      epochs = { connect: 0, status: 0 };
      isolatedStatusListEpochs.set(scopeKey, epochs);
    }
    return epochs;
  }

  function invalidateIsolatedStatusListRequests(scopeKey: string): void {
    const epochs = getIsolatedStatusListEpochs(scopeKey);
    epochs.connect += 1;
    epochs.status += 1;
  }

  function resolveMcpDirectoryService(
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string | null,
  ): McpDirectoryService | null {
    const effectiveWorkspaceIdentity = workspaceIdentity ?? get().currentWorkspaceIdentity;
    if (!effectiveWorkspaceIdentity?.trim()) {
      // 本地 workspace 仍要走 desktop platform 路径，才能执行旧 common MCP
      // 到用户级 ZCode Agent MCP 的迁移；目录服务只用于远端 workspace 覆盖路由。
      return null;
    }
    return directoryService ?? getMcpStoreDirectoryService();
  }

  function commitState(partial: {
    config?: McpConfig;
    nativeServers?: NativeMcpServerRecord[];
  }): Partial<McpStoreState> {
    const state = get();
    const nextConfig = partial.config ?? state.config;
    const nextNativeServers = partial.nativeServers ?? state.nativeServers;
    return {
      config: nextConfig,
      nativeServers: nextNativeServers,
      servers: buildServerList(
        nextConfig,
        nextNativeServers,
        state.enabledStates,
        state.deletedPreloadMcpServers,
        state.servers,
      ),
    };
  }

  function updateNativeServer(
    source: CliMcpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) {
    const nativeServers = get().nativeServers.slice();
    const targetIndex = nativeServers.findIndex(
      (server) =>
        server.source === source && server.name === name && server.projectPath === projectPath,
    );
    if (targetIndex >= 0) {
      const existing = nativeServers[targetIndex];
      if (!existing) {
        return;
      }
      nativeServers[targetIndex] = {
        ...existing,
        config,
      };
    } else {
      // 添加新的服务器记录
      const scope: McpScope = projectPath ? "workspace" : "user";
      nativeServers.push({
        source,
        scope,
        name,
        config,
        enabled: true,
        projectPath,
      });
    }
    set(commitState({ nativeServers }));
  }

  function rebuildIsolatedSnapshot(
    state: McpStoreState,
    nativeServers: NativeMcpServerRecord[],
    enabledStates: Record<string, boolean>,
    existingServers: ZCodeMcpServer[],
    statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot>,
    workspacePath?: string,
  ): McpIsolatedServerSnapshot {
    return {
      nativeServers,
      servers: buildServerList(
        state.config,
        nativeServers,
        enabledStates,
        state.deletedPreloadMcpServers,
        existingServers,
      ),
      workspacePath,
      enabledStates,
      statusSnapshots,
    };
  }

  function updateIsolatedNativeServer(
    scopeKey: string,
    source: CliMcpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ): void {
    set((state) => {
      const previous = state.isolatedServerSnapshots[scopeKey] ?? MCP_ISOLATED_EMPTY_SNAPSHOT;
      const nativeServers = previous.nativeServers.slice();
      const targetIndex = nativeServers.findIndex(
        (server) =>
          server.source === source && server.name === name && server.projectPath === projectPath,
      );
      if (targetIndex >= 0) {
        const existing = nativeServers[targetIndex];
        if (!existing) {
          return {};
        }
        nativeServers[targetIndex] = { ...existing, config };
      } else {
        const scope: McpScope = projectPath ? "workspace" : "user";
        nativeServers.push({
          source,
          scope,
          name,
          config,
          enabled: true,
          projectPath,
        });
      }
      return {
        isolatedServerSnapshots: {
          ...state.isolatedServerSnapshots,
          [scopeKey]: rebuildIsolatedSnapshot(
            state,
            nativeServers,
            previous.enabledStates,
            previous.servers,
            previous.statusSnapshots,
            previous.workspacePath,
          ),
        },
      };
    });
  }

  async function persistIsolatedChange(
    target: McpIsolatedScopeTarget,
    payload: {
      action: "upsert" | "delete" | "set-enabled";
      source: CliMcpSource;
      name: string;
      config?: McpServerConfig;
      enabled?: boolean;
      projectPath?: string;
      location?: ZCodeMcpServer["location"];
    },
  ): Promise<void> {
    await persistCliMcpToUserDirectory(mcpPlatformService, payload, target.directoryService).catch(
      (error) => {
        logger.warn(
          `[mcpStore] persist isolated MCP failed scope=${target.scopeKey}`,
          String(error),
        );
      },
    );
  }

  async function persistScopedChange(
    source: McpSource,
    payload: {
      action: "upsert" | "delete";
      source: CliMcpSource;
      name: string;
      config?: McpServerConfig;
      projectPath?: string;
    },
  ): Promise<void> {
    if (source === "mcp") {
      return;
    }

    await persistCliMcpToUserDirectory(
      mcpPlatformService,
      payload,
      resolveMcpDirectoryService(),
    ).catch((error) => {
      logger.warn(`[mcpStore] persist ${source} MCP failed`, String(error));
    });
  }

  return {
    config: { ...DEFAULT_MCP_CONFIG },
    nativeServers: [],
    servers: [],
    statusSnapshots: {},
    currentProjectPath: "",
    currentWorkspaceIdentity: undefined,
    enabledStates: {},
    deletedPreloadMcpServers: new Set(),
    isConfigLoaded: false,
    currentSessionId: null,
    isolatedServerSnapshots: {},

    loadConfig: () => {
      const config = loadPersistedConfig();
      // MCP 启停状态已经迁移到 ~/.omz/cli/config.json，不能再读取旧 localStorage，
      // 否则旧的本地开关会覆盖新的 ZCode Agent 配置来源。
      const enabledStates: Record<string, boolean> = {};
      const deletedPreload = new Set<string>(safeReadJson<string[]>(MCP_DELETED_PRELOAD_KEY, []));
      const servers = buildServerList(config, [], enabledStates, deletedPreload, []);
      set({
        config,
        nativeServers: [],
        enabledStates,
        deletedPreloadMcpServers: deletedPreload,
        servers,
        statusSnapshots: {},
        isConfigLoaded: true,
      });
    },

    loadMcpFromUserDirectory: async (directoryService, workspaceIdentity) => {
      if (typeof window === "undefined") {
        return false;
      }

      const requestWorkspacePath = get().currentProjectPath || undefined;
      const requestWorkspaceIdentity = workspaceIdentity ?? get().currentWorkspaceIdentity;
      const requestWorkspaceKey = requestWorkspaceIdentity?.trim() || requestWorkspacePath || "";
      if (loadMcpPromise && loadMcpWorkspaceKey === requestWorkspaceKey) {
        return await loadMcpPromise;
      }
      if (loadMcpPromise) {
        await loadMcpPromise;
      }

      const latestWorkspacePath = get().currentProjectPath || undefined;
      const latestWorkspaceIdentity = get().currentWorkspaceIdentity;
      const latestWorkspaceKey = latestWorkspaceIdentity?.trim() || latestWorkspacePath || "";
      if (latestWorkspaceKey !== requestWorkspaceKey) {
        // 该调用等待上一轮 load 时已从 B 切到 C；B 调用持有的 remote
        // directoryService 不得继续读取 C，交给 C 自己发起的 ensure/load 调用处理。
        return false;
      }
      // 等待上一 workspace load 期间可能再次切换；目录服务必须按等待后的
      // 最新 identity 重新选择，不能拿 B 的 remote service 去读取 C 的路径。
      const activeDirectoryService = resolveMcpDirectoryService(
        directoryService,
        latestWorkspaceIdentity,
      );
      if (loadMcpPromise && loadMcpWorkspaceKey === latestWorkspaceKey) {
        return await loadMcpPromise;
      }

      loadMcpWorkspaceKey = latestWorkspaceKey;
      loadMcpPromise = (async () => {
        try {
          logger.info(
            `[mcpStore] loadMcpFromUserDirectory workspace=${latestWorkspacePath ?? "<none>"} identity=${latestWorkspaceIdentity ?? "<none>"}`,
          );
          let servers = await fetchNativeMcpServers(
            mcpPlatformService,
            { workspacePath: latestWorkspacePath },
            activeDirectoryService,
          );
          if (!activeDirectoryService) {
            servers = await migrateStoredCommonMcpToZCodeAgent(
              mcpPlatformService,
              servers,
              latestWorkspacePath,
            );
          }
          const currentState = get();
          const currentWorkspaceKey =
            currentState.currentWorkspaceIdentity?.trim() || currentState.currentProjectPath;
          if (currentWorkspaceKey !== latestWorkspaceKey) {
            // workspace A 的异步目录读取可能晚于切换到 B 才返回；
            // 旧结果包含 env/header/OAuth secret，不能写回共享 store 后被 B 的 Agent 消费。
            return false;
          }
          set(commitState({ nativeServers: servers }));
          return true;
        } catch (e) {
          // 读取失败不是“配置为空”；调用方必须保持 workspace not-ready，
          // 否则会显式下发空 mcpServers 并触发 replace，断开仍在运行的 MCP。
          // remote session attachment 绑定前只能拿到断连代理；这是初始化时序，不是
          // MCP 配置读取失败。只过滤该精确错误码，避免吞掉真实的目录或 RPC 故障。
          if (!isRemoteWorkspaceDisconnectedError(e)) {
            logger.warn("[mcpStore] loadMcpFromUserDirectory failed", String(e));
          }
          return false;
        } finally {
          loadMcpPromise = null;
          loadMcpWorkspaceKey = null;
        }
      })();

      return await loadMcpPromise;
    },

    ensureLoadedForWorkspace: async (workspacePath, directoryService, workspaceIdentity) => {
      if (!get().isConfigLoaded) {
        get().loadConfig();
      }

      const normalizedWorkspacePath = workspacePath ?? "";
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      if (
        normalizedWorkspacePath !== get().currentProjectPath ||
        normalizedWorkspaceIdentity !== get().currentWorkspaceIdentity
      ) {
        get().setCurrentProjectPath(
          normalizedWorkspacePath,
          normalizedWorkspaceIdentity,
          directoryService,
        );
      }

      return await get().loadMcpFromUserDirectory(directoryService, normalizedWorkspaceIdentity);
    },

    saveConfig: () => {
      const { deletedPreloadMcpServers } = get();
      safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(deletedPreloadMcpServers));
    },

    addMcpServer: (name, config) => get().addZCodeAgentMcpServer(name, config),
    updateMcpServer: (name, config) => get().updateZCodeAgentMcpServer(name, config),
    deleteMcpServer: (name) => get().deleteZCodeAgentMcpServer(name),
    addScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 设置页保存后会马上触发 agent 侧 mcp/list 重连。
      // 先等配置落盘，再更新本地 store，避免 agent 读到旧 timeoutMs 后展示旧健康状态。
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    updateScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 本地状态变化会驱动健康状态刷新，必须在磁盘配置更新后发生。
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    deleteScopedMcpServer: (source, name, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      persistScopedChange(targetSource, {
        action: "delete",
        source: targetSource,
        name,
        projectPath,
      });
      set(
        commitState({
          nativeServers: get().nativeServers.filter(
            (server) =>
              !(
                server.source === targetSource &&
                server.name === name &&
                server.projectPath === projectPath
              ),
          ),
        }),
      );
    },
    addZCodeAgentMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    updateZCodeAgentMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    deleteZCodeAgentMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("zcodeagentmcp", name, projectPath),

    toggleServer: async (id, enabled) => {
      invalidateStatusListRequests();
      const targetServer = get().servers.find((server) => server.id === id);
      if (targetServer && targetServer.source !== "mcp") {
        // 开关变化会触发 agent 侧 mcp/list 读取磁盘配置做真实连接。
        // 必须先等 enable 状态落盘，再更新本地列表驱动刷新，否则 agent 会读到旧开关。
        await persistCliMcpToUserDirectory(
          mcpPlatformService,
          {
            action: "set-enabled",
            source: targetServer.source,
            name: targetServer.name,
            enabled,
            projectPath: targetServer.projectPath,
            location: targetServer.location,
          },
          resolveMcpDirectoryService(),
        ).catch((error) => {
          logger.warn("[mcpStore] persist MCP enabled override failed", String(error));
        });
      }

      set((state) => {
        const nextEnabledStates = { ...state.enabledStates, [id]: enabled };
        return {
          enabledStates: nextEnabledStates,
          servers: state.servers.map((s) => (s.id === id ? { ...s, enabled } : s)),
        };
      });
    },

    updateServerStatus: (id, status, error, options) => {
      if (options?.invalidateStatusListRequests !== false) {
        invalidateStatusListRequests();
      }
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                authorization: undefined,
                error,
                failureKind: status === "error" ? "connection_failed" : undefined,
                serverRequestId: undefined,
                toolCount: status === "connected" ? s.toolCount : undefined,
                changed: status === "error" ? s.changed : false,
                lastConnected: status === "connected" ? new Date() : s.lastConnected,
              }
            : s,
        ),
      }));
    },

    beginServerStatusListRefresh: (mode = "connect") => {
      statusListEpochs[mode] += 1;
      const requestEpoch = statusListEpochs[mode];
      if (mode === "status") {
        // OAuth 1s status-only 轮询只读取 runtime snapshot；不能反复清空
        // authorization/toolCount 或把用户同时编辑的其他 MCP 投影成 connecting。
        return requestEpoch;
      }
      // agent 侧 mcp/list 会等待所有 MCP 连接完成才返回；如果插件 MCP 还在 30s 超时中，
      // 修改 timeoutMs 后本地列表会长时间停在 unknown，看起来像没有立即重新检查。
      set((state) => ({
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (
            server.source !== "zcodeagentmcp" ||
            !enabled ||
            (!server.changed && server.status !== "unknown")
          ) {
            return server;
          }
          return {
            ...server,
            status: "connecting",
            authorization: undefined,
            error: undefined,
            failureKind: undefined,
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
      return requestEpoch;
    },

    markServerStatusListRefreshFailed: (error, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode] || mode === "status") {
        // OAuth 轮询是只读的 best-effort status 请求；临时失败不能清空已有
        // authorization snapshot，也不能把同一列表中仍在连接的 MCP 批量标红。
        return;
      }
      set((state) => ({
        statusSnapshots: {},
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (server.source !== "zcodeagentmcp" || !enabled || server.status !== "connecting") {
            return server;
          }
          return {
            ...server,
            status: "error",
            authorization: undefined,
            error,
            failureKind: "status_unavailable",
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
    },

    mergeServerStatusSnapshots: (statuses, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode]) {
        return;
      }
      set((state) => {
        const nextStatusSnapshots =
          mode === "status" ? { ...state.statusSnapshots, ...statuses } : statuses;
        return {
          statusSnapshots: nextStatusSnapshots,
          servers: mergeMcpServerStatusSnapshots(state.servers, nextStatusSnapshots, {
            // OAuth 轮询的 status-only 响应可能只包含 pending 子集。
            // 缺失项不能按全量 mcp/list 处理，否则会把其他 MCP 误标为 agent 未返回。
            markMissingConnectingAsError: mode !== "status",
          }),
        };
      });
    },

    getServer: (id) => get().servers.find((s) => s.id === id),

    setCurrentProjectPath: (path, workspaceIdentity, directoryService) => {
      invalidateStatusListRequests();
      const {
        config,
        currentProjectPath,
        currentWorkspaceIdentity,
        deletedPreloadMcpServers,
        enabledStates,
        isConfigLoaded,
        nativeServers,
        servers,
      } = get();
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const workspaceChanged =
        path !== currentProjectPath || normalizedWorkspaceIdentity !== currentWorkspaceIdentity;
      const nextNativeServers = workspaceChanged ? [] : nativeServers;
      set({
        currentProjectPath: path,
        currentWorkspaceIdentity: normalizedWorkspaceIdentity,
        nativeServers: nextNativeServers,
        statusSnapshots: {},
        servers: buildServerList(
          config,
          nextNativeServers,
          enabledStates,
          deletedPreloadMcpServers,
          workspaceChanged ? [] : servers,
        ),
      });
      if (isConfigLoaded && workspaceChanged) {
        // 切换到远程 workspace 后配置加载是异步的；等待期间必须先清空 A 的
        // user-level MCP，不能把其 env/header/OAuth clientSecret 暂存为 B 的可发送配置。
        void get().loadMcpFromUserDirectory(directoryService, normalizedWorkspaceIdentity);
      }
    },

    getEnabledMcpServersForZCode: (_provider) => {
      const { servers, enabledStates, currentProjectPath } = get();
      const candidates = new Map<string, ZCodeMcpServer>();

      for (const server of servers) {
        const isEnabled = enabledStates[server.id] ?? server.enabled;
        if (!isEnabled) continue;
        if (server.source !== "zcodeagentmcp") continue;
        if (server.scope === "workspace" && server.projectPath !== currentProjectPath) continue;

        const existing = candidates.get(server.name);
        if (!existing || getServerPriority(server) > getServerPriority(existing)) {
          candidates.set(server.name, server);
        }
      }

      const result: ZCodeAgentMcpServer[] = [];
      for (const server of candidates.values()) {
        const zcodeAgentServer = convertToZCodeAgentMcpServer(server.name, server.config);
        if (zcodeAgentServer) result.push(zcodeAgentServer);
      }
      return result;
    },

    checkAllServerStatus: async (tester) => {
      for (const server of get().servers) {
        const isEnabled = get().enabledStates[server.id] ?? server.enabled;
        if (!isEnabled || (!server.changed && server.status !== "unknown")) continue;

        get().updateServerStatus(server.id, "connecting");
        try {
          const result = await tester(server.config);
          get().updateServerStatus(
            server.id,
            result.success ? "connected" : "error",
            result.success ? undefined : (result.error ?? "Connection failed"),
          );
        } catch (e) {
          get().updateServerStatus(server.id, "error", String(e));
        }
      }
    },

    mergePreloadedMcpServers: (preloaded) => {
      const { deletedPreloadMcpServers, nativeServers } = get();
      const targetSource: CliMcpSource = "zcodeagentmcp";
      const nextNativeServers = nativeServers.slice();
      let changed = false;

      for (const [name, cfg] of Object.entries(preloaded)) {
        const serverId = makeServerId(targetSource, name);
        const exists = nextNativeServers.some(
          (server) => server.source === targetSource && server.name === name && !server.projectPath,
        );
        if (deletedPreloadMcpServers.has(serverId) || exists) continue;
        nextNativeServers.push({
          source: targetSource,
          scope: "user",
          name,
          config: cfg,
          enabled: true,
        });
        persistScopedChange(targetSource, {
          action: "upsert",
          source: targetSource,
          name,
          config: cfg,
        });
        changed = true;
      }

      if (!changed) return;
      set(commitState({ nativeServers: nextNativeServers }));
    },

    deletePreloadedMcpServer: (source, name) => {
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      const key = makeServerId(targetSource, name);
      persistScopedChange(targetSource, { action: "delete", source: targetSource, name });
      set((state) => {
        const nextDeleted = new Set(state.deletedPreloadMcpServers);
        nextDeleted.add(key);
        safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(nextDeleted));
        const nextNativeServers = state.nativeServers.filter(
          (server) =>
            !(server.source === targetSource && server.name === name && !server.projectPath),
        );
        return {
          deletedPreloadMcpServers: nextDeleted,
          nativeServers: nextNativeServers,
          servers: buildServerList(
            state.config,
            nextNativeServers,
            state.enabledStates,
            nextDeleted,
            state.servers,
          ),
        };
      });
    },

    setCurrentSessionId: (sessionId) => set({ currentSessionId: sessionId }),

    migrateLegacyCommonMcp: async () => {
      const result = await migrateLegacyCommonMcpFromDesktop(mcpPlatformService);
      const latestWorkspacePath = get().currentProjectPath || undefined;
      const currentNativeServers =
        get().nativeServers.length > 0
          ? get().nativeServers
          : await fetchNativeMcpServers(mcpPlatformService, { workspacePath: latestWorkspacePath });
      const migration = await importLegacyCommonServersToZCodeAgent(
        mcpPlatformService,
        result.servers ?? {},
        currentNativeServers,
        result.sourcePath,
      );
      if (migration.changed) {
        const servers = await fetchNativeMcpServers(mcpPlatformService, {
          workspacePath: latestWorkspacePath,
        });
        set(commitState({ nativeServers: servers }));
      }
      return migration;
    },

    loadIsolatedMcpServers: async (target) => {
      if (typeof window === "undefined") {
        return false;
      }
      if (!get().isConfigLoaded) {
        get().loadConfig();
      }
      const { scopeKey, workspacePath } = target;
      const loadKey = `${scopeKey}\0${workspacePath ?? ""}`;
      const inFlight = isolatedLoadPromises.get(loadKey);
      if (inFlight) {
        return await inFlight;
      }
      latestIsolatedLoadKey.set(scopeKey, loadKey);
      const promise = (async () => {
        try {
          // 没有真实 workspace 锚点时只读设备用户目录；有锚点时连同该 workspace 的
          // 项目级 MCP 一起读取，供 mcp/list 的 replace 语义下发完整集合。
          const nativeServers = await fetchNativeMcpServers(
            mcpPlatformService,
            workspacePath ? { workspacePath } : undefined,
            target.directoryService,
          );
          if (latestIsolatedLoadKey.get(scopeKey) !== loadKey) {
            // 同一 scope 已经切到新锚点；旧结果不能写进快照。
            return false;
          }
          set((state) => {
            const previous = state.isolatedServerSnapshots[scopeKey] ?? MCP_ISOLATED_EMPTY_SNAPSHOT;
            return {
              isolatedServerSnapshots: {
                ...state.isolatedServerSnapshots,
                [scopeKey]: rebuildIsolatedSnapshot(
                  state,
                  nativeServers,
                  previous.enabledStates,
                  previous.servers,
                  previous.statusSnapshots,
                  workspacePath,
                ),
              },
            };
          });
          return true;
        } catch (error) {
          logger.warn(
            `[mcpStore] load isolated MCP servers failed scope=${scopeKey}`,
            String(error),
          );
          return false;
        } finally {
          isolatedLoadPromises.delete(loadKey);
        }
      })();
      isolatedLoadPromises.set(loadKey, promise);
      return await promise;
    },

    addIsolatedMcpServer: async (target, source, name, config, projectPath) => {
      invalidateIsolatedStatusListRequests(target.scopeKey);
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 先落盘再更新投影，避免保存后立即触发的 mcp/list 读到旧配置。
      await persistIsolatedChange(target, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      // user scope 与当前锚点 workspace 的条目都在隔离快照里；写入其它 workspace
      // 的配置只落盘，避免把别的项目配置混进当前投影。
      if (!projectPath || projectPath === target.workspacePath) {
        updateIsolatedNativeServer(target.scopeKey, targetSource, name, config, projectPath);
      }
    },

    updateIsolatedMcpServer: async (target, source, name, config, projectPath) => {
      invalidateIsolatedStatusListRequests(target.scopeKey);
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      await persistIsolatedChange(target, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      if (!projectPath || projectPath === target.workspacePath) {
        updateIsolatedNativeServer(target.scopeKey, targetSource, name, config, projectPath);
      }
    },

    deleteIsolatedMcpServer: async (target, source, name, projectPath) => {
      invalidateIsolatedStatusListRequests(target.scopeKey);
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      await persistIsolatedChange(target, {
        action: "delete",
        source: targetSource,
        name,
        projectPath,
      });
      if (projectPath && projectPath !== target.workspacePath) {
        return;
      }
      set((state) => {
        const previous = state.isolatedServerSnapshots[target.scopeKey];
        if (!previous) {
          return {};
        }
        const nativeServers = previous.nativeServers.filter(
          (server) =>
            !(
              server.source === targetSource &&
              server.name === name &&
              server.projectPath === projectPath
            ),
        );
        return {
          isolatedServerSnapshots: {
            ...state.isolatedServerSnapshots,
            [target.scopeKey]: rebuildIsolatedSnapshot(
              state,
              nativeServers,
              previous.enabledStates,
              previous.servers,
              previous.statusSnapshots,
              previous.workspacePath,
            ),
          },
        };
      });
    },

    toggleIsolatedServer: async (target, id, enabled) => {
      invalidateIsolatedStatusListRequests(target.scopeKey);
      const snapshot = get().isolatedServerSnapshots[target.scopeKey];
      const targetServer = snapshot?.servers.find((server) => server.id === id);
      if (!targetServer) {
        return;
      }
      if (targetServer.source !== "mcp") {
        await persistIsolatedChange(target, {
          action: "set-enabled",
          source: targetServer.source,
          name: targetServer.name,
          enabled,
          projectPath: targetServer.projectPath,
          location: targetServer.location,
        });
      }
      set((state) => {
        const current = state.isolatedServerSnapshots[target.scopeKey];
        if (!current) {
          return {};
        }
        const enabledStates = { ...current.enabledStates, [id]: enabled };
        return {
          isolatedServerSnapshots: {
            ...state.isolatedServerSnapshots,
            [target.scopeKey]: {
              ...current,
              enabledStates,
              servers: current.servers.map((server): ZCodeMcpServer => {
                if (server.id !== id) {
                  return server;
                }
                if (enabled) {
                  return { ...server, enabled };
                }
                return {
                  ...server,
                  enabled,
                  status: "unknown",
                  authorization: undefined,
                  error: undefined,
                  failureKind: undefined,
                  serverRequestId: undefined,
                  toolCount: undefined,
                };
              }),
            },
          },
        };
      });
    },

    getIsolatedEnabledMcpServers: (scopeKey, _provider) => {
      const snapshot = get().isolatedServerSnapshots[scopeKey];
      if (!snapshot) {
        return [];
      }
      const candidates = new Map<string, ZCodeMcpServer>();
      for (const server of snapshot.servers) {
        const isEnabled = snapshot.enabledStates[server.id] ?? server.enabled;
        if (!isEnabled) continue;
        if (server.source !== "zcodeagentmcp") continue;
        // 隔离快照可能包含锚点 workspace 的项目级 MCP；只下发与本次读取锚点一致的
        // workspace 条目，绝不把别的项目配置带给该设备的 Agent。
        if (server.scope === "workspace" && server.projectPath !== snapshot.workspacePath) {
          continue;
        }
        const existing = candidates.get(server.name);
        if (!existing || getServerPriority(server) > getServerPriority(existing)) {
          candidates.set(server.name, server);
        }
      }
      const result: ZCodeAgentMcpServer[] = [];
      for (const server of candidates.values()) {
        const zcodeAgentServer = convertToZCodeAgentMcpServer(server.name, server.config);
        if (zcodeAgentServer) result.push(zcodeAgentServer);
      }
      return result;
    },

    beginIsolatedServerStatusListRefresh: (scopeKey, mode = "connect") => {
      const epochs = getIsolatedStatusListEpochs(scopeKey);
      epochs[mode] += 1;
      const requestEpoch = epochs[mode];
      if (mode === "status") {
        // 与全局语义一致：OAuth status-only 轮询只读 runtime snapshot，不改本地投影。
        return requestEpoch;
      }
      set((state) => {
        const snapshot = state.isolatedServerSnapshots[scopeKey];
        if (!snapshot) {
          return {};
        }
        return {
          isolatedServerSnapshots: {
            ...state.isolatedServerSnapshots,
            [scopeKey]: {
              ...snapshot,
              servers: snapshot.servers.map((server): ZCodeMcpServer => {
                const enabled = snapshot.enabledStates[server.id] ?? server.enabled;
                if (
                  server.source !== "zcodeagentmcp" ||
                  !enabled ||
                  (!server.changed && server.status !== "unknown")
                ) {
                  return server;
                }
                return {
                  ...server,
                  status: "connecting",
                  authorization: undefined,
                  error: undefined,
                  failureKind: undefined,
                  serverRequestId: undefined,
                  toolCount: undefined,
                };
              }),
            },
          },
        };
      });
      return requestEpoch;
    },

    markIsolatedServerStatusListRefreshFailed: (
      scopeKey,
      error,
      requestEpoch,
      mode = "connect",
    ) => {
      const epochs = getIsolatedStatusListEpochs(scopeKey);
      if (requestEpoch !== epochs[mode] || mode === "status") {
        // status-only 轮询是只读 best-effort；临时失败不能清空已有授权快照。
        return;
      }
      set((state) => {
        const snapshot = state.isolatedServerSnapshots[scopeKey];
        if (!snapshot) {
          return {};
        }
        return {
          isolatedServerSnapshots: {
            ...state.isolatedServerSnapshots,
            [scopeKey]: {
              ...snapshot,
              statusSnapshots: {},
              servers: snapshot.servers.map((server): ZCodeMcpServer => {
                const enabled = snapshot.enabledStates[server.id] ?? server.enabled;
                if (
                  server.source !== "zcodeagentmcp" ||
                  !enabled ||
                  server.status !== "connecting"
                ) {
                  return server;
                }
                return {
                  ...server,
                  status: "error",
                  authorization: undefined,
                  error,
                  failureKind: "status_unavailable",
                  serverRequestId: undefined,
                  toolCount: undefined,
                };
              }),
            },
          },
        };
      });
    },

    mergeIsolatedServerStatusSnapshots: (scopeKey, statuses, requestEpoch, mode = "connect") => {
      const epochs = getIsolatedStatusListEpochs(scopeKey);
      if (requestEpoch !== epochs[mode]) {
        return;
      }
      set((state) => {
        const snapshot = state.isolatedServerSnapshots[scopeKey];
        if (!snapshot) {
          return {};
        }
        const nextStatusSnapshots =
          mode === "status" ? { ...snapshot.statusSnapshots, ...statuses } : statuses;
        return {
          isolatedServerSnapshots: {
            ...state.isolatedServerSnapshots,
            [scopeKey]: {
              ...snapshot,
              statusSnapshots: nextStatusSnapshots,
              servers: mergeMcpServerStatusSnapshots(snapshot.servers, nextStatusSnapshots, {
                markMissingConnectingAsError: mode !== "status",
              }),
            },
          },
        };
      });
    },
  };
});
