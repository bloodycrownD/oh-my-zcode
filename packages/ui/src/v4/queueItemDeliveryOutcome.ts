import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

/**
 * `setQueueItemDelivery` 的「已降级为排队」判定（spec edit-resend-stale-text /
 * cr-func P2-2；纯函数，不依赖 React，便于单测与源码外直证）。
 *
 * 背景：held 项切 guide 时 core 要靠 `session_input` 账本才能物化出内联项。账本能力
 * 缺席 / 读失败 / 非 pending / 附件非空时一律 fail-closed——车道照样改写、事件照样发，
 * 但该项**从未进入内联车道**，只能等当前轮结束后当普通排队项消费。过去 ACK 只有
 * accepted，用户看到「已切引导」，本轮却永远不会内联它：一处静默成功。
 *
 * 判定只认 ACK 里的显式事实：
 * - 非 accepted/duplicate：没有投递事实（拒绝/失败另有出口）；
 * - 结果类型不是 `setQueueItemDelivery`：旧 CLI 不回结果，读成「未知」= 不提示；
 * - `inlined:true`：已内联，无降级；
 * - `inlined:false` 但没有 `degradedReason`：请求的是 queue（车道回到排队），
 *   `inlined` 本就该是 false——不许把它当降级，否则每次「恢复排队」都弹一条无意义提示。
 *
 * 返回 `null` = 不需要提示；返回字符串 = 降级原因（当前只用于日志/提示文案分流，
 * 不做任何行为分支）。
 */
export function resolveQueueItemDeliveryDegradedReason(ack: CommandAck | null): string | null {
  if (!ack) return null;
  if (ack.status !== "accepted" && ack.status !== "duplicate") return null;
  const result = ack.result;
  if (!result || result.type !== "setQueueItemDelivery") return null;
  if (result.inlined) return null;
  return result.degradedReason ?? null;
}
