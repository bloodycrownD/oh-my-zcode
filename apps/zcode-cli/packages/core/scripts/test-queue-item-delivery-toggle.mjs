#!/usr/bin/env node
/**
 * setQueueItemDelivery（排队项「引导/排队」toggle）的 core 行为直证
 * （agile: queue-item-guide-toggle）。
 *
 * 用户拍板：guide = 引导至下一轮工具调用后运行（内联当前轮），queue = 普通排队
 * 独立成轮；与「立即」（sendQueuedNow 抢占当前轮）语义区分。协议字段不扩展，
 * 只改既有 delivery.admitted。
 *
 * 覆盖：
 *   - queue→guide / guide→queue 双向改写（内存 + intent.admittedDelivery + 事件）；
 *   - 同值 toggle = noop（不产事件，CommandInbox 重放/重复点击幂等）；
 *   - reserved 项拒绝（sendQueuedNow promotion 主线所有权，第二道门）；
 *   - queueItemId 不存在 → false；
 *   - guide 消费序列随 delivery **动态**进入/移出：firstInlineGuideIndex 是
 *     findIndex 按 delivery 扫描（非入队时固化），toggle 后无需同步索引——
 *     用导出的门 hasInlineGuidePendingInput 钉死该行为；
 *   - held 回落（无 active turn）：经投影定位后重发事件，reducer 原地更新。
 *
 * 运行方式：`npx tsx --test scripts/test-queue-item-delivery-toggle.mjs`
 * （tsx：被测模块是 TypeScript 源码，同 test-promotion-lease 范式。）
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hasInlineGuidePendingInput,
  setPendingInputDelivery,
} from "../src/runtime/methods/steering.js";

const SESSION_ID = "ses_toggle";
const TURN_ID = "turn_toggle_1";
const TRACE_CONTEXT = { traceId: "trace_toggle" };

/** 最小 pendingInput：delivery 与 intent.admittedDelivery 初始同值（admission 事实）。 */
function pendingInput(id, { delivery = "queue", withIntent = true } = {}) {
  return {
    id,
    input: `msg-${id}`,
    queuedAt: new Date(),
    traceId: TRACE_CONTEXT.traceId,
    queryId: `q-${id}`,
    delivery,
    ...(withIntent
      ? {
          intent: {
            sourceCommandId: `cmd-${id}`,
            queueItemId: id,
            clientId: "cli",
            kind: "sendText",
            text: `msg-${id}`,
            admissionSeq: 1,
            admittedAt: Date.now(),
            requestedDelivery: delivery,
            admittedDelivery: delivery,
          },
        }
      : {}),
    turnId: TURN_ID,
  };
}

function makeRuntime({ pendingInputs, reservations = [] } = {}) {
  const activeTurn = pendingInputs
    ? { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs }
    : undefined;
  const events = [];
  return {
    sessionId: SESSION_ID,
    activeTurn,
    pendingInputReservations: new Map(reservations.map((id) => [id, "res-owner"])),
    permissionFullAccessPending: false,
    queueExternalDrainActive: false,
    events,
    appendEvent: async (event) => {
      events.push(event);
      return event;
    },
    rebuildProjection: async () => ({ pendingSteerInputs: [] }),
  };
}

const setDelivery = (runtime, pendingInputId, delivery) =>
  setPendingInputDelivery.call(runtime, {
    pendingInputId,
    delivery,
    traceContext: TRACE_CONTEXT,
  });

test("queue→guide：内存车道、intent.admittedDelivery 与事件三者同步改写", async () => {
  const item = pendingInput("qi-1", { delivery: "queue" });
  const runtime = makeRuntime({ pendingInputs: [item] });
  assert.equal(await setDelivery(runtime, "qi-1", "guide"), true);
  assert.equal(item.delivery, "guide");
  assert.equal(item.intent.admittedDelivery, "guide");
  assert.equal(runtime.events.length, 1);
  const payload = runtime.events[0].payload;
  assert.equal(payload.admittedDelivery, "guide");
  assert.equal(payload.requestedDelivery, "queue");
  assert.equal(payload.pendingInputId, "qi-1");
  assert.equal(payload.targetTurnId, TURN_ID);
  assert.equal(payload.intent.admittedDelivery, "guide");
});

test("guide→queue：对称切回，且清掉 admission 期 fallback 标记", async () => {
  const item = pendingInput("qi-1", { delivery: "guide" });
  item.intent.fallbackReasonCode = "guide.noToolBoundary";
  const runtime = makeRuntime({ pendingInputs: [item] });
  assert.equal(await setDelivery(runtime, "qi-1", "queue"), true);
  assert.equal(item.delivery, "queue");
  assert.equal(item.intent.admittedDelivery, "queue");
  // 用户显式 toggle 即新决策：回退标记必须清掉，不能把手动 queue 当 fallback 结果。
  assert.equal(item.intent.fallbackReasonCode, undefined);
  const payload = runtime.events[0].payload;
  assert.equal(payload.admittedDelivery, "queue");
  assert.equal(payload.requestedDelivery, "guide");
  // 手动 toggle 不带 fallbackReasonCode（投影据此区分 fallback 与用户决策）。
  assert.equal(payload.fallbackReasonCode, undefined);
});

test("同值 toggle = noop：true 但不产事件", async () => {
  const item = pendingInput("qi-1", { delivery: "guide" });
  const runtime = makeRuntime({ pendingInputs: [item] });
  assert.equal(await setDelivery(runtime, "qi-1", "guide"), true);
  assert.equal(item.delivery, "guide");
  assert.equal(runtime.events.length, 0);
});

test("reserved 项拒绝切换（sendQueuedNow promotion 主线所有权）", async () => {
  const item = pendingInput("qi-1", { delivery: "queue" });
  const runtime = makeRuntime({ pendingInputs: [item], reservations: ["qi-1"] });
  assert.equal(await setDelivery(runtime, "qi-1", "guide"), false);
  assert.equal(item.delivery, "queue");
  assert.equal(runtime.events.length, 0);
});

test("queueItemId 不存在 → false", async () => {
  const runtime = makeRuntime({ pendingInputs: [pendingInput("qi-1")] });
  assert.equal(await setDelivery(runtime, "qi-missing", "guide"), false);
  assert.equal(runtime.events.length, 0);
});

test("guide 消费序列按 delivery 动态包含/排除（firstInlineGuideIndex 动态扫描）", async () => {
  const head = pendingInput("qi-head", { delivery: "queue" });
  const middle = pendingInput("qi-mid", { delivery: "queue" });
  const tail = pendingInput("qi-tail", { delivery: "queue" });
  const runtime = makeRuntime({ pendingInputs: [head, middle, tail] });

  // 全部排队：guide 子序列为空，行内引导门关闭。
  assert.equal(
    hasInlineGuidePendingInput.call(runtime, runtime.activeTurn),
    false,
    "纯 queue 时不得存在可消费 guide",
  );

  // 队中一项切 guide：动态扫描立即包含它（无需同步任何索引）。
  assert.equal(await setDelivery(runtime, "qi-mid", "guide"), true);
  assert.equal(
    hasInlineGuidePendingInput.call(runtime, runtime.activeTurn),
    true,
    "toggle 后该项必须进入 guide 消费子序列",
  );

  // 再切回 queue：动态扫描立即排除它（普通 queue 不可偷跑内联引导）。
  assert.equal(await setDelivery(runtime, "qi-mid", "queue"), true);
  assert.equal(
    hasInlineGuidePendingInput.call(runtime, runtime.activeTurn),
    false,
    "toggle 回 queue 后该项必须移出 guide 消费子序列",
  );
});

test("队列前有 ordinary queue 时，后续 guide 不被挡住（子序列 FIFO）", async () => {
  const ordinary = pendingInput("qi-ordinary", { delivery: "queue" });
  const guide = pendingInput("qi-guide", { delivery: "guide" });
  const runtime = makeRuntime({ pendingInputs: [ordinary, guide] });
  assert.equal(
    hasInlineGuidePendingInput.call(runtime, runtime.activeTurn),
    true,
    "guide 子序列独立于普通 queue 队首，先入队的普通消息不得永久挡住 guide",
  );
});

test("held 回落：无 active turn 时经投影定位后重发事件（reducer 原地更新）", async () => {
  const runtime = makeRuntime({ pendingInputs: undefined });
  runtime.rebuildProjection = async () => ({
    pendingSteerInputs: [
      {
        pendingInputId: "qi-held",
        targetTurnId: "turn-held-1",
        intent: {
          sourceCommandId: "cmd-held",
          queueItemId: "qi-held",
          clientId: "cli",
          kind: "sendText",
          admissionSeq: 3,
          admittedAt: Date.now(),
          requestedDelivery: "queue",
          admittedDelivery: "queue",
        },
      },
    ],
  });
  assert.equal(await setDelivery(runtime, "qi-held", "guide"), true);
  assert.equal(runtime.events.length, 1);
  const payload = runtime.events[0].payload;
  assert.equal(payload.admittedDelivery, "guide");
  assert.equal(payload.targetTurnId, "turn-held-1");
  assert.equal(payload.intent.admittedDelivery, "guide");
});

test("held 回落：投影也查不到 → false；同值 → true 不产事件", async () => {
  const runtime = makeRuntime({ pendingInputs: undefined });
  assert.equal(await setDelivery(runtime, "qi-held-missing", "guide"), false);
  runtime.rebuildProjection = async () => ({
    pendingSteerInputs: [
      {
        pendingInputId: "qi-held",
        targetTurnId: "turn-held-1",
        intent: {
          sourceCommandId: "cmd-held",
          queueItemId: "qi-held",
          clientId: "cli",
          kind: "sendText",
          admissionSeq: 3,
          admittedAt: Date.now(),
          requestedDelivery: "queue",
          admittedDelivery: "queue",
        },
      },
    ],
  });
  assert.equal(await setDelivery(runtime, "qi-held", "queue"), true);
  assert.equal(runtime.events.length, 0);
});

test("steer 无 intent 的旧格式项也支持切换（requestedDelivery 缺省取当前车道）", async () => {
  const item = pendingInput("qi-legacy", { delivery: "queue", withIntent: false });
  const runtime = makeRuntime({ pendingInputs: [item] });
  assert.equal(await setDelivery(runtime, "qi-legacy", "guide"), true);
  assert.equal(item.delivery, "guide");
  assert.equal(item.intent, undefined);
  const payload = runtime.events[0].payload;
  assert.equal(payload.requestedDelivery, "queue");
  assert.equal(payload.admittedDelivery, "guide");
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — setQueueItemDelivery core toggle + guide 消费序列"
      : `TEST FAIL — setQueueItemDelivery core toggle (exit code ${code})`,
  );
});
