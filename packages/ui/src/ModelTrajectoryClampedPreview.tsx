// 轨迹输入区「扁平行」的 clamp 预览容器（spec trace-nm-borrow Step 4 / N-5，路径 B）。
//
// 为什么独立成文件：路径 A（折叠行）已有 TrajectoryExpandedContent 承载「展开胶囊 + 全屏入口」，
// 路径 B 的输入区扁平行是另一种结构（无 Collapsible、无展开胶囊），二者形态不可复用，
// 强行合并会让路径 A 的展开态逻辑被路径 B 的无展开态污染。
//
// 依赖方向：本模块 → ModelTrajectoryClamp（纯判定）+ ModelTrajectoryExpansion（搜索命中判定）。
// 不反向依赖 PaneParts/CallInput，避免循环导入（AGENTS.md 禁止循环导入）。
import type { ReactNode } from "react";
import { ExpandIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isClampOverflow } from "@/ModelTrajectoryClamp.js";
import { useTrajectorySearchRevealed } from "@/ModelTrajectoryExpansion.js";
import { useTrajectoryMessageView } from "@/ModelTrajectoryMessageView.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * 输入区扁平行（assistant 等非折叠角色的消息行）的内容容器。
 *
 * - clamp：v1.0.19 起单行截断（max-h-[1lh]，与用户消息预览形态一致）；
 * - 搜索命中：本行被搜索命中时解除 clamp（否则高亮落在被裁区域里看不见）；
 * - 全屏入口：溢出后出现「查看全文」按钮，打开全屏只读 Modal（Step 5 接线）。
 */
export function TrajectoryClampedPreview({
  expansionKey,
  fullContentText,
  intl,
  children,
}: {
  /** 本行展开键：搜索命中判定按它匹配（与搜索索引的 input row key 同源）。 */
  expansionKey?: string;
  /** 全屏视图的正文（由调用方按消息的复制文本口径给出，容器本身不解析消息结构）。 */
  fullContentText?: string;
  intl: IntlShape;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // 持久态「曾经溢出」：搜索命中解除 clamp 后重新测量只会得到「不再溢出」，
  // 入口若跟着回落就会在搜索命中期间凭空消失——这里只置位、不回退。
  const [overflowEver, setOverflowEver] = useState(false);
  const searchRevealed = useTrajectorySearchRevealed(expansionKey);
  // 全屏视图的正文（调用方按复制文本口径给出）：为空时不提供全屏入口。
  const contentText = fullContentText ?? "";

  // C-P2-10：正文变化时重置溢出态——沿用旧正文的「曾经溢出」对新正文是错的。
  // 用「渲染期调整 state」而非 useEffect：useEffect 复位会与 ResizeObserver 重测竞态
  // （RO 先回调置位、复位后到 → 全屏入口被误清），渲染期调整保证复位先于本次提交后的测量。
  const [measuredText, setMeasuredText] = useState(contentText);
  if (measuredText !== contentText) {
    setMeasuredText(contentText);
    setOverflowEver(false);
  }

  const measureOverflow = useCallback(() => {
    const element = contentRef.current;
    if (!element) return;
    if (
      isClampOverflow({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight })
    ) {
      setOverflowEver(true);
    }
  }, []);

  useLayoutEffect(() => {
    measureOverflow();
    // measuredText 入 deps（r1 CR P1-1）：内容变化时上面的渲染期复位会清掉溢出态，
    // 但 RO 观察的是被钳住的盒子（v1.0.19 起单行截断；外框高度不变、RO 不触发）——必须由本 effect 重测，
    // 否则「查看全文」入口（路径 B 唯一出口）在内容变化后被永久抹掉。
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

  const fullContentLabel = intl.formatMessage({ id: "modelTrajectory.viewFullContent" });
  const fullContentTitle = intl.formatMessage({ id: "modelTrajectory.fullContentTitle" });
  const { open: openFullContent } = useTrajectoryMessageView();

  return (
    <div data-trajectory-clamped-preview="" className="col-span-2 flex min-w-0 flex-col gap-1">
      <div
        ref={contentRef}
        data-trajectory-clamped-content=""
        className={cn(
          // v1.0.19：单行截断（用户拍板「与用户消息同为单行」）——max-h-[1lh] 只露首行，
          // 全文走「查看全文」全屏。text-ui-sm/leading-relaxed 与正文行高对齐。
          "flex min-w-0 flex-col gap-1.5 overflow-hidden text-ui-sm leading-relaxed",
          !searchRevealed && "max-h-[1lh]",
        )}
      >
        {children}
      </div>
      {overflowEver && contentText.trim() !== "" ? (
        <div className="flex min-w-0 justify-end">
          <Button
            data-trajectory-full-content-trigger=""
            type="button"
            variant="outline"
            size="xs"
            className="h-5 gap-1 rounded-full px-2 text-ui-xs text-foreground-subtle"
            aria-label={fullContentLabel}
            title={fullContentLabel}
            onClick={() => openFullContent({ title: fullContentTitle, text: contentText })}
          >
            <ExpandIcon className="size-3" />
            {fullContentLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
