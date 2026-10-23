// 照搬上游 v3.16.2 并 omz 化（P7 末批 Remote* 回填接线）：
// ①connect/onRemoveEntry/设备设置跳转——前两者本批接真（IRemoteProjectService 已注册），
//   设备设置跳转随 P9 设置页批（omz 设置无 remoteDevices 段）挂账；
// ②手机远控项目侧栏位已随 relay v1 清理删除（omz 无该面）。
import { memo } from "react";
import { shallow } from "zustand/shallow";
import { Plug } from "lucide-react";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectRowAction,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { buildRemoteHostWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

export function runProjectAction(body: () => Promise<void>) {
  void body().catch((cause) => {
    logger.error("[project-sidebar] 操作失败", cause);
    toast(String(cause));
  });
}

type Props = Pick<
  ProjectNodeProps,
  | "project"
  | "remoteHost"
  | "deviceLabel"
  | "diagnostics"
  | "expanded"
  | "hasUnread"
  | "availability"
  | "tasks"
  | "onSelect"
  | "refresh"
> &
  Pick<ProjectSidebarProps, "isDesktop" | "onCreateTask" | "onReconnectRemoteWorkspace"> & {
    service?: IProjectService;
    remoteService?: IRemoteProjectService;
    onExpandedChange(project: VirtualProject, expanded: boolean): void;
    onEdit(value: { project: VirtualProject }): void;
    onViewFiles?(project: VirtualProject, rootPath: string): Promise<void>;
    remoteActions(project: VirtualProject): ProjectRowAction[];
  };

// Bug 根因：任务活动每秒更新目录，父组件随之重建所有项目的菜单与回调，穿透内容层 memo。
// 按项目隔离装配；数组只比较元素与顺序，其余属性完整比较，真实状态和回调变化仍需更新。
export const ProjectSidebarNode = memo(
  function ProjectSidebarNode({
    project,
    remoteHost,
    service,
    remoteService,
    isDesktop,
    onCreateTask,
    onReconnectRemoteWorkspace,
    onExpandedChange,
    onEdit,
    onViewFiles,
    remoteActions,
    ...display
  }: Props) {
    const { intl } = useZCodeIntl();
    const confirm = useConfirmDialog();
    useTabStoreApi();
    const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
    // P9 挂账：设备设置跳转需 omz 设置「远程设备」段（setPendingSettingsSectionIntent
    // "remoteDevices"）；段位就位前不注入该 action，悬浮卡 pending 态只有详情无跳转。
    const { refresh, availability } = display;
    return (
      <ProjectNode
        {...display}
        project={project}
        remoteHost={remoteHost}
        additionalActions={[
          ...remoteActions(project),
          ...(remoteHost && remoteHost.connectionStatus !== "online"
            ? [
                {
                  id: "connect",
                  label: msg("connect"),
                  icon: Plug,
                  run: () =>
                    runProjectAction(async () => {
                      // 远端连接仍经现有意图分派，保留缺凭据、安装和升级流程。
                      if (isDesktop && project.roots[0] && onReconnectRemoteWorkspace) {
                        await onReconnectRemoteWorkspace(
                          buildRemoteHostWorkspaceIdentity(
                            project.hostId,
                            project.roots[0].rootPath,
                          ),
                        );
                      } else {
                        await remoteService!.connectHost(project.hostId);
                      }
                      await refresh();
                    }),
                },
              ]
            : []),
        ]}
        onExpandedChange={(expanded) => onExpandedChange(project, expanded)}
        onRemoveEntry={() =>
          runProjectAction(async () => {
            const entryId = availability?.entryId;
            if (!entryId || !remoteService) throw new Error("remote-project.entry-not-found");
            await remoteService.removeEntry(entryId);
            await refresh();
          })
        }
        onCreate={() =>
          runProjectAction(async () => {
            onCreateTask({
              projectId: project.id,
              taskGroupId: null,
              ...(remoteHost ? { hostId: project.hostId } : {}),
            });
          })
        }
        onEdit={() => onEdit({ project })}
        onViewFiles={(rootPath) => {
          if (!onViewFiles) return;
          runProjectAction(() => onViewFiles(project, rootPath));
        }}
        onDelete={() =>
          runProjectAction(async () => {
            await service!.deleteProject(project.id, project.hostId);
            await refresh();
          })
        }
        onPin={() =>
          runProjectAction(async () => {
            await service!.saveProject({
              id: project.id,
              hostId: project.hostId,
              pinned: !project.pinned,
            });
            await refresh();
          })
        }
        onMove={(task) =>
          runProjectAction(async () => {
            if (!service) return;
            try {
              await service.moveTask({ task, projectId: project.id, hostId: project.hostId });
            } catch (cause) {
              if (
                project.hostId !== "local" ||
                !String(cause).includes("project.root-confirmation-required")
              )
                throw cause;
              if (!(await confirm({ title: msg("addFolder"), description: task.workspacePath })))
                return;
              await service.moveTask({
                task,
                projectId: project.id,
                hostId: project.hostId,
                addMissingRoot: true,
              });
            }
            await refresh();
          })
        }
      />
    );
  },
  (previous, next) => {
    const { tasks: previousTasks, ...previousProps } = previous;
    const { tasks: nextTasks, ...nextProps } = next;
    return shallow(previousProps, nextProps) && shallow(previousTasks, nextTasks);
  },
);
