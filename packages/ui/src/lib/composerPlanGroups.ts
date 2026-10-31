import type { ProviderSettingsView } from "@zcode/services";
import type {
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelection,
  ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import { type ModelProviderGroupLabelOptions } from "@/lib/modelSelectionGroups.js";
export interface ComposerConnection {
  key: string;
  label: string;
  providerId: string;
  family: ProviderFamilyDomain;
  selection?: ProviderFamilyConnectionSelection;
  items: ModelSelectGroupItem[];
  disabled?: boolean;
}
export interface ComposerPlanGroup extends ModelSelectGroup {
  connection?: ComposerConnection;
}
interface TeamProduct {
  family?: ProviderFamilyDomain;
  productId: string;
  subscribed?: boolean | null;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  apiKeyStatus?: string | null;
  teamProjects?: Array<{
    organizationId?: string | null;
    organizationName?: string | null;
    projectId?: string | null;
    apiKeyStatus?: string | null;
  }> | null;
}
export function composerConnectionKey(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
) {
  return JSON.stringify(
    selection.kind === "team-coding-plan"
      ? [family, selection.kind, selection.productId, selection.organizationId, selection.projectId]
      : [family, selection.kind],
  );
}
export function chooseConnectionModel(items: readonly ModelSelectGroupItem[], model?: string) {
  return items.find((item) => item.name === model) ?? items[0];
}
/** 只投影账号套餐行；API、自定义供应商及模型目录仍沿用原始对象。 */
export function buildComposerPlanGroups(
  groups: readonly ModelSelectGroup[],
  _products: readonly TeamProduct[],
  settingsView?: ProviderSettingsView | null,
  _agentProvider: ZCodeProvider = "glm",
  _labels: ModelProviderGroupLabelOptions = {},
  _selections?: Partial<Record<ProviderFamilyDomain, ProviderFamilyConnectionSelection>>,
): ComposerPlanGroup[] {
  // FORK (upgrade-316, D-13)：账号型 provider / coding plan providerId 三字段与
  // accountState 已随订阅面整删，ModelProviderFamilySpec 解析恒为 null。
  // 因此不再生成个人/团队套餐行，只按 fork 的可用性判据（executable）过滤现有 provider 组；
  // 其它参数保留在签名里，避免调用方与类型契约变化。
  const isAvailable = (providerId: string) => {
    const provider = settingsView?.providers.find((item) => item.providerId === providerId);
    // 与 upstream `accountState?.availability !== "unavailable"` 对齐：目录里没有该
    // provider 时视为可用（保留组），存在但不可执行时才隐藏。
    return provider?.executable !== false;
  };
  return groups.filter((group) => isAvailable(group.key.replace(/^registry-provider:/, "")));
}

