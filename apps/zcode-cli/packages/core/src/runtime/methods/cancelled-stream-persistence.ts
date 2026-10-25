import { createPartId } from "../deps.js";
import { stripMagicContextTagNotation } from "@zcode/shared";
import type { MessageId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import { hasAssistantReasoningContent } from "./turn-output-token-continuation.js";

export async function persistCancelledStreamSnapshot(
  runtime: AgentRuntimeInternal,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    snapshot: RuntimeModelStreamSnapshot;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 用户 stop 时模型请求会以异常退出，成功路径里的最终 text/reasoning
  // 持久化不会执行；这里只 flush 已经到达本进程的 text/reasoning，工具仍等终态路径处理。
  const completedAt = Date.now();
  for (const reasoning of options.snapshot.reasoning) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        metadata: reasoning.providerOptions,
        time: {
          start: options.assistantCreatedAt,
          end: completedAt,
        },
      },
      options.traceContext,
    );
  }
  if (!options.snapshot.text) {
    return;
  }
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "text",
      // 中断落库路径与成功路径同一边界：用户 stop 时 flush 的这段已到达文本同样可能带
      // 模型自写的 §N§ 前缀，不剥就会绕过成功路径的落库剥离直接写进库。
      text: stripMagicContextTagNotation(options.snapshot.text),
      time: {
        start: options.assistantCreatedAt,
        end: completedAt,
      },
    },
    options.traceContext,
  );
}
