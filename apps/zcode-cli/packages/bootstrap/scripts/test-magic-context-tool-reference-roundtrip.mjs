#!/usr/bin/env node
/**
 * mc-tool-reference 端到端往返回归 — MC 反投影对结构化工具结果的保真。
 *
 * 缺陷（2026-10-24 实测）：MC 正投影已把含 `tool_reference` 的 `role:"tool"` 块数组
 * 原样保留进 `state.output`（`packages/magic-context/src/host/types.ts` 的
 * `toolResultToPart`），但 bootstrap 反投影只认字符串：
 *
 *   const toolOutputOf = (part) => typeof part.state?.output === "string" ? ... : "";
 *
 * 后果是同一份 ToolSearch 结果经一次 MC pass 后：
 *   - 引用块消失（数组 → `content: ""`）；
 *   - `isUnchanged` 因内容不等恒判「已改动」，`rebuildEntry` 再写回空串（每 pass 重建，
 *     cache 前缀抖动）；
 *   - 混合 Text + 引用时**连原本能到模型的文本也一起丢**。
 *
 * 修复后（`src/app/magic-context/projection.ts` 的 `toolOutputOf` /
 * `toolOutputContentOf`）的往返语义，本文件逐形状钉死：
 *
 *   T-RT1 string 往返不变 —— 字符串结果逐引用复用原 entry，改写后仍重建为字符串；
 *   T-RT2 纯 text 块   —— 按正投影 `contentText` 的同一规则 `"\n\n"` 拼接还原成字符串；
 *   T-RT3 纯 tool_reference 块 —— 结构化块原样保留（不文本化、不丢），原 entry 逐引用复用；
 *   T-RT4 混合数组     —— 文本与引用块**两者都在**，顺序不变，原 entry 逐引用复用；
 *   T-RT5 isUnchanged  —— 数组输出内容一致即判未改动（改动前恒 false 的回归位）；
 *                         内容变化则重建，且重建结果仍保住全部块；
 *   T-RT6 畸形/未知块  —— 显式策略：非对象与非法 text 块丢弃；未知 type 的记录块透传；
 *   T-RT7 错误状态     —— `status:"error"` 仍映射 `isError:true`，结构化内容不丢。
 *
 * 直接加载 `src/app/magic-context/projection.ts`（该模块只有 `import type`，运行时零依赖；
 * 语法全部可剥离），因此不依赖 bootstrap 的 `dist/`，跑的是**当前源码**而不是旧构建产物——
 * 这是刻意与本目录两个基于 dist 的 MC 套件错开的一点：反投影形状改动若忘了 build，
 * dist 套件会静默测旧代码，本套件不会。依赖 Node 原生类型剥离（仓库 engines 要求 >=24）。
 * 运行：`pnpm --dir apps/zcode-cli/packages/bootstrap run test:tool-reference-roundtrip`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { projectMagicContextEntries } = await import(
  new URL("../src/app/magic-context/projection.ts", import.meta.url).href
);

const CALL_ID = "call_ref";
const REF_TOOL = "mcp__demo__ping";
const TOOL_REFERENCE = { type: "tool_reference", toolName: REF_TOOL };

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

/** MC 侧的一条 tool 结果消息（正投影把 `role:"tool"` 折成 user + 单个 tool part）。 */
function toolMessage(output, { status = "completed", id = "m1" } = {}) {
  return {
    info: { id, role: "user" },
    parts: [
      {
        type: "tool",
        callID: CALL_ID,
        tool: "ToolSearch",
        state: { status, output },
      },
    ],
  };
}

/** 反投影之前的原 entry（ZCode 用独立的 `role:"tool"` entry 承载结果）。 */
function toolEntry(content, extra = {}) {
  return {
    message: { role: "tool", content, toolCallId: CALL_ID, toolName: "ToolSearch", ...extra },
  };
}

/** 单条消息 + 可选 original 的往返驱动。 */
function roundtrip(output, original, options) {
  const message = toolMessage(output, options);
  const originals =
    original === undefined ? new Map() : new Map([[message.info.id ?? "m1", original]]);
  const { entries } = projectMagicContextEntries([message], originals);
  assert.equal(entries.length, 1, "一条 MC 消息必须反投影成恰好一条 entry");
  return entries[0];
}

/** 结构化块的浅拷贝（正投影 `toolResultToPart` 的拷贝形状，用于断言逐字段相等）。 */
const clone = (value) => JSON.parse(JSON.stringify(value));

// ─────────────────────────────────────────────────────────────────────────────
// T-RT1 — string 路径零行为变化
// ─────────────────────────────────────────────────────────────────────────────

await it("T-RT1: a string tool output round-trips unchanged and still reuses the original", () => {
  const original = toolEntry("Found 1 tool: ping");
  const reused = roundtrip("Found 1 tool: ping", original);
  assert.equal(reused, original, "内容一致时仍必须逐引用复用原 entry（cache 前缀稳定性）");
  assert.equal(reused.message.content, "Found 1 tool: ping");

  // 改写后的字符串仍重建为字符串，绝不因为新增数组分支而变成块数组。
  const rewritten = roundtrip("Found 2 tools: ping, pong", original);
  assert.notEqual(rewritten, original, "内容变化必须重建");
  assert.equal(rewritten.message.content, "Found 2 tools: ping, pong");
  assert.equal(typeof rewritten.message.content, "string");
  assert.equal(rewritten.message.isError, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-RT2 — 纯 text 块数组还原成文本
// ─────────────────────────────────────────────────────────────────────────────

await it("T-RT2: a pure text block array is restored to text (no loss, no empty content)", () => {
  const output = [
    { type: "text", text: "alpha" },
    { type: "text", text: "beta" },
  ];

  // 无原 entry（LKG replay / 重建路径）：文本按正投影 contentText 的 `"\n\n"` 规则还原。
  const rebuilt = roundtrip(output, undefined);
  assert.equal(rebuilt.message.content, "alpha\n\nbeta", "纯文本块不得落成空串");
  assert.equal(rebuilt.message.role, "tool");

  // 原 entry 本来就是该字符串时，往返后判定未改动并逐引用复用。
  const original = toolEntry("alpha\n\nbeta");
  assert.equal(roundtrip(output, original), original);

  // 全部是空文本块时与「没有 content」等价（同 normalizeContent 口径）。
  assert.equal(roundtrip([{ type: "text", text: "" }], undefined).message.content, "");
});

// ─────────────────────────────────────────────────────────────────────────────
// T-RT3 — 纯 tool_reference 块原样保留
// ─────────────────────────────────────────────────────────────────────────────

await it("T-RT3: a pure tool_reference array keeps the structured block as-is", () => {
  const rebuilt = roundtrip([clone(TOOL_REFERENCE)], undefined);
  assert.deepEqual(
    rebuilt.message.content,
    [TOOL_REFERENCE],
    "引用块必须结构化保留：不文本化、不丢、字段不变",
  );
  assert.equal(typeof rebuilt.message.content, "object", "引用块不能退化成字符串");

  // 原 entry 内容等价时逐引用复用（改动前这里因 output 落成 "" 恒判已改动）。
  const original = toolEntry([clone(TOOL_REFERENCE)]);
  assert.equal(roundtrip([clone(TOOL_REFERENCE)], original), original);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-RT4 — 混合数组：文本与引用块都在
// ─────────────────────────────────────────────────────────────────────────────

await it("T-RT4: a mixed text + tool_reference array keeps both, in order", () => {
  const output = [{ type: "text", text: "Found 1 tool: ping" }, clone(TOOL_REFERENCE)];

  const rebuilt = roundtrip(output, undefined);
  assert.deepEqual(rebuilt.message.content, [output[0], TOOL_REFERENCE]);
  assert.match(
    JSON.stringify(rebuilt.message.content),
    /Found 1 tool: ping/,
    "引用块旁边的文本必须一起到达模型（改动前两者全丢）",
  );

  const original = toolEntry(clone(output));
  assert.equal(roundtrip(clone(output), original), original);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-RT5 — isUnchanged 判定：一致即复用，变化即重建且保块
// ─────────────────────────────────────────────────────────────────────────────

await it("T-RT5: array outputs participate in isUnchanged (reuse on equal, rebuild on change)", () => {
  const original = toolEntry([{ type: "text", text: "Found 1 tool: ping" }, clone(TOOL_REFERENCE)]);

  // ① 内容一致 → 未改动 → 原对象（引用相等是 cache 前缀稳定性的唯一判据）。
  assert.equal(roundtrip(clone(original.message.content), original), original);

  // ② 只改文本 → 已改动 → 重建，但引用块不能陪葬。
  const retagged = [{ type: "text", text: "§7§ Found 1 tool: ping" }, clone(TOOL_REFERENCE)];
  const rebuilt = roundtrip(retagged, original);
  assert.notEqual(rebuilt, original, "文本变化必须重建");
  assert.deepEqual(rebuilt.message.content, [retagged[0], TOOL_REFERENCE]);
  assert.equal(rebuilt.message.toolCallId, CALL_ID);
  assert.equal(rebuilt.message.toolName, "ToolSearch");

  // ③ 只改引用块 → 同样已改动（结构化内容参与比较，不是被忽略的旁路）。
  const retargeted = [
    { type: "text", text: "Found 1 tool: ping" },
    { type: "tool_reference", toolName: "mcp__demo__pong" },
  ];
  const rebuiltRef = roundtrip(retargeted, original);
  assert.notEqual(rebuiltRef, original, "引用块变化必须被判定为已改动");
  assert.deepEqual(rebuiltRef.message.content, retargeted);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-RT6 — 畸形 / 未知 type 块的显式策略
// ─────────────────────────────────────────────────────────────────────────────

await it("T-RT6: malformed items are dropped explicitly, unknown record types pass through", () => {
  const output = [
    null,
    "raw string is not a block",
    42,
    { type: "text" }, // 缺 text
    { type: "text", text: 42 }, // text 非字符串
    clone(TOOL_REFERENCE),
    { type: "mystery_future_block", payload: { a: 1 } },
  ];

  // 策略：非对象 / 非法 text 块丢弃（不可能成为合法 ModelMessageContentBlock，
  // 透传给 provider projection 只会抛错）；未知 type 的**记录**块原样透传
  // （与 contentBlocksOf 的未知块口径一致）；顺序保持。
  assert.deepEqual(roundtrip(output, undefined).message.content, [
    TOOL_REFERENCE,
    { type: "mystery_future_block", payload: { a: 1 } },
  ]);

  // 全部是畸形项时退化为「没有 content」，与字符串空值在 wire 上等价。
  assert.equal(roundtrip([null, { type: "text" }, "x"], undefined).message.content, "");
});

// ─────────────────────────────────────────────────────────────────────────────
// T-RT7 — 错误状态：isError 语义与结构化内容同时保住
// ─────────────────────────────────────────────────────────────────────────────

await it("T-RT7: an errored structured result keeps isError and its blocks", () => {
  const errorOutput = [{ type: "text", text: "tool search failed" }, clone(TOOL_REFERENCE)];
  const rebuilt = roundtrip(errorOutput, undefined, { status: "error" });
  assert.equal(rebuilt.message.role, "tool");
  assert.equal(rebuilt.message.isError, true, "status:error 仍映射 isError:true");
  assert.deepEqual(rebuilt.message.content, [errorOutput[0], TOOL_REFERENCE]);

  // 错误结果的内容与原 entry 一致时同样复用原对象（错误标志参与判定）。
  const original = toolEntry(clone(errorOutput), { isError: true });
  assert.equal(roundtrip(clone(errorOutput), original, { status: "error" }), original);
});

test.after(() => {
  console.log(
    `\nbootstrap magic-context tool_reference roundtrip tests: ${passed} passed, ${failed} failed`,
  );
});
