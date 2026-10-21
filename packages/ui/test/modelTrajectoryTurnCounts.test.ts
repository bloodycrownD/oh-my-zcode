/**
 * 轨迹回合计数与计数行段序列的单测（spec Step 2 / N-7 / T-N5 / T-N6）。
 *
 * 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入（tsx 下别名不可解析），
 * 只允许相对路径与 `@zcode/*` 包名（先例 modelTrajectoryTurns.test.ts:7-28）。
 *
 * fixture 自带最小构造（不跨文件共享）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
} from "@zcode/services";
import {
  formatTurnCounts,
  resolveTrajectoryTurnCounts,
  type TrajectoryTurnCountSegment,
} from "../src/ModelTrajectoryTurnCounts.js";
import type { TrajectoryTurnGroup, TrajectoryTurnStats } from "../src/ModelTrajectoryTurns.js";
import {
  resolveTrajectoryTurnGroups,
  stripTrajectoryReasoning,
} from "../src/ModelTrajectoryTurns.js";

let requestSeq = 0;

function textMessage(role: string, text: string): ZCodeModelTrajectoryMessage {
  return { role, parts: [{ kind: "text", text }] };
}

function toolCallPart(
  toolCallId: string | undefined,
  toolName: string,
  input: unknown,
): ZCodeModelTrajectoryContentPart {
  return { kind: "tool-call", toolCallId, toolName, input };
}

function toolResultPart(
  toolCallId: string,
  output: unknown,
  toolName?: string,
): ZCodeModelTrajectoryContentPart {
  return { kind: "tool-result", toolCallId, toolName, output };
}

/** 未知形态的 part（services 可能产出，join 保留原样，不计入工具调用数）。 */
const unknownPart: ZCodeModelTrajectoryContentPart = { kind: "unknown", raw: { legacy: true } };

function record(spec: {
  turnId?: string;
  requestId?: string;
  kind?: ZCodeModelTrajectoryCallSourceKind;
  messages: ZCodeModelTrajectoryMessage[];
  messageCount?: number;
  /** response 是否存在；false 时整条 response 缺失（response undefined 场景）。 */
  withResponse?: boolean;
  responseText?: string;
  reasoningText?: string;
  toolCalls?: ZCodeModelTrajectoryContentPart[];
  durationMs?: number;
  error?: boolean;
}): ZCodeModelTrajectoryRecord {
  requestSeq += 1;
  const hasResponse = spec.withResponse ?? true;
  const response = hasResponse
    ? {
        text: spec.responseText,
        reasoningText: spec.reasoningText,
        toolCalls: spec.toolCalls ?? [],
      }
    : undefined;
  return {
    requestId: spec.requestId ?? `req-${requestSeq}`,
    attempt: 1,
    startedAt: "2026-10-21T00:00:00.000Z",
    completedAt: "2026-10-21T00:00:02.000Z",
    durationMs: spec.durationMs ?? 1_000,
    turnId: spec.turnId,
    callSource: { kind: spec.kind ?? "main" },
    model: { modelId: "test-model" },
    request: {
      messages: spec.messages,
      toolNames: [],
      ...(spec.messageCount === undefined ? {} : { messageCount: spec.messageCount }),
      croppedCount: 0,
    },
    response,
    ...(spec.error ? { error: { name: "Error", message: "boom" } } : {}),
  };
}

function groupAt(groups: readonly TrajectoryTurnGroup[], index: number): TrajectoryTurnGroup {
  const group = groups[index];
  assert.ok(group, `缺少第 ${index} 个回合分组`);
  return group;
}

function stats(spec: {
  callCount: number;
  durationMs: number;
  sourceKinds: ZCodeModelTrajectoryCallSourceKind[];
  errorCount?: number;
}): TrajectoryTurnStats {
  return {
    callCount: spec.callCount,
    durationMs: spec.durationMs,
    sourceKinds: spec.sourceKinds,
    errorCount: spec.errorCount ?? 0,
  };
}

// ── T-N5 ① toolCallCount：kind 过滤计数（含 response undefined 与 unknown 条目） ──

test("T-N5 ① toolCallCount：只数 kind==='tool-call'，response undefined 与 unknown 条目不计", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "t1",
      requestId: "r1",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [
        toolCallPart("call_a", "read", "读 a.txt"),
        toolCallPart("call_b", "write", "写 b.txt"),
        unknownPart,
      ],
    }),
    // response 缺失的调用：工具调用数为 0（join 给出空数组）。
    record({
      turnId: "t1",
      requestId: "r2",
      messages: [textMessage("user", "问")],
      messageCount: 2,
      withResponse: false,
    }),
  ]);

  const group = groupAt(groups, 0);
  const before = group.calls[0]?.toolCalls.length;
  const counts = resolveTrajectoryTurnCounts(group);

  assert.equal(counts.toolCallCount, 2, "unknown 条目不计入工具调用数");
  assert.equal(group.calls[0]?.toolCalls.length, before, "计数过滤不动数组：toolCalls 条目数不变");
  assert.equal(group.calls[0]?.toolCalls.length, 3, "unknown 条目仍原样保留在数组里");
});

// ── T-N5 ② charCount：输出侧三分量公式 ──

test("T-N5 ② charCount：text + reasoningText + use 段（join 分隔符计入，不 trim）", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "t1",
      requestId: "r1",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      responseText: "  回答  ",
      reasoningText: "思考",
      toolCalls: [toolCallPart("call_a", "read", "abc"), toolCallPart("call_b", "write", "de")],
    }),
    // response 存在但 text / reasoningText 均缺失 → 两项按 0 计。
    record({
      turnId: "t1",
      requestId: "r2",
      messages: [textMessage("user", "问")],
      messageCount: 2,
      toolCalls: [],
    }),
  ]);

  const counts = resolveTrajectoryTurnCounts(groupAt(groups, 0));

  // "  回答  " 长度 6（不 trim）+ "思考" 长度 2 + use 段 "abc\n\nde" 长度 7
  assert.equal(counts.charCount, 6 + 2 + 7);
});

test("T-N5 ② charCount 随 reasoning 投影变化（关闭思考过程后字数相应减小）", () => {
  const records = [
    record({
      turnId: "t1",
      requestId: "r1",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      responseText: "回答",
      reasoningText: "思考过程",
    }),
  ];

  const withReasoning = resolveTrajectoryTurnCounts(
    groupAt(resolveTrajectoryTurnGroups(records), 0),
  );
  const withoutReasoning = resolveTrajectoryTurnCounts(
    groupAt(resolveTrajectoryTurnGroups(stripTrajectoryReasoning(records)), 0),
  );

  assert.equal(withReasoning.charCount, 2 + 4);
  assert.equal(withoutReasoning.charCount, 2);
});

// ── T-N5 ③ failureCount：modelErrorCount + toolErrorCount ──

test("T-N5 ③ failureCount：模型报错数与工具报错数拆分并合计", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "t1",
      requestId: "r1",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [toolCallPart("call_err", "bash", "ls")],
    }),
    // 结果在下一条 record 的 request.messages 里（跨记录 join），输出是结构化错误。
    record({
      turnId: "t1",
      requestId: "r2",
      messages: [
        textMessage("user", "问"),
        {
          role: "tool",
          parts: [toolResultPart("call_err", { type: "error-text", value: "命令失败" }, "bash")],
        },
      ],
      messageCount: 2,
    }),
    record({
      turnId: "t1",
      requestId: "r3",
      messages: [textMessage("user", "问")],
      messageCount: 3,
      error: true,
    }),
  ]);

  const counts = resolveTrajectoryTurnCounts(groupAt(groups, 0));

  assert.equal(counts.modelErrorCount, 1, "record.error 真值条数");
  assert.equal(counts.toolErrorCount, 1, "配对状态 error 的条目数");
  assert.equal(counts.failureCount, 2, "failureCount = 两者之和");
});

// ── T-N5 ④ sidecar 排除与全 sidecar 回退 ──

test("T-N5 ④ sidecar 调用不进 counts；全 sidecar 回合回退为全部调用", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "t1",
      requestId: "r1",
      messages: [textMessage("user", "问")],
      messageCount: 1,
      toolCalls: [toolCallPart("call_main", "read", "读")],
    }),
    // sidecar（标题生成等辅助调用）：工具调用与错误都不进 counts。
    record({
      turnId: "t1",
      requestId: "r2",
      kind: "sidecar",
      messages: [textMessage("user", "问")],
      messageCount: 2,
      toolCalls: [
        toolCallPart("call_side_1", "read", "读"),
        toolCallPart("call_side_2", "write", "写"),
      ],
      error: true,
    }),
    // 整个回合都是 sidecar：回退为全部调用（不排除任何一条）。
    record({
      turnId: "t2",
      requestId: "r3",
      kind: "sidecar",
      messages: [textMessage("user", "问")],
      messageCount: 3,
      toolCalls: [toolCallPart("call_only_side", "read", "读")],
      error: true,
    }),
  ]);

  const mixed = resolveTrajectoryTurnCounts(groupAt(groups, 0));
  assert.equal(mixed.toolCallCount, 1, "sidecar 的工具调用不进 counts");
  assert.equal(mixed.modelErrorCount, 0, "sidecar 的 error 不进 counts");
  assert.equal(mixed.failureCount, 0);

  const allSidecar = resolveTrajectoryTurnCounts(groupAt(groups, 1));
  assert.equal(allSidecar.toolCallCount, 1, "全 sidecar 回退为全部调用");
  assert.equal(allSidecar.modelErrorCount, 1);
  assert.equal(allSidecar.failureCount, 1);
});

// ── T-N6 formatTurnCounts 段序列逐字锁定 ──

test("T-N6 段序列：全字段齐备时逐段锁定（含 duration 字符串段与每来源一段）", () => {
  const segments = formatTurnCounts(
    stats({ callCount: 3, durationMs: 1_500, sourceKinds: ["main", "sidecar"] }),
    {
      toolCallCount: 2,
      charCount: 42,
      failureCount: 1,
      modelErrorCount: 1,
      toolErrorCount: 0,
    },
  );

  assert.deepEqual(segments, [
    { id: "modelTrajectory.summaryCalls", values: { count: 3 } },
    { id: "modelTrajectory.turn.toolCalls", values: { count: 2 } },
    { id: "modelTrajectory.turn.charCount", values: { count: 42 } },
    { id: "modelTrajectory.turn.failureCount", values: { count: 1 } },
    "1.50s",
    { id: "modelTrajectory.source.main" },
    { id: "modelTrajectory.source.sidecar" },
  ]);
});

test("T-N6 段序列：工具 0 / 失败 0 / 时长 0 / 无来源时对应段省略", () => {
  const segments = formatTurnCounts(stats({ callCount: 1, durationMs: 0, sourceKinds: [] }), {
    toolCallCount: 0,
    charCount: 0,
    failureCount: 0,
    modelErrorCount: 0,
    toolErrorCount: 0,
  });

  assert.deepEqual(segments, [
    { id: "modelTrajectory.summaryCalls", values: { count: 1 } },
    { id: "modelTrajectory.turn.charCount", values: { count: 0 } },
  ]);
});

test("T-N6 段序列：多来源每来源一段，保持首次出现顺序", () => {
  const segments = formatTurnCounts(
    stats({ callCount: 4, durationMs: 250, sourceKinds: ["subagent", "main", "sidecar"] }),
    {
      toolCallCount: 1,
      charCount: 7,
      failureCount: 0,
      modelErrorCount: 0,
      toolErrorCount: 0,
    },
  );

  const sourceIds = segments
    .filter((segment): segment is { id: string } => typeof segment !== "string")
    .map((segment) => segment.id)
    .filter((id) => id.startsWith("modelTrajectory.source."));
  assert.deepEqual(sourceIds, [
    "modelTrajectory.source.subagent",
    "modelTrajectory.source.main",
    "modelTrajectory.source.sidecar",
  ]);
});

test("T-N6 段序列：时长段是原样字符串（非 i18n 段），毫秒与秒两种形态", () => {
  const segments: TrajectoryTurnCountSegment[] = formatTurnCounts(
    stats({ callCount: 1, durationMs: 800, sourceKinds: ["main"] }),
    {
      toolCallCount: 0,
      charCount: 0,
      failureCount: 0,
      modelErrorCount: 0,
      toolErrorCount: 0,
    },
  );

  // 段序：summaryCalls → charCount → 时长字符串段 → 来源段。
  assert.equal(segments[2], "800ms");
  assert.equal(typeof segments[2], "string");
});
