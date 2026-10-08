/* eslint-disable max-lines -- 模型元数据弹窗集中承载模型 ID（含拉取模型列表）、Token、模态与推理档位编辑；待稳定后再按字段族拆分。 */
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ChevronDownIcon, Loader2Icon, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import type { ModelConfigObject } from "@zcode/provider";
import type {
  ProviderModelDraftValues,
  ProviderModelDraftCommitResult,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { ProviderModelInputModalityOptions } from "@/settings/model-provider-section/ProviderModelModalityOptions.js";
import { BooleanModelOption } from "@/settings/model-provider-section/ProviderModelMetadataFields.js";
import {
  ModelSettingsGroup,
  ProviderModelReasoningSettings,
} from "@/settings/model-provider-section/ProviderModelSettingsGroups.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import {
  ProviderModelMetadataDialogActions,
  ModelSmartConfigSwitch,
  ModelConfigDraftFeedback,
  ModelConfigRestoreButton,
} from "@/settings/model-provider-section/ProviderModelMetadataDialogActions.js";
import { modelEditorControlStyle } from "@/settings/model-provider-section/modelEditorControlStyle.js";
import { cn } from "@/components/lib/utils.js";
import {
  ModelConfigHelp,
  ModelConfigInputLabel,
} from "@/settings/model-provider-section/ModelConfigHelp.js";

import { ModelEditorAdvanced } from "@/settings/model-provider-section/ModelEditorAdvanced.js";

function selectFocusedInputText(event: Pick<FocusEvent<HTMLInputElement>, "currentTarget">) {
  event.currentTarget.select();
}

export function ProviderModelMetadataDialog({
  mode = "edit",
  open,
  draft,
  draftErrorMessage,
  draftErrorField,
  personalConfig,
  overrideFields,
  inheritedConfig,
  onOpenChange,
  onDraftChange,
  onRestore,
  onCommit,
  modelConfigResolutionPending = false,
  modelIdReadOnly = false,
  saving = false,
  modelDefaultsLoaded = false,
  providerId,
  onModelIdBlur,
}: {
  mode?: "add" | "edit";
  open: boolean;
  draft: ProviderModelDraftValues;
  draftErrorMessage: string | null;
  draftErrorField?: Extract<ProviderModelDraftCommitResult, { status: "invalid" }>["field"] | null;
  personalConfig?: ModelConfigObject;
  overrideFields?: ReadonlySet<string>;
  inheritedConfig?: ModelConfigObject;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (patch: Partial<ProviderModelDraftValues>) => void;
  onRestore?: () => void;
  onCommit: () => boolean | Promise<boolean>;
  modelConfigResolutionPending?: boolean;
  modelIdReadOnly?: boolean;
  saving?: boolean;
  modelDefaultsLoaded?: boolean;
  /** 目标 Provider；提供后允许从 Provider 的兼容端点拉取可选模型列表。 */
  providerId?: string;
  onModelIdBlur?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
  const commit = async () => {
    const result = await onCommit();
    if (!result) setValidationAttempt((value) => value + 1);
  };
  // 每次关闭清空上一次拉取结果，避免下次打开把旧 Provider 的模型列表带进新草稿。
  useEffect(() => {
    if (!open) {
      setFetchedModels(null);
      setFetchModelsError(null);
    }
  }, [open]);
  const canFetchModels = Boolean(providerId) && !modelIdReadOnly;
  const handleFetchModels = async () => {
    if (!providerId || fetchingModels) {
      return;
    }
    setFetchingModels(true);
    setFetchModelsError(null);
    try {
      const result = await providerSettingsService.listProviderModels({ providerId });
      setFetchedModels(result.models);
    } catch (error) {
      setFetchedModels(null);
      setFetchModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setFetchingModels(false);
    }
  };
  // 拉取结果用可搜索下拉呈现：芯片形态在几十上百个模型时不可用。
  const [modelsPickerOpen, setModelsPickerOpen] = useState(false);
  const modelsListRef = useRef<HTMLDivElement>(null);
  // 输入框内容即过滤词：空=全部候选；模型 ID 子串匹配（大小写不敏感）。
  const fetchedModelQuery = draft.idValue.trim().toLowerCase();
  const visibleFetchedModels =
    fetchedModels?.filter(
      (modelId) => !fetchedModelQuery || modelId.toLowerCase().includes(fetchedModelQuery),
    ) ?? [];
  const handleModelsListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }
    // Popover 嵌在 Dialog 中时，外层滚动锁会吞掉默认滚轮行为（同
    // RemoteConnectionFields 的 SSH 别名列表），这里显式驱动列表自身滚动。
    listElement.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const contextWindowInputId = useId();
  const maxOutputInputId = useId();
  const smart = draft.useRecommendedConfigValue !== false;
  const activeOverrides = smart ? overrideFields : new Set<string>();
  const overridden = (field: string, legacy = false) =>
    smart && (activeOverrides ? activeOverrides.has(field) : legacy);
  const editModelLabel = intl.formatMessage({
    id: "settings.modelProvider.editModel",
  });
  // 新增模型时模型 ID 为空，如果沿用编辑态的上下文窗口自动聚焦，会让用户先落到默认数值字段。
  // 编辑态仍保留上下文窗口自动聚焦和选中，方便直接修改已有模型配置。
  const shouldFocusModelIdInput = mode === "add";
  const shouldFocusContextWindowInput = mode === "edit";
  const addModelConfigResolutionPending = smart && modelConfigResolutionPending;
  const compositionActiveRef = useRef(false);
  const handleTechnicalInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    // 输入法候选确认也会发出 Enter。某些 Electron/macOS 版本的
    // nativeEvent.isComposing 会过早恢复 false，因此同时保留本地 composition 状态。
    if (
      isImeComposingKeyEvent({
        compositionActive: compositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      return;
    }
    event.preventDefault();
    void commit();
  };
  const handleCompositionStart = () => {
    compositionActiveRef.current = true;
  };
  const handleCompositionEnd = () => {
    compositionActiveRef.current = false;
  };
  const maxOutputTokensInputDisabled = mode === "add" && !draft.idValue.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {mode === "edit" ? (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 p-0"
            aria-label={editModelLabel}
            title={editModelLabel}
          >
            <Pencil className="size-3.5 text-foreground-subtle" />
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        // overflow-hidden 仍允许聚焦触发外层滚动；语言换行后曾滚走标题。仅正文滚动，外框只裁切。
        className="max-h-[min(48rem,calc(100vh-4rem))] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-clip"
        data-no-model-drag="true"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">
            {intl.formatMessage({
              id:
                mode === "add"
                  ? "settings.modelProvider.addModel"
                  : "settings.modelProvider.editModel",
            })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({
              id: "settings.modelProvider.editModelDescription",
            })}
          </DialogDescription>
          <ModelSmartConfigSwitch
            disabled={saving}
            checked={smart}
            onChange={(useRecommendedConfigValue) => onDraftChange({ useRecommendedConfigValue })}
          />
        </DialogHeader>
        {/* 保存期间锁定正文交互，不改变原有滚动容器；页脚单独显示提交状态。 */}
        <div
          inert={saving}
          className="min-h-0 min-w-0 -mr-3 space-y-4 overflow-y-auto pr-4"
          data-model-settings-scroll="true"
        >
          <ModelSettingsGroup group="basic">
            <div data-model-identity-row="true" className="flex flex-col gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.modelId" })}
                  </label>
                  {canFetchModels ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      data-testid="model-provider-fetch-models"
                      disabled={saving || fetchingModels}
                      onClick={() => {
                        void handleFetchModels();
                      }}
                    >
                      {fetchingModels ? (
                        <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
                      ) : null}
                      {intl.formatMessage({
                        id: fetchingModels
                          ? "settings.modelProvider.fetchModelsLoading"
                          : "settings.modelProvider.fetchModels",
                      })}
                    </Button>
                  ) : null}
                </div>
                {/* 可输入下拉框（combobox）：拉取成功后，模型 ID 输入框本身承担候选筛选——
                    聚焦弹出候选、输入即过滤、点选即填入；也保留任意手输。 */}
                <Popover
                  open={modelsPickerOpen}
                  onOpenChange={(nextOpen) => {
                    if (!nextOpen) {
                      setModelsPickerOpen(false);
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <div className="relative">
                      <Input
                        {...TECHNICAL_INPUT_ATTRIBUTES}
                        type="text"
                        autoFocus={shouldFocusModelIdInput}
                        size="lg"
                        className={cn("font-mono", modelEditorControlStyle(false))}
                        readOnly={modelIdReadOnly}
                        value={draft.idValue}
                        placeholder={intl.formatMessage({
                          id: "settings.modelProvider.modelId",
                        })}
                        onFocus={() => {
                          if (fetchedModels?.length) {
                            setModelsPickerOpen(true);
                          }
                        }}
                        onChange={(event) => {
                          onDraftChange({ idValue: event.target.value });
                          if (fetchedModels?.length) {
                            setModelsPickerOpen(true);
                          }
                        }}
                        onBlur={onModelIdBlur}
                        onCompositionStart={handleCompositionStart}
                        onCompositionEnd={handleCompositionEnd}
                        onKeyDown={handleTechnicalInputKeyDown}
                      />
                      {canFetchModels && fetchedModels?.length ? (
                        <ChevronDownIcon
                          aria-hidden="true"
                          className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle"
                        />
                      ) : null}
                    </div>
                  </PopoverTrigger>
                  {canFetchModels && fetchedModels && fetchedModels.length > 0 && modelsPickerOpen ? (
                    <PopoverContent
                      align="start"
                      sideOffset={4}
                      data-testid="model-provider-fetch-models-picker"
                      // 弹层不得抢焦点：输入框必须保持聚焦才能连续输入过滤。
                      onOpenAutoFocus={(event) => event.preventDefault()}
                      // 内容随 modelsPickerOpen 条件渲染，关闭即卸载：不依赖退出动画的
                      // animationend（该上下文中 exit 动画可能不触发，Radix Presence 会
                      // 一直挂着幽灵面板）。
                      className="w-[var(--radix-popover-trigger-width)] gap-0 bg-menu p-0"
                    >
                      <Command
                        shouldFilter={false}
                        className="bg-transparent p-0 text-foreground"
                      >
                        <CommandList
                          ref={modelsListRef}
                          className="max-h-60 overscroll-contain"
                          onWheel={handleModelsListWheel}
                        >
                          {visibleFetchedModels.length === 0 ? (
                            <p className="px-4 py-5 text-foreground-subtle">
                              {intl.formatMessage({
                                id: "settings.modelProvider.fetchModelsNoMatch",
                              })}
                            </p>
                          ) : (
                            <CommandGroup className="p-1">
                              {visibleFetchedModels.map((modelId) => (
                                <CommandItem
                                  key={modelId}
                                  value={modelId}
                                  data-checked={
                                    modelId === draft.idValue.trim() ? "true" : undefined
                                  }
                                  className="min-h-8 cursor-pointer px-2 text-ui-base"
                                  title={modelId}
                                  // mousedown 默认行为会把焦点从输入框抢走，先拦掉再靠 select 填值。
                                  onMouseDown={(event) => event.preventDefault()}
                                  onSelect={() => {
                                    onDraftChange({ idValue: modelId });
                                    setModelsPickerOpen(false);
                                  }}
                                >
                                  <span className="truncate font-mono text-ui-sm">{modelId}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  ) : null}
                </Popover>
                {canFetchModels && fetchedModels && fetchedModels.length === 0 ? (
                  <p className="mt-2 text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.fetchModelsEmpty" })}
                  </p>
                ) : null}
                {fetchModelsError ? (
                  <p role="alert" className="mt-2 text-ui-sm text-destructive">
                    {intl.formatMessage(
                      { id: "settings.modelProvider.fetchModelsError" },
                      { reason: fetchModelsError },
                    )}
                  </p>
                ) : null}
              </div>
            </div>
          </ModelSettingsGroup>
          <ModelSettingsGroup group="tokens">
            <div className="space-y-3">
              <div>
                <div className="mb-1 block text-ui-base text-foreground-subtle">
                  <ModelConfigInputLabel field="contextWindow" htmlFor={contextWindowInputId} />
                </div>
                <Input
                  {...TECHNICAL_INPUT_ATTRIBUTES}
                  id={contextWindowInputId}
                  type="text"
                  autoFocus={shouldFocusContextWindowInput}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  size="lg"
                  value={draft.contextWindowValue}
                  data-personal-override={overridden(
                    "contextWindowValue",
                    personalConfig?.properties?.contextWindow !== undefined,
                  )}
                  className={modelEditorControlStyle(
                    overridden(
                      "contextWindowValue",
                      personalConfig?.properties?.contextWindow !== undefined,
                    ),
                  )}
                  placeholder={
                    draft.useRecommendedConfigValue === false ||
                    inheritedConfig?.properties?.contextWindow === undefined
                      ? undefined
                      : String(inheritedConfig.properties.contextWindow)
                  }
                  onChange={(event) => {
                    onDraftChange({ contextWindowValue: event.target.value });
                  }}
                  onFocus={selectFocusedInputText}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onKeyDown={handleTechnicalInputKeyDown}
                />
              </div>
            </div>
          </ModelSettingsGroup>
          <ModelSettingsGroup group="tokens">
            <div className="space-y-3">
              <div data-model-max-output="true">
                <div className="mb-1 flex items-center gap-2">
                  <div className="text-ui-base text-foreground-subtle">
                    <ModelConfigInputLabel field="maxOutputTokens" htmlFor={maxOutputInputId} />
                  </div>
                  {addModelConfigResolutionPending ? (
                    <span
                      className="inline-flex shrink-0 items-center text-foreground-subtlest"
                      role="status"
                    >
                      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                      <span className="sr-only">
                        {intl.formatMessage({ id: "common.loading" })}
                      </span>
                    </span>
                  ) : null}
                </div>
                <Input
                  {...TECHNICAL_INPUT_ATTRIBUTES}
                  id={maxOutputInputId}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  size="lg"
                  value={draft.maxOutputTokensValue}
                  data-personal-override={overridden(
                    "maxOutputTokensValue",
                    personalConfig?.optionSpecs?.maxOutputTokens?.max !== undefined,
                  )}
                  className={modelEditorControlStyle(
                    overridden(
                      "maxOutputTokensValue",
                      personalConfig?.optionSpecs?.maxOutputTokens?.max !== undefined,
                    ),
                  )}
                  placeholder={
                    draft.useRecommendedConfigValue === false ||
                    inheritedConfig?.optionSpecs?.maxOutputTokens?.max === undefined
                      ? undefined
                      : String(inheritedConfig.optionSpecs.maxOutputTokens.max)
                  }
                  disabled={maxOutputTokensInputDisabled}
                  aria-label={intl.formatMessage({
                    id: "settings.modelProvider.maxOutputTokens",
                  })}
                  aria-busy={addModelConfigResolutionPending}
                  onChange={(event) => onDraftChange({ maxOutputTokensValue: event.target.value })}
                  onFocus={selectFocusedInputText}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onKeyDown={handleTechnicalInputKeyDown}
                />
              </div>
            </div>
          </ModelSettingsGroup>
          <ModelEditorAdvanced
            open={open}
            errorField={draftErrorField}
            validationAttempt={validationAttempt}
          >
            <ModelSettingsGroup group="modalities">
              <div className="space-y-3">
                <div>
                  <div className="mb-1 block text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.inputModalities" })}
                    <ModelConfigHelp field="inputModalities" />
                  </div>
                  <ProviderModelInputModalityOptions
                    value={draft.inputFormatValue}
                    onChange={(inputFormatValue) => onDraftChange({ inputFormatValue })}
                    personalValue={personalConfig?.properties?.inputFormat}
                    overrideFields={activeOverrides}
                  />
                </div>
              </div>
            </ModelSettingsGroup>
            <ModelSettingsGroup group="capabilities">
              <div>
                <div
                  className="mb-1 block text-ui-base text-foreground-subtle"
                  data-model-capabilities-label="true"
                >
                  {intl.formatMessage({ id: "settings.modelProvider.capabilities" })}
                  <ModelConfigHelp field="capabilities" />
                </div>
                <div className="flex flex-wrap gap-2" data-model-capabilities-options="true">
                  {(
                    [
                      "supportsJsonSchemaOutput",
                      "supportsNativeWebSearch",
                      "supportsMidConversationSystem",
                    ] as const
                  ).map((property) => {
                    const field = `${property}Value` as const;
                    return (
                      <BooleanModelOption
                        key={property}
                        label={intl.formatMessage({ id: `settings.modelProvider.${property}` })}
                        selected={draft[field] ?? false}
                        onToggle={() => onDraftChange({ [field]: !(draft[field] ?? false) })}
                        overridden={overridden(
                          field,
                          personalConfig?.properties?.[property] !== undefined,
                        )}
                      />
                    );
                  })}
                </div>
              </div>
            </ModelSettingsGroup>
            <ProviderModelReasoningSettings
              draft={draft}
              personalConfig={personalConfig}
              overrideFields={activeOverrides}
              inheritedConfig={inheritedConfig}
              onDraftChange={onDraftChange}
            />
          </ModelEditorAdvanced>
        </div>
        <ModelConfigDraftFeedback error={draftErrorMessage} matched={modelDefaultsLoaded} />
        <ProviderModelMetadataDialogActions
          leadingAction={<ModelConfigRestoreButton disabled={saving} onRestore={onRestore} />}
          saveLabel={intl.formatMessage({ id: "common.save" })}
          cancelLabel={intl.formatMessage({ id: "common.cancel" })}
          saving={saving}
          onSave={() => void commit()}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
