import { useCallback, useRef, useState } from "react";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

/**
 * setQueueItemDelivery 的窄签发面（宿主 SessionPane 的 dispatchCommand 满足之）。
 * 用户拍板：guide = 引导至下一轮工具调用后运行（内联当前轮），queue = 普通排队
 * 独立成轮；与「立即」（sendQueuedNow 抢占当前轮）语义区分。
 */
export type QueueItemDeliveryDispatch = (
  type: "setQueueItemDelivery",
  payload: { queueItemId: string; delivery: "queue" | "guide" },
  targetSessionId: string,
  baseRevision: number,
) => Promise<CommandAck>;

export interface UseQueueItemDeliveryToggleOptions {
  sessionId: string | null;
  dispatchCommand: QueueItemDeliveryDispatch;
  /** 取当前投影 revision（CAS baseRevision 来源；读不到返回 null 则放弃本次点击）。 */
  getRevision: () => number | null;
  /** ACK 拒绝/失败时的观测回调（宿主 logger；UI 不额外弹 toast，行态自然回滚）。 */
  onRejected?: (queueItemId: string, status: string, reasonCode: string | undefined) => void;
}

export interface QueueItemDeliveryToggle {
  /** 正在等待 ACK 的 queueItemId；仅锁该 row（同 pendingEditQueueItemId 模式）。 */
  pendingQueueItemId: string | null;
  /** 点击 toggle：queue→guide（引导）/ guide→queue（恢复排队）。 */
  toggleDelivery: (queueItemId: string, delivery: "queue" | "guide") => void;
}

/**
 * 排队项「引导/排队」toggle 的行级 ACK 等待态。一次只允许一个在途命令；
 * revision 经 getRevision 现读（本地投影可能落后，stale 由 CLI CAS 拒绝后
 * 经 onRejected 观测，不做静默重试——队列命令幂等由命令面保证）。
 *
 * toggleDelivery 身份恒定（在途判断走 ref 镜像）：队列面板行是 memo 组件，
 * 回调身份随会话流式渲染抖动会让整列 memo 失效。
 */
export function useQueueItemDeliveryToggle(
  options: UseQueueItemDeliveryToggleOptions,
): QueueItemDeliveryToggle {
  const [pendingQueueItemId, setPendingQueueItemId] = useState<string | null>(null);
  // 只读最新 options / 在途态，避免回调身份随 session/revision/ACK 变化。
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pendingRef = useRef<string | null>(null);

  const toggleDelivery = useCallback((queueItemId: string, delivery: "queue" | "guide") => {
    const current = optionsRef.current;
    if (!current.sessionId || pendingRef.current !== null) {
      // P2-1 观测：静默 return 不再无痕（区分无会话与在途去重，便于排查「点了没反应」）。
      console.debug(
        "[queueItemDeliveryToggle] dropped: %s",
        !current.sessionId ? "no-session" : `in-flight(${pendingRef.current})`,
      );
      return;
    }
    const baseRevision = current.getRevision();
    if (baseRevision === null) {
      console.debug("[queueItemDeliveryToggle] dropped: revision-unavailable");
      return;
    }
    pendingRef.current = queueItemId;
    setPendingQueueItemId(queueItemId);
    // stale 重试：busy 流式期间投影 revision 随流式事件快速前进，点击瞬间读到的
    // baseRevision 到达 CLI 时可能已落后，gateway CAS 以 proto.staleRevision 拒绝。
    // 队列命令幂等（同值由 handler 门吸收），重发安全。重发 revision 取
    // max(本地投影, ack.revisionAtDecision)——本地投影在流式高峰可能滞后于 CLI
    // 权威值（delta 到达延迟），单靠本地重读会连续落后；决策点 revision 是 CLI
    // 拒绝时告知的权威值，优先采用。上限 2 次防循环，仍失败走 onRejected 观测
    // （不静默吞操作）。
    const MAX_STALE_RETRIES = 2;
    const dispatch = (revision: number, retriesLeft: number): Promise<void> =>
      current
        .dispatchCommand(
          "setQueueItemDelivery",
          { queueItemId, delivery },
          current.sessionId!,
          revision,
        )
        .then((ack) => {
          // noop = 同值 toggle / 并发已消费；duplicate = 命令面幂等重放，均非失败。
          if (ack.status === "stale" && retriesLeft > 0) {
            const local = current.getRevision();
            const nextRevision = Math.max(local ?? 0, ack.revisionAtDecision ?? 0);
            if (nextRevision > 0) return dispatch(nextRevision, retriesLeft - 1);
          }
          if (ack.status !== "accepted" && ack.status !== "noop" && ack.status !== "duplicate") {
            current.onRejected?.(queueItemId, ack.status, ack.reasonCode);
          }
        })
        .catch((error: unknown) => {
          current.onRejected?.(queueItemId, "transport-error", String(error));
        });
    void dispatch(baseRevision, MAX_STALE_RETRIES).finally(() => {
      pendingRef.current = null;
      setPendingQueueItemId(null);
    });
  }, []);

  return { pendingQueueItemId, toggleDelivery };
}
