import { useCallback, useEffect, useRef } from "react";
import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import { TID_SSH_ERROR, type RemoteTarget } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isRemoteConnectionLogScrolledToLatest,
  scrollRemoteConnectionLogsToLatestIfFollowing,
} from "@/remote-connection/remoteConnectionLogScroll.js";
import {
  normalizeRemoteConnectionPhase,
  REMOTE_CONNECTION_PHASES,
} from "@/remote-connection/remoteOperationProgress.js";

export type RemoteConnectionPhaseStatus = "pending" | "active" | "complete" | "failed";

/**
 * 照搬上游 v3.16.2 remote-connection/RemoteConnectionConnectingStep.tsx:75-111 的
 * `resolveRemoteConnectionPhases`（backlog-sweep Step 9 / P9-3 例外的最小实现）。
 * 阶段清单与原始 phase 归并复用 `remoteOperationProgress.ts` 的唯一维护点，本函数只负责
 * 「渲染层日志流 → 四态阶段轨」的投影：日志 message 形如 `[source-server:<phase>] ...`。
 * 消费方：`remote-connection-flow/ui/RemoteConnectionProgress.tsx` 的最小化连接进度条。
 */
export function resolveRemoteConnectionPhases(
  logs: ReadonlyArray<Pick<RemoteConnectionLogEntry, "message" | "level">>,
  options: { connectionReady?: boolean } = {},
) {
  let activeIndex = -1;
  let failedIndex = -1;
  for (const log of logs) {
    const match = /^\[source-server:([^\]]+)\]/u.exec(log.message);
    if (!match) continue;
    const phaseIndex = REMOTE_CONNECTION_PHASES.findIndex(
      ([key]) => key === normalizeRemoteConnectionPhase(match[1]!),
    );
    if (phaseIndex < 0) continue;
    activeIndex = Math.max(activeIndex, phaseIndex);
    if (log.level === "error") failedIndex = phaseIndex;
  }
  // 修复原因：成功连接后 publish-online 不是 Renderer 日志流的可靠终结事件，
  // 仅按日志推断会出现顶部已连接但阶段轨永久停在握手中的状态。连接 session ready
  // 是同一条连接流程的权威终态；没有错误阶段时用它完成最终阶段，不改变连接中的日志进度。
  const connectionReady =
    (options.connectionReady === true ||
      logs.some((log) => log.message.startsWith("[source-server:publish-online]"))) &&
    failedIndex < 0;
  return REMOTE_CONNECTION_PHASES.map(([key, titleId], index) => ({
    key,
    titleId,
    status: (failedIndex === index
      ? "failed"
      : connectionReady
        ? "complete"
        : index < activeIndex
          ? "complete"
          : index === activeIndex
            ? "active"
            : "pending") as RemoteConnectionPhaseStatus,
  }));
}

export function RemoteConnectionConnectingStep({
  logs,
  errorMessage,
  loading,
  onBack,
  onRetry,
}: {
  kind: RemoteTarget["kind"];
  logs: RemoteConnectionLogEntry[];
  errorMessage: string;
  loading: boolean;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { intl } = useZCodeIntl();
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestLogRef = useRef(true);
  const latestLogId = logs.at(-1)?.id;
  const latestLogTimestamp = logs.at(-1)?.timestamp;

  const handleLogContainerScroll = useCallback(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    shouldFollowLatestLogRef.current = isRemoteConnectionLogScrolledToLatest(container);
  }, []);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    // 日志持续追加会推高 scrollHeight，无条件写 scrollTop 会把向上查看历史日志的用户拉回底部。
    // 这里只在用户原本贴底时继续跟随最新日志。
    if (
      scrollRemoteConnectionLogsToLatestIfFollowing(container, shouldFollowLatestLogRef.current)
    ) {
      shouldFollowLatestLogRef.current = true;
    }
  }, [logs.length, latestLogId, latestLogTimestamp]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 h-full">
      <div className="flex flex-col flex-1 min-h-0 space-y-4">
        <div className="min-h-0 flex-1 flex flex-col rounded-xl bg-background border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "remote.connectionLog" })}
            </p>
            {loading ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <LoaderIcon className="size-3.5 animate-spin" />
                {intl.formatMessage({ id: "remote.connecting" })}
              </div>
            ) : null}
          </div>
          <div
            ref={logContainerRef}
            onScroll={handleLogContainerScroll}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 font-mono text-ui-base"
          >
            {logs.length > 0 ? (
              logs.map((entry) => (
                <div key={entry.id} className="w-full flex min-w-0 leading-5 text-foreground">
                  <span className="text-foreground-subtlest">{entry.timestamp}</span>
                  <span
                    className={cn(
                      "mx-2",
                      entry.level === "success"
                        ? "text-success"
                        : entry.level === "warn"
                          ? "text-warning"
                          : entry.level === "error"
                            ? "text-destructive"
                            : "text-foreground-subtle",
                    )}
                  >
                    [{entry.level.toUpperCase()}]
                  </span>
                  <span>{entry.message}</span>
                </div>
              ))
            ) : (
              <div className="flex min-h-full items-center justify-center text-foreground-subtle">
                <span>[INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}</span>
              </div>
            )}
          </div>
        </div>

        {errorMessage ? (
          <div
            data-testid={TID_SSH_ERROR}
            className="flex flex-wrap items-start gap-3 rounded-xl border border-warning/30 px-4 py-3 text-ui-base text-warning"
          >
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">{errorMessage}</span>
          </div>
        ) : null}
      </div>

      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onBack}
          disabled={loading}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <Button
          type="button"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onRetry}
          disabled={loading}
        >
          {loading
            ? intl.formatMessage({ id: "remote.connecting" })
            : intl.formatMessage({ id: "remote.retryConnection" })}
        </Button>
      </div>
    </div>
  );
}
