// 从 ModelConfigSelect 拆出的触发器（max-lines 400 纪律）：
// 旧版按钮 + Composer 合并入口的三态内容（打开态选择提示 / 关闭态模型+档位）与锁宽。
// composerOptions 缺席时渲染输出与拆分前逐字节等价（无 transition 包裹层、无 combined 标记）。
import type { CSSProperties, ReactNode, RefObject } from "react";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { ChevronDownIcon, LoaderIcon, PackageIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import {
  ComposerThoughtIndicator,
  isGlmHighspeedModel,
  type ComposerModelOptions,
} from "@/chat-input-toolbar/ComposerModelMenu.js";
import { ComposerTriggerTransition } from "@/chat-input-toolbar/ComposerTriggerTransition.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

function getModelTriggerLabelClassName({
  labelVisibilityClassName,
  triggerLabelClassName,
}: {
  labelVisibilityClassName: string | undefined;
  triggerLabelClassName?: string;
}): string {
  if (triggerLabelClassName?.trim()) {
    return triggerLabelClassName;
  }

  return cn("min-w-0 text-left", labelVisibilityClassName);
}

export function ModelConfigSelectTrigger({
  composerOptions,
  modelGroups,
  normalizedValue,
  disabled,
  triggerTestId,
  triggerAriaLabel,
  guideTooltipOpen,
  onGuideTooltipDismiss,
  currentTriggerLabel,
  currentTriggerTitle,
  pending,
  triggerLabelPrefix,
  triggerLabelPrefixClassName,
  triggerLabelValue,
  triggerIcon,
  triggerIconClassName = "hidden",
  indicatorClassName,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  customTriggerLabelClassName,
  triggerBadge,
  showSelectionLabel,
  expandedWidth,
  buttonRef,
  selectedThoughtLabel,
  triggerClassName,
}: {
  composerOptions?: ComposerModelOptions;
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  disabled?: boolean;
  triggerTestId: string;
  triggerAriaLabel: string;
  guideTooltipOpen?: boolean;
  onGuideTooltipDismiss?: () => void;
  currentTriggerLabel: string;
  currentTriggerTitle: string;
  pending?: boolean;
  triggerLabelPrefix?: string;
  triggerLabelPrefixClassName?: string;
  triggerLabelValue?: string;
  triggerIcon?: ReactNode;
  triggerIconClassName?: string;
  indicatorClassName?: string;
  labelVisibilityClassName?: string;
  customTriggerLabelClassName?: string;
  triggerBadge?: ReactNode;
  /** 打开态（合并入口显示「选择模型」+档位指示）。 */
  showSelectionLabel: boolean;
  expandedWidth: number | null;
  /** 打开前测量真实按钮宽度用；与 Tooltip triggerRef 是不同节点。 */
  buttonRef: RefObject<HTMLButtonElement | null>;
  selectedThoughtLabel?: string;
  triggerClassName?: string;
}) {
  const highspeed = isGlmHighspeedModel(
    modelGroups.flatMap((group) => group.items).find((item) => item.value === normalizedValue)
      ?.name ?? "",
  );
  const triggerLabelClassName = getModelTriggerLabelClassName({
    labelVisibilityClassName,
    triggerLabelClassName: customTriggerLabelClassName,
  });
  const triggerContents = showSelectionLabel ? (
    <>
      <span
        data-composer-open-label
        className="absolute inset-x-1.5 truncate text-center text-foreground-subtle group-data-[composer-model-icon=true]/toolbar:hidden"
      >
        {composerOptions!.selectModelLabel}
      </span>
      <span
        data-composer-open-icon
        aria-hidden="true"
        className="hidden size-4 shrink-0 items-center text-foreground-subtle group-data-[composer-model-icon=true]/toolbar:inline-flex"
      >
        {triggerIcon ?? <PackageIcon className="size-4" />}
      </span>
      <span
        data-composer-open-thought
        className="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
      >
        <ComposerThoughtIndicator options={composerOptions!} highspeed={highspeed} />
      </span>
    </>
  ) : (
    <>
      {triggerIcon ?? (
        <PackageIcon
          className={cn("pointer-events-none size-4 shrink-0 text-current", triggerIconClassName)}
          aria-hidden="true"
        />
      )}
      <span className={triggerLabelClassName} title={currentTriggerTitle}>
        <RollingToolbarLabel
          label={currentTriggerLabel}
          prefix={pending ? undefined : triggerLabelPrefix}
          prefixClassName={triggerLabelPrefixClassName}
          value={pending ? undefined : triggerLabelValue}
        />
      </span>
      {composerOptions && hasSelectedModel(normalizedValue) ? (
        <ComposerThoughtIndicator options={composerOptions} highspeed={highspeed} />
      ) : null}
      {triggerBadge}
      {pending ? (
        <LoaderIcon className="pointer-events-none size-3.5 animate-spin text-foreground" />
      ) : null}
      {!pending && (
        <ChevronDownIcon
          className={cn(
            "pointer-events-none size-3.5 text-foreground-subtle",
            indicatorClassName,
            composerOptions && "group-data-[composer-compact=true]/combined:hidden",
          )}
        />
      )}
    </>
  );

  return (
    <DropdownMenuTrigger asChild>
      <Button
        ref={buttonRef}
        style={
          showSelectionLabel
            ? ({
                // 锁宽只稳定打开态文案；图标态必须释放宽度，否则 resize 后仍挤占其他入口。
                "--composer-model-open-width": `max(${expandedWidth ?? 0}px, 8rem)`,
              } as CSSProperties)
            : undefined
        }
        type="button"
        variant="ghost"
        size="default"
        disabled={disabled}
        data-chat-toolbar-popover-trigger="true"
        data-testid={triggerTestId}
        data-model-current-value={normalizedValue}
        aria-label={
          selectedThoughtLabel ? `${triggerAriaLabel} ${selectedThoughtLabel}` : triggerAriaLabel
        }
        data-composer-combined-model={composerOptions ? "true" : undefined}
        data-composer-collapse-priority={composerOptions ? "3" : undefined}
        onClick={guideTooltipOpen ? onGuideTooltipDismiss : undefined}
        className={cn(
          "w-fit justify-between gap-1 rounded-lg pl-2 pr-1.5 text-ui-base whitespace-nowrap",
          triggerClassName,
          composerOptions && "group/combined relative",
          showSelectionLabel &&
            "px-2 w-(--composer-model-open-width) min-w-32 max-w-(--composer-model-open-width) group-data-[composer-model-icon=true]/toolbar:w-auto group-data-[composer-model-icon=true]/toolbar:min-w-0 group-data-[composer-model-icon=true]/toolbar:max-w-none",
          composerOptions &&
            !hasSelectedModel(normalizedValue) &&
            "text-foreground-subtle hover:text-foreground-subtle aria-expanded:text-foreground-subtle",
        )}
      >
        {composerOptions ? (
          <ComposerTriggerTransition open={showSelectionLabel}>
            {triggerContents}
          </ComposerTriggerTransition>
        ) : (
          triggerContents
        )}
      </Button>
    </DropdownMenuTrigger>
  );
}

function hasSelectedModel(normalizedValue: string): boolean {
  return Boolean(normalizedValue.trim());
}
