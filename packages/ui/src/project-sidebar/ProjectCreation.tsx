// 照搬上游 v3.16.2 ProjectCreation.tsx 并 omz 化（upstream-v316-fullsync P4.1，拍板②口径）：
// ①Source 管理/远端设备组整组剔除（useSourceServerManagementSnapshot、
//   buildAggregatedSourceStatusMap、IRemoteProjectService）——本机 Host 唯一形态；
// ②P4.2 起 store 有 draftProjectId：保存期间草稿失效守卫按上游 draftProjectId 对比，
//   draftFocusVersion 仍作 omz 侧草稿重建的补充近似；
// ③onCreateTask 按 omz CreateTaskOptions 口径（projectId/taskGroupId 增字段）；
//   composer draft handoff 上游 capture* 与 omz request/consume 形态不同，随 UI 提交链接。
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useEffect, useRef, useState } from "react";
import type {
  IProjectService,
  VirtualProject,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { logger } from "@/logger.js";

export function ProjectCreation({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  projects,
  service,
  onClose,
  onSaved,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  projects: VirtualProject[];
  service: IProjectService;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  useEffect(() => {
    logger.debug("[ProjectCreation] local creation open", { workspacePath });
  }, [workspacePath]);
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
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const saved = async (project: VirtualProject) => {
    if (!active.current) return;
    // 本机项目创建成功即置顶入口列表；远端入口登记随 R3 三期（omz 无 remoteService 面）。
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
      onClose={onClose}
      onSaved={saved}
      onSavedExisting={async (isCurrent) => {
        await onSaved();
        if (active.current && isCurrent?.()) onClose();
      }}
    />
  );
}
