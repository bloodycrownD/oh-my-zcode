import { useMemo } from "react";
import { Loader2, Monitor, RefreshCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MigrationCandidatesCard } from "@/settings/MigrationCandidatesCard.js";
import { isSpecificSettingsSource } from "@/settings/settingsSourceWorkspace.js";

const RANGE_OPTIONS = ["7d", "30d", "90d", "all"] as const;
const WORKSPACE_FILTER_OPTIONS = ["all", "current"] as const;

/**
 * 应用级分区提示。
 * 本分区不按 settingsSourceServerId 收窄读写落点：扫描/导入的是本机 Claude 历史记录。
 * 选中具体设备时说明改动不作用于该设备；未选中具体设备时不展示。
 */
function AppLevelSettingsNotice({
  settingsSourceServerId,
}: {
  settingsSourceServerId?: string | null;
}) {
  const { intl } = useZCodeIntl();
  if (!isSpecificSettingsSource(settingsSourceServerId)) {
    return null;
  }
  return (
    <div
      role="note"
      data-settings-app-level="true"
      className="flex items-start gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-ui-base leading-6 text-foreground-subtle"
    >
      <Monitor className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-medium text-foreground">
          {intl.formatMessage({ id: "settings.scope.appLevel" })}
        </div>
        <div>{intl.formatMessage({ id: "settings.scope.appLevelNotice" })}</div>
      </div>
    </div>
  );
}

export function MigrationSection({
  workspacePath,
  workspaceIdentity,
  isDesktop,
  settingsSourceServerId,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
  /**
   * 设置页顶部的设备（Source）选择，三态与设置页选择器一致：
   * `undefined` = 未按设备收窄（选择器「全部」）、`null` = 本机、字符串 = 具体设备。
   * 本分区不按它收窄读写落点，只用于决定应用级提示是否展示。
   */
  settingsSourceServerId?: string | null;
}) {
  const { intl, locale } = useZCodeIntl();
  const {
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    selectedSessionIds,
    selectedCount,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
  } = useClaudeSessionMigration({
    workspacePath,
    workspaceIdentity,
    isDesktop,
  });

  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  const unsupportedDescription =
    supportState.reason === "desktopOnly"
      ? intl.formatMessage({ id: "settings.migration.unsupported.desktopOnly" })
      : null;

  return (
    <div className="space-y-6">
      <AppLevelSettingsNotice settingsSourceServerId={settingsSourceServerId} />
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardHeader className="border-b border-border">
          <CardAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!supportState.supported || isScanning}
              onClick={() => {
                void scan();
              }}
            >
              {isScanning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="size-3.5" />
              )}
              {intl.formatMessage({ id: "settings.migration.scan" })}
            </Button>
          </CardAction>
          <div className="space-y-1">
            <CardTitle>{intl.formatMessage({ id: "settings.migration.filtersTitle" })}</CardTitle>
            <CardDescription>
              {intl.formatMessage({ id: "settings.migration.filtersDescription" })}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-4 py-4">
          {!supportState.supported ? (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>
                {intl.formatMessage({ id: "settings.migration.unsupported.title" })}
              </AlertTitle>
              <AlertDescription>{unsupportedDescription}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.workspaceFilterLabel" })}
              </div>
              <Select
                value={workspaceFilterMode}
                disabled={!supportState.supported || isScanning || isImporting}
                onValueChange={(value) =>
                  setWorkspaceFilterMode(value as (typeof WORKSPACE_FILTER_OPTIONS)[number])
                }
              >
                <SelectTrigger size="lg" className="w-full justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {intl.formatMessage({ id: "settings.migration.workspaceFilter.all" })}
                  </SelectItem>
                  {hasCurrentWorkspaceFilter ? (
                    <SelectItem value="current">
                      {intl.formatMessage({ id: "settings.migration.workspaceFilter.current" })}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.rangeLabel" })}
              </div>
              <Select
                value={range}
                disabled={!supportState.supported || isScanning || isImporting}
                onValueChange={(value) => setRange(value as (typeof RANGE_OPTIONS)[number])}
              >
                <SelectTrigger size="lg" className="w-full justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {intl.formatMessage({ id: `settings.migration.range.${option}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.limitLabel" })}
              </div>
              <Input
                type="number"
                min={1}
                max={500}
                value={limitInput}
                disabled={!supportState.supported || isScanning || isImporting}
                onChange={(event) => setLimitInput(event.target.value)}
              />
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.migration.limitHint" },
                  { max: String(scanLimit) },
                )}
              </div>
            </div>
          </div>

          {scanError ? (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>
                {intl.formatMessage({ id: "settings.migration.scanFailedTitle" })}
              </AlertTitle>
              <AlertDescription>
                {intl.formatMessage(
                  { id: "settings.migration.scanFailedDescription" },
                  { error: scanError },
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <MigrationCandidatesCard
        supportState={supportState}
        candidates={candidates}
        selectedSessionIds={selectedSessionIds}
        selectedCount={selectedCount}
        importError={importError}
        lastImportResult={lastImportResult}
        isImporting={isImporting}
        dateTimeFormatter={dateTimeFormatter}
        onToggleSelection={toggleSessionSelection}
        onSelectAll={selectAllSessions}
        onClearSelection={clearSelectedSessions}
        onImportSelected={() => {
          void importSelectedSessions();
        }}
      />
    </div>
  );
}
