// 照搬上游 v3.16.2 并 omz 化：
// ①web-remote-control 快路径不搬（relay v1 面，P9 清理）；
// ②远端项目 attach 分支不触发（IRemoteProjectService P4 恒缺席），保留参数形状兼容三期回补。
import { useCallback, useLayoutEffect, useRef } from "react";
import type {
  ProjectSidebarProps,
  ProjectTree,
  IRemoteProjectService,
} from "@/project-sidebar/contract.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

/** 打开任务才绑定 workspace；列表 mutation 不借导航创建 scope。 */
export function useProjectTaskNavigation(
  props: ProjectSidebarProps,
  tree: ProjectTree,
  remoteService?: IRemoteProjectService,
): ProjectSidebarProps["onSelectTask"] {
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const sequence = useRef(0);
  useLayoutEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const latest = useRef({ props, tree, remoteService, activeWorkspaceIdentity });
  useLayoutEffect(() => {
    latest.current = { props, tree, remoteService, activeWorkspaceIdentity };
  });
  return useCallback((path, taskId, identity, remoteSessionId, unreadAt) => {
    const request = ++sequence.current;
    const { props, tree, activeWorkspaceIdentity } = latest.current;
    const readFocus = () =>
      props.workspacePath
        ? useZCodeSessionStore
            .getState()
            .getWorkspaceState(props.workspacePath, activeWorkspaceIdentity ?? undefined)
        : undefined;
    const originFocus = readFocus();
    // 同一目录内切换任务或新草稿也会使旧连接失效，不能仅比较 workspace 身份。
    const isCurrent = () =>
      sequence.current === request &&
      latest.current.activeWorkspaceIdentity === activeWorkspaceIdentity &&
      readFocus()?.activeTaskId === originFocus?.activeTaskId &&
      readFocus()?.draftFocusVersion === originFocus?.draftFocusVersion &&
      (!identity ||
        latest.current.tree.tasks.some(
          (task) => task.taskId === taskId && task.workspaceIdentity === identity,
        ));
    const open = async () => {
      const task = tree.tasks.find(
        (item) =>
          item.taskId === taskId &&
          (item.workspaceIdentity || item.workspacePath) === (identity || path),
      );
      // omz P4：仅本机 Host；identity/远端绑定分支随 source-server 三期回补。
      if (identity && task && remoteService) {
        const directory = await remoteService.readDirectory();
        if (!isCurrent()) return;
        if (directory.hosts.some((host) => host.id === task.hostId)) {
          // 远端绑定链缺席：保持原样交由 onSelectTask 的现有 attachment 路由。
        }
      }
      props.onSelectTask(path, taskId, identity, remoteSessionId, unreadAt);
    };
    void open().catch((error) => {
      logger.error("[project-sidebar] 打开任务失败", error);
      toast(String(error));
    });
  }, []);
}
