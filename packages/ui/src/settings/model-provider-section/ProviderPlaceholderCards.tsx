import { Loader2Icon } from "lucide-react";

/**
 * FORK（D-4）：原 `StatusCards.tsx` 里只有加载卡是 provider 通用的，
 * 其余全部服务于 Coding Plan / Start Plan 额度与购买，随订阅面整删。
 * FORK（删除 zai/bigmodel 预设面）：预设未同步占位卡（PresetProviderPlaceholderCard）
 * 随内置 preset 导航分组一并摘除。
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