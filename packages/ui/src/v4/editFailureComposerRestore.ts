import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

/** 失败后要放回 composer 的草稿事实（requestId/session/workspace 由 pane 侧补）。 */
export interface EditFailureComposerDraft {
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
}

/**
 * `editUserQuery` 失败后能否把 newText 放回 composer（spec edit-resend-stale-text / I4）。
 *
 * 为什么必须是草稿：rewind 提交后目标行已从投影移除（`keptMessages` 不含 target，
 * `row.removed` 从 turnHeader 起），行组件与行内编辑态一并卸载——「同一行仍可编辑」
 * 这条路不存在。CLI 在「截断已提交后 start 失败」时把 newText 挂在 ACK 的
 * `draftText` 上回传，这里是把它落回 composer 的唯一判据。
 *
 * 只认失败态：`accepted` / `duplicate` 说明命令已经成功（包括 `queued`——排队不是失败，
 * T-RT5），此时绝不能拿草稿覆盖用户当前输入。没有 `draftText` 的失败（校验期拒绝、
 * 行仍在）同样不写 composer：行内编辑态还活着，写 composer 会凭空多出一份副本。
 */
export function resolveEditFailureComposerDraft(ack: CommandAck): EditFailureComposerDraft | null {
  if (ack.status === "accepted" || ack.status === "duplicate") return null;
  const text = ack.draftText;
  if (typeof text !== "string" || text.length === 0) return null;
  // editUserQuery 的失败草稿一律按普通文本恢复：composer 会在发送时按 `/` 前缀重新
  // 识别 slash 输入，这里不需要、也拿不到被编辑轮的原始 inputKind。
  return { inputKind: "sendText", text };
}
