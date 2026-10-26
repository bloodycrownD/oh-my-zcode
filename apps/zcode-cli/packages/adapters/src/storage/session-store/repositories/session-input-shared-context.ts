// promote 的 shared-context 附带动作：把 `shared_context_import` 会话项从
// pending/reserved 收口成 attached，并同步那条 context message 的 metadata。
//
// 单独成文件的原因：它是 promote 事务里的**副作用段**（读 messages、写 session_entry、
// 再写 message），与「账本状态机」本身无关；混在 `session-inputs.ts` 里会让仓库文件
// 同时承担两套写路径，改动时容易误以为它可以脱离事务单独调用。**它必须在 promote 的
// `begin immediate` 事务内被调用**——抛错要连带回滚 user message/parts。
import type { DatabaseSync } from "node:sqlite";
import type { MessageInfo, SessionId } from "@zcode/contracts";
import { messages as readMessages, saveMessage } from "./messages.js";
import * as sessionEntryRepository from "./session-entries.js";

/** 触发失败即整笔 promote 回滚（缺项 / 已不可附带都按硬失败处理）。 */
export async function attachSharedContextImports(
  db: DatabaseSync,
  input: { message: MessageInfo; sessionID: SessionId; now: number },
): Promise<void> {
  const metadata = input.message.metadata;
  const intent =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).inputIntent
      : undefined;
  const refs =
    intent && typeof intent === "object"
      ? (intent as Record<string, unknown>).sharedContextRefs
      : undefined;
  if (!Array.isArray(refs)) return;
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
      time: { ...entry.time, updated: input.now },
      data: { ...data, status: "attached", attachedMessageId: String(input.message.id) },
    });
    const contextMessage = (
      await readMessages(db, {
        sessionID: input.sessionID,
      })
    ).find((candidate) => {
      const messageMetadata = candidate.info.metadata;
      return Boolean(
        messageMetadata &&
        typeof messageMetadata === "object" &&
        (messageMetadata as Record<string, unknown>).contextId === contextId,
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
