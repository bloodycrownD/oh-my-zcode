import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「按 Source 编辑」但该 Source 没有可用的远端配置通道时的显式空态。
 *
 * 判定口径见 settingsSourceWorkspace.ts 文件头：远端 Source 必须有一个通过
 * workspaceBelongsToSettingsSource 校验的锚点（已连接 workspace / 归属该项目 /
 * Source home）；校验不过一律落到这里，绝不沿用本机 services 把本机配置伪装成远端配置。
 *
 * 上游用 source-settings attachment 读无 tab 的 Source user scope；本仓 renderer 侧通道见 handoff。
 */
export function SettingsSourceUnavailable({ sourceServerId }: { sourceServerId: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-testid="settings-source-unavailable"
      data-source-server-id={sourceServerId}
      className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle"
    >
      {intl.formatMessage({ id: "settings.source.settingsUnavailable" }, { sourceServerId })}
    </div>
  );
}
