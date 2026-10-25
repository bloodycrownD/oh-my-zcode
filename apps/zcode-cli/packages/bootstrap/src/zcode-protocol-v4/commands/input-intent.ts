import type { TurnInputIntentMetadata } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared";
import type { AttachmentRef, CommandEnvelope, QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalTurnAttachment } from "../event-normalizer.js";
import { commandAdmissionOf } from "./executor.js";

interface CanonicalCommandIntent {
  kind: "sendText" | "sendGoalCommand";
  text: string;
  modelSelection?: ModelSelection;
  /** 显式携带（非继承快照）的 modelSelection 才允许 runtime 写回会话选择。 */
  modelSelectionPinned?: boolean;
  mode?: SubmissionMode;
  planEnabled?: boolean;
  sourceCommandId?: string;
  clientId?: string;
  queueItemId?: string;
  requestedDelivery?: TurnInputIntentMetadata["requestedDelivery"];
  admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
  fallbackReasonCode?: string;
  attachmentRefs?: readonly AttachmentRef[];
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  provenance?: TurnInputIntentMetadata["provenance"];
}

export function inputIntentMetadata(
  envelope: CommandEnvelope,
  options: {
    text: string;
    requestedDelivery: TurnInputIntentMetadata["requestedDelivery"];
    admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
    fallbackReasonCode?: string;
    attachmentRefs?: readonly AttachmentRef[];
    modelSelection?: ModelSelection;
    /** 仅调用方显式提交了 modelSelection（非 admission 兜底固定）时置真。 */
    modelSelectionPinned?: boolean;
    mode?: SubmissionMode;
    planEnabled?: boolean;
    sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  },
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  return {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind: envelope.type === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
    // live intent 过去只带 kind/来源，projection 只能回退可见 command 文案；
    // goal 的 displayText（如 `/GoAl replace X`）不是 runtime 已解析的 canonical objective。
    text: options.text,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options.modelSelectionPinned !== undefined
      ? { modelSelectionPinned: options.modelSelectionPinned }
      : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: options.requestedDelivery,
    admittedDelivery:
      options.admittedDelivery ??
      (options.requestedDelivery === "guide"
        ? "guide"
        : options.requestedDelivery === "queue"
          ? "queue"
          : "startNow"),
    ...(options.fallbackReasonCode ? { fallbackReasonCode: options.fallbackReasonCode } : {}),
    ...(options.attachmentRefs ? { attachmentRefs: [...options.attachmentRefs] } : {}),
    ...(options.sharedContextRefs ? { sharedContextRefs: [...options.sharedContextRefs] } : {}),
  };
}

/**
 * edit/retry 以新 commandId 重建，但保留原 canonical kind/delivery/cause。
 *
 * 不接收第二个 text 参数：I3 要求 `intent.text` 只能来自 `resolveCanonicalInput`
 * 的返回值（过去这里允许调用方另传一份 text，等于给「intent 用旧文本、content 用新文本」
 * 留了一道后门——Bug C 的形态）。
 */
export function inputIntentMetadataFromCanonical(
  envelope: CommandEnvelope,
  canonical: CanonicalCommandIntent,
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  const originalSourceCommandId =
    canonical.provenance?.sourceCommandId ?? canonical.sourceCommandId;
  return {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || canonical.clientId || "cli",
    kind: canonical.kind,
    text: canonical.text,
    ...(canonical.modelSelection ? { modelSelection: canonical.modelSelection } : {}),
    // 执行侧重建的 intent 在 wire 上恒带 boolean pin（今天就是这个形状：
    // test-edit-retry-model 的 B2/B3/B5 断言 `false` 而非缺键）。`resolveCanonicalInput`
    // 的返回值保持三态——缺键 = 本次没有 pin 事实，admission 依赖它与收敛前逐字一致；
    // 这里只把缺键落实成 `false`，**不是**另立一套 pin 判据（判据仍只有
    // `assembleResolvedCanonicalInput` 那一处）。
    modelSelectionPinned: canonical.modelSelectionPinned ?? false,
    ...(canonical.mode ? { mode: canonical.mode } : {}),
    ...(canonical.planEnabled !== undefined ? { planEnabled: canonical.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: canonical.requestedDelivery ?? "startNow",
    admittedDelivery: canonical.admittedDelivery ?? "startNow",
    ...(canonical.fallbackReasonCode ? { fallbackReasonCode: canonical.fallbackReasonCode } : {}),
    ...(canonical.attachmentRefs ? { attachmentRefs: [...canonical.attachmentRefs] } : {}),
    ...(canonical.sharedContextRefs ? { sharedContextRefs: [...canonical.sharedContextRefs] } : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.queueItemId ? { queueItemId: canonical.queueItemId } : {}),
            ...(canonical.clientId ? { clientId: canonical.clientId } : {}),
          },
        }
      : {}),
  };
}

/**
 * edit/retry 的 canonical 继承源：投影 `ConversationEditTarget["intent"]` 的结构子集。
 * 只登记 `resolveCanonicalInput` 真正会读的字段——新增继承字段必须先在投影事实里存在，
 * 并只在本文件登记，调用方不得另起一套。
 */
export interface CanonicalInputRecord {
  kind: "sendText" | "sendGoalCommand";
  text: string;
  sourceCommandId?: string;
  clientId?: string;
  /** 原轮附件（投影形状：`ref` 可能缺省）；无 ref 表示没有已提交内容，不可重发。 */
  attachments?: readonly CanonicalTurnAttachment[];
  queueItemId?: string;
  requestedDelivery?: TurnInputIntentMetadata["requestedDelivery"];
  admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
  fallbackReasonCode?: string;
  modelSelection?: ModelSelection;
  /**
   * 继承源**刻意不参与** pin 判定（`?: never` = 携带即类型错误）。
   *
   * edit/retry 只有两种模型事实：本次显式的 `selection.explicit` 与会话活值
   * `selection.live`。投影构造方不得携带 `modelSelectionPinned`——`ConversationEditTarget`
   * 的 `intent`（`product-projection.ts` 白名单构造）今天本就没有该字段；一旦有人把它
   * 加进投影白名单，旧的 `record.modelSelectionPinned` 继承分支就会让「无 explicit 的
   * 编辑重发」变成 `pin=true`，触发 `turn-model.ts` 的 setSessionModelSelection +
   * persist + emitModelSelected 三连写回（v1.0.4 红线）。
   */
  modelSelectionPinned?: never;
  mode?: SubmissionMode;
  planEnabled?: boolean;
  provenance?: TurnInputIntentMetadata["provenance"];
}

/**
 * 调用方提供的模型选择**事实**（不是判断）：
 * - `explicit`：本次 command 的 payload 显式携带的选择；
 * - `live`：运行态会话当前活值。
 * 优先级与 pin 规则只在 `resolveCanonicalInput` 内实现，调用方不得自行 `??` 串联。
 */
export interface CanonicalInputSelectionFacts {
  explicit?: ModelSelection;
  live?: ModelSelection;
}

/** 继承自 canonical 的投递事实；缺省键 = 本次未继承，由调用方决定（admission 自行推导）。 */
export interface CanonicalInputDelivery {
  requested?: TurnInputIntentMetadata["requestedDelivery"];
  admitted?: TurnInputIntentMetadata["admittedDelivery"];
  fallbackReasonCode?: string;
}

export interface ResolvedCanonicalInput {
  /** 本次真正要发送的权威文本（I3：text 只有一个来源）。 */
  text: string;
  /** 交给 `inputIntentMetadataFromCanonical` 的继承源；其 `text` 恒等于上方 `text`。 */
  intent: CanonicalCommandIntent;
  /** payload 显式优先、否则继承原轮的附件引用。 */
  attachments: readonly AttachmentRef[];
  /** 继承的投递事实。 */
  delivery: CanonicalInputDelivery;
}

/**
 * I3 的唯一解析入口：一条 command 的 text / intent / attachments / delivery 只在这里产生。
 *
 * 为什么必须唯一：admission（`v4-bridge` 写 `session_input` 账本）与执行
 * （`fork-edit-retry` 起轮）过去各自实现同一套 text/attachments/delivery/provenance 继承
 * 规则，当前结果一致纯属人工对齐、无断言守护——`intent.text` 类缺陷反复回归的结构性原因。
 *
 * `record` 是 edit/retry 的 canonical 继承源，其它命令传 null / undefined；
 * 返回 null 表示这条 command 不产生用户输入。`payload` 必须传 `envelope.payload` 本体：
 * 投递事实只有一个来源，参数分开只是为了让 admission 与执行两侧能用同一份入参调用。
 *
 * ## modelSelection / modelSelectionPinned：edit/retry canonical 输入路径只在这里决定
 *
 * 本条约束的作用范围是 **edit/retry 的 canonical 输入解析路径**——`resolveCanonicalInput`
 * 的 editUserQuery / retryTurn 两个分支，以及唯一调用方 `handlers/fork-edit-retry.ts`。
 * 这条路径过去自己实现了一遍 `explicit ?? live ?? snapshot` 与
 * `modelSelectionPinned: explicit !== undefined`，是「换模型后编辑重发跑旧模型 / 旧快照
 * 被静默写回」的直接成因。
 *
 * 规则（这条路径的唯一实现）：
 * ```
 * modelSelection       = selection?.explicit ?? selection?.live ?? record?.modelSelection
 * modelSelectionPinned = selection?.explicit !== undefined ? true : (缺键，不 pin)
 * ```
 * 调用方只提供事实——`explicit` 来自 payload、`live` 来自 `runtime.getSessionModelSelection()`、
 * 什么都不传就表示「本次没有模型选择事实」（admission 当前就是这样，落库字段与今天逐字一致）。
 * 传 `selection` 的一方不得再在外面写 `explicit ?? live ?? snapshot` 或自己算 pin。
 * 守卫：`scripts/test-input-authority.mjs` 的 I3（执行侧零重复规则）/ I4 / I5。
 *
 * pin **没有继承分支**：继承源（`record`）不携带 pin 事实，`record.modelSelectionPinned`
 * 的类型是 `never`。若把它接回判据，「无 explicit 的编辑重发」会继承 `pin=true` 并触发
 * 写回三连（v1.0.4 红线）；投影构造方也不得把它加进白名单。
 *
 * 为什么 pin 的判断权必须收到这里：`modelSelectionPinned` 是 runtime「写回 + 持久化 +
 * emitModelSelected」三连的唯一开关，这条写回门是 2026-10-09 修过的同类缺陷
 * （bugfix-batch-20261009 变更点 1d：继承快照曾被静默写回，把用户刚切换的模型还原并落库）。
 * 在**这条路径**上漏置/误置 pin，编辑重发就会重演「模型没切到最新」——包括为了「顺手兜底」
 * 而复制上面的优先级链。
 *
 * 尚未收口的站点（守卫里带 allowlist，一步一个，不许扩表）：走另一个 builder
 * `inputIntentMetadata` 的 sendText / sendGoalCommand / createSession / legacy session/send
 * （`session-flow.ts:203`、`goal.ts:75`、`session-mgmt.ts:96`、`server-operations.ts:1985`），
 * queue 提升（`queue.ts:268` 的 `applyPromotedModelSelection`），以及模型装配/展示面
 * （`v4-bridge.ts:1022,1385`、`workspace-model-runtime.ts:146`、`create-app.ts:862`、
 * `automation-port.ts:102`）。收口一个删一条 allowlist 条目。
 */
export function resolveCanonicalInput(
  record: CanonicalInputRecord | null | undefined,
  payload: unknown,
  envelope: CommandEnvelope,
  selection?: CanonicalInputSelectionFacts,
): ResolvedCanonicalInput | null {
  if (envelope.type === "createSession") {
    const firstInput = (payload as { firstInput?: { text: string; attachments?: AttachmentRef[] } })
      .firstInput;
    if (!firstInput) return null;
    return assembleResolvedCanonicalInput({
      kind: "sendText",
      text: firstInput.text,
      attachments: firstInput.attachments ?? [],
      selection,
    });
  }
  if (envelope.type === "createSelectionSideSession") {
    const firstInput = (payload as { firstInput?: { text: string } }).firstInput;
    if (!firstInput) return null;
    return assembleResolvedCanonicalInput({
      kind: "sendText",
      text: firstInput.text,
      attachments: [],
      selection,
    });
  }
  if (envelope.type === "sendText" || envelope.type === "sendGoalCommand") {
    const sendPayload = payload as {
      text: string;
      attachments?: AttachmentRef[];
      context_refs?: TurnInputIntentMetadata["sharedContextRefs"];
    };
    return assembleResolvedCanonicalInput({
      kind: envelope.type,
      text: sendPayload.text,
      attachments: sendPayload.attachments ?? [],
      ...(sendPayload.context_refs ? { sharedContextRefs: sendPayload.context_refs } : {}),
      selection,
    });
  }
  if (envelope.type === "editUserQuery") {
    if (!record) return null;
    // `newText` 在 `commandPayloadSchemas.editUserQuery` 里是必填，且 envelope 已在
    // `parseCommandEnvelope` 按该 schema 校验过——按 schema 形状断言，不设兜底：
    // 过去 `newText ?? record.text` 会把「编辑后仍重发旧文本」重新引回来（见 T-IA4 守卫）。
    // 断言只作用于 edit 分支：retry 的 payload 只有 `target`（见下方分支）。
    const editPayload = payload as { newText: string; attachments?: AttachmentRef[] };
    return assembleResolvedCanonicalInput({
      kind: record.kind,
      text: editPayload.newText,
      // payload 显式给 attachments（含 []）优先；缺省才继承原轮。
      attachments: editPayload.attachments ?? inheritedAttachmentRefs(record.attachments),
      record,
      selection,
    });
  }
  if (envelope.type === "retryTurn") {
    if (!record) return null;
    // retry 重发原轮 canonical 文本（截断后已拿不到可见文本）。payload 只有 `target`，
    // 所以这里**不**按 edit 的形状断言 payload——给 retry 伪造 `newText` 字段会让
    // 「retry 偷读新文本」在类型上合法，正是 `newText ?? record.text` 兜底的温床（守卫 I6）。
    return assembleResolvedCanonicalInput({
      kind: record.kind,
      text: record.text,
      attachments: inheritedAttachmentRefs(record.attachments),
      record,
      selection,
    });
  }
  return null;
}

/** 投影附件 → 可重发引用：无 ref 的附件没有已提交内容，不能重发。 */
function inheritedAttachmentRefs(
  attachments: readonly CanonicalTurnAttachment[] | undefined,
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              // 重试／编辑必须保留与原 row 相同的附件来源：逐字段枚举会丢掉
              // sourceKind，text/plain 附件在再 admission 后失去预览授权依据。
              ...attachment,
              ref: attachment.ref,
            },
          ]
        : [],
    ) ?? []
  );
}

/** 把各分支解析出的字段装配成唯一结果；text/intent/delivery/modelSelection 的相对关系只在这里决定。 */
function assembleResolvedCanonicalInput(seed: {
  kind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  record?: CanonicalInputRecord;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  selection?: CanonicalInputSelectionFacts;
}): ResolvedCanonicalInput {
  const { record, selection } = seed;
  const delivery: CanonicalInputDelivery = {
    ...(record?.requestedDelivery ? { requested: record.requestedDelivery } : {}),
    ...(record?.admittedDelivery ? { admitted: record.admittedDelivery } : {}),
    ...(record?.fallbackReasonCode ? { fallbackReasonCode: record.fallbackReasonCode } : {}),
  };
  // 模型选择：显式 payload > 会话活值 > 继承快照；pin 只认「最后确实来自显式 payload」
  // （规则定义见 `resolveCanonicalInput` 文档，不允许在别处再判一次）。
  //
  // pin 没有继承分支：`record.modelSelectionPinned` 的类型是 `never`，继承源不携带 pin
  // 事实。edit/retry 的模型事实只有 explicit / live 两种——过去的
  // `explicit !== undefined ? true : record.modelSelectionPinned` 后半支今天不可达
  // （投影 `ConversationEditTarget.intent` 无该字段），但一旦有人把它加进投影白名单，
  // 编辑重发就会在无 explicit 时 pin=true，触发 turn-model.ts 的写回三连（v1.0.4 红线）。
  const modelSelection = selection?.explicit ?? selection?.live ?? record?.modelSelection;
  const modelSelectionPinned = selection?.explicit !== undefined ? true : undefined;
  // 原始输入来源：provenance 优先，其次原轮的 sourceCommandId——
  // edit/retry 换了 commandId，但归因必须仍指向真正产生这条输入的原始命令。
  const originalSourceCommandId = record?.provenance?.sourceCommandId ?? record?.sourceCommandId;
  const provenance = originalSourceCommandId
    ? (record?.provenance ?? {
        sourceCommandId: originalSourceCommandId,
        ...(record?.queueItemId ? { queueItemId: record.queueItemId } : {}),
        ...(record?.clientId ? { clientId: record.clientId } : {}),
      })
    : undefined;
  const intent: CanonicalCommandIntent = {
    kind: seed.kind,
    text: seed.text,
    ...(record?.sourceCommandId ? { sourceCommandId: record.sourceCommandId } : {}),
    ...(record?.clientId ? { clientId: record.clientId } : {}),
    ...(record?.queueItemId ? { queueItemId: record.queueItemId } : {}),
    ...(delivery.requested ? { requestedDelivery: delivery.requested } : {}),
    ...(delivery.admitted ? { admittedDelivery: delivery.admitted } : {}),
    ...(delivery.fallbackReasonCode ? { fallbackReasonCode: delivery.fallbackReasonCode } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(modelSelectionPinned !== undefined ? { modelSelectionPinned } : {}),
    ...(record?.mode ? { mode: record.mode } : {}),
    ...(record?.planEnabled !== undefined ? { planEnabled: record.planEnabled } : {}),
    attachmentRefs: seed.attachments,
    ...(seed.sharedContextRefs ? { sharedContextRefs: [...seed.sharedContextRefs] } : {}),
    ...(provenance ? { provenance } : {}),
  };
  return { text: seed.text, intent, attachments: seed.attachments, delivery };
}

/**
 * sendQueuedNow 只能转换原 QueueItem，禁止用 promotion commandId 重建来源。
 *
 * 提升轮的模型活值覆盖（出队模型规则：提升一律用会话活值）不在本函数内
 * 施加：它由 handlers/queue.ts 的 `applyPromotedModelSelection` 在本函数返回值上收口
 * （那里持有 runtime），本函数保持纯转换；pin 判据与写回门的语义以下方注释为准。
 */
export function inputIntentMetadataFromQueueItem(
  item: QueueItem,
  canonicalText: string,
): TurnInputIntentMetadata {
  // 注意：modelSelectionPinned 是 admission 期进程内标志，QueueItem 不持久化它，
  // 本函数刻意不置 pin——queue 提升按非显式处理、不写回会话选择（有意语义，勿当漏字段补）。
  return {
    sourceCommandId: item.sourceCommandId,
    queueItemId: item.queueItemId,
    clientId: item.clientId,
    kind: item.kind,
    text: canonicalText,
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
    ...(item.mode ? { mode: item.mode } : {}),
    ...(item.planEnabled !== undefined ? { planEnabled: item.planEnabled } : {}),
    admissionSeq: item.order.admissionSeq,
    admittedAt: item.admittedAt,
    requestedDelivery: item.delivery.requested,
    admittedDelivery: item.delivery.admitted,
    ...(item.order.queuePosition !== undefined ? { queuePosition: item.order.queuePosition } : {}),
    ...(item.delivery.fallbackReasonCode
      ? { fallbackReasonCode: item.delivery.fallbackReasonCode }
      : {}),
    attachmentRefs: item.attachments,
    ...(item.sharedContextRefs ? { sharedContextRefs: [...item.sharedContextRefs] } : {}),
    // 提升只改变调度状态；重试／编辑原始输入的来源关联不能在此丢失。
    ...(item.provenance ? { provenance: { ...item.provenance } } : {}),
  };
}
