/**
 * 轨迹回合聚合与输入增量投影的单测（spec Step 6 / B-1 B-2 B-3，T-T3/T-T4/T-T5/T-T8/T-T9）。
 *
 * 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入（tsx 下别名不可解析），
 * 只允许相对路径与 `@zcode/*` 包名（先例 conversationTurnRenderUnits.test.ts:11-13）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
} from "@zcode/services";
import { DEFAULT_MAX_PREVIEW_CHARS } from "@zcode/shared/zcode-protocol-v4";
import { buildTrajectorySearchIndex } from "../src/ModelTrajectorySearch.js";
import type { TrajectoryTurnGroup } from "../src/ModelTrajectoryTurns.js";
import {
  computeDeltaMessages,
  isTrajectoryRealUserMessage,
  resolveTrajectoryInputMessages,
  resolveTrajectorySearchItems,
  resolveTrajectoryTurnGroups,
  shouldUseConversationDelta,
  stripTrajectoryReasoning,
  TRAJECTORY_EMPTY_USER_PREVIEW,
  trajectoryCallKey,
  trajectoryInputRowKey,
} from "../src/ModelTrajectoryTurns.js";

let requestSeq = 0;

function textMessage(role: string, text: string): ZCodeModelTrajectoryMessage {
  return { role, parts: [{ kind: "text", text }] };
}

function numberedMessages(
  count: number,
  role = "user",
  startIndex = 0,
): ZCodeModelTrajectoryMessage[] {
  return Array.from({ length: count }, (_, offset) => textMessage(role, `m${startIndex + offset}`));
}

function record(spec: {
  turnId?: string;
  requestId?: string;
  kind?: ZCodeModelTrajectoryCallSourceKind;
  messages: ZCodeModelTrajectoryMessage[];
  messageCount?: number;
  responseText?: string;
  reasoningText?: string;
  durationMs?: number;
  error?: boolean;
}): ZCodeModelTrajectoryRecord {
  requestSeq += 1;
  const response =
    spec.responseText === undefined && spec.reasoningText === undefined
      ? undefined
      : { text: spec.responseText, reasoningText: spec.reasoningText, toolCalls: [] };
  return {
    requestId: spec.requestId ?? `req-${requestSeq}`,
    attempt: 1,
    startedAt: "2026-10-19T00:00:00.000Z",
    completedAt: "2026-10-19T00:00:02.000Z",
    durationMs: spec.durationMs ?? 1_200,
    turnId: spec.turnId,
    callSource: { kind: spec.kind ?? "main" },
    model: { modelId: "test-model" },
    request: {
      messages: spec.messages,
      toolNames: [],
      // full-retention 记录（全量直写分支）不带压缩元数据：缺失 messageCount 才是被测分支。
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

function messageTexts(messages: readonly ZCodeModelTrajectoryMessage[]): string[] {
  return messages.map((message) =>
    message.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join(""),
  );
}

// ── T-T3 回合分组 ──────────────────────────────────────────────────────────

test("T-T3 按 turnId 稳定分组：同轮多 call 合并、sidecar 并入、fallback 独立成组", () => {
  const u1 = textMessage("user", "第一个问题");
  const a1 = textMessage("assistant", "第一个回答");
  const steer = textMessage("user", "§9§ 补充一句");
  const u2 = textMessage("user", "第二个问题");
  const a2 = textMessage("assistant", "第二个回答");

  const records = [
    record({
      turnId: "turn-a",
      requestId: "r1",
      messages: [u1],
      messageCount: 1,
      responseText: "先查资料",
    }),
    record({
      turnId: "turn-a",
      requestId: "r2",
      messages: [u1, a1, steer],
      messageCount: 3,
      responseText: "第一个回答",
    }),
    // sidecar（标题生成）与主轮同 turnId：并入同一回合，而不是单独成组。
    record({
      turnId: "turn-a",
      requestId: "r3",
      kind: "sidecar",
      messages: [u1, a1],
      messageCount: 2,
      responseText: "标题",
    }),
    record({
      turnId: "turn-b",
      requestId: "r4",
      messages: [u1, a1, steer, textMessage("assistant", "完成补充"), u2, a2],
      messageCount: 6,
      responseText: "第二个回答",
    }),
    record({ requestId: "fallback-a", messages: [u1], messageCount: 1 }),
    record({ requestId: "fallback-b", messages: [u2], messageCount: 1 }),
  ];

  const groups = resolveTrajectoryTurnGroups(records);

  assert.deepEqual(
    groups.map((group) => group.key),
    ["turn:turn-a", "turn:turn-b", "turn:fallback:fallback-a", "turn:fallback:fallback-b"],
  );
  assert.deepEqual(
    groups.map((group) => group.turnId),
    ["turn-a", "turn-b", null, null],
  );
  assert.deepEqual(
    groups.map((group) => group.turnIndex),
    [0, 1, 2, 3],
  );

  const [turnA, turnB] = [groupAt(groups, 0), groupAt(groups, 1)];
  assert.deepEqual(
    turnA.calls.map((call) => call.recordIndex),
    [0, 1, 2],
  );
  assert.deepEqual(
    turnA.calls.map((call) => call.callIndexInTurn),
    [0, 1, 2],
  );
  assert.equal(turnA.calls[0]?.record, records[0]);
  assert.deepEqual(turnA.stats, {
    callCount: 3,
    durationMs: 3_600,
    sourceKinds: ["main", "sidecar"],
    errorCount: 0,
    startedAt: "2026-10-19T00:00:00.000Z",
    completedAt: "2026-10-19T00:00:02.000Z",
  });

  // 回合预览取本回合第一条真实用户输入；sidecar 的完整上下文不会把上一轮输入带进来。
  assert.equal(turnA.userPreviewKind, "user");
  assert.equal(turnA.userPreview, "第一个问题");
  assert.equal(turnB.userPreview, "第二个问题");
  assert.equal(turnB.assistantPreview, "第二个回答");

  // 每条调用携带按全局链算好的可见输入：首条全量，后续只留新增里的非 assistant。
  assert.deepEqual(messageTexts(turnA.calls[0]?.inputMessages ?? []), ["第一个问题"]);
  assert.deepEqual(messageTexts(turnA.calls[1]?.inputMessages ?? []), ["§9§ 补充一句"]);

  // fallback key 唯一且刷新稳定（同一份数据重复计算得到同一组 key）。
  const keys = groups.map((group) => group.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    resolveTrajectoryTurnGroups(records).map((group) => group.key),
    keys,
  );
});

test("T-T3 无 turnId 的记录即使 requestId 重复也各自独立成组，key 仍唯一", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({ requestId: "dup", messages: [textMessage("user", "第一条")], messageCount: 1 }),
    record({ requestId: "dup", messages: [textMessage("user", "第二条")], messageCount: 1 }),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.calls.length),
    [1, 1],
  );
  assert.notEqual(groups[0]?.key, groups[1]?.key);
  assert.equal(groups[0]?.key, "turn:fallback:dup");
  assert.equal(groups[1]?.key, "turn:fallback:dup#1");
});

// ── T-T4 真实用户输入与预览 ────────────────────────────────────────────────

test("T-T4 真实用户输入判定：注入包裹/通知前缀排除、§N§ 剥离", () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["user", "真实问题", true],
    ["user", "§12§ 真实问题", true],
    ["user", "§3§<system-reminder>上下文</system-reminder>", false],
    ["user", '<system-reminder source="goal-continuation">继续</system-reminder>', false],
    ["user", "<task-notification>任务完成</task-notification>", false],
    ["user", "<subagent-notification>子代理完成</subagent-notification>", false],
    ["user", "<session-history>\n§1§ 历史段落\n</session-history>", false],
    ["user", "§4§ <session-history-since>增量</session-history-since>", false],
    ["user", "<project-memory>\n- 结论\n</project-memory>", false],
    ["user", '<new-compartments><new-compartment id="1" /></new-compartments>', false],
    ["user", "[dropped §7§]", false],
    ["assistant", "真实问题", false],
    ["user", "   ", false],
  ];

  for (const [role, text, expected] of cases) {
    assert.equal(
      isTrajectoryRealUserMessage(textMessage(role, text)),
      expected,
      `${role} ${JSON.stringify(text)}`,
    );
  }
});

test("T-T4 回合预览：跳过注入形态、按 buildPreviewText 口径截断", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "t1",
      messages: [
        textMessage("user", "§1§ <system-reminder>工作区提醒</system-reminder>"),
        textMessage("user", "<session-history>上一段历史</session-history>"),
        textMessage("user", `<project-memory>项目记忆</project-memory>`),
        textMessage("user", `<new-compartments>新隔间</new-compartments>`),
        textMessage("user", `§2§ ${"长".repeat(500)}`),
      ],
      messageCount: 5,
      responseText: "回答",
    }),
  ]);

  const group = groupAt(groups, 0);
  assert.equal(group.userPreviewKind, "user");
  assert.equal(group.userPreview, `${"长".repeat(DEFAULT_MAX_PREVIEW_CHARS - 3)}...`);
});

test("T-T4 回合预览：空白折叠为单空格、最多两段", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "t1",
      messages: [textMessage("user", "hello   world\n\nsecond   paragraph\n\nthird\n\ndropped")],
      messageCount: 1,
    }),
  ]);

  assert.equal(groupAt(groups, 0).userPreview, "hello world\nsecond paragraph");
});

test("T-T4 回合无真实 user：回落首条 assistant 文本，仍无则占位", () => {
  const records = [
    record({
      turnId: "t1",
      messages: [textMessage("user", "<session-history>历史</session-history>")],
      messageCount: 1,
      responseText: "assistant 的回答",
    }),
    record({
      turnId: "t2",
      messages: [textMessage("user", "<system-reminder>提醒</system-reminder>")],
      messageCount: 1,
    }),
  ];

  const groups = resolveTrajectoryTurnGroups(records);
  assert.equal(groupAt(groups, 0).userPreviewKind, "assistantFallback");
  assert.equal(groupAt(groups, 0).userPreview, "assistant 的回答");
  assert.equal(groupAt(groups, 1).userPreviewKind, "empty");
  assert.equal(groupAt(groups, 1).userPreview, TRAJECTORY_EMPTY_USER_PREVIEW);

  // 没有 response 文本时回落回合内首条 assistant 输入消息（首条记录可见全量消息）。
  const assistantInputOnly = resolveTrajectoryTurnGroups([
    record({
      turnId: "t3",
      messages: [textMessage("assistant", "上一条助手文本")],
      messageCount: 1,
    }),
  ]);
  assert.equal(groupAt(assistantInputOnly, 0).userPreviewKind, "assistantFallback");
  assert.equal(groupAt(assistantInputOnly, 0).userPreview, "上一条助手文本");

  const custom = resolveTrajectoryTurnGroups(records, { emptyUserPreview: "(no user input)" });
  assert.equal(groupAt(custom, 1).userPreview, "(no user input)");
});

// ── T-T5 reasoning 投影 ────────────────────────────────────────────────────

test("T-T5 reasoning 投影：删除 reasoningText 与 reasoning part，消息条数不变", () => {
  const reasoningPart = { kind: "reasoning" as const, text: "内心戏" };
  const mixedMessage: ZCodeModelTrajectoryMessage = {
    role: "assistant",
    parts: [{ kind: "text", text: "可见正文" }, reasoningPart],
  };
  const reasoningOnlyMessage: ZCodeModelTrajectoryMessage = {
    role: "assistant",
    parts: [reasoningPart],
  };
  const input = [
    record({
      turnId: "t1",
      messages: [textMessage("user", "问"), mixedMessage, reasoningOnlyMessage],
      messageCount: 3,
      responseText: "答",
      reasoningText: "思路",
    }),
    record({ turnId: "t2", messages: [textMessage("user", "第二问")], messageCount: 4 }),
  ];

  const stripped = stripTrajectoryReasoning(input);

  assert.equal(stripped[0]?.request.messages.length, 3);
  assert.equal("reasoningText" in (stripped[0]?.response ?? {}), false);
  assert.equal(stripped[0]?.response?.text, "答");
  assert.deepEqual(stripped[0]?.request.messages[1]?.parts, [{ kind: "text", text: "可见正文" }]);
  // 只过滤 part 不删 message：没有其他 part 的消息保留为空 parts。
  assert.deepEqual(stripped[0]?.request.messages[2]?.parts, []);
  assert.equal(stripped[0]?.request.messages[2]?.role, "assistant");

  // 未命中的记录原样复用引用（开关切换不触发全量重建）。
  assert.equal(stripped[1], input[1]);
  // 输入不被改写。
  assert.equal(input[0]?.response?.reasoningText, "思路");
  assert.equal(input[0]?.request.messages[1]?.parts.length, 2);
});

// ── T-T8 delta 判据矩阵 ────────────────────────────────────────────────────

test("T-T8 delta 判据矩阵：main/subagent → delta，sidecar/unknown → full", () => {
  const matrix: ReadonlyArray<readonly [ZCodeModelTrajectoryCallSourceKind | undefined, boolean]> =
    [
      [undefined, true],
      ["main", true],
      ["subagent", true],
      ["sidecar", false],
      // 现实现的显式白名单：unknown 与 sidecar 一样完整展示（classifyCallSource 当前不产出
      // 该值，保留白名单是防未来来源被误套主会话 delta）。
      ["unknown", false],
    ];
  for (const [kind, expected] of matrix) {
    assert.equal(
      shouldUseConversationDelta(record({ kind, messages: [], messageCount: 0 })),
      expected,
      String(kind),
    );
  }

  const messages = numberedMessages(12);
  const main = resolveTrajectoryInputMessages({
    record: record({ kind: "main", messages, messageCount: 12 }),
    index: 3,
    previousConversationMessageCount: 10,
  });
  assert.equal(main.inputMessages.length, 2);
  assert.equal(main.nextConversationMessageCount, 12);

  const subagent = resolveTrajectoryInputMessages({
    record: record({ kind: "subagent", messages, messageCount: 12 }),
    index: 3,
    previousConversationMessageCount: 7,
  });
  assert.equal(subagent.inputMessages.length, 5);
  assert.equal(subagent.nextConversationMessageCount, 12);

  const sidecar = resolveTrajectoryInputMessages({
    record: record({ kind: "sidecar", messages, messageCount: 12 }),
    index: 3,
    previousConversationMessageCount: 7,
  });
  // 独立 prompt 完整展示，且不推进主会话的消息数链。
  assert.equal(sidecar.inputMessages, messages);
  assert.equal(sidecar.nextConversationMessageCount, 7);
});

// ── T-T9 调用序列增量（全局 prevCount 链） ─────────────────────────────────

test("T-T9 ① 正向平移：computeDeltaMessages 恰 curr−prev 条，resolve 去 assistant 后 = N−1", () => {
  const nextMessages = numberedMessages(110);
  nextMessages[107] = textMessage("assistant", "m107");
  const current = record({ turnId: "t1", messages: nextMessages, messageCount: 110 });

  const delta = computeDeltaMessages({
    record: current,
    index: 1,
    previousConversationMessageCount: 100,
  });
  assert.equal(delta.length, 10);
  assert.deepEqual(
    messageTexts(delta),
    Array.from({ length: 10 }, (_, offset) => `m${100 + offset}`),
  );

  const resolved = resolveTrajectoryInputMessages({
    record: current,
    index: 1,
    previousConversationMessageCount: 100,
  });
  assert.equal(resolved.inputMessages.length, 9); // 10 条新增里有 1 条 assistant
  assert.equal(resolved.nextConversationMessageCount, 110);

  // 首条记录展示磁盘上全部可见消息（head+tail），nextCount 用 messageCount 的全量口径。
  const firstResolved = resolveTrajectoryInputMessages({
    record: record({ turnId: "t0", messages: nextMessages, messageCount: 5_000 }),
    index: 0,
    previousConversationMessageCount: 0,
  });
  assert.equal(firstResolved.inputMessages.length, 110);
  assert.equal(firstResolved.nextConversationMessageCount, 5_000);

  // tail 窗口只留尾部若干条时，增量大过可见条数 → 负数切片退化为全部可见（不越界）。
  const tailOnly = record({
    turnId: "t2",
    messages: numberedMessages(8, "user", 502),
    messageCount: 510,
  });
  assert.equal(
    computeDeltaMessages({ record: tailOnly, index: 1, previousConversationMessageCount: 400 })
      .length,
    8,
  );
});

test("T-T9 ② 同计数重试：增量为空（锁定 slice(-0) 陷阱）", () => {
  const retry = record({ turnId: "t1", messages: numberedMessages(110), messageCount: 110 });

  assert.deepEqual(
    computeDeltaMessages({ record: retry, index: 5, previousConversationMessageCount: 110 }),
    [],
  );

  const resolved = resolveTrajectoryInputMessages({
    record: retry,
    index: 5,
    previousConversationMessageCount: 110,
  });
  assert.deepEqual(resolved.inputMessages, []);
  assert.equal(resolved.nextConversationMessageCount, 110);
});

test("T-T9 ③ 回合边界计数下降 234→182：整段展示 + prevCount 重置", () => {
  const boundaryMessages = numberedMessages(182);
  for (let index = 0; index < boundaryMessages.length; index += 10) {
    boundaryMessages[index] = textMessage("assistant", `m${index}`);
  }
  const boundary = record({ turnId: "t2", messages: boundaryMessages, messageCount: 182 });

  assert.equal(
    computeDeltaMessages({ record: boundary, index: 4, previousConversationMessageCount: 234 })
      .length,
    182,
  );

  const resolved = resolveTrajectoryInputMessages({
    record: boundary,
    index: 4,
    previousConversationMessageCount: 234,
  });
  assert.equal(resolved.inputMessages.length, 182 - 19); // 0,10,…,180 共 19 条 assistant 被过滤
  assert.equal(resolved.nextConversationMessageCount, 182);

  const next = resolveTrajectoryInputMessages({
    record: record({ turnId: "t2", messages: numberedMessages(190), messageCount: 190 }),
    index: 5,
    previousConversationMessageCount: resolved.nextConversationMessageCount,
  });
  assert.equal(next.inputMessages.length, 190 - 182); // 链从重置后的 182 继续
});

test("T-T9 ④ full-retention（无 messageCount）按可见条数走全量分支", () => {
  const fullMessages = numberedMessages(120);
  const full = record({ turnId: "t1", messages: fullMessages });

  assert.equal(
    computeDeltaMessages({ record: full, index: 0, previousConversationMessageCount: 0 }).length,
    120,
  );

  const first = resolveTrajectoryInputMessages({
    record: full,
    index: 0,
    previousConversationMessageCount: 0,
  });
  assert.equal(first.inputMessages.length, 120);
  assert.equal(first.nextConversationMessageCount, 120);

  const grown = resolveTrajectoryInputMessages({
    record: record({ turnId: "t1", messages: numberedMessages(126) }),
    index: 1,
    previousConversationMessageCount: 120,
  });
  assert.equal(grown.inputMessages.length, 6);

  const shrunk = record({ turnId: "t1", messages: numberedMessages(100) });
  assert.equal(
    computeDeltaMessages({ record: shrunk, index: 2, previousConversationMessageCount: 126 })
      .length,
    100,
  );
});

// ── C-1 搜索索引输入（自 Timeline.tsx 迁入纯函数区后直测） ──────────────────

test("C-1 搜索项按回合首现、回合内 recordIndex 升序展开（交错 turnId 不等于全局下标）", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "turn-a",
      requestId: "reqA",
      messages: [textMessage("user", "a0")],
      messageCount: 1,
    }),
    record({
      turnId: "turn-b",
      requestId: "reqB",
      messages: [textMessage("user", "b1")],
      messageCount: 2,
    }),
    record({
      turnId: "turn-a",
      requestId: "reqA",
      messages: [textMessage("user", "a2")],
      messageCount: 3,
    }),
  ]);

  const items = resolveTrajectorySearchItems(groups, false);

  // 分组按首现顺序：turn-a 先出现 → 它的两次调用（record 0/2）先展开，再是 record 1 的 turn-b。
  assert.deepEqual(
    items.map((item) => item.key),
    ["reqA:0", "reqA:2", "reqB:1"],
  );
  assert.deepEqual(
    items.map((item) => item.turnKey),
    ["turn:turn-a", "turn:turn-a", "turn:turn-b"],
  );
  assert.deepEqual(
    items.map((item) => item.turnIndex),
    [0, 0, 1],
  );
  assert.deepEqual(
    items.map((item) => item.callIndexInTurn),
    [0, 1, 0],
  );
});

test("B-2 搜索索引随占位过滤开关变化：隐藏时零命中，显示时命中且 key 等于渲染 expansionKey", () => {
  const groups = resolveTrajectoryTurnGroups([
    record({
      turnId: "t1",
      requestId: "req",
      messages: [
        textMessage("user", "问题"),
        textMessage("assistant", "[dropped §4§]"),
        textMessage("assistant", "回答"),
      ],
      messageCount: 3,
    }),
  ]);

  // 渲染默认隐藏占位行：索引里也不能有它，否则命中不在 DOM 的行（计数前进但画面不动）。
  const hiddenIndex = buildTrajectorySearchIndex(
    resolveTrajectorySearchItems(groups, true),
    "dropped",
  );
  assert.equal(hiddenIndex.matches.length, 0);

  // 打开「显示占位行」后命中；expansionKey 与 CallInputSection 渲染时用同一对 helper 生成。
  const shownItems = resolveTrajectorySearchItems(groups, false);
  const shownIndex = buildTrajectorySearchIndex(shownItems, "dropped");
  assert.equal(shownIndex.matches.length, 1);
  const match = shownIndex.matches[0];
  assert.ok(match);
  assert.equal(match.expansionKey, trajectoryInputRowKey(trajectoryCallKey("req", 0), 1));
  assert.equal(match.expansionKey, "req:0:input:1");
  assert.equal(match.turnKey, "turn:t1");
  assert.equal(match.turnIndex, 0);
});
