// omz IRemoteProjectService 实现（upstream-v316-fullsync P7 末批，拍板 B）：
// 数据面=SourceServerDirectory（设备/线路/工作区历史持久化权威）+连接管理器在线态的只读投影。
// 与上游 createRemoteProjectService 的差异（有意漂移，登记 spec ⑦）：
// ①不建上游 hosts/remote_project_entries SQLite 表——远端权威项目模型（addEntry/refreshEntry
//   入口缓存）随 P3 vproj-storage 批的 0004/0006 迁移面开放；本批 entries 恒空集，
//   侧栏远端项目行由此保持 omz 现状（不凭空出现离线行）。
// ②membershipId=sourceServerId（同一设备身份即同一成员；换代判定归 Directory
//   recordHandshake 的 identityChanged 权威，不在投影层复制上游 SQLite 成员表语义）。
// ③saveHost/bindHost/removeHost 等写面按 omz 消费现状挂账：上游消费方在向导壳/设备卡
//   （拍板 A 不迁移）与设置页设备卡（P9）；isRemoteProjectHostId 守卫 + 显式错误，
//   不静默伪造成功。
import {
  buildServerRemoteWorkspaceIdentity,
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type RemoteTargetSnapshot,
} from "@zcode/shared";
import type { RemoteProjectDirectory, RemoteProjectHost } from "@zcode/services";
import { IRemoteProjectService } from "@zcode/services";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import type {
  SourceServerConnectionManager,
  SourceServerConnectProfile,
} from "./sourceServerConnectionManager.js";

/** Host 级目录身份（remote:server:<sourceServerId>）；统一 identity 工具构造，禁手拼。 */
export function remoteProjectHostIdForSourceServer(sourceServerId: string): string {
  // 与上游 remoteProjectHostIdForTarget 的 server 分支同构：构造完整 identity 后
  // 由统一工具裁掉 path 段，Host 域不自行拼接/拆解 authority。
  const identity = buildServerRemoteWorkspaceIdentity({
    serverId: sourceServerId,
    workspacePath: "/",
  });
  const hostId = remoteHostIdFromWorkspaceIdentity(identity);
  if (!hostId) throw new Error("remote-project.invalid-host-identity");
  return hostId;
}

/** 从 Host 级目录身份提取 sourceServerId；非 server Host 返回 null。 */
export function sourceServerIdFromRemoteProjectHostId(hostId: string): string | null {
  // Host 级身份无 path 段，直接 parse 会失败；借 buildRemoteHostWorkspaceIdentity 补
  // path 段后走统一解析器提取（上游 bindHost 同款技巧）。
  const parsed = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(hostId, "/"),
  );
  return parsed?.kind === "server" ? (parsed.sourceServerId ?? null) : null;
}

/** 仅接受本服务投影出的 server Host 身份；其余形状在写边界显式拒绝。 */
export function isRemoteProjectHostId(hostId: string): boolean {
  return sourceServerIdFromRemoteProjectHostId(hostId) !== null;
}

export function createDirectoryRemoteProjectService(options: {
  directory(): SourceServerDirectory;
  manager(): SourceServerConnectionManager;
}): IRemoteProjectService {
  const projectHost = async (
    sourceServerId: string,
  ): Promise<RemoteProjectHost | null> => {
    const snapshot = await options.directory().snapshot();
    const server = snapshot.servers.find((entry) => entry.sourceServerId === sourceServerId);
    if (!server) return null;
    const profiles = snapshot.profiles.filter(
      (profile) =>
        profile.lifecycleState !== "retired" && profile.sourceServerId === sourceServerId,
    );
    // 展示线路=preferred 优先，其次最近连接；与 listStartupReconnectCandidates 同序。
    const preferred =
      profiles.find((profile) => profile.profileId === server.preferredProfileId) ??
      [...profiles].sort(
        (left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0),
      )[0];
    const manager = options.manager();
    const state = preferred ? manager.getStateByProfile(preferred.profileId) : undefined;
    const online = manager.getOnlineConnection(sourceServerId) ? "online" : undefined;
    // omz 连接状态机的进行中态（bootstrapping/retrying/updating）投影为 UI 三态的 connecting。
    const inFlight =
      state?.state === "bootstrapping" ||
      state?.state === "retrying" ||
      state?.state === "updating";
    const connectionStatus = online ?? (inFlight ? "connecting" : "offline");
    return {
      id: remoteProjectHostIdForSourceServer(sourceServerId),
      // 拍板②：同一 Source 设备即同一成员；换代由 Directory recordHandshake 权威判定。
      membershipId: sourceServerId,
      kind: (preferred?.transport ?? "ssh") as RemoteProjectHost["kind"],
      target: (preferred?.target ?? null) as RemoteTargetSnapshot | null,
      position: snapshot.servers.findIndex((entry) => entry.sourceServerId === sourceServerId),
      connectionStatus,
      ...(state?.error ? { lastConnectionError: state.error } : {}),
      ...(state?.state ? { lastConnectionStatus: state.state } : {}),
      ...(state?.upgradeTarget ? { upgradeTarget: state.upgradeTarget } : {}),
      ...(server.lastOnlineAt ? { lastOpenedAt: server.lastOnlineAt } : {}),
    };
  };

  const requireRemoteHost = async (hostId: string): Promise<RemoteProjectHost> => {
    const sourceServerId = sourceServerIdFromRemoteProjectHostId(hostId);
    if (!sourceServerId) throw new Error("remote-project.local-host");
    const host = await projectHost(sourceServerId);
    if (!host) throw new Error("remote-project.host-not-found");
    return host;
  };

  return {
    async readDirectory(): Promise<RemoteProjectDirectory> {
      const snapshot = await options.directory().snapshot();
      const hosts: RemoteProjectHost[] = [];
      for (const server of snapshot.servers) {
        const host = await projectHost(server.sourceServerId);
        if (host) hosts.push(host);
      }
      // 拍板差异①：entries 恒空（远端权威项目入口缓存随 P3 vproj-storage 开放）。
      return { hosts, entries: [] };
    },
    async connectHost(hostId) {
      const sourceServerId = sourceServerIdFromRemoteProjectHostId(
        (await requireRemoteHost(hostId)).id,
      );
      if (!sourceServerId) throw new Error("remote-project.local-host");
      const directory = options.directory();
      const snapshot = await directory.snapshot();
      const profiles = snapshot.profiles.filter(
        (profile) =>
          profile.lifecycleState !== "retired" && profile.sourceServerId === sourceServerId,
      );
      const server = snapshot.servers.find((entry) => entry.sourceServerId === sourceServerId);
      const profile =
        profiles.find((candidate) => candidate.profileId === server?.preferredProfileId) ??
        [...profiles].sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0))[0];
      if (!profile) throw new Error("remote-project.connector-unavailable");
      // 复用启动重连的同一凭据链；解析不出完整认证链=需要交互凭据，不静默降级。
      const target = await directory.resolveSilentConnectionTarget(profile.profileId);
      if (!target) throw new Error("remote-project.connector-unavailable");
      const connectProfile: SourceServerConnectProfile = {
        profileId: profile.profileId,
        sourceServerId,
        transport: profile.transport,
      };
      await options.manager().connect({
        profile: connectProfile,
        target,
        // retain：connectHost 只重连已登记成员，不新增成员（上游同语义）。
        membershipIntent: "retain",
      });
      const host = await projectHost(sourceServerId);
      if (!host) throw new Error("remote-project.host-removed");
      return host;
    },
    async saveHost() {
      // 拍板差异③：显式保存连接入口随向导壳/设备卡批（拍板 A/P9）接入；本投影无
      // hosts 表可写，伪造成功会让 UI 以为入口已登记。
      throw new Error("remote-project.save-host-unavailable");
    },
    async bindHost(input) {
      // 握手对回已由 Directory.recordHandshake 在 Manager 连接链完成（r3d 拍板）；
      // 这里只按当前目录投影回执，不存在即迟到/已移除返回 null（上游同语义）。
      const sourceServerId = sourceServerIdFromRemoteProjectHostId(input.resolvedId);
      if (!sourceServerId) return null;
      return await projectHost(sourceServerId);
    },
    async removeHost() {
      // 设备移除属设置页设备卡（P9）；目录投影不提供级联删除面。
      throw new Error("remote-project.remove-host-unavailable");
    },
    async addEntry() {
      // 远端权威项目入口缓存随 P3 vproj-storage 批开放；本批无表可写。
      throw new Error("remote-project.entry-persistence-unavailable");
    },
    async refreshEntry() {
      // entries 恒空 ⇒ project-tree-reader 不会对本服务调用 refreshEntry；
      // 保留 false 返回以匹配契约（迟到/不存在=不应用）。
      return false;
    },
    async removeEntry() {
      // 同 addEntry：无入口缓存可删；幂等 no-op 保持契约形状。
    },
  };
}
