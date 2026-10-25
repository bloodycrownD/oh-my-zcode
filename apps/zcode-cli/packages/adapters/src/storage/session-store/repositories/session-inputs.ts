// session_input 账本仓库。
// 语义：admitted（已接受）→ promoted（与 user message/parts 同事务落 transcript）
// / cancelled / discarded / failed。promotion 的原子性是硬要求：杜绝
// 「queue 已消费但 transcript 无 user message」的孤儿窗口（旧 drain 跨 store 无事务）。
import type { DatabaseSync } from "node:sqlite";
import type {
  MessageId,
  MessageInfo,
  MessagePart,
  SessionId,
  SessionInputDelivery,
  SessionInputExecutionAuthority,
  SessionInputRecord,
  SessionInputStatus,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { encodeJson } from "../json.js";
import { messages as readMessages, saveMessage, savePart } from "./messages.js";
import * as sessionEntryRepository from "./session-entries.js";

interface SessionInputRow {
  id: string;
  session_id: string;
  kind: string;
  delivery: string;
  payload: string;
  admitted_sequence: number;
  promoted_sequence: number | null;
  promoted_message_id: string | null;
  status: string;
  status_reason: string | null;
  time_created: number;
  time_updated: number;
}

export async function saveSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  },
): Promise<void> {
  const now = Date.now();
  // admitted_sequence 按 session 内账本单调分配；同 id 重入会用 runtime 的实际
  // kind/delivery/payload 修正执行前预 admission，同时保留原序与状态（幂等）。
  db.prepare(
    `
      insert into session_input (
        id, session_id, kind, delivery, payload,
        admitted_sequence, status, time_created, time_updated
      )
      values (
        ?, ?, ?, ?, ?,
        (
          select coalesce(max(admitted_sequence), -1) + 1
          from session_input
          where session_id = ?
        ),
        'admitted', ?, ?
      )
      on conflict(id) do update set
        kind = excluded.kind,
        delivery = excluded.delivery,
        payload = excluded.payload,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.id,
    input.sessionID,
    input.kind,
    input.delivery,
    encodeJson(input.payload) ?? "{}",
    input.sessionID,
    now,
    now,
  );
}

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

function parsePayload(raw: string): SessionInputPayloadParse {
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
 * 宽松解码：**只给展示 / hydration 面用**（`decodeSessionInputRow` 的
 * list/get、`updateSessionInputs` 的读-改-写）。
 *
 * 这些消费者拿不到权威判定权：命令事实查询、恢复清扫、队列编辑读回都只需要
 * 「能展示的近似文本」，这里坏行退化成空串不会让任何东西被执行。执行侧**不得**
 * 调用本函数——唯一入口是 `readSessionInputForExecution`，它把解析失败上报成
 * `corrupt` 让 handler 硬失败（见该函数注释）。
 */
function decodePayload(raw: string): SessionInputPayload {
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
 * 返回 `undefined` = 读不出附件事实（不是「没有附件」）。调用方必须按损坏处理：
 * 把「读不出」当成 `[]` 会静默丢掉用户附件，与 F4 的空串兜底同一类事故。
 */
function readLedgerAttachments(payload: Record<string, unknown>): LedgerAttachments | undefined {
  const intent = payload.conversationInputIntent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const attachments = (intent as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return undefined;
  // 逐项严格校验：过滤掉坏项等于静默丢附件，同样是内容丢失。
  return attachments.every(isAttachmentRef) ? (attachments as LedgerAttachments) : undefined;
}

interface SessionInputPatch {
  delivery?: SessionInputDelivery;
  id: string;
  intent?: TurnInputIntentMetadata;
  text?: string;
  queuePosition?: number;
}

function patchObject(value: unknown, patch: SessionInputPatch): unknown {
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

/** queue edit/reorder 必须同步更新 durable intent，避免 CLI restart 后恢复旧 payload。 */
export async function updateSessionInputs(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    updates: SessionInputPatch[];
  },
): Promise<void> {
  if (input.updates.length === 0) return;
  const read = db.prepare(
    "select delivery, payload from session_input where id = ? and session_id = ? and status = 'admitted'",
  );
  const write = db.prepare(
    "update session_input set delivery = ?, payload = ?, time_updated = ? where id = ? and session_id = ? and status = 'admitted'",
  );
  db.exec("begin immediate");
  try {
    const now = Date.now();
    for (const update of input.updates) {
      const row = read.get(update.id, input.sessionID) as
        | { delivery: SessionInputDelivery; payload: string }
        | undefined;
      if (!row) continue;
      const payload = decodePayload(row.payload);
      if (update.text !== undefined) payload.text = update.text;
      if ("conversationInputIntent" in payload) {
        payload.conversationInputIntent = patchObject(payload.conversationInputIntent, update);
      }
      // 兼容当前 runtime metadata；新写入权威格式仍是 conversationInputIntent。
      if (update.intent) {
        payload.intent = update.intent;
      } else if ("intent" in payload && update.queuePosition !== undefined) {
        const intent = payload.intent;
        if (intent && typeof intent === "object" && !Array.isArray(intent)) {
          payload.intent = {
            ...(intent as Record<string, unknown>),
            queuePosition: update.queuePosition,
          };
        }
      }
      write.run(
        update.delivery ?? row.delivery,
        encodeJson(payload) ?? "{}",
        now,
        update.id,
        input.sessionID,
      );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export async function promoteSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  },
): Promise<void> {
  const now = Date.now();
  db.exec("begin immediate");
  try {
    await saveMessage(db, input.message);
    for (const part of input.parts) {
      await savePart(db, part);
    }
    const refs =
      input.message.metadata && typeof input.message.metadata === "object"
        ? (input.message.metadata as Record<string, unknown>).inputIntent &&
          typeof (input.message.metadata as Record<string, unknown>).inputIntent === "object"
          ? (
              (input.message.metadata as Record<string, unknown>).inputIntent as Record<
                string,
                unknown
              >
            ).sharedContextRefs
          : undefined
        : undefined;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (
          !ref ||
          typeof ref !== "object" ||
          (ref as Record<string, unknown>).kind !== "shared_context_import"
        )
          continue;
        const contextId = (ref as Record<string, unknown>).context_id;
        if (typeof contextId !== "string") continue;
        const entry = sessionEntryRepository
          .sessionEntries(db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
          .find((candidate) => {
            const data = candidate.data;
            return Boolean(
              data &&
              typeof data === "object" &&
              !Array.isArray(data) &&
              (data as Record<string, unknown>).contextId === contextId,
            );
          });
        if (!entry) throw new Error("shared context import is missing");
        const data = entry.data as Record<string, unknown>;
        if (!["pending", "reserved"].includes(String(data.status))) {
          throw new Error("shared context import is no longer attachable");
        }
        sessionEntryRepository.saveSessionEntry(db, {
          ...entry,
          time: { ...entry.time, updated: now },
          data: { ...data, status: "attached", attachedMessageId: String(input.message.id) },
        });
        const contextMessage = (
          await readMessages(db, {
            sessionID: input.sessionID,
          })
        ).find((candidate) => {
          const metadata = candidate.info.metadata;
          return Boolean(
            metadata &&
            typeof metadata === "object" &&
            (metadata as Record<string, unknown>).contextId === contextId,
          );
        });
        if (contextMessage) {
          await saveMessage(db, {
            ...contextMessage.info,
            metadata: {
              ...(contextMessage.info.metadata ?? {}),
              sharedContextStatus: "attached",
            },
          });
        }
      }
    }
    // F5：只看得到 admitted 的行。执行侧读权威（readSessionInputForExecution）发生在
    // reserve 之前，到 here 之间该行可能已被 settle（cancelled/discarded/failed）；
    // 无前置条件的 UPDATE 会把撤销过的输入改写回 promoted 并留在 transcript 里。
    // changes !== 1 → 抛错让 catch 回滚整笔事务（user message/parts 一并撤销）。
    const promoted = db
      .prepare(
        `
        update session_input
        set status = 'promoted',
            promoted_message_id = ?,
            promoted_sequence = (
              select coalesce(max(promoted_sequence), -1) + 1
              from session_input
              where session_id = ?
            ),
            time_updated = ?
        where id = ? and session_id = ? and status = 'admitted'
        `,
      )
      .run(String(input.message.id), input.sessionID, now, input.id, input.sessionID);
    if (promoted.changes !== 1) {
      throw new Error(
        `session_input ${input.id} is not promotable: expected status=admitted (row missing or already settled)`,
      );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export async function markSessionInputPromoted(
  db: DatabaseSync,
  input: { id: string; sessionID: SessionId; promotedMessageID: string },
): Promise<void> {
  db.prepare(
    `
      update session_input
      set status = 'promoted',
          promoted_message_id = ?,
          promoted_sequence = (
            select coalesce(max(promoted_sequence), -1) + 1
            from session_input
            where session_id = ?
          ),
          time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      `,
  ).run(input.promotedMessageID, input.sessionID, Date.now(), input.id, input.sessionID);
}

export async function settleSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  },
): Promise<void> {
  // 只收口未终态的记录：promoted 后到达的迟到 discard 不得回退状态。
  db.prepare(
    `
      update session_input
      set status = ?, status_reason = ?, time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      `,
  ).run(input.status, input.reason ?? null, Date.now(), input.id, input.sessionID);
}

export async function listSessionInputs(
  db: DatabaseSync,
  input: { sessionID: SessionId; status?: SessionInputStatus },
): Promise<SessionInputRecord[]> {
  const rows = (input.status
    ? db
        .prepare(
          `
            select * from session_input
            where session_id = ? and status = ?
            order by admitted_sequence
            `,
        )
        .all(input.sessionID, input.status)
    : db
        .prepare(
          `
            select * from session_input
            where session_id = ?
            order by admitted_sequence
            `,
        )
        .all(input.sessionID)) as unknown as SessionInputRow[];
  return rows.map(decodeSessionInputRow);
}

export async function getSessionInputById(
  db: DatabaseSync,
  id: string,
): Promise<SessionInputRecord | null> {
  const row = db.prepare("select * from session_input where id = ?").get(id) as
    | SessionInputRow
    | undefined;
  return row ? decodeSessionInputRow(row) : null;
}

/**
 * 执行权威读法（I1）：把一行 session_input 读成互斥五态。
 *
 * 为什么不复用 `getSessionInputById`：那是 global 查重（createSession 跨 session 找回
 * session），不带 session 约束、也不区分「终态」。执行侧需要两件它在类型上给不出的事：
 * ① 按 session 约束（跨会话同 id 不允许被当成执行权威）；② 终态标记，且终态**不返回
 * text**——让「账本已终结但照旧拿文本起轮」在类型上写不出来。
 *
 * 与展示面 `decodePayload` 的分界（cr-func F4）：本函数**不用**宽松解码。admitted 行的
 * payload 解析失败 / 不是对象 / text 不是字符串 / 附件事实读不出，一律返回
 * `state:"corrupt"`，让 handler 硬失败。绝不返回 `{ text: "" }`——空文本是合法输入
 * （只有附件的 query），把损坏兜底成空串等于拿空内容起轮并移除队列项（静默丢内容）。
 *
 * spec `docs/iterations/bugfix-batch-20261025/bugs/edit-resend-stale-text` 变更点 1。
 * `status` 由 DB check 约束限定为五值，这里按白名单判定，未知值一律按 `failed` 上报
 * （宁可硬失败也不把不可判定的行当成可执行）。
 */
export async function readSessionInputForExecution(
  db: DatabaseSync,
  input: { id: string; sessionID: SessionId },
): Promise<SessionInputExecutionAuthority> {
  const row = db
    .prepare(
      `
        select status, status_reason, promoted_message_id, payload
        from session_input
        where id = ? and session_id = ?
        `,
    )
    .get(input.id, input.sessionID) as
    | {
        payload: string;
        promoted_message_id: string | null;
        status: string;
        status_reason: string | null;
      }
    | undefined;
  if (!row) return { state: "missing", id: input.id, sessionID: input.sessionID };
  if (row.status === "admitted") {
    const parsed = parsePayload(row.payload);
    if (!parsed.ok) {
      return { state: "corrupt", reason: parsed.reason, id: input.id, sessionID: input.sessionID };
    }
    if (typeof parsed.payload.text !== "string") {
      return {
        state: "corrupt",
        reason: "text_not_string",
        id: input.id,
        sessionID: input.sessionID,
      };
    }
    const attachments = readLedgerAttachments(parsed.payload);
    if (attachments === undefined) {
      return {
        state: "corrupt",
        reason: "attachments_unreadable",
        id: input.id,
        sessionID: input.sessionID,
      };
    }
    return {
      state: "pending",
      status: "admitted",
      id: input.id,
      sessionID: input.sessionID,
      // 只取账本自己的文本/附件；这里没有、也不许有任何投影回落（I1）。
      text: parsed.payload.text,
      attachments,
    };
  }
  if (row.status === "promoted") {
    return {
      state: "started",
      status: "promoted",
      id: input.id,
      sessionID: input.sessionID,
      ...(row.promoted_message_id !== null
        ? { promotedMessageID: row.promoted_message_id as MessageId }
        : {}),
    };
  }
  if (row.status === "cancelled" || row.status === "discarded" || row.status === "failed") {
    return {
      state: "voided",
      status: row.status,
      id: input.id,
      sessionID: input.sessionID,
      ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    };
  }
  // check 约束之外的取值只可能来自库被外部改写/跨版本写入：按 failed 收口，仍不返回 text。
  return {
    state: "voided",
    status: "failed",
    id: input.id,
    sessionID: input.sessionID,
    statusReason: `unknown_status:${row.status}`,
  };
}

function decodeSessionInputRow(row: SessionInputRow): SessionInputRecord {
  const payload = decodePayload(row.payload);
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    kind: row.kind,
    delivery:
      row.delivery === "startNow" || row.delivery === "guide" || row.delivery === "queue"
        ? row.delivery
        : "queue",
    payload,
    admittedSequence: row.admitted_sequence,
    ...(row.promoted_sequence !== null ? { promotedSequence: row.promoted_sequence } : {}),
    ...(row.promoted_message_id !== null
      ? { promotedMessageID: row.promoted_message_id as SessionInputRecord["promotedMessageID"] }
      : {}),
    status: (["admitted", "promoted", "cancelled", "discarded", "failed"].includes(row.status)
      ? row.status
      : "admitted") as SessionInputStatus,
    ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    time: { created: row.time_created, updated: row.time_updated },
  };
}
