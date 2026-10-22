// 模型选择器主组件（max-lines 400 纪律：触发器/旧菜单/合并菜单已拆到独立文件）。
// composerOptions 缺席时行为与拆分前逐字节等价；传入时启用 Composer 合并入口
// （模型+供应商+思考强度单菜单，见 ComposerModelMenu）。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { ProviderConfigObject } from "@zcode/provider";
import { cn } from "@/components/lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { TID_CHAT_MODEL_SELECT_TRIGGER } from "@zcode/shared";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { ModelConfigSelectTrigger } from "@/ModelConfigSelectTrigger.js";
import { ModelConfigSelectLegacyMenu } from "@/ModelConfigSelectLegacyMenu.js";
import { ModelConfigSelectComposerMenu } from "@/ModelConfigSelectComposerMenu.js";
import { ModelConfigSelectItems, shouldShowModelProviderLevel } from "@/ModelConfigSelectItems.js";
import type { ModelConfigSelectProps } from "@/ModelConfigSelectProps.js";

export interface ModelSelectGroupItem {
  key: string;
  value: string;
  name: string;
  badgeLabel?: string;
  supportsVisionInput?: boolean;
}

export interface ModelSelectConnectionOption {
  key: string;
  label: string;
  badgeLabel?: string;
  value: string;
  providerId: string;
  familyId: string;
  mode: "oauth" | "apiKey";
  disabled?: boolean;
}

export interface ModelSelectGroup {
  key: string;
  label: string;
  labelBadge?: string;
  /** provider 品牌图标；仅 Composer 合并菜单的 Provider 行展示。 */
  logo?: ProviderConfigObject["logo"];
  directItems?: boolean;
  selectedOptionKey?: string;
  connectionOptions?: ModelSelectConnectionOption[];
  items: ModelSelectGroupItem[];
}

export interface ModelSelectFooterAction {
  key: string;
  label: string;
  selected?: boolean;
  onSelect?: () => void;
}

const EMPTY_MODEL_SELECT_FOOTER_ACTIONS: readonly ModelSelectFooterAction[] = [];
export const MODEL_CONFIG_SELECT_BADGE_CLASS_NAME =
  "shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle";

export const ModelConfigSelect = memo(function ModelConfigSelectComponent({
  composerOptions,
  modelGroups,
  normalizedValue,
  triggerLabel,
  triggerLabelPrefix,
  triggerLabelValue,
  triggerLabelPrefixClassName,
  showManageModelsAction,
  lockReasonMessage,
  isItemLocked,
  onValueChange,
  onConnectionValueChange,
  disabled,
  tooltipTitle,
  guideTooltipTitle,
  guideTooltipOpen = false,
  onGuideTooltipDismiss,
  shortcutLabel,
  triggerRef,
  open: controlledOpen,
  onOpenChange,
  openRequestKey = 0,
  pendingLabel,
  pending,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  indicatorClassName,
  triggerClassName,
  triggerIconClassName = "hidden",
  triggerIcon,
  triggerLabelClassName: customTriggerLabelClassName,
  triggerTestId = TID_CHAT_MODEL_SELECT_TRIGGER,
  formatTriggerLabel,
  showProviderLevel,
  providerSubmenuClassName,
  footerActions = EMPTY_MODEL_SELECT_FOOTER_ACTIONS,
  manageModelsLabel,
  onManageModels,
  focusSelectorOnClose = '[data-testid="chat-input"]',
  contentSide = "top",
  contentAlign = "start",
  leadingItems,
  triggerBadge,
}: ModelConfigSelectProps) {
  const presentation = useRef({ composerOptions, modelGroups, normalizedValue, triggerLabel });
  if (
    composerOptions?.providerMenu?.pending &&
    presentation.current.composerOptions?.providerMenu
  ) {
    // 原因：账号刷新和草稿解析分别到达，混用新选项与旧选中值会让菜单收缩并显示“—”。
    // loading 期间只冻结展示；回调和 pending/error 仍来自当前 owner，不影响提交事实。
    const previous = presentation.current;
    composerOptions = {
      ...previous.composerOptions!,
      onValueChange: composerOptions.onValueChange,
      providerMenu: {
        ...composerOptions.providerMenu,
        groups: previous.composerOptions!.providerMenu!.groups,
        selectedKey: previous.composerOptions!.providerMenu!.selectedKey,
      },
    };
    modelGroups = previous.modelGroups;
    normalizedValue = previous.normalizedValue;
    triggerLabel = previous.triggerLabel;
  } else presentation.current = { composerOptions, modelGroups, normalizedValue, triggerLabel };
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expandedWidth, setExpandedWidth] = useState<number | null>(null);
  const hasSelectedModel = Boolean(normalizedValue.trim());
  const showSelectionLabel = Boolean(composerOptions && open && hasSelectedModel);
  // 未选模型不代表缺失思考档位；空态不应显示横线、绿条或 Tooltip 的伪档位。
  const selectedThoughtLabel = hasSelectedModel
    ? composerOptions?.levels.find((level) => level.value === composerOptions.value)?.label
    : undefined;
  const lastOpenRequestKeyRef = useRef(openRequestKey);
  const hasSelectableModel = modelGroups.length > 0;
  // 闲时任务白名单只有一层模型值；只要存在 group 就强制展示 provider 层的话，
  // 下方已有的扁平模型分支永远不可达，也无法复用 New Task 模型选择器。
  const shouldUseProviderLevel = showProviderLevel ?? shouldShowModelProviderLevel(modelGroups);
  // 模型名和上游占位值可能大小写敏感，强制大写会把 `<synthetic>` 改成 `<SYNTHETIC>` 这类非原始值。
  const triggerDisplayLabel = triggerLabel;
  const renderedTriggerDisplayLabel =
    formatTriggerLabel?.(triggerDisplayLabel) ?? triggerDisplayLabel;
  const renderedPendingLabel =
    pendingLabel && formatTriggerLabel ? formatTriggerLabel(pendingLabel) : pendingLabel;
  const currentTriggerLabel =
    pending && renderedPendingLabel ? renderedPendingLabel : renderedTriggerDisplayLabel;
  const currentTriggerTitle = pending && pendingLabel ? pendingLabel : triggerDisplayLabel;

  const handlePopoverOpenChange = useCallback(
    (nextOpen: boolean) => {
      // 打开前测量真实按钮，不能在替换文案后反过来测量占位内容。
      if (nextOpen && composerOptions && buttonRef.current)
        setExpandedWidth(buttonRef.current.getBoundingClientRect().width);
      else if (!nextOpen) setExpandedWidth(null);
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange, composerOptions],
  );

  useEffect(() => {
    if (openRequestKey <= 0 || openRequestKey === lastOpenRequestKeyRef.current) {
      return;
    }
    lastOpenRequestKeyRef.current = openRequestKey;

    if (disabled) {
      return;
    }

    // 模型菜单是受控 DropdownMenu，快捷键不能依赖模拟 click 触发。
    // Tooltip/Dropdown 多层 asChild 合并 ref 时，click 可能找不到真实 trigger；这里直接打开菜单状态。
    handlePopoverOpenChange(true);
    triggerRef?.current?.focus();
  }, [disabled, handlePopoverOpenChange, openRequestKey, triggerRef]);

  const handleModelValueChange = useCallback(
    (nextValue: string) => {
      onValueChange(nextValue);
    },
    [onValueChange],
  );

  const handleModelSelect = useCallback(
    (value: string, event: Event) => {
      handleModelValueChange(value);
      // 合并菜单选模型后还可继续调档，阻止菜单项默认关闭；外侧点击仍走原关闭链路。
      if (composerOptions) event.preventDefault();
      else handlePopoverOpenChange(false);
    },
    [composerOptions, handleModelValueChange, handlePopoverOpenChange],
  );

  const triggerAriaLabel = useMemo(() => {
    return pending && pendingLabel ? pendingLabel : (tooltipTitle ?? currentTriggerTitle);
  }, [currentTriggerTitle, pending, pendingLabel, tooltipTitle]);

  const renderedFooterActions = useMemo<ModelSelectFooterAction[]>(() => {
    const actions = [...footerActions];
    if (!composerOptions && showManageModelsAction && manageModelsLabel) {
      actions.push({
        key: "manage-models",
        label: manageModelsLabel,
        onSelect: onManageModels,
      });
    }
    return actions;
  }, [composerOptions, footerActions, manageModelsLabel, onManageModels, showManageModelsAction]);

  const closeMenu = useCallback(() => {
    handlePopoverOpenChange(false);
  }, [handlePopoverOpenChange]);

  const modelTrigger = (
    <ModelConfigSelectTrigger
      composerOptions={composerOptions}
      modelGroups={modelGroups}
      normalizedValue={normalizedValue}
      disabled={disabled}
      triggerTestId={triggerTestId}
      triggerAriaLabel={triggerAriaLabel}
      guideTooltipOpen={guideTooltipOpen}
      onGuideTooltipDismiss={onGuideTooltipDismiss}
      currentTriggerLabel={currentTriggerLabel}
      currentTriggerTitle={currentTriggerTitle}
      pending={pending}
      triggerLabelPrefix={triggerLabelPrefix}
      triggerLabelPrefixClassName={triggerLabelPrefixClassName}
      triggerLabelValue={triggerLabelValue}
      triggerIcon={triggerIcon}
      triggerIconClassName={triggerIconClassName}
      indicatorClassName={indicatorClassName}
      labelVisibilityClassName={labelVisibilityClassName}
      customTriggerLabelClassName={customTriggerLabelClassName}
      triggerBadge={triggerBadge}
      showSelectionLabel={showSelectionLabel}
      expandedWidth={expandedWidth}
      buttonRef={buttonRef}
      selectedThoughtLabel={selectedThoughtLabel}
      triggerClassName={triggerClassName}
    />
  );

  return (
    <DropdownMenu open={open} onOpenChange={handlePopoverOpenChange}>
      {tooltipTitle ? (
        <ControlHintTooltip
          // 合并入口的 Tooltip 应提示操作，不重复按钮已有的模型和档位。
          title={
            guideTooltipOpen && guideTooltipTitle
              ? guideTooltipTitle
              : (composerOptions?.selectModelLabel ?? tooltipTitle)
          }
          shortcut={guideTooltipOpen ? undefined : shortcutLabel}
          triggerRef={triggerRef}
          // 菜单打开时 Tooltip 不能再成为最上层；否则 Escape 只关闭提示，菜单仍锁住指针。
          open={open ? (composerOptions ? false : undefined) : guideTooltipOpen ? true : undefined}
          className={guideTooltipOpen ? "bg-background py-0.5 pr-0.5 pl-2" : undefined}
        >
          {modelTrigger}
        </ControlHintTooltip>
      ) : (
        modelTrigger
      )}
      {open && composerOptions ? (
        <DropdownMenuPortal>
          {/* 插件 webview 显式接收指针，内部事件不冒泡到宿主；透明层让外侧点击走 Radix 关闭链路。
              层级位于插件（10）之上、Composer（20）和浮窗（30）之下，保留同一工具栏的菜单切换。 */}
          <div
            aria-hidden="true"
            className="fixed inset-0 z-[19] pointer-events-auto [app-region:no-drag]"
          />
        </DropdownMenuPortal>
      ) : null}
      {open ? (
        <DropdownMenuContent
          className={cn(
            composerOptions
              ? // 外层滚动会带走供应商和 Effort；只让 Models 列表收缩，且排除窗口拖拽命中。
                "w-72 overflow-y-hidden [app-region:no-drag] [&>*:not([data-composer-model-list]):not([data-composer-provider-list])]:shrink-0"
              : shouldUseProviderLevel
                ? "w-max min-w-48 max-w-[calc(100vw-2rem)]"
                : "w-48 max-h-72 overflow-y-auto",
          )}
          collisionPadding={composerOptions ? 12 : undefined}
          align={contentAlign}
          side={contentSide}
          onCloseAutoFocus={(event) => {
            if (!focusSelectorOnClose) {
              // Automations 没有聊天输入框可恢复；保留 Radix 默认行为，
              // 让键盘焦点回到触发器，而不是 preventDefault 后掉到 body。
              return;
            }
            event.preventDefault();
            if (
              !shouldRestoreChatInputFocusAfterPickerClose({
                isCoarseTouchDevice: isCoarseTouchDevice(),
              })
            ) {
              return;
            }
            // 聊天输入框的 data-testid 挂在 contenteditable 自身上，不是父节点。
            // 这里与 mode 选择器保持同一个入口，避免关闭模型弹层后找不到输入框而丢失焦点。
            const input = document.querySelector<HTMLElement>(focusSelectorOnClose);
            input?.focus();
          }}
        >
          {leadingItems !== undefined && leadingItems.length > 0 ? (
            <>
              <ModelConfigSelectItems
                items={leadingItems}
                normalizedValue={normalizedValue}
                isItemLocked={isItemLocked}
                lockReasonMessage={lockReasonMessage}
                onSelect={handleModelSelect}
              />
              {hasSelectableModel ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {composerOptions ? (
            <ModelConfigSelectComposerMenu
              modelGroups={modelGroups}
              normalizedValue={normalizedValue}
              composerOptions={composerOptions}
              isItemLocked={isItemLocked}
              lockReasonMessage={lockReasonMessage}
              onSelectModel={handleModelSelect}
              onModelValueChange={handleModelValueChange}
              onConnectionValueChange={onConnectionValueChange}
              showManageModelsAction={showManageModelsAction}
              manageModelsLabel={manageModelsLabel}
              onManageModels={onManageModels}
              close={closeMenu}
            />
          ) : (
            <ModelConfigSelectLegacyMenu
              modelGroups={modelGroups}
              normalizedValue={normalizedValue}
              showProviderLevel={shouldUseProviderLevel}
              flatItems={modelGroups[0]?.items}
              renderedFooterActions={renderedFooterActions}
              providerSubmenuClassName={providerSubmenuClassName}
              isItemLocked={isItemLocked}
              lockReasonMessage={lockReasonMessage}
              onSelectModel={handleModelSelect}
              onConnectionValueChange={onConnectionValueChange}
              close={closeMenu}
            />
          )}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
});
