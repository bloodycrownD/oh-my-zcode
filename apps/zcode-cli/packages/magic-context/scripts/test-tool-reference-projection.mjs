#!/usr/bin/env node
/**
 * mc-tool-reference 回归 — 正投影对 tool_reference 块的结构保留。
 *
 * 背景：docs/iterations/upstream-v316-fullsync/toolsearch-seam-proof.md §3.3 记录
 * 「MC 正投影对 role:"tool" 块数组一律文本化，native 引用块在 MC pass 后必失」。
 * tool_reference 块形如 `{ type: "tool_reference", toolName }`，没有 text/content
 * 字段；`src/host/types.ts` 的 `toolResultToPart` 走 `contentText` 时会把整条结果
 * 压成字符串，引用块随之消失，native 模式下列表服务端无法展开已发现的工具定义。
 * adapters 侧已有同款保护（`adapters/src/model/transform.ts:174-192`：只要块数组里
 * 存在 `type === "tool_reference"` 就保留结构化 content），MC 的 host 正投影现在
 * 对齐：含 tool_reference 的块数组不再被文本化，其余块按原样保留。
 *
 * 两个方向都锁住（缺一不可，避免把「普通 tool 结果也结构化」这种回归放进来）：
 *
 *   T-TR1 — 含 tool_reference 的 tool 块数组经 `projectRuntimeEntries` 正投影后，
 *           MessageLike 里仍能找到 `{ type: "tool_reference", toolName }` 结构块，
 *           且 tool 结果的折叠语义（user 消息 + 单个 completed tool part）不变；
 *   T-TR2 — 普通 tool 文本块数组行为逐字节不变：仍是单个 tool part，
 *           `state.output` 是 `contentText` 的 "\n\n" 拼接字符串，且不产生任何
 *           tool_reference 结构。
 *
 * 运行（脚本读构建产物，先构建本包；不用跑全量 CLI 套件）：
 *   pnpm --dir apps/zcode-cli/packages/magic-context build
 *   node apps/zcode-cli/packages/magic-context/scripts/test-tool-reference-projection.mjs
 *
 * 参考同目录 test-host.mjs 的入口约定：默认读本包 `dist/`，可用
 * MC_HOST_TEST_OUT 指向别的构建目录。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_ROOT = process.env.MC_HOST_TEST_OUT ?? join(PKG_ROOT, "dist");
if (!existsSync(join(OUT_ROOT, "host", "types.js"))) {
  console.error(
    `no compiled host layer at ${OUT_ROOT} — run \`pnpm --dir apps/zcode-cli/packages/magic-context build\` (or set MC_HOST_TEST_OUT).`,
  );
  process.exit(1);
}

const { projectRuntimeEntries } = await import(
  pathToFileURL(join(OUT_ROOT, "host", "types.js")).href
);

let passed = 0;
let failed = 0;
const it = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
      passed += 1;
    } catch (error) {
      failed += 1;
      throw error;
    }
  });

/**
 * 深度收集投影结果里的所有记录。结构块可能落在 tool part 的 state 上（例如
 * `state.output` 之外的承载字段）也可能作为独立 part 透传，回归只关心
 * 「结构块是否还在 MessageLike 里」，不绑定具体承载位置。
 */
function collectRecords(value, out = [], seen = new Set()) {
  if (value === null || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, out, seen);
    return out;
  }
  out.push(value);
  for (const child of Object.values(value)) collectRecords(child, out, seen);
  return out;
}

const TOOL_REFERENCE = "mcp__demo__ping";

// ─────────────────────────────────────────────────────────────────────────────
// T-TR1 — tool_reference 结构块穿过正投影
// ─────────────────────────────────────────────────────────────────────────────

await it("T-TR1: a tool block array containing tool_reference keeps its structure", () => {
  const [projected] = projectRuntimeEntries(
    [
      {
        message: {
          role: "tool",
          content: [
            { type: "text", text: "Found 1 tool: ping" },
            { type: "tool_reference", toolName: TOOL_REFERENCE },
          ],
          toolCallId: "call_ref",
          toolName: "ToolSearch",
        },
      },
    ],
    { idPrefix: "mc" },
  );

  // 折叠语义不变：role:"tool" 仍是 user 消息 + 单个 completed tool part。
  assert.equal(projected.info.role, "user");
  const toolParts = projected.parts.filter((part) => part?.type === "tool");
  assert.equal(toolParts.length, 1, "tool result still folds into exactly one tool part");
  const toolPart = toolParts[0];
  assert.equal(toolPart.callID, "call_ref");
  assert.equal(toolPart.tool, "ToolSearch");
  assert.equal(toolPart.state.status, "completed");

  // 结构块必须存活（在 parts 的任意承载层级），且 toolName 原样保留。
  const references = collectRecords(projected.parts).filter(
    (record) => record.type === "tool_reference",
  );
  assert.equal(references.length, 1, "the tool_reference block must survive the projection");
  assert.equal(references[0].toolName, TOOL_REFERENCE);

  // 同一结果里的文本不能被结构保留逻辑顺带丢掉。
  assert.match(
    JSON.stringify(projected.parts),
    /Found 1 tool: ping/,
    "the text block next to tool_reference must still reach magic-context",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// T-TR2 — 普通文本块仍是字符串输出（行为逐字节不变）
// ─────────────────────────────────────────────────────────────────────────────

await it("T-TR2: a plain text tool block array is still textified", () => {
  const [projected] = projectRuntimeEntries([
    {
      message: {
        role: "tool",
        content: [
          { type: "text", text: "alpha" },
          { type: "text", text: "beta" },
        ],
        toolCallId: "call_plain",
        toolName: "Bash",
      },
    },
  ]);

  assert.equal(projected.info.role, "user");
  assert.equal(projected.parts.length, 1, "plain tool result still folds into one part");
  const toolPart = projected.parts[0];
  assert.equal(toolPart.type, "tool");
  assert.equal(toolPart.callID, "call_plain");
  assert.equal(toolPart.tool, "Bash");
  assert.equal(toolPart.state.status, "completed");
  // contentText 的既有拼接规则（空行分隔），文本化路径不得被结构性改动波及。
  assert.equal(toolPart.state.output, "alpha\n\nbeta");
  assert.equal(
    collectRecords(projected.parts).some((record) => record.type === "tool_reference"),
    false,
    "a plain text tool result must not grow structured blocks",
  );
});

test.after(() => {
  console.log(`\nmagic-context tool_reference projection tests: ${passed} passed, ${failed} failed`);
});
