import assert from "node:assert/strict";
import test from "node:test";

import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { ToolSearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

/**
 * phase-toolsearch 冒烟（T-TS2 的 UI 面）：T08 resolveRenderer 按名分流——
 * ToolSearch 调用走专用卡（select: 展示命中名单形态），不落 raw JSON 兜底。
 */

// 分流是纯查表：fixture 只需携带 dispatch 读取的 toolName/kind 字段。
function contextOf(toolCall: {
  kind: string;
  toolName?: string;
  toolId: string;
  input: unknown;
}): ToolCallBlockRenderContext {
  return { toolCallNode: { toolCall } } as unknown as ToolCallBlockRenderContext;
}

test("T-TS-UI1: resolveToolCallRenderer 对 ToolSearch 工具名分流到 ToolSearchToolCallBlock", () => {
  const context = contextOf({
    kind: "tool",
    toolName: "ToolSearch",
    toolId: "t1",
    input: { query: "select:Read,Edit" },
  });
  assert.equal(resolveToolCallRenderer(context), ToolSearchToolCallBlock);
});

test("T-TS-UI2: 普通 Search 工具不受分流影响（family 之前只按精确名判定）", () => {
  const context = contextOf({ kind: "tool", toolName: "Grep", toolId: "t2", input: {} });
  assert.notEqual(resolveToolCallRenderer(context), ToolSearchToolCallBlock);
});
