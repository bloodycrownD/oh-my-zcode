import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";

/**
 * FORK（D-4）：Coding Plan 额度页整删后只剩 App Usage（本地 agent 数据库统计）。
 * 设置页的 usage 分区不再有第二个 tab。
 */
export function UsageStatsSection() {
  return <AppUsagePanel />;
}