#!/usr/bin/env node
/**
 * Step 4/5 — 主会话切模型实时生效（bugfix-batch-20261011，T-ML1..T-ML4 + auto-drain 同路径）。
 *
 * ============================================================================
 * 这一步要钉死什么
 * ============================================================================
 *
 * 缺陷②的报障形态：会话里切模型后，assistant 下一轮（含排队消息提升）仍用旧模型。
 * 两刀修复各自的失效方向都必须有自动化断言：
 *
 *   Step 4（UI 即时下发，packages/ui SessionPane.handleSelectModel）：
 *     选模型即对已有 session 下发 switchModelConfig → app.setModel →
 *     runtime.setSessionModelSelection。失效方向是「下发缺失/时序错位」，本文件在
 *     CLI 侧钉死它依赖的那段事实：**会话态在选择时即更新**。
 *
 *   Step 5（promote 活值规则，handlers/queue.ts applyPromotedModelSelection）：
 *     runtime.lastModelSwitchAt > item.admittedAt → 提升轮改用会话活值。
 *     - T-ML1  切换后下一个新提交轮用新模型（admission 冻结活值 + 变值时间戳只记一次）。
 *     - T-ML2a 入队后切换 → 提升轮用活值，且不 pin、不写回会话态。
 *     - T-ML2b 入队后未切换（含「切换发生在入队之前」）→ 提升轮用 item 旧快照。
 *     - T-ML2c auto-drain（v4-bridge 经同一 sendQueuedNow 路径）同规则。
 *     - T-ML2d item 缺 `admittedAt`（异常/跨版本投影）+ 已切换 → 提升仍用活值
 *              （`?? 0` 防御语义直证：缺字段不是保留旧快照的理由）。
 *     - T-ML3  编辑重发仍用被编辑轮快照且不写回会话态——即使切换发生在编辑之后
 *              （v1.0.4 回归红线：时间戳判据不得被编辑重发路径消费）。
 *     - T-ML4  execution-scope 轮豁免：仍按 intent 选择执行，但绝不写回会话态。
 *
 * ============================================================================
 * 隔离（不写真实 ~/.omz / ~/.zcode，不触网）
 * ============================================================================
 *
 * - 假 provider：modelFactory 桩只造内存 Model，bind/generateText/streamText 一律抛错，
 *   任何真实 provider 请求都会让测试失败而不是静默通行。
 * - 假 runtime/假 host：只实现本测试触达的窄面；sessionStore.saveSessionEntry 捕获进内存，
 *   不落任何磁盘文件。
 * - 被测代码零打桩：core/bootstrap 一律按 dist 文件路径加载真实模块（见下）。
 *
 * ============================================================================
 * dist 前置（registerHooks，同 test-magic-context-turn-transform.mjs 手法）
 * ============================================================================
 *
 * @zcode/shared / @zcode/model-option-map / @zcode/provider / @zcode/provider-node 的包入口
 * 发布的是原始 TypeScript（`exports["."] = "./src/index.ts"`），裸 node 无法把内部 `.js`
 * 说明符改指到 `.ts`。resolve 钩子把这些包改指到同布局的编译产物，不引入实验性 loader
 * 标志、不桩任何被测代码。
 *
 * 运行方式（需先 build core/bootstrap）：
 *   pnpm --filter @zcode/core build && pnpm --filter @zcode/bootstrap build
 *   node --test apps/zcode-cli/packages/bootstrap/scripts/test-model-live.mjs
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
// 入口发布原始 TS 的 workspace 包 → 同布局 dist（bootstrap dist 的加载闭包需要 provider 两只）。
const TS_SOURCE_PACKAGES = new Set([
  "@zcode/shared",
  "@zcode/model-option-map",
  "@zcode/provider",
  "@zcode/provider-node",
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

// core 真实写点/读点（Step 5a 的落点：runtime/methods/config.ts）。
const { setSessionModelSelection, getSessionModelSelection, getLastModelSwitchAt } = await import(
  new URL("../../core/dist/runtime/methods/config.js", import.meta.url).href
);
// core 写回门（Step 5 的红线段：turn-model.ts 的 pin/execution-scope 门）。
const { applySubmissionExecutionState } = await import(
  new URL("../../core/dist/runtime/methods/turn-model.js", import.meta.url).href
);
// fork-edit-retry ⇄ input-intent ⇄ executor ⇄ handlers/index 之间存在循环依赖；
// 只有以 executor 为入口先初始化（commandAdmissionOf 是函数声明、提升后可用），
// 再取 handler 导出才不会在 handlers/index 的重导出上命中 TDZ。
// （与同目录 test-edit-retry-model.mjs 同一约束，dist 侧同样成立。）
await import(new URL("../dist/zcode-protocol-v4/commands/executor.js", import.meta.url).href);
const { queueHandlers } = await import(
  new URL("../dist/zcode-protocol-v4/commands/handlers/queue.js", import.meta.url).href
);
const { forkEditRetryHandlers } = await import(
  new URL("../dist/zcode-protocol-v4/commands/handlers/fork-edit-retry.js", import.meta.url).href
);
const { sessionFlowHandlers } = await import(
  new URL("../dist/zcode-protocol-v4/commands/handlers/session-flow.js", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 4/5 model-live (T-ML1..T-ML4)"
      : `TEST FAIL — Step 4/5 model-live (exit code ${code})`,
  );
});

const SESSION_ID = "ses_tml";
const EPOCH = "epoch-tml";

/** 会话初始选型（切模前的活值）。 */
const SELECTION_A = Object.freeze({
  providerId: "openai",
  modelId: "gpt-5",
  options: Object.freeze({ reasoningLevel: "medium" }),
});
/** 用户切换到的目标选型。 */
const SELECTION_B = Object.freeze({
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  options: Object.freeze({ reasoningLevel: "high" }),
});
/** 「入队时携带、与会话活值不同」的显式快照（T-ML2b 的旧快照语义用）。 */
const SELECTION_C = Object.freeze({
  providerId: "google",
  modelId: "gemini-3-pro",
  options: Object.freeze({ reasoningLevel: "low" }),
});

// ── 共享假件 ────────────────────────────────────────────────────────────────

/**
 * 会话模型态 + 真实 core 写点。
 *
 * `switchModel` 就是发布链路的写入口（bootstrap app.setModel → runtime.setSessionModelSelection），
 * 因此「同值不记时间戳 / 变值才记 / 清除不记」这些 Step 5a 语义由真实代码决定，测试只观测。
 */
function createModelState(initialSelection) {
  const state = { sessionModelSelection: initialSelection, lastModelSwitchAt: 0 };
  return {
    state,
    switchModel: (selection) => setSessionModelSelection.call(state, selection),
    currentSelection: () => getSessionModelSelection.call(state),
    lastModelSwitchAt: () => getLastModelSwitchAt.call(state),
  };
}

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

/** applySubmissionExecutionState 的 runtime 面（观测写回三连）。 */
function createWriteBackRuntime(sessionSelection) {
  const calls = [];
  const state = { sessionModelSelection: sessionSelection, lastModelSwitchAt: 0 };
  const runtime = {
    config: { taskType: "default" },
    sessionId: SESSION_ID,
    getSessionModelSelection: () => getSessionModelSelection.call(state),
    setSessionModelSelection: (selection) => {
      calls.push({ kind: "setSessionModelSelection", selection });
      setSessionModelSelection.call(state, selection);
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

const TRACE = { traceId: "trace-tml" };

/** 把 intent 喂回执行态，返回「本轮用的 Model + 是否发生写回三连」。 */
async function executeWithIntent(intent, sessionSelection) {
  const harness = createWriteBackRuntime(sessionSelection);
  const model = await applySubmissionExecutionState(harness.runtime, intent, TRACE);
  return { model, harness };
}

/** 写回三连（turn-model.ts 的 pin 门后动作）；modelFactory 只是建 Model，不算写回。 */
const WRITE_BACK_KINDS = new Set(["setSessionModelSelection", "persist", "emitModelSelected"]);
function writeBackKinds(calls) {
  return calls.map((call) => call.kind).filter((kind) => WRITE_BACK_KINDS.has(kind));
}

// ── T-ML1：切换后下一个新提交轮用新模型 ───────────────────────────────────────

test("T-ML1a: setSessionModelSelection 只在选型变值时记 lastModelSwitchAt", () => {
  const modelState = createModelState(SELECTION_A);
  assert.equal(modelState.lastModelSwitchAt(), 0, "初始无切换");

  modelState.switchModel({ ...SELECTION_A });
  assert.equal(modelState.lastModelSwitchAt(), 0, "同值重写不得记时间戳（desktop 每次提交都写回）");

  modelState.switchModel(SELECTION_B);
  const switchedAt = modelState.lastModelSwitchAt();
  assert.ok(switchedAt > 0, "变值必须记墙钟");
  assert.deepEqual(modelState.currentSelection(), SELECTION_B, "会话活值必须更新");

  modelState.switchModel({ ...SELECTION_B });
  assert.equal(modelState.lastModelSwitchAt(), switchedAt, "同值重写不得刷新时间戳");

  modelState.switchModel(undefined);
  assert.equal(modelState.lastModelSwitchAt(), switchedAt, "清除失效不得记成切换");
  assert.equal(modelState.currentSelection(), undefined, "清除后无活值");
});

test("T-ML1b: 切换后下一个新提交轮用新模型（admission 冻结活值 → 执行 → 写回不刷时间戳）", async () => {
  const modelState = createModelState(SELECTION_A);
  modelState.switchModel(SELECTION_B);
  const switchedAt = modelState.lastModelSwitchAt();

  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      getMode: () => "build",
      getModel: () => "openai/gpt-5",
      runtime: {
        getSessionModelSelection: () => modelState.currentSelection(),
        getPlanEnabled: () => false,
        getActiveTurnInfo: () => undefined,
      },
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started_turn", turnId: "turn-tml1", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-tml", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    getInputRoutingMode: () => null,
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
  };

  await sessionFlowHandlers.sendText(host, {
    commandId: "cmd-tml1",
    clientId: "ui",
    sessionId: SESSION_ID,
    type: "sendText",
    // 桌面 composer 每条提交都带 modelSelection（composerSubmissionConfig 恒带）。
    payload: { text: "next turn after switch", modelSelection: modelState.currentSelection() },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
  });

  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "sendText 必须携带 intent");
  // 新提交冻结的必须是切换后的活值，而不是任何更早的快照。
  assert.deepEqual(intent.modelSelection, SELECTION_B);
  assert.equal(intent.modelSelectionPinned, true);

  const { model } = await executeWithIntent(intent, modelState.currentSelection());
  assert.equal(model.providerId, SELECTION_B.providerId);
  assert.equal(model.modelId, SELECTION_B.modelId);
  // 提交侧写回（pin 路径）与会话活值同值 → 不刷新切换时间戳，
  // 「入队后未切模」的时间戳边界因此不会被提交动作本身侵蚀。
  assert.equal(modelState.lastModelSwitchAt(), switchedAt);
});

// ── sendQueuedNow 提升 harness ───────────────────────────────────────────────

function createQueueItem({ admittedAt, modelSelection }) {
  return {
    sourceCommandId: "cmd-tml-original",
    queueItemId: "queue-tml",
    clientId: "ui",
    kind: "sendText",
    text: "queued text",
    attachments: [],
    ...(modelSelection ? { modelSelection } : {}),
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 7, queuePosition: 0 },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt,
  };
}

/** sendQueuedNow 的最小宿主/record；intent 落在 app.sendInput 的 options.intent。 */
function createPromotionHarness({ queueItem, modelState, autoDrainPromotion = false }) {
  const captured = {};
  const record = {
    app: {
      sessionId: SESSION_ID,
      getMode: () => "build",
      getModel: () => "openai/gpt-5",
      readTarget: async () => null,
      runtime: {
        getSessionModelSelection: () => modelState.currentSelection(),
        getLastModelSwitchAt: () => modelState.lastModelSwitchAt(),
        getPlanEnabled: () => false,
        getActiveTurnInfo: () => undefined,
        getActiveForegroundExecutionId: () => undefined,
        acquireForegroundPromotionLease: ({ leaseId }) => {
          captured.leaseId = leaseId;
          return { kind: "acquired" };
        },
        releaseForegroundPromotionLease: () => {
          captured.leaseReleased = true;
        },
      },
      reserveQueueItem: async () => true,
      markQueueItemPromoting: async () => true,
      removeQueueItem: async () => true,
      releaseQueueItemReservation: async () => true,
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started_turn", turnId: "turn-tml2", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-tml", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    getQueueItem: (sessionId, queueItemId) =>
      sessionId === SESSION_ID && queueItemId === queueItem.queueItemId ? queueItem : null,
    getInputRoutingMode: () => null,
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
  };
  const envelope = {
    commandId: "cmd-tml-promote",
    clientId: "ui",
    sessionId: SESSION_ID,
    type: "sendQueuedNow",
    payload: { queueItemId: queueItem.queueItemId },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
    // v4-bridge autoDrainV4QueueIfReady 走的内部执行上下文（idle-only 抢占路径）。
    ...(autoDrainPromotion ? { __v4ExecutionContext: { autoDrainPromotion: true } } : {}),
  };
  return { host, envelope, captured };
}

/** 驱动 sendQueuedNow 并回收提升轮的 intent。 */
async function promoteQueueItem({ queueItem, modelState, autoDrainPromotion = false }) {
  const harness = createPromotionHarness({ queueItem, modelState, autoDrainPromotion });
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);
  const intent = harness.captured.sendInputOptions?.intent;
  assert.ok(intent, "提升轮必须携带 intent（sendQueuedNow 禁止 text-only 重发）");
  return intent;
}

test("T-ML2a: 入队后切换 → 提升轮用活值且不 pin、不写回会话态", async () => {
  const modelState = createModelState(SELECTION_A);
  // 入队时刻取一个确定早于「现在」的墙钟：切换一定发生在入队之后。
  const queueItem = createQueueItem({ admittedAt: 1_700_000_000_000, modelSelection: SELECTION_A });
  modelState.switchModel(SELECTION_B);

  const intent = await promoteQueueItem({ queueItem, modelState });
  assert.deepEqual(intent.modelSelection, SELECTION_B, "提升轮必须用切换后的会话活值");
  assert.equal(intent.modelSelectionPinned, false, "活值不是本轮显式选择：不得 pin");
  // 其余提升语义保持原状（来源/队列关联不被时间戳判据波及）。
  assert.equal(intent.sourceCommandId, queueItem.sourceCommandId);
  assert.equal(intent.queueItemId, queueItem.queueItemId);

  const { model, harness } = await executeWithIntent(intent, modelState.currentSelection());
  assert.equal(model.providerId, SELECTION_B.providerId);
  assert.equal(model.modelId, SELECTION_B.modelId);
  assert.deepEqual(
    writeBackKinds(harness.calls),
    [],
    "提升轮不得写回/持久化/广播（会话态已由 switchModelConfig 写成新值）",
  );
  assert.deepEqual(harness.state.sessionModelSelection, SELECTION_B, "会话态保持活值");
});

test("T-ML2b: 入队后未切换 → 提升轮用 item 旧快照", async () => {
  // 从未切换：时间戳 0，任何 admittedAt 都不满足「切换晚于入队」。
  const neverSwitched = createModelState(SELECTION_A);
  const intentNoSwitch = await promoteQueueItem({
    queueItem: createQueueItem({ admittedAt: 1_700_000_000_000, modelSelection: SELECTION_C }),
    modelState: neverSwitched,
  });
  assert.deepEqual(intentNoSwitch.modelSelection, SELECTION_C, "未切换必须保留 item 快照");

  // 切换发生在入队之前：快照与会话活值不同也不能被时间戳判据翻掉。
  const switchedBeforeEnqueue = createModelState(SELECTION_A);
  switchedBeforeEnqueue.switchModel(SELECTION_B);
  const intentBeforeEnqueue = await promoteQueueItem({
    // admittedAt 取「切换之后」的墙钟（确定的未来值）。
    queueItem: createQueueItem({
      admittedAt: Number.MAX_SAFE_INTEGER,
      modelSelection: SELECTION_C,
    }),
    modelState: switchedBeforeEnqueue,
  });
  assert.deepEqual(
    intentBeforeEnqueue.modelSelection,
    SELECTION_C,
    "入队之后的切换才算「切过」；旧的 item 快照不被回溯改写",
  );
});

test("T-ML2c: auto-drain 提升（内部 sendQueuedNow）与手动提升同规则", async () => {
  const modelState = createModelState(SELECTION_A);
  const queueItem = createQueueItem({ admittedAt: 1_700_000_000_000, modelSelection: SELECTION_A });
  modelState.switchModel(SELECTION_B);
  const intent = await promoteQueueItem({ queueItem, modelState, autoDrainPromotion: true });
  assert.deepEqual(intent.modelSelection, SELECTION_B, "auto-drain 必须走同一条活值规则");

  const { model, harness } = await executeWithIntent(intent, modelState.currentSelection());
  assert.equal(model.providerId, SELECTION_B.providerId);
  assert.deepEqual(writeBackKinds(harness.calls), [], "auto-drain 提升同样不得写回");
});

test("T-ML2d: item 缺 admittedAt（异常/跨版本投影）+ 已切换 → 提升仍用活值", async () => {
  // `?? 0` 防御语义直证（CR MF-ML-3）：缺 admittedAt 不是真实路径——
  // queueItemSchema extends conversationInputIntentSchema，admittedAt 必填，
  // 且 queue 不持久化（snapshot.ts:257）；但一旦观测到缺字段的投影，
  // `?? 0` 视为最老，任何真实切换（晚于 0）都必须胜出。
  const modelState = createModelState(SELECTION_A);
  modelState.switchModel(SELECTION_B);
  const intent = await promoteQueueItem({
    queueItem: createQueueItem({ admittedAt: undefined, modelSelection: SELECTION_A }),
    modelState,
  });
  assert.deepEqual(intent.modelSelection, SELECTION_B, "缺 admittedAt 不构成保留旧快照的理由");
  assert.equal(intent.modelSelectionPinned, false, "活值仍不得 pin");
});

// ── T-ML3：编辑重发回归（时间戳判据不得被编辑路径消费）───────────────────────

test("T-ML3: 编辑重发仍用被编辑轮快照且不写回会话态（切换发生在编辑之后）", async () => {
  const modelState = createModelState(SELECTION_A);
  modelState.switchModel(SELECTION_B);
  // 前置：编辑动作发生在切换之后——旧实现（无条件写回）会把 B 还原成 A。
  assert.ok(modelState.lastModelSwitchAt() > 0);

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
    traceContext: { traceId: "trace-tml", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  const editTarget = {
    entityId: "ent-tml",
    productTurnId: "turn-1",
    transcriptMessageId: "msg-tml",
    intent: {
      kind: "sendText",
      text: "original text",
      sourceCommandId: "cmd-original",
      clientId: "ui",
      queueItemId: "queue-original",
      requestedDelivery: "startNow",
      admittedDelivery: "startNow",
      // 被编辑轮的旧快照。
      modelSelection: SELECTION_A,
    },
  };
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    resolveRowActionTarget: () => ({
      ok: true,
      action: "editUserQuery",
      row: {
        rowId: 4,
        turnId: "turn-1",
        entityId: "ent-tml",
        productTurnId: "turn-1",
        visibility: "visible",
        kind: "userInput",
      },
      editTarget,
      messageId: editTarget.transcriptMessageId,
    }),
    afterLegacyStateMutation: async () => undefined,
  };

  await forkEditRetryHandlers.editUserQuery(host, {
    commandId: "cmd-tml-edit",
    clientId: "ui",
    sessionId: SESSION_ID,
    type: "editUserQuery",
    payload: { target: { rowId: 4, entityId: "ent-tml" }, newText: "edited text" },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
  });

  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "编辑重发必须携带 intent");
  // 时间戳判据只在 queue 提升路径生效：编辑重发仍按被编辑轮的旧快照执行。
  assert.deepEqual(intent.modelSelection, SELECTION_A, "编辑重发必须沿用被编辑轮快照");
  assert.equal(intent.modelSelectionPinned, false, "继承快照不得 pin");

  const { model, harness } = await executeWithIntent(intent, modelState.currentSelection());
  assert.equal(model.providerId, SELECTION_A.providerId);
  assert.equal(model.modelId, SELECTION_A.modelId);
  assert.deepEqual(
    writeBackKinds(harness.calls),
    [],
    "编辑重发不得写回/持久化/广播（v1.0.4 回归红线）",
  );
  // 会话态仍是我刚切换到的活值，没有被旧快照还原。
  assert.deepEqual(modelState.currentSelection(), SELECTION_B);
});

// ── T-ML4：execution-scope 豁免 ──────────────────────────────────────────────

test("T-ML4: execution-scope 轮按 intent 选择执行但绝不写回会话态", async () => {
  const harness = createWriteBackRuntime(SELECTION_A);
  const model = await applySubmissionExecutionState(
    harness.runtime,
    {
      kind: "sendText",
      text: "execution scoped text",
      sourceCommandId: "cmd-tml4",
      clientId: "ui",
      queueItemId: "queue-tml4",
      // 即使显式 pin（一次性执行约束的显式选择）：
      modelSelection: SELECTION_B,
      modelSelectionPinned: true,
      requestedDelivery: "startNow",
      admittedDelivery: "startNow",
    },
    TRACE,
    { selectionScope: "execution" },
  );
  assert.ok(model, "execution-scoped 轮仍要使用 intent 的选型执行");
  assert.equal(model.providerId, SELECTION_B.providerId);
  assert.equal(model.modelId, SELECTION_B.modelId);
  assert.deepEqual(
    writeBackKinds(harness.calls),
    [],
    "execution-scope 轮不得写回/持久化/广播（豁免必须保留）",
  );
  assert.deepEqual(harness.state.sessionModelSelection, SELECTION_A, "会话态不被执行约束改写");
});
