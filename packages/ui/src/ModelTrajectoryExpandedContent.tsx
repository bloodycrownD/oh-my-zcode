import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import { ExpandIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { clampOverflowPx, isClampOverflow } from "@/ModelTrajectoryClamp.js";
import { messageClipboardText, useTrajectoryMessageView } from "@/ModelTrajectoryMessageView.js";
import { ContentPartView } from "@/ModelTrajectoryPaneDetails.js";
import {
  trajectoryToolCallInputs,
  trajectoryToolHasError,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
} from "@/ModelTrajectoryToolPayload.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * 折叠行的展开内容（spec trace-nm-borrow Step 4 / N-5，路径 A）。
 *
 * - clamp：内容超过 6 行（max-h-[6lh]）时裁剪，底部渐隐提示还有下文；
 * - 溢出胶囊：维持现状条件（isOverflowing && !searchRevealed），点开即解除 clamp；
 * - 全屏入口：条件是持久态 overflowEver（搜索命中解除 clamp 后测量回落也不消失），
 *   打开全屏只读 Modal（Step 5 接线：状态挂在回合外层的 MessageViewHost）。
 */
export function TrajectoryExpandedContent({
  message,
  role,
  open,
  searchRevealed,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  role: "system" | "user" | "assistant" | "tool";
  open: boolean;
  searchRevealed: boolean;
  intl: IntlShape;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  // 最近一次测量的高度（scrollHeight / clientHeight）：
  // 底部渐隐的宽度按真实溢出量现算（上限 24px），裁得越多、渐隐越明显；
  // 不溢出时宽度取 0，不留旧值（遮罩残留）。
  const [overflowMetrics, setOverflowMetrics] = useState({ scrollHeight: 0, clientHeight: 0 });
  // 持久态「曾经溢出」：searchRevealed 会摘掉 max-h，此时重新测量只会得到「不再溢出」，
  // 全屏入口若跟着回落就会在搜索命中期间凭空消失——所以这里只置位、不回退。
  const [overflowEver, setOverflowEver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const metadata = trajectoryToolMetadata(message);
  const toolPayloadHasError = trajectoryToolHasError(message);
  const toolPayloads = message.parts.some((part) => part.kind === "tool-result")
    ? trajectoryToolOutputs(message)
    : trajectoryToolCallInputs(message);
  // 全屏视图的正文：取复制文本口径（与行内展示同源，避免两处内容漂移）。
  const fullContentText = messageClipboardText(message);

  // C-P2-10：正文变化时重置展开态与溢出态——沿用旧正文的「展开全部 / 曾经溢出」对新正文是错的。
  // 用「渲染期调整 state」而非 useEffect：useEffect 复位会与 ResizeObserver 重测竞态
  // （RO 先回调置位、复位后到 → 全屏入口被误清），渲染期调整保证复位先于本次提交后的测量。
  const [measuredText, setMeasuredText] = useState(fullContentText);
  if (measuredText !== fullContentText) {
    setMeasuredText(fullContentText);
    setShowAll(false);
    setOverflowEver(false);
    setIsOverflowing(false);
  }

  const measureOverflow = useCallback(() => {
    const element = contentRef.current;
    if (!element || showAll) return;
    const scrollHeight = element.scrollHeight;
    const clientHeight = element.clientHeight;
    setOverflowMetrics((previous) =>
      previous.scrollHeight === scrollHeight && previous.clientHeight === clientHeight
        ? previous
        : { scrollHeight, clientHeight },
    );
    const overflowing = isClampOverflow({ scrollHeight, clientHeight });
    setIsOverflowing(overflowing);
    if (overflowing) {
      setOverflowEver(true);
    }
  }, [showAll]);

  useLayoutEffect(() => {
    measureOverflow();
    // measuredText 入 deps（r1 CR P1-1）：内容变化时上面的渲染期复位会清掉溢出态，
    // 但 RO 观察的是被 6lh 钳住的盒子（外框高度不变、RO 不触发）——必须由本 effect 重测，
    // 否则「查看全文」入口与溢出胶囊在内容变化后被永久抹掉。
  }, [measureOverflow, measuredText]);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    observer?.observe(element);
    window.addEventListener("resize", measureOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow]);

  useEffect(() => {
    if (!open) setShowAll(false);
  }, [open]);

  const contentExpanded = showAll || searchRevealed;
  const clipped = isOverflowing && !contentExpanded;
  // 溢出胶囊的可见条件维持现状（isOverflowing && !searchRevealed）。
  const capsuleVisible = isOverflowing && !searchRevealed;
  // 渐隐遮罩宽度现算：溢出像素数取最近一次测量值（上限 24px），不溢出时为 0——
  // 旧实现把宽度存进 state，内容变化后会残留上一次的渐隐高度。
  const overflowPx = clipped ? Math.min(clampOverflowPx(overflowMetrics), 24) : 0;
  const maskImage = clipped
    ? `linear-gradient(to bottom, black 0%, black calc(100% - ${overflowPx}px), transparent 100%)`
    : undefined;
  const fullContentLabel = intl.formatMessage({ id: "modelTrajectory.viewFullContent" });
  // 全屏视图的标题：与正文同源的标题行。
  const fullContentTitle = intl.formatMessage({ id: "modelTrajectory.fullContentTitle" });
  // 正文为空时不提供全屏入口（打开也是空白）。
  const hasFullContent = fullContentText.trim() !== "";
  const { open: openFullContent } = useTrajectoryMessageView();

  return (
    <div data-trajectory-expanded-content-shell="" className="relative min-w-0">
      <div
        // 浮动按钮的占位留白放在 clamp 盒之外：留白若在盒内会挤占 6 行的可视高度。
        // pb-2 无条件保留（r1 CR P2-2：短内容也需底部留白）；溢出时升级为 pb-12 给浮动按钮带让位。
        className={cn("relative min-w-0 pb-2", overflowEver && "pb-12")}
      >
        <div
          ref={contentRef}
          data-trajectory-message-content=""
          data-trajectory-user-content-card={role === "user" ? "" : undefined}
          data-overflow-clipped={clipped || undefined}
          className={cn(
            // text-ui-sm/leading-relaxed 让 max-h-[6lh] 的「6 行」与正文行高对齐；
            // 内容盒不留 pb（留白由盒外的 pb-12 浮动按钮带承担），否则 6 行里只有 5 行半可见。
            "flex w-full min-w-0 flex-col gap-1.5 overflow-hidden px-3 pt-0 text-ui-sm leading-relaxed",
            !contentExpanded && "max-h-[6lh]",
          )}
          style={{ maskImage, WebkitMaskImage: maskImage }}
        >
          {metadata.names || metadata.ids ? (
            <div className="flex min-w-0 items-center gap-1">
              {metadata.names ? (
                <Badge
                  data-trajectory-expanded-tool-name=""
                  data-trajectory-search-field="tool-name"
                  variant="outline"
                  className="h-5 rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                  title={metadata.names}
                >
                  {metadata.names}
                </Badge>
              ) : null}
              {metadata.ids ? (
                <Badge
                  data-trajectory-expanded-tool-id=""
                  data-trajectory-search-field="tool-id"
                  variant="outline"
                  className="h-5 min-w-0 truncate rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                  title={metadata.ids}
                >
                  {metadata.ids}
                </Badge>
              ) : null}
            </div>
          ) : null}
          {toolPayloads.length > 0
            ? toolPayloads.map((output, outputIndex) => (
                <pre
                  key={outputIndex}
                  data-trajectory-search-field="content"
                  data-trajectory-tool-error-content={toolPayloadHasError ? "" : undefined}
                  className={cn(
                    "min-w-0 whitespace-pre-wrap break-words font-mono text-ui-sm leading-relaxed",
                    toolPayloadHasError
                      ? "rounded-lg bg-destructive/10 px-2 py-1.5 text-destructive"
                      : "text-foreground",
                  )}
                >
                  {output.trim()}
                </pre>
              ))
            : message.parts.map((part, partIndex) => (
                <div key={partIndex} data-trajectory-search-field="content">
                  <ContentPartView
                    part={
                      "text" in part && typeof part.text === "string"
                        ? { ...part, text: part.text.trim() }
                        : part
                    }
                    intl={intl}
                    showToolHeader={false}
                  />
                </div>
              ))}
        </div>
        {capsuleVisible ? (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <Button
              data-trajectory-overflow-toggle=""
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full bg-surface/90 px-2 text-ui-sm shadow-sm supports-[backdrop-filter]:bg-surface/70 supports-[backdrop-filter]:backdrop-blur-md"
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
              {intl.formatMessage({
                id: showAll ? "modelTrajectory.collapseContent" : "modelTrajectory.showAll",
              })}
            </Button>
          </div>
        ) : null}
        {overflowEver && hasFullContent ? (
          <div className="absolute bottom-3 right-3">
            <Button
              data-trajectory-full-content-trigger=""
              type="button"
              variant="outline"
              size="icon-sm"
              className="rounded-full bg-surface/90 text-foreground-subtle shadow-sm supports-[backdrop-filter]:bg-surface/70 supports-[backdrop-filter]:backdrop-blur-md"
              aria-label={fullContentLabel}
              title={fullContentLabel}
              onClick={() => openFullContent({ title: fullContentTitle, text: fullContentText })}
            >
              <ExpandIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
