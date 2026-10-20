import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import {
  FolderOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelTrajectory } from "@/hooks/useModelTrajectory.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  TrajectoryExpansionCommandContext,
  TrajectoryExpansionRegistryContext,
  TRAJECTORY_TURN_EXPANSION_KEY_PREFIX,
  createTrajectoryExpansionCommands,
  type TrajectoryExpansionOverride,
} from "@/ModelTrajectoryExpansion.js";
import { ModelTrajectoryExpansionMenu } from "@/ModelTrajectoryExpansionMenu.js";
import {
  buildTrajectorySearchIndex,
  TrajectorySearchRevealContext,
  TrajectorySearchRevealTurnContext,
} from "@/ModelTrajectorySearch.js";
import { ModelTrajectorySearchBar } from "@/ModelTrajectorySearchBar.js";
import { clearTrajectorySearchHighlights } from "@/ModelTrajectorySearchHighlight.js";
import {
  ModelTrajectoryTimeline,
  resolveTrajectorySearchItems,
} from "@/ModelTrajectoryTimeline.js";
import type { TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";
import { TrajectoryWireFilterContext } from "@/ModelTrajectoryCallInput.js";
import { EmptyState, summarizeRecords } from "@/ModelTrajectoryPaneParts.js";
import { resolveTrajectoryTurnGroups, stripTrajectoryReasoning } from "@/ModelTrajectoryTurns.js";

export function ModelTrajectoryPane({
  taskId,
  title,
  workspacePath,
  workspaceIdentity,
  onClose,
}: {
  taskId: string;
  title?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  onClose?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  // Step 8 / B-3：轨迹面板此前从未读取全局「显示思考过程」开关（聊天页 SessionPane 消费同一字段）。
  // 关闭时对 records 做去 reasoning 投影：搜索索引与复制文本随之自然剔除，消息条数不变。
  const { settings } = useSettings();
  const showReasoning = settings?.messageStreamShowReasoning ?? true;
  const { loading, data, error, refresh } = useModelTrajectory(
    workspacePath,
    taskId,
    workspaceIdentity,
  );

  const records = useMemo(() => {
    const sourceRecords = data?.records ?? [];
    return showReasoning ? sourceRecords : stripTrajectoryReasoning(sourceRecords);
  }, [data?.records, showReasoning]);
  // B-4 占位行过滤开关：唯一所有者是 Pane（局部 state、默认隐藏、不持久化、不进设置页）。
  const [hidePlaceholderRows, setHidePlaceholderRows] = useState(true);
  const wireFilterContextValue = useMemo(
    () => ({
      hidePlaceholders: hidePlaceholderRows,
      setHidePlaceholders: setHidePlaceholderRows,
    }),
    [hidePlaceholderRows],
  );
  const sourceFiles = data?.sourceFiles;
  const sourceDirectory = useMemo(
    () => getModelTrajectorySourceDirectory(sourceFiles),
    [sourceFiles],
  );
  const summary = useMemo(() => summarizeRecords(records), [records]);
  // B-1/B-6：按 turnId 聚合成回合，虚拟化单位与搜索索引都以回合为准。
  const turnGroups = useMemo(
    () =>
      resolveTrajectoryTurnGroups(records, {
        emptyUserPreview: intl.formatMessage({ id: "modelTrajectory.turn.noUserInput" }),
      }),
    [intl, records],
  );
  const searchItems = useMemo(() => resolveTrajectorySearchItems(turnGroups), [turnGroups]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const searchIndex = useMemo(
    () => buildTrajectorySearchIndex(searchItems, deferredSearchQuery),
    [deferredSearchQuery, searchItems],
  );
  const resolvedSearchActiveIndex =
    searchIndex.matches.length === 0
      ? -1
      : Math.min(searchActiveIndex, searchIndex.matches.length - 1);
  const activeSearchMatch =
    resolvedSearchActiveIndex >= 0
      ? (searchIndex.matches[resolvedSearchActiveIndex] ?? null)
      : null;
  const [expansionCommands, setExpansionCommands] = useState(createTrajectoryExpansionCommands);
  const expansionVersionRef = useRef(0);
  const [expansionOverrides, setExpansionOverrides] = useState(
    () => new Map<string, TrajectoryExpansionOverride>(),
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // B-6：全部展开/收起改为回合级（消息行在展开的回合内默认展开，无需逐类展开）。
  const willExpandAll = !expansionCommands.turn.expanded;
  const toggleAllLabel = intl.formatMessage({
    id: willExpandAll ? "modelTrajectory.expandAll" : "modelTrajectory.collapseAll",
  });
  const handleToggleAll = useCallback(() => {
    const expanded = !expansionCommands.turn.expanded;
    expansionVersionRef.current += 1;
    const version = expansionVersionRef.current;
    // 只清回合命名空间的 override：消息行上用户单独做过的展开选择保持不变。
    setExpansionOverrides((previous) => {
      const next = new Map<string, TrajectoryExpansionOverride>();
      for (const [key, override] of previous) {
        if (!key.startsWith(TRAJECTORY_TURN_EXPANSION_KEY_PREFIX)) next.set(key, override);
      }
      return next;
    });
    setExpansionCommands((previous) => ({ ...previous, turn: { expanded, version } }));
  }, [expansionCommands.turn.expanded]);
  const handleToggleExpansionKind = useCallback((kind: TrajectoryVisualRole) => {
    expansionVersionRef.current += 1;
    const version = expansionVersionRef.current;
    setExpansionCommands((previous) => ({
      ...previous,
      [kind]: { expanded: !previous[kind].expanded, version },
    }));
  }, []);
  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    setSearchActiveIndex(0);
  }, []);
  const handleSearchMove = useCallback(
    (direction: "previous" | "next") => {
      const count = searchIndex.matches.length;
      if (count === 0) return;
      setSearchActiveIndex((current) => {
        const resolved = Math.min(current, count - 1);
        return direction === "next" ? (resolved + 1) % count : (resolved - 1 + count) % count;
      });
    },
    [searchIndex.matches.length],
  );
  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchActiveIndex(0);
    clearTrajectorySearchHighlights();
  }, []);
  const setExpansionOverride = useCallback((key: string, override: TrajectoryExpansionOverride) => {
    setExpansionOverrides((previous) => {
      const next = new Map(previous);
      next.set(key, override);
      return next;
    });
  }, []);
  const expansionRegistry = useMemo(
    () => ({ overrides: expansionOverrides, setOverride: setExpansionOverride }),
    [expansionOverrides, setExpansionOverride],
  );
  const handleOpenSourceDirectory = useCallback(async () => {
    if (!sourceDirectory) {
      return;
    }

    try {
      const result = await platform.openInFileManager(sourceDirectory);
      if (result.success) {
        return;
      }

      logger.warn("[ModelTrajectoryPane] 打开调用轨迹目录失败", {
        taskId,
        path: sourceDirectory,
        sourceFiles: sourceFiles ?? [],
        error: result.error ?? "unknown-error",
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    } catch (openError) {
      logger.warn("[ModelTrajectoryPane] 打开调用轨迹目录失败", {
        taskId,
        path: sourceDirectory,
        sourceFiles: sourceFiles ?? [],
        error: openError instanceof Error ? openError.message : String(openError),
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [intl, platform, sourceDirectory, sourceFiles, taskId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-col px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1" title={taskId}>
            <span className="block truncate text-ui-base font-medium text-foreground">
              {title?.trim() || intl.formatMessage({ id: "modelTrajectory.title" })}
            </span>
          </div>
          {records.length > 0 ? (
            <Button
              data-trajectory-search-trigger=""
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground"
              onClick={() => setSearchOpen(true)}
              aria-label={intl.formatMessage({ id: "modelTrajectory.search" })}
              title={intl.formatMessage({ id: "modelTrajectory.search" })}
            >
              <SearchIcon className="size-3.5" />
            </Button>
          ) : null}
          {records.length > 0 ? (
            <ModelTrajectoryExpansionMenu
              commands={expansionCommands}
              onToggle={handleToggleExpansionKind}
              reasoningEnabled={showReasoning}
              intl={intl}
            />
          ) : null}
          {records.length > 0 ? (
            <Button
              data-trajectory-toggle-all=""
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground"
              onClick={handleToggleAll}
              aria-label={toggleAllLabel}
              title={toggleAllLabel}
            >
              {willExpandAll ? (
                <Maximize2Icon className="size-3.5" />
              ) : (
                <Minimize2Icon className="size-3.5" />
              )}
            </Button>
          ) : null}
          {sourceDirectory ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleOpenSourceDirectory()}
              aria-label={intl.formatMessage({ id: "modelTrajectory.openSourceDirectory" })}
              title={`${intl.formatMessage({ id: "modelTrajectory.openSourceDirectory" })}: ${sourceDirectory}`}
            >
              <FolderOpenIcon className="size-4" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={refresh}
            aria-label={intl.formatMessage({ id: "modelTrajectory.refresh" })}
            title={intl.formatMessage({ id: "modelTrajectory.refresh" })}
          >
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          </Button>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={intl.formatMessage({ id: "modelTrajectory.close" })}
              title={intl.formatMessage({ id: "modelTrajectory.close" })}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
        {records.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-xs text-foreground-subtle">
            <span>
              {intl.formatMessage(
                { id: "modelTrajectory.summaryCalls" },
                { count: String(records.length) },
              )}
            </span>
            {summary.totalTokens > 0 ? (
              <span
                className="font-mono"
                title={intl.formatMessage({ id: "modelTrajectory.summaryTokens" })}
              >
                · {summary.totalTokens.toLocaleString()} tok
              </span>
            ) : null}
            {summary.models.length > 0 ? (
              <span className="min-w-0 truncate font-mono">· {summary.models.join(", ")}</span>
            ) : null}
          </div>
        ) : null}
        {searchOpen && records.length > 0 ? (
          <ModelTrajectorySearchBar
            query={searchQuery}
            activeIndex={resolvedSearchActiveIndex}
            matchCount={searchIndex.matches.length}
            onQueryChange={handleSearchQueryChange}
            onMove={handleSearchMove}
            onClose={handleCloseSearch}
            intl={intl}
          />
        ) : null}
      </header>
      <div data-trajectory-header-divider="" className="h-px shrink-0 bg-border" />

      {/* Radix ScrollArea 会注入 display: table 的内容层，使长轨迹参与异常宽度计算；这里仅需原生纵向滚动。 */}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {error ? (
          <EmptyState
            tone="error"
            text={intl.formatMessage({ id: "modelTrajectory.error" })}
            detail={error}
          />
        ) : loading && records.length === 0 ? (
          <EmptyState text={intl.formatMessage({ id: "modelTrajectory.loading" })} />
        ) : records.length === 0 ? (
          <EmptyState text={intl.formatMessage({ id: "modelTrajectory.empty" })} />
        ) : (
          <TrajectoryExpansionCommandContext.Provider value={expansionCommands}>
            <TrajectoryExpansionRegistryContext.Provider value={expansionRegistry}>
              <TrajectorySearchRevealContext.Provider
                value={activeSearchMatch?.expansionKey ?? null}
              >
                <TrajectorySearchRevealTurnContext.Provider
                  value={activeSearchMatch?.turnKey ?? null}
                >
                  <TrajectoryWireFilterContext.Provider value={wireFilterContextValue}>
                    <ModelTrajectoryTimeline
                      turnGroups={turnGroups}
                      searchQuery={searchIndex.query}
                      searchMatches={searchIndex.matches}
                      activeSearchMatch={activeSearchMatch}
                      intl={intl}
                      scrollContainerRef={scrollContainerRef}
                    />
                  </TrajectoryWireFilterContext.Provider>
                </TrajectorySearchRevealTurnContext.Provider>
              </TrajectorySearchRevealContext.Provider>
            </TrajectoryExpansionRegistryContext.Provider>
          </TrajectoryExpansionCommandContext.Provider>
        )}

        {data?.truncated ? (
          <p className="px-3 py-2 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "modelTrajectory.truncatedNotice" })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function getModelTrajectorySourceDirectory(
  sourceFiles: readonly string[] | undefined,
): string | null {
  const sourceFile = sourceFiles?.find((path) => path.trim().length > 0);
  return sourceFile ? getContainingDirectoryPath(sourceFile) : null;
}
