import type { PluginStoreOrder } from "@zcode/shared";

/**
 * FORK（D-6）：`/api/v1/client/configs` 下发链整删，插件商店顺序退化为内置序。
 *
 * hook 签名保留（3 个消费者 PluginStorePage / WorkspacePluginPreview / pluginsMentionProvider
 * 零改动），`order` 恒为 null 表示「不排序、按内置顺序展示」，`refresh` 为 no-op。
 */
export function usePluginStoreOrder(_enabled = true): {
  order: PluginStoreOrder | null;
  refresh: (forceRefresh?: boolean) => Promise<void>;
} {
  return { order: null, refresh: async () => {} };
}