#!/usr/bin/env node
/**
 * Step 6 / T-E1 —— 编辑重发「模型侧」闭环的自动化验证。
 *
 * ============================================================================
 * 这一步要锁死的失效形态
 * ============================================================================
 *
 * 用户切到新模型后编辑旧消息重发，出现两个叠加症状：
 *   A. turn 仍跑在被编辑轮的旧模型上——协议面无处携带「本次提交的显式选择」；
 *   B. 更糟的是旧快照会被静默写回并持久化到 session_model_selection，把用户
 *      刚切换的模型还原成旧值（“编辑后模型也没切到最新”的根因之一）。
 *
 * 修复闭环（ spec ① 变更点 1a/1c/1c'/1d ）：
 *   1a  editUserQuery payload 新增 modelSelection（显式携带 = 覆盖优先）；
 *   1c/1c'  intent 重建时 payload.modelSelection ?? 旧快照，并打 modelSelectionPinned；
 *   1d  runtime 仅对显式 pin 的选择执行「写回 + 持久化 + emitModelSelected」三连，
 *       继承快照不再覆盖会话选择，但本次执行仍按 intent 的 modelSelection 建 Model。
 *
 * 本文件六组断言各对一处收口：
 *   A 协议面：editUserQuery payload 带/不带 modelSelection 均可解析（zod）。
 *   B 命令面：fork-edit-retry 显式覆盖优先 + pin 标记；缺省沿用旧快照但不 pin；
 *     retryTurn（故意重发原文）仍用旧快照且不 pin。
 *   C 运行时面：applySubmissionExecutionState 仅 pin 时写回三连；继承快照
 *     不动 session_model_selection，但 turn 仍使用 intent 携带的选择。
 *   D pin 边界集（round-2 追加）：除 editUserQuery / fork-edit-retry 外，
 *     sendGoalCommand / createSession firstInput / legacy session/send 三条
 *     payload 显式携带 modelSelection 的路径同样必须置 pin——漏置会让 1d 拒绝
 *     写回，把「显式选择不落库」变成静默行为变更。断言「显式携带 → pin →
 *     写回生效」闭环；缺省路径保持不 pin。
 *   E pin 主路径（round-3 追加，agent/G-1）：sendText 是普通用户输入的唯一
 *     主路径，session-flow.ts 置 pin 行（payload.modelSelection !== undefined）
 *     的两个静默失效方向（恒 true→旧 bug 复活；恒 false→显式选择永不落库）
 *     此前零测试覆盖（全仓无 sendText handler 测试）。直接驱动 handler：
 *     E1 显式携带→pinned true+写回三连；E2 缺省→pinned false+不写回。
 *   F pin 不跨持久化/queue 提升不变式（round-3 追加，agent/G-2）：
 *     modelSelectionPinned 是 admission 期进程内标志——buildPersistedConversation
 *     InputIntent 与 inputIntentMetadataFromQueueItem 的输出均不得携带该键，
 *     且喂回执行态时不得写回（冷恢复/queue 提升按非显式处理）。
 *
 * 运行方式：`npx tsx --test scripts/test-edit-retry-model.mjs`（与
 * test-turn-directory 同源：tsx 直接吃 src，免去「先 build bootstrap 再跑测试」的
 * 前置；@zcode/contracts/@zcode/shared 分别走 dist 与 src exports）。
 */

import assert from "node:assert/strict";
import test from "node:test";

const { commandPayloadSchemas } = await import("@zcode/shared/zcode-protocol-v4");
const { SESSION_ENTRY_MODEL_SELECTION } = await import("@zcode/contracts");
// fork-edit-retry ⇄ input-intent ⇄ executor ⇄ handlers/index 之间存在循环依赖；
// 只有以 executor 为入口先初始化（commandAdmissionOf 是函数声明、提升后可用），
// 再取 fork-edit-retry 导出才不会在 handlers/index 的重导出上命中 TDZ。
await import(new URL("../src/zcode-protocol-v4/commands/executor.ts", import.meta.url).href);
const { forkEditRetryHandlers } = await import(
  new URL("../src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts", import.meta.url).href
);
const { goalHandlers } = await import(
  new URL("../src/zcode-protocol-v4/commands/handlers/goal.ts", import.meta.url).href
);
const { sessionMgmtHandlers } = await import(
  new URL("../src/zcode-protocol-v4/commands/handlers/session-mgmt.ts", import.meta.url).href
);
const { sendPrompt } = await import(
  new URL("../src/zcode-protocol/server-operations.ts", import.meta.url).href
);
const { sessionFlowHandlers } = await import(
  new URL("../src/zcode-protocol-v4/commands/handlers/session-flow.ts", import.meta.url).href
);
const { inputIntentMetadataFromCanonical, inputIntentMetadataFromQueueItem } = await import(
  new URL("../src/zcode-protocol-v4/commands/input-intent.ts", import.meta.url).href
);
const { buildPersistedConversationInputIntent } = await import(
  new URL("../../core/src/runtime/methods/input-intent-persistence.ts", import.meta.url).href
);
const { applySubmissionExecutionState } = await import(
  new URL("../../core/src/runtime/methods/turn-model.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 6 edit-resend model selection (T-E1)"
      : `TEST FAIL — Step 6 edit-resend model selection (exit code ${code})`,
  );
});

const SESSION_ID = "ses_te1";
const EPOCH = "epoch-te1";

/** 用户在编辑前刚切换到的显式选择（提交时应覆盖旧快照）。 */
const EXPLICIT_SELECTION = Object.freeze({
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  options: Object.freeze({ reasoningLevel: "high" }),
});
/** 被编辑轮/queue item 里遗留的旧快照。 */
const SNAPSHOT_SELECTION = Object.freeze({
  providerId: "openai",
  modelId: "gpt-5",
  options: Object.freeze({ reasoningLevel: "medium" }),
});

// ── A: 协议面 ───────────────────────────────────────────────────────────────

test("A1: editUserQuery payload 带/不带 modelSelection 均可解析", () => {
  const base = { target: { rowId: 4, entityId: "ent-4" }, newText: "edited text" };
  const withoutSelection = commandPayloadSchemas.editUserQuery.safeParse(base);
  assert.ok(withoutSelection.success, "缺省 modelSelection 必须仍可解析（旧发送端兼容）");
  assert.equal(withoutSelection.data.modelSelection, undefined);

  const withSelection = commandPayloadSchemas.editUserQuery.safeParse({
    ...base,
    modelSelection: EXPLICIT_SELECTION,
  });
  assert.ok(withSelection.success, "携带 modelSelection 必须可解析");
  assert.deepEqual(withSelection.data.modelSelection, EXPLICIT_SELECTION);
});

// ── B: 命令面（fork-edit-retry intent 重建）─────────────────────────────────

/** 一个最小可驱动的 v4 命令宿主/record；sendInput 捕获交给 core 的 intent。 */
function createCommandHarness({ editTarget, payload }) {
  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      runtime: {
        rewindConversationToMessage: async () => ({ strategy: "active_chain" }),
      },
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-te1", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    resolveRowActionTarget: () => ({
      ok: true,
      action: "editUserQuery",
      row: {
        rowId: payload.target.rowId,
        turnId: "turn-1",
        entityId: payload.target.entityId,
        productTurnId: "turn-1",
        visibility: "visible",
        kind: "userInput",
      },
      editTarget,
      messageId: editTarget.transcriptMessageId,
    }),
    afterLegacyStateMutation: async () => {},
  };
  const envelope = {
    commandId: "cmd-edit-te1",
    clientId: "ui",
    sessionId: SESSION_ID,
    type: "editUserQuery",
    payload,
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
  };
  return { host, envelope, captured };
}

function editTargetWithSnapshot(snapshotSelection) {
  return {
    entityId: "ent-4",
    productTurnId: "turn-1",
    transcriptMessageId: "msg-4",
    intent: {
      kind: "sendText",
      text: "original text",
      sourceCommandId: "cmd-original",
      clientId: "ui",
      queueItemId: "queue-original",
      requestedDelivery: "startNow",
      admittedDelivery: "startNow",
      modelSelection: snapshotSelection,
    },
  };
}

test("B1: 编辑重发显式携带 modelSelection → turn 用提交的选择且 pin", async () => {
  const payload = {
    target: { rowId: 4, entityId: "ent-4" },
    newText: "edited text",
    modelSelection: EXPLICIT_SELECTION,
  };
  const { host, envelope, captured } = createCommandHarness({
    editTarget: editTargetWithSnapshot(SNAPSHOT_SELECTION),
    payload,
  });
  const result = await forkEditRetryHandlers.editUserQuery(host, envelope);
  assert.equal(result?.type, "editUserQuery");
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "core sendInput 必须收到 intent");
  // 显式覆盖优先：不是旧快照。
  assert.deepEqual(intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(intent.modelSelectionPinned, true);
  // 编辑后的新文本照常重发。
  assert.equal(intent.text, "edited text");
  assert.equal(captured.sendInput.text, "edited text");
});

test("B2: 编辑重发缺省 modelSelection → 沿用旧快照但不 pin", async () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: "edited text" };
  const { host, envelope, captured } = createCommandHarness({
    editTarget: editTargetWithSnapshot(SNAPSHOT_SELECTION),
    payload,
  });
  await forkEditRetryHandlers.editUserQuery(host, envelope);
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "core sendInput 必须收到 intent");
  assert.deepEqual(intent.modelSelection, SNAPSHOT_SELECTION);
  assert.equal(intent.modelSelectionPinned, false);
});

test("B3: retryTurn 仍重发原文 + 旧快照，且不 pin（写回收敛外语义不变）", async () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" } };
  const { host, envelope, captured } = createCommandHarness({
    editTarget: editTargetWithSnapshot(SNAPSHOT_SELECTION),
    payload,
  });
  envelope.type = "retryTurn";
  await forkEditRetryHandlers.retryTurn(host, envelope);
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "core sendInput 必须收到 intent");
  assert.equal(intent.text, "original text");
  assert.equal(captured.sendInput.text, "original text");
  assert.deepEqual(intent.modelSelection, SNAPSHOT_SELECTION);
  assert.equal(intent.modelSelectionPinned, false);
});

// ── C: 运行时面（applySubmissionExecutionState 写回收敛）────────────────────

function createStubModel(selection) {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    displayName: "stub-model",
    properties: {},
    optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } },
    options: { reasoningLevel: selection.options?.reasoningLevel ?? "high" },
    // 本测试只走到「选模型、写回、发事件」，不产生 provider 请求。
    bind: () => {
      throw new Error("stub model bind must not be called");
    },
    generateText: async () => {
      throw new Error("stub model generateText must not be called");
    },
    streamText: async () => {
      throw new Error("stub model streamText must not be called");
    },
  };
}

function createRuntimeHarness(sessionSelection) {
  const calls = [];
  const state = { selection: sessionSelection };
  const runtime = {
    config: { taskType: "default" },
    sessionId: SESSION_ID,
    getSessionModelSelection: () => state.selection,
    setSessionModelSelection: (selection) => {
      calls.push({ kind: "setSessionModelSelection", selection });
      state.selection = selection;
    },
    emitModelSelected: async (event) => {
      calls.push({ kind: "emitModelSelected", event });
    },
    sessionStore: {
      saveSessionEntry: async (entry) => {
        calls.push({ kind: "persist", entry });
      },
    },
    modelFactory: (input) => {
      calls.push({ kind: "modelFactory", selection: input.selection });
      return createStubModel(input.selection);
    },
  };
  return { runtime, calls, state };
}

function intentWith(selection, pinned) {
  return {
    sourceCommandId: "cmd-edit-te1",
    queueItemId: "queue-edit-te1",
    clientId: "ui",
    kind: "sendText",
    text: "edited text",
    modelSelection: selection,
    ...(pinned === undefined ? {} : { modelSelectionPinned: pinned }),
    admissionSeq: 1,
    admittedAt: 1_700_000_000_000,
    requestedDelivery: "startNow",
    admittedDelivery: "startNow",
  };
}

const TRACE = { traceId: "trace-te1" };

test("C1: pin 的选择 → 写回 + 持久化 + emitModelSelected 三连", async () => {
  const harness = createRuntimeHarness(SNAPSHOT_SELECTION);
  const model = await applySubmissionExecutionState(
    harness.runtime,
    intentWith(EXPLICIT_SELECTION, true),
    TRACE,
  );
  assert.ok(model, "必须返回本次执行使用的 Model");
  // turn 使用的就是提交时显式选择的模型。
  assert.equal(model.providerId, EXPLICIT_SELECTION.providerId);
  assert.equal(model.modelId, EXPLICIT_SELECTION.modelId);
  const kinds = harness.calls.map((call) => call.kind);
  assert.ok(kinds.includes("setSessionModelSelection"), "显式选择必须写回会话");
  assert.ok(kinds.includes("persist"), "显式选择必须持久化 session_model_selection");
  assert.ok(kinds.includes("emitModelSelected"), "模型变化必须广播 ModelSelected");
  assert.deepEqual(harness.state.selection, EXPLICIT_SELECTION);
  const persisted = harness.calls.find((call) => call.kind === "persist");
  assert.equal(persisted.entry.type, SESSION_ENTRY_MODEL_SELECTION);
});

test("C2: 继承快照（无 pin）→ 不写回不持久化，但 turn 仍用该选择执行", async () => {
  for (const pinned of [undefined, false]) {
    const harness = createRuntimeHarness(SNAPSHOT_SELECTION);
    const model = await applySubmissionExecutionState(
      harness.runtime,
      intentWith(EXPLICIT_SELECTION, pinned),
      TRACE,
    );
    assert.ok(model, "必须返回本次执行使用的 Model");
    // 本次执行仍按 intent 的选择建 Model（只是不动会话态）。
    assert.equal(model.providerId, EXPLICIT_SELECTION.providerId);
    assert.equal(model.modelId, EXPLICIT_SELECTION.modelId);
    const kinds = harness.calls.map((call) => call.kind);
    assert.deepEqual(
      kinds.filter((kind) => kind !== "modelFactory"),
      [],
      "继承快照不得写回/持久化/广播（pinned=" + String(pinned) + "）",
    );
    // session_model_selection 不被旧快照覆盖。
    assert.deepEqual(harness.state.selection, SNAPSHOT_SELECTION);
  }
});

test("C3: pin 且与会话选择相同 → 写回仍在，但不重复广播", async () => {
  const harness = createRuntimeHarness(EXPLICIT_SELECTION);
  await applySubmissionExecutionState(
    harness.runtime,
    intentWith(EXPLICIT_SELECTION, true),
    TRACE,
  );
  const kinds = harness.calls.map((call) => call.kind);
  assert.ok(kinds.includes("setSessionModelSelection"));
  assert.ok(kinds.includes("persist"));
  assert.ok(!kinds.includes("emitModelSelected"), "同值选择不得重复广播 ModelSelected");
});

// ── D: pin 边界集（round-2 追加）────────────────────────────────────────────

/** 断言「显式携带 → pin → 写回生效」闭环：把路径产生的 intent 喂回 runtime 门。 */
async function assertPinClosesWriteBack(intent) {
  const harness = createRuntimeHarness(SNAPSHOT_SELECTION);
  const model = await applySubmissionExecutionState(harness.runtime, intent, TRACE);
  assert.ok(model, "必须返回本次执行使用的 Model");
  assert.equal(model.providerId, EXPLICIT_SELECTION.providerId);
  assert.equal(model.modelId, EXPLICIT_SELECTION.modelId);
  const kinds = harness.calls.map((call) => call.kind);
  assert.ok(kinds.includes("setSessionModelSelection"), "pin 的显式选择必须写回会话");
  assert.ok(kinds.includes("persist"), "pin 的显式选择必须持久化");
  assert.ok(kinds.includes("emitModelSelected"), "pin 的显式选择必须广播 ModelSelected");
  assert.deepEqual(harness.state.selection, EXPLICIT_SELECTION);
}

/** sendGoalCommand 的最小宿主/record；intent 落在 app.setTarget 与续跑入口。 */
function createGoalHarness({ text, modelSelection }) {
  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      getMode: () => "build",
      getModel: () => "openai/gpt-5",
      readTarget: async () => null,
      setTarget: async (params) => {
        captured.intent = params.intent;
        return undefined;
      },
      continueActiveTarget: async (options) => {
        captured.continuationIntent = options.intent;
        return undefined;
      },
      runtime: {
        getPlanEnabled: () => false,
        getSessionModelSelection: () => SNAPSHOT_SELECTION,
        setExecutionState: async () => undefined,
      },
    },
    traceContext: { traceId: "trace-te1", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    getInputRoutingMode: () => null,
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
  };
  const envelope = {
    commandId: "cmd-goal-te1",
    clientId: "ui",
    sessionId: SESSION_ID,
    type: "sendGoalCommand",
    payload: { text, ...(modelSelection ? { modelSelection } : {}) },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
  };
  return { host, envelope, captured };
}

test("D1: sendGoalCommand 显式携带 modelSelection → pin + 写回生效", async () => {
  const { host, envelope, captured } = createGoalHarness({
    text: "/goal 修复模型选择",
    modelSelection: EXPLICIT_SELECTION,
  });
  await goalHandlers.sendGoalCommand(host, envelope);
  const intent = captured.intent;
  assert.ok(intent, "goal 提交必须携带 intent");
  assert.deepEqual(intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(intent.modelSelectionPinned, true);
  await assertPinClosesWriteBack(intent);
});

test("D2: sendGoalCommand 缺省 modelSelection → 不 pin（不写回）", async () => {
  const { host, envelope, captured } = createGoalHarness({ text: "/goal 修复模型选择" });
  await goalHandlers.sendGoalCommand(host, envelope);
  const intent = captured.intent;
  assert.ok(intent, "goal 提交必须携带 intent");
  assert.equal(intent.modelSelectionPinned, false);
  // resolveSubmittedExecutionState 兜底固定的 Session 快照：runtime 侧不写回。
  const harness = createRuntimeHarness(SNAPSHOT_SELECTION);
  await applySubmissionExecutionState(harness.runtime, intent, TRACE);
  assert.deepEqual(harness.state.selection, SNAPSHOT_SELECTION);
});

/** createSession.firstInput 的最小宿主/record；intent 经 app.sendInput 落 core。 */
function createSessionHarness({ firstInput }) {
  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      runtime: {
        getSessionModelSelection: () => SNAPSHOT_SELECTION,
      },
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-te1", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    createSessionRecord: async () => ({ sessionId: SESSION_ID }),
    admitInputCommand: async () => null,
    afterLegacyStateMutation: async () => undefined,
  };
  const envelope = {
    commandId: "cmd-create-te1",
    clientId: "ui",
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: "ws-te1", ...(firstInput ? { firstInput } : {}) },
    issuedAt: new Date(1_700_000_000_000),
  };
  return { host, envelope, captured };
}

test("D3: createSession firstInput 显式携带 modelSelection → pin + 写回生效", async () => {
  const { host, envelope, captured } = createSessionHarness({
    firstInput: { text: "hello", modelSelection: EXPLICIT_SELECTION },
  });
  const result = await sessionMgmtHandlers.createSession(host, envelope);
  assert.equal(result?.type, "createSession");
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "首条 turn 必须携带 intent");
  assert.deepEqual(intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(intent.modelSelectionPinned, true);
  await assertPinClosesWriteBack(intent);
});

test("D4: createSession firstInput 缺省 modelSelection → 不 pin（不写回）", async () => {
  const { host, envelope, captured } = createSessionHarness({ firstInput: { text: "hello" } });
  await sessionMgmtHandlers.createSession(host, envelope);
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "首条 turn 必须携带 intent");
  // 旧发送端缺省 → admission 兜底固定 Session 快照，不得 pin。
  assert.deepEqual(intent.modelSelection, SNAPSHOT_SELECTION);
  assert.equal(intent.modelSelectionPinned, false);
});

test("D5: legacy session/send 显式携带 modelSelection → pin + 写回生效", async () => {
  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started_turn", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-te1", sessionId: SESSION_ID },
    workspace: { workspacePath: "D:\\ws-te1" },
    persistence: "immediate",
    stateRevision: 0,
    updatedAt: 0,
    taskType: "user",
  };
  const context = {
    sessions: new Map([[SESSION_ID, record]]),
    logger: { info: () => {}, warn: () => {} },
    notify: () => undefined,
  };
  await sendPrompt(context, {
    sessionId: SESSION_ID,
    content: "legacy text",
    modelSelection: EXPLICIT_SELECTION,
  });
  // 后台 turn 的前缀同步段就会调用 sendInput；再让出一个宏任务确保收尾。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "legacy send 必须携带 intent");
  assert.deepEqual(intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(intent.modelSelectionPinned, true);
  await assertPinClosesWriteBack(intent);
});

// ── E: pin 主路径（round-3 追加，sendText handler 直驱）──────────────────────

/**
 * sendText 的最小宿主/record（桩参考 D 组范式）：
 * getInputRoutingMode→null（不经 held queue 分支）、ensureModelReady 空实现、
 * queue 系钩子本路径不触达（routing=null 时 applyHeldQueueDisposition 即返回），
 * app.sendInput 捕获 core admission 收到的 intent。
 */
function createSendTextHarness({ text, modelSelection }) {
  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      getMode: () => "build",
      getModel: () => "openai/gpt-5",
      runtime: {
        getSessionModelSelection: () => SNAPSHOT_SELECTION,
        getPlanEnabled: () => false,
        getActiveTurnInfo: () => undefined,
      },
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started_turn", turnId: "turn-te1", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-te1", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    getInputRoutingMode: () => null,
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
  };
  const envelope = {
    commandId: "cmd-send-te1",
    clientId: "ui",
    sessionId: SESSION_ID,
    type: "sendText",
    payload: { text, ...(modelSelection ? { modelSelection } : {}) },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
  };
  return { host, envelope, captured };
}

test("E1: sendText 显式携带 modelSelection → pin + 写回生效", async () => {
  const { host, envelope, captured } = createSendTextHarness({
    text: "send text te1",
    modelSelection: EXPLICIT_SELECTION,
  });
  await sessionFlowHandlers.sendText(host, envelope);
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "sendText 必须携带 intent");
  assert.deepEqual(intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(intent.modelSelectionPinned, true);
  assert.equal(intent.text, "send text te1");
  assert.equal(captured.sendInput.text, "send text te1");
  await assertPinClosesWriteBack(intent);
});

test("E2: sendText 缺省 modelSelection → 沿用 Session 快照，不 pin（不写回）", async () => {
  const { host, envelope, captured } = createSendTextHarness({ text: "send text te1" });
  await sessionFlowHandlers.sendText(host, envelope);
  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "sendText 必须携带 intent");
  // admission 兜底固定的 Session 快照不算显式选择：不得 pin、不得写回。
  assert.deepEqual(intent.modelSelection, SNAPSHOT_SELECTION);
  assert.equal(intent.modelSelectionPinned, false);
  const harness = createRuntimeHarness(SNAPSHOT_SELECTION);
  const model = await applySubmissionExecutionState(harness.runtime, intent, TRACE);
  assert.ok(model, "必须返回本次执行使用的 Model");
  assert.equal(model.providerId, SNAPSHOT_SELECTION.providerId);
  assert.equal(model.modelId, SNAPSHOT_SELECTION.modelId);
  const kinds = harness.calls.map((call) => call.kind);
  assert.deepEqual(
    kinds.filter((kind) => kind !== "modelFactory"),
    [],
    "缺省路径不得写回/持久化/广播",
  );
  assert.deepEqual(harness.state.selection, SNAPSHOT_SELECTION);
});

// ── F: pin 不跨持久化/queue 提升不变式（round-3 追加）────────────────────────

test("F1: buildPersistedConversationInputIntent 剥离 modelSelectionPinned（喂回不写回）", async () => {
  // 先经 admission 面构造确实带 pin 的 intent（E1 同源事实）。
  const pinnedIntent = inputIntentMetadataFromCanonical(
    {
      commandId: "cmd-f1",
      clientId: "ui",
      sessionId: SESSION_ID,
      type: "sendText",
      issuedAt: new Date(1_700_000_000_000),
      baseRevision: 3,
      baseLogEpoch: EPOCH,
    },
    {
      kind: "sendText",
      text: "f1 text",
      modelSelection: EXPLICIT_SELECTION,
      modelSelectionPinned: true,
      sourceCommandId: "cmd-f1-original",
      clientId: "ui",
      queueItemId: "queue-f1-original",
      requestedDelivery: "startNow",
      admittedDelivery: "startNow",
    },
  );
  assert.equal(pinnedIntent.modelSelectionPinned, true, "前置：admission intent 必须带 pin");

  const persisted = buildPersistedConversationInputIntent("f1 text", pinnedIntent, "queued");
  assert.ok(persisted, "持久化输出必须存在");
  assert.ok(
    !("modelSelectionPinned" in persisted),
    "持久化输出不得携带 modelSelectionPinned 键（admission 期进程内标志不落库）",
  );
  // modelSelection 本身仍落库（恢复与回放需要），丢的只是 pin。
  assert.deepEqual(persisted.modelSelection, EXPLICIT_SELECTION);

  // 喂回执行态：持久化对象无 pin → 不得写回/持久化/广播（冷恢复第一轮按非显式处理）。
  const harness = createRuntimeHarness(SNAPSHOT_SELECTION);
  await applySubmissionExecutionState(harness.runtime, persisted, TRACE);
  const kinds = harness.calls.map((call) => call.kind);
  assert.deepEqual(
    kinds.filter((kind) => kind !== "modelFactory"),
    [],
    "持久化 intent 喂回执行态不得写回",
  );
  assert.deepEqual(harness.state.selection, SNAPSHOT_SELECTION);
});

test("F2: inputIntentMetadataFromQueueItem 不置 pin（queue 提升喂回不写回）", async () => {
  const queueItem = {
    sourceCommandId: "cmd-f2-original",
    queueItemId: "queue-f2",
    clientId: "ui",
    kind: "sendText",
    text: "f2 text",
    attachments: [],
    // queue item 里遗留的旧快照（继承语义，不是本轮显式选择）。
    modelSelection: EXPLICIT_SELECTION,
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 7, queuePosition: 0 },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: 1_700_000_000_000,
  };
  const intent = inputIntentMetadataFromQueueItem(queueItem, "f2 text");
  assert.ok(
    !("modelSelectionPinned" in intent),
    "queue 提升 intent 不得携带 modelSelectionPinned 键（QueueItem 不持久化 pin）",
  );
  assert.deepEqual(intent.modelSelection, EXPLICIT_SELECTION);

  // 喂回执行态：queue 提升按非显式处理，不得写回。
  const harness = createRuntimeHarness(SNAPSHOT_SELECTION);
  const model = await applySubmissionExecutionState(harness.runtime, intent, TRACE);
  assert.ok(model, "必须返回本次执行使用的 Model");
  const kinds = harness.calls.map((call) => call.kind);
  assert.deepEqual(
    kinds.filter((kind) => kind !== "modelFactory"),
    [],
    "queue 提升 intent 喂回执行态不得写回",
  );
  assert.deepEqual(harness.state.selection, SNAPSHOT_SELECTION);
});
