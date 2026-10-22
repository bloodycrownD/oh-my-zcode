import type { SessionCreateSource } from "@zcode/shared";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";

export interface PendingCommandClientContext {
  workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  groupedDraftTask?: GroupedDraftTaskState;
  /** 首发捕获的虚拟项目归属（upstream-v316-fullsync P4.2）；重放时随命令重发，防迟到 ACK 丢归属。 */
  projectId?: string | null;
  /** 首发捕获的分组归属意图；重放后由 admit 组织链重新提交。 */
  taskGroupId?: string | null;
  sessionCreateSource?: SessionCreateSource;
}

interface WorkspaceScopedPendingCommand {
  clientContext?: PendingCommandClientContext;
  replay: {
    kind: "input" | "sensitiveDigest";
    type: string;
    payload?: Record<string, unknown>;
  };
}

function resolvePendingCommandWorkspaceKey(entry: WorkspaceScopedPendingCommand): string | null {
  const workspace = entry.clientContext?.workspace;
  if (workspace) {
    return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  }
  if (entry.replay.kind !== "input" || entry.replay.type !== "createSession") {
    return null;
  }
  // 兼容升级前已落盘的 createSession 恢复线索：协议 payload 的 workspaceId
  // 本身就是发起端 workspaceKey，不能因缺少新 clientContext 而跨 workspace 展示。
  const workspaceId = entry.replay.payload?.workspaceId;
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : null;
}

export function isPendingCommandForWorkspace(
  entry: WorkspaceScopedPendingCommand,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  return resolvePendingCommandWorkspaceKey(entry) === (workspaceIdentity?.trim() || workspacePath);
}
