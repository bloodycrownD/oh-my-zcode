import { useEffect } from "react";
import type { AppSettings } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

interface UseRetireLegacyMemorySwitchInput {
  activeSection: SettingsSectionId;
  memoryEnabled: boolean | undefined;
  updateSharedSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

// FORK（magic-context-memory-management / 变更点 10 · Step 8）：存量迁移。
// 原生「工作区记忆」开关已从 UI 退场（分区改挂 magic-context 项目记忆管理面板），
// 但协议字段 memoryEnabled 保留照发（strict 兼容窗口 + 压制 CLI 原生记忆提取），
// 因此存量 true 必须在这里归零——这是隐形开关的唯一出口。onboarding 侧已停写该键
// （Step 9），这里写回 false 后不会被换号同步复活。
export function useRetireLegacyMemorySwitch({
  activeSection,
  memoryEnabled,
  updateSharedSettings,
}: UseRetireLegacyMemorySwitchInput) {
  const { intl } = useZCodeIntl();
  useEffect(() => {
    if (activeSection !== "memory") return;
    if (memoryEnabled !== true) return;
    void (async () => {
      try {
        await updateSharedSettings({ memoryEnabled: false });
        toast(intl.formatMessage({ id: "settings.memory.management.legacySwitchRetired" }));
      } catch (error) {
        // 归零失败不阻塞分区渲染：下次进入分区会重试，面板本身不依赖该字段。
        console.warn("[settings] 关闭遗留的原生记忆开关失败", String(error));
      }
    })();
  }, [activeSection, intl, memoryEnabled, updateSharedSettings]);
}
