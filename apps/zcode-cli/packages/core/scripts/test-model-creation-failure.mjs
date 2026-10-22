#!/usr/bin/env node
/**
 * T-C4（upstream-v3.16-backport U4 / Step 7）：模型创建失败保留已接纳输入 + 终态。
 *
 * 断言口径（spec §U4）：
 *   1) TurnStarted 已发（创建失败不再在 TurnStarted 之前夭折）；
 *   2) 用户消息已落库（persistUserPrompt 以 displayInput 被调用）；
 *   3) 终态 TurnError 事件 turnPhase === "model_creation"；
 *   4) 终态错误是创建错误（携带 registry 消失 marker），而非落库/其他二次错误。
 *
 * 运行形态：node --import tsx --test（载 TS 源码；core 包 dist 形态受 @zcode/* exports
 * 直指 src 的模块解析限制，见 iteration CONSTRAINTS）。
 *   cd apps/zcode-cli/packages/core && node --import tsx --test scripts/test-model-creation-failure.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executeTurnCommand } from "../src/runtime/methods/turn.ts";

const CREATION_MARKER = "PROVIDER_VANISHED_MARKER: provider missing from registry";

/** 构造创建失败轮所需的 runtime 桩：只实现 creationFailure 路径真实触碰到的表面。 */
function buildRuntimeStub(recorder) {
  return {
    sessionId: "sess-tc4",
    turnNumber: 0,
    workingDirectory: "D:/tmp-tc4",
    rootTraceContext: { traceId: "trace-root-tc4" },
    config: { outputStyle: undefined },
    logger: {
      info() {},
      warn(message, context) {
        recorder.warns.push({ message, context });
      },
      error() {},
    },
    // 创建失败的注入点：模型工厂创建失败（registry 中 provider 短暂缺失的真实形态落点）。
    modelFactory() {
      throw new Error(CREATION_MARKER);
    },
    getSessionModelSelection() {
      return { providerId: "ghost-provider", modelId: "ghost-model" };
    },
    // preamble
    reserveTurnStart(turnId) {
      recorder.reservedTurnIds.push(turnId);
    },
    releaseTurnStart(turnId) {
      recorder.releasedTurnIds.push(turnId);
    },
    now() {
      return new Date();
    },
    lastEmittedLocalDate: undefined,
    finishActiveTurn(activeTurn) {
      recorder.finishedActiveTurns.push(activeTurn);
      return Promise.resolve();
    },
    // 主链
    beginActiveTurn(turnId, _traceContext, mode, steerable, options) {
      recorder.beginActiveTurnCalls.push({ turnId, mode, steerable, options });
      return { pendingInputs: [], steerable };
    },
    ensureSessionPersisted() {
      return Promise.resolve();
    },
    createEvent(type, info, _traceContext) {
      const event = { type, info };
      recorder.createdEvents.push(event);
      return event;
    },
    appendEvent(event) {
      recorder.appendedEvents.push(event);
      return Promise.resolve();
    },
    startTargetTurnAccounting() {
      return Promise.resolve(null);
    },
    runUserPromptSubmitHooks() {
      return Promise.resolve({ additionalContexts: [] });
    },
    injectHookAdditionalContextIntoMessageHistory() {},
    messageHistory: {
      entries: [],
      addUser(text) {
        this.entries.push({ role: "user", text });
      },
      addEntries(entries) {
        this.entries.push(...entries.map((entry) => ({ role: "user", entry })));
      },
      addAttachment() {},
      setCacheMiss() {},
      getCacheStats() {
        return {};
      },
    },
    artifactStore: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    persistPendingModelChangeTimeline() {
      return Promise.resolve();
    },
    persistUserPrompt(messageId, displayInput) {
      recorder.persistedUserPrompts.push({ messageId, displayInput });
      return Promise.resolve();
    },
    injectPluginReferenceReminderFromTurn() {
      return Promise.resolve();
    },
    // 外层 catch
    finishTargetTurnAccounting() {
      return Promise.resolve(null);
    },
    rebuildProjection() {
      return Promise.resolve({ pendingSteerInputs: [] });
    },
    sessionStore: {
      messages() {
        return Promise.resolve([]);
      },
    },
  };
}

test("T-C4: 模型创建失败 → TurnStarted + 用户消息落库 + model_creation 终态 + 创建错误原样上报", async () => {
  const recorder = {
    warns: [],
    reservedTurnIds: [],
    releasedTurnIds: [],
    finishedActiveTurns: [],
    beginActiveTurnCalls: [],
    createdEvents: [],
    appendedEvents: [],
    persistedUserPrompts: [],
  };
  const runtime = buildRuntimeStub(recorder);
  const input = "请帮我分析这段日志里的竞态";

  await assert.rejects(
    executeTurnCommand.call(runtime, input, undefined, { inputId: "input-tc4" }),
    (error) => {
      recorder.rejectedError = error;
      return true;
    },
  );

  // 断言 1：TurnStarted 已发（事件同时进了 appendEvent 与 events 推送链——
  // 桩里两条链都落 recorder.createdEvents/recorded append；按 type 断言）。
  const turnStarted = recorder.appendedEvents.find(
    (event) => String(event.type).includes("turn_started"),
  );
  assert.ok(turnStarted, "TurnStarted 事件必须在创建失败后仍然发出");

  // 断言 2：用户消息已落库（displayInput 原文）。
  assert.equal(recorder.persistedUserPrompts.length, 1, "persistUserPrompt 恰好调用一次");
  assert.equal(recorder.persistedUserPrompts[0]?.displayInput, input, "落库文本 = displayInput");
  assert.equal(
    turnStarted?.info?.messageId,
    recorder.persistedUserPrompts[0]?.messageId,
    "TurnStarted.messageId 与落库 messageId 一致",
  );

  // 断言 3：终态 TurnError 的 turnPhase === "model_creation"。
  const turnError = [...recorder.appendedEvents]
    .reverse()
    .find((event) => String(event.type).includes("turn_error"));
  assert.ok(turnError, "必须写入 TurnError 终态事件");
  assert.equal(turnError.info?.turnPhase, "model_creation", "终态 turnPhase 必须是 model_creation");

  // 断言 4：终态错误是创建错误（marker 原样穿透），不是落库/二次错误。
  const outcomeText = JSON.stringify(turnError);
  assert.ok(
    outcomeText.includes(CREATION_MARKER),
    `终态事件必须携带创建错误 marker，实际: ${outcomeText.slice(0, 400)}`,
  );
  // 落库链未失败：不应出现“落库失败只 warn”的守卫日志。
  assert.ok(
    !recorder.warns.some((entry) => String(entry.message).includes("persistence failed")),
    "创建错误之后不应再发生落库失败（无 input_persistence_failed warn）",
  );

  // 行为面补充：创建失败轮不得进入 context/session-start（ensureContextInitialized 未被触碰）——
  // 桩中未提供该方法，若被调用会 TypeError 直接红，天然守卫。
  // beginActiveTurn 的 steerable 参数必须为 false（上游语义：失败轮不可 steer）。
  assert.equal(recorder.beginActiveTurnCalls[0]?.steerable, false, "创建失败轮 steerable=false");
});
