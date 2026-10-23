import type { ProviderSettingsView } from "@zcode/services";
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { resolveProviderTemplateName } from "@zcode/provider";
import type { ReactNode } from "react";
import {
  TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderLogo } from "./ProviderLogo.js";
import type { ProviderTemplatePick } from "./createProviderNameDialog.js";

/**
 * Template 选择页只负责「选项 → 选择意图」：选中后把模板 ID 与预填名交给 Section，
 * 由名称弹窗确认名称、再走 `createPersonalProvider`。这里不再直接创建供应商，
 * 因此也不需要创建态与失败横幅。
 */
export function ProviderTemplatePicker({
  templates,
  onBack,
  onPicked,
}: {
  templates: ProviderSettingsView["providerTemplates"];
  onBack: () => void;
  onPicked: (pick: ProviderTemplatePick) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const customLabel = intl.formatMessage({ id: "settings.modelProvider.newProviderName" });
  // FORK（删除 zai/bigmodel 预设面）：选择器不再提供这 4 个智谱模板入口（Z.ai / BigModel API、Coding Plan），
  // 也不再单独分组。模板来源数据（config/provider/zcode-builtin.json 的 templateRules）保持不动，
  // 存量用户的 personal provider 仍按 templateId 解析 overlay，删数据会让旧 Provider 不可执行。
  const hiddenZhipuTemplateIds = [
    "bigmodel-api",
    "zai-api",
    "bigmodel-standard-api",
    "zai-standard-api",
  ];
  const visibleTemplates = templates.filter(
    (template) => !hiddenZhipuTemplateIds.includes(template.templateId),
  );
  const groups = [
    {
      id: "other",
      templates: visibleTemplates,
    },
  ] as const;
  return (
    <section className="space-y-5" data-testid={TID_MODEL_PROVIDER_TEMPLATE_PICKER}>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON}
          aria-label={intl.formatMessage({ id: "settings.modelProvider.templatePickerBack" })}
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.templatePickerTitle" })}
        </h2>
      </div>

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.id} data-provider-template-group={group.id} className="space-y-3">
            <h3 className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: `settings.modelProvider.templateGroup.${group.id}` })}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.id === "other" ? (
                <ProviderTemplateCard
                  label={intl.formatMessage({ id: "settings.modelProvider.createCustomProvider" })}
                  testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "custom")}
                  icon={
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover">
                      <PlusIcon className="size-4" aria-hidden="true" />
                    </span>
                  }
                  onClick={() => onPicked({ suggestedName: customLabel })}
                />
              ) : null}
              {group.templates.map((template) => {
                const label = resolveProviderTemplateName(template.templateId, template, locale);
                return (
                  <ProviderTemplateCard
                    key={template.templateId}
                    label={label}
                    testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, template.templateId)}
                    icon={
                      <span className="flex size-9 shrink-0 items-center justify-center">
                        <ProviderLogo logo={template.config.logo} className="size-8" />
                      </span>
                    }
                    onClick={() =>
                      onPicked({ templateId: template.templateId, suggestedName: label })
                    }
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function ProviderTemplateCard({
  label,
  testId: cardTestId,
  icon,
  onClick,
}: {
  label: string;
  testId: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <button
        type="button"
        data-testid={cardTestId}
        onClick={onClick}
        className="flex min-h-16 min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors outline-none hover:border-border-hover hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
      >
        {icon}
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{label}</span>
        <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      </button>
    </ControlHintTooltip>
  );
}
