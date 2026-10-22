// 照搬上游 v3.16.2 ProjectComposerMenu.tsx 并 omz 化（upstream-v316-fullsync P4.1，拍板②）：
// ①不替换 omz ChatEmptyWorkspacePreviewMenu；本组件作为项目树内「新建项目」入口挂载
//   （ProjectSidebarListHeader 右端 chip：项目搜索/切换/脱离/新建）；
// ②Remote* 整组剔除：ChatRemoteFolderSelection/RemoteIdentityHoverCard/remoteHostLabel/
//   useRemoteConnectionEntryVisibility/onOpenRemoteWorkspace/addDevice 连接流（三期回补）；
// ③遥测面剔除：runUserAction/runUserActionAsync 直接调用操作（omz 无 userActionTelemetry）；
// ④omz store 草稿态无 draftProjectId/draftTaskGroupId 字段：当前项目勾选态与分组继承
//   暂缺（chip 回退「选择项目」文案），随 UI 提交链（P4.2）补 store 字段后恢复。
import type { ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import {
  ChevronDownIcon,
  FolderPlus,
  MessageCircle,
  SearchIcon,
  X,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import {
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_WORKSPACE_TRIGGER,
} from "@zcode/shared";

import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import { projectKey } from "@/project-sidebar/view.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export function ProjectComposerMenu({
  workspacePath,
  workspaceIdentity,
  allowConversationWorkspaceSelection = true,
  /** 是否显示项目 chip 的快捷脱离按钮；默认跟随非项目工作区选择能力。 */
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onCreateTask,
  onSelectConversationWorkspace,
  containerClassName,
  triggerClassName,
  triggerIndicator,
  children,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  allowConversationWorkspaceSelection?: boolean;
  allowConversationWorkspaceDetach?: boolean;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  onSelectConversationWorkspace: () => void | Promise<void>;
  /** 调用方局部调整 workspace chip 外层视觉，不改变普通会话默认样式。 */
  containerClassName?: string;
  /** 调用方局部调整 workspace trigger 视觉，不改变普通会话默认样式。 */
  triggerClassName?: string;
  /** 调用方局部替换尾部 indicator；普通会话继续使用默认 Lucide chevron。 */
  triggerIndicator?: ReactNode;
  /** 分支等控件位于项目选择器与编辑按钮之间。 */
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const { tree, projects, error, service, refresh } = useProjectDirectory();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId,
  );
  // omz：CreateTaskOptions 已有 projectId/taskGroupId 增字段（前批 WorkspaceShellLayout 定形）；
  // 分组继承依赖 store draftTaskGroupId（P4.2），当前传 null 保持显式无归属。
  const createProjectTask: ProjectSidebarProps["onCreateTask"] = (request) =>
    onCreateTask(
      typeof request === "object"
        ? {
            ...request,
            taskGroupId: null,
          }
        : request,
    );
  const draftVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 草稿重建和聊天切换都会使旧返回意图失效；omz 远端连接流剔除后无返回意图写入方，
  // 保留 chatKey/pending 的失效重置语义（omz 化：restoredChat/returnFocus 随 R3 回补）。
  const chatKey = JSON.stringify([workspaceKey, activeTaskId, draftVersion]);
  const trigger = useRef<HTMLButtonElement>(null);
  const setSubmissionPending = useContext(ComposerSubmissionPendingContext);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setSubmissionPending?.(pending);
    return () => setSubmissionPending?.(false);
  }, [pending, chatKey, setSubmissionPending]);
  useEffect(() => {
    setPending(false);
  }, [chatKey]);
  const [creating, setCreating] = useState(false);
  // omz：store 无 draftProjectId（P4.2）；当前项目身份在菜单内暂不勾选，仅提供切换/新建。
  const currentProject = undefined as VirtualProject | undefined;
  const isConversationWorkspace = !currentProject;
  const canDetachProject =
    allowConversationWorkspaceSelection && allowConversationWorkspaceDetach;
  const visibleProjects = useMemo(() => {
    const query = workspaceSearchQuery.trim().toLowerCase();
    return projects.filter((project) =>
      [project.name, ...project.roots.map((root) => root.rootPath)].some((text) =>
        text.toLowerCase().includes(query),
      ),
    );
  }, [projects, workspaceSearchQuery]);
  const currentWorkspaceTitle =
    currentProject?.name ?? intl.formatMessage({ id: "chat.empty.selectProject" });
  const currentWorkspaceIconClassName = cn(
    "size-4 text-foreground-subtle transition-opacity",
    // Bugfix: 关闭按钮和项目图标占用同一位置。只有允许脱离项目时才隐藏底层图标，
    // 否则 X 会直接叠在图标上；定时任务禁用该能力时则让项目图标保持可见。
    canDetachProject &&
      "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
  );

  const menu = (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              void onSelectConversationWorkspace();
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            ref={trigger}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
            <ProjectFolderIcon
              rootCount={currentProject?.roots.length ?? 0}
              className={currentWorkspaceIconClassName}
            />
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        data-testid="composer-project-menu"
        align="start"
        side="top"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div
          data-slot="command-input-wrapper"
          className="shrink-0 p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({
                id: "chat.empty.workspaceSearchPlaceholder",
              })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex min-h-0 flex-col p-1">
          {error ? (
            <div role="alert" className="px-2 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          <div className="min-h-0 max-h-60 overflow-y-auto">
            {visibleProjects.map((project) => {
              return (
                <span key={projectKey(project)} className="block min-w-0">
                  <DropdownMenuCheckboxItem
                    data-project-id={project.id}
                    data-project-host={project.hostId}
                    data-project-name={project.name}
                    checked={currentProject === project}
                    onSelect={() => {
                      logger.info("[ProjectComposerMenu] 选择项目", {
                        projectId: project.id,
                        hostId: project.hostId,
                      });
                      // 同侧栏项目新建入口：由 Root/Host 解析主要目录。
                      createProjectTask({
                        projectId: project.id,
                      });
                    }}
                  >
                    <ProjectFolderIcon
                      rootCount={project.roots.length}
                      className="size-4 text-foreground-subtle"
                    />
                    {/* 不同字号按框居中会让设备名基线上浮；文字单独对齐基线，外层图标仍居中。 */}
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                </span>
              );
            })}
            {visibleProjects.length === 0 && !error ? (
              <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <DropdownMenuSeparator />
            {/* 项目创建依赖共享服务，不能受本机原生打开文件夹的能力开关限制。 */}
            <DropdownMenuItem
              data-testid="composer-create-project"
              disabled={!service}
              onSelect={() => setCreating(true)}
            >
              <FolderPlus className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "project.create" })}</span>
            </DropdownMenuItem>
            {allowConversationWorkspaceSelection ? (
              <DropdownMenuCheckboxItem
                data-testid="composer-work-outside-project"
                checked={isConversationWorkspace}
                onSelect={() => {
                  void Promise.resolve(onSelectConversationWorkspace());
                }}
              >
                <MessageCircle className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
              </DropdownMenuCheckboxItem>
            ) : null}
          </div>
        </div>
      </DropdownMenuContent>
      {/* 连接成功仍由目录流程交付聊天；普通创建在同一草稿中选中保存后的项目。 */}
      {creating && service ? (
        <ProjectCreation
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          onCreateTask={createProjectTask}
          projects={tree.projects}
          service={service}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}
    </DropdownMenu>
  );
  return (
    <>
      {menu}
      {children}
    </>
  );
}
