// 照搬上游 v3.16.2 `.reference/ZCode/packages/services/src/remote-projects/workspace-settings.ts`
// （backlog-sweep Step 1，fork 纪律：实现逐字保真）。
// 单向兼容投影：settings 只从同一 SQLite 快照派生，不读取旧集合重建成员。
// omz 现状（spec 数据所有者裁定 §4）：`setWorkspaceProjection` 本轮不接线，本模块
// 仅作 remote-projects 依赖面在库（knip 消费方随 P3 设置投影批），不改变设置权威。
import {
  buildRemoteHostWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type AppSettings,
  type PersistedWorkspaceSessionEntry,
} from "@zcode/shared";
import type { VirtualProject } from "#src/project-storage/contract.js";
import type { RemoteProjectDirectory, RemoteProjectHost } from "#src/remote-projects/contract.js";

const key = (entry: PersistedWorkspaceSessionEntry) =>
  entry.kind === "local"
    ? entry.workspacePath
    : entry.workspaceIdentity?.trim() ||
      buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);

/** 单向兼容投影。输入必须是同一 SQLite 快照，不读取旧集合重建成员。 */
export function projectWorkspaceSettings(
  projects: readonly VirtualProject[],
  directory: RemoteProjectDirectory,
  settings: AppSettings,
): Pick<
  AppSettings,
  "lastActiveWorkspace" | "lastWorkspaceSession" | "recentProjects" | "lastActiveTabIndex"
> {
  const localPaths = [
    ...new Set(
      projects
        .filter((project) => !project.deleted)
        .flatMap((project) => project.roots.map((root) => root.rootPath)),
    ),
  ];
  const lastWorkspaceSession: PersistedWorkspaceSessionEntry[] = localPaths.map(
    (workspacePath) => ({ kind: "local", workspacePath, workspacePurpose: "project" }),
  );
  const hosts = new Map(directory.hosts.map((host) => [host.id, host]));
  const identityOrder = [...localPaths];
  const seen = new Set<string>();
  for (const entry of directory.entries) {
    const host = hosts.get(entry.hostId);
    if (!host?.target) continue;
    const paths = entry.roots.length
      ? entry.roots.map((root) => root.rootPath)
      : entry.legacyWorkspace
        ? [entry.legacyWorkspace.workspacePath]
        : [];
    for (const workspacePath of paths) {
      const stableKey = buildRemoteHostWorkspaceIdentity(host.id, workspacePath);
      if (seen.has(stableKey)) continue;
      seen.add(stableKey);
      identityOrder.push(stableKey);
      const legacy =
        entry.legacyWorkspace?.workspacePath === workspacePath ? entry.legacyWorkspace : null;
      const target = legacy?.target ?? host.target;
      // 旧版通过 snapshot 中的实际 credential key 取凭据；不制造无值的镜像 key。
      lastWorkspaceSession.push({
        ...legacy,
        kind: "remote",
        workspacePath,
        workspaceIdentity:
          legacy?.workspaceIdentity &&
          parseRemoteWorkspaceIdentity(legacy.workspaceIdentity)?.kind !== "server"
            ? legacy.workspaceIdentity
            : buildRemoteWorkspaceIdentity(workspacePath, target),
        workspacePurpose: "project",
        target,
        lastOpenedAt: legacy?.lastOpenedAt ?? host.lastOpenedAt ?? 0,
        lastConnectionStatus: legacy?.lastConnectionStatus ?? "connected",
      });
    }
  }

  // 只在新字段缺席的首次升级取旧选择；null 是已经清空，不再被旧 index 填回。
  let active =
    settings.lastActiveWorkspace === undefined
      ? (settings.lastWorkspaceSession?.[settings.lastActiveTabIndex ?? 0] ?? null)
      : settings.lastActiveWorkspace;
  if (active?.kind === "remote") {
    const identity = key(active);
    let host: RemoteProjectHost | undefined = hosts.get(
      remoteHostIdFromWorkspaceIdentity(identity) ?? "",
    );
    if (!host && parseRemoteWorkspaceIdentity(identity)?.kind !== "server") {
      const route = remoteHostIdFromWorkspaceIdentity(
        buildRemoteWorkspaceIdentity(active.workspacePath, active.target),
      );
      const matches = directory.hosts.filter(
        (candidate) =>
          candidate.target &&
          remoteHostIdFromWorkspaceIdentity(
            buildRemoteWorkspaceIdentity(active!.workspacePath, candidate.target),
          ) === route,
      );
      if (matches.length === 1) host = matches[0];
    }
    const retained =
      host &&
      directory.entries.some(
        (entry) =>
          entry.hostId === host.id &&
          (entry.roots.some((root) => root.rootPath === active!.workspacePath) ||
            entry.legacyWorkspace?.workspacePath === active!.workspacePath),
      );
    active =
      host?.target && (retained || active.workspacePurpose === "conversation")
        ? {
            ...active,
            target: host.target,
            workspaceIdentity: buildRemoteHostWorkspaceIdentity(host.id, active.workspacePath),
          }
        : null;
  }
  const activeIndex = active ? identityOrder.indexOf(key(active)) : -1;
  return {
    lastActiveWorkspace: active,
    lastWorkspaceSession,
    recentProjects: localPaths.slice(0, 10),
    lastActiveTabIndex: Math.max(0, activeIndex),
  };
}
