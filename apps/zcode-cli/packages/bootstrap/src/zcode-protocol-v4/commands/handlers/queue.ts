// queue 命令组：deleteQueueItem / editQueueItem / reorderQueueItem / setAutoDrain /
// setFollowupMode / setQueueItemDelivery / sendQueuedNow（原生重做，组文件样板见 session-flow.ts）。
// 决策逻辑直驱 core（app 层 queue API，批1 已搬运）；queueItemId ≡ core 的
// pendingInputId（同一 id 空间，无需翻译）。queue 变更的事件由 core runtime 自发，
// 经 gateway ingest 推进 v4 投影——本组不需要 legacy 广播钩子。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
  QueueItem,
} from "@zcode/shared/zcode-protocol-v4";
import type { TurnInputIntentMetadata } from "@zcode/contracts";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromQueueItem } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  applyGoalCommand,
  parseGoalObjectiveFromCommandText,
  V4GoalRejectedError,
} from "./goal.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { commandExecutionContextOf } from "../executor.js";
export { V4SessionIdleTimeoutError } from "./session-flow.js";

/** sendQueuedNow 在投影里查不到该项原文（已被 drain/删除或 id 无效）→ 拒绝。 */
class V4QueueItemTextUnavailableError extends Error {
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item text unavailable: ${queueItemId}`);
    this.name = "V4QueueItemTextUnavailableError";
  }
}

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
      `v4 sendQueuedNow input is not pending: ${queueItemId} (ledger status ${status}${statusReason ? `: ${statusReason}` : ""})`,
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
    super(`v4 sendQueuedNow execution authority missing: ${queueItemId} (${detail})`);
    this.name = "V4QueueInputAuthorityMissingError";
  }
}

class V4QueueItemReservedError extends Error {
  readonly reasonCode = "guard.queueItemReserved";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item already reserved: ${queueItemId}`);
    this.name = "V4QueueItemReservedError";
  }
}

class V4QueuePromotionCommitError extends Error {
  readonly reasonCode = "fault.command.queuePromotionCommitFailed";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow started but failed to remove queue item: ${queueItemId}`);
    this.name = "V4QueuePromotionCommitError";
  }
}

class V4QueueItemNotEditableError extends Error {
  readonly reasonCode = "guard.queueItemNotEditable";
  constructor(queueItemId: string) {
    super(`v4 queue item is not editable: ${queueItemId}`);
    this.name = "V4QueueItemNotEditableError";
  }
}

/** setQueueItemDelivery 在投影里查不到该项（已被 drain/删除或 id 无效）→ 拒绝。 */
class V4QueueItemDeliveryMissingError extends Error {
  readonly reasonCode = "guard.queueItemDeliveryMissing";
  constructor(queueItemId: string) {
    super(`v4 setQueueItemDelivery queue item missing: ${queueItemId}`);
    this.name = "V4QueueItemDeliveryMissingError";
  }
}

/** reserved/promoting 中的项归 sendQueuedNow promotion 主线所有，禁止切投递车道。 */
class V4QueueItemDeliveryLockedError extends Error {
  readonly reasonCode = "guard.queueItemDeliveryLocked";
  constructor(queueItemId: string) {
    super(`v4 setQueueItemDelivery queue item is locked by promotion: ${queueItemId}`);
    this.name = "V4QueueItemDeliveryLockedError";
  }
}

/**
 * core setPendingInputDelivery 返回 false（并发 drain/reserve 竞态：项在门检查后、
 * core 改写前被消费）。改为显式 rejected 而非静默 accepted——操作丢失必须可观测
 * （cr-fix-spec P0-2：本次多轮 e2e 排查的放大器正是「ack accepted 但零效果无痕迹」）。
 */
class V4QueueItemDeliveryCoreMissError extends Error {
  readonly reasonCode = "guard.queueItemDeliveryCoreMiss";
  constructor(queueItemId: string) {
    super(`v4 setQueueItemDelivery core missed concurrent drain/reserve: ${queueItemId}`);
    this.name = "V4QueueItemDeliveryCoreMissError";
  }
}

export class V4QueuePromotionLeaseUnavailableError extends Error {
  readonly reasonCode = "guard.queuePromotionBusy";
  constructor(activeLeaseId?: string) {
    super(
      activeLeaseId
        ? `v4 queue promotion is owned by another lease: ${activeLeaseId}`
        : "v4 queue promotion requires an idle Core runtime",
    );
    this.name = "V4QueuePromotionLeaseUnavailableError";
  }
}

async function deleteQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["deleteQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  // 未命中（并发 drain/重复删除的竞态）= noop，不算失败；留 warn 供观测。
  const removed = await record.app.removeQueueItem(payload.queueItemId);
  if (!removed) {
    host.logger?.warn?.("v4 deleteQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    // 未命中曾返回 undefined，gateway 会把并发 drain/重复删除误报为 accepted；
    // queue 撤回编辑因此可能把已消费的旧投影再次恢复到 composer。
    throw new V4CommandNoopError("queue.itemMissing");
  }
  return undefined;
}

async function editQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  // core reducer 同 id 原地更新（保位）；未命中 = noop + warn（同 delete 的竞态语义）。
  const edited = await record.app.editQueueItem(payload.queueItemId, payload.newText);
  if (!edited) {
    host.logger?.warn?.("v4 editQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function reorderQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  // beforeQueueItemId = null → 移到队尾（协议与 app API 同形，直传）。
  const moved = await record.app.reorderQueueItem(payload.queueItemId, payload.beforeQueueItemId);
  if (!moved) {
    host.logger?.warn?.("v4 reorderQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function setAutoDrain(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setQueueAutoDrain(payload.autoDrain);
  if (payload.autoDrain) {
    // 不能只翻授权位：idle 暂停队列没有 active turn 可替它启动队首。复用 CLI
    // 权威 ready hook，busy 时只武装，idle 时立即按 sendQueuedNow 原子路径提升。
    await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
  }
  return undefined;
}

async function setFollowupMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setFollowupMode(payload.mode);
  return undefined;
}

/**
 * setQueueItemDelivery：用户拍板 toggle——排队项在 queue ↔ guide 间切换投递车道。
 * guide = 引导至下一轮工具调用后运行（内联当前轮）；queue = 回普通排队独立成轮。
 * 与「立即」（sendQueuedNow 抢占当前轮）语义区分，不抢占、不新造调度优先级。
 *
 * 门（按序）：投影命中 → dispatch.state === "queued" → 同值 noop → core 改写。
 * reserved/promoting 中的项归 sendQueuedNow promotion 主线所有（core
 * pendingInputReservations 同设第二道门），切换会造成所有权竞态。
 */
async function setQueueItemDelivery(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setQueueItemDelivery"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  if (queueItem === null) {
    throw new V4QueueItemDeliveryMissingError(payload.queueItemId);
  }
  if (queueItem.dispatch.state !== "queued") {
    throw new V4QueueItemDeliveryLockedError(payload.queueItemId);
  }
  // 同值 toggle = noop：幂等返回（客户端重放/重复点击），不驱动 core。
  if (queueItem.delivery.admitted === payload.delivery) return undefined;
  // turn 间隙（无前台执行、无外层 abort）时切 guide 会永久滞留：core 的物化
  // 要求 activeTurn 存在（steering.ts held 回落），autoDrain 又只消费 queue
  // 车道头项（guide 项已从 queue.items 分流），两个消费侧都看不见它——用户
  // 观察为「第一轮引导无效，下一轮才出现」。引导语义（当前轮后的下一个边界
  // 执行）在空闲态的自然延伸就是「立即执行」：转交 sendQueuedNow promotion，
  // 复用其 idle-only 原子闸门、模型活值与提升链，不另造第三条调度路径。
  if (
    payload.delivery === "guide" &&
    record.app.runtime.getActiveForegroundExecutionId() === undefined &&
    !record.activeAbortController
  ) {
    return sendQueuedNow(host, {
      ...envelope,
      payload: { queueItemId: payload.queueItemId },
    });
  }
  const changed = await record.app.setQueueItemDelivery(payload.queueItemId, payload.delivery, {
    traceContext: record.traceContext,
  });
  if (!changed) {
    // 并发 drain/reserve 竞态：项已不在可切换集合。显式拒绝（ack rejected）让 UI
    // onRejected 可观测——静默 accepted 会让操作丢失无痕迹（cr-fix-spec P0-2）。
    host.logger?.warn?.("v4 setQueueItemDelivery missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    throw new V4QueueItemDeliveryCoreMissError(payload.queueItemId);
  }
  return undefined;
}

/**
 * 提升轮的模型活值覆盖（bugfix-batch-20261011 Step 5 / spec 缺陷② b 刀；
 * 规则简化 2026-10-11 用户裁定：「出队模型」——提升一律用会话当前活值）。
 *
 * 规则：queue item 被提升的那一刻，`intent.modelSelection` 一律取
 * `getSessionModelSelection()` 会话活值（即用户最后一次选择的模型），
 * 不再比较 `lastModelSwitchAt` 与 `item.admittedAt`——无论切换发生在
 * 入队之前还是之后，出队即用当前会话模型（入队后没切时活值==快照，无行为差）。
 *
 * 边界（回归红线，勿放宽）：
 * - 会话无活值（getSessionModelSelection 为空）→ 维持 item 快照兜底。
 * - 只覆盖 `intent.modelSelection`，**不置 pin、不写回会话态**：会话态只有
 *   switchModelConfig / 首发原子链两条既有写入口，promote 不允许出现第三条
 *   模型写路径（v1.0.4「queue 提升不写回会话选择」语义原样保持）。
 * - 编辑重发（fork-edit-retry）按同语义在此刀对齐（startCanonicalIntent 活值优先）；
 *   execution-scope 轮在 core 侧豁免切模（runtime/methods/turn-model.ts），此处不干预。
 * - auto-drain（v4-bridge 的 sendQueuedNow 内部触发）走同一 handler，天然同规则。
 * - `lastModelSwitchAt` 字段保留（T-ML1 时间戳语义/诊断面），但提升判据不再消费它。
 */
function applyPromotedModelSelection(
  runtime: V4SessionRecordView["app"]["runtime"],
  _item: QueueItem,
  intent: TurnInputIntentMetadata,
): TurnInputIntentMetadata {
  const liveSelection = runtime.getSessionModelSelection();
  if (!liveSelection) return intent;
  return {
    ...intent,
    modelSelection: liveSelection,
    // 显式标注「非 pin」：活值来自会话态而非本轮提交，写回门（turn-model.ts）据此拒绝。
    modelSelectionPinned: false,
  };
}

/**
 * I1 的唯一执行文本来源：按 id 读 `session_input` 账本。
 *
 * 接受条件只有一个：账本 `status=admitted`（未起跑）。其余三态全部硬失败：
 * - `started`（promoted，已起跑）/ `voided`（cancelled / discarded / failed）→
 *   `fault.command.inputNotPending`；
 * - `missing`（账本无此行）或宿主未提供该能力 → `fault.command.inconsistentAuthority`。
 *
 * 硬失败必须可观测：先做一次对账上报（warn 日志带 session/item/终态与原因，不落文本内容），
 * 再抛出带 reasonCode 的领域错误——gateway 会把它原样上行成 ACK 的 reasonCode。
 * **不读、也不回落到投影项的 `queueItem.text`**。
 */
async function resolveExecutionText(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  queueItemId: string,
): Promise<string> {
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
  if (authority.state === "pending") return authority.text;
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
    queueItemId,
    sessionId,
  });
  if (authority.state === "missing") {
    throw new V4QueueInputAuthorityMissingError(queueItemId, "ledger row missing");
  }
  throw new V4QueueInputNotPendingError(
    queueItemId,
    authority.status,
    authority.state === "voided" ? authority.statusReason : undefined,
  );
}

/**
 * sendQueuedNow：reserve → Core promotion lease → stop barrier → start/promote → remove。
 * - 必须读取完整 QueueItem；text-only fallback 会丢 sourceCommandId/附件/client/order，禁止使用。
 * - stop 复用 session-flow 的语义：goal-pause barrier（否则 verifier 未收 abort 时
 *   queue 无法 drain）→ abort；只 abort 不 await。
 * - 等 idle 语义：锁由后台 turn 的 finally 释放（见 prompt-turn 文件头 3），
 *   abort 后立刻重发会撞 "A prompt is already running"，必须轮询等锁释放。
 * - start 之前任一步失败都 release reservation，原项原位保留；start 成功后才 remove。
 */
async function sendQueuedNow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
  const record = requireRecord(host, envelope.sessionId);
  const reservationId = envelope.commandId;
  const autoDrainPromotion = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
  const foregroundPromotionLeaseId = `queue-promotion:${reservationId}`;
  const traceOptions = { traceContext: record.traceContext };
  let queueItemReserved = false;
  let startAdmitted = false;
  let leaseReleaseOwnedByBackground = false;
  let foregroundPromotionLeaseAcquired = false;
  try {
    const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
    if (queueItem === null) {
      throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    }
    // I1（RC1 根修）：执行文本从 session_input 账本读，投影项只用于校验存在性。
    // 放在 reserve/lease 之前：终态或缺失时不留下任何 side effect，原项原位保留。
    const executionText = await resolveExecutionText(host, record, queueItem.queueItemId);
    const acquirePromotionLease = (mode: "after-current" | "idle-only"): void => {
      const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
        leaseId: foregroundPromotionLeaseId,
        mode,
        promotedInputId: queueItem.sourceCommandId,
      });
      if (leaseResult.kind !== "acquired") {
        throw new V4QueuePromotionLeaseUnavailableError(
          leaseResult.kind === "conflict" ? leaseResult.leaseId : undefined,
        );
      }
      foregroundPromotionLeaseAcquired = true;
    };
    if (autoDrainPromotion) acquirePromotionLease("idle-only");
    if (!(await record.app.reserveQueueItem(payload.queueItemId, reservationId, traceOptions))) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    queueItemReserved = true;
    const objective =
      queueItem.kind === "sendGoalCommand"
        ? parseGoalObjectiveFromCommandText(queueItem.text)
        : undefined;
    if (queueItem.kind === "sendGoalCommand" && !objective) {
      throw new V4GoalRejectedError("emptyObjective", "Usage: /goal <objective>");
    }
    const attachments = await mapAttachmentRefsToTurnAttachments(record.app, queueItem.attachments);
    if (!autoDrainPromotion) acquirePromotionLease("after-current");
    let preempted = false;
    if (!autoDrainPromotion) {
      preempted = await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendQueuedNow preempts active turn",
        goalPausedMutationReason: "send_queued_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    }
    if (
      !(await record.app.markQueueItemPromoting(payload.queueItemId, reservationId, traceOptions))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    // spec 4b 例外表：goal 分支的 objective 解析与 displayText 仍读投影项（本 spec 不动）；
    // 例外之外**执行内容**只来自账本 `executionText`——见下方普通分支的两处。
    if (queueItem.kind === "sendGoalCommand") {
      const intent = applyPromotedModelSelection(
        record.app.runtime,
        queueItem,
        inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text),
      );
      const goalContinuationWillStart = !(
        intent.planEnabled ??
        record.app.runtime?.getPlanEnabled?.() ??
        record.app.getMode?.() === "plan"
      );
      await applyGoalCommand(host, record, {
        displayText: queueItem.text,
        foregroundPromotionLeaseId,
        inputId: queueItem.sourceCommandId,
        intent,
        objective: objective!,
      });
      leaseReleaseOwnedByBackground = goalContinuationWillStart;
    } else {
      // 变更点 21：落库/执行的 `intent.text` 与 `content` 必须是账本文本，
      // 否则冷恢复会把它带回 edit target（transcript-hydration），旧文本再次可执行。
      const intent = applyPromotedModelSelection(
        record.app.runtime,
        queueItem,
        inputIntentMetadataFromQueueItem(queueItem, executionText),
      );
      const started = await startPromptTurn(host, record, {
        content: executionText,
        inputId: queueItem.sourceCommandId,
        // 手动提升若实际抢占旧执行，同样是 human steer；自动 drain 不产生此标记。
        ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
        intent,
        requireIdle: true,
        toolDisallowlist: queueItem.toolDisallowlist,
        ...(attachments ? { attachments } : {}),
      });
      // 旧 fake app/兼容命令可能不返回 admission receipt；真实 app 已在 Core admission
      // 处完成 started 校验。只有明确 queued/rejected 才能判定 promotion 未启动。
      if (started.admission.kind === "queued" || started.admission.kind === "rejected") {
        throw new V4QueuePromotionLeaseUnavailableError();
      }
    }
    startAdmitted = true;
    const removed = await record.app.removeQueueItem(payload.queueItemId, {
      reason: "promoted",
      reservationId,
      ...traceOptions,
    });
    if (!removed) throw new V4QueuePromotionCommitError(payload.queueItemId);
    // omz 拍板（2026-10-23，bug B）：手动「立即发送」=恢复语义——本条提升后自动放行剩余
    // 队列（与「继续」按钮一致）。自动 drain 提升本身就在 autoDrain=true 下进行，无需重复。
    //
    // `setQueueAutoDrain` 是 ZCodeApp 上 required 的成员（app/types.ts），
    // session-flow / v4-bridge 也都是非可选调用；这里曾写成可选调用（`?.`）只为绕开
    // 旧夹具缺失能力，结果 tripwire 长期红：能力真的缺席时恢复动作会被静默吞掉。
    // 夹具已补桩（model-live / e2e-live-all / queue-item-delivery），恢复语义必须硬调用。
    if (!autoDrainPromotion) {
      await record.app.setQueueAutoDrain(true);
      await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
    }
    return undefined;
  } finally {
    if (foregroundPromotionLeaseAcquired && !leaseReleaseOwnedByBackground) {
      record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    }
    // start 一旦 admitted 就不能 release，否则 remove 异常时另一端会重复执行；此时保持
    // promoting 供显式 resync/故障处理。start 前失败则安全回滚到 queued。
    if (queueItemReserved && !startAdmitted) {
      await record.app.releaseQueueItemReservation(
        payload.queueItemId,
        reservationId,
        traceOptions,
      );
    }
  }
}

export const queueHandlers = {
  deleteQueueItem,
  editQueueItem,
  reorderQueueItem,
  setAutoDrain,
  setFollowupMode,
  setQueueItemDelivery,
  sendQueuedNow,
};
