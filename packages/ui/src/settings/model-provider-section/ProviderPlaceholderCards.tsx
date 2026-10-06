import { Loader2Icon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * FORK（D-4）：原 `StatusCards.tsx` 里只有这两张卡是 provider 通用的，
 * 其余全部服务于 Coding Plan / Start Plan 额度与购买，随订阅面整删。
 * 这两张通用卡独立成文件，避免与订阅语义绑在一起。
 */
export function ModelProviderLoadingCard({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" />
        <span>{loadingLabel}</span>
      </div>
    </div>
  );
}

export function PresetProviderPlaceholderCard({
  displayName,
  messageId = "settings.modelProvider.presetEmpty",
}: {
  displayName: string;
  messageId?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="bg-background/50 rounded-2xl p-3">
      <div className="text-ui-lg font-semibold text-foreground">{displayName}</div>
      <div className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: messageId })}
      </div>
    </div>
  );
}