/**
 * 轨迹 wire 占位行分类器的单测（spec Step 9 / B-4 B10，T-T6 的 wire-filter 半边）。
 *
 * 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入（tsx 下别名不可解析），
 * 只允许相对路径与 `@zcode/*` 包名（先例 modelTrajectoryTurns.test.ts:1-6）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import {
  classifyTrajectoryWireMessage,
  classifyTrajectoryWireRows,
} from "../src/ModelTrajectoryWireFilter.js";

function textMessage(role: string, text: string): ZCodeModelTrajectoryMessage {
  return { role, parts: [{ kind: "text", text }] };
}

function reasoningMessage(role: string, text: string): ZCodeModelTrajectoryMessage {
  return { role, parts: [{ kind: "reasoning", text }] };
}

test("T-T6 wire-filter：marker-only 文本（只剩 §N§ 标记）→ hidden", () => {
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", "§12§")), "placeholder");
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", "§1§ §2§")), "placeholder");
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", "  §3§\n")), "placeholder");
});

test("T-T6 wire-filter：空 parts 与全空文本 → hidden", () => {
  assert.equal(classifyTrajectoryWireMessage({ role: "assistant", parts: [] }), "placeholder");
  assert.equal(classifyTrajectoryWireMessage({ role: "tool", parts: [] }), "placeholder");
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", "")), "placeholder");
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", " \n\t ")), "placeholder");
});

test("T-T6 wire-filter：[dropped §4§] 单行及其它占位符形态 → hidden", () => {
  assert.equal(
    classifyTrajectoryWireMessage(textMessage("assistant", "[dropped §4§]")),
    "placeholder",
  );
  assert.equal(
    classifyTrajectoryWireMessage(textMessage("assistant", "  [dropped §4§]  ")),
    "placeholder",
  );
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", "[dropped]")), "placeholder");
  assert.equal(
    classifyTrajectoryWireMessage(textMessage("assistant", "[truncated §7§]")),
    "placeholder",
  );
  assert.equal(
    classifyTrajectoryWireMessage(textMessage("assistant", "[truncated]")),
    "placeholder",
  );
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", "[cleared]")), "placeholder");
  assert.equal(
    classifyTrajectoryWireMessage(textMessage("assistant", "[dropped §1§]\n[dropped §2§]")),
    "placeholder",
  );
  assert.equal(
    classifyTrajectoryWireMessage(reasoningMessage("assistant", "[cleared]")),
    "placeholder",
  );
});

test("T-T6 wire-filter：system / user 角色强制 visible（含占位文本与空 parts）", () => {
  assert.equal(classifyTrajectoryWireMessage(textMessage("system", "[dropped §4§]")), "visible");
  assert.equal(classifyTrajectoryWireMessage(textMessage("user", "§12§")), "visible");
  assert.equal(classifyTrajectoryWireMessage({ role: "user", parts: [] }), "visible");
  assert.equal(classifyTrajectoryWireMessage({ role: "system", parts: [] }), "visible");
  // 角色大小写与空白不影响保护判定。
  assert.equal(classifyTrajectoryWireMessage(textMessage(" SYSTEM ", "[cleared]")), "visible");
});

test("T-T6 wire-filter：正常文本与结构化 part → visible", () => {
  assert.equal(classifyTrajectoryWireMessage(textMessage("assistant", "正常回复")), "visible");
  assert.equal(classifyTrajectoryWireMessage(textMessage("tool", "命令输出")), "visible");
  assert.equal(classifyTrajectoryWireMessage(reasoningMessage("assistant", "思考内容")), "visible");
  // 占位文本旁有真实工具调用时，整条消息仍要展示。
  assert.equal(
    classifyTrajectoryWireMessage({
      role: "assistant",
      parts: [
        { kind: "text", text: "[dropped §9§]" },
        { kind: "tool-call", toolName: "read", input: { path: "a.ts" } },
      ],
    }),
    "visible",
  );
  assert.equal(
    classifyTrajectoryWireMessage({
      role: "tool",
      parts: [{ kind: "tool-result", toolName: "read", output: "ok" }],
    }),
    "visible",
  );
  // 预览式 truncated（带真实预览文本）不算空占位。
  assert.equal(
    classifyTrajectoryWireMessage(textMessage("assistant", "[truncated §7§]\n真实预览内容")),
    "visible",
  );
});

test("T-T6 wire-filter：hiddenCount 计数正确且保持顺序", () => {
  const normalUser = textMessage("user", "帮我看看这个 bug");
  const droppedAssistant = textMessage("assistant", "[dropped §4§]");
  const emptyAssistant: ZCodeModelTrajectoryMessage = { role: "assistant", parts: [] };
  const normalAssistant = textMessage("assistant", "已经定位到根因");
  const markerOnlyTool = textMessage("tool", "§15§");
  const messages = [normalUser, droppedAssistant, emptyAssistant, normalAssistant, markerOnlyTool];

  const { rows, hiddenCount } = classifyTrajectoryWireRows(messages);

  assert.equal(hiddenCount, 3);
  // UI 侧聚合口径：visible = 非占位行按原顺序投影（分类只有 classifyTrajectoryWireRows
  // 一条路径，测试自行聚合断言）。
  const visible = rows.filter((row) => !row.placeholder).map((row) => row.message);
  assert.deepEqual(visible, [normalUser, normalAssistant]);
  // 返回原对象引用，且不修改入参。
  assert.equal(visible[0], normalUser);
  assert.equal(visible[1], normalAssistant);
  assert.equal(messages.length, 5);
});

test("T-T6 wire-filter：空列表与全占位列表", () => {
  const empty = classifyTrajectoryWireRows([]);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.hiddenCount, 0);

  const allPlaceholders = [
    textMessage("assistant", "[dropped]"),
    textMessage("assistant", "[cleared]"),
  ];
  const classified = classifyTrajectoryWireRows(allPlaceholders);
  assert.deepEqual(
    classified.rows.filter((row) => !row.placeholder).map((row) => row.message),
    [],
  );
  assert.equal(classified.hiddenCount, 2);
});

test("T-T6 wire-filter：classifyTrajectoryWireRows 保留原始下标（UI 渲染与搜索索引共用）", () => {
  const normalUser = textMessage("user", "帮我看看这个 bug");
  const droppedAssistant = textMessage("assistant", "[dropped §4§]");
  const emptyAssistant: ZCodeModelTrajectoryMessage = { role: "assistant", parts: [] };
  const normalAssistant = textMessage("assistant", "已经定位到根因");
  const messages = [normalUser, droppedAssistant, emptyAssistant, normalAssistant];

  const { rows, hiddenCount } = classifyTrajectoryWireRows(messages);

  assert.equal(hiddenCount, 2);
  assert.deepEqual(
    rows.map((row) => [row.messageIndex, row.placeholder]),
    [
      [0, false],
      [1, true],
      [2, true],
      [3, false],
    ],
  );
  assert.equal(rows[0]?.message, normalUser);
  assert.deepEqual(
    rows.filter((row) => !row.placeholder).map((row) => row.message),
    [normalUser, normalAssistant],
  );
});
