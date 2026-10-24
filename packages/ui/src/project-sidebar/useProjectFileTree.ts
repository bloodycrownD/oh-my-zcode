// 照搬上游 v3.16.2 project-sidebar/useProjectFileTree.ts 并 omz 化（backlog-sweep Step 5 顺手补）：
// ①删 webRemoteControlWorkspaceSwitcher 分支（relay v2 跨设备切换，omz 无该 prop）；
// ②onOpenFileManager 由骨架内文件树承接（omz 无 side-pane 文件管理器 tab）：
//   ProjectSidebar 传入包装后的 props，把 target 直接交给侧栏内 WorkspaceFileTree 浮层。
import { useCallback, useEffect, useRef } from "react";
import type {
  IRemoteProjectService,
  ProjectSidebarProps,
  ProjectTask,
  RemoteProjectDirectory,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { getPathLeaf } from "@/lib/path.js";
import { resolveProjectFileTarget } from "@/project-sidebar/project-file-navigation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

export function useProjectFileTree(
  props: ProjectSidebarProps,
  directory: RemoteProjectDirectory,
  remoteService?: IRemoteProjectService,
) {
  const request = useRef(0);
  const consumedRequest = useRef<ProjectSidebarProps["fileTreeOpenRequest"]>(null);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    const next = props.fileTreeOpenRequest;
    if (!next || consumedRequest.current === next || !props.onOpenFileManager) return;
    consumedRequest.current = next;
    request.current++;
    props.onOpenFileManager(next.target);
  }, [props.fileTreeOpenRequest, props.onOpenFileManager]);
  const openFiles = useCallback(
    async (project: VirtualProject, rootPath: string) => {
      const generation = ++request.current;
      const target = await resolveProjectFileTarget({
        project,
        rootPath,
        props,
        remoteService,
        isRemote: directory.hosts.some((host) => host.id === project.hostId),
        // omz RemoteWorkspaceSession 不含 workspaceIdentity 字段，绑定关系只由
        // sessionIdByWorkspaceIdentity 索引承载（同 path 不同远端不互相覆盖）。
        findSession: (identity) => {
          const sessionId =
            useRemoteWorkspaceSessionStore.getState().sessionIdByWorkspaceIdentity[identity];
          return sessionId ? { sessionId } : undefined;
        },
      });
      // 原因：连接完成可能晚于另一次查看/关闭，旧目标不得覆盖最新文件树选择。
      if (target && generation === request.current) props.onOpenFileManager?.(target);
    },
    [props, directory, remoteService],
  );

  const openTaskFiles = useCallback(
    async (task: ProjectTask, remoteSessionId?: string) => {
      const generation = ++request.current;
      const identity = task.workspaceIdentity?.trim();
      const sessions = useRemoteWorkspaceSessionStore.getState();
      const boundSessionId = identity ? sessions.sessionIdByWorkspaceIdentity[identity] : undefined;
      const sessionId = boundSessionId ?? remoteSessionId;
      // 原因：远端 cwd 可与本地同名；只接受该任务 identity 对应索引绑定的 session，
      // 不能退回本机读取，也不能借用同 path 的其它 attachment。
      if (identity && !boundSessionId) throw new Error("project.connection-unavailable");
      if (generation !== request.current) return;
      props.onOpenFileManager?.({
        workspacePath: task.workspacePath,
        workspaceName: getPathLeaf(task.workspacePath) || task.workspacePath,
        ...(identity ? { workspaceIdentity: identity, workspaceRemoteSessionId: sessionId } : {}),
      });
    },
    [props.onOpenFileManager],
  );
  return { openFiles, openTaskFiles };
}
