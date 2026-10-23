// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批，拍板 B：Remote* 组件与同步链回填）。
import {
  parseRemoteWorkspaceIdentity,
  type SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface WorkspaceSourceResolutionOptions {
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
}

export function getWorkspaceSourceServerId(
  tab: Pick<WorkspaceTabState, "workspaceIdentity" | "workspacePath" | "remoteTarget">,
  options: WorkspaceSourceResolutionOptions = {},
): string | null {
  // omz：上游此处有 remoteTarget.kind==="server"（直连 URL）守卫；该传输形态不随本期
  // （拍板②，omz RemoteTarget 无 server variant），server 传输批回补时一并恢复。
  const parsed = tab.workspaceIdentity ? parseRemoteWorkspaceIdentity(tab.workspaceIdentity) : null;
  if (parsed?.kind === "server") return parsed.sourceServerId ?? null;

  const legacyWorkspaceIdentity = tab.workspaceIdentity?.trim();
  if (!legacyWorkspaceIdentity) return null;
  const matchingSourceServerIds = new Set(
    options.workspaceHistory
      ?.filter(
        (entry) =>
          entry.workspacePath === tab.workspacePath &&
          entry.legacyWorkspaceIdentity?.trim() === legacyWorkspaceIdentity &&
          Boolean(entry.sourceServerId?.trim()),
      )
      .map((entry) => entry.sourceServerId!.trim()) ?? [],
  );
  // 修复原因：旧版本回退兼容会在 lastWorkspaceSession 中保留 route identity，
  // 即使 Source Directory 已经确认设备，侧栏也会把同一个 tab 再画成“待识别线路”。
  // 这里只消费 Directory 已持久化的精确 legacy alias，不改写旧数据，也不按 hostname/账号猜测；
  // 若换代历史产生歧义则继续保持待识别，避免把 workspace 归到错误设备。
  return matchingSourceServerIds.size === 1
    ? (matchingSourceServerIds.values().next().value ?? null)
    : null;
}
