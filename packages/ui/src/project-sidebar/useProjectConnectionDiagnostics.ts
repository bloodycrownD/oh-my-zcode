// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批）并 omz 化：
// reconnectingRemoteWorkspaceKeys 输入 omz ProjectSidebarProps 无（恢复中键集合随恢复
// 状态机 UI 批回补）；entries 遍历在 omz 投影下恒空（无入口缓存），保留形状兼容。
import { useMemo } from "react";
import {
  remoteHostIdFromWorkspaceIdentity,
  type ProjectSidebarProps,
  type RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";

/**
 * 只合并 Host 投影与旧 workspace 的连接错误；连接进度由详情直接读连接管理服务的操作日志。
 * 修复原因：原先这里订阅 requestId 文本日志，但该通道 Host 未注入、Main 未登记，侧栏始终拿到空日志。
 */
export function useProjectConnectionDiagnostics(
  directory: RemoteProjectDirectory,
  props: ProjectSidebarProps,
) {
  return useMemo(
    () =>
      new Map(
        directory.hosts.map((host) => {
          const keys = new Set<string>(
            Object.keys(props.remoteWorkspaceErrorByWorkspaceKey ?? {}).filter(
              (key) => remoteHostIdFromWorkspaceIdentity(key) === host.id,
            ),
          );
          for (const entry of directory.entries)
            if (entry.hostId === host.id && entry.legacyWorkspace?.workspaceIdentity)
              keys.add(entry.legacyWorkspace.workspaceIdentity);
          return [
            host.id,
            {
              error:
                host.connectionStatus === "online"
                  ? undefined
                  : host.lastConnectionError ||
                    [...keys]
                      .map((key) => props.remoteWorkspaceErrorByWorkspaceKey?.[key])
                      .find(Boolean),
            },
          ];
        }),
      ),
    [directory, props.remoteWorkspaceErrorByWorkspaceKey],
  );
}
