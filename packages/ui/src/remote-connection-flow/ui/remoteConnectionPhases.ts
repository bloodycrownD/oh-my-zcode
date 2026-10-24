// 连接阶段投影的唯一维护点（knip-wire-progress）：向导内的阶段轨与后台最小化进度条都要用，
// 放在 flow 层避免 `RemoteConnectionConnectingStep` ↔ `RemoteConnectionProgress` 互相 import 成环。
// 阶段清单与原始 phase 归并复用 `remoteOperationProgress.ts` 的唯一维护点，本文件只负责
// 「渲染层日志流 → 四态阶段轨」的投影：日志 message 形如 `[source-server:<phase>] ...`。
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import {
  normalizeRemoteConnectionPhase,
  REMOTE_CONNECTION_PHASES,
} from "@/remote-connection/remoteOperationProgress.js";

export type RemoteConnectionPhaseStatus = "pending" | "active" | "complete" | "failed";

interface RemoteConnectionPhase {
  key: string;
  titleId: string;
  status: RemoteConnectionPhaseStatus;
}

export function resolveRemoteConnectionPhases(
  logs: ReadonlyArray<Pick<RemoteConnectionLogEntry, "message" | "level">>,
  options: { connectionReady?: boolean } = {},
): RemoteConnectionPhase[] {
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

/** 已完成阶段数占比；失败阶段不计入完成度，避免失败时显示 100%。 */
export function getRemoteConnectionPhasePercent(
  phases: ReadonlyArray<RemoteConnectionPhase>,
): number {
  if (phases.length === 0) return 0;
  const complete = phases.filter((phase) => phase.status === "complete").length;
  return Math.round((complete / phases.length) * 100);
}

/** 阶段轨当前应高亮的阶段：失败优先，其次进行中；尚无日志时沿用上游取第一阶段。 */
export function getRemoteConnectionActivePhase(
  phases: ReadonlyArray<RemoteConnectionPhase>,
): RemoteConnectionPhase {
  return (
    phases.find((phase) => phase.status === "failed") ??
    phases.find((phase) => phase.status === "active") ??
    phases[0]!
  );
}
