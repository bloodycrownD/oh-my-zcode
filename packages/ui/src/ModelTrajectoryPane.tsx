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
  areAllTrajectoryExpansionKindsExpanded,
  createTrajectoryExpansionCommands,
  setAllTrajectoryExpansionKinds,
  withoutTrajectoryTurnOverrides,
  type TrajectoryExpansionOverride,
} from "@/ModelTrajectoryExpansion.js";
import { ModelTrajectoryExpansionMenu } from "@/ModelTrajectoryExpansionMenu.js";
import { ModelTrajectoryMessageViewHost } from "@/ModelTrajectoryMessageViewHost.js";
import {
  buildTrajectorySearchIndex,
  TrajectorySearchRevealContext,
  TrajectorySearchRevealTurnContext,
} from "@/ModelTrajectorySearch.js";
import { ModelTrajectorySearchBar } from "@/ModelTrajectorySearchBar.js";
import { clearTrajectorySearchHighlights } from "@/ModelTrajectorySearchHighlight.js";
import { ModelTrajectoryTimeline } from "@/ModelTrajectoryTimeline.js";
import type { TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";
import { TrajectoryWireFilterContext } from "@/ModelTrajectoryCallInput.js";
import { EmptyState, summarizeRecords } from "@/ModelTrajectoryPaneParts.js";
import {
  resolveTrajectorySearchItems,
  resolveTrajectoryTurnGroups,
  stripTrajectoryReasoning,
} from "@/ModelTrajectoryTurns.js";

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
  // B-2：搜索索引必须与渲染一致——占位行被隐藏时不进索引（否则命中不在 DOM 的行，
  // 计数前进但高亮/滚动不动作），开关切换即重建。
  const searchItems = useMemo(
    () => resolveTrajectorySearchItems(turnGroups, hidePlaceholderRows),
    [hidePlaceholderRows, turnGroups],
  );
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
  // v1.0.19 P1-5：搜索命中的强制展开集合覆盖**全部**命中（不再只有 active 命中），
  // 否则默认收起时其余命中行的 content 字段不在 DOM → 计数前进但高亮不可见。
  // 必须在 useMemo 里构造集合——渲染体内直接 new Set 会让 Context 值每帧变化，
  // 令全部消费行（useTrajectorySearchRevealed 的调用方）反复重渲染。
  const revealMessageKeys = useMemo(
    () => new Set(searchIndex.matches.map((match) => match.expansionKey)),
    [searchIndex.matches],
  );
  const revealTurnKeys = useMemo(
    () => new Set(searchIndex.matches.map((match) => match.turnKey)),
    [searchIndex.matches],
  );
  const [expansionCommands, setExpansionCommands] = useState(createTrajectoryExpansionCommands);
  const expansionVersionRef = useRef(0);
  const [expansionOverrides, setExpansionOverrides] = useState(
    () => new Map<string, TrajectoryExpansionOverride>(),
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // v1.0.19 P1-4：工具栏「全部展开/收起」按全部 7 个命令槽聚合判定，
  // 只看命令槽的 expanded 值，per-row override 不参与聚合。
  const willExpandAll = !areAllTrajectoryExpansionKindsExpanded(expansionCommands);
  const toggleAllLabel = intl.formatMessage({
    id: willExpandAll ? "modelTrajectory.expandAll" : "modelTrajectory.collapseAll",
  });
  // 回合展开的两个写入口：①工具栏「全部展开/收起」（批量写 7 槽）
  // ②「自定义展开」菜单的「回合」项（只写 turn 槽）。
  // 两者都必须在写 turn 槽前清理 `turn:` 命名空间的 override——
  // 否则被 override 钉住的回合对翻转无响应（现状语义保留）；非 turn 行 override 不清理。
  const clearTurnOverrides = useCallback(() => {
    setExpansionOverrides((previous) => withoutTrajectoryTurnOverrides(previous));
  }, []);
  // 工具栏全量入口：批量写全部 7 槽，目标态 = 7 槽是否全展开的取反
  // （全展开→收起；任一未展开→展开）。必须函数式更新——闭包取值在同一 tick
  // 连点两次时读到旧值，会丢一次翻转。
  const toggleAllExpansion = useCallback(() => {
    expansionVersionRef.current += 1;
    const version = expansionVersionRef.current;
    clearTurnOverrides();
    setExpansionCommands((previous) =>
      setAllTrajectoryExpansionKinds(
        previous,
        !areAllTrajectoryExpansionKindsExpanded(previous),
        version,
      ),
    );
  }, [clearTurnOverrides]);
  const handleToggleExpansionKind = useCallback(
    (kind: TrajectoryVisualRole) => {
      expansionVersionRef.current += 1;
      const version = expansionVersionRef.current;
      // 菜单「回合」项：只翻转回合级，不连带其它类开关（与工具栏全量入口语义分离）。
      if (kind === "turn") {
        clearTurnOverrides();
        setExpansionCommands((previous) => ({
          ...previous,
          turn: { expanded: !previous.turn.expanded, version },
        }));
        return;
      }
      setExpansionCommands((previous) => ({
        ...previous,
        [kind]: { expanded: !previous[kind].expanded, version },
      }));
    },
    [clearTurnOverrides],
  );
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
              onClick={toggleAllExpansion}
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
              <TrajectorySearchRevealContext.Provider value={revealMessageKeys}>
                <TrajectorySearchRevealTurnContext.Provider value={revealTurnKeys}>
                  <TrajectoryWireFilterContext.Provider value={wireFilterContextValue}>
                    {/* 全屏只读视图的宿主挂在时间线外层（spec N-6）：
                        入口按钮在虚拟化行内，Modal 状态必须活回合之外，行回收不影响已打开的视图。 */}
                    <ModelTrajectoryMessageViewHost>
                      <ModelTrajectoryTimeline
                        turnGroups={turnGroups}
                        searchQuery={searchIndex.query}
                        searchMatches={searchIndex.matches}
                        activeSearchMatch={activeSearchMatch}
                        intl={intl}
                        scrollContainerRef={scrollContainerRef}
                      />
                    </ModelTrajectoryMessageViewHost>
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
