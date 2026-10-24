// 照搬上游 v3.16.2 ui/settings/settingsSourceWorkspace.ts（backlog-sweep Step 11）：
// 设置页「当前作用于哪台 Source」的纯逻辑。Source 为空即本机 scope；拿不到 Source 事实时
// 只有本机 scope 可以回落，远端 scope 必须显式 unavailable（见下方判定规则）。
//
// 归属判定规则（唯一口径，各 section 不得自行拼装）：
// 1. 归属只认 `workspaceIdentity`：`remote:server:<sourceServerId>:<path>` 属于该 Source；
//    其它 remote identity（ssh / wsl / docker 旧链）不属于任何 Source；空 identity 或
//    非 remote identity 的项目属于本机（sourceServerId === null）。
// 2. 选中远端 Source（字符串）时，任何要读远端配置的锚点都必须先通过
//    workspaceBelongsToSettingsSource；校验不过一律按 unavailable 处理（显式空态），
//    绝不回退本机路径 / 本机服务——否则会把本机配置伪装成远端事实。
// 3. 远端 Source 的 user scope 不绑项目 identity，但必须由 Source 自己构造归属 identity
//    （home 路径 + buildServerRemoteWorkspaceIdentity）；拿不到 home 时返回 unavailable。
// 4. 本机 scope（sourceServerId === null）保留项目自身路径 / 身份，不伪造远端 authority；
//    没有项目锚点时读本机 user 配置，因此本机 scope 永远不会 unavailable。
// 5. 服务来源解析顺序（2026-10-24 补最后一公里）：已登记的 `source-settings` attachment
//    端口 → 锚点链 → unavailable。端口存在时四个分区直接用端口提供的
//    hooks/plugins/skills/subagents 服务，不要求设备已打开 workspace，也不伪造 workspace
//    锚点；端口迟到/释放经 sourceSettingsServiceStore 订阅自动重算。
import { useMemo } from "react";
import {
  buildServerRemoteWorkspaceIdentity,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import type {
  IHooksService,
  IPluginManagementService,
  IServiceAccessor,
  ISettingsSyncService,
  ISkillSyncService,
  ISkillsService,
  ISubagentsService,
} from "@zcode/services";
import { useSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

export function workspaceBelongsToSettingsSource(
  tab: Pick<WorkspaceTabState, "workspaceIdentity">,
  sourceServerId: string | null,
): boolean {
  const identity = tab.workspaceIdentity?.trim();
  if (!identity) return sourceServerId === null;
  const parsed = parseRemoteWorkspaceIdentity(identity);
  if (sourceServerId === null) return !isRemoteWorkspaceIdentity(identity);
  return parsed?.kind === "server" && parsed.sourceServerId === sourceServerId;
}

export function filterWorkspaceTabsForSettingsSource<
  T extends Pick<WorkspaceTabState, "workspaceIdentity">,
>(tabs: readonly T[], sourceServerId: string | null): T[] {
  return tabs.filter((tab) => workspaceBelongsToSettingsSource(tab, sourceServerId));
}

/** Source 设置投影的缓存权威键；本机 scope 不构造，避免把本机配置挂到远端 authority 下。 */
export function buildSettingsSourceAuthorityKey(sourceServerId: string): string {
  return `source-settings:${sourceServerId}`;
}

export function buildSourceSettingsProjectionKey(
  workspacePath: string | null | undefined,
  workspaceIdentity?: string,
  authorityKey?: string,
): string {
  const targetKey = workspaceIdentity?.trim() || workspacePath || "";
  const authority = authorityKey?.trim();
  return authority ? `${authority}\0${targetKey}` : targetKey;
}

/**
 * 投影是否已经对应当前 target（= loading 可以结束）。
 * 键口径必须与 {@link buildSourceSettingsProjectionKey} 一致：只比路径 / identity 而忽略
 * authorityKey 会让 Source scope 的投影永远「未加载」，页面停在 loading。
 */
export function isSettingsProjectionCurrent(params: {
  hasTarget: boolean;
  activeTargetKey: string;
  loadedTargetKey: string;
}): boolean {
  return !params.hasTarget || params.loadedTargetKey === params.activeTargetKey;
}

export interface SettingsSourceScopeAnchor<
  T extends Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">,
> {
  /** 该 Source 的已连接 workspace（顺序即优先级）；user scope 直接用它作 RPC 锚点。 */
  tab?: T;
  workspacePath?: string;
  workspaceIdentity?: string;
  /** false = 读不到该 Source 的配置，调用方必须渲染 unavailable 空态。 */
  available: boolean;
}

/**
 * 解析选中 Source 的配置锚点。候选顺序：已连接 workspace → 注入的项目 workspace
 * （必须校验归属）→ Source home（仅远端 Source，identity 由 Source 自己构造）。
 *
 * 本机 scope（sourceServerId === null）没有项目锚点时返回 `{ available: true }`：
 * 本机 user 配置不需要 workspace 锚点，直接走本机 Host。
 */
export function resolveSettingsSourceScopeAnchor<
  T extends Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">,
>(params: {
  sourceServerId: string | null;
  /** 已按 Source 过滤过的已连接 workspace。 */
  scopedTabs: readonly T[];
  /** 设置页注入的项目 workspace；可能属于别的设备，必须校验归属。 */
  fallbackWorkspacePath?: string | null;
  fallbackWorkspaceIdentity?: string;
  /** 该 Source 的 home（attachment 快照），只对远端 Source 生效。 */
  sourceHomeDir?: string;
}): SettingsSourceScopeAnchor<T> {
  const tab = params.scopedTabs[0];
  if (tab) {
    return {
      tab,
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity?.trim() || undefined,
      available: true,
    };
  }

  const fallbackPath = params.fallbackWorkspacePath?.trim() || undefined;
  const fallbackIdentity = params.fallbackWorkspaceIdentity?.trim() || undefined;
  if (
    (fallbackPath || fallbackIdentity) &&
    workspaceBelongsToSettingsSource({ workspaceIdentity: fallbackIdentity }, params.sourceServerId)
  ) {
    return { workspacePath: fallbackPath, workspaceIdentity: fallbackIdentity, available: true };
  }

  const home = params.sourceHomeDir?.trim();
  if (params.sourceServerId && home) {
    return {
      workspacePath: home,
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: params.sourceServerId,
        workspacePath: home,
      }),
      available: true,
    };
  }

  // 本机 scope：没有项目锚点也合法（本机 user 配置直接走本机 Host）。
  if (params.sourceServerId === null) return { available: true };
  return { available: false };
}

/**
 * Source 设置 attachment 端口直接提供的配置服务。
 *
 * 只投影四个分区真正消费的读取面：`source-settings` scope 装配的服务集就是这四项
 * （hooks / plugin-management / skills / subagents），外加可选的 skill-sync / settings-sync。
 * 其余服务（尤其 model-selection / provider-settings）不在该通道注册，继续走 workspace
 * 解析——否则会把未注册的远端能力伪装成可用，或把本机 Provider 事实当成远端事实。
 */
export interface SettingsSourceCapabilityServices {
  hooksService: IHooksService;
  pluginManagementService: IPluginManagementService;
  skillsService: ISkillsService;
  subagentsService: ISubagentsService;
  /** 远端 Skill 同步面；旧 Source 的集合可能缺省，调用方回落 workspace 解析。 */
  skillSyncService?: ISkillSyncService;
  /** 技能导入的 settings-sync 面；缺省时同样回落 workspace 解析。 */
  settingsSyncService?: ISettingsSyncService;
}

/**
 * 从已登记的 Source 端口服务里投影四个分区的配置能力。
 * `undefined` = 端口缺席（可能迟到）或服务集不完整；调用方必须继续走锚点链，
 * 不得用空实现顶替——空列表会被误解成「该设备确实没有配置」。
 */
export function resolveSettingsSourceCapabilityServices(
  services: IServiceAccessor | undefined,
): SettingsSourceCapabilityServices | undefined {
  if (!services) return undefined;
  const hooksService = services.hooksService;
  const pluginManagementService = services.pluginManagementService;
  const skillsService = services.skillsService;
  const subagentsService = services.subagentsService;
  // 装配期 createSourceSettingsServiceCollection 已保证这四项存在；运行期仍显式校验，
  // 避免旧 attachment / 测试 double 把 undefined 当服务传进 store 后静默失败。
  if (!hooksService || !pluginManagementService || !skillsService || !subagentsService) {
    return undefined;
  }
  return {
    hooksService,
    pluginManagementService,
    skillsService,
    subagentsService,
    ...(services.skillSyncService ? { skillSyncService: services.skillSyncService } : {}),
    ...(services.settingsSyncService ? { settingsSyncService: services.settingsSyncService } : {}),
  };
}

/**
 * 端口路由下的 user-scope RPC 路径占位。
 *
 * 端口服务按 `source-settings` scope 直连设备，本身不携带 workspace 归属；但
 * hooks / plugins / skills / subagents 的契约都要求一个 `workspacePath` 入参（且
 * `nonEmptyString`）。user scope 只读用户目录，因此这里给一个稳定、明确不存在的路径：
 * 既满足入参校验，又保证任何路径回退都读不到别的项目配置。不得据此构造
 * `workspaceIdentity`——端口路由不伪造 workspace authority。
 */
export function buildSettingsSourceUserScopeRpcPath(sourceServerId: string): string {
  return `source-settings://${sourceServerId}/user`;
}

/** Source 设置面的三态解析结果：端口 → 锚点链 → 显式不可用。 */
export type SettingsSourceServiceRouteKind = "port" | "anchor" | "unavailable";

export interface SettingsSourceServiceRoute<
  T extends Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">,
> {
  kind: SettingsSourceServiceRouteKind;
  /** 仅 kind === "port"：由 attachment 端口直接提供的四个分区服务。 */
  capabilities?: SettingsSourceCapabilityServices;
  /** 锚点解析结果；端口路由下仍保留，用于路径复用与缓存权威键。 */
  anchor: SettingsSourceScopeAnchor<T>;
  /** 仅 kind === "port"：user scope 的 RPC 路径（优先复用锚点路径，否则用稳定占位路径）。 */
  userScopeRpcPath?: string;
}

/**
 * 选区解析顺序（唯一口径）：已登记端口 → 锚点链 → unavailable。
 *
 * - 端口只对真实 Source（字符串 id）生效；本机 scope（null）没有 attachment。
 * - 端口存在时不要求锚点：这正是「设备在线但没打开 workspace」也能编辑配置的路径。
 * - 端口缺席（迟到 / 已释放）时行为与旧链完全一致：锚点可用走锚点，否则显式不可用。
 */
export function resolveSettingsSourceServiceRoute<
  T extends Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">,
>(params: {
  sourceServerId: string | null;
  /** 端口注册表里该 Source 的访问面；undefined = 尚未登记或已释放。 */
  portServices?: IServiceAccessor;
  anchor: SettingsSourceScopeAnchor<T>;
}): SettingsSourceServiceRoute<T> {
  if (params.sourceServerId) {
    const capabilities = resolveSettingsSourceCapabilityServices(params.portServices);
    if (capabilities) {
      const anchorPath = params.anchor.available
        ? params.anchor.workspacePath?.trim() || undefined
        : undefined;
      return {
        kind: "port",
        capabilities,
        anchor: params.anchor,
        userScopeRpcPath: anchorPath ?? buildSettingsSourceUserScopeRpcPath(params.sourceServerId),
      };
    }
  }
  return {
    kind: params.anchor.available ? "anchor" : "unavailable",
    anchor: params.anchor,
  };
}

/**
 * 分区用的端口订阅版解析：端口登记 / 释放都会触发重算。
 *
 * `settingsSourceServerId === undefined`（本机设置页）返回 undefined，调用方保持旧行为；
 * `null`（本机 Source）或宿主机不支持端口时，结果与锚点链一致。
 */
export function useSettingsSourceServiceRoute<
  T extends Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">,
>(params: {
  settingsSourceServerId: string | null | undefined;
  /** 已按 Source 过滤过的已连接 workspace。 */
  scopedTabs: readonly T[];
  fallbackWorkspacePath?: string | null;
  fallbackWorkspaceIdentity?: string;
  sourceHomeDir?: string;
}): SettingsSourceServiceRoute<T> | undefined {
  const enabled = params.settingsSourceServerId !== undefined;
  const sourceServerId = params.settingsSourceServerId ?? null;
  // 订阅注册表：端口迟到（先开设置页、后登记）与释放（掉线/删除）都必须自动重算，
  // 不允许要求用户重新选择设备。useSyncExternalStore 的 snapshot 就是端口服务对象本身。
  const portServices = useSourceSettingsServices(params.settingsSourceServerId ?? undefined);
  return useMemo(() => {
    if (!enabled) return undefined;
    return resolveSettingsSourceServiceRoute({
      sourceServerId,
      portServices,
      anchor: resolveSettingsSourceScopeAnchor({
        sourceServerId,
        scopedTabs: params.scopedTabs,
        fallbackWorkspacePath: params.fallbackWorkspacePath,
        fallbackWorkspaceIdentity: params.fallbackWorkspaceIdentity,
        sourceHomeDir: params.sourceHomeDir,
      }),
    });
  }, [
    enabled,
    portServices,
    sourceServerId,
    params.fallbackWorkspaceIdentity,
    params.fallbackWorkspacePath,
    params.scopedTabs,
    params.sourceHomeDir,
  ]);
}

export interface SourceSettingsHomeSnapshot {
  sourceServerId: string;
  homedir: string;
}

export interface SourceSettingsValueSnapshot<T> {
  sourceServerId: string;
  value: T;
}

export function resolveSettingsSourceServerSelection(params: {
  pendingTarget: { sourceServerId: string | null } | undefined;
  persistedSourceServerId: string | null | undefined;
  sourceServerIds: readonly string[];
}): string | null {
  // Bug 原因：显式本机跳转以前被折叠成 undefined，随后错误回退到旧远端偏好。
  // pendingTarget 是否存在才表示有无导航意图；其中 null 是有效的本机 Source。
  const preferred =
    params.pendingTarget === undefined
      ? (params.persistedSourceServerId ?? null)
      : params.pendingTarget.sourceServerId;
  return preferred && params.sourceServerIds.includes(preferred) ? preferred : null;
}

export function resolveSourceSettingsValue<T>(
  snapshot: SourceSettingsValueSnapshot<T> | null,
  selectedSourceServerId: string | null,
): T | null {
  return snapshot?.sourceServerId === selectedSourceServerId ? snapshot.value : null;
}

export function isSettingsSourceOnline(
  snapshot: {
    profiles: ReadonlyArray<{
      profileId: string;
      sourceServerId?: string;
      lifecycleState?: "active" | "retired";
    }>;
    states: ReadonlyArray<{ profileId: string; state: string }>;
  } | null,
  sourceServerId: string | null,
): boolean {
  if (!snapshot || !sourceServerId) return false;
  const activeProfileIds = new Set(
    snapshot.profiles
      .filter(
        (profile) =>
          profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
      )
      .map((profile) => profile.profileId),
  );
  return snapshot.states.some(
    (state) => activeProfileIds.has(state.profileId) && state.state === "online",
  );
}

export function resolveSourceSettingsHomeDir(
  snapshot: SourceSettingsHomeSnapshot | null,
  selectedSourceServerId: string | null,
): string | undefined {
  return snapshot?.sourceServerId === selectedSourceServerId ? snapshot.homedir : undefined;
}

export interface SettingsUserScopeTarget {
  workspacePath?: string;
  workspaceIdentity?: string;
  authorityKey?: string;
  /** true = 选中了远端 Source 但拿不到 home，调用方必须显示 unavailable。 */
  unavailable: boolean;
}

export function resolveSettingsUserScopeTarget(params: {
  sourceServerId: string | null;
  sourceHomeDir?: string;
  projectWorkspacePath?: string;
  projectWorkspaceIdentity?: string;
}): SettingsUserScopeTarget {
  const authorityKey = params.sourceServerId
    ? buildSettingsSourceAuthorityKey(params.sourceServerId)
    : undefined;
  if (params.sourceServerId) {
    const homedir = params.sourceHomeDir?.trim();
    if (!homedir) {
      // 远端 Source 的 user scope 没有可证明归属的锚点：显式 unavailable，绝不回落本机。
      return { authorityKey, unavailable: true };
    }
    // user scope 不携项目 identity，但必须由 Source 构造归属 identity——否则无法证明
    // 该锚点属于这台设备（「无 identity 即 unavailable」规则的唯一例外说明）。
    return {
      workspacePath: homedir,
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: params.sourceServerId,
        workspacePath: homedir,
      }),
      authorityKey,
      unavailable: false,
    };
  }
  // 本机 scope：拿不到 Source 时保留项目自身路径/身份，不伪造远端 authority。
  return {
    workspacePath: params.projectWorkspacePath,
    workspaceIdentity: params.projectWorkspaceIdentity,
    unavailable: false,
  };
}
