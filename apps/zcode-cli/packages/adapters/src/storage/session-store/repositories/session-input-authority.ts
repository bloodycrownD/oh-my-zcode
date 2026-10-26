// 执行侧权威读法（账本 → 互斥五态）。
//
// 与仓库读写分文件的原因：这里的返回值**故意不带 text**（终态），且**必须失败**而不是
// 兜底成空串。把它和 `decodePayload` 的宽松解码放在同一个文件里，最容易被后来的改动
// 「复用一下 parse」而破坏 I1。载荷解析与附件事实全部来自 `session-input-payload.ts`。
import type { DatabaseSync } from "node:sqlite";
import type { MessageId, SessionId, SessionInputExecutionAuthority } from "@zcode/contracts";
import { parsePayload, readLedgerAttachments } from "./session-input-payload.js";

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
