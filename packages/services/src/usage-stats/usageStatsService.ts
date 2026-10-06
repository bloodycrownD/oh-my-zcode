import type { AppUsageRequest, AppUsageSnapshot } from "@zcode/shared";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";

interface UsageStatsServiceDependencies {
  /** App Usage 经 ZCode Protocol 读取 agent 数据库真实统计。 */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
}

/**
 * FORK（D-4）：只保留 App Usage —— 本地 agent 数据库统计，不触达官方端点。
 * Coding Plan 额度、订阅与权益查询随订阅面整删。
 */
export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
  };
}