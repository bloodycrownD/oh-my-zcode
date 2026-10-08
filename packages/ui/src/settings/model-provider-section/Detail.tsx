/* eslint-disable max-lines -- Model Provider 详情页当前集中编排 Plan Card、API Key 表单和 OAuth 套餐态；后续稳定后再按 family/API/OAuth 拆分。 */
import {



  type BuiltinModelProviderId,
  type ProviderFamilyConnectionSelectionSettings,




  type ModelConnectivityResult,
  type OAuthProviderId,
} from "@zcode/shared";
import {
  getProviderFormApiKeyManagementUrl,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { type CodingPlanStatus, type ModelProviderNavItem } from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import { ModelProviderLoadingCard } from "./ProviderPlaceholderCards.js";
import { type CodingPlanLoginOptions } from "./codingPlanPricingCards.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import type { ProviderSettingsView } from "@zcode/services";
import type { SavePersonalModelDraftInput } from "@zcode/provider";

export function ModelProviderSectionDetail({
  selectedNavItem,
  navigationItems = selectedNavItem ? [selectedNavItem] : [],
  connectionSettingsFailed = false,

  startPlanSubscriptionCount = 0,
  providerListLoading = false,





  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onReorderProviderModels,
  onTestModel,



  onOpenApiKeyUrl,



  providerSettingsView: providerSettingsViewOverride,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems?: ModelProviderNavItem[];
  connectionSettingsFailed?: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  startPlanSubscriptionCount?: number;
  /** 供应商列表是否仍在加载：用于区分「首屏加载中」与「确实还没有自定义供应商」的空状态。 */
  providerListLoading?: boolean;
  codingPlanPurchaseTokenAuthenticatedByProviderId: Partial<
    Record<BuiltinModelProviderId, boolean>
  >;
  codingPlanAuthError?: string | null;
  presetSubscriptionProviderId: BuiltinModelProviderId | null;
  codingPlanStatusSyncProviderId: BuiltinModelProviderId | null;
  codingPlanDisconnectProviderId: BuiltinModelProviderId | null;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onReorderProviderModels?: (providerId: string, modelIds: string[]) => Promise<void>;
  onTestModel: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onRetryCodingPlan?: () => void | Promise<void>;
  onCodingPlanLogin: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
    status: CodingPlanStatus,
    options?: CodingPlanLoginOptions,
  ) => number | void;
  onCodingPlanDisconnect: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
  ) => void;
  onOpenApiKeyUrl: (url: string) => void;
  onCodingPlanPurchaseComplete: () => void | Promise<void>;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
  providerSettingsView?: ProviderSettingsView | null;
}) {
  const { intl } = useZCodeIntl();
  const loadingLabel = intl.formatMessage({ id: "common.loading" });
  const rootProviderSettingsRead = useProviderSettingsView();
  const rootProviderSettingsView =
    rootProviderSettingsRead.state.status === "ready" ? rootProviderSettingsRead.state.view : null;
  const providerSettingsView = providerSettingsViewOverride ?? rootProviderSettingsView;
  // 账号分支曾漏传删除回调，出现只删 UI 不写盘。所有详情共用同一套模型操作装配。
  const modelEditingProps = {
    onAddPersonalModel,
    onSavePersonalModelDraft,
    onSetPersonalModelEnabled,
    onDeletePersonalModel,
    settingsRevision: providerSettingsView?.revision,
  };

  if (!selectedNavItem) {
    // 预设分组删除后，列表加载完成但没有任何自定义供应商时不能一直显示 loading。
    // 空状态把入口交给页面右上角「添加供应商」，避免用户把空列表误判成页面卡住。
    if (providerListLoading) {
      return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
    }

    return (
      <div className="flex h-12 items-center rounded-lg border border-dashed border-border px-4 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.empty" })}
      </div>
    );
  }

  if (selectedNavItem.type === "preset") {
    // FORK（删除 zai/bigmodel 预设面）：内置 preset provider 与对应导航分组已整删，
    // 原「尚未同步，请先完成 OAuth 登录」占位分支不会再被命中；这里只保留 loading 兜底，
    // 防止旧导航 key 或外部入口残留时把 preset 误渲染成自定义供应商表单。
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  if (selectedNavItem.type === "codingPlanLoading") {
    // Z.AI plan 判定占位只属于左侧导航，不应进入详情表单渲染路径。
    return null;
  }

  if (!selectedNavItem.provider) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  const customProvider = selectedNavItem.provider;
  const customApiKeyUrl = customProvider.templateId
    ? getProviderFormApiKeyManagementUrl(customProvider)
    : undefined;
  return (
    // 仅展示预设模板声明的入口，不根据地址猜测自定义 Provider 的 Key 控制台。
    <InlineEditableProviderCard
      provider={customProvider}
      onSave={onSave}
      {...modelEditingProps}
      onDelete={() => onDelete(customProvider)}
      onReorderModelIds={
        onReorderProviderModels
          ? (modelIds) => onReorderProviderModels(customProvider.providerId, modelIds)
          : undefined
      }
      onTestModel={onTestModel}
      presetApiKeyUrl={customApiKeyUrl}
      readOnlyEndpoints={false}
      nameEditable
      onOpenPresetApiKey={
        customApiKeyUrl
          ? () => {
              onOpenApiKeyUrl(customApiKeyUrl);
            }
          : undefined
      }
    />
  );
}
