// 从 ModelConfigSelect 拆出的 Composer 合并菜单挂载（max-lines 400 纪律）：
// ComposerModelMenu 装配 + 「管理模型」providerFooter。选模型不关菜单、调档与
// 浏览回退语义见 ComposerModelMenu。
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import {
  ComposerModelMenu,
  type ComposerModelOptions,
} from "@/chat-input-toolbar/ComposerModelMenu.js";
import type {
  ModelSelectConnectionOption,
  ModelSelectGroup,
  ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import {
  ModelConfigSelectConnectionHeader,
  ModelConfigSelectItems,
} from "@/ModelConfigSelectItems.js";

export function ModelConfigSelectComposerMenu({
  modelGroups,
  normalizedValue,
  composerOptions,
  isItemLocked,
  lockReasonMessage,
  onSelectModel,
  onModelValueChange,
  onConnectionValueChange,
  showManageModelsAction,
  manageModelsLabel,
  onManageModels,
  close,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  composerOptions: ComposerModelOptions;
  isItemLocked: (candidateValue: string) => boolean;
  lockReasonMessage: string;
  /** 选中模型项（含 composerOptions 的 preventDefault 不关菜单语义）。 */
  onSelectModel: (value: string, event: Event) => void;
  /** provider 浏览回退的纯值回传（不经过菜单关闭链路）。 */
  onModelValueChange: (value: string) => void;
  onConnectionValueChange?: (option: ModelSelectConnectionOption) => void;
  showManageModelsAction: boolean;
  manageModelsLabel?: string;
  onManageModels?: () => void;
  close: () => void;
}) {
  return (
    <ComposerModelMenu
      groups={modelGroups}
      normalizedValue={normalizedValue}
      options={composerOptions}
      isItemLocked={isItemLocked}
      onSelectModel={onModelValueChange}
      renderItems={(items: ModelSelectGroupItem[]) => (
        <ModelConfigSelectItems
          items={items}
          normalizedValue={normalizedValue}
          isItemLocked={isItemLocked}
          lockReasonMessage={lockReasonMessage}
          onSelect={onSelectModel}
        />
      )}
      renderConnection={(group: ModelSelectGroup) => (
        <ModelConfigSelectConnectionHeader
          group={group}
          onConnectionValueChange={onConnectionValueChange}
        />
      )}
      providerFooter={
        showManageModelsAction && manageModelsLabel ? (
          <DropdownMenuItem
            className="min-h-8 gap-2 px-2"
            data-model-footer-action="manage-models"
            onSelect={() => {
              close();
              onManageModels?.();
            }}
          >
            {manageModelsLabel}
          </DropdownMenuItem>
        ) : null
      }
    />
  );
}
