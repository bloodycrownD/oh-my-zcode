#!/usr/bin/env node
/**
 * 五条不变式的回归网（spec `docs/iterations/bugfix-batch-20261025/bugs/edit-resend-stale-text`）。
 *
 * 本文件当前覆盖 **I2（分支截断级联作废）** —— Step 4 的验收面。其余不变式的用例由后续
 * 步骤（Step 5 投影复位 / Step 7-9 事务 / Step 10-11 投递态）在本文件继续追加，不要另立脚本。
 *
 * ============================================================================
 * 本步第一件事：RC2 的真实可达链（spec「根因/RC2」要求先证伪再动手）
 * ============================================================================
 *
 * 「截断 → 旧队列项立刻被提升」在本树 **不可达**：`rewindConversationToMessage` 之后
 * `host.afterLegacyStateMutation("session_rewound")` 会调 `autoDrainV4QueueIfReady`，
 * 但那里要过 `shouldAutoDrainV4QueueHead` 的 `autoDrain === true`；而编辑重发的抢占
 * （`preemptActiveTurnAndWait` 未传 `preserveQueueAutoDrainOnCancel`）经
 * `TurnComplete(cancelled)` 的 heldQueue 补丁、以及 stop 的显式
 * `setQueueAutoDrain(false)`，都会把 `queue.autoDrain` 落成 false。所以那条链在本树是死的。
 *
 * **真实可达链是「用户点继续」**：截断后旧项仍留在投影队列里（`onRewindTriggered`
 * 只裁 transcript 行，不动 queue），队列处于暂停态（autoDrain=false）。用户点「继续」
 * → `setAutoDrain(true)` → `afterLegacyStateMutation("queue_auto_drain_resumed")` →
 * `autoDrainV4QueueIfReady` 把 **属于已消失那一轮** 的旧项提升起轮 → 旧文本在新分支上跑。
 * 期间任何新输入还会被 `computeInputRouting`（queue>0 且 autoDrain=false）路由成 enqueue，
 * 排在旧项后面——这就是用户看到的「发出去的是旧消息」。T-RW2 用这条真实入口承载，改前红。
 *
 * ============================================================================
 * 用例分区
 * ============================================================================
 *
 * T-RW0 源码形状：级联必须挂在 setRevert 之后 / RewindTriggered 之前；不得读
 *      `activeTurn.pendingInputs`；edit/retry 必须把自持 id 传给 rewind。
 * T-RW1 判据三条：`admitted` ∧ 排除自持 id ∧ (targetTurnId ∈ removedTurnIds ∨ 'deferred')；
 *      幸存轮的排队项一条都不许动。
 * T-RW2 真实可达链（本 bug 的核心断言）：暂停队列 + 编辑重发 → 点「继续」时旧项不得被提升，
 *      新文本的路由必须是 startNow（改前：enqueue + 提升起旧文本）。
 * T-RW3 投影收口 + autoDrain 双侧复位：`TurnSteerDiscarded` 对任意 reason 都移除队列项
 *      （既有行为，禁止加 reason 过滤——promoted 依赖同一语义）；作废后**投影队列为空**时
 *      runtime 门（queueAutoDrain）与 v4 投影（queue.autoDrain）必须同时复位，只复位一侧
 *      即失败；队列非空（幸存 held 项）时必须两边都保持 held。
 * T-RW5 不自伤：排除自持 id 后，**没有任何 settle 调用**指向它、账本仍为 admitted（不能只
 *      断言终态 promoted：误 settle 后 promote 会因 status='admitted' 前置而硬失败，两种
 *      事故的终态都是「没有 promoted」），且它随后仍能正常提升起轮。
 *
 * 运行：`pnpm --dir apps/zcode-cli/packages/bootstrap run test:edit-resend-authority`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bootstrapSrc = join(here, "..", "src");
const cliPackages = join(here, "..", "..");
const coreSrc = join(cliPackages, "core", "src");
const contractsSrc = join(cliPackages, "contracts", "src");

const contractsEvents = await import(
  pathToFileURL(join(contractsSrc, "events", "session.events.ts")).href
);
const { EventReducer } = await import(
  pathToFileURL(join(contractsSrc, "events", "event-reducer.ts")).href
);
const { InMemorySessionEventStore } = await import(
  pathToFileURL(join(contractsSrc, "events", "in-memory-session-event-store.ts")).href
);
const { appendEvent, createEvent, notifyEventSinks } = await import(
  pathToFileURL(join(coreSrc, "runtime", "methods", "events.ts")).href
);
const { rebuildProjection } = await import(
  pathToFileURL(join(coreSrc, "runtime", "methods", "message-persistence.ts")).href
);
const { completeExternalQueueDrain, discardRewoundPendingSteerInputs, setQueueAutoDrain } =
  await import(pathToFileURL(join(coreSrc, "runtime", "methods", "steering.ts")).href);
const { ProductProjection } = await import(
  pathToFileURL(join(bootstrapSrc, "zcode-protocol-v4", "product-projection.ts")).href
);
const { shouldAutoDrainV4QueueHead } = await import(
  pathToFileURL(join(bootstrapSrc, "zcode-protocol-v4", "queue-auto-drain.ts")).href
);
const { computeInputRouting } = await import(
  pathToFileURL(join(bootstrapSrc, "zcode-protocol-v4", "projection-state.ts")).href
);
// handlers/queue.ts ⇄ handlers/index.ts ⇄ executor.ts 之间是循环依赖。
// 与 test-input-authority 同源：先以 executor 为入口初始化，再取 queueHandlers 才不会命中 TDZ。
await import(
  pathToFileURL(join(bootstrapSrc, "zcode-protocol-v4", "commands", "executor.ts")).href
);
const { queueHandlers } = await import(
  pathToFileURL(join(bootstrapSrc, "zcode-protocol-v4", "commands", "handlers", "queue.ts")).href
);

const { SessionEventType, createSessionEvent } = contractsEvents;

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — I2 rewind cascade / edit resend authority"
      : `TEST FAIL — I2 rewind cascade / edit resend authority (exit code ${code})`,
  );
});

// ── 公共夹具 ────────────────────────────────────────────────────────────────

const SESSION_ID = "ses_edit_resend_authority";
const TRACE_CONTEXT = {
  attributes: {},
  queryId: `query_${SESSION_ID}`,
  sessionId: SESSION_ID,
  traceId: `trace_${SESSION_ID}`,
};

/** 被截断的那一轮（rewind 的 target 所属 turn）。 */
const TURN_REMOVED = "turn-edited-1";
/** 被截断轮次派生的子 turn（同一批 removedTurnIds）。 */
const TURN_REMOVED_CHILD = "turn-edited-1-sub";
/** 幸存轮：它的排队项一条都不许动。 */
const TURN_KEPT = "turn-kept-0";

const OLD_ID = "queue_cmd-old";
const OLD_TEXT = "终止前那条旧输入（不得在新分支上起跑）";
const KEPT_ID = "queue_cmd-kept";
const KEPT_TEXT = "属于幸存轮的排队输入（必须保留）";
const DEFERRED_ID = "queue_cmd-deferred";
const DEFERRED_TEXT = "无活跃轮时入队的输入（无法归属任何 turn）";
const SELF_ID = "queue_cmd-self";
const NEW_TEXT = "编辑后的新文本（唯一该起跑的内容）";

/**
 * `session_input` 账本的可控宿主。语义逐条对齐 `session-inputs.ts`：
 * - `settleSessionInput` 只收口 `admitted`（promoted 之后到达的迟到 discard 不回退状态）；
 * - `getSessionInputForExecution` 是五态（pending/started/voided/missing/corrupt），
 *   终态**不返回 text**。
 */
function createLedger() {
  const rows = new Map();
  const calls = { settles: [], saves: [] };
  /** 让前 n 次 serve 调用抛错的开关（模拟存储瞬时失败 → 事件汇兜底）。 */
  const failSettle = { remaining: 0 };
  const admissionPayload = (text) => ({
    text,
    conversationInputIntent: { attachments: [], kind: "sendText", text },
  });
  return {
    calls,
    failSettle,
    rows,
    seed({ id, text, status = "admitted" }) {
      rows.set(id, {
        id,
        kind: "sendText",
        payload: admissionPayload(text),
        sessionID: SESSION_ID,
        status,
        statusReason: undefined,
      });
      return rows.get(id);
    },
    port: {
      saveSessionInput: async (input) => {
        calls.saves.push(input.id);
        rows.set(input.id, {
          id: input.id,
          kind: input.kind,
          payload: input.payload,
          sessionID: input.sessionID,
          status: "admitted",
          statusReason: undefined,
        });
      },
      settleSessionInput: async ({ id, status, reason }) => {
        calls.settles.push({ id, reason, status });
        if (failSettle.remaining > 0) {
          failSettle.remaining -= 1;
          throw new Error("simulated settle failure");
        }
        const row = rows.get(id);
        if (!row || row.status !== "admitted") return;
        row.status = status;
        row.statusReason = reason;
      },
      updateSessionInputs: async () => undefined,
      listSessionInputs: async ({ status } = {}) =>
        [...rows.values()]
          .filter((row) => (status ? row.status === status : true))
          .map((row) => ({ ...row })),
      getSessionInputById: async (id) => rows.get(id) ?? null,
      getSessionInputForExecution: async ({ id, sessionID }) => {
        const row = sessionID === SESSION_ID ? rows.get(id) : undefined;
        if (!row) return { id, sessionID, state: "missing" };
        if (row.status === "admitted") {
          const text = row.payload?.text;
          if (typeof text !== "string")
            return { id, sessionID, reason: "text_not_string", state: "corrupt" };
          return {
            attachments: row.payload.conversationInputIntent?.attachments ?? [],
            id,
            sessionID,
            state: "pending",
            status: "admitted",
            text,
          };
        }
        return row.status === "promoted"
          ? { id, sessionID, state: "started", status: "promoted" }
          : {
              id,
              sessionID,
              state: "voided",
              status: row.status,
              ...(row.statusReason ? { statusReason: row.statusReason } : {}),
            };
      },
    },
  };
}

/** 真实 runtime 形状的可控宿主：投影走真实 EventReducer，落账走真实 appendEvent。 */
function createRuntime({ ledger }) {
  const warnings = [];
  const runtime = {
    branchGeneration: 0,
    eventReducer: new EventReducer(),
    eventSinks: [],
    eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, fields) => warnings.push({ fields, message }),
    },
    pendingInputReservations: new Map(),
    // runtime 的 autoDrain 门与授权位镜像：真实构造器默认 true / false（agent-runtime.ts:230）。
    // 复位断言必须读这两个字段（真实 setQueueAutoDrain 写它们），不能用投影值代替。
    queueAutoDrain: true,
    queueExternalDrainActive: false,
    rebuildProjection,
    runtimeTaskRegistry: { all: () => ({}) },
    sessionId: SESSION_ID,
    sessionStore: ledger.port,
    warnings,
    appendEvent,
    completeExternalQueueDrain,
    createEvent,
    discardRewoundPendingSteerInputs,
    notifyEventSinks,
    setQueueAutoDrain,
  };
  return runtime;
}

/**
 * 给两个投影同时喂一条真实事件：
 * - core 侧（EventReducer over InMemorySessionEventStore）：级联读取的是它；
 * - v4 产品投影（ProductProjection）：队列/autoDrain/路由裁决读取的是它。
 */
async function emitFact({ product, runtime }, type, payload, options = {}) {
  const event = createSessionEvent(type, SESSION_ID, payload, {
    traceId: options.traceId ?? TRACE_CONTEXT.traceId,
    turnId: options.turnId ?? payload.targetTurnId ?? TURN_REMOVED,
  });
  const stored = await runtime.eventStore.append(event);
  product.applyEvent(stored);
  return stored;
}

/** 入队事实：[admission 落账] + TurnSteerQueued（生产同序：先账本后事件）。 */
async function seedQueuedInput(context, { id, targetTurnId, text }) {
  await context.runtime.sessionStore.saveSessionInput({
    delivery: "queue",
    id,
    kind: "sendText",
    payload: {
      conversationInputIntent: { attachments: [], kind: "sendText", queueItemId: id, text },
      text,
    },
    sessionID: SESSION_ID,
  });
  await emitFact(context, SessionEventType.TurnSteerQueued, {
    delivery: "queue",
    input: text,
    inputPreview: text,
    inputSize: text.length,
    intent: {
      admittedDelivery: "queue",
      kind: "sendText",
      queueItemId: id,
      requestedDelivery: "queue",
      sourceCommandId: id.replace(/^queue_/, ""),
      text,
    },
    pendingInputId: id,
    queueLength: 1,
    targetTurnId,
  });
}

function createContext() {
  const ledger = createLedger();
  const runtime = createRuntime({ ledger });
  const product = new ProductProjection(SESSION_ID, "epoch-edit-resend");
  // 生产接线：v4 gateway 是 core 的 event sink，事件落库后逐条喂给产品投影。
  // 少了这一层就等于「core 发了作废事件，UI/队列那一侧永远不知道」——正是幽灵队列项的成因。
  runtime.eventSinks.push({ onSessionEvent: (event) => product.applyEvent(event) });
  return { ledger, product, runtime };
}

function queueState(context) {
  const snapshot = context.product.getSnapshot();
  return {
    autoDrain: snapshot.queue.autoDrain,
    items: snapshot.queue.items,
    pauseReason: snapshot.queue.pauseReason,
    queueLength: snapshot.queue.items.length,
  };
}

/**
 * 生产链路 `record.app.setQueueAutoDrain(x)` → core `setQueueAutoDrain`（input-facade.ts:355）：
 * 一次调用同时翻 runtime 门（queueAutoDrain / queueExternalDrainActive）并追加
 * QueueAutoDrainChanged 事件（v4 投影由此收口）。**不能用 emitFact 直喂投影**——那样只改
 * 一侧，恰好会让本步要防的「只复位一侧」缺陷在测试里看不出来。
 */
async function setAutoDrain(context, autoDrain) {
  await context.runtime.setQueueAutoDrain({ autoDrain, traceContext: TRACE_CONTEXT });
}

/**
 * 「用户点继续 / setAutoDrain(true)」的真实链路：`queue.ts` 的 setAutoDrain handler 只做
 * `app.setQueueAutoDrain(true)` + `afterLegacyStateMutation("queue_auto_drain_resumed")`，
 * 后者在 v4-bridge 里就是 `QueueAutoDrainChanged` 落投影 + `autoDrainV4QueueIfReady`。
 * 这里逐段照抄，不是简化：gate 用真实 `shouldAutoDrainV4QueueHead`，提升用真实
 * `queueHandlers.sendQueuedNow`，执行文本用真实账本读法。
 */
async function resumeAutoDrain(context) {
  await setAutoDrain(context, true);
  const { items, autoDrain } = queueState(context);
  const head = items[0] ?? null;
  const promoted =
    head !== null &&
    shouldAutoDrainV4QueueHead({
      autoDrain,
      dispatchState: head.dispatch.state,
      sessionBusy: false,
      targetStatus: null,
    });
  if (!promoted) return { head, promoted: false };

  const harness = promotionHarness(context, head);
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);
  return { head, promoted: true, ...harness };
}

/** `sendQueuedNow` 的可控宿主（真实 handler；账本读法接上下文里的真账本）。 */
function promotionHarness(context, queueItem) {
  const calls = { remove: 0, reserve: 0, sendInput: 0, warnings: [] };
  const captured = {};
  const record = {
    app: {
      getMode: () => "build",
      readTarget: async () => null,
      markQueueItemPromoting: async () => true,
      releaseQueueItemReservation: async () => true,
      removeQueueItem: async () => {
        calls.remove += 1;
        return true;
      },
      reserveQueueItem: async () => {
        calls.reserve += 1;
        return true;
      },
      runtime: {
        acquireForegroundPromotionLease: () => ({ kind: "acquired", leaseId: "lease-test" }),
        getActiveForegroundExecutionId: () => undefined,
        getActiveTurnInfo: () => undefined,
        getPlanEnabled: () => false,
        getSessionModelSelection: () => undefined,
        releaseForegroundPromotionLease: () => undefined,
      },
      sendInput: async (input, options) => {
        calls.sendInput += 1;
        captured.input = input;
        captured.options = options;
        return { completion: Promise.resolve(), kind: "started_turn", turnId: "turn-new" };
      },
      sessionId: SESSION_ID,
      setQueueAutoDrain: async () => undefined,
    },
    persistence: "immediate",
    traceContext: TRACE_CONTEXT,
  };
  const host = {
    afterLegacyStateMutation: async () => undefined,
    ensureModelReady: async () => undefined,
    getInputRoutingMode: () => null,
    getQueueItem: (sessionId, queueItemId) =>
      sessionId === SESSION_ID && queueItemId === queueItem.queueItemId ? queueItem : null,
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    getSessionInputForExecution: (sessionId, queueItemId) =>
      context.ledger.port.getSessionInputForExecution({ id: queueItemId, sessionID: sessionId }),
    logger: {
      info: () => undefined,
      warn: (message, fields) => calls.warnings.push({ fields, message }),
    },
  };
  const envelope = {
    baseRevision: 0,
    clientId: "v4-auto-drain",
    commandId: `auto-test-${queueItem.queueItemId}`,
    issuedAt: Date.now(),
    payload: { queueItemId: queueItem.queueItemId },
    sessionId: SESSION_ID,
    type: "sendQueuedNow",
  };
  return { calls, captured, envelope, host };
}

function readSource(relativePath) {
  return readFileSync(join(bootstrapSrc, relativePath), "utf8");
}

function readCoreSource(relativePath) {
  return readFileSync(join(coreSrc, relativePath), "utf8");
}

/** 去掉行注释与块注释，避免注释里的锚点文字把形状守卫喂成假绿。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

// ── T-RW0 源码形状 ──────────────────────────────────────────────────────────

test("T-RW0 级联必须挂在 setRevert 之后、RewindTriggered 之前（位置是语义的一部分）", () => {
  const source = stripComments(readCoreSource("runtime/methods/rewind-message.ts"));
  const setRevertIndex = source.indexOf("await this.sessionStore!.setRevert({");
  const cascadeIndex = source.indexOf("await this.discardRewoundPendingSteerInputs({");
  const rewindEventIndex = source.indexOf("SessionEventType.RewindTriggered", cascadeIndex);
  assert.ok(setRevertIndex > 0, "rewind-message 必须仍然调用 setRevert");
  assert.ok(cascadeIndex > 0, "截断级联必须被接线（spec 变更点 7）");
  assert.ok(setRevertIndex < cascadeIndex, "级联必须在 setRevert 之后：截断落账才是作废的前提");
  assert.ok(
    rewindEventIndex > cascadeIndex,
    "级联必须在 RewindTriggered 之前：UI 不应先看到历史截断、再看到旧项消失",
  );
});

test("T-RW0 级联不得读 activeTurn.pendingInputs（抢占后取不到，等于一条都没作废）", () => {
  const source = stripComments(readCoreSource("runtime/methods/steering.ts"));
  const start = source.indexOf("export async function discardRewoundPendingSteerInputs");
  assert.ok(start > 0, "discardRewoundPendingSteerInputs 必须存在");
  const body = source.slice(start, source.indexOf("\nexport ", start + 1));
  assert.doesNotMatch(body, /activeTurn\.pendingInputs/, "判据只能来自事件投影 pendingSteerInputs");
  assert.match(body, /rebuildProjection\(\)/, "判据必须经 rebuildProjection 读事件投影");
});

test("T-RW0 edit/retry 必须把自持 session_input id 传给 rewind（否则级联自伤）", () => {
  const source = stripComments(
    readSource("zcode-protocol-v4/commands/handlers/fork-edit-retry.ts"),
  );
  assert.match(
    source,
    /commandAdmissionOf\(envelope\)\.queueItemId/,
    "自持 id 必须与 admission 同源（queue_<commandId>），不得手写拼串",
  );
  const calls = source.match(/submitConversationRewind\(\s*host,\s*record,[\s\S]*?\)/g) ?? [];
  assert.equal(calls.length, 3, "edit（两条路径）+ retry 共三处 rewind 调用");
  for (const call of calls) {
    assert.match(call, /rewindExclusionIds\(envelope\)/, "每处 rewind 都必须传排除集");
  }
});

// ── T-RW1 判据三条 ──────────────────────────────────────────────────────────

test("T-RW1 被截断区间的未起跑输入全部 discarded(rewound)，幸存轮排队项原样保留", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  await seedQueuedInput(context, { id: KEPT_ID, targetTurnId: TURN_KEPT, text: KEPT_TEXT });
  await seedQueuedInput(context, {
    id: DEFERRED_ID,
    targetTurnId: "deferred",
    text: DEFERRED_TEXT,
  });

  const discarded = await context.runtime.discardRewoundPendingSteerInputs({
    removedTurnIds: [TURN_REMOVED, TURN_REMOVED_CHILD],
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(
    [...discarded].sort(),
    [DEFERRED_ID, OLD_ID].sort(),
    "只有「被截断的 turn」与 deferred 该被作废",
  );
  assert.equal(context.ledger.rows.get(OLD_ID).status, "discarded");
  assert.equal(context.ledger.rows.get(OLD_ID).statusReason, "rewound");
  assert.equal(context.ledger.rows.get(DEFERRED_ID).status, "discarded");
  assert.equal(
    context.ledger.rows.get(KEPT_ID).status,
    "admitted",
    "幸存轮的排队输入被误作废 = 吞掉用户输入",
  );

  // core 事件投影（pendingSteerInputs）与 v4 产品投影（queue.items）必须同时只剩幸存项。
  const projection = await context.runtime.rebuildProjection();
  assert.deepEqual(
    projection.pendingSteerInputs.map((item) => item.pendingInputId),
    [KEPT_ID],
  );
  assert.deepEqual(
    queueState(context).items.map((item) => item.queueItemId),
    [KEPT_ID],
  );

  // 事件本身要留痕：reason=rewound + 正确的 targetTurnId（诊断/冷恢复都靠它）。
  const events = await context.runtime.eventStore.getEvents(SESSION_ID);
  const discards = events.filter((event) => event.type === SessionEventType.TurnSteerDiscarded);
  assert.equal(discards.length, 2, "按 targetTurnId 分组发事件");
  assert.deepEqual(
    discards.map((event) => event.payload.reason),
    ["rewound", "rewound"],
  );
  assert.deepEqual(
    discards.map((event) => event.payload.targetTurnId),
    [TURN_REMOVED, "deferred"],
  );
});

test("T-RW1 removedTurnIds 为空 → 零作废零事件（无截断就没有级联）", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });

  const discarded = await context.runtime.discardRewoundPendingSteerInputs({
    removedTurnIds: [],
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(discarded, []);
  assert.equal(context.ledger.rows.get(OLD_ID).status, "admitted");
  assert.equal(context.ledger.calls.settles.length, 0);
});

test("T-RW1 账本已终态的行不会被级联写回（promoted 不许回退，settle 幂等）", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  context.ledger.rows.get(OLD_ID).status = "promoted";

  await context.runtime.discardRewoundPendingSteerInputs({
    removedTurnIds: [TURN_REMOVED],
    traceContext: TRACE_CONTEXT,
  });

  assert.equal(context.ledger.rows.get(OLD_ID).status, "promoted", "已 promotion 的行不得回退");
});

test("T-RW1 预 settle 失败时事件汇兜底：rewound 必须落 discarded，不是 cancelled", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  // 第一次 settle（级联自己的持久终态写）失败，第二次（appendEvent → events.ts 事件汇）成功。
  context.ledger.failSettle.remaining = 1;

  await context.runtime.discardRewoundPendingSteerInputs({
    removedTurnIds: [TURN_REMOVED],
    traceContext: TRACE_CONTEXT,
  });

  const settles = context.ledger.calls.settles.filter((call) => call.id === OLD_ID);
  assert.equal(settles.length, 2, "预 settle + 事件汇兜底各一次");
  assert.equal(context.ledger.rows.get(OLD_ID).status, "discarded");
  assert.equal(
    context.ledger.rows.get(OLD_ID).statusReason,
    "rewound",
    "reason 必须原样留痕；把 rewound 映射成 cancelled 会让「这条输入为什么没了」失真",
  );
  // 预 settle 失败不得阻断作废：投影仍然收口（否则队列里留下一条永远不可执行的幽灵项）。
  assert.deepEqual(queueState(context).items, []);
});

// ── T-RW2 本 bug 的核心断言（真实可达链） ───────────────────────────────────

test("T-RW2 暂停队列 + 编辑重发：点「继续」时旧项从未被提升，新文本路由为 startNow", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  // 终止 → 队列暂停（stop 显式 setQueueAutoDrain(false)；同一调用同时翻 runtime 门和投影）。
  await setAutoDrain(context, false);
  // 本次编辑重发自身的 admission 行（新文本）。生产时序：空闲编辑重发时 admission 发生在
  // rewind 之后（startCanonicalIntent），此刻投影里还没有它的队列项——只有账本行。
  context.ledger.seed({ id: SELF_ID, text: NEW_TEXT });

  const before = queueState(context);
  assert.deepEqual(
    before.items.map((item) => item.queueItemId),
    [OLD_ID],
    "改前/截断前：属于被截断那一轮的旧项还在队列里",
  );

  // rewind 截断（真实级联；报告里附的「改前红」就是把这一行删掉/退化成空实现）。
  await context.runtime.discardRewoundPendingSteerInputs({
    excludeSessionInputIds: [SELF_ID],
    removedTurnIds: [TURN_REMOVED, TURN_REMOVED_CHILD],
    traceContext: TRACE_CONTEXT,
  });

  // 用户点「继续」。
  const resumed = await resumeAutoDrain(context);
  assert.equal(
    resumed.calls?.sendInput ?? 0,
    0,
    "旧项被提升起轮 = I2 违反（改前红：这里会是 1，且内容是 OLD_TEXT）",
  );
  assert.equal(resumed.promoted, false, "作废后队首不存在，auto-drain 无事可做");

  // 旧文本即使被别的路径拿到投影项，也再也取不到执行权威（I1 + I2 双保险）。
  const oldAuthority = await context.ledger.port.getSessionInputForExecution({
    id: OLD_ID,
    sessionID: SESSION_ID,
  });
  assert.equal(oldAuthority.state, "voided");
  assert.equal(oldAuthority.status, "discarded");
  assert.equal(oldAuthority.statusReason, "rewound");

  // 新文本不再被旧项挡在队列后面：空闲 + 队列空 → startNow。
  const routing = computeInputRouting(
    {
      autoDrain: queueState(context).autoDrain,
      goalStatus: null,
      goalVerifying: false,
      phase: "completedInterrupted",
      queueLength: queueState(context).queueLength,
    },
    "queue",
  );
  assert.equal(
    routing.mode,
    "startNow",
    "队列里还剩旧项时这里是 enqueue——新文本被静默排队就是用户看到的「发出去的是旧消息」",
  );
});

test("T-RW2 反向：未作废时同一条链会把 OLD_TEXT 起轮（证明用例真的在测那条链）", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  await setAutoDrain(context, false);

  const resumed = await resumeAutoDrain(context);
  assert.equal(resumed.promoted, true, "对照组：没有级联时旧项一定会被提升");
  assert.equal(resumed.calls.sendInput, 1);
  assert.equal(resumed.captured.input.text, OLD_TEXT, "对照组起跑的正是旧文本");
});

// ── T-RW3 投影收口 + autoDrain 双侧复位（Step 5） ───────────────────────────

test("T-RW3 TurnSteerDiscarded 对任意 reason 都移除队列项（promoted 依赖同一语义）", async () => {
  for (const reason of ["rewound", "promoted", "user_removed", "turn_cancelled"]) {
    const context = createContext();
    await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
    await emitFact(context, SessionEventType.TurnSteerDiscarded, {
      pendingInputIds: [OLD_ID],
      reason,
      targetTurnId: TURN_REMOVED,
    });
    assert.deepEqual(
      queueState(context).items,
      [],
      `reason=${reason} 时投影必须移除该项（onTurnSteerDiscarded 不许按 reason 过滤）`,
    );
  }
});

test("T-RW3 作废清空队列后：runtime 门与 v4 投影同时复位 autoDrain（只复位一侧即失败）", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  // 「终止」留下的暂停态：runtime 门与投影由同一次权威写入同时翻到 false。
  await setAutoDrain(context, false);
  assert.equal(context.runtime.queueAutoDrain, false);
  assert.equal(context.runtime.queueExternalDrainActive, false);
  assert.equal(queueState(context).autoDrain, false);
  assert.equal(queueState(context).pauseReason, "manual");

  const discarded = await context.runtime.discardRewoundPendingSteerInputs({
    removedTurnIds: [TURN_REMOVED],
    traceContext: TRACE_CONTEXT,
  });
  assert.deepEqual(discarded, [OLD_ID]);

  // 投影侧：项被移除（既有行为）+ 授权位复位（v4 投影消费 QueueAutoDrainChanged）。
  assert.deepEqual(queueState(context).items, []);
  assert.equal(
    queueState(context).autoDrain,
    true,
    "投影侧必须复位：autoDrain=false 会被 v4 投影派生为 held，下一次入队就再也不会自动放行",
  );
  assert.equal(queueState(context).pauseReason, undefined, "复位后不得残留 pauseReason");
  // 门侧：runtime 的授权位与 external drain 标记。
  assert.equal(context.runtime.queueAutoDrain, true, "runtime 门必须复位");
  assert.equal(
    context.runtime.queueExternalDrainActive,
    false,
    "队列已空 = 没有待外层 FIFO 提升的项；标记停在 true 会抑制下一轮的行内 guide 消费",
  );

  // 复位事件必须排在作废事件之后：UI 先看到项消失，再看到恢复；且只发一次。
  const relevant = (await context.runtime.eventStore.getEvents(SESSION_ID))
    .filter(
      (event) =>
        event.type === SessionEventType.QueueAutoDrainChanged ||
        event.type === SessionEventType.TurnSteerDiscarded,
    )
    .map((event) =>
      event.type === SessionEventType.TurnSteerDiscarded
        ? "discarded"
        : `autoDrain:${event.payload.autoDrain}`,
    );
  assert.deepEqual(relevant, ["autoDrain:false", "discarded", "autoDrain:true"]);

  // 复位不得把任何东西「顺带提升」：队列空 + 门开，auto-drain 无事可做。
  const resumed = await resumeAutoDrain(context);
  assert.equal(resumed.promoted, false);
  assert.equal(resumed.calls?.sendInput ?? 0, 0);
});

test("T-RW3 队列非空（幸存 held 项）时必须保持 held：复位会让它在 start 前抢跑", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  await seedQueuedInput(context, { id: KEPT_ID, targetTurnId: TURN_KEPT, text: KEPT_TEXT });
  await setAutoDrain(context, false);

  await context.runtime.discardRewoundPendingSteerInputs({
    removedTurnIds: [TURN_REMOVED],
    traceContext: TRACE_CONTEXT,
  });

  // 本次删掉了 1 条，但队列里还有 survivor —— 用「删了几条」推算会在这里误开门。
  assert.deepEqual(
    queueState(context).items.map((item) => item.queueItemId),
    [KEPT_ID],
  );
  assert.equal(queueState(context).autoDrain, false, "投影侧必须保持 held");
  assert.equal(context.runtime.queueAutoDrain, false, "runtime 门必须保持关闭");
  assert.equal(context.runtime.queueExternalDrainActive, false);

  const autoDrainEvents = (await context.runtime.eventStore.getEvents(SESSION_ID)).filter(
    (event) => event.type === SessionEventType.QueueAutoDrainChanged,
  );
  assert.deepEqual(
    autoDrainEvents.map((event) => event.payload.autoDrain),
    [false],
    "队列非空时不得追加复位事件",
  );

  // 保持关闭的真实后果：survivor 不会被 auto-drain 提升；反证若误复位就会被提升起轮
  // （rewind 返回后 afterLegacyStateMutation → autoDrainV4QueueIfReady 早于 startCanonicalIntent）。
  const head = queueState(context).items[0];
  const gate = (autoDrain) =>
    shouldAutoDrainV4QueueHead({
      autoDrain,
      dispatchState: head.dispatch.state,
      sessionBusy: false,
      targetStatus: null,
    });
  assert.equal(gate(queueState(context).autoDrain), false, "幸存项不得被提升");
  assert.equal(gate(true), true, "反证：无条件复位时同一闸门会放行幸存项 = 本 bug 复发");
});

test("T-RW3 无可作废项时不碰暂停位（队列本来就空 ≠ 本次作废清了队列）", async () => {
  const context = createContext();
  await setAutoDrain(context, false);

  const discarded = await context.runtime.discardRewoundPendingSteerInputs({
    removedTurnIds: [TURN_REMOVED],
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(discarded, []);
  assert.equal(queueState(context).autoDrain, false, "本次没作废任何项，不该改动暂停语义");
  assert.equal(context.runtime.queueAutoDrain, false);
  assert.equal(
    (await context.runtime.eventStore.getEvents(SESSION_ID)).filter(
      (event) => event.type === SessionEventType.QueueAutoDrainChanged,
    ).length,
    1,
    "不得追加复位事件",
  );
});

// ── T-RW5 不自伤（观测中间态） ──────────────────────────────────────────────

test("T-RW5 排除集生效：自持 id 没有任何 settle 调用、账本仍 admitted，且随后能正常起轮", async () => {
  const context = createContext();
  // 最危险的形态：重发自身的 TurnSteerQueued 把 targetTurnId 记成了被截断的那个 turn。
  await seedQueuedInput(context, { id: SELF_ID, targetTurnId: TURN_REMOVED, text: NEW_TEXT });
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });

  const discarded = await context.runtime.discardRewoundPendingSteerInputs({
    excludeSessionInputIds: [SELF_ID],
    removedTurnIds: [TURN_REMOVED],
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(discarded, [OLD_ID], "自持项不在作废集合里");
  assert.equal(
    context.ledger.calls.settles.filter((call) => call.id === SELF_ID).length,
    0,
    "对自身 id 的任何 settle 调用都算自伤（终态上看不出来：误 settle 会让 promote 直接硬失败）",
  );
  assert.equal(
    context.ledger.rows.get(SELF_ID).status,
    "admitted",
    "start 之前账本必须仍是 admitted",
  );
  assert.deepEqual(
    queueState(context).items.map((item) => item.queueItemId),
    [SELF_ID],
    "自持项必须还留在队列里（它才是这次要跑的输入）",
  );

  // 随后真实提升：执行内容 == 账本里的 NEW_TEXT（自伤时这里会因账本终态硬失败）。
  const selfItem = queueState(context).items[0];
  const harness = promotionHarness(context, selfItem);
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);
  assert.equal(harness.calls.sendInput, 1);
  assert.equal(harness.captured.input.text, NEW_TEXT);
});
