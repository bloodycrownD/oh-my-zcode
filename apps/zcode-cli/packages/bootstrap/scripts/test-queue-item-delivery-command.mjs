#!/usr/bin/env node
/**
 * setQueueItemDelivery（排队项「引导/排队」toggle）的 bootstrap 侧防线
 * （agile: queue-item-guide-toggle）。
 *
 * 用户拍板：guide = 引导至下一轮工具调用后运行（内联当前轮），queue = 普通排队
 * 独立成轮；与「立即」（sendQueuedNow 抢占当前轮）语义区分。
 *
 * 覆盖三层：
 *   A. 协议面：payload schema（delivery 只收 queue|guide）+ CAS baseRevision 必需；
 *   B. handler 门：dispatch.state !== "queued"（reserved/promoting）拒绝
 *      （guard.queueItemDeliveryLocked）、queueItemId 不存在拒绝
 *      （guard.queueItemDeliveryMissing）、同值 noop 不动 core、core 未命中时
 *      warn + 显式 rejected（guard.queueItemDeliveryCoreMiss，cr-fix-spec P0-2：
 *      操作丢失必须可观测，不再静默 accepted）；
 *   C. 投影面：TurnSteerDeliveryChanged 双向 toggle 落入 queue 行——
 *      guide 时 steer=steering、queue 时 steer=notRequested；带 fallbackReasonCode
 *      的 core 改投仍必须是 steer=fellBack（回归红线：两种语义共用同一事件）。
 *
 * 运行方式：`npx tsx --test scripts/test-queue-item-delivery-command.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { commandPayloadSchemas, parseCommandEnvelope, COMMANDS_REQUIRING_BASE_REVISION } =
  await import("@zcode/shared/zcode-protocol-v4");
const { SessionEventType } = await import("@zcode/contracts");
// 先载 executor 打通模块图（v4-gateway ↔ handlers/index ↔ queue 存在环，
// 直接 import queue.ts 会撞 TDZ；同 test-edit-retry-model 范式）。
await import(new URL("../src/zcode-protocol-v4/commands/executor.ts", import.meta.url).href);
const { queueHandlers } = await import(
  new URL("../src/zcode-protocol-v4/commands/handlers/queue.ts", import.meta.url).href
);
const { ProductProjection } = await import(
  new URL("../src/zcode-protocol-v4/product-projection.ts", import.meta.url).href
);

const SESSION_ID = "ses_dlv";
const QUEUE_ITEM_ID = "qi-dlv-1";
const EPOCH = "epoch-dlv";

// ── A. 协议面 ──────────────────────────────────────────────────────────────

test("A1: setQueueItemDelivery payload 只接受 queue|guide", () => {
  assert.deepEqual(
    commandPayloadSchemas.setQueueItemDelivery.parse({ queueItemId: "qi", delivery: "guide" }),
    {
      queueItemId: "qi",
      delivery: "guide",
    },
  );
  assert.deepEqual(
    commandPayloadSchemas.setQueueItemDelivery.parse({ queueItemId: "qi", delivery: "queue" }),
    { queueItemId: "qi", delivery: "queue" },
  );
  for (const delivery of ["startNow", "auto", "Guide", ""]) {
    assert.equal(
      commandPayloadSchemas.setQueueItemDelivery.safeParse({ queueItemId: "qi", delivery }).success,
      false,
      `delivery=${delivery} 必须被拒`,
    );
  }
});

test("A2: setQueueItemDelivery 是 CAS 命令（必带 baseRevision）", () => {
  assert.equal(COMMANDS_REQUIRING_BASE_REVISION.has("setQueueItemDelivery"), true);
  const envelope = {
    commandId: "cmd-1",
    clientId: "cli",
    sessionId: SESSION_ID,
    type: "setQueueItemDelivery",
    payload: { queueItemId: QUEUE_ITEM_ID, delivery: "guide" },
    issuedAt: Date.now(),
  };
  const missingRevision = parseCommandEnvelope(envelope);
  assert.equal(missingRevision.ok, false, "缺 baseRevision 必须被拒");
  const withRevision = parseCommandEnvelope({ ...envelope, baseRevision: 7 });
  assert.equal(withRevision.ok, true);
});

// ── B. handler 门 ──────────────────────────────────────────────────────────

function makeHost({ queueItem, appResult = true }) {
  const calls = [];
  return {
    calls,
    logger: { warn: (message, context) => calls.push({ kind: "warn", message, context }) },
    getRecord: (sessionId) =>
      sessionId === SESSION_ID
        ? {
            app: {
              sessionId,
              // B1/B5 钉的是「toggle 驱动 core 改写」这条门；空闲态的 guide 会转交
              // sendQueuedNow（queue.ts 的空闲回落），与本组语义不同。夹具此前缺
              // runtime 直接 TypeError（B1/B5 长期红），补一个「有前台执行」的活值让
              // 用例落在它自称的路径上——断言本身未放宽。
              runtime: { getActiveForegroundExecutionId: () => "exec-dlv-1" },
              setQueueItemDelivery: async (pendingInputId, delivery) => {
                calls.push({ kind: "app.setQueueItemDelivery", pendingInputId, delivery });
                return appResult;
              },
            },
            traceContext: { traceId: "trace-dlv", turnId: "turn-1" },
          }
        : undefined,
    getQueueItem: () => queueItem,
    // 执行权威（I1）：只有空闲回落会走到 sendQueuedNow，见 B6。
    getSessionInputForExecution: async (sessionId, queueItemId) => ({
      state: "pending",
      status: "admitted",
      id: queueItemId,
      sessionID: sessionId,
      text: queueItem?.text ?? "",
      attachments: queueItem?.attachments ?? [],
    }),
  };
}

function makeEnvelope(delivery = "guide") {
  return {
    commandId: "cmd-dlv-1",
    sessionId: SESSION_ID,
    type: "setQueueItemDelivery",
    payload: { queueItemId: QUEUE_ITEM_ID, delivery },
    issuedAt: new Date().toISOString(),
  };
}

function queueItem({ dispatchState = "queued", admitted = "queue" } = {}) {
  return {
    queueItemId: QUEUE_ITEM_ID,
    kind: "sendText",
    text: "排队消息",
    sourceCommandId: "cmd-src",
    clientId: "cli",
    attachments: [],
    delivery: { requested: "queue", admitted },
    order: { admissionSeq: 1, queuePosition: 0 },
    steer: { state: admitted === "guide" ? "steering" : "notRequested" },
    dispatch:
      dispatchState === "queued"
        ? { state: "queued" }
        : { state: dispatchState, reservationId: "res-1" },
    admittedAt: new Date().toISOString(),
  };
}

const runHandler = (host, envelope) => queueHandlers.setQueueItemDelivery(host, envelope);

test("B1: queued 态 queue→guide 驱动 core 改写", async () => {
  const host = makeHost({ queueItem: queueItem() });
  assert.equal(await runHandler(host, makeEnvelope("guide")), undefined);
  assert.deepEqual(
    host.calls.filter((call) => call.kind === "app.setQueueItemDelivery"),
    [{ kind: "app.setQueueItemDelivery", pendingInputId: QUEUE_ITEM_ID, delivery: "guide" }],
  );
});

test("B2: reserved / promoting 拒绝（guard.queueItemDeliveryLocked）", async () => {
  for (const dispatchState of ["reserved", "promoting"]) {
    const host = makeHost({ queueItem: queueItem({ dispatchState }) });
    await assert.rejects(
      () => runHandler(host, makeEnvelope("guide")),
      (error) => {
        assert.equal(error.reasonCode, "guard.queueItemDeliveryLocked");
        assert.equal(error.name, "V4QueueItemDeliveryLockedError");
        return true;
      },
      `dispatch.state=${dispatchState} 必须拒绝`,
    );
    assert.equal(
      host.calls.some((call) => call.kind === "app.setQueueItemDelivery"),
      false,
      "被拒时不得驱动 core",
    );
  }
});

test("B3: queueItemId 不存在拒绝（guard.queueItemDeliveryMissing）", async () => {
  const host = makeHost({ queueItem: null });
  await assert.rejects(
    () => runHandler(host, makeEnvelope("guide")),
    (error) => {
      assert.equal(error.reasonCode, "guard.queueItemDeliveryMissing");
      return true;
    },
  );
});

test("B4: 同值 toggle = noop，不驱动 core", async () => {
  const host = makeHost({ queueItem: queueItem({ admitted: "guide" }) });
  assert.equal(await runHandler(host, makeEnvelope("guide")), undefined);
  assert.equal(
    host.calls.some((call) => call.kind === "app.setQueueItemDelivery"),
    false,
    "同值 toggle 不得驱动 core",
  );
});

test("B5: core 未命中（并发 drain 竞态）时 warn + 显式 rejected（P0-2）", async () => {
  const host = makeHost({ queueItem: queueItem(), appResult: false });
  await assert.rejects(
    () => runHandler(host, makeEnvelope("guide")),
    (error) => {
      assert.equal(error.reasonCode, "guard.queueItemDeliveryCoreMiss");
      return true;
    },
  );
  assert.equal(
    host.calls.some((call) => call.kind === "warn"),
    true,
    "竞态未命中必须留 warn 供观测",
  );
});

test("B6: 空闲态 guide → 转交 sendQueuedNow，执行文本取账本（I1）", async () => {
  // 空闲（无前台执行、无外层 abort）时切 guide 会永久滞留，handler 把该项转交
  // sendQueuedNow。这条入口同样受 I1 约束：投影项文本是旧值，账本才是执行权威。
  const projected = queueItem();
  const ledgerText = "账本里的新文本";
  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      getMode: () => "build",
      readTarget: async () => null,
      runtime: {
        getActiveForegroundExecutionId: () => undefined,
        getSessionModelSelection: () => undefined,
        getPlanEnabled: () => false,
        getActiveTurnInfo: () => undefined,
        acquireForegroundPromotionLease: () => ({ kind: "acquired" }),
        releaseForegroundPromotionLease: () => undefined,
      },
      reserveQueueItem: async () => true,
      markQueueItemPromoting: async () => true,
      removeQueueItem: async () => true,
      releaseQueueItemReservation: async () => true,
      setQueueAutoDrain: async () => {
        captured.autoDrainResumed = true;
      },
      sendInput: async (input) => {
        captured.input = input;
        return { kind: "started_turn", turnId: "turn-dlv", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-dlv", turnId: "turn-1" },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { warn: () => undefined },
    getQueueItem: () => projected,
    getSessionInputForExecution: async (sessionId, queueItemId) => ({
      state: "pending",
      status: "admitted",
      id: queueItemId,
      sessionID: sessionId,
      text: ledgerText,
      // 账本附件事实（I1 的附件口径）：夹具里与投影同值，附件权威性由
      // test-input-authority 的 L1 断言。
      attachments: projected.attachments ?? [],
    }),
    getInputRoutingMode: () => null,
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
  };
  assert.equal(await runHandler(host, makeEnvelope("guide")), undefined);
  assert.equal(captured.input?.text, ledgerText, "空闲回落起轮必须用账本文本，而不是投影项");
  assert.notEqual(captured.input?.text, projected.text, "投影文本被执行 = RC1 复活");
  assert.equal(captured.autoDrainResumed, true, "手动提升成功后必须恢复 autoDrain");
});

// ── C. 投影面 ──────────────────────────────────────────────────────────────

let eventSeq = 0;
function event(type, payload) {
  eventSeq += 1;
  return {
    id: `evt-dlv-${eventSeq}`,
    sessionId: SESSION_ID,
    turnId: "turn-1",
    type,
    timestamp: new Date(),
    traceId: "trace-dlv",
    sequenceNumber: eventSeq,
    payload,
  };
}

function queuedEvent(admittedDelivery) {
  return event(SessionEventType.TurnSteerQueued, {
    pendingInputId: QUEUE_ITEM_ID,
    input: "排队消息",
    inputPreview: "排队消息",
    inputSize: 4,
    queueLength: 1,
    targetTurnId: "turn-1",
    intent: {
      sourceCommandId: "cmd-src",
      queueItemId: QUEUE_ITEM_ID,
      clientId: "cli",
      kind: "sendText",
      text: "排队消息",
      admissionSeq: 1,
      admittedAt: eventSeq,
      requestedDelivery: "queue",
      admittedDelivery,
    },
  });
}

function deliveryChangedEvent({ admittedDelivery, requestedDelivery, fallbackReasonCode }) {
  return event(SessionEventType.TurnSteerDeliveryChanged, {
    pendingInputId: QUEUE_ITEM_ID,
    targetTurnId: "turn-1",
    requestedDelivery,
    admittedDelivery,
    ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    intent: {
      sourceCommandId: "cmd-src",
      queueItemId: QUEUE_ITEM_ID,
      clientId: "cli",
      kind: "sendText",
      text: "排队消息",
      admissionSeq: 1,
      admittedAt: 1,
      requestedDelivery,
      admittedDelivery,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
  });
}

function queueItemOf(projection) {
  const item = projection
    .getSnapshot()
    .queue.items.find((row) => row.queueItemId === QUEUE_ITEM_ID);
  assert.ok(item, "queue 行必须存在");
  return item;
}

test("C1: queue→guide toggle 投影为 admitted=guide + steer=steering", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(queuedEvent("queue"));
  assert.equal(queueItemOf(projection).delivery.admitted, "queue");
  projection.applyEvent(
    deliveryChangedEvent({ admittedDelivery: "guide", requestedDelivery: "queue" }),
  );
  const item = queueItemOf(projection);
  assert.equal(item.delivery.admitted, "guide");
  assert.equal(item.delivery.requested, "queue");
  assert.equal(item.steer.state, "steering", "用户手动 guide toggle 不是回退");
});

test("C2: guide→queue toggle 投影为 admitted=queue + steer=notRequested", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(queuedEvent("guide"));
  projection.applyEvent(
    deliveryChangedEvent({ admittedDelivery: "queue", requestedDelivery: "guide" }),
  );
  const item = queueItemOf(projection);
  assert.equal(item.delivery.admitted, "queue");
  assert.equal(item.steer.state, "notRequested");
});

test("C3: core fallback（带 fallbackReasonCode）仍投影 steer=fellBack（回归红线）", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(queuedEvent("guide"));
  projection.applyEvent(
    deliveryChangedEvent({
      admittedDelivery: "queue",
      requestedDelivery: "guide",
      fallbackReasonCode: "guide.turnInterrupted",
    }),
  );
  const item = queueItemOf(projection);
  assert.equal(item.delivery.admitted, "queue");
  assert.equal(item.steer.state, "fellBack");
  assert.equal(item.steer.reasonCode, "guide.turnInterrupted");
  assert.equal(item.delivery.fallbackReasonCode, "guide.turnInterrupted");
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — setQueueItemDelivery 协议/handler/投影三层"
      : `TEST FAIL — setQueueItemDelivery command (exit code ${code})`,
  );
});
