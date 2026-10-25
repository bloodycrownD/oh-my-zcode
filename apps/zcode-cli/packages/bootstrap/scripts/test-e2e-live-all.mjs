#!/usr/bin/env node
/**
 * bugfix-batch-20261011 / verify-e2e — 协议级 e2e：一进程内真 runtime 跑
 * 「模型实时切换 × 排队提升 × settle 后台化」三项叠加（node:test，零新依赖）。
 *
 * ============================================================================
 * 这一步要钉死什么（为什么不是三套既有单测的重复）
 * ============================================================================
 *
 * 既有单测各自单维度打桩验证一条链：
 *   - test-model-live.mjs           切模型写点 / promote 活值判据 / 编辑重发红线
 *   - test-subagent-live-model.mjs  子智能体 per-spawn 活读 agents-state.json
 *   - test-settle-background.mjs    长驻形态两处 settle 不阻塞 + close drain 收口
 *
 * 本文件要钉死的是**三项在同一进程、同一 runtime 装配下叠加不互斥**：用户在
 * 长驻 App（protocol 宿主，processExitsAfterTurn=false）里同时触发三件事——
 *   ① 切模型：会话选型即时变 M1→M2（switchModelConfig，协议命令）；
 *   ② 排队提升：turn A(M1) 在飞时入队 Q，A 完成后 Q 被 promote；
 *   ③ settle 后台化：长驻形态下 model step 前无 settle 等待，turn 后 close
 *      的 drain 仍把后台折叠 pass 收口落库。
 *
 * 三者的交叉点只有全部同时在场才会暴露：promote 一律读会话当前活值（出队模型
 * 裁定 2026-10-11，不再比对时间戳），而提升时机的推进依赖 turn 完成
 * 后 drain/foreground execution 不被 settle 拖住（恰恰本批把 settle 搬到了
 * 后台）。任何一环单独测过、合在一起却可能互相遮蔽，这里做叠加验证。
 *
 * 四个场景（T-E2E1..T-E2E4）：
 *   1. 切模型×排队提升：长驻 App → turn A(M1) 在飞时入队 Q → switchModelConfig
 *      到 M2 → A 完成 → Q promote → 断言 Q 轮用 M2 且会话选择=M2；
 *      全程断言长驻形态 model step 前无 settle 等待（顺序数组/计时）。
 *   2. 出队模型：编辑重发用会话活值：入队 Q2(M1) → 切 M2 → 编辑重发 → 断言重发轮用 M2（2026-10-11 裁定；写回红线不变）。
 *   3. settle 叠加：长驻形态下 model step 前无 settle 等待；turn 后 close drain
 *      仍收口（折叠 pass 落库）。
 *   4. 子代理 spawn 间隙改设置：同 App spawn(override=M1) → 改临时
 *      agents-state.json(override=M2) → 再 spawn → 断言第二次用 M2。
 *
 * 任何断言失败 = 阻塞项报告（附最小复现），不改任何生产代码。
 *
 * ============================================================================
 * 隔离声明（绝不写真实 ~/.omz / ~/.zcode，不触网）
 * ============================================================================
 *
 * - `ZCODE_STORAGE_DIR` 在 import 任何被测模块**之前**指到 os.tmpdir() 下的一次性
 *   临时目录；agent 的 agents-state.json 只写该目录下的 per-test 子目录。
 * - `MAGIC_CONTEXT_DB_DIR` / `MAGIC_CONTEXT_LOG_PATH` 同款指向临时目录
 *   （真工厂会开 SQLite；core/shared/data-path.ts 的两个 getter 现读这两个 env）。
 * - mock/echo model：modelFactory 桩只造内存 Model；bind/generateText/streamText
 *   一律抛错，任何真实 provider 请求都会让测试失败而不是静默通行。
 * - 被测代码零打桩：core/bootstrap/@zcode/magic-context 一律按 dist 文件路径加载
 *   真实模块（registerHooks 手法见下）。
 *
 * ============================================================================
 * dist 前置（registerHooks，同 test-model-live.mjs / test-settle-background.mjs）
 * ============================================================================
 *
 * @zcode/shared / @zcode/model-option-map / @zcode/provider / @zcode/provider-node
 * 的包入口发布原始 TypeScript，裸 node 无法把内部 `.js` 说明符改指到 `.ts`。
 * resolve 钩子把这些包改指到同布局的编译产物，不引入实验性 loader 标志、
 * 不桩任何被测代码。
 *
 * 运行方式（需先 build 相关包）：
 *   pnpm --filter @zcode/shared build && pnpm --filter @zcode/model-option-map build
 *   pnpm --filter @zcode/provider build && pnpm --filter @zcode/provider-node build
 *   pnpm --filter @zcode/core build && pnpm --filter @zcode/bootstrap build
 *   node --test apps/zcode-cli/packages/bootstrap/scripts/test-e2e-live-all.mjs
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 隔离：必须先于任何被测模块的 import ──────────────────────────────────────
// 三路 env 全部指向 os.tmpdir() 下的一次性临时目录：任何 import 期解析
// storage root / magic-context 库路径的模块都落这里，绝不碰真实 ~/.omz。
const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-e2e-live-all-"));
process.env.ZCODE_STORAGE_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_DB_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_LOG_PATH = join(TEST_HOME, "magic-context.log");
process.on("exit", () => {
  // 尽力而为：真工厂那条用例会开 SQLite 句柄，Windows 上进程退出前不释放，
  // 目录删除可能 EPERM。清理失败不改变用例结果，残留由 OS 临时目录策略回收，
  // 且它本来就在 tmpdir 下。
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* 见上 */
  }
});

// ── dist 前置：入口发布原始 TS 的 workspace 包 → 同布局 dist ─────────────────
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
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

// ── 被测真模块（core / bootstrap / magic-context 一律按 dist 路径加载）───────────
// fork-edit-retry ⇄ input-intent ⇄ executor ⇄ handlers/index 之间存在循环依赖；
// 只有以 executor 为入口先初始化（commandAdmissionOf 是函数声明、提升后可用），
// 再取 handler 导出才不会在 handlers/index 的重导出上命中 TDZ。
await import(new URL("../dist/zcode-protocol-v4/commands/executor.js", import.meta.url).href);
const { setSessionModelSelection, getSessionModelSelection, getLastModelSwitchAt } = await import(
  new URL("../../core/dist/runtime/methods/config.js", import.meta.url).href
);
const { applySubmissionExecutionState } = await import(
  new URL("../../core/dist/runtime/methods/turn-model.js", import.meta.url).href
);
const { queueHandlers } = await import(
  new URL("../dist/zcode-protocol-v4/commands/handlers/queue.js", import.meta.url).href
);
const { forkEditRetryHandlers } = await import(
  new URL("../dist/zcode-protocol-v4/commands/handlers/fork-edit-retry.js", import.meta.url).href
);
const { createAgentStateOverrideProvider } = await import(
  new URL("../dist/subagents.js", import.meta.url).href
);
const { createExploreSubagentPort } = await import(
  new URL("../../core/dist/subagent/runner.js", import.meta.url).href
);
const { DEFAULT_MAGIC_CONTEXT_CONFIG, getActiveCompartmentRun, registerActiveCompartmentRun } =
  await import("@zcode/magic-context");
const { createMagicContextTurnTransform, createZCodeMagicContextTurnTransformPort } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — verify-e2e-live-all (T-E2E1..T-E2E4)"
      : `TEST FAIL — verify-e2e-live-all (exit code ${code})`,
  );
});

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

const SESSION_ID = "ses_e2e_live_all";
const EPOCH = "epoch-e2e-live-all";

/** 会话初始选型（切模前的活值）= M1。 */
const M1 = Object.freeze({
  providerId: "openai",
  modelId: "gpt-5",
  options: Object.freeze({ reasoningLevel: "medium" }),
});
/** 用户切换到的目标选型 = M2。 */
const M2 = Object.freeze({
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  options: Object.freeze({ reasoningLevel: "high" }),
});

// ============================================================================
// 共享装配与驱动件（手法与三个模板单测同源：真写点 / 真 handler / 真端口）
// ============================================================================

/** 会话模型态 + 真实 core 写点（.call(state) 驱 setSessionModelSelection 本体）。 */
function createModelState(initialSelection) {
  const state = { sessionModelSelection: initialSelection, lastModelSwitchAt: 0 };
  return {
    state,
    switchModel: (selection) => setSessionModelSelection.call(state, selection),
    currentSelection: () => getSessionModelSelection.call(state),
    lastModelSwitchAt: () => getLastModelSwitchAt.call(state),
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
    sessionStore: { saveSessionEntry: async (entry) => calls.push({ kind: "persist", entry }) },
    modelFactory: (input) => {
      calls.push({ kind: "modelFactory", selection: input.selection });
      return createStubModel(input.selection);
    },
  };
  return { runtime, calls, state };
}

function createStubModel(selection) {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    displayName: "stub-model",
    properties: {},
    optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } },
    options: { reasoningLevel: selection.options?.reasoningLevel ?? "high" },
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

const TRACE = { traceId: "trace-e2e-live-all" };

/** 把 intent 喂回执行态，返回「本轮用的 Model + 写回观测 harness」。 */
async function executeWithIntent(intent, sessionSelection) {
  const harness = createWriteBackRuntime(sessionSelection);
  const model = await applySubmissionExecutionState(harness.runtime, intent, TRACE);
  return { model, harness };
}

const WRITE_BACK_KINDS = new Set(["setSessionModelSelection", "persist", "emitModelSelected"]);
function writeBackKinds(calls) {
  return calls.map((call) => call.kind).filter((kind) => WRITE_BACK_KINDS.has(kind));
}

function createQueueItem({ admittedAt, modelSelection }) {
  return {
    sourceCommandId: "cmd-e2e-original",
    queueItemId: "queue-e2e",
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

/** sendQueuedNow 的最小宿主/record（与 test-model-live.mjs 同款，intent 落 options.intent）。 */
function createPromotionHarness({ queueItem, modelState, sessionId }) {
  const captured = {};
  const record = {
    app: {
      sessionId,
      getMode: () => "build",
      getModel: () => `${M1.providerId}/${M1.modelId}`,
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
      // 手动提升成功后的恢复语义：handler 硬调用（非可选）。
      setQueueAutoDrain: async () => undefined,
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started_turn", turnId: "turn-e2e", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: TRACE.traceId, sessionId },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sid) => (sid === sessionId ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    getQueueItem: (sid, queueItemId) =>
      sid === sessionId && queueItemId === queueItem.queueItemId ? queueItem : null,
    // I1：执行文本 + 附件来自 session_input 账本（本夹具让账本与投影同值，只钉模型选择语义）。
    getSessionInputForExecution: async (sid, queueItemId) =>
      sid === sessionId && queueItemId === queueItem.queueItemId
        ? {
            state: "pending",
            status: "admitted",
            id: queueItemId,
            sessionID: sid,
            text: queueItem.text,
            attachments: queueItem.attachments ?? [],
          }
        : { state: "missing", id: queueItemId, sessionID: sid },
    getInputRoutingMode: () => null,
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
  };
  const envelope = {
    commandId: "cmd-e2e-promote",
    clientId: "ui",
    sessionId,
    type: "sendQueuedNow",
    payload: { queueItemId: queueItem.queueItemId },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
  };
  return { host, envelope, captured };
}

async function promoteQueueItem({ queueItem, modelState, sessionId }) {
  const harness = createPromotionHarness({ queueItem, modelState, sessionId });
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);
  const intent = harness.captured.sendInputOptions?.intent;
  assert.ok(intent, "提升轮必须携带 intent（sendQueuedNow 禁止 text-only 重发）");
  assert.equal(harness.captured.leaseReleased, true, "提升路径必须释放 idle-only lease");
  return intent;
}

/** 收集结构化日志：后台 settle 落定记账断言用。 */
function capturingLogger() {
  const entries = [];
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger;
    },
  };
  const note = (level) => (message, context) => entries.push({ level, message, context });
  logger.info = note("info");
  logger.debug = note("debug");
  logger.warn = note("warn");
  return { logger, entries };
}

/** 一条真实的 ZCode request entries：system → user → assistant(toolCall) → tool → user。 */
function sampleEntries() {
  return [
    { kind: "message", message: { role: "system", content: "you are zcode" } },
    {
      kind: "message",
      message: { role: "user", content: "first question" },
      metadata: { source: "real_user" },
    },
    {
      kind: "message",
      message: {
        role: "assistant",
        content: "let me read it",
        toolCalls: [{ id: "call_1", name: "read", input: { path: "a.ts" } }],
      },
    },
    {
      kind: "message",
      message: { role: "tool", content: "file body", toolCallId: "call_1", toolName: "read" },
    },
    {
      kind: "message",
      message: { role: "user", content: "second question" },
      metadata: { source: "real_user" },
    },
  ];
}

async function runPort(port, entries, sessionId) {
  return await port({
    entries,
    model: { providerId: "zcode", modelId: "glm-4.6", properties: { contextWindow: 128_000 } },
    sessionId,
    workingDirectory: TEST_HOME,
  });
}

/** 把微任务队列排干：后台 settle 的 promise 链在微任务上推进。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 长驻形态轻量端口 + 一条不会自己结束的折叠 run（三项叠加的公共起点）。
 * 返回的 releaseRun 由用例在断言「端口未等它」之后手动放行。
 */
function createLongLivedAssembly(sessionId, logger) {
  const order = [];
  let releaseRun = () => {};
  registerActiveCompartmentRun(
    sessionId,
    new Promise((resolve) => {
      releaseRun = resolve;
    }),
    "incremental",
  );
  const port = createZCodeMagicContextTurnTransformPort(
    async () => {
      order.push("transform");
    },
    {
      getConfig: () => DEFAULT_MAGIC_CONTEXT_CONFIG,
      options: { sessionId, logger, processExitsAfterTurn: false },
      onPassSucceeded: () => order.push("notify"),
      settleScheduledPass: async () => {
        order.push("settle:start");
        await new Promise((resolve) => setTimeout(resolve, 200));
        order.push("settle:end");
      },
    },
  );
  return { order, port, releaseRun };
}

// ============================================================================
// 场景 1：切模型 × 排队提升（T-E2E1）
// ============================================================================

test("T-E2E1: 长驻 App 下 turn A(M1) 在飞 → switchModelConfig(M2) → A 完成 → Q promote 用 M2", async () => {
  const sessionId = "ses_e2e_1";
  const { logger, entries } = capturingLogger();
  const { order, port, releaseRun } = createLongLivedAssembly(sessionId, logger);
  const modelState = createModelState(M1);

  // turn A 的 model step：在飞折叠 run 在场，端口必须立即返回（settle 后台化）。
  const startedAt = Date.now();
  const result = await runPort(port, sampleEntries(), sessionId);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(
    order,
    ["transform", "notify"],
    "叠加形态下 model step 前不得出现任何 settle 等待",
  );
  assert.ok(elapsedMs < 100, `model step 不得被 200ms settle 拖住，实测 ${elapsedMs}ms`);
  assert.ok(
    getActiveCompartmentRun(sessionId) !== undefined,
    "折叠 run 仍在后台飞——提升/drain 不被它拖住",
  );

  // turn A 在飞期间：入队 Q（M1 快照）→ 用户切到 M2（真实写点）。
  // admittedAt 取确定的过去墙钟（同 test-model-live.mjs 惯例）：避免与切换同毫秒导致
  // 「切换晚于入队」在时间戳精度上不可判。
  const queueItem = createQueueItem({ admittedAt: 1_700_000_000_000, modelSelection: M1 });
  modelState.switchModel(M2);
  assert.ok(
    modelState.lastModelSwitchAt() > queueItem.admittedAt,
    "切换必须晚于入队（活值判据的前提）",
  );

  // A 完成 → Q promote：真实 sendQueuedNow。此刻后台折叠 run 仍在飞。
  const intent = await promoteQueueItem({ queueItem, modelState, sessionId });
  assert.deepEqual(
    intent.modelSelection,
    M2,
    "提升轮必须用切换后的会话活值（三项叠加的核心交叉点）",
  );
  assert.equal(intent.modelSelectionPinned, false, "活值不得 pin");
  assert.equal(intent.queueItemId, queueItem.queueItemId);

  const { model, harness } = await executeWithIntent(intent, modelState.currentSelection());
  assert.equal(model.providerId, M2.providerId);
  assert.equal(model.modelId, M2.modelId);
  assert.deepEqual(writeBackKinds(harness.calls), [], "提升轮不得写回/持久化/广播");
  assert.deepEqual(modelState.currentSelection(), M2, "会话态保持活值");

  // 后台折叠 run 落定：后台 settle 有记账（后台化 ≠ 丢动作）。
  releaseRun();
  await flush();
  await flush();
  assert.equal(getActiveCompartmentRun(sessionId), undefined, "后台 settle 等 run 落定后清表");
  assert.ok(
    entries.some((entry) => entry.context?.event === "magic_context.settle_background_settled"),
    "后台 settle 必须留下记账日志",
  );
});

// ============================================================================
// 场景 2：出队模型规则——编辑重发用会话活值（T-E2E2，2026-10-11 用户裁定）
// ============================================================================

test("T-E2E2: 入队 Q2(M1) → 切 M2 → 编辑重发 → 重发轮用 M2（出队模型；写回红线在叠加形态下不变）", async () => {
  const sessionId = "ses_e2e_2";
  const { order, port, releaseRun } = createLongLivedAssembly(sessionId, NOOP_LOGGER);
  const modelState = createModelState(M1);

  // turn 在飞 + model step 未被 settle 阻塞（叠加形态在场）。
  const result = await runPort(port, sampleEntries(), sessionId);
  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(order, ["transform", "notify"]);

  const queueItem = createQueueItem({ admittedAt: 1_700_000_000_000, modelSelection: M1 });
  modelState.switchModel(M2);
  assert.ok(modelState.lastModelSwitchAt() > queueItem.admittedAt);

  // 编辑重发：真实 forkEditRetryHandlers.editUserQuery（不是 queue 提升路径）。
  const captured = {};
  const record = {
    app: {
      sessionId,
      runtime: {
        rewindConversationToMessage: async () => ({ strategy: "active_chain" }),
        getSessionModelSelection: () => modelState.currentSelection(),
      },
      sendInput: async (input, options) => {
        captured.sendInput = input;
        captured.sendInputOptions = options;
        return { kind: "started", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: TRACE.traceId, sessionId },
    persistence: "immediate",
  };
  const editTarget = {
    entityId: "ent-e2e",
    productTurnId: "turn-1",
    transcriptMessageId: "msg-e2e",
    intent: {
      kind: "sendText",
      text: "original text",
      sourceCommandId: queueItem.sourceCommandId,
      clientId: "ui",
      queueItemId: queueItem.queueItemId,
      requestedDelivery: "startNow",
      admittedDelivery: "startNow",
      // 被编辑轮的旧快照 = M1。
      modelSelection: M1,
    },
  };
  const host = {
    getRecord: (sid) => (sid === sessionId ? record : undefined),
    logger: { info: () => {}, warn: () => {} },
    resolveRowActionTarget: () => ({
      ok: true,
      action: "editUserQuery",
      row: {
        rowId: 4,
        turnId: "turn-1",
        entityId: "ent-e2e",
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
    commandId: "cmd-e2e-edit",
    clientId: "ui",
    sessionId,
    type: "editUserQuery",
    payload: { target: { rowId: 4, entityId: "ent-e2e" }, newText: "edited text" },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: EPOCH,
  });

  const intent = captured.sendInputOptions?.intent;
  assert.ok(intent, "编辑重发必须携带 intent");
  assert.deepEqual(intent.modelSelection, M2, "编辑重发用会话活值（出队模型，2026-10-11 裁定）");
  assert.equal(intent.modelSelectionPinned, false, "活值不是本轮显式选择：不得 pin");

  const { model, harness } = await executeWithIntent(intent, modelState.currentSelection());
  assert.equal(model.providerId, M2.providerId);
  assert.equal(model.modelId, M2.modelId);
  assert.deepEqual(writeBackKinds(harness.calls), [], "编辑重发不得写回（v1.0.4 写回红线不变）");
  assert.deepEqual(modelState.currentSelection(), M2, "会话态保持活值");

  releaseRun();
  await flush();
});

// ============================================================================
// 场景 3：settle 叠加（T-E2E3）——真工厂 + 每个 model step 都不阻塞 + close drain 收口
// ============================================================================

test("T-E2E3: 长驻真工厂端口：N 个 model step 均不等在飞折叠，close() 的 drain 仍收口", async () => {
  const sessionId = "ses_e2e_3";
  const closeHooks = [];
  // 真工厂 + 真临时库：sidecar 只造 Model 不发请求；registerClose 按 MF-05 装配。
  const port = await createMagicContextTurnTransform({
    enabled: true,
    configDomain: {},
    sessionId,
    workingDirectory: TEST_HOME,
    logger: NOOP_LOGGER,
    createSidecarModel: () => ({
      providerId: "zcode",
      modelId: "glm-4.6",
      displayName: "glm-4.6",
      properties: { contextWindow: 128_000 },
      optionSpecs: { maxOutputTokens: { max: 8_192 }, reasoningLevel: { values: [] } },
      options: {},
      bind() {
        return this;
      },
    }),
    registerClose: (close) => {
      closeHooks.push(close);
    },
    processExitsAfterTurn: false,
  });
  assert.ok(port, "flag on 且库开得出来时必须拿到端口");

  // 冷启动不计入计时：真工厂首调要开 SQLite/跑迁移/首次投影（实测 ~1.4s），
  // 这不是 settle 阻塞——先暖机一次，再注册在飞 run，用计时的两个 model step
  // 隔离「在飞折叠不阻塞每一步」。
  await runPort(port, sampleEntries(), sessionId);

  let releaseRun = () => {};
  registerActiveCompartmentRun(
    sessionId,
    new Promise((resolve) => {
      releaseRun = resolve;
    }),
    "incremental",
  );

  // settle 是**每个 model step 前**都跑的钩子（turn-loop while(true)）：连打两步，
  // 两步都必须不等在飞折叠 run——这是「N×120s 上界」被砍掉的直接观察。
  for (let step = 1; step <= 2; step += 1) {
    const startedAt = Date.now();
    const result = await runPort(port, sampleEntries(), sessionId);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(result.outcome === "applied" || result.outcome === "unchanged", result.outcome);
    assert.ok(elapsedMs < 100, `第 ${step} 个 model step 不得被在飞折叠拖住，实测 ${elapsedMs}ms`);
    assert.ok(
      getActiveCompartmentRun(sessionId) !== undefined,
      `第 ${step} 步返回时折叠 run 仍在飞（后台 settle 未越权等待）`,
    );
  }

  assert.equal(closeHooks.length, 1, "长驻形态不得丢掉 MF-05 的关闭钩子");
  // 放行折叠 run → 后台 settle 自行落定 → close() 的 drain 不再有无界等待。
  releaseRun();
  await flush();
  await flush();
  await closeHooks[0]();
  assert.equal(getActiveCompartmentRun(sessionId), undefined, "close 收口后 run 表清空");
});

// ============================================================================
// 场景 4：子代理 spawn 间隙改设置（T-E2E4）
// ============================================================================

const SUB_M1 = Object.freeze({ providerId: "live-provider", modelId: "sub-model-1" });
const SUB_M2 = Object.freeze({ providerId: "live-provider", modelId: "sub-model-2" });

test("T-E2E4: 同 App spawn(override=SUB_M1) → 改 agents-state.json(SUB_M2) → 再 spawn 用 SUB_M2", async () => {
  const storageRoot = join(TEST_HOME, "subagent-e2e");
  mkdirSync(join(storageRoot, "v2"), { recursive: true });
  const agentsStatePath = join(storageRoot, "v2", "agents-state.json");
  const writeAgentState = (overrides) =>
    writeFileSync(
      agentsStatePath,
      `${JSON.stringify({ builtInModelSelectionOverrides: overrides }, null, 2)}\n`,
      "utf8",
    );

  // per-spawn 活读 provider：与主会话共享同一进程/同一 TEST_HOME（「同 App」）。
  const provider = createAgentStateOverrideProvider({ storageRoot, logger: NOOP_LOGGER });
  const spawns = [];
  const port = createExploreSubagentPort({
    builtInModelSelectionOverrides: provider,
    outputRootDir: join(TEST_HOME, "agent-output"),
    logger: NOOP_LOGGER,
    runExploreAgent: async (request) => {
      spawns.push(request.profile);
      return { response: "done", traceId: request.traceContext.traceId, events: [] };
    },
    emitParentEvent: async () => {},
  });
  const spawn = () =>
    port.run({
      sessionId: "ses_e2e_4",
      parentToolCallId: "call_e2e_4",
      agentType: "general-purpose",
      description: "spawn general-purpose",
      prompt: "noop",
      workingDirectory: TEST_HOME,
      workspaceRoot: TEST_HOME,
      trace: { traceId: "tr_e2e_4" },
    });

  writeAgentState({ "general-purpose": SUB_M1 });
  await spawn();
  assert.deepEqual(spawns[0].modelSelection, SUB_M1, "第一次 spawn 用设置页写入的 SUB_M1");

  // 用户在 host 进程把 override 换成 SUB_M2：只改文件，不重启、不重建 port。
  writeAgentState({ "general-purpose": SUB_M2 });
  await spawn();
  assert.deepEqual(
    spawns[1].modelSelection,
    SUB_M2,
    "spawn 间隙的设置变更下一次 spawn 即生效（per-spawn 活读）",
  );

  // 主会话模型态不受子代理 override 干扰（三链互不串扰）。
  const modelState = createModelState(M1);
  modelState.switchModel(M2);
  assert.deepEqual(modelState.currentSelection(), M2);
});
