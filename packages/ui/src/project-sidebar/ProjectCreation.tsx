// 照搬上游 v3.16.2 ProjectCreation.tsx 并 omz 化（upstream-v316-fullsync P4.1，拍板②口径；
// backlog-sweep Step 4 补设备面降级分支；设备管理往返按上游形态恢复）：
// ①Source 管理面（useSourceServerManagementSnapshot/buildAggregatedSourceStatusMap）不搬——
//   management 服务缺席时设备全集直接由 `directory.hosts` 投影（数据所有者裁定 §2：
//   设备行 = hosts 表投影，连接态另算），management snapshot 投影随 P9 换装；
// ②设备连接/添加设备按上游 preference 形态走 onOpenRemoteWorkspace
//   （completion:"device-management" + returnTarget kind connect-device/add-device）；
//   契约类型见 app-shell/types.ts 的 RemoteConnectionOpenPreference（挂载点/Root 同批落地）；
//   能力缺席（allowDeviceManagement=false 或回调未传）时保持 remoteService.connectHost 降级路径；
// ③设备行带 Source 身份（backlog-sweep 缺陷修复）：server 形态 host（`remote:server:<id>`）
//   由统一 identity 工具反解出 sourceServerId；向导返回时必须仍是同一 Source，不一致明确失败，
//   不能静默放行把另一台设备的目录写进草稿。向导入口不再携带「选中设备的 Source」当期望值：
//   Root 只按本次实际连上的 target 反解 Source（Root.tsx 的 resolveDeviceAdditionSourceServerId）。
//   设备行的 sourceServerId 同时作为「能不能归属 Source」的能力标记随 returnTarget 透传
//   （deviceSourceServerId）：有值 = server 形态设备，Root 反解失败时按可读失败收尾；
//   undefined = legacy ssh/wsl/docker host，没有 Source 归属，保持「报告 connected 即回原流程」，
//   Root 不得把成功连接降级成取消。
// ④P4.2 起 store 有 draftProjectId：保存期间草稿失效守卫按上游 draftProjectId 对比，
//   draftFocusVersion 仍作 omz 侧草稿重建的补充近似；
// ⑤onCreateTask 按 omz CreateTaskOptions 口径（projectId/taskGroupId 增字段）；
//   composer draft handoff 上游 capture* 与 omz request/consume 形态不同，随 UI 提交链接；
// ⑥`directory`/`remoteService` 为可选：侧栏本机入口不传即保持纯本机形态（零行为变化），
//   远端入口传入后设备面自动升级；目录投影恒有 `{hosts:[],entries:[]}`（空数组 truthy），
//   所以设备面按「有设备行 || 挂载点允许设备管理」判定，不能让空投影把纯本机形态变成下拉；
// ⑦向导往返期间 ProjectEditor 让位（suspended）：后台取消只解除连接等待，
//   原草稿在用户回到原 tab 前仍保持隐藏。
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
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
import {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { logger } from "@/logger.js";

/**
 * 设备行的 Source 身份（backlog-sweep 缺陷修复，Workspace Identity 约束）：
 * hosts 表只存 host 身份键，server 形态（`remote:server:<sourceServerId>`）必须经统一
 * identity 工具反解，禁止在本文件手写 authority 拆解；legacy ssh/wsl/docker 设备没有
 * Source 归属，返回 undefined（向导回传无身份可比）。
 * 与 Host 侧 `RemoteConnectionProgressSection.sourceServerIdForHost` 同一解析。
 */
function projectDevice(host: RemoteProjectHost): ProjectDevice {
  const sourceServerId = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(host.id, "/"),
  )?.sourceServerId;
  return {
    id: host.id,
    label: remoteHostLabel(host),
    status: host.connectionStatus ?? "offline",
    ...(sourceServerId ? { sourceServerId } : {}),
  };
}

/**
 * 设备面投影（backlog-sweep 缺陷修复）：
 * ①设备行带 Source 身份（见 projectDevice）；
 * ②「本机入口不传即纯本机」——useProjectTree 的初始 directory 恒为 `{hosts:[],entries:[]}`，
 *   空数组是 truthy；无条件透传会让 ProjectEditor 在纯本机形态也渲染设备下拉。
 *   只有存在设备行、或挂载点显式允许设备管理（需要「添加远程设备…」入口）时才启用设备面。
 */
export function selectProjectDevices(
  directory: RemoteProjectDirectory | undefined,
  allowDeviceManagement: boolean,
): ProjectDevice[] | undefined {
  const hosts = directory?.hosts ?? [];
  if (!directory || (hosts.length === 0 && !allowDeviceManagement)) return undefined;
  return hosts.map(projectDevice);
}

export function ProjectCreation({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  projects,
  directory,
  service,
  remoteService,
  defaultDeviceId,
  allowDeviceManagement = false,
  onOpenRemoteWorkspace,
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
  /** 是否允许设备面发起「连接/添加设备」向导往返；权限来源由挂载点决定（上游 :48）。 */
  allowDeviceManagement?: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
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
  // 向导往返请求的身份守卫：只有当前请求可以 resolve，迟到或被替换的 finish 一律丢弃。
  const [connection, setConnection] = useState<{
    device?: ProjectDevice;
    resolve(ready: boolean): void;
  } | null>(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const addition = useRef<object | null>(null);
  const pendingConnection = useRef(connection);
  // 成员代换守卫：保存跨了异步边界后，旧 host 的 membershipId 不得再登记入口。
  const admittedHosts = useRef(new Map<string, RemoteProjectHost>());
  // 每轮目录投影同步成员快照；本轮缺失的 id 保留旧快照，交给 prepareHost 的换代判断处理。
  for (const host of directory?.hosts ?? []) admittedHosts.current.set(host.id, host);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      addition.current = null;
      // 卸载时解除后台连接等待；原草稿保持隐藏，等用户回到原 tab 前不再提交。
      pendingConnection.current?.resolve(false);
    };
  }, []);
  // 设备面降级：management 服务缺席时，设备行就是 hosts 表投影（连接态取连接管理器投影）。
  const devices = selectProjectDevices(directory, allowDeviceManagement);
  // 设备管理能力只在挂载点显式允许时接管连接；回调按上游 preference 契约透传。
  const openDeviceWizard = allowDeviceManagement ? onOpenRemoteWorkspace : undefined;
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
    if (openDeviceWizard) {
      return new Promise<boolean>((resolve, reject) => {
        const request = { device, resolve };
        pendingConnection.current = request;
        setConnection(request);
        const accepted = openDeviceWizard({
          completion: "device-management",
          returnTarget: {
            kind: "connect-device",
            // 能力标记而非期望值：有值 = server 形态设备（必须确认本次连上的仍是同一
            // Source），undefined = legacy ssh/wsl/docker 设备（没有 Source 归属，
            // 反解失败也按 connected 回原流程）。判定见 root/deviceAdditionSource.ts 的
            // requiresResolvedDeviceAdditionSource。
            deviceSourceServerId: device.sourceServerId,
            isCurrent: () => active.current && pendingConnection.current === request,
            finish: (result) => {
              if (!active.current || pendingConnection.current !== request) return;
              pendingConnection.current = null;
              setConnection(null);
              if (result.kind !== "connected") {
                resolve(false);
                return;
              }
              // 原目录/已有项目 continuation 只接受所选 Source：向导可以改选线路，返回的
              // Source 与选中设备不一致时明确失败，不能把另一台设备的目录写进当前草稿。
              // 复用 connection-unavailable 文案（「此设备不可用，请在设置中重新连接」），
              // 由 ProjectEditor 的错误行展示；legacy 设备没有 Source 归属，无身份可比。
              if (
                device.sourceServerId !== undefined &&
                result.sourceServerId !== device.sourceServerId
              ) {
                logger.warn("[ProjectCreation] device connection returned another source", {
                  deviceId: device.id,
                  expectedSourceServerId: device.sourceServerId,
                  actualSourceServerId: result.sourceServerId,
                });
                reject(new Error("project.connection-unavailable"));
                return;
              }
              resolve(true);
            },
          },
        });
        if (accepted === false) {
          pendingConnection.current = null;
          setConnection(null);
          resolve(false);
        }
      });
    }
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
      // 向导往返期间原对话框让位：后台取消只解除连接等待，回到原 tab 后仍保留草稿。
      suspended={Boolean(connection) || addingDevice || activeTabId !== originTabId.current}
      onConnectDevice={remoteService || openDeviceWizard ? connectDevice : undefined}
      onAddDevice={
        openDeviceWizard
          ? (selectDevice) => {
              const request = {};
              addition.current = request;
              setAddingDevice(true);
              const accepted = openDeviceWizard({
                completion: "device-management",
                returnTarget: {
                  kind: "add-device",
                  isCurrent: () => active.current && addition.current === request,
                  finish: async (result) => {
                    if (!active.current || addition.current !== request) return;
                    addition.current = null;
                    setAddingDevice(false);
                    if (result.kind !== "connected" || !result.sourceServerId) return;
                    // 返回仍走同一个设备切换入口，不能绕过原草稿的目录确认。
                    const hostId = remoteHostIdFromWorkspaceIdentity(
                      buildServerRemoteWorkspaceIdentity({
                        serverId: result.sourceServerId,
                        workspacePath: "/",
                      }),
                    );
                    if (hostId) await selectDevice(hostId);
                  },
                },
              });
              if (accepted === false) {
                addition.current = null;
                setAddingDevice(false);
              }
            }
          : undefined
      }
    />
  );
}
