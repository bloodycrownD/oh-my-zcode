// 照搬上游 v3.16.2 project-sidebar/index.tsx 并 omz 化（P4 首批范围收口 + P4.1 补全批）：
// ①Remote* 全家/useProjectRemoteSync/useProjectConnectionDiagnostics/web-remote-control 面剔除
//   （随 phase-remote-ux 三期回补）；
// ②P4.1：ProjectCreation/ProjectEditor 真组件挂载（编辑/新建入口自 toast 占位换真，
//   上游 index.tsx 同款 creating/editor state）；归档管理入口挂设置页（ArchiveManagement）；
// ③P4.1 拍板②：ProjectComposerMenu chip 挂项目树头部作为「新建项目」入口，
//   不替换 omz ChatEmptyWorkspacePreviewMenu；
// ④TaskGroupedView 分组视角随 grouped 批接入。
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { TID_SIDEBAR } from "@zcode/shared/test-ids";
import { SidebarTooltipProvider } from "@/ControlHintTooltip.js";
import type { ProjectSidebarProps, VirtualProject } from "@/project-sidebar/contract.js";
import { useProjectPinIntent } from "@/project-sidebar/useProjectPinIntent.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useProjectTaskNavigation } from "@/project-sidebar/useProjectTaskNavigation.js";
import { SortableProjects } from "@/project-sidebar/SortableProjects.js";
import {
  selectProjectRows,
  selectSortedProjects,
  projectKey,
  projectHasUnread,
} from "@/project-sidebar/view.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import {
  ProjectSidebarNode,
  runProjectAction as action,
} from "@/project-sidebar/ProjectSidebarNode.js";
import { ProjectSections } from "@/project-sidebar/ProjectSections.js";
import { ProjectSidebarListHeader } from "@/project-sidebar/ProjectSidebarListHeader.js";
import { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { TaskGroupedView } from "@/project-sidebar/TaskGroupedView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";

// 右侧面板显隐曾让所有项目的菜单和 Tooltip 重渲染；只隔离无关父更新，保留目录/context 订阅。
export const ProjectSidebar = memo(function ProjectSidebar(props: ProjectSidebarProps) {
  const {
    tree: authoritativeTree,
    // P7 续批接通：目录投影来自 useProjectTree（sourceServerDirectory 数据面经
    // IRemoteProjectService）；Remote* 组件挂载随后续批回补，此处先消除硬编码空集。
    directory,
    service,
    availability,
    refresh,
    error,
    loading,
    preferences,
  } = useProjectDirectory();
  const { tree, pin } = useProjectPinIntent(authoritativeTree);
  const onSelectTask = useProjectTaskNavigation(props, tree);
  const { intl } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const { view, setView } = preferences;
  const scrollRef = useRef<HTMLDivElement>(null);
  const taskPresentation = useMemo(
    () => ({
      activeWorkspaceKey: props.workspaceIdentity?.trim() || props.workspacePath,
      onPin: pin,
    }),
    [props.workspacePath, props.workspaceIdentity, pin],
  );
  // P4.1：编辑/新建对话框 owner 自 toast 占位升级为真组件（上游 index.tsx 同款状态）。
  const [editor, setEditor] = useState<{ project: VirtualProject | null } | null>(null);
  const [creating, setCreating] = useState(false);
  // grouped 视角的工具栏/吸顶组头 portal 目标（上游 groupedToolbar/groupedSticky 同职责）。
  const [groupedToolbar, setGroupedToolbar] = useState<HTMLDivElement | null>(null);
  const [groupedSticky, setGroupedSticky] = useState<HTMLDivElement | null>(null);
  const start = async (projectId?: string, taskGroupId?: string | null) => {
    // omz：CreateTaskOptions.taskGroupId 增字段消费链随 P4.2（UI 提交链）接；
    // 先把 grouped 视角的分组归属显式带上，缺省仍为 null。
    props.onCreateTask({
      projectId: projectId ?? null,
      taskGroupId: taskGroupId ?? null,
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
  // omz P4 首批：Footer/设置入口随 P4.1（ProjectSidebarNavigation 批）接入；预留 openSettings。
  void openSettings;
  const renderProject = (project: VirtualProject): ReactNode => (
    <ProjectSidebarNode
      key={projectKey(project)}
      project={project}
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
      isDesktop={props.isDesktop}
      onCreateTask={props.onCreateTask}
      onEdit={setEditor}
      onViewFiles={undefined}
      remoteActions={() => []}
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
              className="absolute inset-0 flex min-h-0 flex-col"
            >
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
                            onCreate={(groupId) => action(() => start(undefined, groupId))}
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
