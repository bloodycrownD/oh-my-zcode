// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批）并 omz 化：
// ISourceServerManagementService 频道面随 P9 设置页批（spec ⑦ 挂账）；此处收窄为结构
// 端口（getRecentOperationLogs/onDidAppendOperationLog），management 缺席时静默降级，
// 事件只触发重读，关闭页面后仍从同一个 Host owner 查询；不在 UI 累积历史。
import { useEffect, useState } from "react";
import { sourceServerOperationLogSchema, type SourceServerOperationLog } from "@zcode/shared";
import { logger } from "@/logger.js";

export interface SourceServerOperationLogsPort {
  getRecentOperationLogs?(profile: { profileId: string }): Promise<SourceServerOperationLog[]>;
  onDidAppendOperationLog?(listener: () => void): { dispose(): void } | undefined;
}

export function useSourceServerOperationLogs(
  management: SourceServerOperationLogsPort | undefined,
  profileIds: readonly string[] = [],
) {
  const [logsByProfileId, setLogsByProfileId] = useState<
    Record<string, SourceServerOperationLog[]>
  >({});
  const profileKey = JSON.stringify([...new Set(profileIds)].sort());
  useEffect(() => {
    setLogsByProfileId({});
    if (!management?.getRecentOperationLogs) return;
    const ids: string[] = JSON.parse(profileKey);
    let disposed = false;
    let pending = false;
    let queued = false;
    const refresh = async () => {
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      try {
        const entries = await Promise.all(
          ids.map(async (id) => {
            const logs = await management.getRecentOperationLogs!({ profileId: id });
            return [id, logs.map((entry) => sourceServerOperationLogSchema.parse(entry))] as const;
          }),
        );
        if (!disposed) setLogsByProfileId(Object.fromEntries(entries));
      } catch (error) {
        if (!disposed) logger.warn("读取远程设备最近日志失败", error);
      } finally {
        pending = false;
        if (!disposed && queued) {
          queued = false;
          void refresh();
        }
      }
    };
    const subscription = management.onDidAppendOperationLog?.(() => {
      void refresh();
    });
    void refresh();
    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [management, profileKey]);
  return { logsByProfileId };
}
