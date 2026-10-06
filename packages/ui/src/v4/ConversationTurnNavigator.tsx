import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  testId,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorBarVisualState,
  resolveConversationTurnNavigatorVisualFocusItemIndex,
  type ConversationTurnNavigatorItem,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  resolveTurnNavigatorActiveItemIndex,
  type ConversationTurnNavigatorMergedItem,
} from "@/v4/conversationTurnNavigatorDirectory.js";
import { DEFAULT_ROW_HEIGHT_ESTIMATE_PX } from "@/v4/timelineRowHeightCache.js";

interface ConversationTurnNavigatorProps {
  /**
   * 合并后的 rail 条目（目录降级项 + 已加载项按 queryRowId 去重，升序稳定）。
   * 由父组件 ConversationTimeline 构建（full/J-2 上提）：rail 的实际渲染条件
   * （turnNavigatorVisible）与左侧 gutter 占位在父层共用同一份派生结果，
   * 子组件不再自算，避免两套条件漂移。
   */
  items: readonly ConversationTurnNavigatorMergedItem[];
  /**
   * 已加载侧条目（buildConversationTurnNavigatorItems 产物，父层随 items 一起
   * 传入）。active 判定的已加载主循环与 loadedItemByUnitIndex 索引以它为源；
   * unitIndex 是虚拟列表单位，与目录降级项的 rail 序占位不同计量，不能混用。
   */
  loadedItems: readonly ConversationTurnNavigatorItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  activeQueryRowId?: number;
  isHydratingDirectory?: boolean;
  /**
   * 目录被页数上限截断时，还没取到的更早条目数；undefined / 0 不渲染提示。
   *
   * 截断必须显式告诉用户：否则 rail 顶部那条「更早没有更多了」的假象会让人以为
   * 会话只有这么几条提问。数量取自服务端现算的权威总数减去已取到的条目数。
   */
  olderEntriesNotLoadedCount?: number;
  /**
   * 当前正文窗口首行 rowId（`rows.window[0].rowId`）。active 定位降级用它判断
   * 「视口是否落在窗口之上的未加载区」；窗口为空时传 undefined。
   */
  windowFirstRowId?: number;
  /**
   * 跳转回调。`isDirectoryFallback` 标记目标行尚未加载（只有目录项），
   * 此时 `unitIndex` 只是 rail 序占位，调用方须按 `rowId` 走拉取闭环定位。
   */
  onJumpToQuery: (
    target: { unitIndex: number; rowId: number; isDirectoryFallback?: boolean },
    behavior: ScrollBehavior,
  ) => void;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

function ConversationTurnNavigatorImpl({
  items,
  loadedItems,
  scrollOffsetPx,
  viewportHeightPx,
  virtualItems,
  activeQueryRowId,
  isHydratingDirectory = false,
  olderEntriesNotLoadedCount,
  windowFirstRowId,
  onJumpToQuery,
}: ConversationTurnNavigatorProps) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [interactionItemIndex, setInteractionItemIndex] = useState<number | undefined>(undefined);
  // 截断提示：rail 只有 36px 宽，正文放不下，视觉上是一条「上面还有」的断口标记，
  // 完整文案（含还差多少条）走 hover 卡与 aria-label——与条目 tooltip 同一套交互。
  const olderEntriesNotLoadedText =
    olderEntriesNotLoadedCount === undefined || olderEntriesNotLoadedCount <= 0
      ? null
      : intl.formatMessage(
          { id: "chat.turnNavigator.olderEntriesNotLoaded" },
          { count: String(olderEntriesNotLoadedCount) },
        );

  // 已加载侧索引：unitIndex 是虚拟列表单位，降级目录项的 unitIndex 只是 rail 序占位，
  // 两者不能混在一张 Map 里（否则 active 判定会撞键）。
  const loadedItemByUnitIndex = useMemo(
    () => new Map(loadedItems.map((item) => [item.unitIndex, item])),
    [loadedItems],
  );
  // 触发量化用**主时间线**行高（DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72）：scrollOffsetPx
  // 是主滚动容器的偏移，与 rail 自身 10px 的行高不同量级，不能混用。量化到「行」后
  // active 重算只在跨行时发生（原来每个滚动像素都重算一次 O(可见行数) 扫描）。
  const scrollOffsetPxFinite = Number.isFinite(scrollOffsetPx) ? Math.max(0, scrollOffsetPx) : 0;
  const scrollRowBucket = Math.floor(scrollOffsetPxFinite / DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
  const activeUnitIndex = useMemo(
    () =>
      resolveConversationTurnNavigatorActiveUnitIndex({
        items: loadedItems,
        itemByUnitIndex: loadedItemByUnitIndex,
        scrollOffsetPx: scrollRowBucket * DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
        viewportHeightPx,
        virtualItems,
      }),
    // 量化值（scrollRowBucket）取代原始 scrollOffsetPx 作为依赖：同一行内滚动不再触发重算。
    [loadedItems, loadedItemByUnitIndex, scrollRowBucket, viewportHeightPx, virtualItems],
  );
  const itemIndexes = useMemo(() => {
    const byRowId = new Map<number, number>();
    // unitIndex（已加载侧）-> 合并后 items 下标：active unit 要落到合并后的 rail 位置。
    const mergedByLoadedUnitIndex = new Map<number, number>();
    items.forEach((item, index) => {
      byRowId.set(item.rowId, index);
      if (!item.isDirectoryFallback && !mergedByLoadedUnitIndex.has(item.unitIndex)) {
        mergedByLoadedUnitIndex.set(item.unitIndex, index);
      }
    });
    return { byRowId, mergedByLoadedUnitIndex };
  }, [items]);
  const loadedActiveItemIndex =
    activeQueryRowId === undefined ? undefined : itemIndexes.byRowId.get(activeQueryRowId);
  const loadedUnitActiveItemIndex =
    activeUnitIndex === undefined
      ? undefined
      : itemIndexes.mergedByLoadedUnitIndex.get(activeUnitIndex);
  const loadedActiveItemIndexFinal = loadedActiveItemIndex ?? loadedUnitActiveItemIndex;
  // active 定位降级三态：已加载主循环 → 未加载区取第一个未加载目录项 → 混合态已加载优先。
  const activeItemIndex =
    resolveTurnNavigatorActiveItemIndex({
      items,
      loadedActiveItemIndex: loadedActiveItemIndexFinal,
      windowFirstRowId,
    }) ?? -1;
  const visualFocusItemIndex = resolveConversationTurnNavigatorVisualFocusItemIndex({
    activeItemIndex,
    interactionItemIndex,
  });
  const railScrollRef = useRef<HTMLDivElement>(null);
  const getRailScrollElement = useCallback(() => railScrollRef.current, []);
  const getRailItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const railVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 10,
    getItemKey: getRailItemKey,
    getScrollElement: getRailScrollElement,
    overscan: 6,
  });
  const virtualRows = railVirtualizer.getVirtualItems();

  useEffect(() => {
    if (activeItemIndex < 0 || items.length < 2) return;
    railVirtualizer.scrollToIndex(activeItemIndex, { align: "auto" });
    const element = railScrollRef.current;
    if (!element) return;
    window.queueMicrotask(() => {
      if (railScrollRef.current !== element) return;
      // 目录从 tail 一次扩展到上千项时，scrollToIndex 与 virtualizer 的
      // measurement 更新处于同一个 commit，Chromium 可能合并 scroll 通知。补发通知
      // 只同步 rail observer，确保活动项对应的可视窗口立即挂载。
      element.dispatchEvent(new Event("scroll"));
    });
  }, [activeItemIndex, items.length, railVirtualizer]);

  // 条目不足两条时不渲染的裁决在父层 turnNavigatorVisible 完成（full/J-2 单一真源），
  // 本组件只保留上面 effect 内的 items.length 守卫。

  return (
    <nav
      aria-label={intl.formatMessage({ id: "chat.turnNavigator.label" })}
      aria-busy={isHydratingDirectory}
      data-testid={TID_V4_TURN_NAVIGATOR}
      data-item-count={items.length}
      data-rendered-item-count={virtualRows.length}
      className="pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 -translate-x-2 opacity-0 transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none @min-[864px]/conversation:visible @min-[864px]/conversation:translate-x-0 @min-[864px]/conversation:opacity-100"
    >
      {olderEntriesNotLoadedText !== null ? (
        <HoverCard closeDelay={80} openDelay={120}>
          <HoverCardTrigger asChild>
            <div
              data-testid={testId(TID_V4_TURN_NAVIGATOR, "older-entries-not-loaded")}
              data-missing-entry-count={olderEntriesNotLoadedCount}
              aria-label={olderEntriesNotLoadedText}
              className="pointer-events-auto absolute left-3 top-6 z-10 flex w-9 flex-col items-center gap-0.5"
            >
              <span className="block h-px w-3 bg-foreground-subtlest" />
              <span className="block h-px w-2 bg-foreground-subtlest" />
              <span className="block h-px w-3 bg-foreground-subtlest" />
            </div>
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            side="right"
            sideOffset={8}
            data-testid={testId(TID_V4_TURN_NAVIGATOR_TOOLTIP, "older-entries-not-loaded")}
            className="w-80 max-w-[calc(100vw-2rem)] border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <p className="whitespace-pre-line text-ui-base leading-5 text-popover-foreground/80">
              {olderEntriesNotLoadedText}
            </p>
          </HoverCardContent>
        </HoverCard>
      ) : null}
      <div
        ref={railScrollRef}
        // 只声明 overflow-y-auto 时，浏览器会把 overflow-x 计算为 auto；
        // hover 山峰横向放大后便可能触发横向滚动条，因此 rail 必须只开放纵向滚动。
        className="!scrollbar-hide pointer-events-auto absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
        onPointerLeave={() => setInteractionItemIndex(undefined)}
        onScroll={() => setInteractionItemIndex(undefined)}
      >
        <div className="relative w-9" style={{ height: `${railVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow) => {
            const itemIndex = virtualRow.index;
            const item = items[itemIndex];
            if (!item) return null;
            const active = itemIndex === activeItemIndex;
            const visualState = resolveConversationTurnNavigatorBarVisualState({
              itemIndex,
              visualFocusItemIndex,
            });
            const showScrollActiveColor = visualFocusItemIndex === undefined && active;
            return (
              <div
                key={item.key}
                className="absolute left-0 top-0 h-2.5 w-9"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <HoverCard closeDelay={80} openDelay={120}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      aria-current={active ? "location" : undefined}
                      aria-label={intl.formatMessage(
                        { id: "chat.turnNavigator.jumpToQuery" },
                        { index: String(itemIndex + 1) },
                      )}
                      aria-posinset={itemIndex + 1}
                      aria-setsize={items.length}
                      data-testid={testId(TID_V4_TURN_NAVIGATOR_ITEM, item.key)}
                      data-item-index={itemIndex}
                      data-unit-index={item.unitIndex}
                      data-turn-id={item.turnId}
                      data-query-row-id={item.rowId}
                      data-active={active ? "true" : "false"}
                      data-running={item.isRunning ? "true" : "false"}
                      // 目录降级项（未加载区间）标记：跳转闭环按它区分「目标行尚未加载」。
                      data-directory-fallback={item.isDirectoryFallback ? "true" : "false"}
                      data-visual-color-tone={visualState.colorTone}
                      data-visual-scale={String(visualState.scaleX)}
                      data-visual-tone={visualState.tone}
                      onBlur={() => setInteractionItemIndex(undefined)}
                      onClick={() =>
                        onJumpToQuery(
                          {
                            unitIndex: item.unitIndex,
                            rowId: item.rowId,
                            isDirectoryFallback: item.isDirectoryFallback,
                          },
                          prefersReducedMotion ? "auto" : "smooth",
                        )
                      }
                      onFocus={() => setInteractionItemIndex(itemIndex)}
                      onPointerEnter={() => setInteractionItemIndex(itemIndex)}
                      onPointerLeave={() => setInteractionItemIndex(undefined)}
                      className="flex h-2.5 w-9 items-center justify-start rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span
                        className={cn(
                          "block h-0.5 w-3 origin-left rounded-full transition-[height,opacity,transform,background-color] duration-150 ease-out motion-reduce:transition-none",
                          visualState.colorTone === "focus" && "bg-foreground",
                          visualState.colorTone === "muted" &&
                            (showScrollActiveColor ? "bg-foreground" : "bg-foreground-subtlest"),
                        )}
                        style={{
                          opacity: showScrollActiveColor
                            ? 0.9
                            : item.isRunning
                              ? Math.max(visualState.opacity, 0.72)
                              : visualState.opacity,
                          transform: `scaleX(${visualState.scaleX})`,
                        }}
                      />
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    align="start"
                    side="right"
                    sideOffset={8}
                    data-testid={testId(TID_V4_TURN_NAVIGATOR_TOOLTIP, item.key)}
                    className="w-80 max-w-[calc(100vw-2rem)] border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg"
                  >
                    <div className="space-y-2">
                      <p className="line-clamp-2 whitespace-pre-line text-ui-base font-medium leading-5">
                        {item.userPreview}
                      </p>
                      <p
                        className={cn(
                          "line-clamp-3 whitespace-pre-line text-ui-base leading-5",
                          item.assistantPreviewKind === "text"
                            ? "text-popover-foreground/80"
                            : "text-foreground-subtle",
                        )}
                      >
                        {item.assistantPreview}
                      </p>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export const ConversationTurnNavigator = memo(ConversationTurnNavigatorImpl);
