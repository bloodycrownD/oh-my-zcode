// 账本 payload 的编解码 + 「附件事实」的唯一读法 + 编辑期的 payload 补丁。
//
// 为什么这些必须留在同一个文件里：payload 有两个写者（admission 的
// `saveSessionInput` 与 `TurnSteerQueued` 的账本 upsert），而写入是**整 payload 覆盖**
// 而不是 merge——所以「附件事实只在 `conversationInputIntent.attachments`」这条判据
// 和「怎么读它」不能拆到两个文件各自维护一份。拆散后最典型的回归是：写侧按
// `conversationInputIntent.attachments` 落库，读侧却回头读顶层 `payload.attachments`
// （那一处会被第二次写入静默丢掉）。
import type {
  SessionInputDelivery,
  SessionInputExecutionAuthority,
  TurnInputIntentMetadata,
} from "@zcode/contracts";

type SessionInputPayload = { text: string; [key: string]: unknown };

/**
 * 账本 payload 的严格解析结果。
 *
 * 为什么必须区分「解析失败」与「合法空文本」：`text: ""` 是合法输入（只有附件的
 * query），而「JSON 读不出来」意味着**不知道用户写了什么**。过去两者都返回
 * `{ text: "" }`，执行侧把账本当唯一权威之后，损坏行会让空文本起轮并移除队列项
 * ——用户内容静默丢失且不触发任何 fault（cr-func F4）。
 */
type SessionInputPayloadParse =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly reason: "payload_unparsable" | "payload_not_object" };

export function parsePayload(raw: string): SessionInputPayloadParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "payload_unparsable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "payload_not_object" };
  }
  return { ok: true, payload: parsed as Record<string, unknown> };
}

/**
 * 宽松解码：**只给展示 / hydration 面用**（`decodeSessionInputRow` 的 list/get、
 * `updateSessionInputs` 的读-改-写）。
 *
 * 这些消费者拿不到权威判定权：命令事实查询、恢复清扫、队列编辑读回都只需要
 * 「能展示的近似文本」，这里坏行退化成空串不会让任何东西被执行。执行侧**不得**
 * 调用本函数——唯一入口是 `readSessionInputForExecution`，它把解析失败上报成
 * `corrupt` 让 handler 硬失败（见 `session-input-authority.ts`）。
 */
export function decodePayload(raw: string): SessionInputPayload {
  const parsed = parsePayload(raw);
  if (!parsed.ok) return { text: "" };
  return {
    ...parsed.payload,
    text: typeof parsed.payload.text === "string" ? parsed.payload.text : "",
  };
}

/** 附件事实的类型只从契约派生：契约改了这里自动跟着改，不维护第二份镜像。 */
type LedgerAttachments = Extract<
  SessionInputExecutionAuthority,
  { state: "pending" }
>["attachments"];

function isAttachmentRef(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ref === "string" &&
    typeof candidate.fileName === "string" &&
    typeof candidate.mime === "string" &&
    typeof candidate.bytes === "number"
  );
}

/**
 * 账本里的附件事实：`payload.conversationInputIntent.attachments`。
 *
 * 为什么是这一处而不是 `payload.attachments`：`TurnSteerQueued` 的账本 upsert 会用
 * `buildPersistedConversationInputIntent` 重写整个 payload，只带上
 * `text / intent / conversationInputIntent` 三个键——admission 时写的顶层
 * `payload.attachments` 会被丢掉，而 `conversationInputIntent.attachments`
 * （= `intent.attachmentRefs ?? []`）在两个写入点都存在。所以这一处才是账本里
 * 唯一"两个写者都覆盖"的附件事实。
 *
 * 返回 `undefined` = 读不出附件事实（真损坏）。调用方必须按损坏处理：
 * 把「字段在、但读不出」当成 `[]` 会静默丢掉用户附件，与 F4 的空串兜底同一类事故。
 *
 * **唯一的例外是「intent 事实整体缺失」的 legacy 形状**（cr-func P1-3）：
 * `TurnSteerQueued` 在没有 intent 时只写 `{ text }`（`events.ts`），而 intent 至今
 * 仍可能缺失（legacy `session/send` 只在 `params.modelSelection` 存在时才建 intent）。
 * 这类行的账本与投影**都没有**附件事实（投影的 `QueueItem.attachments` 也只从
 * `intent.attachmentRefs` 来，见 `product-projection.ts`），所以 `[]` 不是猜测而是
 * 唯一可读的答案；把它判成损坏会让这一项永久不可提升、auto-drain 停在这一项上，
 * 用户只能删项重发（P1-3 的失效形态）。
 *
 * 判据写死为「`intent` 与 `conversationInputIntent` **同时**缺失」：
 * - 两者都在（新写者）→ 正常读 `conversationInputIntent.attachments`；
 * - 只有 `conversationInputIntent` 缺失但 `intent` 在 → 事实在、读不出 = 损坏；
 * - `conversationInputIntent` 在但 `attachments` 不是数组 / 有坏项 → 损坏。
 * 这个区分是**可判定的**（已知历史形状 vs 字段损坏），不是「读失败就宽松」。
 */
export function readLedgerAttachments(
  payload: Record<string, unknown>,
): LedgerAttachments | undefined {
  const intent = payload.conversationInputIntent;
  if (intent === undefined && payload.intent === undefined) {
    // legacy 形状：`{ text }`（无 intent 事实）。账本没有、也无从记录附件。
    return [];
  }
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const attachments = (intent as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return undefined;
  // 逐项严格校验：过滤掉坏项等于静默丢附件，同样是内容丢失。
  return attachments.every(isAttachmentRef) ? (attachments as LedgerAttachments) : undefined;
}

export interface SessionInputPatch {
  delivery?: SessionInputDelivery;
  id: string;
  intent?: TurnInputIntentMetadata;
  text?: string;
  queuePosition?: number;
}

export function patchObject(value: unknown, patch: SessionInputPatch): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const current = value as Record<string, unknown>;
  const order = current.order;
  const intent = patch.intent;
  return {
    ...current,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.queuePosition !== undefined || intent?.queuePosition !== undefined
      ? {
          order:
            order && typeof order === "object" && !Array.isArray(order)
              ? {
                  ...(order as Record<string, unknown>),
                  queuePosition: patch.queuePosition ?? intent?.queuePosition,
                }
              : { queuePosition: patch.queuePosition ?? intent?.queuePosition },
        }
      : {}),
    ...(intent
      ? {
          delivery: {
            requested: intent.requestedDelivery,
            admitted: intent.admittedDelivery,
            ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
          },
          steer: intent.fallbackReasonCode
            ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
            : current.steer,
        }
      : {}),
  };
}
