// 照搬上游 v3.16.2 `.reference/ZCode/packages/services/src/remote-projects/connection-membership.ts`
// （backlog-sweep Step 1，fork 纪律：host_id 派生与 admission 时序逐字保真）。
// omz 漂移（spec r5 P0-1 裁定）：omz 的 `RemoteTarget`/`RemoteTargetSnapshot` 联合只含
// ssh/wsl/docker，不含上游的 `kind:"server"`（URL 直连传输）；URL Server 仍经 LEGACY
// deployServer 旧链。因此 `prepareRemoteServerConnection` 的入参在本仓恒为 never，函数体
// 按上游 URL Server 目标形状实现并保留导出面，实际消费方随传输批开放。
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type ConnectionProfile,
  type RemoteTarget,
  type RemoteTargetSnapshot,
} from "@zcode/shared";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";

/** 上游 URL Server 直连目标形状；仅本文件内部使用（omz 联合类型不含该 kind）。 */
interface RemoteServerTarget {
  kind: "server";
  url: string;
  name?: string;
  workspacePath?: string;
  serverId?: string;
  tokenCredentialKey?: string;
  token?: string;
}

function isRemoteServerTarget(target: unknown): target is RemoteServerTarget {
  return Boolean(target) && (target as { kind?: unknown }).kind === "server";
}

/**
 * 从持久化快照里取 URL Server 目标：omz 的 `RemoteTargetSnapshot` 联合不含该 kind，
 * 直接用类型谓词会把已声明类型收窄成 never，故统一经 unknown 读取。
 */
function readRemoteServerTarget(target: unknown): RemoteServerTarget | undefined {
  return isRemoteServerTarget(target) ? target : undefined;
}

export function remoteProjectHostIdForTarget(
  target: RemoteTarget,
  sourceServerId?: string,
): string {
  const identity = sourceServerId
    ? buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" })
    : buildRemoteWorkspaceIdentity("/", target);
  const hostId = remoteHostIdFromWorkspaceIdentity(identity);
  if (!hostId) throw new Error("remote-project.invalid-host-identity");
  return hostId;
}

export function remoteProjectHostIdForProfile(profile: ConnectionProfile): string {
  return remoteProjectHostIdForTarget(profile.target, profile.sourceServerId);
}

/** URL transport 沿用 CredentialService；成员服务只收到不含 secret 的连接快照。 */
export async function prepareRemoteServerConnection(input: {
  service: IRemoteProjectService;
  credentials: {
    load(key: string): Promise<string | null>;
    save(key: string, value: string): Promise<void>;
  };
  target: Extract<RemoteTarget, { kind: "server" }>;
  intent: "add" | "retain";
}) {
  const requested = input.target as unknown as RemoteServerTarget;
  const directory = await input.service.readDirectory();
  const requestedId = remoteProjectHostIdForTarget(requested as unknown as RemoteTarget);
  const existing =
    directory.hosts.find((host) => host.id === requestedId) ??
    (!requested.serverId
      ? directory.hosts.find((host) => readRemoteServerTarget(host.target)?.url === requested.url)
      : undefined);
  if (input.intent === "retain" && !existing) throw new Error("remote-project.host-removed");
  const saved = readRemoteServerTarget(existing?.target);
  const id = existing?.id ?? requestedId;
  const tokenCredentialKey =
    saved?.tokenCredentialKey ?? (requested.token ? `remote-server:${id}:token` : undefined);
  if (input.intent === "add" && requested.token && tokenCredentialKey)
    await input.credentials.save(tokenCredentialKey, requested.token);
  // 上游在此调用 stripRemoteTargetSecrets；omz 该工具不含 server 分支，等价地只剔除 token。
  const { token: _token, ...requestedWithoutSecret } = requested;
  const target =
    input.intent === "retain" && saved
      ? saved
      : {
          ...requestedWithoutSecret,
          ...(saved?.serverId ? { serverId: saved.serverId } : {}),
          ...(tokenCredentialKey ? { tokenCredentialKey } : {}),
        };
  const host =
    input.intent === "add"
      ? await input.service.saveHost({
          id,
          target: target as unknown as RemoteTargetSnapshot,
        })
      : existing!;
  const connectionTarget = readRemoteServerTarget(host.target);
  if (!connectionTarget) throw new Error("remote-project.invalid-server");
  const { tokenCredentialKey: key, ...connectionTargetWithoutSecret } = connectionTarget;
  const token = key ? await input.credentials.load(key) : undefined;
  if (key && !token) throw new Error("remote-project.credential-unavailable");
  return {
    target: { ...connectionTargetWithoutSecret, ...(token ? { token } : {}) },
    async commit(sourceServerId: string) {
      const bound = await input.service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId: remoteProjectHostIdForTarget(
          connectionTargetWithoutSecret as unknown as RemoteTarget,
          sourceServerId,
        ),
      });
      if (!bound) throw new Error("remote-project.host-removed");
    },
  };
}

/** 注入既有连接管理器；成员关系不承担网络状态、重试或凭据解析。 */
export function createRemoteProjectConnectionAdmission(service: IRemoteProjectService) {
  return async (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }): Promise<(sourceServerId: string) => Promise<void>> => {
    const id = remoteProjectHostIdForProfile(input.profile);
    const host =
      input.intent === "add"
        ? await service.saveHost({ id, target: input.profile.target })
        : (await service.readDirectory()).hosts.find((item) => item.id === id);
    if (!host) throw new Error("remote-project.host-removed");
    return async (sourceServerId) => {
      const resolvedId = remoteProjectHostIdForProfile({ ...input.profile, sourceServerId });
      const bound = await service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId,
        createDistinctHost: input.confirmIdentityChange,
      });
      if (!bound) throw new Error("remote-project.host-removed");
    };
  };
}
