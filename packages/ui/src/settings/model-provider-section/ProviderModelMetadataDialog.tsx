/* eslint-disable max-lines -- 模型元数据弹窗集中承载模型 ID（含拉取模型列表）、Token、模态与推理档位编辑；待稳定后再按字段族拆分。 */
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { CheckIcon, ChevronDownIcon, Loader2Icon, Pencil } from "lucide-react";
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

/** 候选列表项 id：输入框用 aria-activedescendant 指向当前键盘高亮项。 */
function modelOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
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
  // 拉取结果用可搜索下拉呈现：芯片形态在几十上百个模型时不可用。
  const [modelsPickerOpen, setModelsPickerOpen] = useState(false);
  // 键盘导航的当前高亮项；-1 = 未高亮（回车仍走提交草稿的既有语义）。
  const [activeModelIndex, setActiveModelIndex] = useState(-1);
  const modelIdInputRef = useRef<HTMLInputElement>(null);
  const modelsListRef = useRef<HTMLDivElement>(null);
  const modelsListboxId = useId();
  // 在途拉取的序号与弹窗开关快照：关闭弹窗或再次拉取都会推进序号，过期响应一律丢弃。
  const fetchModelsSeqRef = useRef(0);
  const openRef = useRef(open);
  const commit = async () => {
    const result = await onCommit();
    if (!result) setValidationAttempt((value) => value + 1);
  };
  // 每次关闭清空上一次拉取结果与在途状态，避免下次打开把旧 Provider 的模型列表带进新草稿。
  useEffect(() => {
    openRef.current = open;
    if (open) {
      return;
    }
    fetchModelsSeqRef.current += 1;
    setFetchedModels(null);
    setFetchModelsError(null);
    setFetchingModels(false);
    setModelsPickerOpen(false);
    setActiveModelIndex(-1);
  }, [open]);
  const canFetchModels = Boolean(providerId) && !modelIdReadOnly;
  const handleFetchModels = async () => {
    if (!providerId || fetchingModels) {
      return;
    }
    const seq = ++fetchModelsSeqRef.current;
    setFetchingModels(true);
    setFetchModelsError(null);
    try {
      const result = await providerSettingsService.listProviderModels({ providerId });
      // 弹窗已关闭或已有更新的拉取：丢弃过期响应，不能把它写进（下次打开的）弹窗。
      if (seq !== fetchModelsSeqRef.current || !openRef.current) {
        return;
      }
      setFetchedModels(result.models);
      setActiveModelIndex(-1);
    } catch (error) {
      if (seq !== fetchModelsSeqRef.current || !openRef.current) {
        return;
      }
      setFetchedModels(null);
      setFetchModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === fetchModelsSeqRef.current) {
        setFetchingModels(false);
      }
    }
  };
  // 输入框内容即过滤词：空=全部候选；模型 ID 子串匹配（大小写不敏感）。
  const fetchedModelQuery = draft.idValue.trim().toLowerCase();
  const visibleFetchedModels =
    fetchedModels?.filter(
      (modelId) => !fetchedModelQuery || modelId.toLowerCase().includes(fetchedModelQuery),
    ) ?? [];
  // 高亮项可能已被后续输入过滤掉；越界一律按未高亮处理。
  const activeOptionIndex =
    activeModelIndex >= 0 && activeModelIndex < visibleFetchedModels.length
      ? activeModelIndex
      : -1;
  const handleModelsListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }
    // Popover 嵌在 Dialog 中时，外层滚动锁会吞掉默认滚轮行为（同
    // RemoteConnectionFields 的 SSH 别名列表）：显式驱动列表自身滚动即可；
    // 被动监听下 preventDefault/stopPropagation 无效，不再调用。
    listElement.scrollTop += event.deltaY;
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
  // 候选列表打开时由输入框接管上下键 / 回车 / Esc：焦点始终留在输入框（弹层不抢焦），
  // 高亮项经 aria-activedescendant 暴露；实现不依赖 cmdk 的内部键盘状态。
  const handleModelIdKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const composing = isImeComposingKeyEvent({
      compositionActive: compositionActiveRef.current,
      nativeEvent: event.nativeEvent,
    });
    if (!composing && modelsPickerOpen && visibleFetchedModels.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = visibleFetchedModels.length;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveModelIndex((current) => {
          const base = current >= 0 && current < count ? current : delta > 0 ? -1 : 0;
          return (base + delta + count) % count;
        });
        return;
      }
      if (event.key === "Enter") {
        const activeModel = visibleFetchedModels[activeOptionIndex];
        if (activeModel !== undefined) {
          event.preventDefault();
          onDraftChange({ idValue: activeModel });
          setModelsPickerOpen(false);
          setActiveModelIndex(-1);
          return;
        }
      }
      if (event.key === "Escape") {
        // 只收起候选：阻止继续冒泡，避免同一按键再触发外层 Dialog 的关闭。
        event.preventDefault();
        event.stopPropagation();
        setModelsPickerOpen(false);
        setActiveModelIndex(-1);
        return;
      }
    }
    handleTechnicalInputKeyDown(event);
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
                    聚焦弹出候选、输入即过滤、点选或上下键+回车即填入；也保留任意手输。 */}
                <Popover
                  open={modelsPickerOpen}
                  onOpenChange={(nextOpen) => {
                    if (nextOpen) {
                      setModelsPickerOpen(true);
                      return;
                    }
                    // 展开态点击输入框会经 Trigger 语义请求关闭；此时输入框仍是焦点，
                    // 说明用户只是要定位光标/继续输入，保留候选不关。
                    if (document.activeElement === modelIdInputRef.current) {
                      return;
                    }
                    setModelsPickerOpen(false);
                    setActiveModelIndex(-1);
                  }}
                >
                  <PopoverTrigger asChild>
                    <div className="relative">
                      <Input
                        {...TECHNICAL_INPUT_ATTRIBUTES}
                        ref={modelIdInputRef}
                        type="text"
                        role="combobox"
                        aria-expanded={modelsPickerOpen}
                        aria-controls={modelsPickerOpen ? modelsListboxId : undefined}
                        aria-activedescendant={
                          modelsPickerOpen && activeOptionIndex >= 0
                            ? modelOptionId(modelsListboxId, activeOptionIndex)
                            : undefined
                        }
                        aria-autocomplete="list"
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
                        onKeyDown={handleModelIdKeyDown}
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
                      {/* 手写 listbox：cmdk 的 Item 会覆写 id/data-selected/aria-selected，
                          外部输入框驱动的键盘高亮无法与它对齐；这里直接渲染带 id 的选项。 */}
                      <div
                        ref={modelsListRef}
                        id={modelsListboxId}
                        role="listbox"
                        tabIndex={-1}
                        aria-label={intl.formatMessage({
                          id: "settings.modelProvider.fetchModels",
                        })}
                        className="max-h-60 overflow-y-auto overscroll-contain p-1"
                        onWheel={handleModelsListWheel}
                      >
                        {visibleFetchedModels.length === 0 ? (
                          <p className="px-4 py-5 text-foreground-subtle">
                            {intl.formatMessage({
                              id: "settings.modelProvider.fetchModelsNoMatch",
                            })}
                          </p>
                        ) : (
                          visibleFetchedModels.map((modelId, index) => {
                            const checked = modelId === draft.idValue.trim();
                            const active = index === activeOptionIndex;
                            return (
                              <div
                                key={modelId}
                                id={modelOptionId(modelsListboxId, index)}
                                role="option"
                                aria-selected={active}
                                data-selected={active ? "true" : undefined}
                                className="relative flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-ui-base select-none hover:bg-menu-hover data-selected:bg-menu-hover data-selected:text-foreground"
                                title={modelId}
                                // mousedown 默认行为会把焦点从输入框抢走，先拦掉再靠 click 填值。
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseMove={() => setActiveModelIndex(index)}
                                onClick={() => {
                                  onDraftChange({ idValue: modelId });
                                  setModelsPickerOpen(false);
                                  setActiveModelIndex(-1);
                                }}
                              >
                                <span className="truncate font-mono text-ui-sm">{modelId}</span>
                                {checked ? (
                                  <CheckIcon
                                    aria-hidden="true"
                                    className="ml-auto size-4 shrink-0 text-foreground-subtle"
                                  />
                                ) : null}
                              </div>
                            );
                          })
                        )}
                      </div>
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
