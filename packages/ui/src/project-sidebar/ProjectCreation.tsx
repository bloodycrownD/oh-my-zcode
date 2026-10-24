// 照搬上游 v3.16.2 ProjectCreation.tsx 并 omz 化（upstream-v316-fullsync P4.1，拍板②口径；
// backlog-sweep Step 4 补设备面降级分支）：
// ①Source 管理面（useSourceServerManagementSnapshot/buildAggregatedSourceStatusMap）不搬——
//   P9 management 服务缺席时设备全集直接由 `directory.hosts` 投影（数据所有者裁定 §2：
//   设备行 = hosts 表投影，连接态另算）；
// ②`onAddDevice` 走 disable 分支（拍板 A）：上游依赖向导壳的 completion/returnTarget，
//   omz 的 onOpenRemoteWorkspace 无该配置面，故不传 onAddDevice（设备下拉不出现「添加设备」）；
// ③P4.2 起 store 有 draftProjectId：保存期间草稿失效守卫按上游 draftProjectId 对比，
//   draftFocusVersion 仍作 omz 侧草稿重建的补充近似；
// ④onCreateTask 按 omz CreateTaskOptions 口径（projectId/taskGroupId 增字段）；
//   composer draft handoff 上游 capture* 与 omz request/consume 形态不同，随 UI 提交链接；
// ⑤`directory`/`remoteService` 为可选：侧栏本机入口不传即保持纯本机形态（零行为变化），
//   远端入口传入后设备面自动升级。
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useEffect, useRef, useState } from "react";
import type {
  IProjectService,
  IRemoteProjectService,
  RemoteProjectDirectory,
  RemoteProjectHost,
  VirtualProject,
  ProjectDevice,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { logger } from "@/logger.js";

export function ProjectCreation({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  projects,
  directory,
  service,
  remoteService,
  defaultDeviceId,
  onClose,
  onSaved,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  projects: VirtualProject[];
  /** 远端入口传入目录投影后启用设备面；缺席时是纯本机创建。 */
  directory?: RemoteProjectDirectory;
  service: IProjectService;
  remoteService?: IRemoteProjectService;
  defaultDeviceId?: string;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  useEffect(() => {
    logger.debug("[ProjectCreation] creation open", {
      workspacePath,
      remoteDevices: directory?.hosts.length ?? 0,
    });
  }, [directory?.hosts.length, workspacePath]);
  const sidebar = useOptionalProjectDirectory();
  const activeTabId = useOptionalTabStore((state) => state.activeTabId);
  const originTabId = useRef(activeTabId);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const currentScope = useRef({ workspaceKey, activeTabId });
  currentScope.current = { workspaceKey, activeTabId };
  const [originDraft] = useState(() => {
    const { activeTaskId, draftFocusVersion, draftProjectId } = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    return { workspaceKey, activeTaskId, draftFocusVersion, draftProjectId };
  });
  const active = useRef(true);
  // 成员代换守卫：保存跨了异步边界后，旧 host 的 membershipId 不得再登记入口。
  const admittedHosts = useRef(new Map<string, RemoteProjectHost>());
  // 每轮目录投影同步成员快照；本轮缺失的 id 保留旧快照，交给 prepareHost 的换代判断处理。
  for (const host of directory?.hosts ?? []) admittedHosts.current.set(host.id, host);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // 设备面降级：management 服务缺席时，设备行就是 hosts 表投影（连接态取连接管理器投影）。
  const devices: ProjectDevice[] | undefined = directory
    ? directory.hosts.map((host) => ({
        id: host.id,
        label: remoteHostLabel(host),
        status: host.connectionStatus ?? "offline",
      }))
    : undefined;
  const prepareHost = async (hostId: string, isCurrent = () => active.current) => {
    if (hostId === "local" || !remoteService) return;
    const current = (await remoteService.readDirectory()).hosts.find((host) => host.id === hostId);
    if (!active.current || !isCurrent()) throw new Error("project.creation-cancelled");
    const previous = admittedHosts.current.get(hostId);
    if (previous && previous.membershipId !== current?.membershipId)
      throw new Error("remote-project.host-removed");
    if (!current) throw new Error("remote-project.host-removed");
    admittedHosts.current.set(hostId, current);
    return current;
  };
  const connectDevice = async (device: ProjectDevice): Promise<boolean> => {
    if (!remoteService) return false;
    const host = await remoteService.connectHost(device.id);
    if (!active.current) return false;
    admittedHosts.current.set(host.id, host);
    return true;
  };
  const saved = async (project: VirtualProject) => {
    if (!active.current) return;
    if (project.hostId !== "local" && remoteService) {
      // 远端创建与入口登记分两步：先确认成员仍在（membershipId 未换代），再登记入口。
      const host = admittedHosts.current.get(project.hostId);
      if (!host) throw new Error("remote-project.host-removed");
      await remoteService.addEntry({
        hostId: project.hostId,
        expectedMembershipId: host.membershipId,
        project: { projectId: project.id, name: project.name, roots: project.roots },
      });
      if (!active.current) return;
    }
    // 本机项目创建成功即置顶入口列表；远端入口已由 addEntry 落库并经 state:projects 广播。
    sidebar?.preferences.prepend(project);
    await onSaved();
    const draft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    // 创建原来只刷新列表，草稿仍绑定旧项目；复用项目选择入口，并拒绝保存期间已失效的草稿。
    if (
      active.current &&
      currentScope.current.activeTabId === originTabId.current &&
      currentScope.current.workspaceKey === originDraft.workspaceKey &&
      !originDraft.activeTaskId &&
      !draft.activeTaskId &&
      draft.draftProjectId === originDraft.draftProjectId &&
      draft.draftFocusVersion === originDraft.draftFocusVersion
    ) {
      logger.debug("[ProjectCreation] select created project for draft", {
        projectId: project.id,
        hostId: project.hostId,
      });
      onCreateTask({
        projectId: project.id,
      });
    }
  };
  return (
    <ProjectEditor
      project={null}
      projects={projects}
      service={service}
      devices={devices}
      defaultDeviceId={defaultDeviceId}
      remoteService={remoteService}
      onClose={onClose}
      onSaved={saved}
      onBeforeSave={async (hostId) => {
        await prepareHost(hostId);
      }}
      onSavedExisting={async (isCurrent) => {
        await onSaved();
        if (active.current && isCurrent?.()) onClose();
      }}
      onPrepareExisting={
        remoteService
          ? async (hostId, isCurrent) => {
              const host = await prepareHost(hostId, isCurrent);
              if (!host) throw new Error("remote-project.host-removed");
              return host;
            }
          : undefined
      }
      onBrowseExisting={(device) =>
        device.status === "online" ? Promise.resolve(true) : connectDevice(device)
      }
      onConnectDevice={remoteService ? connectDevice : undefined}
      // 拍板 A：onAddDevice 依赖向导壳（completion:"device-management"/returnTarget），本轮 disable。
    />
  );
}
