// queue 命令组：deleteQueueItem / editQueueItem / reorderQueueItem / setAutoDrain /
// setFollowupMode / sendQueuedNow（原生重做，组文件样板见 session-flow.ts）。
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
 * 提升轮的模型活值覆盖（bugfix-batch-20261011 Step 5 / spec 缺陷② b 刀）。
 *
 * 判据：runtime 记录「会话模型选择最近一次变值」的墙钟 `getLastModelSwitchAt()`；若它
 * 晚于本项入队时间（`item.admittedAt` = v4 command admission 墙钟，语义即入队时刻），
 * 说明用户在入队之后切过模型——提升轮必须改用当前会话活值，否则排队消息会拿着入队时的
 * 旧快照执行（「切模型后排队消息还用旧模型」的报障根因）。
 *
 * 边界（回归红线，勿放宽）：
 * - 未切换 → 维持 queue item 的旧快照语义，包含旧发送端 admission 兜底固定的快照。
 *   core 侧同值写回不记时间戳（desktop 每条 sendText 都 pin 当前选择），因此「入队后又
 *   提交了几条同模型消息」不会被误判成切换。
 * - 旧投影缺 `admittedAt` → `?? 0` 视为最老：任何真实切换都晚于它，活值胜出。
 * - 只覆盖 `intent.modelSelection`，**不置 pin、不写回会话态**：会话态已由
 *   switchModelConfig 写成新值，promote 不需要也不允许出现第二条模型写路径
 *   （v1.0.4「编辑重发/queue 提升不写回会话选择」语义原样保持）。
 * - 编辑重发（fork-edit-retry / goal / session-mgmt）不经本函数，旧快照执行语义不动；
 *   execution-scope 轮在 core 侧豁免切模（runtime/methods/turn-model.ts），此处不干预。
 * - auto-drain（v4-bridge 的 sendQueuedNow 内部触发）走同一 handler，天然同规则。
 */
function applyPromotedModelSelection(
  runtime: V4SessionRecordView["app"]["runtime"],
  item: QueueItem,
  intent: TurnInputIntentMetadata,
): TurnInputIntentMetadata {
  const lastModelSwitchAt = runtime.getLastModelSwitchAt?.() ?? 0;
  if (!(lastModelSwitchAt > (item.admittedAt ?? 0))) return intent;
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
      const intent = applyPromotedModelSelection(
        record.app.runtime,
        queueItem,
        inputIntentMetadataFromQueueItem(queueItem, queueItem.text),
      );
      const started = await startPromptTurn(host, record, {
        content: queueItem.text,
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
  sendQueuedNow,
};
