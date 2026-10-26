// sendQueuedNow 的执行权威读法（I1）+ 它专用的三种硬失败。
//
// 为什么单独成文件：这一段是「执行内容只能来自 `session_input` 账本」的**唯一读入口**，
// 与 queue 的其余命令（delete/edit/reorder/toggle）没有共享状态。`queue.ts` 里的提升主线
// （reserve → lease → stop → start/promote → remove，含 auto-drain 的恢复语义）与这段判据
// 分开后，改提升流程不会顺手改到权威读法，反之亦然。
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

/**
 * 硬失败的运营出口（spec 风险节「运营出口」）。
 *
 * 账本侧的这条输入已不可执行（终态 / 缺行 / 损坏），投影里残留的队列项是幽灵：
 * 自动放行在 `v4-bridge` 的 auto-drain catch 里已被暂停，手动「立即发送」对同一 id
 * 永远 rejected，用户不删掉它就再也发不出去。唯一可做的动作是删除该项后重发——
 * ACK 的 `message` 会被 UI 直接 toast（`SessionPane` 的 sendQueuedNow 拒绝分支），
 * 所以文案必须写清动作，不能只说账本状态（cr-func F2）。
 */
const LEDGER_DEAD_ITEM_RECOVERY =
  "该队列项已没有可执行的账本输入，无法发送；请删除该队列项后重新发送（删除后若队列仍暂停，重新打开自动放行）";

/**
 * 执行权威不是「未起跑」：账本已是 promoted（已起跑）/ cancelled / discarded / failed。
 *
 * I1（spec edit-resend-stale-text）：执行文本只能来自 `session_input` 账本，账本项终态时
 * **必须硬失败**——回落投影值等于让展示模型当执行权威，正是本条 bug 的根因。
 */
class V4QueueInputNotPendingError extends Error {
  readonly reasonCode = "fault.command.inputNotPending";
  constructor(queueItemId: string, status: string, statusReason?: string) {
    super(
      `v4 sendQueuedNow input is not pending: ${queueItemId} (ledger status ${status}${
        statusReason ? `: ${statusReason}` : ""
      })；${LEDGER_DEAD_ITEM_RECOVERY}`,
    );
    this.name = "V4QueueInputNotPendingError";
  }
}

/**
 * 账本没有这一行（或宿主没有执行权威能力）：投影说项还在、账本说没这条输入。
 * 同样硬失败——执行侧拿不到权威文本时不许退化成投影文本。
 */
class V4QueueInputAuthorityMissingError extends Error {
  readonly reasonCode = "fault.command.inconsistentAuthority";
  constructor(queueItemId: string, detail: string) {
    super(
      `v4 sendQueuedNow execution authority missing: ${queueItemId} (${detail})；${LEDGER_DEAD_ITEM_RECOVERY}`,
    );
    this.name = "V4QueueInputAuthorityMissingError";
  }
}

/**
 * 账本行还在、状态还是 admitted，但 payload 读不出可信内容（非法 JSON / 非对象 /
 * text 不是字符串 / 附件事实缺失）。
 *
 * 这一态是 cr-func F4 的根修：过去 adapters 把解析失败兜底成 `{ text: "" }`，执行侧
 * 于是拿空文本起轮并移除队列项——用户内容静默丢失。现在损坏与「合法空文本」分开：
 * 空文本走正常执行，损坏走本错误（reasonCode 与「账本缺行」同为
 * `fault.command.inconsistentAuthority`：对客户端而言都是"这条输入不可执行"，
 * 差异在 message 与对账日志里）。
 */
class V4QueueInputLedgerCorruptError extends Error {
  readonly reasonCode = "fault.command.inconsistentAuthority";
  constructor(queueItemId: string, reason: string) {
    super(
      `v4 sendQueuedNow execution authority is corrupt: ${queueItemId} (ledger payload ${reason})；${LEDGER_DEAD_ITEM_RECOVERY}`,
    );
    this.name = "V4QueueInputLedgerCorruptError";
  }
}

/**
 * I1 的唯一执行输入来源：按 id 读 `session_input` 账本，取 **文本 + 附件**。
 *
 * 为什么附件也读账本：admission 已把 attachments 写进账本
 * （`v4-bridge.ts` 的 `saveSessionInput`，`payload.attachments` +
 * `payload.conversationInputIntent.attachments`），`TurnSteerQueued` 的幂等 upsert
 * 经 `buildPersistedConversationInputIntent` 保留 `conversationInputIntent.attachments`，
 * 所以读账本不需要任何新增写入。投影项的 `queueItem.attachments` 从此不再是执行输入
 * （cr-func F1：只数 `queueItem.text` 的 I7 只是半个不变量）。
 *
 * 接受条件只有一个：账本 `status=admitted`（未起跑）。其余四态全部硬失败：
 * - `started`（promoted，已起跑）/ `voided`（cancelled / discarded / failed）→
 *   `fault.command.inputNotPending`；
 * - `missing`（账本无此行）→ `fault.command.inconsistentAuthority`；
 * - `corrupt`（payload 读不出可信内容）→ 同为 `fault.command.inconsistentAuthority`，
 *   但独立错误类型与文案——绝不能兜底成空文本起轮（F4）。
 * 宿主未提供该能力同样按 `missing` 硬失败。
 *
 * 硬失败必须可观测：先做一次对账上报（warn 日志带 session/item/终态与原因，不落文本内容），
 * 再抛出带 reasonCode 与「删除该队列项后重发」出口的领域错误——gateway 会把它原样上行成
 * ACK 的 reasonCode/message。
 * **不读、也不回落到投影项的 `queueItem.text` / `queueItem.attachments`**。
 */
export async function resolveExecutionAuthority(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  queueItemId: string,
): Promise<{ attachments: readonly AttachmentRef[]; text: string }> {
  const sessionId = record.app.sessionId;
  const read = host.getSessionInputForExecution;
  if (!read) {
    host.logger?.warn?.("v4 sendQueuedNow execution authority capability absent", {
      queueItemId,
      sessionId,
    });
    throw new V4QueueInputAuthorityMissingError(queueItemId, "host capability absent");
  }
  const authority = await read(sessionId, queueItemId);
  if (authority.state === "pending") {
    return { attachments: authority.attachments, text: authority.text };
  }
  host.logger?.warn?.("v4 sendQueuedNow rejected: ledger authority is not pending", {
    ledgerState: authority.state,
    ...(authority.state === "voided"
      ? {
          ledgerStatus: authority.status,
          ...(authority.statusReason ? { statusReason: authority.statusReason } : {}),
        }
      : {}),
    ...(authority.state === "started"
      ? {
          ledgerStatus: authority.status,
          ...(authority.promotedMessageID
            ? { promotedMessageID: authority.promotedMessageID }
            : {}),
        }
      : {}),
    ...(authority.state === "corrupt" ? { corruptReason: authority.reason } : {}),
    queueItemId,
    sessionId,
  });
  if (authority.state === "corrupt") {
    throw new V4QueueInputLedgerCorruptError(queueItemId, authority.reason);
  }
  if (authority.state === "missing") {
    throw new V4QueueInputAuthorityMissingError(queueItemId, "ledger row missing");
  }
  throw new V4QueueInputNotPendingError(
    queueItemId,
    authority.status,
    authority.state === "voided" ? authority.statusReason : undefined,
  );
}
