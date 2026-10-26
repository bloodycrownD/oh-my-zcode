/* eslint-disable max-lines -- 项目记忆面板集中维护列表、分类过滤、批量勾选与废弃确认对话框的共享状态；拆分会凭增跨组件的选中态传递。 */
/**
 * FORK（magic-context-memory-management / Step 8 · 变更点 9）：「记忆」分区的
 * magic-context 跨会话项目记忆管理面板。
 *
 * FORK（session-memory-and-context / P1 真分页返工）：数字分页（PAGE_SIZE_OPTIONS
 * 10/20/50/100 默认 20 + 服务端 total 推导页数）+ 分类过滤切到服务端 `category` 参数
 * （词表静态全量，不再从已加载条目派生）；勾选跨页累计（翻页保留、刷新/废弃后清空），
 * 批量废弃仍按 100 分片。
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
  TID_SETTINGS_MCM_ENTRY_EXPAND,
  TID_SETTINGS_MCM_ITEM,
  TID_SETTINGS_MCM_ITEM_SELECT,
  TID_SETTINGS_MCM_LOAD_ERROR,
  TID_SETTINGS_MCM_PAGE_NEXT,
  TID_SETTINGS_MCM_PAGE_NUMBER,
  TID_SETTINGS_MCM_PAGE_PREV,
  TID_SETTINGS_MCM_PAGE_SIZE,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

type MemoryEntry = ZCodeWorkspaceListMagicContextMemoriesResult["entries"][number];
type MemoryCounts = ZCodeWorkspaceListMagicContextMemoriesResult["counts"];

/**
 * 数字分页（session-memory-and-context P1 返工）：可调页大小（10/20/50/100，默认 20——
 * 用户实测 50 偏大），页码窗口可跳转；「过滤后总数」由 wire `total` 精确给出（P1 首版
 * 仅 truncated 只能做 prev/next 的假分页）；分类过滤在服务端完成（`category` 只裁
 * entries，counts 保持全项目五桶口径）。
 */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;
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

/**
 * 标准页码窗口（0 基页码）：首页/尾页恒显、当前页 ±1、间隔 >1 折叠为 "…"。
 * pageCount ≤ 7 时全量直出，不再制造无意义省略号。
 */
function computePageWindow(current: number, pageCount: number): Array<number | "ellipsis"> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index);
  }
  const window: Array<number | "ellipsis"> = [0];
  const from = Math.max(1, current - 1);
  const to = Math.min(pageCount - 2, current + 1);
  if (from > 1) window.push("ellipsis");
  for (let index = from; index <= to; index += 1) window.push(index);
  if (to < pageCount - 2) window.push("ellipsis");
  window.push(pageCount - 1);
  return window;
}

/** 分类徽章/过滤徽章的显示文本；`null` = 「全部分类」，未知分类原样回显。 */
function resolveCategoryLabel(intl: IntlInstance, category: string | null): string {
  if (category === null) {
    return intl.formatMessage({ id: "settings.memory.management.filter.all" });
  }
  const labelKey = CATEGORY_LABEL_KEY[category];
  return labelKey ? intl.formatMessage({ id: labelKey }) : category;
}

/**
 * 单条记忆行（P1 返工）：content 默认两行省略（`line-clamp-2`），检测到溢出才显示
 * 「展开/收起」（scrollHeight/clientHeight 比对，短内容不挂按钮）。行内局部展开态
 * 不进父组件——翻页/刷新时随行卸载自然复位。
 */
function MemoryEntryRow({
  entry,
  selected,
  onToggleSelection,
  updatedAtFormatter,
}: {
  entry: MemoryEntry;
  selected: boolean;
  onToggleSelection: (id: number, checked: boolean) => void;
  updatedAtFormatter: Intl.DateTimeFormat;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const [needsToggle, setNeedsToggle] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = contentRef.current;
    setNeedsToggle(element !== null && element.scrollHeight > element.clientHeight + 1);
  }, [entry.content]);

  const merged = isMergedEntry(entry);
  const statusLabelKey =
    STATUS_LABEL_KEY[entry.status] ?? "settings.memory.management.status.archived";
  return (
    <div
      data-testid={testId(TID_SETTINGS_MCM_ITEM, String(entry.id))}
      className="flex min-w-0 gap-3 px-4 py-3"
    >
      <Checkbox
        className="mt-0.5"
        checked={selected}
        disabled={entry.status === "archived"}
        data-testid={testId(TID_SETTINGS_MCM_ITEM_SELECT, String(entry.id))}
        aria-label={`#${entry.id}`}
        onCheckedChange={(checked) => onToggleSelection(entry.id, checked === true)}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline">{resolveCategoryLabel(intl, entry.category)}</Badge>
          <Badge variant={entry.status === "permanent" ? "default" : "secondary"}>
            {intl.formatMessage({ id: statusLabelKey })}
          </Badge>
          {merged ? (
            <Badge variant="outline">
              {intl.formatMessage({ id: "settings.memory.management.badge.merged" })}
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
        <div
          ref={contentRef}
          className={cn(
            "break-words text-ui-base leading-6 whitespace-pre-wrap text-foreground",
            !expanded && "line-clamp-2",
          )}
        >
          {entry.content}
        </div>
        {needsToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-ui-xs"
            data-testid={testId(TID_SETTINGS_MCM_ENTRY_EXPAND, String(entry.id))}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {intl.formatMessage({
              id: expanded
                ? "settings.memory.management.entry.collapse"
                : "settings.memory.management.entry.expand",
            })}
          </Button>
        ) : null}
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
  );
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
  /** 服务端 truncated：本页之后还有未返回条目 = 精确的「有下一页」。 */
  const [hasNextPage, setHasNextPage] = useState(false);
  /** 服务端 total：当前过滤条件命中后的集合总数（页码窗口与「共 X 条」以此为准）。 */
  const [total, setTotal] = useState(0);
  /** 当前页码（0 基）。分类/页大小切换会整体回到第 1 页（load 变化触发 effect）。 */
  const [page, setPage] = useState(0);
  /** 每页条数（可调）；变化经 load 依赖链同样回到第 1 页。 */
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [archiving, setArchiving] = useState(false);
  /** 丢弃过期响应：翻页与过滤并发时只有最后一次有权回填列表。 */
  const requestVersionRef = useRef(0);

  /**
   * 拉取一页，成功返回本页 entries 与服务端 total（供调用方做越界收敛），失败/过期
   * 返回 undefined。`resetSelection`：刷新/分类切换/废弃完成后清空勾选；纯翻页保留
   * 勾选（跨页累计挑选后批量废弃是合法用法，selectedCount 徽章持续显示累计数）。
   */
  const load = useCallback(
    async (
      targetPage: number,
      options?: { resetSelection?: boolean },
    ): Promise<{ entries: MemoryEntry[]; total: number } | undefined> => {
      if (!targetWorkspacePath) {
        setLoading(false);
        return undefined;
      }
      const version = requestVersionRef.current + 1;
      requestVersionRef.current = version;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await services.zcodeAgentService.listMagicContextMemories({
          workspacePath: targetWorkspacePath,
          limit: pageSize,
          offset: targetPage * pageSize,
          ...(categoryFilter ? { category: categoryFilter } : {}),
        });
        if (requestVersionRef.current !== version) return undefined;
        setSupported(result.supported);
        setAvailable(result.available);
        setUnavailableReason(result.reason ?? null);
        setCounts(result.counts);
        setHasNextPage(result.truncated);
        setTotal(result.total);
        setEntries(result.entries);
        setPage(targetPage);
        if (options?.resetSelection) setSelectedIds(new Set());
        return { entries: result.entries, total: result.total };
      } catch (error) {
        if (requestVersionRef.current !== version) return undefined;
        logger.warn("[MemoryManagementSection] 读取项目记忆失败", {
          error: errorMessage(error),
        });
        setLoadError(errorMessage(error));
        setEntries([]);
        setHasNextPage(false);
        return undefined;
      } finally {
        if (requestVersionRef.current === version) {
          setLoading(false);
        }
      }
    },
    [categoryFilter, pageSize, services, targetWorkspacePath],
  );

  // 初次加载 + 分类切换（categoryFilter 变化 → load 重建 → 回第 1 页重新拉取）。
  useEffect(() => {
    void load(0, { resetSelection: true });
  }, [load]);

  /** 翻页（保留勾选）；失败不跳页（load 内 version 守卫）。 */
  const goToPage = useCallback(
    (targetPage: number) => {
      void load(targetPage);
    },
    [load],
  );

  /**
   * 废弃完成后的回填：停在当前页；回填后当前页被清空时，按最新 total 收敛到最后一
   * 个合法页（total 骤降≥2 页时 page-1 仍越界；archived 行在管理视图不消失、行不真删，
   * 该分支目前不可达，收敛是防御——空态分支不渲染分页条，停在越界空页没有控件可返回）。
   * 读取失败不收敛（load 返回 undefined，错误横幅已由 load 呈现）。
   */
  const reloadAfterArchive = useCallback(
    async (currentPage: number, pageSizeAfterReload: number) => {
      const reloaded = await load(currentPage, { resetSelection: true });
      if (
        reloaded !== undefined &&
        reloaded.entries.length === 0 &&
        reloaded.total > 0
      ) {
        const maxPage = Math.max(0, Math.ceil(reloaded.total / pageSizeAfterReload) - 1);
        if (maxPage < currentPage) {
          await load(maxPage, { resetSelection: true });
        }
      }
    },
    [load],
  );

  /**
   * 分类选项为静态全词表（CATEGORY_LABEL_KEY 的 12 值）：服务端过滤下「从已加载条目
   * 派生选项」只反映当前页，词表是权威面且恒定，某分类无条目时服务端返回空列表走空态。
   */
  const categoryOptions = useMemo(() => Object.keys(CATEGORY_LABEL_KEY), []);

  // 服务端已按 category 过滤：本页 entries 即可见集合，无需客户端再过滤。
  const visibleEntries = entries;

  // 已归档/已合并行不可再废弃（会得到 already-archived / rejected 回执），勾选框直接禁用。
  const selectableVisibleIds = useMemo(
    () => visibleEntries.filter((entry) => entry.status !== "archived").map((entry) => entry.id),
    [visibleEntries],
  );
  const selectedVisibleCount = selectableVisibleIds.filter((id) => selectedIds.has(id)).length;
  /**
   * 勾选以 id 集合为准（跨页累计）：翻页保留，selectedCount 显示累计数。旧页条目不在
   * 当前 entries 里也不影响废弃——memoryIds 直接取 [...selectedIds]；若其中部分 id 已被
   * 其他入口废弃，服务端按 already-archived 幂等回报，不构成错误。
   */
  const selectedCount = selectedIds.size;

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
    const memoryIds = [...selectedIds];
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
      // 无论成败都刷新：失败前已归档的分片必须反映到列表与 counts；刷新清空勾选，
      // 停在当前页（越界空页按最新 total 收敛），失败后重试需重新勾选。
      await reloadAfterArchive(page, pageSize);
      setArchiving(false);
    }
  }, [intl, page, pageSize, reason, reloadAfterArchive, selectedIds, services, targetWorkspacePath]);

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

  /**
   * 占位态文案映射（FORK / cr-func 第 3 轮 P1-1）。
   *
   * `no-app-port` = 本工作区没有活动会话（记忆库随会话装配）——这一态下「请稍后重试」
   * 是**假建议**：除非这期间开了会话，重试永远不会成功。所以它单独一条文案，写的是
   * 用户能执行的动作（先开会话）。
   *
   * 判据刻意**白名单 `disabled`**：未知取值（未来新增的 reason / 旧 CLI 的其它值 /
   * 缺省）落到中性的「暂不可用，稍后重试」，而不是「被关掉了」——后者对未知原因是
   * 另一句假话。`unsupported` 走上面的 `supported === false` 分支，不到这里。
   */
  const unavailableMessageId =
    unavailableReason === "no-app-port"
      ? "settings.memory.management.unavailable.noAppPort"
      : unavailableReason === "disabled"
        ? "settings.memory.management.unavailable.disabled"
        : "settings.memory.management.unavailable.unavailable";

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
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
        >
          <span>{intl.formatMessage({ id: unavailableMessageId })}</span>
          {/* 重试入口：此前该分支没有任何按钮，用户只能离开设置页再进来（remount）才
              能重拉——`no-app-port` 下这是唯一可操作项（开完会话回来点一下）。 */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={TID_SETTINGS_MCM_REFRESH}
            onClick={() => void load(0)}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
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
                  { count: selectedCount },
                )}
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid={TID_SETTINGS_MCM_ARCHIVE_SELECTED}
                disabled={selectedCount === 0 || archiving}
                onClick={() => {
                  setReason("");
                  setDialogOpen(true);
                }}
              >
                {intl.formatMessage({ id: "settings.memory.management.archiveSelected" })}
              </Button>
              <SettingsResourceHeaderActions
                onRefresh={() => void load(page, { resetSelection: true })}
                refreshing={loading}
                refreshTestId={TID_SETTINGS_MCM_REFRESH}
                refreshLabel={intl.formatMessage({ id: "common.refresh" })}
              />
            </div>
          </div>

          {/* 分类过滤为静态全词表（服务端过滤，切换即回第 1 页——load 依赖变化触发 effect）。 */}
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
                {visibleEntries.map((entry, index) => (
                  <Fragment key={entry.id}>
                    {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                    <MemoryEntryRow
                      entry={entry}
                      selected={selectedIds.has(entry.id)}
                      onToggleSelection={toggleSelection}
                      updatedAtFormatter={updatedAtFormatter}
                    />
                  </Fragment>
                ))}
              </div>

              {/* 真分页（P1 返工）：页码窗口可跳转 + 可调页大小 + 过滤后总数区间。
                  页码总数由服务端 total 精确给出；勾选跨页保留。 */}
              {(() => {
                const pageCount = Math.max(1, Math.ceil(total / pageSize));
                return (
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={TID_SETTINGS_MCM_PAGE_PREV}
                      disabled={page === 0 || loading}
                      onClick={() => goToPage(page - 1)}
                    >
                      {intl.formatMessage({ id: "settings.memory.management.page.prev" })}
                    </Button>
                    {computePageWindow(page, pageCount).map((item, index) =>
                      item === "ellipsis" ? (
                        <span key={`ellipsis-${index}`} className="px-1 text-ui-sm text-foreground-subtle">
                          …
                        </span>
                      ) : (
                        <button
                          key={item}
                          type="button"
                          aria-current={item === page ? "page" : undefined}
                          data-testid={testId(TID_SETTINGS_MCM_PAGE_NUMBER, String(item + 1))}
                          className={cn(
                            "min-w-7 rounded-md px-2 py-1 text-ui-sm transition-colors",
                            item === page
                              ? "bg-selected font-medium text-foreground"
                              : "text-foreground-subtle hover:bg-hover",
                          )}
                          disabled={loading}
                          onClick={() => goToPage(item)}
                        >
                          {item + 1}
                        </button>
                      ),
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={TID_SETTINGS_MCM_PAGE_NEXT}
                      disabled={!hasNextPage || loading}
                      onClick={() => goToPage(page + 1)}
                    >
                      {intl.formatMessage({ id: "settings.memory.management.page.next" })}
                    </Button>
                    <span className="px-1 text-ui-sm text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "settings.memory.management.page.range" },
                        {
                          start: total === 0 ? 0 : page * pageSize + 1,
                          end: page * pageSize + visibleEntries.length,
                          total,
                        },
                      )}
                    </span>
                    <Select
                      value={String(pageSize)}
                      disabled={loading}
                      // 页大小变化 → 立即回第 1 页（否则新 pageSize + 旧 page 会瞬时渲染
                      // 越界区间），load 重建（依赖 pageSize）→ effect 重新拉取。
                      onValueChange={(value) => {
                        const next = Number(value);
                        if (Number.isFinite(next) && next > 0) {
                          setPage(0);
                          setPageSize(next);
                        }
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-7 w-auto gap-1 text-ui-sm"
                        data-testid={TID_SETTINGS_MCM_PAGE_SIZE}
                        aria-label={intl.formatMessage({
                          id: "settings.memory.management.page.sizeLabel",
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAGE_SIZE_OPTIONS.map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size} /{" "}
                            {intl.formatMessage({
                              id: "settings.memory.management.page.sizeLabel",
                            })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })()}
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
                { count: selectedCount },
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
              disabled={archiving || selectedCount === 0}
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
