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

function makeRuntime({ pendingInputs, reservations = [], ledger } = {}) {
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
    // 执行权威（I1）：物化正文只认账本，投影 held.input 只用于展示。
    // `ledger === undefined` → 宿主没有该能力（老夹具形态）。
    ...(ledger === undefined
      ? {}
      : {
          sessionStore: {
            getSessionInputForExecution: async ({ id, sessionID }) => ({
              state: "pending",
              status: "admitted",
              id,
              sessionID,
              text: ledger.text,
              attachments: ledger.attachments ?? [],
            }),
          },
        }),
    appendEvent: async (event) => {
      events.push(event);
      return event;
    },
    rebuildProjection: async () => ({ pendingSteerInputs: [] }),
  };
}

const setDeliveryOutcome = (runtime, pendingInputId, delivery) =>
  setPendingInputDelivery.call(runtime, {
    pendingInputId,
    delivery,
    traceContext: TRACE_CONTEXT,
  });

/**
 * 既有 17 条形态断言测的就是「车道改写成功/未命中」这一个事实。
 * `setPendingInputDelivery` 现在返回 `PendingInputDeliveryResult`（cr-func P2-2，
 * 多出 inlined/degradedReason），`.changed` 就是过去那个 boolean——断言强度不变。
 */
const setDelivery = async (runtime, pendingInputId, delivery) =>
  (await setDeliveryOutcome(runtime, pendingInputId, delivery)).changed;

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

// ── held 物化：queue 车道项切 guide 必须进内存，注入消费侧才看得见 ──────────
// v1.0.10 真机缺陷回归钉：busy 中排队项走 enqueueDeferredInput 只发事件不进内存，
// 旧实现仅改投影 → hasInlineGuidePendingInput（扫内存）永远 false → 注入从未
// 触发 → turn 结束被 autoDrain 当普通输入消费。物化后两个注入点（tool 边界 +
// text-only 收口续跑）即可内联执行。

function makeHeldProjection(overrides = {}) {
  return {
    pendingSteerInputs: [
      {
        pendingInputId: "qi-held-1",
        input: "引导排队的命令内容",
        inputPreview: "引导排队的命令内容".slice(0, 30),
        inputSize: 30,
        commandKind: undefined,
        source: undefined,
        inputPresentation: undefined,
        intent: {
          admittedAt: Date.now(),
          requestedDelivery: "queue",
          admittedDelivery: "queue",
        },
        toolDisallowlist: undefined,
        queuedAt: new Date("2026-10-14T00:00:00Z"),
        targetTurnId: TURN_ID,
        traceId: "trace_toggle",
        ...overrides,
      },
    ],
  };
}

test("held 物化：正文取账本（I1），投影文本只用于展示", async () => {
  const ledgerText = "账本里的引导内容（与投影不同）";
  const runtime = makeRuntime({
    pendingInputs: [],
    ledger: { text: ledgerText },
  });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  // 投影的 intent.text 也停在 admission 期的旧值（真实形态：held 项的 intent 是
  // TurnSteerQueued 的快照，与投影正文同源）。
  runtime.rebuildProjection = async () =>
    makeHeldProjection({
      intent: {
        admittedAt: Date.now(),
        requestedDelivery: "queue",
        admittedDelivery: "queue",
        text: "投影里的旧文本",
      },
    });
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.inlined, true, "物化成功 = 该项现在就在内联车道");
  assert.equal(outcome.degradedReason, undefined, "成功物化不得带降级原因");
  assert.equal(runtime.activeTurn.pendingInputs.length, 1, "必须物化进内存");
  const materialized = runtime.activeTurn.pendingInputs[0];
  // 变异探测：把 resolveHeldGuideInput 的返回值改回 held.input，本断言即红。
  assert.equal(
    materialized.input,
    "账本里的引导内容（与投影不同）",
    "物化正文必须来自 session_input 账本，不得用投影 held.input",
  );
  // cr-func P1-2（Bug C 形态）：`intent.text` 是落库与重发的权威
  // （`input-intent-persistence.ts:30` 的 `intent.text ?? text`；`TurnSteerDrained`
  // 的 drainedInputs[].intent.text 又供 editTarget.intent.text 重发）。只换正文不换
  // intent.text 会造出「content 用新文本、intent 用旧文本」。变异：删掉物化里的
  // `text: materializedInput`，本断言即红。
  assert.equal(
    materialized.intent.text,
    "账本里的引导内容（与投影不同）",
    "物化项的 intent.text 必须与正文同批换成账本文本",
  );
  // 同一条事实还必须进投影同步事件：账本行长（updateSessionInputs 的 payload.intent
  // 镜像）由事件写入，事件带旧文本 = 账本里留着一条与执行正文矛盾的 intent。
  // 变异：事件改回 `{...held.intent, admittedDelivery}`，本断言即红。
  assert.equal(
    runtime.events[0].payload.intent.text,
    "账本里的引导内容（与投影不同）",
    "TurnSteerDeliveryChanged 的 intent 也必须带账本文本",
  );
  assert.equal(materialized.delivery, "guide");
  assert.equal(materialized.materialized, true);
  assert.equal(materialized.intent.admittedDelivery, "guide");
  assert.equal(runtime.events.length, 1, "投影同步事件照发");
  assert.equal(
    hasInlineGuidePendingInput.call(runtime, runtime.activeTurn),
    true,
    "注入消费门必须看得见物化项",
  );
});

test("held 物化：宿主无账本能力时不物化（不得拿投影起轮），且上报降级原因", async () => {
  // 老宿主/夹具形态：无法判定权威文本 → 保持投影切换，不把投影文本变成模型内容。
  const runtime = makeRuntime({ pendingInputs: [] });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  runtime.rebuildProjection = async () => makeHeldProjection();
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true, "车道照样改写（投影事件照发）");
  assert.equal(outcome.inlined, false, "未物化 = 不在内联车道");
  // cr-func P2-2：这条原因必须能被命令 ACK 看见，否则「已切引导」永远不内联
  // 就是静默成功。变异：核心恢复 boolean 返回值，本断言即红。
  assert.equal(
    outcome.degradedReason,
    "ledger_capability_absent",
    "fail-closed 必须上报可判定的降级原因",
  );
  assert.equal(runtime.activeTurn.pendingInputs.length, 0, "无账本能力时不得物化");
  assert.equal(runtime.events.length, 1, "投影事件照发（UI 仍显示切换）");
  assert.equal(
    hasInlineGuidePendingInput.call(runtime, runtime.activeTurn),
    false,
    "未物化项不得进入注入消费门",
  );
});

test("held 物化：账本非 pending（终态/损坏）不物化，原因 = ledger_not_pending", async () => {
  // 账本说不该执行时，物化只会把死项种进内存并在 drain 时用投影文本起一轮。
  const runtime = makeRuntime({ pendingInputs: [] });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  runtime.rebuildProjection = async () => makeHeldProjection();
  runtime.sessionStore = {
    getSessionInputForExecution: async ({ id, sessionID }) => ({
      state: "voided",
      status: "cancelled",
      id,
      sessionID,
    }),
  };
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.inlined, false);
  assert.equal(outcome.degradedReason, "ledger_not_pending");
  assert.equal(runtime.activeTurn.pendingInputs.length, 0, "账本非 pending 时不得物化");
  assert.equal(runtime.events.length, 1, "投影事件照发");
});

test("held 物化：账本附件非空而投影无附件时不物化，原因 = ledger_attachments", async () => {
  const runtime = makeRuntime({ pendingInputs: [] });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  runtime.rebuildProjection = async () => makeHeldProjection();
  runtime.sessionStore = {
    getSessionInputForExecution: async ({ id, sessionID }) => ({
      state: "pending",
      status: "admitted",
      id,
      sessionID,
      text: "账本正文",
      attachments: [{ ref: "att-9", fileName: "b.png", mime: "image/png", bytes: 2 }],
    }),
  };
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.inlined, false);
  assert.equal(outcome.degradedReason, "ledger_attachments");
  assert.equal(runtime.activeTurn.pendingInputs.length, 0, "账本附件项不得物化");
  assert.equal(runtime.events.length, 1, "投影事件照发");
});

test("held 物化：账本读失败不物化，原因 = ledger_read_failed", async () => {
  const runtime = makeRuntime({ pendingInputs: [] });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  runtime.rebuildProjection = async () => makeHeldProjection();
  runtime.sessionStore = {
    getSessionInputForExecution: async () => {
      throw new Error("ledger unavailable");
    },
  };
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.inlined, false);
  assert.equal(outcome.degradedReason, "ledger_read_failed");
  assert.equal(runtime.activeTurn.pendingInputs.length, 0);
});

test("held 反物化：物化项切回 queue 整体移出内存，权威回 queue 车道投影", async () => {
  // 物化需要账本权威（I1）；这里只要一次成功的物化，正文值不参与本用例断言。
  const runtime = makeRuntime({ pendingInputs: [], ledger: { text: "引导排队的命令内容" } });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  runtime.rebuildProjection = async () => makeHeldProjection();
  await setDelivery(runtime, "qi-held-1", "guide");
  assert.equal(await setDelivery(runtime, "qi-held-1", "queue"), true);
  assert.equal(runtime.activeTurn.pendingInputs.length, 0, "物化项必须移出内存");
  const last = runtime.events[runtime.events.length - 1].payload;
  assert.equal(last.admittedDelivery, "queue", "投影同步回 queue");
  assert.equal(
    hasInlineGuidePendingInput.call(runtime, runtime.activeTurn),
    false,
    "切回后注入门关闭",
  );
});

test("held 附件项跳过物化：投影不含完整附件载荷，物化会丢附件", async () => {
  const runtime = makeRuntime({ pendingInputs: [] });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  runtime.rebuildProjection = async () =>
    makeHeldProjection({
      intent: {
        admittedAt: Date.now(),
        requestedDelivery: "queue",
        admittedDelivery: "queue",
        attachmentRefs: [{ ref: "att-1", fileName: "a.png", mime: "image/png", bytes: 1 }],
      },
    });
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.inlined, false);
  assert.equal(outcome.degradedReason, "projection_attachments");
  assert.equal(runtime.activeTurn.pendingInputs.length, 0, "附件项不得物化");
  assert.equal(runtime.events.length, 1, "投影事件照发（UI 仍显示切换）");
});

test("held reserved 项拒绝物化：与 sendQueuedNow promotion 互斥，并上报 reserved", async () => {
  const runtime = makeRuntime({ pendingInputs: [], reservations: ["qi-held-1"] });
  runtime.activeTurn = { turnId: TURN_ID, traceContext: TRACE_CONTEXT, pendingInputs: [] };
  runtime.rebuildProjection = async () => makeHeldProjection();
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.inlined, false);
  assert.equal(outcome.degradedReason, "reserved");
  assert.equal(runtime.activeTurn.pendingInputs.length, 0, "reserved 项不得物化");
});

test("held 切 guide 且无 active turn：没有内联车道，原因 = no_active_turn", async () => {
  // 无进行中的轮 = 没有 pendingInputs 可注入；项留在投影 guide 车道，轮结束后按
  // 普通排队消费。这条过去同样静默成功（cr-func P2-2）。
  const runtime = makeRuntime({ pendingInputs: undefined });
  runtime.rebuildProjection = async () => makeHeldProjection();
  const outcome = await setDeliveryOutcome(runtime, "qi-held-1", "guide");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.inlined, false);
  assert.equal(outcome.degradedReason, "no_active_turn");
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — setQueueItemDelivery core toggle + guide 消费序列"
      : `TEST FAIL — setQueueItemDelivery core toggle (exit code ${code})`,
  );
});
