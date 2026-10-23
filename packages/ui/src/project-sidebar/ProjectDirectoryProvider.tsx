// 照搬上游 v3.16.2 并 omz 化：
// ①P7 末批：deviceNames 改为 directory.hosts 投影（remoteHostLabel）——设备显示名权威
//   （useSourceServerManagementSnapshot 的 displayName）随 P9 设置页批换装；
// ②useTaskGroups 已随 P4.1 接真（ITaskGroupService 由 node.ts 注册 + client 出代理；
//   accessor 缺席时 available=false 降级空结构）。omz 旧侧栏 organizeGrouped 并存不删。
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { countProjectTreeUnreadTasks, selectSortedProjects } from "@/project-sidebar/view.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";
import { useTaskGroups } from "@/project-sidebar/useTaskGroups.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

function useDirectoryState(isDesktop: boolean) {
  const result = useProjectTree(isDesktop);
  const groups = useTaskGroups(result.factTree);
  const sortedProjects = useMemo(
    () => selectSortedProjects(result.factTree),
    [result.factTree.projects],
  );
  const preferences = useProjectSidebarPreferences(
    sortedProjects,
    result.loading,
    result.availability,
  );
  const projects = useMemo(() => {
    const sorted = preferences.sort(sortedProjects);
    return [...sorted.filter((p) => p.pinned), ...sorted.filter((p) => !p.pinned)];
  }, [sortedProjects, preferences.order]);
  const deviceNames = useMemo(
    () => new Map(result.directory.hosts.map((host) => [host.id, remoteHostLabel(host)])),
    [result.directory.hosts],
  );
  // Context 不受消费方 memo 保护；父级更新 children 时，等价目录不能再次广播。
  return useMemo(
    () => ({
      ...result,
      preferences,
      projects,
      groups,
      deviceNames,
    }),
    [result, preferences, projects, groups, deviceNames],
  );
}
const Context = createContext<ReturnType<typeof useDirectoryState> | null>(null);
/** 侧栏和 composer 共享读取与偏好，避免各自订阅后出现两份项目目录。 */
export function ProjectDirectoryProvider({
  children,
  isDesktop = false,
}: {
  children: ReactNode;
  isDesktop?: boolean;
}) {
  const existing = useContext(Context);
  return existing ? children : <DirectoryOwner isDesktop={isDesktop}>{children}</DirectoryOwner>;
}
function DirectoryOwner({ children, isDesktop }: { children: ReactNode; isDesktop: boolean }) {
  const directory = useDirectoryState(isDesktop);
  // 任务栏/托盘角标与侧栏蓝点同源：数权威树的未读任务（过滤与 projectHasUnread 一致）。
  // 挂在 Provider owner（Root 顶层，常驻不卸载）而不是 ProjectSidebar：侧栏卸载期间
  // 后台完成的未读变化也要同步到任务栏/托盘。嵌入 pane / 测试环境无 Provider 时跳过。
  const platform = useOptionalPlatform();
  // 任务通知开关同时门控任务栏/托盘角标：关掉通知 = 连常驻提醒一起关闭
  // （同步 0 清空角标），侧栏蓝点作为应用内状态不受影响。
  const notificationEnabled = useZCodeStoreWithDefault((state) => state.notificationEnabled, true);
  const unreadTaskCount = useMemo(
    () => countProjectTreeUnreadTasks(directory.tree),
    [directory.tree],
  );
  useEffect(() => {
    platform?.syncWindowUnreadCount(notificationEnabled ? unreadTaskCount : 0);
  }, [platform, notificationEnabled, unreadTaskCount]);
  return <Context.Provider value={directory}>{children}</Context.Provider>;
}
export function useProjectDirectory() {
  const directory = useContext(Context);
  if (!directory) throw new Error("project.directory-provider-required");
  return directory;
}

/** 嵌入式 pane 可无侧栏；完整 Shell 必须使用同一目录 owner。 */
export function useOptionalProjectDirectory() {
  return useContext(Context);
}
