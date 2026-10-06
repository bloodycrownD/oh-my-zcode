import type { AppUsageRequest, AppUsageSnapshot } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * FORK（D-4）：Coding Plan 额度/订阅链路已整删，只保留 App Usage。
 *
 * App Usage 读的是 agent 本地数据库的真实统计（经 ZCode Protocol `usage/stats`），
 * 不触达任何官方端点；原文件里其余方法全部服务于官方额度接口，随订阅面一并下线。
 */
export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);