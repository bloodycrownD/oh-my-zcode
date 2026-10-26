// forkAssistant：唯一 stable resolver 固定 logical-turn/message boundary，再走
// conversation-only fork。此路径不读取 activeAbortController、不 stop parent，也不进入
// legacy forkSession（后者含 ensureNoActiveTurn + workspace rewind）。
//
// 为什么与 edit/retry 分文件：fork 不参与 `rewind → start` 事务（不截断、不重发、没有
// committed 事实与 draftText 出口），事务骨架留在 `fork-edit-retry.ts` 一处可读完。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { traceContextToLogContext } from "@zcode/contracts";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
// 日志 module 名单点定义：与 edit/retry 同属一个 v4 命令模块，两处字面量会漂移。
import { CONVERSATION_COMMAND_LOG_MODULE } from "./fork-edit-retry.js";
// 行目标过期的裁决与 edit/retry 同一处：`proto.*` 必须原样上行（见 `assertRowTargetFresh`）。
import { assertRowTargetFresh } from "./fork-edit-retry-guards.js";

const FORK_ASSISTANT_COMPLETED_EVENT = "conversation.command.fork_assistant.completed";

class V4ForkTargetGuardError extends Error {
  constructor(
    readonly reasonCode: string,
    targetRowId: number,
  ) {
    super(`forkAssistant targetRowId ${targetRowId} 被稳定目标解析器拒绝: ${reasonCode}`);
    this.name = "V4ForkTargetGuardError";
  }
}

async function forkAssistant(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["forkAssistant"];
  const record = requireRecord(host, envelope.sessionId);
  const targetResolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "forkAssistant",
  );
  // 过期目标必须先抛：折成 guard.* 客户端就不会刷新（用户点重试永远落在旧行上）。
  assertRowTargetFresh(targetResolution, "forkAssistant", payload.target.rowId);
  if (!targetResolution?.ok) {
    throw new V4ForkTargetGuardError("guard.forkTargetNotStable", payload.target.rowId);
  }
  if (!host.resolveStableForkTarget) {
    throw new Error("v4 forkAssistant requires host.resolveStableForkTarget capability");
  }
  const resolution = await host.resolveStableForkTarget(record.app.sessionId, payload.target.rowId);
  if (!resolution.ok) {
    throw new V4ForkTargetGuardError(resolution.reasonCode, payload.target.rowId);
  }
  if (!host.forkStableConversation) {
    throw new Error("v4 forkAssistant requires host.forkStableConversation capability");
  }
  const { forkedSessionId } = await host.forkStableConversation(record.app.sessionId, {
    target: resolution.target,
    goalBoundary: resolution.goalBoundary,
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
  });
  // fork 完成事实过去只在 session event/debug 中，生产默认 JSONL 无法直接检索。
  // child 已创建并完成宿主注册后再写 info，避免把被拒绝或失败的请求误记为成功。
  host.logger?.info?.("v4 forkAssistant completed", {
    ...traceContextToLogContext(record.traceContext),
    childSessionId: forkedSessionId,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: FORK_ASSISTANT_COMPLETED_EVENT,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    parentSessionId: record.app.sessionId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    sessionId: record.app.sessionId,
    status: "completed",
    targetBoundaryMessageId: resolution.target.boundaryMessageId,
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
  });
  const result = { type: "forkAssistant" as const, sessionId: forkedSessionId };
  return result;
}

export const forkAssistantHandlers = { forkAssistant };
