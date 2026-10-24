/* eslint-disable max-lines -- 侧栏骨架（导航/任务区/滚动/底部）+ 项目树对话框族同文件收口；
   上游 index.tsx 同形态，拆分会让目录 owner 与抽屉 owner 分散到两处（backlog-sweep Step 3）。 */
// 照搬上游 v3.16.2 project-sidebar/index.tsx 并 omz 化（P4 首批范围收口 + P4.1 补全批
// + P7 末批 Remote* 接线 + backlog-sweep Step 3 骨架重排）：
// ①P7 末批：useProjectRemoteSync/useProjectConnectionDiagnostics/RemoteProjectPicker 消费
//   面接线（remoteHost/deviceLabel/diagnostics/remoteActions/dialog 挂载）；remotePicker
//   触发面（设备行入口）随 P3 持久化批挂账（omz 投影 entries 恒空，入口流不可达）；
// ②P4.1：ProjectCreation/ProjectEditor 真组件挂载（编辑/新建入口自 toast 占位换真，
//   上游 index.tsx 同款 creating/editor state）；归档管理入口挂设置页（ArchiveManagement）；
// ③P4.1 拍板②：ProjectComposerMenu chip 挂项目树头部作为「新建项目」入口，
//   不替换 omz ChatEmptyWorkspacePreviewMenu；
// ④TaskGroupedView 分组视角随 grouped 批接入；
// ⑤backlog-sweep Step 3：骨架顺序改为 nav → task-list-region → scroll → footer（上游 :231/:232/:327），
//   顶层新建裸调用 + grouped 视角分组继承（activeTaskId→groups.parents，其次 draftTaskGroupId）；
// ⑥backlog-sweep Step 5：经典侧栏文件树滑层迁入骨架（omz 无 side-pane 文件管理器 tab），
//   useProjectFileTree 接通 onViewFiles/onOpenTaskFiles。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { TID_SIDEBAR } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { SidebarTooltipProvider } from "@/ControlHintTooltip.js";
import type {
  Locale,
  ProjectSidebarProps,
  SidebarFileTreeTarget,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { useProjectPinIntent } from "@/project-sidebar/useProjectPinIntent.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useProjectRemoteSync } from "@/project-sidebar/useProjectRemoteSync.js";
import { useProjectConnectionDiagnostics } from "@/project-sidebar/useProjectConnectionDiagnostics.js";
import { useProjectTaskNavigation } from "@/project-sidebar/useProjectTaskNavigation.js";
import { useProjectFileTree } from "@/project-sidebar/useProjectFileTree.js";
import { SortableProjects } from "@/project-sidebar/SortableProjects.js";
import {
  selectProjectRows,
  selectSortedProjects,
  projectKey,
  projectHasUnread,
  projectSourceServerId,
} from "@/project-sidebar/view.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import {
  ProjectSidebarNode,
  runProjectAction as action,
} from "@/project-sidebar/ProjectSidebarNode.js";
import { ProjectSections } from "@/project-sidebar/ProjectSections.js";
import { ProjectSidebarListHeader } from "@/project-sidebar/ProjectSidebarListHeader.js";
import { ProjectSidebarNavigation } from "@/project-sidebar/ProjectSidebarNavigation.js";
import { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { TaskGroupedView } from "@/project-sidebar/TaskGroupedView.js";
import { taskGroupKey } from "@/project-sidebar/grouped-view.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";

// 右侧面板显隐曾让所有项目的菜单和 Tooltip 重渲染；只隔离无关父更新，保留目录/context 订阅。
export const ProjectSidebar = memo(function ProjectSidebar(props: ProjectSidebarProps) {
  const {
    tree: authoritativeTree,
    // P7 续批接通：目录投影来自 useProjectTree（sourceServerDirectory 数据面经
    // IRemoteProjectService）；Remote* 组件挂载随 P7 末批接线。
    directory,
    service,
    remoteService,
    availability,
    refresh,
    error,
    loading,
    preferences,
    groups,
    deviceNames,
  } = useProjectDirectory();
  const { tree, pin } = useProjectPinIntent(authoritativeTree);
  const remoteSync = useProjectRemoteSync(directory);
  const diagnostics = useProjectConnectionDiagnostics(directory, props);
  const onSelectTask = useProjectTaskNavigation(props, tree, remoteService);
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const setTheme = useZCodeStore((state) => state.setTheme);
  const { view, setView } = preferences;
  const scrollRef = useRef<HTMLDivElement>(null);
  // 文件树滑层（经典侧栏同款）：omz 没有 side-pane 文件管理器 tab，入口只能落在侧栏内；
  // useProjectFileTree 的 target 与 Shell 的 markdown-link/git-reveal 请求共用同一目标态。
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(false);
  const [fileTreeTarget, setFileTreeTarget] = useState<SidebarFileTreeTarget | null>(null);
  const handleOpenFileTree = useCallback((target: SidebarFileTreeTarget) => {
    setFileTreeTarget(target);
    setIsFileTreeOpen(true);
  }, []);
  const fileTreeProps = useMemo<ProjectSidebarProps>(
    () => ({ ...props, onOpenFileManager: handleOpenFileTree }),
    [props, handleOpenFileTree],
  );
  const { openFiles, openTaskFiles } = useProjectFileTree(fileTreeProps, directory, remoteService);
  useEffect(() => {
    if (!props.fileTreeOpenRequest) {
      return;
    }
    handleOpenFileTree(props.fileTreeOpenRequest.target);
  }, [props.fileTreeOpenRequest, handleOpenFileTree]);
  useEffect(() => {
    props.onFileTreeOpenChange?.(isFileTreeOpen);
  }, [isFileTreeOpen, props.onFileTreeOpenChange]);
  useEffect(() => {
    return () => props.onFileTreeOpenChange?.(false);
  }, [props.onFileTreeOpenChange]);
  const taskPresentation = useMemo(
    () => ({
      activeWorkspaceKey: props.workspaceIdentity?.trim() || props.workspacePath,
      onPin: pin,
      onOpenTaskFiles: openTaskFiles,
    }),
    [props.workspacePath, props.workspaceIdentity, pin, openTaskFiles],
  );
  // P4.1：编辑/新建对话框 owner 自 toast 占位升级为真组件（上游 index.tsx 同款状态）。
  const [editor, setEditor] = useState<{ project: VirtualProject | null } | null>(null);
  const [creating, setCreating] = useState(false);
  // grouped 视角的工具栏/吸顶组头 portal 目标（上游 groupedToolbar/groupedSticky 同职责）。
  const [groupedToolbar, setGroupedToolbar] = useState<HTMLDivElement | null>(null);
  const [groupedSticky, setGroupedSticky] = useState<HTMLDivElement | null>(null);
  // 上游 :131-155：三参形态（projectId/hostId/taskGroupId）；分组继承只在 grouped 视角、
  // 且入口未指定项目时生效——先看当前会话所属组，再退回草稿分组意图。
  const start = async (projectId?: string, hostId?: string, taskGroupId?: string | null) => {
    const workspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(props.workspacePath, props.workspaceIdentity);
    const activeTaskId = workspaceState.activeTaskId;
    const inheritedGroup =
      view === "grouped" && !projectId
        ? activeTaskId
          ? (groups.parents.get(
              taskGroupKey({
                taskId: activeTaskId,
                workspacePath: props.workspacePath,
                workspaceIdentity: props.workspaceIdentity,
              }),
            ) ?? null)
          : (workspaceState.draftTaskGroupId ?? null)
        : null;
    props.onCreateTask({
      projectId: projectId ?? null,
      taskGroupId: taskGroupId === undefined ? inheritedGroup : taskGroupId,
      ...(hostId ? { hostId } : {}),
    });
  };
  const projects = preferences.sort(selectSortedProjects(tree));
  const expandableProjects = projects.filter(
    (project) => availability.get(projectKey(project))?.online !== false,
  );
  const hasExpandedProjects = expandableProjects.some(preferences.isExpanded);
  const reorder = (active: string, over: string) => {
    const source = projects.find((item) => projectKey(item) === active);
    const target = projects.find((item) => projectKey(item) === over);
    if (!source || !target || source.pinned !== target.pinned) return;
    preferences.reorder(
      projects.filter((item) => item.pinned === source.pinned),
      active,
      over,
    );
  };
  const openSettings = useCallback(() => {
    tabStore.getState().openSettingsTab();
  }, [tabStore]);
  const handleLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        setLocalePreference("system");
        return;
      }
      if (value === "zh-CN" || value === "en-US") {
        setLocalePreference(value as Locale);
      }
    },
    [setLocalePreference],
  );
  const handleThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        setTheme(value);
      }
    },
    [setTheme],
  );
  const renderProject = (project: VirtualProject): ReactNode => (
    <ProjectSidebarNode
      key={projectKey(project)}
      project={project}
      deviceLabel={deviceNames.get(projectSourceServerId(project) ?? "")}
      remoteHost={directory.hosts.find((host) => host.id === project.hostId)}
      diagnostics={diagnostics.get(project.hostId)}
      expanded={preferences.isExpanded(project)}
      onExpandedChange={preferences.setExpanded}
      hasUnread={projectHasUnread(authoritativeTree, project)}
      availability={availability.get(projectKey(project))}
      tasks={selectProjectRows(tree, {
        kind: "project",
        projectId: project.id,
        hostId: project.hostId,
      })}
      onSelect={onSelectTask}
      refresh={refresh}
      service={service}
      remoteService={remoteService}
      isDesktop={props.isDesktop}
      onCreateTask={props.onCreateTask}
      onReconnectRemoteWorkspace={props.onReconnectRemoteWorkspace}
      onEdit={setEditor}
      onViewFiles={openFiles}
      remoteActions={remoteSync.actions}
    />
  );
  return (
    <ProjectTaskListContext.Provider value={taskPresentation}>
      {/* 侧栏提示域（上游同款）：grouped 行内 SidebarNativeTooltip 统一 300ms 延迟。 */}
      <SidebarTooltipProvider>
        <aside data-testid={TID_SIDEBAR} className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="h-12 shrink-0 [app-region:drag]" />
          {/* 内联改名聚焦曾把 hidden 容器横向滚动，导致手机整栏左移；滑动面板只裁切，不允许焦点滚动。 */}
          <div className="relative min-h-0 flex-1 overflow-clip">
            <div
              data-project-sidebar-panel="navigation"
              className={cn(
                "absolute inset-0 flex min-h-0 flex-col transition-transform duration-200 ease-out",
                isFileTreeOpen && "-translate-x-full pointer-events-none",
              )}
              aria-hidden={isFileTreeOpen}
            >
              {/* 原因：顶层新建显式传 null 会抹掉当前项目；省略归属，让 Root 与快捷键共用继承路径。 */}
              <ProjectSidebarNavigation props={props} onCreate={() => props.onCreateTask()} />
              <div
                data-testid="sidebar-task-list-region"
                className="flex min-h-0 flex-1 flex-col border-t border-border/50 pt-3 [anchor-name:--sidebar-task-list-divider]"
              >
                <ProjectSidebarListHeader
                  onOpenCommandCenter={props.onOpenCommandCenter}
                  view={view}
                  onViewChange={setView}
                  actionsRef={setGroupedToolbar}
                >
                  {/* 拍板②：项目树内「新建项目」入口（项目 chip 菜单），omz 聊天空态菜单不替换。 */}
                  <ProjectComposerMenu
                    workspacePath={props.workspacePath}
                    workspaceIdentity={props.workspaceIdentity}
                    onCreateTask={props.onCreateTask}
                    onSelectConversationWorkspace={props.onCreateConversationTask}
                    triggerClassName="max-w-40 pl-2.5 pr-1.5"
                  />
                </ProjectSidebarListHeader>
                {/* 原因：仅设 overflow-y:auto 会让拖拽位移打开水平滚动；列表始终只允许纵向滚动。 */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {/* grouped 视角吸顶组头 portal 目标（上游同款）。 */}
                  <div ref={setGroupedSticky} />
                  <ScrollFadeViewport ref={scrollRef} className="overflow-x-hidden">
                    <div className="flex flex-col gap-3 pb-3">
                      {view === "projects" ? (
                        <>
                          <ProjectTaskRows
                            kind="pinned"
                            tasks={selectProjectRows(tree, { kind: "pinned" })}
                            onSelect={onSelectTask}
                            refresh={refresh}
                          />
                          {projects.filter((project) => project.pinned).length ? (
                            <SortableProjects
                              projects={projects.filter((project) => project.pinned)}
                              renderProject={renderProject}
                              onReorder={reorder}
                            />
                          ) : null}
                          <ProjectSections
                            tree={tree}
                            projects={projects}
                            directory={directory}
                            renderProject={renderProject}
                            onReorder={reorder}
                            loading={loading}
                            onSelect={onSelectTask}
                            refresh={refresh}
                            onCreate={() => action(() => start())}
                            onAddProject={() => {
                              // P4.1：新建入口换真组件（ProjectCreation 对话框）。
                              setCreating(true);
                            }}
                            hasExpandedProjects={hasExpandedProjects}
                            canToggleProjects={expandableProjects.length > 0}
                            onToggleProjects={() =>
                              preferences.setAllExpanded(expandableProjects, !hasExpandedProjects)
                            }
                          />
                        </>
                      ) : view === "grouped" ? (
                        <>
                          <ProjectTaskRows
                            kind="pinned"
                            tasks={selectProjectRows(tree, { kind: "pinned" })}
                            onSelect={onSelectTask}
                            refresh={refresh}
                          />
                          {/* P4.1：上游 grouped 视角（折叠/建组/拖拽分组）；omz 分组内草稿
                            继承与旧侧栏 organizeGrouped 并存不删。 */}
                          <TaskGroupedView
                            tasks={tree.tasks}
                            onSelect={onSelectTask}
                            refresh={refresh}
                            scrollRef={scrollRef}
                            toolbarTarget={groupedToolbar}
                            stickyTarget={groupedSticky}
                            workspacePath={props.workspacePath}
                            workspaceIdentity={props.workspaceIdentity}
                            onOpenAutomations={props.onOpenAutomations}
                            onCreate={(groupId) =>
                              action(() => start(undefined, undefined, groupId))
                            }
                          />
                        </>
                      ) : (
                        <ProjectTaskRows
                          key="timeline"
                          kind="timeline"
                          tasks={selectProjectRows(tree, { kind: view })}
                          onSelect={onSelectTask}
                          refresh={refresh}
                        />
                      )}
                      {loading ? (
                        <p className="px-4 text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({ id: "common.loading" })}
                        </p>
                      ) : null}
                      {error ? (
                        <p role="alert" className="px-4 text-ui-sm text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  </ScrollFadeViewport>
                </div>
              </div>
              <WorkspaceSidebarFooter
                className="pr-3"
                theme={props.theme}
                localeMenuValue={localePreference}
                onLocaleChange={handleLocaleChange}
                onThemeChange={handleThemeChange}
                onSettingsButtonClick={openSettings}
                workspacePath={props.workspacePath}
                workspaceIdentity={props.workspaceIdentity}
                workspaceRemoteSessionId={props.workspaceRemoteSessionId}
                isDesktop={props.isDesktop}
              />
            </div>
            {/* 文件树滑层（经典侧栏退役后由骨架承接）：markdown-link 跳转与「查看文件」共用。 */}
            <div
              className={cn(
                "absolute inset-0 transition-transform duration-200 ease-out",
                isFileTreeOpen ? "translate-x-0" : "translate-x-full pointer-events-none",
              )}
              aria-hidden={!isFileTreeOpen}
            >
              {fileTreeTarget ? (
                <WorkspaceFileTree
                  workspacePath={fileTreeTarget.workspacePath}
                  workspaceName={fileTreeTarget.workspaceName}
                  workspaceIdentity={fileTreeTarget.workspaceIdentity}
                  workspaceRemoteSessionId={fileTreeTarget.workspaceRemoteSessionId}
                  revealPath={fileTreeTarget.revealPath}
                  temporaryExternalDirectory={fileTreeTarget.temporaryExternalDirectory}
                  canOpenLocalFileManager={props.isDesktop}
                  activePreviewPath={props.activePreviewPath}
                  onClose={() => setIsFileTreeOpen(false)}
                  onOpenBrowserUrl={props.isDesktop ? props.onOpenBrowserUrl : undefined}
                  onOpenPreview={(source) => {
                    // 文件树可以查看非当前 workspace 的文件。
                    // 预览 source 携带 workspace 作用域，PreviewPane 才能用正确 host 读取远程文件；
                    // 同时不切换当前 workspace，避免"Add to chat"丢给错误的 composer。
                    props.onOpenCodeViewer?.({
                      ...source,
                      workspacePath: fileTreeTarget.workspacePath,
                      workspaceIdentity: fileTreeTarget.workspaceIdentity,
                      workspaceRemoteSessionId: fileTreeTarget.workspaceRemoteSessionId,
                    });
                  }}
                />
              ) : null}
            </div>
          </div>
          {/* P4.1：编辑/新建对话框挂侧栏根部（上游 index.tsx 同款）；omz 本机形态无远端设备面。 */}
          {creating && service ? (
            <ProjectCreation
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              onCreateTask={props.onCreateTask}
              projects={tree.projects}
              service={service}
              onClose={() => setCreating(false)}
              onSaved={refresh}
            />
          ) : null}
          {editor && service ? (
            <ProjectEditor
              key={editor.project?.id ?? "new"}
              project={editor.project}
              projects={tree.projects}
              service={service}
              onClose={() => setEditor(null)}
              onSaved={refresh}
              onDeleted={refresh}
            />
          ) : null}
          {/* 远端同步菜单（skills/mcp/plugins）的对话框 owner；actions 由 ProjectSidebarNode 消费。 */}
          {remoteSync.dialog}
        </aside>
      </SidebarTooltipProvider>
    </ProjectTaskListContext.Provider>
  );
});

export { readProjectSidebarView } from "@/project-sidebar/view-preference.js";
export { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
export { SidebarTooltipProvider } from "@/ControlHintTooltip.js";
export {
  ProjectDirectoryProvider,
  useOptionalProjectDirectory,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
export type {
  SidebarFileTreeOpenRequest,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";
