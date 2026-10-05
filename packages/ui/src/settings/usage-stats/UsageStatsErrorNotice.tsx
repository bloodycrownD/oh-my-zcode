import { AlertTriangle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * FORK（D-4）：额度错误分类原依赖 `usageErrorCopy`（团队套餐 / 凭据错误文案），
 * 随 Coding Plan 额度面整删。App Usage 的失败直接展示原始错误文本。
 */
export function UsageStatsErrorNotice({ error }: { error: string }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex w-fit min-w-0 items-center gap-1.5 text-ui-base">
      <AlertTriangle className="size-3 shrink-0 text-destructive" />
      <span className="min-w-0 truncate whitespace-nowrap text-destructive">{error}</span>
      <span className="sr-only">{intl.formatMessage({ id: "common.loading" })}</span>
    </div>
  );
}