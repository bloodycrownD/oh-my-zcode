#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-MEM-1——model_request 驻留副本瘦身 + producer/consumer 同值。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P2 #10 / #11，producer/consumer 对）
 * ============================================================================
 *
 * `model_request` 事件每次模型请求一条，payload 带的是**完整上下文**（每个工具迭代一份），且作为
 * 非瞬态事件永久驻留内存 store。compact 只截断后续请求、不回收已驻留事件——长会话实测驻留随轮次
 * 线性涨约 150MB。
 *
 * 修复分两侧，必须成对：
 *   producer —— sealed turn 淘汰同一节拍把驻留副本瘦身成 `messageCount`（去掉 `messages` 大数组）；
 *   consumer —— bootstrap 的 `mapModelRequestPayload` 同时认两种形态并映射出**同一个** `messageCount`。
 * 只做一侧就会出现「瘦身事件被旧 mapper 投影成 messageCount: undefined」的语义缺口。
 *
 * 运行：`npx tsx --test scripts/test-model-request-slim.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { createInMemorySessionEventStore, slimRetainedModelRequest, SessionEventType } = await import(
  "@zcode/contracts"
);
const { mapSessionEvent } = await import("../src/zcode-protocol/session-mapper.ts");

const SESSION_ID = "ses-t-mem-1";

let seq = 0;
function sessionEvent(type, payload, turnId = "turn-1") {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId: SESSION_ID,
    type,
    timestamp: new Date(1_700_000_000_000 + seq),
    traceId: "trace-t-mem-1",
    turnId,
    sequenceNumber: seq,
    payload,
  };
}

const MESSAGES = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "用户输入" },
  { role: "assistant", content: "回答" },
];

function modelRequestEvent(turnId = "turn-1") {
  return sessionEvent(
    SessionEventType.ModelRequest,
    {
      messages: MESSAGES,
      providerId: "glm",
      modelId: "glm-4.6",
      inputTokens: 1234,
    },
    turnId,
  );
}

test("T-MEM-1 瘦身只把 messages 换成 messageCount，其余 payload 与事件字段不变", () => {
  const event = modelRequestEvent();
  const slim = slimRetainedModelRequest(event);

  assert.notEqual(slim, event, "瘦身必须返回新对象（不改入参）");
  assert.equal("messages" in slim.payload, false);
  assert.equal(slim.payload.messageCount, MESSAGES.length);
  assert.equal(slim.payload.providerId, "glm");
  assert.equal(slim.payload.modelId, "glm-4.6");
  assert.equal(slim.payload.inputTokens, 1234);
  assert.equal(slim.id, event.id);
  assert.equal(slim.sequenceNumber, event.sequenceNumber);
  assert.equal(slim.turnId, event.turnId);
  // 入参本身没被动过（live sink 拿的是 append 返回的完整对象）。
  assert.equal(event.payload.messages, MESSAGES);
});

test("T-MEM-1 非 model_request / 无 messages 数组的事件原样返回", () => {
  const other = sessionEvent(SessionEventType.TurnStarted, { turnNumber: 1 });
  assert.equal(slimRetainedModelRequest(other), other);
  const noMessages = sessionEvent(SessionEventType.ModelRequest, { providerId: "glm" });
  assert.equal(slimRetainedModelRequest(noMessages), noMessages);
});

test("T-MEM-1 store 淘汰同一节拍：驻留副本已是瘦身形态，瞬态事件被回收", async () => {
  const store = createInMemorySessionEventStore();
  await store.append(sessionEvent(SessionEventType.TurnStarted, { turnNumber: 1 }, "turn-1"));
  const appended = await store.append(modelRequestEvent("turn-1"));
  await store.append(
    sessionEvent(SessionEventType.ModelStreaming, { kind: "text_delta", delta: "x" }, "turn-1"),
  );
  await store.append(sessionEvent(SessionEventType.TurnComplete, { resultType: "complete" }, "turn-1"));

  // append 的返回值是 live sink 拿到的完整对象（debug JSONL 仍然全量）。
  assert.equal(Array.isArray(appended.payload.messages), true);

  // 下一个 turn 开始 → 淘汰 sealed turn 的瞬态事件，并把 model_request 驻留副本瘦身。
  await store.append(sessionEvent(SessionEventType.TurnStarted, { turnNumber: 2 }, "turn-2"));

  const retained = await store.getEvents(SESSION_ID);
  const modelRequests = retained.filter((event) => event.type === SessionEventType.ModelRequest);
  assert.equal(modelRequests.length, 1);
  assert.equal("messages" in modelRequests[0].payload, false);
  assert.equal(modelRequests[0].payload.messageCount, MESSAGES.length);
  assert.equal(
    retained.some((event) => event.type === SessionEventType.ModelStreaming),
    false,
    "同 turn 的瞬态事件随同一节拍回收",
  );
});

test("T-MEM-1 producer/consumer 同值：两种形态经 mapModelRequestPayload 映射出同一个 messageCount", async () => {
  const store = createInMemorySessionEventStore();
  await store.append(sessionEvent(SessionEventType.TurnStarted, { turnNumber: 1 }, "turn-1"));
  const full = await store.append(modelRequestEvent("turn-1"));
  await store.append(sessionEvent(SessionEventType.TurnComplete, { resultType: "complete" }, "turn-1"));
  await store.append(sessionEvent(SessionEventType.TurnStarted, { turnNumber: 2 }, "turn-2"));
  const slim = (await store.getEvents(SESSION_ID)).find(
    (event) => event.type === SessionEventType.ModelRequest,
  );

  const fullProjection = mapSessionEvent(full);
  const slimProjection = mapSessionEvent(slim);
  assert.equal(fullProjection.payload.messageCount, MESSAGES.length);
  assert.equal(slimProjection.payload.messageCount, MESSAGES.length);
  assert.equal(fullProjection.payload.messageCount, slimProjection.payload.messageCount);
  // 其余字段同值（两种形态只在 messages 上有差别）。
  assert.equal(fullProjection.payload.providerId, slimProjection.payload.providerId);
  assert.equal(fullProjection.payload.modelId, slimProjection.payload.modelId);
  assert.equal(fullProjection.payload.inputTokens, slimProjection.payload.inputTokens);
});
