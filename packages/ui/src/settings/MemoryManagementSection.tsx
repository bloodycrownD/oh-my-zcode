/* eslint-disable max-lines -- 项目记忆面板集中维护列表、分类过滤、批量勾选与废弃确认对话框的共享状态；拆分会凭增跨组件的选中态传递。 */
/**
 * FORK（magic-context-memory-management / Step 8 · 变更点 9）：「记忆」分区的
 * magic-context 跨会话项目记忆管理面板。
 *
 * 数据链：`services.zcodeAgentService.listMagicContextMemories / archiveMagicContextMemories`
 * → workspace RPC（`workspace/listMagicContextMemories` 等）→ CLI handler → magic-context
 * `host/memory-admin.ts`。写路径与对话内 `ctx_memory action:"archive"` 共享同一组合函数
 * （单事务成对写），本面板只发起请求、按逐 id outcome 组 toast。
 *
 * 数据始终取**本机 Host**（SettingsPage 的「记忆」分支外层用 `<ServiceProvider services={localHostServices}>`
 * 包裹，与「上下文管理」分区同款），远程 workspace 场景下管理的同样是本机 CLI 记忆库。
 *
 * 降级（spec D6）：
 *   - `supported:false`（旧 CLI 无该方法）→ 「需升级 CLI」占位，不显示列表；
 *   - `available:false`（magicContext 关闭 / 库打不开）→ 未启用/不可用占位；
 *   - archive 失败由 services 转译成可读中文 message，直接 toast。
 *
 * 分类词表（`MemoryCategory`）权威在 magic-context 包：这里只做**显示标签**映射，
 * 未知分类原样回显，不复刻协议校验语义。`seenCount` 是写入去重计数而非「使用次数」，
 * 按 spec 不展示。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeWorkspaceListMagicContextMemoriesResult } from "@zcode/shared";
import {
  TID_SETTINGS_MCM_ARCHIVE_CANCEL,
  TID_SETTINGS_MCM_ARCHIVE_CONFIRM,
  TID_SETTINGS_MCM_ARCHIVE_DIALOG,
  TID_SETTINGS_MCM_ARCHIVE_REASON,
  TID_SETTINGS_MCM_ARCHIVE_SELECTED,
  TID_SETTINGS_MCM_CATEGORY_FILTER,
  TID_SETTINGS_MCM_COUNTS,
  TID_SETTINGS_MCM_EMPTY,
  TID_SETTINGS_MCM_ITEM,
  TID_SETTINGS_MCM_ITEM_SELECT,
  TID_SETTINGS_MCM_LOAD_ERROR,
  TID_SETTINGS_MCM_LOAD_MORE,
  TID_SETTINGS_MCM_REFRESH,
  TID_SETTINGS_MCM_SELECT_ALL,
  TID_SETTINGS_MCM_UNAVAILABLE,
  testId,
} from "@zcode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

type MemoryEntry = ZCodeWorkspaceListMagicContextMemoriesResult["entries"][number];
type MemoryCounts = ZCodeWorkspaceListMagicContextMemoriesResult["counts"];

/** 单次拉取上限与 wire schema 的上限（200）一致；截断由 truncated 标记 + 加载更多承接。 */
const PAGE_SIZE = 200;
/** 与工具面 `CtxMemoryInputSchema.reason` / wire schema 的上限一致。 */
const REASON_MAX_LENGTH = 4096;
/**
 * 单批废弃的 id 上限 100：wire `memoryIds` 为 `int[] 1..100`（shared
 * `zcode-protocol/index.ts:2289` 的 `max(100)`），与工具面契约 `CtxMemoryInputSchema.ids`
 * 同值。UI 依赖方向不能 import contracts，只能在此本地锚定；超过即整批 -32602，
 * 故 `submitArchive` 按本值分片提交（勾选上限=已加载条目数，跨页可 >100）。
 */
const ARCHIVE_BATCH_MAX = 100;

/**
 * 分类显示标签（magic-context `MemoryCategory` 12 值 accept-both：v2 五类 + legacy 九类，
 * 重叠 CONSTRAINTS/NAMING 去重后唯一值 12）。
 * 未知分类回退原样回显——上游新增分类时不至于让徽章变成空白。
 */
const CATEGORY_LABEL_KEY: Readonly<Record<string, string>> = {
  PROJECT_RULES: "settings.memory.management.category.PROJECT_RULES",
  ARCHITECTURE: "settings.memory.management.category.ARCHITECTURE",
  CONSTRAINTS: "settings.memory.management.category.CONSTRAINTS",
  CONFIG_VALUES: "settings.memory.management.category.CONFIG_VALUES",
  NAMING: "settings.memory.management.category.NAMING",
  ARCHITECTURE_DECISIONS: "settings.memory.management.category.ARCHITECTURE_DECISIONS",
  CONFIG_DEFAULTS: "settings.memory.management.category.CONFIG_DEFAULTS",
  USER_PREFERENCES: "settings.memory.management.category.USER_PREFERENCES",
  USER_DIRECTIVES: "settings.memory.management.category.USER_DIRECTIVES",
  ENVIRONMENT: "settings.memory.management.category.ENVIRONMENT",
  WORKFLOW_RULES: "settings.memory.management.category.WORKFLOW_RULES",
  KNOWN_ISSUES: "settings.memory.management.category.KNOWN_ISSUES",
};

const STATUS_LABEL_KEY: Readonly<Record<string, string>> = {
  active: "settings.memory.management.status.active",
  permanent: "settings.memory.management.status.permanent",
  archived: "settings.memory.management.status.archived",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 更新时间格式化器（UI 的 intl 只做 id→文案，没有 formatDate）。
 * 只到分钟：记忆的更新时间差一分钟没有展示价值，但秒级时间戳会让每行都显眼。
 */
function createUpdatedAtFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 已合并 = 被后继记忆取代（supersededByMemoryId 非空；这类行 status 也是 archived）。 */
function isMergedEntry(entry: MemoryEntry): boolean {
  return entry.supersededByMemoryId !== null;
}

/** 分类徽章/过滤徽章的显示文本；`null` = 「全部分类」，未知分类原样回显。 */
function resolveCategoryLabel(intl: IntlInstance, category: string | null): string {
  if (category === null) {
    return intl.formatMessage({ id: "settings.memory.management.filter.all" });
  }
  const labelKey = CATEGORY_LABEL_KEY[category];
  return labelKey ? intl.formatMessage({ id: labelKey }) : category;
}

export function MemoryManagementSection({ workspacePath }: { workspacePath?: string | null }) {
  const { intl, locale } = useZCodeIntl();
  const services = useServices();
  const targetWorkspacePath = workspacePath?.trim() ?? "";
  const updatedAtFormatter = useMemo(() => createUpdatedAtFormatter(locale), [locale]);

  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [counts, setCounts] = useState<MemoryCounts | null>(null);
  const [supported, setSupported] = useState(true);
  const [available, setAvailable] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [archiving, setArchiving] = useState(false);
  /** 丢弃过期响应：刷新与加载更多并发时只有最后一次有权回填列表。 */
  const requestVersionRef = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      if (!targetWorkspacePath) {
        setLoading(false);
        return;
      }
      const version = requestVersionRef.current + 1;
      requestVersionRef.current = version;
      if (offset === 0) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setLoadError(null);
      try {
        const result = await services.zcodeAgentService.listMagicContextMemories({
          workspacePath: targetWorkspacePath,
          limit: PAGE_SIZE,
          offset,
        });
        if (requestVersionRef.current !== version) return;
        setSupported(result.supported);
        setAvailable(result.available);
        setUnavailableReason(result.reason ?? null);
        setCounts(result.counts);
        setTruncated(result.truncated);
        setEntries((current) => (offset === 0 ? result.entries : [...current, ...result.entries]));
        if (offset === 0) setSelectedIds(new Set());
      } catch (error) {
        if (requestVersionRef.current !== version) return;
        logger.warn("[MemoryManagementSection] 读取项目记忆失败", {
          error: errorMessage(error),
        });
        setLoadError(errorMessage(error));
        if (offset === 0) setEntries([]);
      } finally {
        if (requestVersionRef.current === version) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [services, targetWorkspacePath],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const entry of entries) {
      if (seen.has(entry.category)) continue;
      seen.add(entry.category);
      options.push(entry.category);
    }
    return options;
  }, [entries]);

  const visibleEntries = useMemo(
    () => (categoryFilter ? entries.filter((entry) => entry.category === categoryFilter) : entries),
    [categoryFilter, entries],
  );

  // 过滤命中项可能在刷新后整体消失（例如该类目被全部废弃）：此时过滤条件会把用户锁在
  // 空列表里，而对应的过滤徽章也已退场、无法手动切回——自动回到「全部分类」。
  useEffect(() => {
    if (categoryFilter !== null && !categoryOptions.includes(categoryFilter)) {
      setCategoryFilter(null);
    }
  }, [categoryFilter, categoryOptions]);

  // 已归档/已合并行不可再废弃（会得到 already-archived / rejected 回执），勾选框直接禁用。
  const selectableVisibleIds = useMemo(
    () => visibleEntries.filter((entry) => entry.status !== "archived").map((entry) => entry.id),
    [visibleEntries],
  );
  const selectedVisibleCount = selectableVisibleIds.filter((id) => selectedIds.has(id)).length;
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedIds.has(entry.id)),
    [entries, selectedIds],
  );

  const toggleSelection = useCallback((id: number, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of selectableVisibleIds) {
          if (checked) {
            next.add(id);
          } else {
            next.delete(id);
          }
        }
        return next;
      });
    },
    [selectableVisibleIds],
  );

  const submitArchive = useCallback(async () => {
    const memoryIds = selectedEntries.map((entry) => entry.id);
    if (memoryIds.length === 0) return;
    const trimmedReason = reason.trim();
    setArchiving(true);
    // 按 ARCHIVE_BATCH_MAX 分片顺序提交：单批 >100 会被 wire 整批拒（-32602），
    // 串行而非并行是为了让「已成功归档的条数」与「失败发生在第几片」都确定可比。
    const batches: number[][] = [];
    for (let start = 0; start < memoryIds.length; start += ARCHIVE_BATCH_MAX) {
      batches.push(memoryIds.slice(start, start + ARCHIVE_BATCH_MAX));
    }
    let archivedCount = 0;
    let alreadyCount = 0;
    let failedCount = 0;
    try {
      for (const batch of batches) {
        const result = await services.zcodeAgentService.archiveMagicContextMemories({
          workspacePath: targetWorkspacePath,
          memoryIds: batch,
          ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        });
        const batchArchivedCount = result.outcomes.filter(
          (item) => item.outcome === "archived",
        ).length;
        const batchAlreadyCount = result.outcomes.filter(
          (item) => item.outcome === "already-archived",
        ).length;
        archivedCount += batchArchivedCount;
        alreadyCount += batchAlreadyCount;
        failedCount += result.outcomes.length - batchArchivedCount - batchAlreadyCount;
      }
      const parts: string[] = [];
      if (archivedCount > 0) {
        parts.push(
          intl.formatMessage(
            { id: "settings.memory.management.archive.toastArchived" },
            { count: archivedCount },
          ),
        );
      }
      if (alreadyCount > 0) {
        parts.push(
          intl.formatMessage(
            { id: "settings.memory.management.archive.toastAlready" },
            { count: alreadyCount },
          ),
        );
      }
      if (failedCount > 0) {
        parts.push(
          intl.formatMessage(
            { id: "settings.memory.management.archive.toastFailed" },
            { count: failedCount },
          ),
        );
      }
      if (parts.length > 0) toast(parts.join(" "));
      setDialogOpen(false);
      setReason("");
    } catch (error) {
      // services 已把 -32601 与 SQLITE_BUSY 转译成可读中文：原样进 toast，弹窗保留以便重试。
      logger.warn("[MemoryManagementSection] 废弃项目记忆失败", {
        error: errorMessage(error),
      });
      // 失败即停：本片之后的分片不再提交，已成功分片的 archived 条数照常回报，失败原文附后。
      const failureParts: string[] = [];
      if (archivedCount > 0) {
        failureParts.push(
          intl.formatMessage(
            { id: "settings.memory.management.archive.toastArchived" },
            { count: archivedCount },
          ),
        );
      }
      failureParts.push(errorMessage(error));
      toast(failureParts.join(" "));
    } finally {
      // 无论成败都刷新：失败前已归档的分片必须反映到列表与 counts。刷新会同时清空勾选
      //（load(0) 的既有语义），故失败后重试需重新勾选——弹窗保持打开只表示本次提交未走完。
      await load(0);
      setArchiving(false);
    }
  }, [intl, load, reason, selectedEntries, services, targetWorkspacePath]);

  if (!targetWorkspacePath) {
    return (
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.management.noWorkspace" })}
      </p>
    );
  }

  const sectionDescription = intl.formatMessage({
    id: "settings.memory.management.description",
  });

  /**
   * 读取失败且没有任何已加载数据：主区留给上方错误横幅与重试，不渲染空态 EMPTY——
   * 「暂无项目记忆」是对数据的肯定断言，此刻并未读到数据（counts 徽章保留最近成功值）。
   */
  const errorWithoutData = loadError !== null && entries.length === 0;

  return (
    <div className="space-y-4">
      <div className="text-ui-base font-medium text-foreground-subtle">{sectionDescription}</div>

      {loadError ? (
        <div
          data-testid={TID_SETTINGS_MCM_LOAD_ERROR}
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          <span className="min-w-0">{intl.formatMessage({ id: "settings.memory.management.loadFailed" })}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void load(0)}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}

      {!supported ? (
        <div
          data-testid={TID_SETTINGS_MCM_UNAVAILABLE}
          className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.memory.management.unsupported" })}
        </div>
      ) : !available ? (
        <div
          data-testid={TID_SETTINGS_MCM_UNAVAILABLE}
          className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({
            id:
              unavailableReason === "unavailable"
                ? "settings.memory.management.unavailable.unavailable"
                : "settings.memory.management.unavailable.disabled",
          })}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div
              data-testid={TID_SETTINGS_MCM_COUNTS}
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              {counts
                ? (
                    [
                      ["counts.total", counts.total],
                      ["counts.active", counts.active],
                      ["counts.permanent", counts.permanent],
                      ["counts.archived", counts.archived],
                      ["counts.merged", counts.merged],
                    ] as const
                  ).map(([key, value]) => (
                    <Badge key={key} variant="outline" className="text-foreground-subtle">
                      {intl.formatMessage(
                        { id: `settings.memory.management.${key}` },
                        { count: value },
                      )}
                    </Badge>
                  ))
                : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.memory.management.selectedCount" },
                  { count: selectedEntries.length },
                )}
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid={TID_SETTINGS_MCM_ARCHIVE_SELECTED}
                disabled={selectedEntries.length === 0 || archiving}
                onClick={() => {
                  setReason("");
                  setDialogOpen(true);
                }}
              >
                {intl.formatMessage({ id: "settings.memory.management.archiveSelected" })}
              </Button>
              <SettingsResourceHeaderActions
                onRefresh={() => void load(0)}
                refreshing={loading}
                refreshTestId={TID_SETTINGS_MCM_REFRESH}
                refreshLabel={intl.formatMessage({ id: "common.refresh" })}
              />
            </div>
          </div>

          {categoryOptions.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {[null, ...categoryOptions].map((category) => {
                const active = categoryFilter === category;
                return (
                  <button
                    key={category ?? "all"}
                    type="button"
                    aria-pressed={active}
                    data-testid={testId(TID_SETTINGS_MCM_CATEGORY_FILTER, category ?? "all")}
                    className={cn(
                      "rounded-full px-3 py-1 text-ui-xs font-medium transition-colors",
                      active
                        ? "bg-selected text-foreground"
                        : "bg-surface text-foreground-subtle hover:bg-hover",
                    )}
                    onClick={() => setCategoryFilter(category)}
                  >
                    {resolveCategoryLabel(intl, category)}
                  </button>
                );
              })}
            </div>
          ) : null}

          {loading && entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.memory.management.loading" })}
            </div>
          ) : errorWithoutData ? null : visibleEntries.length === 0 ? (
            <div
              data-testid={TID_SETTINGS_MCM_EMPTY}
              className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
            >
              {intl.formatMessage({ id: "settings.memory.management.empty" })}
            </div>
          ) : (
            <>
              {selectableVisibleIds.length > 0 ? (
                <div className="flex items-center gap-3 px-1 text-ui-sm text-foreground-subtle">
                  <Checkbox
                    id="settings-mcm-select-all"
                    data-testid={TID_SETTINGS_MCM_SELECT_ALL}
                    checked={
                      selectedVisibleCount === selectableVisibleIds.length
                        ? true
                        : selectedVisibleCount > 0
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(checked) => toggleAllVisible(checked === true)}
                  />
                  <label
                    className="cursor-pointer select-none"
                    htmlFor="settings-mcm-select-all"
                  >
                    {intl.formatMessage({ id: "settings.memory.management.selectAll" })}
                  </label>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-xl bg-surface">
                {visibleEntries.map((entry, index) => {
                  const merged = isMergedEntry(entry);
                  const statusLabelKey =
                    STATUS_LABEL_KEY[entry.status] ?? "settings.memory.management.status.archived";
                  return (
                    <Fragment key={entry.id}>
                      {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                      <div
                        data-testid={testId(TID_SETTINGS_MCM_ITEM, String(entry.id))}
                        className="flex min-w-0 gap-3 px-4 py-3"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={selectedIds.has(entry.id)}
                          disabled={entry.status === "archived"}
                          data-testid={testId(TID_SETTINGS_MCM_ITEM_SELECT, String(entry.id))}
                          aria-label={`#${entry.id}`}
                          onCheckedChange={(checked) => toggleSelection(entry.id, checked === true)}
                        />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {resolveCategoryLabel(intl, entry.category)}
                            </Badge>
                            <Badge variant={entry.status === "permanent" ? "default" : "secondary"}>
                              {intl.formatMessage({ id: statusLabelKey })}
                            </Badge>
                            {merged ? (
                              <Badge variant="outline">
                                {intl.formatMessage({
                                  id: "settings.memory.management.badge.merged",
                                })}
                              </Badge>
                            ) : null}
                            <span className="text-ui-xs text-foreground-subtle">
                              {intl.formatMessage(
                                { id: "settings.memory.management.updatedAt" },
                                { time: updatedAtFormatter.format(new Date(entry.updatedAt)) },
                              )}
                            </span>
                            <span className="text-ui-xs text-foreground-subtle">
                              {intl.formatMessage(
                                { id: "settings.memory.management.importance" },
                                { value: entry.importance },
                              )}
                            </span>
                          </div>
                          <div className="break-words text-ui-base leading-6 whitespace-pre-wrap text-foreground">
                            {entry.content}
                          </div>
                          {entry.status === "archived" && entry.archiveReason ? (
                            <div className="text-ui-sm text-foreground-subtle">
                              {intl.formatMessage(
                                { id: "settings.memory.management.archiveReason" },
                                { reason: entry.archiveReason },
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </Fragment>
                  );
                })}
              </div>

              {truncated ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "settings.memory.management.truncated" },
                      { count: entries.length },
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={TID_SETTINGS_MCM_LOAD_MORE}
                    disabled={loadingMore}
                    onClick={() => void load(entries.length)}
                  >
                    {intl.formatMessage({ id: "settings.memory.management.loadMore" })}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next && !archiving) setDialogOpen(false);
        }}
      >
        <AlertDialogContent data-testid={TID_SETTINGS_MCM_ARCHIVE_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.memory.management.archive.dialogTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: "settings.memory.management.archive.dialogDescription" },
                { count: selectedEntries.length },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <label
              className="text-ui-sm font-medium text-foreground"
              htmlFor="settings-mcm-archive-reason"
            >
              {intl.formatMessage({ id: "settings.memory.management.archive.reasonLabel" })}
            </label>
            <Textarea
              id="settings-mcm-archive-reason"
              data-testid={TID_SETTINGS_MCM_ARCHIVE_REASON}
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              rows={3}
              placeholder={intl.formatMessage({
                id: "settings.memory.management.archive.reasonPlaceholder",
              })}
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="text-right text-ui-xs text-foreground-subtle">
              {reason.length}/{REASON_MAX_LENGTH}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              type="button"
              size="sm"
              data-testid={TID_SETTINGS_MCM_ARCHIVE_CANCEL}
              disabled={archiving}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              size="sm"
              data-testid={TID_SETTINGS_MCM_ARCHIVE_CONFIRM}
              disabled={archiving || selectedEntries.length === 0}
              onClick={(event) => {
                // 阻止 Radix 默认关闭：废弃是异步操作，等请求返回后再由 submitArchive 收起。
                event.preventDefault();
                void submitArchive();
              }}
            >
              {intl.formatMessage({ id: "settings.memory.management.archive.confirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
