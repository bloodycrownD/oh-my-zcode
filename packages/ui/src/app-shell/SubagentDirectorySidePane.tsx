import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import { testId, TID_V4_BACKGROUND_WORK_CANCEL } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
  SquareIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type {
  OpenScopedSubagentSideTabRequest,
  SubagentDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { resolveDirectoryRowCancelWorkId } from "@/lib/subagentDirectoryCancel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

type DirectoryItem = RunningSubagentSummary | ZCodeSessionEndedSubagent;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

function buildSubagentDirectoryOpenRequest(
  tab: SubagentDirectorySidePaneTab,
  item: DirectoryItem,
): OpenScopedSubagentSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    rootSessionId: tab.rootSessionId,
    parentSessionId: tab.parentSessionId,
    childSessionId: item.childSessionId,
    subagentType: item.subagentType,
    title: item.title,
  };
}

function StatusIcon({ status }: { status: DirectoryItem["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <LoaderCircleIcon aria-hidden className={`${className} animate-spin`} />;
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden className={className} />;
    case "success":
      return <CheckCircle2Icon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "cancelled":
      return <BanIcon aria-hidden className={className} />;
    case "lost":
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

const DirectoryRow = memo(function DirectoryRow({
  item,
  onOpen,
  onCancelBackgroundWork,
}: {
  item: DirectoryItem;
  onOpen: (item: DirectoryItem) => void;
  /** running 行的「停止」入口；缺省（只读 pane / 无可用连接）时不渲染按钮。 */
  onCancelBackgroundWork?: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const timestamp = "endedAt" in item ? item.endedAt : item.startedAt;
  const cancelWorkId = resolveDirectoryRowCancelWorkId(item, Boolean(onCancelBackgroundWork));
  const handleCancel = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // 行整体本身是可点的打开按钮，不拦冒泡的话点「停止」会顺带打开详情 tab。
      event.stopPropagation();
      if (cancelWorkId !== null) {
        onCancelBackgroundWork?.(cancelWorkId);
      }
    },
    [cancelWorkId, onCancelBackgroundWork],
  );
  return (
    <div className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        onClick={() => onOpen(item)}
      >
        <span className="mt-0.5 text-foreground-subtle">
          <StatusIcon status={item.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground">{item.title}</span>
            <span className="shrink-0 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: `subagentDirectory.status.${item.status}` })}
            </span>
          </span>
          {item.summary ? (
            <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
              {item.summary}
            </span>
          ) : null}
        </span>
        {timestamp ? (
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {formatTaskRelativeTime(timestamp, intl)}
          </span>
        ) : null}
      </button>
      {cancelWorkId !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, cancelWorkId)}
          aria-label={intl.formatMessage({
            id: "chat.summaryPanel.stopRunningBackgroundTask",
          })}
          onClick={handleCancel}
          className="mt-0.5 h-6 shrink-0 px-1.5 text-ui-base text-[var(--color-foreground)]"
        >
          <SquareIcon aria-hidden className="size-3 fill-current" />
          {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
        </Button>
      ) : null}
    </div>
  );
});

export const SubagentDirectorySidePane = memo(function SubagentDirectorySidePane({
  tab,
  onOpenSubagentSession,
  canCancelBackgroundWork,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  /**
   * 目录行「停止」的能力门。由渲染上游（AnimatedSidePanePanel ← WorkspaceShellLayout）
   * 按父 pane 的只读态透传：只读 workspace 不下发，运行中行不渲染停止按钮（与
   * SessionPane.tsx:1625 `readOnly ? undefined : handleCancelBackgroundWork` 同语义，
   * 对应 spec ③/A3）。
   *
   * 取消命令本身由本 pane 自己的 V4PaneConversationProvider 连接发出（目标
   * tab.parentSessionId）——壳层没有 v4 传输面，无法像主 pane 那样就地 dispatch。
   */
  canCancelBackgroundWork?: boolean;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <SubagentDirectoryContents
        tab={tab}
        onOpenSubagentSession={onOpenSubagentSession}
        canCancelBackgroundWork={canCancelBackgroundWork}
      />
    </V4PaneConversationProvider>
  );
});

const SubagentDirectoryContents = memo(function SubagentDirectoryContents({
  tab,
  onOpenSubagentSession,
  canCancelBackgroundWork,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  /** 见 SubagentDirectorySidePane 的同名 prop：父 pane 只读时不渲染停止按钮。 */
  canCancelBackgroundWork?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  const subagents = projection.snapshot?.subagents;
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const directory = useSessionSubagents({
    enabled: projection.snapshot !== null,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: tab.parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const running = subagents?.running ?? EMPTY_RUNNING;
  const endedTotal = subagents?.endedTotal ?? 0;
  const handleOpen = (item: DirectoryItem) => {
    onOpenSubagentSession(buildSubagentDirectoryOpenRequest(tab, item));
  };
  // 与主 pane 的 SessionPane.handleCancelBackgroundWork 是同一条 v4 命令；区别只在
  // 目标会话——目录页自己没有 sessionId，停的是 tab.parentSessionId 下的后台工作。
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      const envelope = createCommandEnvelope({
        type: "cancelBackgroundWork",
        sessionId: tab.parentSessionId,
        payload: { workId },
      });
      void sendCommand(envelope).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-subagent-directory] cancelBackgroundWork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [sendCommand, tab.parentSessionId],
  );
  // 只读 / 未放行时不下发 handler，DirectoryRow 据此不渲染停止按钮。
  const onCancelBackgroundWork = canCancelBackgroundWork ? handleCancelBackgroundWork : undefined;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "subagentDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <section>
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.running" })} · {running.length}
          </h3>
          {running.length > 0 ? (
            running.map((item) => (
              <DirectoryRow
                key={item.childSessionId}
                item={item}
                onOpen={handleOpen}
                onCancelBackgroundWork={onCancelBackgroundWork}
              />
            ))
          ) : (
            <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "subagentDirectory.runningEmpty" })}
            </p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.ended" })} · {endedTotal}
          </h3>
          {directory.ended.items.map((item) => (
            <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
          ))}
          {directory.ended.nextCursor ? (
            <div className="px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directory.loading}
                onClick={() => void directory.loadMore()}
              >
                {intl.formatMessage({ id: "subagentDirectory.showMore" })}
              </Button>
            </div>
          ) : null}
        </section>

        {directory.error ? (
          <p role="alert" className="mx-3 mt-4 text-ui-sm text-[var(--color-danger)]">
            {intl.formatMessage({ id: "subagentDirectory.loadFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
