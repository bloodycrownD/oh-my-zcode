/**
 * 轨迹工具调用/结果跨记录 join 的单测（spec Step 1 / N-1 / T-N1）。
 *
 * 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入（tsx 下别名不可解析），
 * 只允许相对路径与 `@zcode/*` 包名（先例 modelTrajectoryTurns.test.ts:7-28）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
} from "@zcode/services";
import {
  filterTrajectoryInputRows,
  joinTrajectoryToolResults,
  trajectoryCallKey,
  trajectoryInputRowKey,
  trajectoryToolCallDisplayText,
  trajectoryToolCallTargetKey,
  type TrajectoryToolCallInfo,
} from "../src/ModelTrajectoryToolJoin.js";
import {
  computeDeltaMessages,
  trajectoryCallKey as turnsCallKey,
} from "../src/ModelTrajectoryTurns.js";
import type { TrajectoryWireRow } from "../src/ModelTrajectoryWireFilter.js";

function toolCall(
  toolCallId: string | undefined,
  toolName: string,
  input: unknown,
): ZCodeModelTrajectoryContentPart {
  return { kind: "tool-call", toolCallId, toolName, input };
}

function toolResult(
  toolCallId: string | undefined,
  output: unknown,
  toolName?: string,
): ZCodeModelTrajectoryContentPart {
  return { kind: "tool-result", toolCallId, toolName, output };
}

function textMessage(role: string, text: string): ZCodeModelTrajectoryMessage {
  return { role, parts: [{ kind: "text", text }] };
}

function record(spec: {
  requestId: string;
  attempt?: number;
  messages: ZCodeModelTrajectoryMessage[];
  messageCount?: number;
  toolCalls?: ZCodeModelTrajectoryContentPart[];
}): ZCodeModelTrajectoryRecord {
  return {
    requestId: spec.requestId,
    attempt: spec.attempt ?? 1,
    startedAt: "2026-10-21T00:00:00.000Z",
    completedAt: "2026-10-21T00:00:02.000Z",
    durationMs: 1_000,
    callSource: { kind: "main" },
    model: { modelId: "test-model" },
    request: {
      messages: spec.messages,
      toolNames: [],
      ...(spec.messageCount === undefined ? {} : { messageCount: spec.messageCount }),
      croppedCount: 0,
    },
    response: spec.toolCalls ? { toolCalls: spec.toolCalls } : undefined,
  };
}

function infos(
  join: ReturnType<typeof joinTrajectoryToolResults>,
  requestId: string,
  recordIndex: number,
): TrajectoryToolCallInfo[] {
  const result = join.callToolCalls.get(trajectoryCallKey(requestId, recordIndex));
  assert.ok(result, `缺少 ${requestId}:${recordIndex} 的配对信息`);
  return result;
}

const callOk = toolCall("call_ok", "read", "读 a.txt");
const resultOk = toolResult("call_ok", "内容A", "read");
const callError = toolCall("call_err", "bash", "ls");
const resultError = toolResult("call_err", { type: "error-text", value: "命令失败" }, "bash");
const callMissing = toolCall("call_gone", "grep", "rg x");
const callNoId = toolCall(undefined, "shell", "pwd");
const unknownNoId: ZCodeModelTrajectoryContentPart = { kind: "unknown", raw: { legacy: true } };

// ── T-N1 ① 四态判定 ────────────────────────────────────────────────────────

test("T-N1 ① 配对四态：ok/error/missing（被放弃 attempt 与 unknown 无 id）/pending 仅尾部", () => {
  const records = [
    record({
      requestId: "r0",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [callOk, callError, callMissing, unknownNoId],
    }),
    record({
      requestId: "r1",
      messages: [textMessage("user", "问"), { role: "tool", parts: [resultOk, resultError] }],
      messageCount: 2,
      toolCalls: [],
    }),
    // 尾部 record：未配对的 call 判 pending（尾部在途是常态），不是 missing。
    record({
      requestId: "r2",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [toolCall("call_tail", "write", "写"), unknownNoId],
    }),
  ];

  const join = joinTrajectoryToolResults(records);

  const first = infos(join, "r0", 0);
  assert.equal(first.length, 4, "配对数组与 response.toolCalls 严格同长度");
  assert.deepEqual(
    first.map((info) => info.status),
    ["ok", "error", "missing", "missing"],
  );
  // part 原样引用（渲染侧直接消费同一对象）。
  assert.equal(first[0]?.part, callOk);
  assert.equal(first[0]?.pairedResultText, "内容A");
  assert.equal(first[1]?.pairedResultText, "命令失败", "error 的结果文本取真实错误文本");
  assert.equal(first[2]?.pairedResultText, "");
  assert.equal(first[3]?.pairedResultText, "");

  const middle = infos(join, "r1", 1);
  assert.deepEqual(middle, [], "无 toolCalls 的 record 配对信息为空数组");

  const last = infos(join, "r2", 2);
  assert.deepEqual(
    last.map((info) => info.status),
    ["pending", "pending"],
  );
  assert.equal(last[0]?.pairedResultText, "");
});

test("T-N1 ① 被放弃 attempt 的未配对 call 判 missing，末条 attempt 判 pending", () => {
  const records = [
    record({
      requestId: "req",
      attempt: 1,
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [toolCall("call_abandoned", "read", "读")],
    }),
    record({
      requestId: "req",
      attempt: 2,
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [toolCall("call_retry", "read", "读")],
    }),
  ];

  const join = joinTrajectoryToolResults(records);

  assert.deepEqual(
    infos(join, "req", 0).map((info) => info.status),
    ["missing"],
  );
  assert.deepEqual(
    infos(join, "req", 1).map((info) => info.status),
    ["pending"],
  );
});

// ── T-N1 ② 孤立结果 / 跨记录配对集合 ───────────────────────────────────────

test("T-N1 ② 跨记录配对：call 在 record N、result 在 record N+1 时 N+1 的集合含该 id", () => {
  const records = [
    record({
      requestId: "r0",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [callOk],
    }),
    record({
      requestId: "r1",
      messages: [textMessage("user", "问"), { role: "tool", parts: [resultOk] }],
      messageCount: 2,
      toolCalls: [],
    }),
  ];

  const join = joinTrajectoryToolResults(records);

  assert.equal(infos(join, "r0", 0)[0]?.status, "ok");
  const pairedInR1 = join.pairedResultToolCallIds.get(trajectoryCallKey("r1", 1));
  assert.equal(pairedInR1?.has("call_ok"), true, "N+1 的消息里的 result 被消费 → 入集合");
  const pairedInR0 = join.pairedResultToolCallIds.get(trajectoryCallKey("r0", 0));
  assert.equal(pairedInR0?.has("call_ok"), false, "N 自己的消息里没有 result → 集合为空");
});

test("T-N1 ② 孤立 result（有结果无调用）不剔除：不入配对集合、行照旧保留", () => {
  const orphanResult = toolResult("call_orphan", "没人消费的结果", "read");
  const records = [
    record({
      requestId: "r0",
      messages: [textMessage("user", "问"), { role: "tool", parts: [orphanResult] }],
      messageCount: 2,
      toolCalls: [],
    }),
  ];

  const join = joinTrajectoryToolResults(records);
  const paired = join.pairedResultToolCallIds.get(trajectoryCallKey("r0", 0));
  assert.equal(paired?.has("call_orphan"), false, "没有任何 call 消费 → 不入配对集合");
  assert.equal(paired?.size, 0);
});

// ── T-N1 ③ 剔除谓词 ───────────────────────────────────────────────────────

test("T-N1 ③ 剔除谓词：全部 part 都是已配对 result 才整行剔除，其余一律保留", () => {
  const resultNoId = toolResult(undefined, "没有 id 的结果", "read");
  const pairedIds = new Set(["call_ok"]);
  const rows: TrajectoryWireRow<ZCodeModelTrajectoryMessage>[] = [
    // 整行都是已配对 result → 剔除
    { message: { role: "tool", parts: [resultOk] }, messageIndex: 0, placeholder: false },
    // 孤立 result → 保留
    {
      message: { role: "tool", parts: [toolResult("call_orphan", "孤立")] },
      messageIndex: 1,
      placeholder: false,
    },
    // 混合：已配对 + 未配对 → 整行保留
    {
      message: { role: "tool", parts: [resultOk, toolResult("call_orphan", "孤立")] },
      messageIndex: 2,
      placeholder: false,
    },
    // 含 text part → 保留
    {
      message: { role: "tool", parts: [resultOk, { kind: "text", text: "补充" }] },
      messageIndex: 3,
      placeholder: false,
    },
    // result 无 id → 保留
    { message: { role: "tool", parts: [resultNoId] }, messageIndex: 4, placeholder: false },
  ];

  const { visibleRows, pairedRemovedCount } = filterTrajectoryInputRows(rows, pairedIds);

  assert.equal(pairedRemovedCount, 1);
  assert.deepEqual(
    visibleRows.map((row) => row.messageIndex),
    [1, 2, 3, 4],
  );
  // 不改动入参行数组本身（剔除只发生在产物上）。
  assert.equal(rows.length, 5);
});

test("T-N1 ③ 无配对集合时行全部保留", () => {
  const rows: TrajectoryWireRow<ZCodeModelTrajectoryMessage>[] = [
    { message: { role: "tool", parts: [resultOk] }, messageIndex: 0, placeholder: false },
  ];
  const { visibleRows, pairedRemovedCount } = filterTrajectoryInputRows(rows, new Set());
  assert.equal(pairedRemovedCount, 0);
  assert.deepEqual(
    visibleRows.map((row) => row.messageIndex),
    [0],
  );
});

// ── T-N1 ④ 多 result part 不串文本 / id 缺失不入 map ──────────────────────

test("T-N1 ④ 一条消息多个 result part：按 part 配对，文本互不串联", () => {
  const resultA = toolResult("call_a", "文本A", "read");
  const resultB = toolResult("call_b", "文本B", "write");
  const records = [
    record({
      requestId: "r0",
      messages: [textMessage("user", "问"), { role: "tool", parts: [resultA, resultB] }],
      messageCount: 2,
      toolCalls: [toolCall("call_a", "read", "读"), toolCall("call_b", "write", "写")],
    }),
  ];

  const join = joinTrajectoryToolResults(records);
  const paired = infos(join, "r0", 0);

  assert.equal(paired[0]?.pairedResultText, "文本A");
  assert.equal(paired[1]?.pairedResultText, "文本B");
});

test("T-N1 ④ id 缺失不入 map：无 id 的 call 永远配不上，无 id 的 result 不被消费", () => {
  const resultNoId = toolResult(undefined, "没有 id 的结果", "read");
  const records = [
    record({
      requestId: "r0",
      messages: [textMessage("user", "问"), { role: "tool", parts: [resultNoId] }],
      messageCount: 2,
      toolCalls: [callNoId],
    }),
    // 追加一条尾部 record，使 r0 不是尾部（未配对 → missing 而非 pending）。
    record({
      requestId: "r1",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [],
    }),
  ];

  const join = joinTrajectoryToolResults(records);
  const paired = infos(join, "r0", 0);

  assert.equal(paired[0]?.status, "missing");
  assert.equal(paired[0]?.pairedResultText, "");
  const pairedIds = join.pairedResultToolCallIds.get(trajectoryCallKey("r0", 0));
  assert.equal(pairedIds?.size, 0, "无 id 的 result 不入配对集合");
});

// ── T-N1 ⑤ key 家族迁移后逐字同值 ────────────────────────────────────────

test("T-N1 ⑤ key 家族迁移后逐字同值（call key / input row key / tool-call target key）", () => {
  // 迁移前的旧模板（逐字照抄），迁移后必须完全一致。
  assert.equal(trajectoryCallKey("req-1", 7), `${"req-1"}:${7}`);
  assert.equal(trajectoryInputRowKey("req-1:7", 3), `${"req-1:7"}:input:${3}`);
  // 旧 PaneParts 模板：${expansionKeyPrefix}:output:${toolCall.kind}:${toolCallIndex}
  const expansionKeyPrefix = trajectoryCallKey("req-1", 7);
  const toolCallIndex = 0;
  assert.equal(
    trajectoryToolCallTargetKey(expansionKeyPrefix, callOk.kind, toolCallIndex),
    `${expansionKeyPrefix}:output:${callOk.kind}:${toolCallIndex}`,
  );
  // 旧 Search 模板：${item.key}:output:${toolCall.kind}:${toolCallIndex}
  assert.equal(
    trajectoryToolCallTargetKey("req-1:7", "tool-call", 0),
    `${"req-1:7"}:output:${"tool-call"}:${0}`,
  );
  // Turns.ts 的 re-export 与 ToolJoin 是同一个函数（引用点零改、值逐字同）。
  assert.equal(turnsCallKey, trajectoryCallKey);
});

// ── T-N1 ⑥ displayText 拼接 ──────────────────────────────────────────────

test("T-N1 ⑥ displayText：use 段 + 结果段，空结果不拼分隔符", () => {
  const withResult = trajectoryToolCallDisplayText({
    part: callOk,
    status: "ok",
    pairedResultText: "内容A",
  });
  assert.equal(withResult, `读 a.txt\n\n内容A`);

  const withoutResult = trajectoryToolCallDisplayText({
    part: callOk,
    status: "pending",
    pairedResultText: "",
  });
  assert.equal(withoutResult, "读 a.txt");
  assert.equal(withoutResult.endsWith("\n\n"), false, "空结果不拼分隔符");

  // unknown 条目回退：没有 use 段时只给结果文本（不产生前导分隔符）。
  assert.equal(
    trajectoryToolCallDisplayText({ part: unknownNoId, status: "missing", pairedResultText: "" }),
    "",
  );
});

// ── T-N1 ⑦ delta 场景不误判 ──────────────────────────────────────────────

test("T-N1 ⑦ delta 投影为空时仍能配对：join 只用完整 request.messages", () => {
  const records = [
    record({
      requestId: "r0",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [callOk],
    }),
    record({
      requestId: "r1",
      // messageCount 与上一条相同 → 增量投影为空数组（delta 场景）。
      messages: [textMessage("user", "问"), { role: "tool", parts: [resultOk] }],
      messageCount: 1,
      toolCalls: [],
    }),
  ];

  const delta = computeDeltaMessages({
    record: records[1]!,
    index: 1,
    previousConversationMessageCount: 1,
  });
  assert.deepEqual(delta, [], "该场景的增量投影确实为空");

  const join = joinTrajectoryToolResults(records);
  assert.equal(
    infos(join, "r0", 0)[0]?.status,
    "ok",
    "join 走完整 messages，不因 delta 为空而误判 missing",
  );
  const pairedInR1 = join.pairedResultToolCallIds.get(trajectoryCallKey("r1", 1));
  assert.equal(pairedInR1?.has("call_ok"), true);
});
