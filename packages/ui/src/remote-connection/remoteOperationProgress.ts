// 照搬上游 v3.16.2 remote-connection/RemoteConnectionConnectingStep 的进度投影段
// （upstream-v316-fullsync P7 末批）：omz ConnectingStep 为向导壳批前的裁剪版，本批侧栏
// 详情只需要「阶段+进度」投影，故独立成文件；向导壳批（拍板 A 挂账）回补完整 ConnectingStep
// 时可将本文件并回或转为 re-export。

/** 连接向导与侧栏详情共用的用户阶段；原始 phase 的归并规则只在这里维护一份。 */
export const REMOTE_CONNECTION_PHASES = [
  ["channel", "remote.phase.channel"],
  ["identify", "remote.phase.identify"],
  ["deploy", "remote.phase.deploy"],
  ["handshake", "remote.phase.handshake"],
] as const;

export function normalizeRemoteConnectionPhase(rawPhase: string): string | null {
  if (rawPhase === "probe") return "channel";
  if (rawPhase === "directory-record") return "identify";
  if (rawPhase === "publish-online") return "handshake";
  if (rawPhase === "daemon" || rawPhase === "protocol-handshake" || rawPhase === "restart")
    return "handshake";
  if (
    rawPhase === "download" ||
    rawPhase === "preflight" ||
    rawPhase === "upload" ||
    rawPhase === "extract" ||
    rawPhase === "verify-archive" ||
    rawPhase === "verify" ||
    rawPhase === "install"
  ) {
    return "deploy";
  }
  if (rawPhase === "channel") return "channel";
  return REMOTE_CONNECTION_PHASES.some(([key]) => key === rawPhase) ? rawPhase : null;
}

export interface RemoteOperationProgress {
  index: number;
  total: number;
  titleId: string;
  /** 仅最新一条是上传/下载进度时存在，0-100 整数。 */
  percent?: number;
  /** 本次操作首条日志时间；Host 每次新操作都会替换旧日志。 */
  startedAt?: number;
}

/** 侧栏详情只投影阶段与进度，不展示原始日志文本。 */
export function resolveRemoteOperationProgress(
  allLogs: ReadonlyArray<
    Pick<
      import("@zcode/shared").SourceServerOperationLog,
      "phase" | "progress" | "timestamp" | "level"
    >
  >,
): RemoteOperationProgress {
  // 修复原因：Host 保留的是“最近一次操作”而非“进行中的操作”；断线后首次重试前、两次重试之间
  // 读到的是已结束的上一次操作，曾显示“第 4/4 步 · 已用 120 分”。终态（ready / error）
  // 说明该操作已结束，按尚无日志展示，等下一次尝试由 Host 替换日志。
  const tail = allLogs.at(-1);
  const logs = tail && (tail.phase === "ready" || tail.level === "error") ? [] : allLogs;
  let index = 0;
  for (const log of logs) {
    const key = normalizeRemoteConnectionPhase(log.phase);
    const found = REMOTE_CONNECTION_PHASES.findIndex(([phase]) => phase === key);
    if (found > index) index = found;
  }
  const latest = logs.at(-1);
  const transfer =
    latest?.progress !== undefined && (latest.phase === "upload" || latest.phase === "download");
  return {
    index,
    total: REMOTE_CONNECTION_PHASES.length,
    titleId: REMOTE_CONNECTION_PHASES[index]![1],
    ...(transfer ? { percent: Math.floor(latest.progress! * 100) } : {}),
    ...(logs[0] ? { startedAt: logs[0].timestamp } : {}),
  };
}
