// 照搬上游 v3.16.2 remote-connection-flow/ui/RemoteConnectionProgress.tsx（134L，backlog-sweep
// Step 9 / P9-3 组件级例外，拍板 A 的例外真实范围之一）。
// 组件形态照搬；本仓向导壳未搬（拍板 A），故 Provider 无生产挂载点——面板侧的
// `useRemoteConnectionProgress()` 恒为 null，「未完成连接」横幅不渲染。这是登记过的降级，
// 不是死代码：向导壳落地时只需在 Root 挂 Provider + 发布点。
import type { RemoteConnectionProgress } from "@/remote-connection-flow/contract.js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveRemoteConnectionPhases } from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { formatRemoteLinkRailTarget } from "@/remote-connection/RemoteLinkRail.js";
import { cn } from "@/components/lib/utils.js";

const ProgressContext = createContext<RemoteConnectionProgress | null>(null);
const PublishProgressContext = createContext<
  ((progress: RemoteConnectionProgress | null) => void) | null
>(null);

export function RemoteConnectionProgressProvider({ children }: { children: ReactNode }) {
  const [progress, publish] = useState<RemoteConnectionProgress | null>(null);
  // 发布方只订阅稳定的命令，不能订阅自己的显示结果；否则新日志引用会形成 render/effect 回环。
  return (
    <PublishProgressContext value={publish}>
      <ProgressContext value={progress}>{children}</ProgressContext>
    </PublishProgressContext>
  );
}
export function useRemoteConnectionProgress() {
  return useContext(ProgressContext);
}
export function usePublishRemoteConnectionProgress(progress: RemoteConnectionProgress | null) {
  const publish = useContext(PublishProgressContext);
  useEffect(() => {
    publish?.(progress);
  }, [publish, progress]);
  useEffect(() => () => publish?.(null), [publish]);
}

export function RemoteConnectionMinimizedProgress({
  view,
  cancelled,
  target,
  name,
  logs,
  error,
  reason,
  waiting,
  onResume,
  onCancel,
  ready,
}: RemoteConnectionProgress) {
  const { intl } = useZCodeIntl();
  const phases = resolveRemoteConnectionPhases(logs);
  const active =
    phases.find((phase) => phase.status === "active" || phase.status === "failed") ?? phases[0]!;
  const percent = Math.round(
    (phases.filter((phase) => phase.status === "complete").length / phases.length) * 100,
  );
  const device = name ?? (target ? formatRemoteLinkRailTarget(target) : "");
  const progressing = view === "connecting" && !cancelled && !ready;
  const title = intl.formatMessage(
    {
      id: ready
        ? "remote.background.ready"
        : error
          ? "remote.minimized.failed"
          : cancelled
            ? "remote.connectionCancelled"
            : progressing
              ? "remote.minimized.connecting"
              : `remote.minimized.${view}`,
    },
    { device },
  );
  return (
    <div data-background-connection className="px-4 pb-3">
      <button
        type="button"
        data-testid="remote-connection-minimized"
        onClick={onResume}
        className={cn(
          "my-2 w-full rounded-lg border border-border p-2 text-left",
          error
            ? "bg-destructive-surface text-destructive-surface-foreground"
            : progressing
              ? "bg-progress-surface text-progress-surface-foreground"
              : "bg-surface text-foreground",
        )}
      >
        <span className="flex items-center gap-2 text-ui-sm font-medium">
          {error ? (
            <AlertTriangleIcon className="size-3.5 shrink-0" />
          ) : progressing ? (
            <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {!error && progressing ? <span>{percent}%</span> : null}
        </span>
        <span className="mt-1 block break-words text-ui-xs">
          {(error ? `${error} · ${reason}` : "") ||
            intl.formatMessage({
              id: !progressing
                ? "remote.minimized.resume"
                : waiting
                  ? "remote.minimized.waiting"
                  : active.titleId,
            })}
        </span>
        {!error && progressing ? (
          <span
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-2 block h-1 overflow-hidden rounded-full bg-border"
          >
            <span
              className="block h-full bg-progress-surface-foreground"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : null}
        <span className="mt-1 block text-ui-sm underline">
          {intl.formatMessage({
            id: ready ? "remote.background.continue" : "remote.background.review",
          })}
        </span>
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-ui-sm text-foreground-subtle hover:text-foreground underline"
      >
        {intl.formatMessage({ id: ready ? "common.close" : "remote.background.cancel" })}
      </button>
    </div>
  );
}
