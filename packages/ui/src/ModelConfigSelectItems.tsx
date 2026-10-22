// 从 ModelConfigSelect 拆出的模型项展示件（max-lines 400 纪律）：单项、RadioGroup 包装
// 与 provider 连接方式头。旧菜单与 Composer 合并菜单共用，渲染输出与拆分前逐字节等价。
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { AlertCircle, CheckIcon } from "lucide-react";
import { TID_CHAT_MODEL_SELECT_ITEM, TID_CHAT_MODEL_SELECT_GROUP, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";
import type {
  ModelSelectConnectionOption,
  ModelSelectGroup,
  ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import { MODEL_CONFIG_SELECT_BADGE_CLASS_NAME } from "@/ModelConfigSelect.js";

/** 选中模型项；合并模式下由调用方决定 preventDefault 与菜单关闭行为。 */
export type ModelConfigSelectItemHandler = (value: string, event: Event) => void;

export function ModelConfigSelectItem({
  item,
  normalizedValue,
  isItemLocked,
  lockReasonMessage,
  onSelect,
}: {
  item: ModelSelectGroupItem;
  normalizedValue: string;
  isItemLocked: (candidateValue: string) => boolean;
  lockReasonMessage: string;
  onSelect: ModelConfigSelectItemHandler;
}) {
  const itemLocked = isItemLocked(item.value);
  const itemSelected = item.value === normalizedValue;
  // React 的 key 不能跟随 props spread 传入，否则开发环境会在 CDP console 报警。
  const itemKey = item.key;
  const commonProps = {
    "data-model-option-locked": itemLocked ? "true" : undefined,
    "data-model-option-selected": itemSelected ? "true" : undefined,
    "data-testid": testId(TID_CHAT_MODEL_SELECT_ITEM, item.value),
    "data-checked": itemSelected ? "true" : undefined,
  } as const;
  const content = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span className="min-w-0 truncate" title={item.name}>
          {item.name}
        </span>
        {item.badgeLabel ? (
          <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{item.badgeLabel}</span>
        ) : null}
        {item.supportsVisionInput ? <ModelInputCapabilityBadge /> : null}
      </span>
      {itemLocked ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex size-4 items-center justify-center rounded-full text-foreground-subtlest hover:text-foreground-subtle"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <AlertCircle className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="center" sideOffset={6}>
              {lockReasonMessage}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {itemLocked && itemSelected ? <CheckIcon className="size-4 text-foreground-subtle" /> : null}
    </>
  );

  if (itemLocked) {
    return (
      <DropdownMenuItem
        key={itemKey}
        {...commonProps}
        className="min-h-8 cursor-not-allowed gap-2 px-2 text-ui-base text-foreground-subtlest data-[highlighted]:text-foreground-subtlest"
        onSelect={(event) => event.preventDefault()}
      >
        {content}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuRadioItem
      key={itemKey}
      {...commonProps}
      value={item.value}
      className="min-h-8 gap-2 pl-2 pr-8 text-ui-base"
      onSelect={(event) => {
        onSelect(item.value, event);
      }}
    >
      {content}
    </DropdownMenuRadioItem>
  );
}

export function ModelConfigSelectItems({
  items,
  normalizedValue,
  isItemLocked,
  lockReasonMessage,
  onSelect,
}: {
  items: readonly ModelSelectGroupItem[];
  normalizedValue: string;
  isItemLocked: (candidateValue: string) => boolean;
  lockReasonMessage: string;
  onSelect: ModelConfigSelectItemHandler;
}) {
  return (
    <DropdownMenuRadioGroup value={normalizedValue}>
      {items.map((item) => (
        <ModelConfigSelectItem
          key={item.key}
          item={item}
          normalizedValue={normalizedValue}
          isItemLocked={isItemLocked}
          lockReasonMessage={lockReasonMessage}
          onSelect={onSelect}
        />
      ))}
    </DropdownMenuRadioGroup>
  );
}

export function ModelConfigSelectConnectionHeader({
  group,
  onConnectionValueChange,
}: {
  group: ModelSelectGroup;
  onConnectionValueChange?: (option: ModelSelectConnectionOption) => void;
}) {
  const options = group.connectionOptions ?? [];
  if (options.length > 0) {
    const selectedOptionKey = group.selectedOptionKey ?? options[0]?.key;
    const selectedConnection =
      options.find((option) => option.key === selectedOptionKey) ?? options[0];
    return (
      <div className="flex min-h-8 items-center gap-2 px-2 py-1">
        <span
          className="min-w-0 flex-1 truncate text-left text-ui-sm font-medium text-foreground-subtlest"
          title={group.label}
        >
          {group.label}
        </span>
        <Select
          value={selectedOptionKey}
          onValueChange={(nextKey) => {
            const option = options.find((candidate) => candidate.key === nextKey);
            if (!option) {
              return;
            }
            // 切换连接方式后需要保留外层模型菜单，方便用户继续选择刷新后的模型。
            onConnectionValueChange?.(option);
          }}
        >
          <SelectTrigger
            size="xs"
            variant="outline"
            className="min-w-0 shrink-0 gap-0.5 rounded-full pr-1.5 text-ui-sm text-foreground-subtle [&_svg]:size-3"
            data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
            data-model-provider-key={group.key}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span className="max-w-28 truncate">
              {selectedConnection?.badgeLabel ?? selectedConnection?.label ?? group.label}
            </span>
          </SelectTrigger>
          <SelectContent
            align="end"
            position="popper"
            className="w-max min-w-40 max-w-72"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {options.map((option) => (
              <SelectItem
                key={option.key}
                value={option.key}
                data-model-connection-option={option.key}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return null;
}

export function isFamilyConnectionGroup(
  group: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">,
): boolean {
  return (
    group.key.startsWith("family:") ||
    Boolean(group.labelBadge?.trim()) ||
    (group.connectionOptions?.length ?? 0) > 0
  );
}

export function shouldRenderModelGroupSeparator(
  previousGroup: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge"> | undefined,
  currentGroup: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">,
): boolean {
  if (!previousGroup) {
    return false;
  }
  return isFamilyConnectionGroup(previousGroup) || isFamilyConnectionGroup(currentGroup);
}

export function isModelSelectGroupSelected(
  group: Pick<ModelSelectGroup, "items">,
  normalizedValue: string,
): boolean {
  return group.items.some((item) => item.value === normalizedValue);
}

export function shouldShowModelProviderLevel(modelGroups: readonly ModelSelectGroup[]): boolean {
  return modelGroups.length > 0;
}

export function renderGroupLabel(group: ModelSelectGroup, options: { mutedLabel?: boolean } = {}) {
  return (
    <span className="min-w-0 flex-1 items-center gap-1.5 text-left inline-flex">
      <span
        className={cn(
          "min-w-0 whitespace-normal break-words text-ui-base",
          options.mutedLabel && "text-foreground-subtle",
        )}
        title={group.label}
      >
        {group.label}
      </span>
      {group.labelBadge ? (
        <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{group.labelBadge}</span>
      ) : null}
    </span>
  );
}
