#!/usr/bin/env node
/**
 * V4 迟到原始流不得覆盖已定稿输入（上游 v3.15.1 → v3.16.2 backport，U3）。
 *
 * ============================================================================
 * 失效面
 * ============================================================================
 *
 * V4 投影里工具行的输入有两个来源：
 *
 *   A. **原始模型流**（ModelStreaming 的 tool_input_delta / tool_call）：
 *      模型侧边吐边定稿，omz 的 `tool_call`（带 input）drain 即发，
 *      `tool_input_delta` 排队滞后。
 *   B. **调度事实**（ToolCallScheduled）：runtime 已经接纳这次调用，
 *      带权威 toolName + 完整 input。
 *
 * 断流恢复会二次投递同 id 的事件，A/B 到达顺序不再单调。旧实现里 A 无条件覆盖
 * B 已经写进 row 的 input/inputText → 轨迹面板的「调用参数」格显示的是迟到
 * chunk 拼出来的半截内容，而不是真正被执行的那次调用。
 *
 * 移植上游三处（同一处修复必须三处同落，缺一就会出现新缺口）：
 *
 *   1. `appendStreamingToolInput`：行已经定稿（row.input !== undefined）时丢弃
 *      迟到的 tool_input_delta。
 *   2. `finalizeStreamingToolInput`：行已经定稿时丢弃迟到的 tool_call
 *      （不再无条件覆盖 input/inputText，也不再改写 toolName）。
 *   3. `onToolCallScheduled`：existing-upsert 补写 toolName——因为第 2 条守卫
 *      挡住了「靠迟到原始流补身份」，工具名只能由 scheduled 这个权威事实落。
 *
 * 运行方式（必须 tsx）：
 *   `pnpm --dir apps/zcode-cli/packages/bootstrap run test:late-tool-input-guard`
 *   （等价于 `npx tsx --test scripts/test-late-tool-input-guard.mjs`）
 *
 * 为什么不能是裸 `node --test`：被测模块是 TypeScript 源码，且本仓的 `@zcode/shared`
 * 直接导出 `src/*.ts`（package.json exports 指向源码），源码内部相对导入写成
 * "./x.js" 而磁盘上是 ".ts"——裸 node 无法解析，必须由 tsx 兜住。
 * 与 test-ask-question-projection / test-turn-directory 同范式。
 */

import assert from "node:assert/strict";
import test from "node:test";

const { SessionEventType } = await import("@zcode/contracts");
const { ProductProjection } = await import(
  new URL("../src/zcode-protocol-v4/product-projection.ts", import.meta.url).href
);

const SESSION_ID = "ses_late_tool_input";
const EPOCH = "epoch-late";
const TURN_ID = "turn-late-1";

let eventSeq = 0;
function event(type, payload) {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(),
    traceId: "trace-late-tool-input",
    sequenceNumber: eventSeq,
    payload,
  };
}

function turnStarted() {
  return event(SessionEventType.TurnStarted, {
    input: "跑一下迟到流守卫",
    messageId: "msg_u_late",
  });
}

function scheduled(toolCallId, toolName, input) {
  return event(SessionEventType.ToolCallScheduled, {
    toolCallId,
    toolName,
    input,
    schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
  });
}

function rawStream(payload) {
  return event(SessionEventType.ModelStreaming, {
    delta: "",
    done: false,
    ...payload,
  });
}

function toolRow(projection, toolCallId) {
  const row = projection
    .getSnapshot()
    .rows.window.find((item) => item.kind === "toolCall" && item.toolCallId === toolCallId);
  assert.ok(row, `工具行 ${toolCallId} 必须被投影出来`);
  return row;
}

test("1: scheduled 已定稿输入后，迟到的 tool_call 不覆盖 input/inputText", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted());
  projection.applyEvent(scheduled("call_late_1", "Bash", { command: "echo scheduled" }));

  const before = toolRow(projection, "call_late_1");
  assert.deepEqual(before.input, { command: "echo scheduled" });
  assert.equal(before.inputText, JSON.stringify({ command: "echo scheduled" }));

  // 迟到的原始流：同一 toolCallId、另一个工具名与另一份 input。
  projection.applyEvent(
    rawStream({
      kind: "tool_call",
      toolCallId: "call_late_1",
      toolName: "shell",
      input: { command: "echo late" },
    }),
  );

  const after = toolRow(projection, "call_late_1");
  assert.deepEqual(after.input, { command: "echo scheduled" }, "迟到原始流不得覆盖已定稿 input");
  assert.equal(after.inputText, JSON.stringify({ command: "echo scheduled" }));
});

test("2: tool_call 定稿后，迟到的 tool_input_delta 被丢弃", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted());
  projection.applyEvent(
    rawStream({ kind: "tool_input_start", toolCallId: "call_late_2", toolName: "Bash" }),
  );
  projection.applyEvent(
    rawStream({
      kind: "tool_call",
      toolCallId: "call_late_2",
      toolName: "Bash",
      input: { command: "echo final" },
    }),
  );

  const before = toolRow(projection, "call_late_2");
  assert.deepEqual(before.input, { command: "echo final" });

  projection.applyEvent(
    rawStream({ kind: "tool_input_delta", toolCallId: "call_late_2", delta: "LEAKED_TAIL" }),
  );

  const after = toolRow(projection, "call_late_2");
  assert.equal(
    after.inputText,
    JSON.stringify({ command: "echo final" }),
    "定稿后的迟到 delta 不得再拼进 inputText",
  );
  assert.equal(after.inputText.includes("LEAKED_TAIL"), false);
});

test("3: existing-upsert 由 scheduled 补写 toolName", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted());
  // 原始流先到：工具名还是模型/提供方的原始名。
  projection.applyEvent(
    rawStream({ kind: "tool_input_start", toolCallId: "call_late_3", toolName: "shell" }),
  );
  projection.applyEvent(
    rawStream({
      kind: "tool_call",
      toolCallId: "call_late_3",
      toolName: "shell",
      input: { command: "echo identity" },
    }),
  );
  assert.equal(toolRow(projection, "call_late_3").toolName, "shell");

  // scheduled 后到：它带权威工具名，必须写回既有行。
  projection.applyEvent(scheduled("call_late_3", "Bash", { command: "echo identity" }));

  const after = toolRow(projection, "call_late_3");
  assert.equal(after.toolName, "Bash", "既有行的工具名必须由 scheduled 补写");
  assert.deepEqual(after.input, { command: "echo identity" });
});
