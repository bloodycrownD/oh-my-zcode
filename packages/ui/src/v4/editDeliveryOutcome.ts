import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

/** editUserQuery 的投递三值（与 `command.ts` 结果 schema 的 `delivery` 同源同值）。 */
export type EditDelivery = "startNow" | "queue" | "guide";

/**
 * `onEdit` 的真实返回值形状：`CommandAck` 或 `false`（被拒）或 `void`（旧宿主）。
 * 判据必须容忍这三种，否则调用方会为「旧宿主没有 ACK」凭空造出一个投递态。
 */
export type EditCommandOutcome = CommandAck | boolean | void | null | undefined;

/**
 * 从 `editUserQuery` 的 ACK 读投递态（spec `edit-resend-stale-text` / I5）。
 *
 * 只认 `accepted` / `duplicate` 的 `editUserQuery` 结果，且**只认显式值**：
 * - 失败 / 被拒：本次没有投递事实；
 * - 旧 CLI（additive 字段缺省）：同样返回 `null`，由调用方按「未知」处理。
 *
 * 两个方向都不许推断：缺字段推断成 `startNow` 正是 I5 要消灭的「假成功」；
 * 推断成 `queue` 则会让新客户端对每个旧 CLI 的编辑都弹一条排队提示。
 */
/** edit/retry 共用的投递三值判定：只认显式值，缺省一律 null（未知）。 */
function explicitDelivery(delivery: unknown): EditDelivery | null {
  return delivery === "startNow" || delivery === "queue" || delivery === "guide" ? delivery : null;
}

export function resolveEditDelivery(outcome: EditCommandOutcome): EditDelivery | null {
  if (typeof outcome !== "object" || outcome === null) return null;
  const ack = outcome;
  if (ack.status !== "accepted" && ack.status !== "duplicate") return null;
  const result = ack.result;
  if (!result || result.type !== "editUserQuery") return null;
  return explicitDelivery(result.delivery);
}

/**
 * 从 `retryTurn` 的 ACK 读投递态（cr-func P1-5）。
 *
 * retry 与 edit 是同一条 `rewind → start` 事务，`queue` 同样是「没起跑」——
 * 过去 retryTurn 不返回任何结果，客户端只能把 queued 当成功。判定规则与
 * `resolveEditDelivery` 逐字相同，只是结果分支不同。
 */
export function resolveRetryDelivery(outcome: EditCommandOutcome): EditDelivery | null {
  if (typeof outcome !== "object" || outcome === null) return null;
  const ack = outcome;
  if (ack.status !== "accepted" && ack.status !== "duplicate") return null;
  const result = ack.result;
  if (!result || result.type !== "retryTurn") return null;
  return explicitDelivery(result.delivery);
}

/**
 * 编辑返回后是否收敛行内编辑态（关闭编辑器）。
 *
 * I5：「UI 不得在 queued 时表现为成功」。`queue` 意味着这一轮**还没起跑**，编辑器必须
 * 留着，否则用户看到行内编辑器消失、以为已经发送，实际输入排在队列里等下一轮。
 * `guide`（已内联进当前轮、模型已看到）与 `startNow`（已起轮）按成功收敛；
 * `null`（无投递事实，含旧 CLI）沿用收敛，保持旧行为。
 */
export function shouldCollapseEditState(outcome: EditCommandOutcome): boolean {
  return resolveEditDelivery(outcome) !== "queue";
}
