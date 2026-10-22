// 照搬上游 v3.16.2；grouped 视角项暂不渲染（上游 TaskGroupedView 随 P5 回补，
// omz 旧侧栏 organizeGrouped 分组视角并存），枚举与存储形状保持兼容。
import type { ProjectSidebarProps, ProjectSidebarView } from "@/project-sidebar/contract.js";
import { Clock, Folder, ListFilter, Search } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCommandShortcutLabel } from "@/lib/keyboardShortcuts.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

/** 列表头部独立于导航和滚动内容，搜索与视图仍使用现有 owner。 */
export function ProjectSidebarListHeader({
  onOpenCommandCenter,
  view,
  onViewChange,
}: {
  onOpenCommandCenter: ProjectSidebarProps["onOpenCommandCenter"];
  view: ProjectSidebarView;
  onViewChange(view: ProjectSidebarView): void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1 px-2 pb-2"
      data-testid="sidebar-search-toolbar"
    >
      <span
        data-testid="sidebar-list-title"
        className="min-w-0 flex-1 truncate px-2.5 text-ui-base font-medium text-foreground-subtle"
      >
        {intl.formatMessage({ id: "taskList.title" })}
      </span>
      <ControlHintTooltip
        // 原因：快捷键拼入标题会继承标题样式；用独立 shortcut 复用标准键帽。
        title={intl.formatMessage({ id: "commandCenter.open" })}
        shortcut={formatCommandShortcutLabel("k")}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-foreground-subtle hover:text-foreground"
          data-testid="sidebar-search-open"
          aria-label={intl.formatMessage({ id: "commandCenter.open" })}
          onClick={onOpenCommandCenter}
        >
          <Search className="size-3.5" />
        </Button>
      </ControlHintTooltip>
      <DropdownMenu>
        <ControlHintTooltip title={intl.formatMessage({ id: "project.view" })}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              data-testid="sidebar-view-menu"
              aria-label={intl.formatMessage({ id: "project.view" })}
            >
              <ListFilter className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={view}
            onValueChange={(value) => {
              if (value === "projects" || value === "timeline") onViewChange(value);
            }}
          >
            <DropdownMenuRadioItem data-testid="sidebar-view-projects" value="projects">
              <Folder className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "project.viewByProject" })}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem data-testid="sidebar-view-timeline" value="timeline">
              <Clock className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "project.viewRecentlyUpdated" })}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
