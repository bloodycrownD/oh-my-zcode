import type { Locale, RemoteTarget } from "@zcode/shared";
import type { LucideIcon } from "lucide-react";
import type {
  AppProps,
  CreateTaskRequest,
  RemoteWorkspaceRecoveryStatus,
} from "@/app-shell/types.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { Theme } from "@/useTheme.js";
export { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "@zcode/services";
export type { WebRemoteControlMobileTaskView, WebRemoteControlStatus } from "@zcode/shared";
export interface ProjectDevice {
  id: string;
  label: string;
  status: string;
  sourceServerId?: string;
}

export interface ProjectRowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  run(): void;
  disabled?: boolean;
  destructive?: boolean;
}
export {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
export type {
  WindowHostTaskAddress,
  WindowHostControllerTaskActivity,
} from "@zcode/shared/zcode-protocol-v4";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  SaveProjectInput,
  IProjectService,
  IWindowControllerService,
  IZCodeTaskService,
  WindowHostControllerMutation,
  WindowHostControllerFrame,
  WindowHostTaskUnreadSignal,
  IRemoteProjectService,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  RemoteProjectHost,
} from "@zcode/services";
export interface ProjectAvailability {
  entryId?: string;
  /** 仅首次升级入口用于替换旧排序键，不改变项目身份。 */
  upgradeEntryId?: string;
  online: boolean;
  unresolved?: boolean;
}
export type { Locale, Theme };
export type ProjectSidebarView = "projects" | "grouped" | "timeline";
/**
 * 侧栏底部账号展示所需的最小用户信息。
 * 升级 316 说明：上游把 UserInfo 放在 @zcode/shared 的 oauth 域，fork 随官方账号体系整体移除了
 * 该域（见 removed-features 的 ZCodeProviderAccountAccess 一类），shared 不再导出 UserInfo。
 * 这里保留侧栏契约里的 user 入口，用本地结构描述，避免把已删除的账号体系重新引回 shared。
 */
export interface ProjectSidebarUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}
export interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}
export interface SidebarFileTreeOpenRequest {
  id: number;
  target: SidebarFileTreeTarget;
}
/** 项目、时间线共用同一 Host 行集合；回调只负责现有导航，不维护组织状态。 */
export interface ProjectSidebarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activePreviewPath?: string | null;
  onOpenFileManager?: (target: SidebarFileTreeTarget) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
  fileTreeOpenRequest?: SidebarFileTreeOpenRequest | null;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask: () => void;
  onCreateConversationTaskOnSource?: (sourceServerId: string) => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  webRemoteControlWorkspaceSwitcher?: import("@/root/types.js").WebRemoteControlWorkspaceSwitcherApi;
  theme: Theme;
  onConnectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: { confirmSourceServerInstall?: boolean },
    feedback?: import("@/app-shell/types.js").RemoteConnectionFeedbackOptions,
  ) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    preparedWorkspaceIdentity?: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: ProjectSidebarUser | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceRecoveryByWorkspaceKey?: Record<string, RemoteWorkspaceRecoveryStatus>;
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  /**
   * fork 保留：重连过程中逐条累积的远程连接日志，按 workspaceKey 归档。
   * 升级 316 说明：上游 project-sidebar 只消费 remoteWorkspaceErrorByWorkspaceKey + reconnecting
   * 键集合，没有日志明细入口；为了不改动 WorkspaceShellLayout 的接线（以及手机远控重连面板
   * 复用同一份日志），契约里继续保留该可选字段，由后续侧栏组件按需渲染。
   */
  reconnectingRemoteWorkspaceLogsByWorkspaceKey?: Record<
    string,
    import("@/hooks/useRemoteConnectionLogs.js").RemoteConnectionLogEntry[]
  >;
  isDesktop?: boolean;
  isWebRemoteControl?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  toggleSidebarShortcutLabel?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  goBackShortcutLabel?: string;
  goForwardShortcutLabel?: string;
  onOpenCommandCenter: () => void;
  onOpenRepoWiki?: () => void;
  repoWikiActive?: boolean;
  onOpenAutomations?: () => void;
  onOpenPluginStore?: () => void;
  automationsActive?: boolean;
  pluginStoreActive?: boolean;
  onFileTreeOpenChange?: (open: boolean) => void;
  onWebRemoteTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onWebRemoteTaskSwitchingChange?: (switching: boolean) => void;
}
