import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";

interface DelayPlan {
  commandMs: number;
  ackMs: number;
  consumed?: boolean;
  ackReleased?: boolean;
}
/** 仅 E2E build 的公开传输 seam 故障注入；只延迟真实命令/ACK，不伪造事件。 */
export async function sendWithConversationDelayE2E(
  // 修复原因：合并后 CommandEnvelope 不再携带上游的 ttft（TTFT 遥测上下文，fork 已移除），
  // 这里保留调用方已传入的信封参数但不再按遥测字段筛选命令，延迟对所有真实命令生效。
  _envelope: CommandEnvelope,
  send: () => Promise<CommandAck>,
): Promise<CommandAck> {
  const host =
    typeof window === "undefined"
      ? undefined
      : (window as Window & { __zcodeTransportDelayE2E?: DelayPlan });
  const plan = shouldExposeE2EStoreBridge() ? host?.__zcodeTransportDelayE2E : undefined;
  if (!plan || plan.consumed) return send();
  plan.consumed = true;
  const delay = (ms: number) =>
    new Promise<void>((resolve) =>
      setTimeout(resolve, Number.isFinite(ms) ? Math.min(10000, Math.max(0, ms)) : 0),
    );
  await delay(plan.commandMs);
  const ack = await send();
  await delay(plan.ackMs);
  plan.ackReleased = true;
  return ack;
}
