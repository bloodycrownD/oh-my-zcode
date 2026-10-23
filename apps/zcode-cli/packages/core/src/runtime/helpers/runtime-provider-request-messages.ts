import { buildToolExposure } from "../../tool/search/exposure.js";
import type { ModelToolContract } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ToolRegistry } from "../../tool/registry.js";
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

export function prepareRuntimeProviderRequest(
  runtime: RequestRuntime,
  input: MessageProjectionInput & {
    tools: readonly ModelToolContract[];
    registry?: Pick<ToolRegistry, "get">;
  },
) {
  const exposure = buildToolExposure({
    model: input.model,
    mode: runtime.config.toolSearch?.mode,
    tools: input.tools,
    registry: input.registry,
    entries: input.entries,
  });
  const projection = buildRuntimeProviderRequestMessages(runtime, {
    entries: exposure.entries,
    model: input.model,
    loadedToolCallIds: exposure.loadedToolCallIds,
    applyCacheControl: input.applyCacheControl,
  });
  return {
    request: {
      messages: projection.messages,
      tools: exposure.tools,
      toolSearchEnabled: exposure.context.mode === "native",
    },
    projection,
    entries: exposure.entries,
    // 记录过滤 Continue 后会重新渲染，需复用本次有效引用，避免遗漏成功提示或重复扫描历史。
    loadedToolCallIds: exposure.loadedToolCallIds,
    toolSearch: exposure.context,
    reason: exposure.reason,
  };
}
