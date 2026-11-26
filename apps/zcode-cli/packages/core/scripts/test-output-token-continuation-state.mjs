#!/usr/bin/env node
/**
 * Step 6 / phase-continuation-input —— 输出续写的 turn 请求状态不变量。
 *
 * magic-context-trim-integrity 规格的问题二：core 的输出续写路径不得把 transform
 * 折叠后的请求条目写回 `state.turnRequestState.entries`（原 turn-model-step.ts:574）。
 * 写回会让下一次迭代以「折叠产物 + 追加条目」作为 transform 输入，位置整体前移后
 * tag 按位置字符串错位重绑，工具调用与结果的配对被打断，模型拒收请求。
 *
 * 本文件用最小 fake runtime 直接驱动 `runModelBackedTurnStep` 的续写分支，钉住三条
 * 不变量（spec「测试策略」问题二）：
 *   T-C1 —— 续写后 entries 的前缀逐项引用不变，末尾恰为 assistant + 续写 user 条目，
 *           且没有任何对象来自 options.messages（折叠产物投影哨兵，防「写回」复活）。
 *   T-C2 —— 调用前 entries 里的每个条目（含 request-only 附件）在调用后逐项引用相等
 *           （确认删除写回不会丢掉一次性附件）。
 *   T-C5 —— 模型部分输出为空且无 reasoning 时，entries 只追加续写 user 条目，
 *           不追加 assistant 条目，messageHistory 也不写入。
 *
 * 夹具要点（spec Step 6 须知 a-d）：
 *   (a) `runModelBackedTurnStep` 不经过 turn-loop 的 `startModelRequest`，而
 *       `receiveModelResponse` 要求状态机处于 `AwaitingModelResponse`（turn-state.ts
 *       的 phase 转移表），因此先把 `TurnMachineImpl` 预驱动：create → start →
 *       startModelRequest。
 *   (b) `config.taskType = "workflow_child"`：querySource 既非 main_turn 也非
 *       subagent（turn-model-step-usage.ts 的 querySourceForTask），绕开
 *       mainTurnCacheHitAggregate 与 currentTurnFileChanges 两个无关分支。
 *   (c) 不提供 `sessionStore`（undefined）：usageStoreFor 按它判定（usage-observability.ts），
 *       用量观测整体短路，T-C5 的空提交也走 `if (runtime.sessionStore)` 守卫。
 *   (d) `options.messages` 用与 entries 不相交的哨兵对象构造：生产里它是折叠产物的
 *       provider 投影。transform 对未改动条目元素级复用原对象是合法的，所以 T-C1 不以
 *       「messages 与 entries 无共同对象」为断言，只断言 entries 不含 messages 哨兵。
 *
 * 运行：`cmd /c pnpm --filter @zcode/core exec tsx --test scripts/test-output-token-continuation-state.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { runModelBackedTurnStep } = await import(
  new URL("../src/runtime/methods/turn-model-step.ts", import.meta.url).href
);
const { TurnMachineImpl } = await import(
  new URL("../src/agent/turn-machine.ts", import.meta.url).href
);
const { createRuntimeUserEntry } = await import(
  new URL("../src/agent/message-history.ts", import.meta.url).href
);

const SESSION_ID = "ses_output_token_continuation_state";
const TRACE = { traceId: "trace-output-token-continuation", spanId: "span-fixture", turnId: "turn-fixture" };
const MODEL = {
  providerId: "provider-fixture",
  modelId: "model-fixture",
  optionSpecs: { maxOutputTokens: { max: 32000 } },
  properties: { contextWindow: 200000 },
};
const CONTINUATION_PROMPT_MARKER = "Output token limit hit";

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 最小 fake runtime：只放续写分支真正触达的成员。`runModelTextRequest` 按用例返回
 * 固定结果（finishReason="length" + 0 工具调用 → classifyOutputTokenContinuation
 * 判为 "continue"，streaming coordinator 因无工具调用而保持惰性）。
 */
function createFakeRuntime({ modelResult }) {
  const calls = { addEntries: [], persistAssistantMessage: [], persistPart: [] };
  return {
    sessionId: SESSION_ID,
    config: { taskType: "workflow_child" },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    latestAssistantMessageId: "msg-anchor-assistant",
    latestAssistantTurnId: "turn-anchor",
    latestConversationMessageId: "msg-anchor-conversation",
    messageHistory: {
      addEntries(entries) {
        calls.addEntries.push(entries);
      },
    },
    logModelRequestSteeringContext() {},
    persistAssistantMessage: async (...args) => {
      calls.persistAssistantMessage.push(args);
    },
    persistPart: async (part) => {
      calls.persistPart.push(part);
    },
    createEvent: (type, payload) => ({ type, payload, timestamp: new Date(), sessionId: SESSION_ID }),
    appendEvent: async () => {},
    runModelTextRequest: async () => modelResult,
    extractToolCallsFromResult: (result) => result.toolCalls ?? [],
    calls,
  };
}

/** 预驱动状态机到 AwaitingModelResponse（须知 a），并构造 RegularTurnLoopState。 */
function createState({ entries, modelResult }) {
  const runtime = createFakeRuntime({ modelResult });
  let turnMachine = TurnMachineImpl.create(SESSION_ID, 1, "fixture-input", "trace-fixture", "turn-fixture");
  turnMachine = new TurnMachineImpl(turnMachine.start());
  turnMachine = new TurnMachineImpl(
    turnMachine.startModelRequest(`${MODEL.providerId}/${MODEL.modelId}`, []),
  );
  const state = {
    automationCreateLimitReached: false,
    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: false,
    workflowResultConsumed: false,
    currentUserMessageId: "msg-current-user",
    events: [],
    input: "fixture-input",
    model: MODEL,
    modelResponse: "",
    modelStepCount: 0,
    historyRoundCount: 0,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    turnRequestState: { entries, outputTokenContinuationCount: 0 },
    traceId: "trace-fixture",
    turnAbortSignal: new AbortController().signal,
    turnId: "turn-fixture",
    turnMachine,
    turnTraceContext: TRACE,
    userMessageId: "msg-user",
  };
  return { runtime, state };
}

/**
 * 驱动续写分支。`options.messages` 是与 entries 不相交的哨兵对象（须知 d）——
 * 生产里它就是折叠产物的 provider 投影（turn-loop 的 buildRuntimeProviderRequestMessages）。
 */
async function driveContinuation({ entries, modelResult }) {
  const { runtime, state } = createState({ entries, modelResult });
  const projectionSentinels = [
    { role: "user", content: "SENTINEL-folded-projection-0" },
    { role: "assistant", content: "SENTINEL-folded-projection-1" },
  ];
  const stepResult = await runModelBackedTurnStep.call(runtime, state, {
    messages: projectionSentinels,
    sourceEntries: [],
    recordedMessages: [],
    tools: [],
  });
  return { runtime, state, stepResult, projectionSentinels };
}

function nonEmptyUsage() {
  return { inputTokens: 120, outputTokens: 200, totalTokens: 320 };
}

function fixtureEntries({ attachment } = {}) {
  const entries = [createRuntimeUserEntry("第一条用户输入")];
  if (attachment) entries.push(attachment);
  entries.push(createRuntimeUserEntry("第二条用户输入"));
  return entries;
}

/** request-only 附件条目：T-C2 用它确认删除写回不会丢一次性附件。 */
function requestOnlyAttachment() {
  return {
    kind: "attachment",
    content: "REQUEST-ONLY-ATTACHMENT-MARKER",
    metadata: { source: "runtime_mode" },
  };
}

function assertPrefixByReference(entriesAfter, entriesBefore, label, expectedAppended) {
  // 期望追加条数由调用点显式传入：用 label 字符串推断分支，会让换了标签的新用例
  // 按错误的条数断言（CR-8）。
  assert.equal(entriesAfter.length, entriesBefore.length + expectedAppended, label);
  for (let i = 0; i < entriesBefore.length; i += 1) {
    assert.ok(
      entriesAfter[i] === entriesBefore[i],
      `${label}: entries[${i}] 必须与调用前逐项引用相等（写回折叠产物会破坏这一点）`,
    );
  }
}

// ── T-C1 ────────────────────────────────────────────────────────────────────

test("T-C1: 续写后 entries 前缀引用不变，尾部恰为 assistant + 续写条目，不含折叠投影哨兵", async () => {
  const entriesBefore = fixtureEntries();
  const partialText = "……被 output-limit 截断的部分输出";
  const { state, stepResult, projectionSentinels } = await driveContinuation({
    entries: entriesBefore,
    modelResult: {
      finishReason: "length",
      providerMetadata: {},
      text: partialText,
      usage: nonEmptyUsage(),
    },
  });

  assert.equal(stepResult, "output_continuation", "续写分支必须返回 output_continuation");
  const entriesAfter = state.turnRequestState.entries;
  assertPrefixByReference(entriesAfter, entriesBefore, "T-C1", 2);

  const assistantEntry = entriesAfter[entriesBefore.length];
  assert.equal(assistantEntry.message.role, "assistant", "倒数第二条是 assistant 条目");
  assert.ok(
    JSON.stringify(assistantEntry.message.content).includes(partialText),
    "assistant 条目携带非空部分输出",
  );

  const continuationEntry = entriesAfter[entriesBefore.length + 1];
  assert.equal(continuationEntry.message.role, "user", "末尾是续写 user 条目");
  assert.equal(
    continuationEntry.queryScope,
    "output_token_continuation",
    "续写条目必须带 output_token_continuation 作用域",
  );
  assert.ok(
    JSON.stringify(continuationEntry.message.content).includes(CONTINUATION_PROMPT_MARKER),
    "续写条目是 Output token limit 提示",
  );

  const sentinels = new Set(projectionSentinels);
  assert.ok(
    entriesAfter.every((entry) => !sentinels.has(entry)),
    "entries 里不得出现任何来自 options.messages 的对象（防「写回」复活的护栏）",
  );
});

// ── T-C2 ────────────────────────────────────────────────────────────────────

test("T-C2: 调用前的每个条目（含 request-only 附件）在续写后逐项引用相等", async () => {
  const attachment = requestOnlyAttachment();
  const entriesBefore = fixtureEntries({ attachment });
  const { state } = await driveContinuation({
    entries: entriesBefore,
    modelResult: {
      finishReason: "length",
      providerMetadata: {},
      text: "部分输出",
      usage: nonEmptyUsage(),
    },
  });

  const entriesAfter = state.turnRequestState.entries;
  // 前缀逐项引用相等（与 T-C1 同口径），并显式点名附件条目。
  for (let i = 0; i < entriesBefore.length; i += 1) {
    assert.ok(entriesAfter[i] === entriesBefore[i], `T-C2: entries[${i}] 引用相等`);
  }
  assert.ok(
    entriesAfter.includes(attachment),
    "request-only 附件条目必须以同一引用保留在 entries 里（不因删除写回而丢失）",
  );
  assert.equal(attachment.content, "REQUEST-ONLY-ATTACHMENT-MARKER", "附件内容不被改写");
  assert.ok(
    state.modelResponse.length > 0,
    "夹具前置确认：本用例的部分输出非空（空输出走 T-C5）",
  );
});

// ── T-C5 ────────────────────────────────────────────────────────────────────

test("T-C5: 部分输出为空且无 reasoning 时，entries 只追加续写条目、无 assistant 条目", async () => {
  const entriesBefore = fixtureEntries();
  const { runtime, state, stepResult } = await driveContinuation({
    entries: entriesBefore,
    modelResult: {
      finishReason: "length",
      providerMetadata: {},
      text: "",
      usage: { inputTokens: 120, outputTokens: 0, totalTokens: 120 },
    },
  });

  assert.equal(stepResult, "output_continuation", "空部分输出同样进入续写分支");
  const entriesAfter = state.turnRequestState.entries;
  assertPrefixByReference(entriesAfter, entriesBefore, "T-C5", 1);

  const continuationEntry = entriesAfter[entriesAfter.length - 1];
  assert.equal(continuationEntry.message.role, "user", "只追加续写 user 条目");
  assert.equal(continuationEntry.queryScope, "output_token_continuation");
  assert.ok(
    entriesAfter.every((entry) => entry.message?.role !== "assistant"),
    "不得出现 assistant 条目（空提交不进历史）",
  );
  assert.equal(
    runtime.calls.addEntries.length,
    0,
    "空提交不得写入 messageHistory（persistCompletedAssistantStep 提交失败）",
  );
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 6 output-token continuation state (T-C1/T-C2/T-C5)"
      : `TEST FAIL — Step 6 output-token continuation state (exit code ${code})`,
  );
});
