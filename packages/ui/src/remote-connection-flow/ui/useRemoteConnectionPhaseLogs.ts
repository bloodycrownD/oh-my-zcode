// 阶段投影的日志来源（knip-wire-progress）：必须读 runtime 原始事件而不是展示日志。
// 展示日志经 `normalizeRemoteConnectionLogMessage` 剥掉了 `[source-server:<phase>]` 前缀，
// 用它投影阶段会永远停在第一步；这里只清理时间戳/pid 噪音，保留 phase 标记。
import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService, RemoteConnectionRuntimeLog } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";

const PHASE_LOG_LIMIT = 200;

/** 与展示日志的 normalizer 同源，但保留 `[source-server:<phase>]` 前缀。 */
export function normalizeRemoteConnectionPhaseLogMessage(message: string): string {
  return message
    .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/u, "")
    .replace(/^\[pid:\d+\]\s*/u, "")
    .trim();
}

function shouldAcceptPhaseLog(
  entry: Pick<RemoteConnectionRuntimeLog, "requestId">,
  activeRequestId: string | null,
): boolean {
  if (!activeRequestId) return true;
  return entry.requestId?.trim() === activeRequestId;
}

export function useRemoteConnectionPhaseLogs(activeRequestId?: string | null) {
  const platform: IPlatformService | null = useOptionalPlatform();
  const activeRequestIdRef = useRef(activeRequestId);
  const [phaseLogs, setPhaseLogs] = useState<RemoteConnectionLogEntry[]>([]);

  useEffect(() => {
    activeRequestIdRef.current = activeRequestId;
    // 每次连接尝试的 requestId 都不同；换 id 必须清空，否则新阶段会继承上一次的完成度。
    setPhaseLogs([]);
  }, [activeRequestId]);

  useEffect(() => {
    if (!platform) return;
    const unsubscribe = platform.onRemoteConnectionLog((entry) => {
      const requestId = activeRequestIdRef.current?.trim() ?? null;
      if (!shouldAcceptPhaseLog(entry, requestId)) return;
      const message = normalizeRemoteConnectionPhaseLogMessage(entry.message);
      if (!message) return;
      setPhaseLogs((current) =>
        [
          ...current,
          {
            id: `${entry.label}-${entry.timestamp}-${current.length}`,
            level: entry.level,
            message,
            timestamp: entry.timestamp,
          },
        ].slice(-PHASE_LOG_LIMIT),
      );
    });
    return unsubscribe;
  }, [platform]);

  const resetPhaseLogs = useCallback(() => setPhaseLogs([]), []);
  return { phaseLogs, resetPhaseLogs };
}
