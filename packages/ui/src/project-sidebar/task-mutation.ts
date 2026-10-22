import type {
  ProjectTaskRef,
  IZCodeTaskService,
  IWindowControllerService,
  WindowHostControllerMutation,
  WindowHostTaskAddress,
} from "@/project-sidebar/contract.js";
export type ProjectTaskMutation =
  | Exclude<WindowHostControllerMutation, { kind: "open" | "resume" }>
  | { kind: "rename"; title: string };
interface ProjectTaskPorts {
  service: IZCodeTaskService;
  controller?: IWindowControllerService;
}
function taskAddress(task: ProjectTaskRef, remoteSessionId?: string | null): WindowHostTaskAddress {
  // omz：remote-workspace-identity 无 server kind/sourceServerId（source-server face 随三期）。
  return {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
  };
}
// omz 化：omz IWindowControllerService 无 getTaskMeta（跨 source 行为随 R3 三期补），
// 已读 meta 只走本机 task service；mutateTask 命令面与上游一致保留双路由。
/** 已查看事件读取唯一 owner 的 marker；不借用 UI 行缓存，也不跨 Source 使用本机服务。 */
export function readProjectTaskMeta(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  _remoteSessionId?: string,
) {
  return ports.service.getTaskMeta(task);
}
/** 两个列表入口共用完整地址与命令路由；组织态和 CLI 事实仍各自只由原 owner 写入。 */
export async function mutateProjectTask(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  mutation: ProjectTaskMutation,
  remoteSessionId?: string | null,
) {
  const target = {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  };
  if (ports.controller && mutation.kind !== "rename")
    return ports.controller.mutateTask({
      address: taskAddress(task, remoteSessionId),
      mutation,
    });
  switch (mutation.kind) {
    case "archive":
      return mutation.archived
        ? ports.service.archiveTask(target)
        : ports.service.unarchiveTask(target);
    case "delete":
      await ports.service.deleteTask(target);
      return null;
    case "rename":
      return ports.service.renameTask({ ...target, title: mutation.title });
    case "pin":
      return ports.service.setTaskPinned({ ...target, pinned: mutation.pinned });
    case "mark-read":
      return ports.service.setTaskUnread({
        ...target,
        unread: false,
        expectedUnreadAt: mutation.expectedUnreadAt,
      });
    case "mark-unread":
      return ports.service.setTaskUnread({ ...target, unread: true });
  }
}
