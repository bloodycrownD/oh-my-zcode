import {
  buildPreviewText,
  DEFAULT_MAX_PREVIEW_CHARS,
  DEFAULT_MAX_PREVIEW_PARAGRAPHS,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export type ConversationTurnNavigatorAssistantPreviewKind = "empty" | "running" | "text";

export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
}

interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
  /**
   * 可选：`unitIndex -> item` 索引。滚动路径上 items 变化极少而每次滚动都要重算，
   * 传入组件侧已缓存的索引即可跳过每次调用 O(N) 的 `new Map(items.map(...))`；
   * 缺省时函数内自建，保持纯函数可单测、向后兼容。
   */
  itemByUnitIndex?: Map<number, ConversationTurnNavigatorItem>;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

/** 归一化（start/end 已夹取为有限非负）且按 start 升序、rowId 升序排好的位置表。 */
export interface ConversationTurnNavigatorNormalizedQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
  /**
   * 可选：同一批 positions 的归一化+排序结果（由
   * `normalizeConversationTurnNavigatorQueryPositions` 产出）。调用方已持有排序结果时
   * 传入，跳过每次调用的 `map().sort()`；缺省时函数内自建。
   */
  normalizedPositions?: readonly ConversationTurnNavigatorNormalizedQueryPosition[];
}

type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

export type ConversationTurnNavigatorHydrationResult =
  | { status: "hydrated"; logEpoch: string }
  | { status: "not-enough-queries"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

/**
 * rail 的目录可见性输入（store 的窄投影目录状态的窄面）。
 *
 * 只带裁决 rail 显隐所需的四个数：条目数据由 items 合并层消费，这里不复制条目数组，
 * 免得同一份目录在组件里存第二份。
 */
export interface ConversationTurnNavigatorDirectoryView {
  /** 是否成功取过一次目录（未取过时不能按「空」判隐藏，否则首帧闪一下）。 */
  loaded: boolean;
  entryCount: number;
  /** 服务端现算的 realUser query 权威总数。 */
  realUserQueryTotal: number;
  /** 更早方向仍有条目。 */
  hasMore: boolean;
}

/**
 * 宽屏是否该拉一次 turn 目录。
 *
 * 目录模式下判定输入从「窗口里还有没有更早行」换成目录自身的两个事实：
 * `realUserQueryTotal`（够不够两条 query 撑起 rail）与 `directoryHasMore`
 * （更早方向还有没有没取到的条目）。两者都未知（首轮、尚未取过目录）时，
 * 仍以 `canLoadOlder` 放行——「不知道」不能当成「不需要」。
 */
export function shouldHydrateConversationTurnNavigatorDirectory(params: {
  canLoadOlder: boolean;
  containerWidthPx: number;
  hasLoadHandler: boolean;
  loadingDirectory: boolean;
  realUserQueryTotal?: number;
  directoryHasMore?: boolean;
}): boolean {
  if (!params.hasLoadHandler || params.loadingDirectory) return false;
  if (params.containerWidthPx < CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX) return false;
  const total = params.realUserQueryTotal;
  if (total !== undefined) {
    // 权威总数不足两条：rail 不会出现，不必 hydrate。
    if (total < 2) return false;
    // 目录已取齐（更早方向没有条目）：没有可补的内容。
    if (params.directoryHasMore === false) return false;
    return true;
  }
  return params.canLoadOlder;
}

/**
 * rail 是否隐藏。
 *
 * 目录已知且「一条都没有、权威总数也不足两条」时隐藏——这时 rail 画出来是一根空条。
 * 尚未取过目录（`loaded === false`）一律不隐藏：加载中隐藏会在首帧闪一下。
 */
export function shouldHideConversationTurnNavigatorRail(
  directory: ConversationTurnNavigatorDirectoryView | undefined,
): boolean {
  if (!directory?.loaded) return false;
  return directory.entryCount === 0 && directory.realUserQueryTotal < 2;
}

export function resolveConversationTurnNavigatorHydrationRetryDelayMs(
  failedAttemptCount: number,
): number | null {
  if (failedAttemptCount === 1) return 250;
  if (failedAttemptCount === 2) return 1_000;
  return null;
}

// 摘要口径（折叠/分段/截断三件套）已下沉到 @zcode/shared 的 previewText.ts：
// 服务端 turn 目录要出同一口径的 queryPreview / assistantPreview，两处实现必然漂移。
// 这里只留依赖 UI 类型的 buildAssistantPreview。

function buildAssistantPreview(
  unit: ConversationTurnRenderUnit,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
): {
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
} {
  if (unit.assistantTextRows.length > 0) {
    return {
      assistantPreview: buildPreviewText({
        texts: unit.assistantTextRows.map((row) => row.text),
        fallback: options.assistantEmptyPreview,
        maxPreviewChars: options.maxPreviewChars,
        maxPreviewParagraphs: options.maxPreviewParagraphs,
      }),
      assistantPreviewKind: "text",
    };
  }

  if (unit.isRunning) {
    return {
      assistantPreview: options.assistantRunningPreview,
      assistantPreviewKind: "running",
    };
  }

  return {
    assistantPreview: options.assistantEmptyPreview,
    assistantPreviewKind: "empty",
  };
}

export function buildConversationTurnNavigatorItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
): ConversationTurnNavigatorItem[] {
  const resolvedOptions: Required<BuildConversationTurnNavigatorItemsOptions> = {
    ...options,
    maxPreviewChars: options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: options.maxPreviewParagraphs ?? DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  };

  return units.flatMap((unit, unitIndex) => {
    // provider/store 的物理 role=user 还包含 background/goal/mailbox
    // 等系统上下文；目录代表用户主动 query，只能使用投影明确裁决的 realUser。
    const realUserInputs = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
    if (unit.timelineOnly || realUserInputs.length === 0) {
      return [];
    }

    // 导航项按 query 拆分，但 hover 的 assistant 摘要保持旧产品语义：
    // 取所属 product turn 的文本结果，不在 renderer 猜测 guide 回复分段。
    const { assistantPreview, assistantPreviewKind } = buildAssistantPreview(unit, resolvedOptions);
    return realUserInputs.map((row, queryIndex) => ({
      // 不能以 product turn 为目录粒度，并把同一 turn 的 steer query
      // 全部拼进一个 preview。目录真正导航的是用户可见 query，必须用稳定 row
      // 身份逐条建项，turnId 只负责把虚拟列表先定位到所属容器。
      key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
      turnId: unit.turnId,
      unitIndex,
      rowId: row.rowId,
      userPreview: buildPreviewText({
        texts: [row.text],
        fallback: resolvedOptions.userFallbackPreview,
        maxPreviewChars: resolvedOptions.maxPreviewChars,
        maxPreviewParagraphs: resolvedOptions.maxPreviewParagraphs,
      }),
      assistantPreview,
      assistantPreviewKind,
      // 同一 running product turn 可能已有多个已结束 guide segment；只有最后一条
      // query 仍代表当前工作，避免所有旧 query 一起呈现 running 强调。
      isRunning: unit.isRunning && queryIndex === realUserInputs.length - 1,
    }));
  });
}

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex(
  options: ResolveConversationTurnNavigatorActiveUnitIndexOptions,
): number | undefined {
  const { items, virtualItems, scrollOffsetPx, viewportHeightPx } = options;
  if (items.length === 0) {
    return undefined;
  }

  const itemByUnitIndex =
    options.itemByUnitIndex ?? new Map(items.map((item) => [item.unitIndex, item]));
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = itemByUnitIndex.get(virtualItem.index);
    if (!item) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart = rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeUnitIndex = item.unitIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeUnitIndex !== undefined) {
    return activeUnitIndex;
  }

  const topVirtualIndex = virtualItems.find((item) => {
    const rowStart = resolveFiniteNonNegative(item.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(item.size));
    return rowEnd >= viewportStart && rowStart <= viewportEnd;
  })?.index;
  if (topVirtualIndex === undefined) {
    return items[0]?.unitIndex;
  }

  return (
    items.find((item) => item.unitIndex >= topVirtualIndex)?.unitIndex ??
    items.findLast((item) => item.unitIndex <= topVirtualIndex)?.unitIndex ??
    items[0]?.unitIndex
  );
}

/**
 * 把原始位置表归一化并排序，供 `resolveConversationTurnNavigatorActiveQueryRowId`
 * 复用（滚动高频路径上避免每次重排）。
 */
export function normalizeConversationTurnNavigatorQueryPositions(
  positions: readonly ConversationTurnNavigatorQueryPosition[],
): ConversationTurnNavigatorNormalizedQueryPosition[] {
  return positions
    .map((position) => {
      const start = resolveFiniteNonNegative(position.start);
      return {
        rowId: position.rowId,
        start,
        end: Math.max(start, resolveFiniteNonNegative(position.end)),
      };
    })
    .sort((left, right) => left.start - right.start || left.rowId - right.rowId);
}

export function resolveConversationTurnNavigatorActiveQueryRowId(
  options: ResolveConversationTurnNavigatorActiveQueryRowIdOptions,
): number | undefined {
  const { positions, scrollOffsetPx, viewportHeightPx } = options;
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  const normalized =
    options.normalizedPositions ?? normalizeConversationTurnNavigatorQueryPositions(positions);

  const visible = normalized.filter(
    (position) => position.end >= viewportStart && position.start <= viewportEnd,
  );
  if (visible.length > 0) {
    return visible.reduce((nearest, candidate) =>
      Math.abs(candidate.start - viewportStart) < Math.abs(nearest.start - viewportStart)
        ? candidate
        : nearest,
    ).rowId;
  }

  return (
    normalized.findLast((position) => position.start <= viewportStart)?.rowId ??
    normalized.find((position) => position.start > viewportStart)?.rowId
  );
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}
