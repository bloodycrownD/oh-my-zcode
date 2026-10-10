import type { ZCodeMessagePart, ZCodeMessageWithParts, ZCodeToolState } from "@zcode/shared";
import type { MessagePart, MessageWithParts, ToolState } from "@zcode/contracts";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";

export function mapMessageWithParts(
  message: MessageWithParts,
  onDroppedPart?: (part: MessagePart) => void,
): ZCodeMessageWithParts {
  return {
    info:
      message.info.role === "user"
        ? {
            agent: message.info.agent,
            messageId: String(message.info.id),
            model: message.info.modelSelection,
            metadata: message.info.metadata,
            role: "user",
            semantics: message.info.semantics,
            sessionId: String(message.info.sessionID),
            source: message.info.source,
            system: message.info.system,
            synthetic: message.info.synthetic,
            time: message.info.time,
            tools: message.info.tools,
            visibility: message.info.visibility,
          }
        : {
            agent: message.info.agent,
            cost: message.info.cost,
            error: message.info.error
              ? ({ name: message.info.error.name, data: message.info.error.data } as Record<
                  string,
                  unknown
                >)
              : undefined,
            finish: message.info.finish,
            messageId: String(message.info.id),
            model:
              message.info.providerId && message.info.modelId
                ? {
                    providerId: message.info.providerId,
                    modelId: message.info.modelId,
                    ...(message.info.reasoningLevel
                      ? { options: { reasoningLevel: message.info.reasoningLevel } }
                      : {}),
                  }
                : undefined,
            parentMessageId: String(message.info.parentID),
            path: message.info.path,
            role: "assistant",
            semantics: message.info.semantics,
            sessionId: String(message.info.sessionID),
            structured: message.info.structured,
            time: message.info.time,
            tokens: message.info.tokens,
          },
    parts: message.parts
      .filter(
        (part) =>
          part.type !== "tool" || !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata),
      )
      .map((part) => {
        const mapped = mapMessagePart(part);
        // 未知/损坏 type 在 mapMessagePart 内降级为 null（e2e/R-3 上游根治）。
        // 这里过滤出协议面并回调上报丢弃，snapshot 映射侧据此统计 warn（agent/B-1）——
        // 过去丢弃完全静默，part 消失只能靠用户肉眼发现。
        if (mapped === null) {
          onDroppedPart?.(part);
          return null;
        }
        return mapped;
      })
      .filter((part): part is ZCodeMessagePart => part !== null),
  };
}

/**
 * 单 part → 协议 part。返回 null = 未知/损坏 type，不进协议快照。
 *
 * e2e/R-3 上游根治：过去 switch 没有 default 分支，未知 type 会让函数隐式返回
 * undefined 混进 parts 数组，hydrateSnapshotFilePartUrl 对 undefined 读 .type
 * 直接把编辑重发后的整个 buildSessionSnapshot 打成 TypeError（rewind 已生效、
 * 重发丢失）。根因核验结论：rewind 投影只整条丢弃消息、不合成 part，真正的
 * undefined 生产者就是这里的无 default 隐式返回——可达来源是 decodeStoredPart
 * 对残缺 data 行返回的无 type 对象，以及前向兼容的新 part type。
 */
function mapMessagePart(part: MessagePart): ZCodeMessagePart | null {
  const base = {
    messageId: String(part.messageID),
    partId: String(part.id),
    sessionId: String(part.sessionID),
  };
  switch (part.type) {
    case "text":
      return {
        ...base,
        ignored: part.ignored,
        metadata: part.metadata,
        synthetic: part.synthetic,
        text: part.text,
        type: "text",
      };
    case "reasoning":
      return { ...base, metadata: part.metadata, text: part.text, type: "reasoning" };
    case "file":
      return {
        ...base,
        filename: part.filename,
        metadata: part.metadata as Record<string, unknown> | undefined,
        mime: part.mime,
        type: "file",
        url: part.url,
      };
    case "tool":
      return {
        ...base,
        callId: part.callID,
        metadata: mapToolPartMetadata(part.metadata),
        state: mapToolState(part.state),
        tool: part.tool,
        type: "tool",
      };
    case "step-start":
      return { ...base, snapshot: part.snapshot, type: "step-start" };
    case "step-finish":
      return {
        ...base,
        cost: part.cost,
        reason: part.reason,
        snapshot: part.snapshot,
        tokens: part.tokens,
        type: "step-finish",
      };
    case "snapshot":
      return { ...base, snapshot: part.snapshot, type: "snapshot" };
    case "patch":
      return { ...base, files: part.files, hash: part.hash, type: "patch" };
    case "timeline":
      return {
        ...base,
        anchorMessageId: part.anchorMessageId ? String(part.anchorMessageId) : undefined,
        anchorTurnId: part.anchorTurnId ? String(part.anchorTurnId) : undefined,
        display: part.display,
        fromModel: part.timelineType === "model_change" ? part.fromModel : undefined,
        goalIteration: part.timelineType === "goal_verification" ? part.goalIteration : undefined,
        parentSessionId:
          part.timelineType === "session_fork" ? String(part.parentSessionId) : undefined,
        restoredFileCount:
          part.timelineType === "session_fork" ? part.restoredFileCount : undefined,
        status: part.status,
        targetCheckpointId:
          part.timelineType === "session_fork" ? part.targetCheckpointId : undefined,
        targetId: part.timelineType === "goal_verification" ? part.targetId : undefined,
        targetMessageId:
          part.timelineType === "session_fork" ? String(part.targetMessageId) : undefined,
        time: part.time,
        timelineType: part.timelineType,
        toModel: part.timelineType === "model_change" ? part.toModel : undefined,
        type: "timeline",
        verification: part.timelineType === "goal_verification" ? part.verification : undefined,
        verificationId: part.timelineType === "goal_verification" ? part.verificationId : undefined,
      };
    case "subtask":
      return {
        ...base,
        agent: part.agent,
        command: part.command,
        description: part.description,
        model: part.model,
        prompt: part.prompt,
        type: "subagent",
      };
    case "agent":
      return { ...base, name: part.name, type: "agent" };
    case "retry":
      return {
        ...base,
        attempt: part.attempt,
        error: { name: part.error.name, data: part.error.data },
        type: "retry",
      };
    default:
      // 未知 type（缺 type 的残缺存储行 / 前向兼容新 type）：返回 null 由调用侧
      // 过滤并统计，杜绝隐式 undefined 混入 parts 数组（e2e/R-3 崩溃源头）。
      return null;
  }
}

function mapToolPartMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "providerToolName")) {
    return metadata;
  }
  // providerToolName 只用于 Agent cold hydration 恢复模型原始空名；App 使用
  // ToolPart.tool 的 non-empty 占位值，不能把内部 provider 字段投影到公共协议。
  const visibleMetadata = { ...metadata };
  delete visibleMetadata.providerToolName;
  return Object.keys(visibleMetadata).length > 0 ? visibleMetadata : undefined;
}

function mapToolState(state: ToolState): ZCodeToolState {
  switch (state.status) {
    case "pending":
      return { input: state.input, raw: state.raw, status: "pending" };
    case "running":
      return {
        input: state.input,
        metadata: mapToolStateMetadata(state.metadata),
        startedAt: state.time.start,
        status: "running",
        title: state.title,
      };
    case "completed":
      return {
        completedAt: state.time.end,
        input: state.input,
        metadata: mapCompletedToolStateMetadata(state.metadata),
        output: state.output,
        startedAt: state.time.start,
        status: "completed",
        title: state.title,
      };
    case "error":
      return {
        completedAt: state.time.end,
        error: state.error,
        input: state.input,
        metadata: mapErrorToolStateMetadata(state.metadata),
        startedAt: state.time.start,
        status: "error",
      };
  }
}

function mapToolStateMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "readFileState")) {
    return metadata;
  }
  const protocolMetadata = { ...metadata };
  // readFileState 携带完整文件快照，只用于 agent resume 内部恢复；
  // app/remote protocol 只需要展示 metadata，不能把文件内容藏在 tool state metadata 里透出。
  delete protocolMetadata.readFileState;
  return protocolMetadata;
}

function mapErrorToolStateMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const protocolMetadata = mapToolStateMetadata(metadata);
  if (
    !protocolMetadata ||
    !Object.prototype.hasOwnProperty.call(protocolMetadata, "modelContent")
  ) {
    return protocolMetadata;
  }
  // error modelContent 只用于 Agent 精确恢复 provider history，
  // 不能作为新的 App / remote protocol metadata 暴露。
  const visibleMetadata = { ...protocolMetadata };
  delete visibleMetadata.modelContent;
  return visibleMetadata;
}

function mapCompletedToolStateMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const protocolMetadata = mapToolStateMetadata(metadata);
  if (
    !protocolMetadata ||
    !Object.prototype.hasOwnProperty.call(protocolMetadata, "modelContentLayout")
  ) {
    return protocolMetadata ?? {};
  }
  // modelContentLayout 只供 Agent 冷恢复重建 tool result 媒体顺序，
  // completed metadata 原样映射会把内部布局和重复文本带入 App / remote replayable payload。
  const visibleMetadata = { ...protocolMetadata };
  delete visibleMetadata.modelContentLayout;
  // core 的历史/异常 completed tool part 可能没有 metadata，但
  // ZCode protocol 的 completed tool state 要求 metadata 必须是 object。
  return visibleMetadata;
}
