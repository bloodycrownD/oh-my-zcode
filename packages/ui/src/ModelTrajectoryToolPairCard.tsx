// 轨迹面板的工具配对卡（spec trace-nm-borrow Step 3 / N-2，契约 1–9）。
//
// 为什么独立成文件：配对卡有独立的 DOM 契约（搜索字段、两格 clamp、状态点、复制/全屏入口），
// 塞进 ModelTrajectoryPaneParts.tsx 会顶破 400 行上限，也会把搜索契约埋进响应区渲染里。
//
// 依赖方向：本模块 → ToolJoin（join 结果与 key 单源）+ ToolPayload（载荷文本口径）
// + Clamp（溢出判定）+ Expansion（展开态）。不反向依赖 PaneParts/CallInput，避免循环导入。
//
// 数据面提醒：工具结果不在发起调用的 record.response 里，而在**后续 record 的 request.messages**
// （跨记录 join，见 ModelTrajectoryToolJoin.ts）。因此本卡的「结果格」内容来自 join 产物，
// 卡片自身不关心结果出现在哪条记录。
import { ChevronRightIcon, CopyIcon, ExpandIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import type { ZCodeModelTrajectoryContentPart } from "@zcode/services";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { isClampOverflow } from "@/ModelTrajectoryClamp.js";
import { useTrajectoryExpansion } from "@/ModelTrajectoryExpansion.js";
import { useTrajectoryMessageView } from "@/ModelTrajectoryMessageView.js";
import { trajectoryRoleTextClass } from "@/ModelTrajectoryRoleStyles.js";
import {
  trajectoryToolCallBadgeText,
  trajectoryToolCallDisplayText,
  trajectoryToolCallTargetKey,
  type TrajectoryToolCallInfo,
  type TrajectoryToolCallStatus,
} from "@/ModelTrajectoryToolJoin.js";
import { trajectoryToolCallInputs } from "@/ModelTrajectoryToolPayload.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * 一次工具调用的配对卡：左「use」格（调用输入）+ 右「result」格（配对结果）+ 状态点。
 *
 * 契约要点（spec「配对卡 DOM / 搜索 / 展开契约」）：
 * - target key 逐字取 trajectoryToolCallTargetKey（渲染与搜索索引共用单源）；
 * - 卡根是 Radix Collapsible（高亮判定读 data-state），展开内容外层包 data-trajectory-message-expanded；
 * - 卡内保留 tool-name / tool-id 搜索字段（文本优先取配对 result part 的真实名，回退 call part）；
 * - use 格与 result 格各挂 content 搜索字段，use 在前（与索引拼接顺序一致）；
 * - 展开态走 useTrajectoryExpansion 的 "tool-call" 命令槽（不新增命令槽）。
 */
export function TrajectoryToolPairCard({
  info,
  toolCallIndex,
  callKey,
  isAlt = false,
  intl,
}: {
  /** join 产物：与 response.toolCalls 下标对齐。 */
  info: TrajectoryToolCallInfo;
  /** 该调用在 response.toolCalls 里的下标（target key 的组成部分）。 */
  toolCallIndex: number;
  /** 调用级 key（trajectoryCallKey 产物），target key 的前缀。 */
  callKey: string;
  isAlt?: boolean;
  intl: IntlShape;
}) {
  const targetKey = trajectoryToolCallTargetKey(callKey, info.part.kind, toolCallIndex);
  // 契约 4：沿用既有 "tool-call" 命令槽与视觉角色，不新增 TRAJECTORY_EXPANSION_KINDS 条目。
  const { open, searchRevealed, handleOpenChange } = useTrajectoryExpansion({
    key: targetKey,
    commandKind: "tool-call",
  });

  const isUnknown = info.part.kind === "unknown";
  const rawText = rawPartText(info.part);
  const badge = trajectoryToolCallBadgeText(info);
  const copyText = trajectoryToolCallDisplayText(info);
  const useText = trajectoryToolCallInputs({ role: "assistant", parts: [info.part] }).join("\n\n");
  const resultText = info.pairedResultText;
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const fullContentLabel = intl.formatMessage({ id: "modelTrajectory.viewFullContent" });
  const fullContentTitle = intl.formatMessage({ id: "modelTrajectory.fullContentTitle" });
  const { open: openFullContent } = useTrajectoryMessageView();

  const handleCopy = () => {
    if (!copyText || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(copyText).catch((error: unknown) => {
      logger.warn("[ModelTrajectory] 复制工具配对卡内容失败", error);
    });
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      data-trajectory-tool-pair-card=""
      data-trajectory-tool-call-status={info.status}
      data-trajectory-search-target-key={targetKey}
      data-trajectory-row-alt={isAlt || undefined}
      className={cn(
        "group relative col-span-full grid w-full min-w-0 grid-cols-subgrid",
        isAlt && "bg-surface/30",
      )}
    >
      <div className="col-span-full grid min-h-8 w-full min-w-0 grid-cols-subgrid items-center">
        <CollapsibleTrigger
          data-trajectory-tool-pair-trigger=""
          className="col-span-2 grid min-h-8 min-w-0 grid-cols-subgrid items-center py-0 pl-3 text-left text-ui-sm text-foreground-subtle"
        >
          <span
            data-trajectory-role-label="tool-call"
            className={cn(
              "pr-1 font-mono text-ui-sm uppercase",
              trajectoryRoleTextClass("tool-call"),
            )}
          >
            {intl.formatMessage({ id: "modelTrajectory.toolCall" })}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {isUnknown ? null : <ToolStatusDot status={info.status} intl={intl} />}
            <span
              data-trajectory-tool-pair-preview=""
              className="min-w-0 flex-1 truncate font-mono text-foreground"
              title={previewText(useText, resultText)}
            >
              {previewText(useText, resultText)}
            </span>
            {badge.name ? (
              <Badge
                data-trajectory-tool-pair-name=""
                data-trajectory-search-field="tool-name"
                variant="outline"
                className="h-5 shrink-0 rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                title={badge.name}
              >
                {badge.name}
              </Badge>
            ) : null}
            {badge.id ? (
              <Badge
                data-trajectory-tool-pair-id=""
                data-trajectory-search-field="tool-id"
                variant="outline"
                className="h-5 max-w-[40%] shrink-0 truncate rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                title={badge.id}
              >
                {badge.id}
              </Badge>
            ) : null}
          </span>
        </CollapsibleTrigger>
        <span className="relative -ml-1 mr-1 flex items-center justify-end">
          <Button
            data-trajectory-tool-pair-copy=""
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5 rounded-sm text-foreground-subtlest"
            aria-label={copyLabel}
            title={copyLabel}
            disabled={!copyText}
            onClick={handleCopy}
          >
            <CopyIcon className="size-3" />
          </Button>
          <CollapsibleTrigger asChild>
            <Button
              data-trajectory-tool-pair-chevron-trigger=""
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5 rounded-sm text-foreground-subtlest"
              aria-label={intl.formatMessage({
                id: open ? "modelTrajectory.collapse" : "modelTrajectory.expand",
              })}
            >
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            </Button>
          </CollapsibleTrigger>
        </span>
      </div>

      <CollapsibleContent data-trajectory-message-expanded="" className="col-span-full">
        <div
          data-trajectory-tool-pair-content=""
          className="flex min-w-0 flex-col gap-1.5 px-3 pb-2"
        >
          <TrajectoryPairCell
            label={intl.formatMessage({ id: "modelTrajectory.toolInput" })}
            text={useText}
            // unknown 条目回退渲染 raw 原文（不进索引：索引文本为空）。
            rawText={rawText}
            revealed={searchRevealed}
            intl={intl}
          />
          <TrajectoryPairCell
            label={intl.formatMessage({ id: "modelTrajectory.toolOutput" })}
            text={resultText}
            placeholder={resultPlaceholder(info.status, intl)}
            error={info.status === "error"}
            revealed={searchRevealed}
            intl={intl}
          />
          <div className="flex min-w-0 justify-end">
            {/* 全屏入口（Step 5 接线）：正文与卡片复制按钮同源（trajectoryToolCallDisplayText），
                标题优先用工具名（徽标同源），无工具名时回退「消息全文」。 */}
            <Button
              data-trajectory-full-content-trigger=""
              data-trajectory-tool-pair-full-content-trigger=""
              type="button"
              variant="outline"
              size="xs"
              className="h-5 gap-1 rounded-full px-2 text-ui-xs text-foreground-subtle"
              aria-label={fullContentLabel}
              title={fullContentLabel}
              onClick={() =>
                openFullContent({
                  title: badge.name || fullContentTitle,
                  text: copyText,
                })
              }
            >
              <ExpandIcon className="size-3" />
              {fullContentLabel}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 状态点：aria-label 用 i18n（ok/error/pending/missing 四态）。 */
function ToolStatusDot({ status, intl }: { status: TrajectoryToolCallStatus; intl: IntlShape }) {
  const label = intl.formatMessage({ id: `modelTrajectory.toolStatus.${status}` });
  const colorClass =
    status === "ok"
      ? "bg-success"
      : status === "error"
        ? "bg-destructive"
        : status === "pending"
          ? "bg-warning"
          : "bg-foreground-subtlest";
  return (
    <span
      data-trajectory-tool-status=""
      data-trajectory-tool-status-value={status}
      role="img"
      aria-label={label}
      title={label}
      className={cn("size-2 shrink-0 rounded-full", colorClass)}
    />
  );
}

/**
 * 配对卡的一格（use / result）。
 *
 * - 内容用 `<pre>` 等宽渲染（与既有工具载荷展示同款）；
 * - 每格各自 6 行 clamp（max-h-[6lh]），搜索命中时跳过 clamp，否则高亮落在被裁区域；
 * - 溢出后出现「展开/收起」胶囊（路径 A 同范式），否则长内容在 Step 5 之前不可达。
 */
function TrajectoryPairCell({
  label,
  text,
  rawText,
  placeholder,
  error = false,
  revealed,
  intl,
}: {
  label: string;
  /** 载荷文本（与索引同源，逐字一致）。 */
  text: string;
  /** unknown 条目的 raw 原文（回退渲染，不进索引）。 */
  rawText?: string;
  /** 无结果时的灰化占位文案（不参与索引）。 */
  placeholder?: string;
  error?: boolean;
  revealed: boolean;
  intl: IntlShape;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [overflowEver, setOverflowEver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const expanded = showAll || revealed;

  const measureOverflow = useCallback(() => {
    const element = contentRef.current;
    if (!element || showAll) return;
    const overflowing = isClampOverflow({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
    setIsOverflowing(overflowing);
    if (overflowing) setOverflowEver(true);
  }, [showAll]);

  useLayoutEffect(() => {
    measureOverflow();
  }, [measureOverflow]);

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

  const capsuleVisible = overflowEver && (isOverflowing || showAll);

  return (
    <div
      data-trajectory-tool-pair-cell=""
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-card/40 px-2 py-1.5"
    >
      <span className="text-ui-xs font-medium text-foreground-subtlest">{label}</span>
      <div
        ref={contentRef}
        data-trajectory-tool-pair-cell-content=""
        className={cn(
          // text-ui-sm/leading-relaxed 让 max-h-[6lh] 的「6 行」与正文行高对齐。
          "min-w-0 overflow-hidden text-ui-sm leading-relaxed",
          !expanded && "max-h-[6lh]",
        )}
      >
        {placeholder ? (
          <span
            data-trajectory-tool-pair-placeholder=""
            className="text-ui-sm text-foreground-subtlest"
          >
            {placeholder}
          </span>
        ) : rawText !== undefined ? (
          <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground">
            {rawText}
          </pre>
        ) : (
          <pre
            data-trajectory-search-field="content"
            className={cn(
              "min-w-0 whitespace-pre-wrap break-words font-mono text-ui-sm",
              error ? "text-destructive" : "text-foreground",
            )}
          >
            {text}
          </pre>
        )}
      </div>
      {capsuleVisible ? (
        <div className="flex min-w-0 justify-end">
          <Button
            data-trajectory-tool-pair-overflow-toggle=""
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 gap-1 px-1 text-ui-xs text-foreground-subtle"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
            {intl.formatMessage({
              id: showAll ? "modelTrajectory.collapseContent" : "modelTrajectory.showAll",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** 无结果时的占位文案：missing = 未返回结果，pending = 等待结果（尾部在途是常态）。 */
function resultPlaceholder(status: TrajectoryToolCallStatus, intl: IntlShape): string | undefined {
  if (status === "missing") return intl.formatMessage({ id: "modelTrajectory.toolResultMissing" });
  if (status === "pending") return intl.formatMessage({ id: "modelTrajectory.toolResultPending" });
  return undefined;
}

/** 收起态的单行预览：优先结果文本，其次调用输入。 */
function previewText(useText: string, resultText: string): string {
  const source = resultText || useText;
  const compact = source.replaceAll(/\s+/g, " ").trim();
  if (!compact) return "—";
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
}

/** unknown 条目的 raw 原文（回退渲染）；非 unknown 返回 undefined。 */
function rawPartText(part: ZCodeModelTrajectoryContentPart): string | undefined {
  if (part.kind !== "unknown") return undefined;
  return formatRawPart(part.raw);
}

/** unknown 条目的 raw 原文（回退渲染）。 */
function formatRawPart(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}
