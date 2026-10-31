/**
 * FORK (upgrade-316): 客户端精选推荐区已下线（settings/recommendedPlugins.json 的
 * $comment 已注明「客户端精选推荐区已下线，pluginNames 策展名单随之下线」）。
 *
 * v3.16.2 上游引入的 `clientConfigService.getSnapshot()` / `ClientConfigSnapshot`
 * 在 fork 的 shared 与 IServiceAccessor 中都不存在，且没有对应实现可接；
 * 按「已移除特性只删引用或改 no-op，不重新引入实现」的约定，这里保留同名 hook
 * 与原返回结构，恒返回空推荐，让插件商店/启动器 UI 无需改动调用面即可编译运行。
 */
export interface RecommendedUiPluginEntry {
  pluginId: string;
  surfaceId: string;
}

/** 推荐区下线后，承载它的「打开标签页」UI 插件分区一并隐藏（含空态与查看全部）。 */
export const isUiPluginRecommendationEnabled = false;

export function useUiPluginRecommendations(_enabled: boolean): {
  recommendations: RecommendedUiPluginEntry[];
  loading: boolean;
} {
  // 无推荐来源：空数组 + 非 loading，避免启动器一直停在骨架屏。
  return { recommendations: [], loading: false };
}
