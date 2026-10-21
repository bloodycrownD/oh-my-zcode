import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, type RefObject } from "react";
import type { TrajectorySearchMatch } from "@/ModelTrajectorySearch.js";
import {
  applyTrajectorySearchHighlights,
  clearTrajectorySearchHighlights,
  isTrajectorySearchTargetMounted,
  scrollTrajectorySearchRangeIntoView,
} from "@/ModelTrajectorySearchHighlight.js";
import type { IntlShape } from "@/ModelTrajectoryPaneParts.js";
import { ModelTrajectoryTurnGroup } from "@/ModelTrajectoryTurnGroup.js";
import type { TrajectoryTurnGroup } from "@/ModelTrajectoryTurns.js";

export function ModelTrajectoryTimeline({
  turnGroups,
  searchQuery,
  searchMatches,
  activeSearchMatch,
  intl,
  scrollContainerRef,
}: {
  /** 虚拟化单位（B-5）：一行 = 一个回合，展开后行内渲染该回合的 CallCard 列表。 */
  turnGroups: TrajectoryTurnGroup[];
  searchQuery: string;
  searchMatches: TrajectorySearchMatch[];
  activeSearchMatch: TrajectorySearchMatch | null;
  intl: IntlShape;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const virtualizer = useVirtualizer({
    count: turnGroups.length,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => turnGroups[index]?.key ?? index,
    // 回合外壳默认收起，估算值按「表头两行」给（序号行 + 计数行）；
    // 展开后由 measureElement 实测修正。
    estimateSize: () => 64,
    overscan: 3,
  });
  // 搜索切换会同时收起旧命中并展开新命中；此时禁止 virtualizer 根据每次测高回调连续
  // 修正滚动锚点，由下方文本级定位在布局稳定后一次完成滚动。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => !searchQuery;
  const roleWidthLabels = ["system", "user", "assistant", "tool"].map((role) =>
    intl.formatMessage({ id: `modelTrajectory.role.${role}` }),
  );
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems.at(-1);
  const topSpacerHeight = firstVirtualItem?.start ?? 0;
  const bottomSpacerHeight = lastVirtualItem ? virtualizer.getTotalSize() - lastVirtualItem.end : 0;
  // 只跟踪挂载集合。把 start 放进依赖会让每次动态测高都重新安排一次精确滚动。
  const mountedRowsKey = virtualItems.map((item) => item.key).join("|");

  useEffect(() => () => clearTrajectorySearchHighlights(), []);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (
      !activeSearchMatch ||
      !root ||
      isTrajectorySearchTargetMounted(root, activeSearchMatch.expansionKey)
    ) {
      return;
    }
    // 虚拟化单位已是回合：先滚到命中回合（回合由 reveal 上下文强制展开），
    // 再由文本级定位完成消息内的一次性精确定位。
    virtualizer.scrollToIndex(activeSearchMatch.turnIndex, { align: "center" });
  }, [activeSearchMatch, scrollContainerRef, virtualizer]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !searchQuery) {
      clearTrajectorySearchHighlights();
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      virtualizer.measure();
      secondFrame = window.requestAnimationFrame(() => {
        const activeRange = applyTrajectorySearchHighlights({
          root,
          query: searchQuery,
          matches: searchMatches,
          activeMatch: activeSearchMatch,
        });
        if (activeRange) scrollTrajectorySearchRangeIntoView(activeRange, root);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [
    activeSearchMatch,
    mountedRowsKey,
    scrollContainerRef,
    searchMatches,
    searchQuery,
    virtualizer,
  ]);

  return (
    <ol
      data-trajectory-timeline=""
      className="grid grid-cols-[max-content_minmax(0,1fr)_auto] gap-x-2"
    >
      {roleWidthLabels.map((label) => (
        <li
          key={label}
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 h-0 overflow-hidden whitespace-nowrap font-mono text-ui-sm"
        >
          {label}
        </li>
      ))}
      {topSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: topSpacerHeight }} />
      ) : null}
      {virtualItems.map((virtualItem) => {
        const group = turnGroups[virtualItem.index];
        if (!group) return null;
        return (
          <li
            key={group.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-trajectory-virtual-row=""
            className="col-span-full grid w-full grid-cols-subgrid"
          >
            <ModelTrajectoryTurnGroup group={group} intl={intl} />
          </li>
        );
      })}
      {bottomSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: bottomSpacerHeight }} />
      ) : null}
    </ol>
  );
}
