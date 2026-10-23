import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";

type RequestRuntime = {
  readonly config: Pick<AgentRuntimeConfig, "midConversationSystem" | "toolSearch">;
};

interface MessageProjectionInput {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  model: Model;
  loadedToolCallIds?: ReadonlySet<string>;
}

/**
 * phase-toolsearch 的请求准备缝（turn-loop 落地序见 toolsearch-seam-proof.md）：
 * 先用完整作用域目录做一次工具暴露决策（deferred 目录 + tool_reference 投影），
 * 再把配套结果（entries/loadedToolCallIds/tools）交给投影与发送方。
 * 辅助请求曾出现「按能力保留引用却发送空工具表」的形态缺口，统一走本入口避免复发。
 */
// 仅渲染消息，供已准备请求的记录投影和历史估算复用；不重新猜测工具启用状态。
export function buildRuntimeProviderRequestMessages(
  runtime: RequestRuntime,
  input: MessageProjectionInput,
): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem =
    runtime.config.midConversationSystem?.mode === "force" ||
    input.model.properties.supportsMidConversationSystem;
  return buildProviderRequestMessages({
    ...input,
    useMidConversationSystem,
  });
}
