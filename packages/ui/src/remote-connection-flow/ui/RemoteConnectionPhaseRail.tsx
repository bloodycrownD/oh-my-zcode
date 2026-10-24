// 连接向导内的阶段轨（knip-wire-progress）：数据只来自真实 runtime 日志流，
// 与后台最小化进度条共用 remoteConnectionPhases 的同一份投影，避免两处百分比算法漂移。
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  getRemoteConnectionActivePhase,
  getRemoteConnectionPhasePercent,
  resolveRemoteConnectionPhases,
  type RemoteConnectionPhaseStatus,
} from "@/remote-connection-flow/ui/remoteConnectionPhases.js";

const SEGMENT_CLASS: Record<RemoteConnectionPhaseStatus, string> = {
  complete: "bg-success",
  active: "bg-primary animate-pulse motion-reduce:animate-none",
  failed: "bg-destructive",
  pending: "bg-border",
};

export function RemoteConnectionPhaseRail({
  logs,
  connectionReady = false,
}: {
  logs: ReadonlyArray<Pick<RemoteConnectionLogEntry, "message" | "level">>;
  connectionReady?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const phases = resolveRemoteConnectionPhases(logs, { connectionReady });
  const active = getRemoteConnectionActivePhase(phases);
  const percent = getRemoteConnectionPhasePercent(phases);

  return (
    <div
      data-testid="remote-connection-phase-rail"
      data-phase-status={active.status}
      className="rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 text-ui-sm">
        <span className="min-w-0 truncate font-medium text-foreground">
          {intl.formatMessage({ id: active.titleId })}
        </span>
        <span
          data-testid="remote-connection-phase-percent"
          className="shrink-0 text-foreground-subtle"
        >
          {percent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${intl.formatMessage({ id: active.titleId })} ${percent}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-2 flex gap-1"
      >
        {phases.map((phase) => (
          <span
            key={phase.key}
            data-progress-phase={phase.key}
            data-progress-status={phase.status}
            title={intl.formatMessage({ id: phase.titleId })}
            className={cn("h-1.5 flex-1 overflow-hidden rounded-full", SEGMENT_CLASS[phase.status])}
          />
        ))}
      </div>
    </div>
  );
}
