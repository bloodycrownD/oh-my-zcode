// 照搬上游 v3.16.2 project-sidebar/ProjectSidebarNavigation.tsx 并 omz 化：
// ①删 deviceNavigation/isWebRemoteControl 分支（relay v2 手机远控设备头，omz 无该面）；
// ②omz 独有面迁移（backlog-sweep Step 5 独有面归宿④）：经典侧栏的 WorkspaceNewTaskTooltip
//   随 alias 退役迁入本骨架新建入口，只读 workspace 仍给出禁用原因提示；
// ③顶层新建走裸调用 onCreateTask()（不显式传 null），分组/项目归属继承由 ProjectSidebar 承担。
import { Blocks, CalendarClock } from "lucide-react";
import type { ReactNode } from "react";
import { TID_AUTOMATIONS_OPEN } from "@zcode/shared";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

function WorkspaceNewTaskTooltip({
  children,
  disabledReason,
}: {
  children: ReactNode;
  disabledReason?: string;
}) {
  // 正常状态下按钮已带“新建任务”文案和快捷键，再挂 tooltip 只是重复；仅禁用时才解释原因。
  if (!disabledReason) return children;
  return (
    <ControlHintTooltip title={disabledReason}>
      <div>{children}</div>
    </ControlHintTooltip>
  );
}

/** 顶部导航只展示 Shell 的选中状态，路由仍由 Shell 唯一持有。 */
export function ProjectSidebarNavigation({
  props,
  onCreate,
}: {
  props: Pick<
    ProjectSidebarProps,
    | "onOpenAutomations"
    | "automationsActive"
    | "onOpenPluginStore"
    | "pluginStoreActive"
    | "workspaceReadOnlyReason"
  >;
  onCreate(): void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div data-testid="sidebar-primary-navigation" className="flex flex-col gap-1 px-2 py-3">
      <WorkspaceNewTaskTooltip disabledReason={props.workspaceReadOnlyReason}>
        <NewTaskButtonGroup
          disabled={Boolean(props.workspaceReadOnlyReason)}
          onCreateTask={onCreate}
        />
      </WorkspaceNewTaskTooltip>
      {props.onOpenAutomations ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.automationsActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.automationsActive ?? false}
          data-testid={TID_AUTOMATIONS_OPEN}
          // 点击事件不能进入业务导航的可选 automationId 参数。
          onClick={() => props.onOpenAutomations?.()}
        >
          <CalendarClock className="size-4" />
          {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="lg"
        className={`w-full justify-start gap-2 ${props.pluginStoreActive ? "bg-selected text-foreground" : ""}`}
        aria-pressed={props.pluginStoreActive ?? false}
        data-testid="plugin-store-sidebar-open"
        onClick={() => props.onOpenPluginStore?.()}
      >
        <Blocks className="size-4" />
        {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
      </Button>
    </div>
  );
}
