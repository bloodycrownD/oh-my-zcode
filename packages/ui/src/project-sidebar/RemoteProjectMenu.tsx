// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批，拍板 B）并 omz 化：
// 设备数据源从 management snapshot（P9 缝）改为 omz ProjectDevice 投影（status 直接携带
// 聚合态）；onOpenRemoteWorkspace 沿 omz AppProps 形态（无 preference 参数——向导交接随
// 拍板 A 挂账），「新建远端连接」项保留入口形状，由调用方决定去向。
import { Cloud, FolderOpen, Plus } from "lucide-react";
import { sourceServerConnectionStateSchema } from "@zcode/shared";
import { TID_VIRTUAL_PROJECT_ADD } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import type { ProjectDevice } from "@/project-sidebar/contract.js";

export function RemoteProjectMenu({
  devices,
  onOpenFolder,
  onOpenRemoteWorkspace,
}: {
  /** omz 投影：已握手 Source 设备（status=聚合连接态）；management snapshot 随 P9 换装。 */
  devices?: readonly ProjectDevice[];
  onOpenFolder: () => void;
  onOpenRemoteWorkspace?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_VIRTUAL_PROJECT_ADD}
          className="text-foreground-subtle hover:text-foreground data-[state=open]:text-foreground"
          aria-label={intl.formatMessage({ id: "workspaceSidebar.addProject" })}
        >
          <Plus className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onOpenFolder}>
          <FolderOpen className="size-4" />
          {intl.formatMessage({ id: "workspace.openFolder" })}
        </DropdownMenuItem>
        {onOpenRemoteWorkspace ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Cloud className="size-4" />
              {intl.formatMessage({ id: "workspaceSidebar.openRemoteProject" })}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64 max-w-[calc(100vw-24px)]">
              {(devices ?? []).map((device) => {
                // omz ProjectDevice.status 为 string；连接状态枚举在此收敛，非法值落 offline。
                const state = sourceServerConnectionStateSchema.safeParse(device.status).data;
                const presentation = resolveRemoteConnectionPresentation(state ? { state } : {});
                return (
                  <DropdownMenuItem
                    key={device.id}
                    data-remote-project-device={device.sourceServerId ?? device.id}
                    disabled={presentation.status === "connecting"}
                    onSelect={onOpenRemoteWorkspace}
                  >
                    <RemoteConnectionStateIcon presentation={presentation} project />
                    <span className="min-w-0 flex-1 truncate">{device.label}</span>
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: presentation.shortMessageId })}
                    </span>
                  </DropdownMenuItem>
                );
              })}
              {devices?.length ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={onOpenRemoteWorkspace}>
                <Plus className="size-4" />
                {intl.formatMessage({ id: "workspaceSidebar.newRemoteConnection" })}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
