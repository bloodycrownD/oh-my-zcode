// 从 ModelConfigSelect 拆出的旧版菜单内容（max-lines 400 纪律）：
// provider 分组/子菜单映射、扁平模型列表与吸底 footer。composerOptions 缺席路径的
// 渲染输出与拆分前逐字节等价（leadingItems 区由主文件渲染，两侧共用）。
import { Fragment } from "react";
import {
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
} from "@/components/ui/dropdown-menu.js";
import { CheckIcon } from "lucide-react";
import { TID_CHAT_MODEL_SELECT_GROUP, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import type {
  ModelSelectConnectionOption,
  ModelSelectFooterAction,
  ModelSelectGroup,
  ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import {
  ModelConfigSelectConnectionHeader,
  ModelConfigSelectItem,
  ModelConfigSelectItems,
  isModelSelectGroupSelected,
  renderGroupLabel,
  shouldRenderModelGroupSeparator,
} from "@/ModelConfigSelectItems.js";

export function ModelConfigSelectLegacyMenu({
  modelGroups,
  normalizedValue,
  showProviderLevel,
  flatItems,
  renderedFooterActions,
  providerSubmenuClassName,
  isItemLocked,
  lockReasonMessage,
  onSelectModel,
  onConnectionValueChange,
  close,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  showProviderLevel: boolean;
  /** 无 provider 层（扁平列表）时第一组的模型项。 */
  flatItems?: readonly ModelSelectGroupItem[];
  renderedFooterActions: readonly ModelSelectFooterAction[];
  providerSubmenuClassName?: string;
  isItemLocked: (candidateValue: string) => boolean;
  lockReasonMessage: string;
  onSelectModel: (value: string, event: Event) => void;
  onConnectionValueChange?: (option: ModelSelectConnectionOption) => void;
  close: () => void;
}) {
  const hasSelectableModel = modelGroups.length > 0;
  const itemProps = {
    normalizedValue,
    isItemLocked,
    lockReasonMessage,
    onSelect: onSelectModel,
  };
  return (
    <>
      {hasSelectableModel && showProviderLevel ? (
        modelGroups.map((group, index) => {
          const groupSeparator = shouldRenderModelGroupSeparator(modelGroups[index - 1], group) ? (
            <DropdownMenuSeparator />
          ) : null;
          if (group.directItems) {
            return (
              <Fragment key={group.key}>
                {groupSeparator}
                <div>
                  <DropdownMenuLabel
                    className="flex min-h-8 items-center px-2 py-1"
                    data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                    data-model-provider-key={group.key}
                  >
                    {renderGroupLabel(group)}
                  </DropdownMenuLabel>
                  <ModelConfigSelectConnectionHeader
                    group={group}
                    onConnectionValueChange={onConnectionValueChange}
                  />
                  <DropdownMenuRadioGroup value={normalizedValue}>
                    {group.items.map((item) => (
                      <ModelConfigSelectItem key={item.key} item={item} {...itemProps} />
                    ))}
                  </DropdownMenuRadioGroup>
                </div>
              </Fragment>
            );
          }

          const groupSelected = isModelSelectGroupSelected(group, normalizedValue);
          return (
            <Fragment key={group.key}>
              {groupSeparator}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  className="min-h-8"
                  data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                  data-model-provider-key={group.key}
                  data-model-provider-selected={groupSelected ? "true" : undefined}
                >
                  {renderGroupLabel(group)}
                  {groupSelected ? <CheckIcon className="size-4 text-foreground-subtle" /> : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className={cn(
                    "max-h-72 overflow-y-auto",
                    // 固定宽度会提前截断模型名；按内容扩展，并让可用空间优先于最小宽度。
                    providerSubmenuClassName ??
                      "w-max min-w-[min(12rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width)",
                  )}
                >
                  <ModelConfigSelectItems items={group.items} {...itemProps} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </Fragment>
          );
        })
      ) : hasSelectableModel ? (
        flatItems ? (
          <ModelConfigSelectItems items={flatItems} {...itemProps} />
        ) : null
      ) : null}
      {renderedFooterActions.length > 0 ? (
        <div className="sticky bottom-0 z-10 bg-menu after:absolute after:left-0 after:top-full after:h-1 after:w-full after:bg-menu after:content-['']">
          {hasSelectableModel ? <DropdownMenuSeparator /> : null}
          {renderedFooterActions.map((action) => (
            <DropdownMenuItem
              key={action.key}
              className="min-h-8 gap-2 px-2"
              data-model-footer-action={action.key}
              data-model-footer-action-selected={action.selected ? "true" : undefined}
              onSelect={() => {
                close();
                action.onSelect?.();
              }}
            >
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.selected ? <CheckIcon className="size-4 text-foreground-subtle" /> : null}
            </DropdownMenuItem>
          ))}
        </div>
      ) : null}
    </>
  );
}
