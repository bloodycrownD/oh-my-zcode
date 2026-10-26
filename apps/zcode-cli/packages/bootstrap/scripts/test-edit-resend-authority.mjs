#!/usr/bin/env node
/**
 * 五条不变式的回归网（spec `docs/iterations/bugfix-batch-20261025/bugs/edit-resend-stale-text`）。
 *
 * Step 13 收口后本文件对 **I1..I5 各至少一例**：I1 执行权威取账本（正向 + 终态反向）、
 * I2 判据集合/不自伤/幽灵项、I3 单一解析入口（admission ↔ 执行逐字一致）、I4 事务
 * （apply/commit 分离 + abort 不写回 + draftText）、I5 投递态三值。Step 14 把它连同其余
 * 三个脚本挂进根 `test:v4-perf`——它是防止第五次回归的唯一门禁，不要拆成多个脚本。
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
 * T-IA1 执行权威取账本（I1 / Step 3 收口，Step 13 补例）：提升轮的 content、落库
 *      `intent.text` 与附件都取 `session_input`，投影项文本/附件被改成旧值也不得被执行；
 *      账本终态 → 硬失败、不起轮（反向不得发生）。
 * T-IA3 单一解析入口（I3 / Step 2 收口，Step 13 补例）：同一条 edit 命令，admission 侧
 *      `resolveCanonicalInput` 的产出与执行侧真正交给 `sendInput` 的 text/附件逐字一致。
 * T-RW0 源码形状：级联必须挂在 setRevert 之后 / RewindTriggered 之前；不得读
 *      `activeTurn.pendingInputs`；edit/retry 必须把自持 id 传给 rewind。
 * T-RW1 判据三条：`admitted` ∧ 排除自持 id ∧ (targetTurnId ∈ removedTurnIds ∨ 'deferred')；
 *      幸存轮的排队项一条都不许动。
 * T-RW2 不终止直接编辑重发（本 bug 的核心断言）：用户没点停止、队列也没被暂停，
 *      rewind 返回时 `autoDrain` 仍是 true —— `afterLegacyStateMutation` →
 *      `autoDrainV4QueueIfReady` 会把**属于被截断那一轮**的旧队首提升起轮（早于
 *      `startCanonicalIntent`），新文本的 admission 随即撞上活跃轮被退回 queue。
 *      断言：钩子一项都不得提升 + 新文本路由为 startNow（改前：提升 OLD_TEXT）。
 *      **不要用 stop 路径复证本用例**：那条路的旧项是 held 的，改前就不会起跑（假绿）。
 * T-RW3 投影收口 + autoDrain 双侧复位：`TurnSteerDiscarded` 对任意 reason 都移除队列项
 *      （既有行为，禁止加 reason 过滤——promoted 依赖同一语义）；作废后**投影队列为空**时
 *      runtime 门（queueAutoDrain）与 v4 投影（queue.autoDrain）必须同时复位，只复位一侧
 *      即失败；队列非空（幸存 held 项）时必须两边都保持 held；已作废项在用户点「继续」
 *      后同样不得被提升（恢复门只放行存活项）。
 * T-RW4 stop 结算（Step 6）：只结算「队列承载不了」的孤儿 pending 输入；改投 queue 的 guide
 *      与 held 队列项的账本必须保持 admitted（零 settle）——stop 是「停这一轮」，不是
 *      「清空排队内容」。判据顺序（fallback → 结算 → held 判据）另有源码形状守卫。
 * T-RW5 不自伤：排除自持 id 后，**没有任何 settle 调用**指向它、账本仍为 admitted（不能只
 *      断言终态 promoted：误 settle 后 promote 会因 status='admitted' 前置而硬失败，两种
 *      事故的终态都是「没有 promoted」），且它随后仍能正常提升起轮。
 * T-DA1 投递态上抛（Step 10）：ACK 必带 `delivery` 三值；`startNow` / `queue` / `guide`
 *      逐个断言，queueItemId 与 admission 权威 id 同源；契约三值 + 可选字段可解码。
 * T-DA2 旧结果兼容 + UI 分流（Step 11）：缺省 `delivery` 读成「无投递事实」（不反推
 *      startNow 也不反推 queue）；UI 只在 queue 时提示排队、且 queued 不收敛编辑态。
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
/** UI 的 v4 目录：I5 的「UI 不得在 queued 时表现为成功」只有源码形状 + 纯函数两层可断言。 */
const uiV4Src = join(here, "..", "..", "..", "..", "..", "packages", "ui", "src", "v4");

const contractsEvents = await import(
  pathToFileURL(join(contractsSrc, "events", "session.events.ts")).href
);
// 暂停位的唯一派生规则（cr-func P2）。纯函数，直接取 contracts 源码断言真值表，
// 不需要经过 queue handler 才能证明判据正确。
const { deriveQueueAutoDrain } = await import(
  pathToFileURL(join(contractsSrc, "interfaces", "session.port.ts")).href
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
const {
  completeExternalQueueDrain,
  createPendingInputId,
  discardPendingInput,
  discardRewoundPendingSteerInputs,
  enqueueDeferredInput,
  fallbackPendingGuidesToQueue,
  setQueueAutoDrain,
  steerTurn,
} = await import(pathToFileURL(join(coreSrc, "runtime", "methods", "steering.ts")).href);
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
const { V4EditCommittedFailureError, forkEditRetryHandlers } = await import(
  pathToFileURL(
    join(bootstrapSrc, "zcode-protocol-v4", "commands", "handlers", "fork-edit-retry.ts"),
  ).href
);
// P2-3：stop 的「拦下后续项」判定必须与 deriveQueueAutoDrain 同口径（读不到 ≠ 空）。
const { sessionFlowHandlers } = await import(
  pathToFileURL(join(bootstrapSrc, "zcode-protocol-v4", "commands", "handlers", "session-flow.ts"))
    .href
);
// I3 的唯一解析入口：admission 侧（无选择事实）与执行侧（带事实）必须产出同一份结果。
const { resolveCanonicalInput } = await import(
  pathToFileURL(join(bootstrapSrc, "zcode-protocol-v4", "commands", "input-intent.ts")).href
);
const { applyWorkspaceFileRewind } = await import(
  pathToFileURL(join(coreSrc, "runtime", "methods", "file-rewind.ts")).href
);
// I4 事务边界的真实原语（P1-2）：只有真 `rewindConversationToMessage` 能证明
// 「setRevert 之后失败」会抛带 committed:true 的类型化错误。
const { rewindConversationToMessage } = await import(
  pathToFileURL(join(coreSrc, "runtime", "methods", "rewind-message.ts")).href
);
const { ConversationRewindCommittedError, isConversationRewindCommittedError } = await import(
  pathToFileURL(join(contractsSrc, "rewind", "index.ts")).href
);
// 真实 FileSystemPort 错误类型：file-rewind 只把 `isFileSystemPortError + not_found`
// 当成「文件不存在」，普通 Error 会被判成读取失败（计划阶段直接 unsafe）。
const { createFileSystemError } = await import(
  pathToFileURL(join(contractsSrc, "interfaces", "file-system.port.ts")).href
);
// UI 侧「失败后把 newText 放回 composer」的唯一判据（packages/ui 无 jsdom，纯函数在这里断言）。
const { resolveEditFailureComposerDraft } = await import(
  pathToFileURL(
    join(
      here,
      "..",
      "..",
      "..",
      "..",
      "..",
      "packages",
      "ui",
      "src",
      "v4",
      "editFailureComposerRestore.ts",
    ),
  ).href
);
const { commandAckSchema, commandResultSchema } = await import("@zcode/shared/zcode-protocol-v4");
// 真实 sqlite 适配器（P1-3 端到端）：legacy「无 intent」行的读法只有真 store 能证明。
const { SqliteSessionStore } = await import(
  pathToFileURL(
    join(cliPackages, "adapters", "src", "storage", "session-store", "sqlite-session-store.ts"),
  ).href
);
// I5 的 UI 判据（纯函数；packages/ui 无 jsdom，与 editFailureComposerRestore 同一层）。
const { resolveEditDelivery, resolveRetryDelivery, shouldCollapseEditState } = await import(
  pathToFileURL(join(uiV4Src, "editDeliveryOutcome.ts")).href
);
// P2-2 的 UI 判据（纯函数）：setQueueItemDelivery ACK 的「已切车道但没内联」。
const { resolveQueueItemDeliveryDegradedReason } = await import(
  pathToFileURL(join(uiV4Src, "queueItemDeliveryOutcome.ts")).href
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
    createPendingInputId,
    discardPendingInput,
    discardRewoundPendingSteerInputs,
    enqueueDeferredInput,
    fallbackPendingGuidesToQueue,
    notifyEventSinks,
    setQueueAutoDrain,
    steerTurn,
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

/**
 * 入队事实：[admission 落账] + TurnSteerQueued（生产同序：先账本后事件）。
 *
 * `ledgerText` / `ledgerAttachments` 与 `projectionText` / `projectionAttachments` 刻意分开：
 * I1 要证明「投影被改成旧值也不得被执行」，两条事实必须在夹具里真的不是同一份。
 * 缺省时它们相等（其余用例不关心 I1 的这条差异）。
 */
async function seedQueuedInput(
  context,
  {
    delivery = "queue",
    id,
    // `text` 必须排在两个派生缺省值之前：解构默认值按出现顺序求值，靠后会 TDZ。
    text,
    targetTurnId,
    kind = "sendText",
    ledgerAttachments = [],
    ledgerText = text,
    projectionAttachments = [],
    projectionText = text,
  },
) {
  await context.runtime.sessionStore.saveSessionInput({
    delivery,
    id,
    kind,
    payload: {
      conversationInputIntent: {
        attachments: ledgerAttachments,
        kind,
        queueItemId: id,
        text: ledgerText,
      },
      text: ledgerText,
    },
    sessionID: SESSION_ID,
  });
  await emitFact(context, SessionEventType.TurnSteerQueued, {
    delivery,
    input: projectionText,
    inputPreview: projectionText,
    inputSize: projectionText.length,
    intent: {
      admittedDelivery: delivery,
      attachmentRefs: projectionAttachments,
      kind,
      queueItemId: id,
      requestedDelivery: delivery,
      sourceCommandId: id.replace(/^queue_/, ""),
      text: projectionText,
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
 * rewind 返回后的权威钩子：`afterLegacyStateMutation` → `autoDrainV4QueueIfReady`
 * （`v4-bridge.ts:505-586`）。这里逐段照抄它真正的判据（`shouldAutoDrainV4QueueHead`
 * 用投影里的 `head.autoDrain` + dispatch 状态 + 会话是否空闲），提升走真实 handler。
 *
 * 它**不依赖**任何「用户点继续」的动作：`autoDrain` 本来就是 true 时只差这一次调用。
 */
async function runAutoDrainHook(context) {
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

/**
 * 「用户点继续 / setAutoDrain(true)」的真实链路：`queue.ts` 的 setAutoDrain handler 只做
 * `app.setQueueAutoDrain(true)` + `afterLegacyStateMutation("queue_auto_drain_resumed")`，
 * 后者在 v4-bridge 里就是 `QueueAutoDrainChanged` 落投影 + `autoDrainV4QueueIfReady`。
 * 这里逐段照抄，不是简化：gate 用真实 `shouldAutoDrainV4QueueHead`，提升用真实
 * `queueHandlers.sendQueuedNow`，执行文本用真实账本读法。
 */
async function resumeAutoDrain(context) {
  await setAutoDrain(context, true);
  return runAutoDrainHook(context);
}

/** `sendQueuedNow` 的可控宿主（真实 handler；账本读法接上下文里的真账本或真 store）。 */
function promotionHarness(context, queueItem, options = {}) {
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
      // goal 分支（P1-4）：objective / intent / displayText 都落在 setTarget 上。
      setTarget: async (params) => {
        captured.goalTarget = params;
        return undefined;
      },
      continueActiveTarget: async (options) => {
        captured.goalContinuation = options;
        return undefined;
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
      options.authority
        ? options.authority({ id: queueItemId, sessionID: sessionId })
        : context.ledger.port.getSessionInputForExecution({ id: queueItemId, sessionID: sessionId }),
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

/**
 * 判据的可判定集合化（Step 12）：三条条件各有唯一事实来源，成员判定必须能逐条取反。
 *
 * 集合 = `session_input` 里同时满足 ①`status=admitted`、②`id ∉ excludeSessionInputIds`、
 * ③`targetTurnId ∈ removedTurnIds ∨ 'deferred'` 的行。
 * - ②③ 在 core 侧判定 → 本用例的真值表（任何一条被放宽/收紧，只有对应的行进出集合）；
 * - ① 是**写侧单点判据**（`settleSessionInput` 的 `where status='admitted'`），由
 *   adapters 的 `test-session-input-ledger-authority` 用例 9 守护——core 拿到的投影项
 *   不携带账本状态，这里只断言「已终态的行不得被回写」这一侧。
 *
 * 12 行 = 2(账本 admitted|promoted) × 2(是否自持) × 3(targetTurnId: removed|kept|deferred)。
 */
test("T-RW1 判据是可判定集合：逐条取反只有对应的行进出集合", async () => {
  const context = createContext();
  const targetOf = { deferred: "deferred", kept: TURN_KEPT, removed: TURN_REMOVED };
  const rows = [];
  for (const admitted of [true, false]) {
    for (const excluded of [true, false]) {
      for (const target of ["removed", "kept", "deferred"]) {
        const id = `queue_cmd-${admitted ? "adm" : "prm"}-${excluded ? "self" : "other"}-${target}`;
        rows.push({ admitted, excluded, id, member: !excluded && target !== "kept" });
        await seedQueuedInput(context, { id, targetTurnId: targetOf[target], text: `${id} 文本` });
        if (!admitted) context.ledger.rows.get(id).status = "promoted";
      }
    }
  }
  const excludedIds = rows.filter((row) => row.excluded).map((row) => row.id);

  const discarded = await context.runtime.discardRewoundPendingSteerInputs({
    excludeSessionInputIds: excludedIds,
    removedTurnIds: [TURN_REMOVED],
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(
    [...discarded].sort(),
    rows
      .filter((row) => row.member)
      .map((row) => row.id)
      .sort(),
    "集合成员 = ②∧③：排除自持 id 后只剩被截断轮次与 deferred，幸存轮一条都不许动",
  );

  for (const row of rows) {
    const expectedStatus = row.admitted ? (row.member ? "discarded" : "admitted") : "promoted";
    assert.equal(
      context.ledger.rows.get(row.id).status,
      expectedStatus,
      `${row.id}: 账本 ${row.admitted ? "admitted" : "promoted"} 行在 member=${row.member} 时状态必须是 ${expectedStatus}`,
    );
    const settles = context.ledger.calls.settles.filter((call) => call.id === row.id);
    assert.equal(
      settles.length > 0,
      row.member,
      `${row.id}: member=${row.member} 时才允许出现 settle 调用（非成员不得被顺带收口）`,
    );
    for (const settle of settles) assert.equal(settle.reason, "rewound");
  }

  // 投影侧同理：剩下的必须正好是非成员。
  assert.deepEqual(
    queueState(context)
      .items.map((item) => item.queueItemId)
      .sort(),
    rows
      .filter((row) => !row.member)
      .map((row) => row.id)
      .sort(),
  );
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

// ── T-RW2 本 bug 的核心断言（不终止直接编辑重发） ────────────────────────────

test("T-RW2 不终止直接编辑重发：autoDrain 仍为 true 时 rewind 钩子也不得提升旧队首", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  // 用户没有点停止、也没有暂停队列 —— 因此 rewind 返回时**没有任何 held 兜底**：
  // `afterLegacyStateMutation("session_rewound")` → `autoDrainV4QueueIfReady` 会看到
  // autoDrain=true + dispatchState=queued + 会话空闲，直接把队首提升起轮。
  // 旧项一旦活过截断，抢跑就发生在这里，而且早于下面 startCanonicalIntent 的 admission。
  context.ledger.seed({ id: SELF_ID, text: NEW_TEXT });

  // rewind 截断（真实级联）。「改前红」= 把这一行退化成空实现：
  // 旧项留在队列里，紧随其后的 rewind 钩子就会把它提升起轮（起跑内容是 OLD_TEXT）。
  await context.runtime.discardRewoundPendingSteerInputs({
    excludeSessionInputIds: [SELF_ID],
    removedTurnIds: [TURN_REMOVED, TURN_REMOVED_CHILD],
    traceContext: TRACE_CONTEXT,
  });

  // rewind 返回后的权威钩子（不是「点继续」：这条链不需要用户额外动作）。
  const hook = await runAutoDrainHook(context);
  assert.equal(
    hook.calls?.sendInput ?? 0,
    0,
    "旧项被提升起轮 = I2 违反（改前红：这里会是 1，且内容是 OLD_TEXT）",
  );
  assert.equal(hook.promoted, false, "作废后队首不存在，auto-drain 无事可做");

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

test("T-RW2 反向：同一条 rewind 钩子在未作废时会立刻把 OLD_TEXT 起轮（证明用例真的在测那条链）", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });

  // 对照组：不跑级联（= 改前行为）。同一个 helper、同一个闸门、同一个托管，唯一差别是
  // 旧项还在队列里——它必须被提升，且起跑内容必须是 OLD_TEXT。
  const hook = await runAutoDrainHook(context);
  assert.equal(hook.promoted, true, "对照组：没有级联时旧项一定会被提升");
  assert.equal(hook.calls.sendInput, 1);
  assert.equal(hook.captured.input.text, OLD_TEXT, "对照组起跑的正是旧文本");
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

/**
 * 「先终止再编辑」的 held 项滞留路径（T-RW2 的旧入口，Step 12 移到 T-RW3）。
 *
 * 这条链上旧项本来就被 stop 冻结在队列里：**改前它也不会自己起跑**，所以它不能承载
 * T-RW2 的「改前红」。留在这里的价值是另一件事——用户后续点「继续」时，恢复动作只能
 * 放行**存活**项；已作废的旧项必须在那一刻也拿不到执行权（否则重置暂停位的每一步都是
 * 一次复发机会）。T-RW2 现在用 `autoDrain=true` 的不终止入口承载核心断言。
 */
test("T-RW3 暂停队列 + 编辑重发后点「继续」：已作废的旧项不得被恢复动作提升", async () => {
  const context = createContext();
  await seedQueuedInput(context, { id: OLD_ID, targetTurnId: TURN_REMOVED, text: OLD_TEXT });
  // 终止 → 队列暂停（stop 显式 setQueueAutoDrain(false)；同一调用同时翻 runtime 门和投影）。
  await setAutoDrain(context, false);
  // 本次编辑重发自身的 admission 行（新文本）。生产时序：空闲编辑重发时 admission 发生在
  // rewind 之后（startCanonicalIntent），此刻投影里还没有它的队列项——只有账本行。
  context.ledger.seed({ id: SELF_ID, text: NEW_TEXT });

  // rewind 截断（真实级联）。
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

// ── T-RW4 stop 结算（只结算队列承载不了的孤儿，Step 6） ──────────────────────

const GUIDE_ID = "queue_cmd-guide";
const GUIDE_TEXT = "本轮未消费的引导输入（stop 后应改投普通队列并保留）";
const ORPHAN_ID = "pending_turn-edited-1_orphan";
const ORPHAN_TEXT = "事件落账失败的内存孤儿（队列里根本不存在）";

/** 内存态 pendingInput 的形状（对齐 steering.ts admitTurnSteer 的构造）。 */
function pendingInputOf({ delivery, id, text }) {
  return {
    delivery,
    id,
    input: text,
    intent: { admittedDelivery: delivery, kind: "sendText", queueItemId: id, text },
    queuedAt: new Date(),
    traceId: TRACE_CONTEXT.traceId,
    turnId: TURN_REMOVED,
  };
}

function activeTurnWith(pendingInputs) {
  return {
    kind: "foreground",
    pendingInputs,
    steerable: false,
    traceContext: { ...TRACE_CONTEXT },
    turnId: TURN_REMOVED,
  };
}

/**
 * stop 的真实时序（`turn.ts:720-751`）：`pauseActiveTargetForCancellation` →
 * `fallbackPendingGuidesToQueue`（guide 原地改投 queue）→ **Step 6 结算** → held 判据。
 * 夹具逐段照抄，不简化：跳过 fallback 就测不到「存活项不许被结算」这条。
 */
async function settleOnCancel(context, activeTurn) {
  const events = [];
  context.runtime.activeTurn = activeTurn;
  const fallbackChanged = await context.runtime.fallbackPendingGuidesToQueue({
    activeTurn,
    events,
    reasonCode: "guide.turnInterrupted",
    traceContext: TRACE_CONTEXT,
  });
  const settled = await context.runtime.discardPendingInput({
    activeTurn,
    events,
    reason: "turn_cancelled",
    traceContext: TRACE_CONTEXT,
  });
  return { events, fallbackChanged, settled };
}

test("T-RW4 stop 只结算孤儿：改投 queue 的 guide 与 held 项账本必须保持 admitted", async () => {
  const context = createContext();
  // ① 本轮未消费的 guide：账本 + 事件投影 + 内存 pendingInputs 三处都有。
  await seedQueuedInput(context, {
    delivery: "guide",
    id: GUIDE_ID,
    targetTurnId: TURN_REMOVED,
    text: GUIDE_TEXT,
  });
  // ② 内存孤儿：真实产生窗口是「push 内存成功、appendEvent 失败」——投影与账本都没有队列行。
  context.ledger.seed({ id: ORPHAN_ID, text: ORPHAN_TEXT });
  // ③ held 队列项：只在投影/账本里，从来不入内存。
  await seedQueuedInput(context, { id: KEPT_ID, targetTurnId: TURN_KEPT, text: KEPT_TEXT });

  const activeTurn = activeTurnWith([
    pendingInputOf({ delivery: "guide", id: GUIDE_ID, text: GUIDE_TEXT }),
    pendingInputOf({ delivery: "queue", id: ORPHAN_ID, text: ORPHAN_TEXT }),
  ]);

  const { fallbackChanged, settled } = await settleOnCancel(context, activeTurn);

  assert.equal(fallbackChanged, 1, "guide 必须先被改投普通 queue（保留语义）");
  assert.deepEqual(settled, [ORPHAN_ID], "只有队列承载不了的孤儿该被结算");

  // ① 存活 guide：账本仍 admitted、零 settle —— 提前置终态会让「继续」的提升被 I1 硬失败。
  assert.equal(
    context.ledger.calls.settles.filter((call) => call.id === GUIDE_ID).length,
    0,
    "对存活项的 settle 就是误杀（账本 admitted 是队列项可执行的唯一前提）",
  );
  assert.equal(context.ledger.rows.get(GUIDE_ID).status, "admitted");
  assert.equal(
    (await context.ledger.port.getSessionInputForExecution({ id: GUIDE_ID, sessionID: SESSION_ID }))
      .state,
    "pending",
    "存活项必须仍可被执行侧读成 pending",
  );
  // 投影侧：guide 改投 queue 后仍在队列里（既有回归红线 test-queue-item-delivery-command C3）。
  const guideRow = queueState(context).items.find((item) => item.queueItemId === GUIDE_ID);
  assert.ok(guideRow, "改投 queue 的 guide 不得从队列消失");
  assert.equal(guideRow.delivery.admitted, "queue");
  assert.equal(guideRow.steer.state, "fellBack");
  assert.equal(guideRow.steer.reasonCode, "guide.turnInterrupted");

  // ② 孤儿：账本 cancelled(turn_cancelled)，内存摘除，投影本来就没有它。
  assert.equal(context.ledger.rows.get(ORPHAN_ID).status, "cancelled");
  assert.equal(context.ledger.rows.get(ORPHAN_ID).statusReason, "turn_cancelled");
  assert.deepEqual(
    activeTurn.pendingInputs.map((item) => item.id),
    [GUIDE_ID],
    "孤儿必须摘出内存：它留在内存会污染 held 判据（该判据读内存长度）",
  );
  assert.equal(
    queueState(context).items.some((item) => item.queueItemId === ORPHAN_ID),
    false,
  );

  // ③ held 队列项全程不受影响（它不在内存里，结算碰不到它）。
  assert.equal(context.ledger.rows.get(KEPT_ID).status, "admitted");
  assert.equal(context.ledger.calls.settles.filter((call) => call.id === KEPT_ID).length, 0);
  assert.ok(queueState(context).items.some((item) => item.queueItemId === KEPT_ID));

  // 事件留痕：只有一条 discard，reason=turn_cancelled，且只点名孤儿。
  const discards = (await context.runtime.eventStore.getEvents(SESSION_ID)).filter(
    (event) => event.type === SessionEventType.TurnSteerDiscarded,
  );
  assert.equal(discards.length, 1);
  assert.deepEqual(discards[0].payload.pendingInputIds, [ORPHAN_ID]);
  assert.equal(discards[0].payload.reason, "turn_cancelled");
  assert.equal(discards[0].payload.targetTurnId, TURN_REMOVED);
});

test("T-RW4 没有孤儿时零结算：stop 不得清空用户排队内容", async () => {
  const context = createContext();
  await seedQueuedInput(context, {
    delivery: "guide",
    id: GUIDE_ID,
    targetTurnId: TURN_REMOVED,
    text: GUIDE_TEXT,
  });
  const activeTurn = activeTurnWith([
    pendingInputOf({ delivery: "guide", id: GUIDE_ID, text: GUIDE_TEXT }),
  ]);

  const { settled } = await settleOnCancel(context, activeTurn);

  assert.deepEqual(settled, [], "内存里全是队列承载得了的项 → 一条都不结算");
  assert.equal(context.ledger.calls.settles.length, 0, "stop 之后账本不得出现任何终态写入");
  assert.equal(context.ledger.rows.get(GUIDE_ID).status, "admitted");
  assert.equal(
    (await context.runtime.eventStore.getEvents(SESSION_ID)).filter(
      (event) => event.type === SessionEventType.TurnSteerDiscarded,
    ).length,
    0,
    "没有孤儿就不该有 discard 事件（有事件 = 项从队列消失 = 误杀）",
  );
});

test("T-RW4 投影读失败时零结算（读失败 ≠ 队列为空）", async () => {
  const context = createContext();
  await seedQueuedInput(context, {
    delivery: "guide",
    id: GUIDE_ID,
    targetTurnId: TURN_REMOVED,
    text: GUIDE_TEXT,
  });
  const activeTurn = activeTurnWith([
    pendingInputOf({ delivery: "guide", id: GUIDE_ID, text: GUIDE_TEXT }),
    pendingInputOf({ delivery: "queue", id: ORPHAN_ID, text: ORPHAN_TEXT }),
  ]);
  context.runtime.activeTurn = activeTurn;
  // 判据不可信时最危险的走法是把「读不出」当成「一条都不在队列里」→ 全量误杀。
  context.runtime.rebuildProjection = async () => {
    throw new Error("projection unavailable");
  };

  const settled = await context.runtime.discardPendingInput({
    activeTurn,
    reason: "turn_cancelled",
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(settled, []);
  assert.equal(activeTurn.pendingInputs.length, 2, "内存一条都不许动");
  assert.equal(context.ledger.calls.settles.length, 0, "读失败必须 fail-safe 到零结算");
  assert.ok(
    context.runtime.warnings.some((entry) => entry.fields?.event === "turn.steer.settle_skipped"),
    "跳过必须可观测",
  );
});

test("T-RW4 引用守卫：activeTurn 已被替换时零结算", async () => {
  const context = createContext();
  const staleTurn = activeTurnWith([
    pendingInputOf({ delivery: "queue", id: ORPHAN_ID, text: ORPHAN_TEXT }),
  ]);
  context.runtime.activeTurn = activeTurnWith([]);

  const settled = await context.runtime.discardPendingInput({
    activeTurn: staleTurn,
    reason: "turn_cancelled",
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(settled, []);
  assert.equal(staleTurn.pendingInputs.length, 1, "过期句柄不得改内存");
  assert.equal(context.ledger.calls.settles.length, 0);
});

test("T-RW4 结算必须排在 held 判据之前（唯一的顺序约束），且确实被接线", () => {
  const source = stripComments(readCoreSource("runtime/methods/turn.ts"));
  const cancelStart = source.indexOf("if (coreError.type === CoreErrorType.TurnCancelled) {");
  const settleIndex = source.indexOf("await this.discardPendingInput({");
  const heldIndex = source.indexOf("activeTurn.pendingInputs.length > 0");
  assert.ok(cancelStart > 0, "取消分支必须仍然存在");
  assert.ok(settleIndex > 0, "Step 6 的结算必须被接线（不允许「能力在但零调用方」）");
  assert.ok(settleIndex > cancelStart, "结算必须挂在取消路径里，不得挪到普通失败分支");
  assert.ok(heldIndex > 0, "held 判据必须仍然存在");
  assert.ok(
    settleIndex < heldIndex,
    "结算必须在 held 判据之前：held 判据读内存长度，孤儿留在内存会把「队列为空」判成 held（paused + 0 项）",
  );
  // 与 fallback 的先后**不是**语义约束：判据是「是否仍在事件投影 pendingSteerInputs 里」，
  // guide 项在 fallback 之前也已在投影中（变异 M2 实测：把它挪到 fallback 之前，
  // 结算结果与账本状态逐条不变）。这里不写一条无法证伪的顺序断言。
});

// ── T-RT 公共夹具（I4 事务，Step 7-9）───────────────────────────────────────

const REWIND_WORKSPACE_ROOT = join(here, "__file_rewind_fixture__");
const REWIND_TARGET_MESSAGE_ID = "msg-rt-target";
const REWIND_CHECKPOINT_ID = "ckpt-rt-1";
const EDIT_NEW_TEXT = "失败后必须能原样重发的新文本";

/**
 * 真实 `applyWorkspaceFileRewind` + 内存文件系统（Step 7 / T-RT2）。
 *
 * 只桩掉三个端口（artifactStore / fileSystemPort / eventStore），写文件、journal、
 * 补偿与「apply / commit 阶段判定」全部走真实实现——T-RT2 断言的正是这三者的先后关系，
 * 用假 runtime 复刻等于把被测逻辑删掉。
 *
 * `files`: { "src/a.ts": { before, after } }，current 初始 = after（= checkpoint 记下的
 * 「改完后」内容，即 rewind 前的工作区状态）。
 */
function createFileRewindRuntime({ files, writeFailureAt } = {}) {
  const calls = { commits: 0, reads: 0, removes: [], writes: [] };
  const contents = new Map(
    Object.entries(files ?? {}).map(([relative, state]) => [
      join(REWIND_WORKSPACE_ROOT, relative),
      { ...state, current: state.current ?? state.after },
    ]),
  );
  const runtime = {
    appendEvent,
    artifactStore: {
      readToolResultArtifact: async () => ({
        content: JSON.stringify({
          files: Object.entries(files ?? {}).map(([relative, state]) => ({
            afterContent: state.after,
            beforeContent: state.before,
            existedBefore: state.before !== null,
            path: relative,
            structuredPatch: [],
          })),
          createdAt: "2026-10-25T00:00:00.000Z",
          kind: "workspace_file_before_change",
          toolCallId: "tc-rt-1",
          toolName: "Edit",
          version: 1,
        }),
      }),
    },
    createEvent,
    eventSinks: [],
    eventStore: {
      getEvents: async () => [
        createSessionEvent(
          SessionEventType.CheckpointCreated,
          SESSION_ID,
          {
            checkpointId: REWIND_CHECKPOINT_ID,
            fileCount: Object.keys(files ?? {}).length,
            messageId: REWIND_TARGET_MESSAGE_ID,
            scope: "workspace",
            snapshotRef: `artifact://${REWIND_CHECKPOINT_ID}`,
          },
          { traceId: TRACE_CONTEXT.traceId },
        ),
      ],
    },
    fileSystemPort: {
      readTextFile: async ({ path }) => {
        calls.reads += 1;
        const state = contents.get(path);
        if (!state || state.current === null) {
          throw createFileSystemError({ code: "not_found", message: `missing ${path}`, path });
        }
        return { content: state.current };
      },
      removeFile: async ({ path }) => {
        calls.removes.push(path);
        contents.get(path).current = null;
      },
      writeTextFile: async ({ content, path }) => {
        calls.writes.push({ content, path });
        if (calls.writes.length === writeFailureAt) throw new Error("simulated write failure");
        contents.get(path).current = content;
      },
    },
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    notifyEventSinks,
    rootTraceContext: TRACE_CONTEXT,
    sessionId: SESSION_ID,
    workspaceRoot: REWIND_WORKSPACE_ROOT,
  };
  return {
    calls,
    currentOf: (relative) => contents.get(join(REWIND_WORKSPACE_ROOT, relative)).current,
    runtime,
  };
}

function applyFileRewind(harness, commitAfterApply) {
  return applyWorkspaceFileRewind.call(harness.runtime, {
    ...(commitAfterApply ? { commitAfterApply } : {}),
    targetMessageIds: [REWIND_TARGET_MESSAGE_ID],
    traceContext: TRACE_CONTEXT,
  });
}

/**
 * `editUserQuery` 的事务宿主（T-RT1/3/4/5）：真实 handler + 可控 runtime。
 *
 * `state.startMode` 可在用例中间切换，用来验证「失败后同一份 newText 能立刻重发」。
 * `state.revert` 是 `setRevert` 的替身：rewind 成功才写目标 messageId，恢复会话
 * （spec 已否决的 restoreRevert）只会把它写回 null/旧值。
 */
function createEditTransactionHarness({
  commitFailure = false,
  queuedDelivery = "queue",
  startMode = "started",
  // P1-2：模拟「setRevert 之后失败」——真实 core 会抛带 committed:true 的类型化错误
  // （`ConversationRewindCommittedError`），handler 必须据此判定「截断已提交」。
  rewindCommittedFailure = false,
} = {}) {
  const calls = {
    cancels: [],
    fileApplies: 0,
    previews: 0,
    rewinds: [],
    sendInputs: [],
    // I3：执行侧真正交给 Core 的 intent/delivery 事实（`sendInput(input, options)`），
    // 与 admission 侧的 `resolveCanonicalInput` 产出逐字对比。
    sendOptions: [],
    stateMutations: [],
  };
  const state = { revert: null, startMode };
  const emptyPreview = {
    canApply: true,
    ignoredFiles: [],
    safeFiles: [{ action: "restore", operationCount: 1, path: "src/a.ts", toolNames: ["Edit"] }],
    unsafeFiles: [],
  };
  const runtime = {
    applyWorkspaceFileRewind: async ({ commitAfterApply }) => {
      calls.fileApplies += 1;
      if (commitFailure) {
        // 真实 core 在 commit 阶段失败时返回 failurePhase:"commit"（文件已回退、不补偿）。
        return {
          applied: false,
          commitError: "simulated commit failure",
          failurePhase: "commit",
          preview: emptyPreview,
          response: "files rewound, commit failed",
        };
      }
      await commitAfterApply();
      return { applied: true, preview: emptyPreview, response: "applied" };
    },
    getActiveForegroundExecutionId: () => undefined,
    getSessionModelSelection: () => undefined,
    previewWorkspaceFileRewind: async () => {
      calls.previews += 1;
      return emptyPreview;
    },
    rewindConversationToMessage: async (params) => {
      calls.rewinds.push(params);
      if (rewindCommittedFailure) {
        // 真实原语在 setRevert 落盘后失败时的形状：截断已是事实（revert 已写），
        // 错误带 committed:true。原样上抛由 handler 转成可见失败。
        state.revert = params.targetMessageId;
        throw new ConversationRewindCommittedError({
          cause: new Error("rebuild failed after commit"),
          rewindId: "rewind-rt-committed",
          targetMessageId: params.targetMessageId,
        });
      }
      state.revert = params.targetMessageId;
      return { strategy: "active_chain" };
    },
  };
  const record = {
    app: {
      getModel: () => "openai/gpt-5",
      getMode: () => "build",
      readTarget: async () => null,
      runtime,
      sendInput: async (input, options) => {
        calls.sendInputs.push(input);
        calls.sendOptions.push(options);
        if (state.startMode === "throws") {
          throw Object.assign(new Error("model target unavailable"), {
            reasonCode: "fault.command.modelUnavailable",
          });
        }
        // 复刻 Core admission 的 busy 门：abort 若留下 active turn / foreground 执行权，
        // 新提交会被退回队列而不是起轮（T-RT3 的判据）。
        if (
          record.activeAbortController ||
          runtime.getActiveForegroundExecutionId() !== undefined
        ) {
          return {
            delivery: "queue",
            kind: "queued",
            pendingInputId: "pending-rt-busy",
            queueLength: 1,
          };
        }
        if (state.startMode === "queued") {
          // `delivery` 是 Core admission 的现场事实（TurnSteerResult）：guide = 内联进
          // 当前轮，queue = 等下一轮。prompt-turn 只转述，不参与判定。
          return {
            delivery: queuedDelivery,
            kind: "queued",
            pendingInputId: "pending-rt-queued",
            queueLength: 1,
          };
        }
        return { completion: Promise.resolve(), kind: "started_turn", turnId: "turn-rt-new" };
      },
      sessionId: SESSION_ID,
      updateTargetStatus: async () => null,
    },
    persistence: "immediate",
    traceContext: TRACE_CONTEXT,
  };
  // 被编辑轮的 canonical 事实（I3：admission 侧要用同一份继承源再解析一次）。
  const editTargetIntent = {
    admittedDelivery: "startNow",
    clientId: "ui",
    kind: "sendText",
    queueItemId: "queue-original",
    requestedDelivery: "startNow",
    sourceCommandId: "cmd-original",
    text: "被编辑的旧文本",
  };
  const host = {
    afterLegacyStateMutation: async (_record, reason) => {
      calls.stateMutations.push(reason);
    },
    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      calls.cancels.push({ queueItemId, reason, sessionId });
    },
    getInputRoutingMode: () => null,
    getMessageIdsForTurnRow: () => [REWIND_TARGET_MESSAGE_ID],
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => undefined, warn: () => undefined },
    resolveRowActionTarget: () => ({
      editTarget: {
        entityId: "ent-rt",
        intent: editTargetIntent,
        productTurnId: "turn-1",
        transcriptMessageId: REWIND_TARGET_MESSAGE_ID,
      },
      messageId: REWIND_TARGET_MESSAGE_ID,
      ok: true,
      row: {
        entityId: "ent-rt",
        kind: "userInput",
        productTurnId: "turn-1",
        rowId: 4,
        turnId: "turn-1",
        visibility: "visible",
      },
    }),
  };
  const makeEnvelope = (workspaceMode = "preserve") => ({
    baseLogEpoch: "epoch-rt",
    baseRevision: 0,
    clientId: "ui",
    commandId: "cmd-rt-edit",
    issuedAt: Date.now(),
    payload: {
      newText: EDIT_NEW_TEXT,
      target: { entityId: "ent-rt", rowId: 4 },
      workspaceMode,
    },
    sessionId: SESSION_ID,
    type: "editUserQuery",
  });
  return { calls, editTargetIntent, host, makeEnvelope, record, state };
}

// ── T-RT2 apply / commit 阶段分离（Step 7）──────────────────────────────────

test("T-RT2① apply 阶段失败：commitAfterApply 根本不被调用（shutdown 前不落 setRevert）", async () => {
  // 文件被外部改过 → 计划阶段判 unsafe，写文件之前就返回 blocked。
  const unsafe = createFileRewindRuntime({
    files: { "src/a.ts": { after: "after", before: "before", current: "externally modified" } },
  });
  const unsafeResult = await applyFileRewind(unsafe, async () => {
    unsafe.calls.commits += 1;
  });
  assert.equal(unsafeResult.applied, false);
  assert.equal(unsafeResult.preview.canApply, false);
  assert.equal(unsafeResult.failurePhase, "apply");
  assert.equal(unsafe.calls.commits, 0, "apply 未成功就绝不能进入 commit（= setRevert 不落）");
  assert.equal(unsafe.currentOf("src/a.ts"), "externally modified", "计划阶段失败不得改工作区");

  // 写文件阶段失败：journal 逆序补偿，文件回到 rewind 前内容，commit 同样不得开始。
  const writeFailure = createFileRewindRuntime({
    files: {
      "src/a.ts": { after: "a-after", before: "a-before" },
      "src/b.ts": { after: "b-after", before: "b-before" },
    },
    writeFailureAt: 2,
  });
  const writeResult = await applyFileRewind(writeFailure, async () => {
    writeFailure.calls.commits += 1;
  });
  assert.equal(writeResult.applied, false);
  assert.equal(writeResult.failurePhase, "apply");
  assert.equal(writeFailure.calls.commits, 0, "写失败必须停在 apply 阶段");
  assert.equal(writeFailure.currentOf("src/a.ts"), "a-after", "已写文件必须被补偿");
  assert.equal(writeFailure.currentOf("src/b.ts"), "b-after", "未写文件保持原样");
  assert.equal(
    writeFailure.calls.writes.length,
    4,
    "两次 apply 写（第二次失败）+ journal 逆序补偿两次（journal 在写之前入账，含失败那次）",
  );
});

test("T-RT2② commit 阶段失败：文件不得被补偿回未截断，且必须标出 failurePhase=commit", async () => {
  const harness = createFileRewindRuntime({
    files: { "src/a.ts": { after: "after-content", before: "before-content" } },
  });
  let sawRewoundFiles = false;
  const result = await applyFileRewind(harness, async () => {
    harness.calls.commits += 1;
    // commit 回调执行时文件必须已经是 before 内容：这是「文件回退先于会话截断」的证据。
    sawRewoundFiles = harness.currentOf("src/a.ts") === "before-content";
    throw new Error("simulated commit failure");
  });

  assert.equal(harness.calls.commits, 1, "commit 必须真的被调用过（否则测的不是这条路）");
  assert.equal(sawRewoundFiles, true, "commit 开始时文件必须已回退");
  assert.equal(result.applied, false);
  assert.equal(result.failurePhase, "commit");
  assert.equal(result.commitError, "simulated commit failure");
  assert.equal(
    harness.currentOf("src/a.ts"),
    "before-content",
    "commit 失败后补偿文件 = 「会话已截断 + 文件未截断」，重启也不自愈；必须保持已回退",
  );
  assert.equal(
    harness.calls.writes.length,
    1,
    "commit 阶段失败不得再写文件（补偿写会让上面那条断言变成另一种事故）",
  );
});

test("T-RT2② commit 失败在 handler 侧必须上行成可见 fault，不得伪装成 blocked", async () => {
  const harness = createEditTransactionHarness({ commitFailure: true });
  await assert.rejects(
    () => forkEditRetryHandlers.editUserQuery(harness.host, harness.makeEnvelope("rewind")),
    (error) => {
      assert.ok(error instanceof V4EditCommittedFailureError, "必须是 I4 的可见失败类型");
      assert.equal(error.draftText, EDIT_NEW_TEXT, "newText 必须随失败一起回传");
      assert.match(error.message, /工作区文件已回退/);
      assert.match(error.message, /重新发送/);
      return true;
    },
  );
  const cancels = harness.calls.cancels;
  assert.equal(cancels.length, 1, "本次命令自持的账本行必须被结算");
  assert.equal(cancels[0].queueItemId, "queue_cmd-rt-edit", "结算的是本次 admission 行");
});

test("T-RT2③ 原语在 setRevert 之后失败必须抛 committed:true（真 core，不是 stub）", async () => {
  // 直接用真实 `rewindConversationToMessage`：提交点（setRevert）之后的三步
  // ——级联作废 / 派生状态重建 / RewindTriggered——任一抛错都必须变成类型化事实。
  // 否则 handler 的局部布尔（只在整段成功后翻转）会把这个窗口原样 rethrow 成
  // 「什么都没提交」：历史已截断、无 draftText、无「历史已回退」文案。
  const makeRuntime = ({ failAppend, failBranchGeneration = false }) => {
    const userMessage = {
      info: { id: "msg-user-rt1", role: "user", sessionID: SESSION_ID, time: { created: 1 } },
      parts: [
        {
          id: "part-rt1",
          messageID: "msg-user-rt1",
          sessionID: SESSION_ID,
          text: "原始输入",
          time: { end: 2, start: 1 },
          type: "text",
        },
      ],
    };
    const calls = { reverts: [], events: [] };
    const runtime = {
      artifactStore: undefined,
      branchGeneration: 0,
      createEvent: (type, payload, trace) =>
        createSessionEvent(type, SESSION_ID, payload, { traceId: trace.traceId }),
      // 故意在 RewindTriggered 上抛错 = 「setRevert 之后失败」的最小真实窗口
      // （`discardRewoundPendingSteerInputs` 无候选会早退，`rebuildConversationDerivedState`
      //  用最小桩跑通；第三个 append 点是唯一必到的提交后写）。
      discardRewoundPendingSteerInputs,
      appendEvent: async (event) => {
        calls.events.push(event.type);
        if (failAppend && event.type === "rewind_triggered") {
          throw new Error("simulated append failure after commit");
        }
        return event;
      },
      injectTargetStateIntoMessageHistory: () => undefined,
      logger: { debug: () => undefined, error: () => undefined, info: () => undefined, warn: () => undefined },
      messageHistory: {
        addAttachment: () => undefined,
        addEntries: () => undefined,
        borrowReadOnlyRuntimeEntries: () => [],
        replaceMessages: () => undefined,
        reset: () => undefined,
        setCacheMiss: () => undefined,
      },
      readFileState: new Map(),
      readSessionTargetForContext: async () => null,
      rebuildProjection: async () => ({ pendingSteerInputs: [] }),
      runtimeTaskRegistry: {
        all: () => ({}),
        // cr-func P2-1：宿主实现可以抛错。它在 `setRevert` 之后执行，所以同样是
        // 「提交后失败」——必须落在 try 内变成 committed 事实。
        setActiveBranchGeneration: () => {
          if (failBranchGeneration) {
            throw new Error("simulated registry failure after commit");
          }
        },
      },
      sessionId: SESSION_ID,
      sessionStore: {
        getSession: async () => ({ revert: undefined }),
        messages: async () => [userMessage],
        setRevert: async (input) => {
          calls.reverts.push(input.revert);
        },
      },
      workspaceRoot: "D:/tmp/ws",
      workingDirectory: "D:/tmp/ws",
    };
    return { calls, runtime };
  };

  // 正向对照：不注入失败时同一条路径正常返回（证明下面不是「反正都抛」）。
  const ok = makeRuntime({ failAppend: false });
  const applied = await rewindConversationToMessage.call(ok.runtime, {
    events: [],
    targetMessageId: "msg-user-rt1",
    traceContext: TRACE_CONTEXT,
  });
  assert.equal(applied.keptMessageCount, 0);
  assert.equal(ok.calls.reverts.length, 1, "正向对照：setRevert 已落盘");

  const failing = makeRuntime({ failAppend: true });
  let failure;
  await assert.rejects(
    () =>
      rewindConversationToMessage.call(failing.runtime, {
        events: [],
        targetMessageId: "msg-user-rt1",
        traceContext: TRACE_CONTEXT,
      }),
    (error) => {
      failure = error;
      return true;
    },
  );
  // 变异探测：去掉 rewind-message.ts 里的 try/catch（或把类型化错误换回原错），本条即红。
  assert.equal(isConversationRewindCommittedError(failure), true, "必须是带 committed 事实的类型化错误");
  assert.equal(failure.committed, true);
  assert.equal(failing.calls.reverts.length, 1, "提交点是 setRevert —— 它确实已经发生");

  // cr-func P2-1：`branchGeneration` 与 `runtimeTaskRegistry.setActiveBranchGeneration`
  // 两行内存/注册表镜像赋值也必须在提交点之后。宿主实现一抛错，历史已经截断——
  // 若这两行在 try 之外，异常会以普通错误上行成「什么都没提交」。
  // 变异：把 try 上移的那两行放回 try 之前，本条即红。
  const registryFailing = makeRuntime({ failAppend: false, failBranchGeneration: true });
  let registryFailure;
  await assert.rejects(
    () =>
      rewindConversationToMessage.call(registryFailing.runtime, {
        events: [],
        targetMessageId: "msg-user-rt1",
        traceContext: TRACE_CONTEXT,
      }),
    (error) => {
      registryFailure = error;
      return true;
    },
  );
  assert.equal(
    isConversationRewindCommittedError(registryFailure),
    true,
    "setActiveBranchGeneration 抛错同样是「截断已提交」",
  );
  assert.equal(registryFailure.committed, true);
  assert.equal(registryFailing.calls.reverts.length, 1, "setRevert 已落盘");
});

test("T-RT8（cr-func P2-1）/rewind message 路径必须把 committed 事实写进失败文案", () => {
  // TUI `/rewind` 与 edit/retry 共用同一个 core 原语，但这条路径没有 ACK/draftText：
  // 可读文案是唯一的事实载体。过去它被拍平成普通 `Rewind failed`。
  const source = stripComments(
    readFileSync(join(coreSrc, "runtime", "methods", "rewind.ts"), "utf8"),
  );
  // 变异：删掉 committed 分支（回到 `createTurnFailureError(error, abortSignal, "Rewind failed")`
  // + 统一 fallbackMessage），前四条断言即红。
  assert.match(source, /isConversationRewindCommittedError\(error\)/u);
  assert.match(source, /Rewind committed: [^"']*truncated/u);
  assert.doesNotMatch(source, /createTurnFailureError\(error, abortSignal, "Rewind failed"\)/u);
  assert.match(source, /fallbackMessage: failureMessage/u, "TurnError payload 必须拿到同一条文案");
  assert.match(source, /rewind\.committed_step_failed/u, "日志事件名必须能区分提交后失败");
  // 主消息不能打 Wrapper role：error-payload 会选择器跳过 wrapper 帧、改读底层 cause。
  assert.match(source, /createCoreError\(CoreErrorType\.UnknownError, failureMessage/u);
});

test("T-RT2③ handler 用事实而不是布尔判「已提交」：类型化错误 → draftText + 历史已回退", async () => {
  const harness = createEditTransactionHarness({ rewindCommittedFailure: true });
  await assert.rejects(
    () => forkEditRetryHandlers.editUserQuery(harness.host, harness.makeEnvelope("preserve")),
    (error) => {
      assert.ok(
        error instanceof V4EditCommittedFailureError,
        "setRevert 之后失败不得原样上行成「什么都没提交」",
      );
      assert.equal(error.draftText, EDIT_NEW_TEXT, "newText 必须回 composer（目标行已随截断消失）");
      assert.match(error.message, /历史已回退到目标轮/);
      return true;
    },
  );
  // 失败按提交后语义收口：账本行被结算，且没有尝试 start（截断后不该继续起轮）。
  assert.equal(harness.calls.cancels.length, 1);
  assert.equal(harness.calls.sendInputs.length, 0);
});

// ── T-RT1 / T-RT3 / T-RT4 / T-RT5 abort 语义（Step 8-9）──────────────────────
test("T-RT1 start 失败：截断保持已提交、不回滚，客户端收到带「历史已回退」语义的 fault", async () => {
  const harness = createEditTransactionHarness({ startMode: "throws" });
  let failure;
  await assert.rejects(
    () => forkEditRetryHandlers.editUserQuery(harness.host, harness.makeEnvelope("preserve")),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.ok(failure instanceof V4EditCommittedFailureError, "必须转成可见的 I4 失败");
  assert.equal(failure.draftText, EDIT_NEW_TEXT);
  assert.equal(
    failure.reasonCode,
    "fault.command.modelUnavailable",
    "原始领域错误码必须保留（客户端要能按 guard/fault 分流）",
  );
  assert.match(failure.message, /历史已回退到目标轮/);
  assert.match(failure.message, /可直接重新发送/);

  // 会话侧：revert 保持已截断，没有任何「恢复会话」的写回（第二次 rewind 就是回滚信号）。
  assert.equal(harness.state.revert, REWIND_TARGET_MESSAGE_ID, "不得回滚截断");
  assert.equal(harness.calls.rewinds.length, 1, "失败后不得再提交一次反向 rewind");
  // 账本侧：本次命令自持行被结算，不留 admitted limbo。
  assert.equal(harness.calls.cancels.length, 1);
  assert.equal(harness.calls.cancels[0].queueItemId, "queue_cmd-rt-edit");
  assert.equal(harness.calls.cancels[0].reason, "fault.command.modelUnavailable");
  // start 确实被尝试过（失败点必须在 start，不能是更早的校验）。
  assert.equal(harness.calls.sendInputs.length, 1);
  assert.equal(harness.calls.sendInputs[0].text, EDIT_NEW_TEXT);
});

test("T-RT3 失败后拿到的草稿可以直接发送成功（不靠行内编辑态存活、不留 active 锁）", async () => {
  const harness = createEditTransactionHarness({ startMode: "throws" });
  let failure;
  await assert.rejects(
    () => forkEditRetryHandlers.editUserQuery(harness.host, harness.makeEnvelope()),
    (error) => {
      failure = error;
      return true;
    },
  );

  // 用户拿到草稿后直接发送（真实入口是 composer：新 commandId、普通 sendText）。
  // 这里只验证 abort 之后这条提交能被准入——残留 active turn / 锁会让它变成 queued。
  harness.state.startMode = "started";
  const resent = await harness.record.app.sendInput({ text: failure.draftText });
  assert.equal(failure.draftText, EDIT_NEW_TEXT, "草稿内容必须就是 newText");
  assert.equal(resent.kind, "started_turn", "abort 之后新提交必须能起轮（不得留 active turn/锁）");
  assert.equal(harness.calls.sendInputs.at(-1).text, EDIT_NEW_TEXT, "起轮的必须仍是编辑后的文本");
  assert.equal(
    harness.record.activeAbortController,
    undefined,
    "abort 不得留下 bootstrap controller",
  );
  assert.equal(
    harness.state.revert,
    REWIND_TARGET_MESSAGE_ID,
    "截断保持（用户看到的历史与工作区一致）",
  );
});

test("T-RT4 失败结果把 newText 写进 composer 草稿；成功（含 queued）绝不覆盖用户输入", () => {
  const harness = createEditTransactionHarness();
  const failedAck = {
    commandId: "cmd-rt-edit",
    draftText: EDIT_NEW_TEXT,
    message: "历史已回退到目标轮…",
    reasonCode: "fault.command.executionFailed",
    revisionAtDecision: 0,
    status: "failed",
  };
  assert.deepEqual(
    resolveEditFailureComposerDraft(failedAck),
    { inputKind: "sendText", text: EDIT_NEW_TEXT },
    "T-RT3 的唯一实现路径：失败时 newText 必须能落回 composer 草稿",
  );
  assert.equal(
    resolveEditFailureComposerDraft({ ...failedAck, status: "accepted" }),
    null,
    "成功（含 queued）不得用草稿覆盖用户当前输入",
  );
  assert.equal(
    resolveEditFailureComposerDraft({ ...failedAck, draftText: undefined }),
    null,
    "没有 draftText 的失败（校验期拒绝、目标行还在）不得凭空多出一份草稿",
  );
  // 契约必须能承载该字段（ACK additive）。
  const parsed = commandAckSchema.parse({ ...failedAck, commandId: "cmd-rt-edit" });
  assert.equal(parsed.draftText, EDIT_NEW_TEXT);
  // 链路最后一环：gateway 只从显式携带 draftText 的领域错误透传，不做推断。
  const gatewaySource = stripComments(
    readFileSync(join(bootstrapSrc, "zcode-protocol-v4/v4-gateway.ts"), "utf8"),
  );
  assert.match(gatewaySource, /draftText\s*=\s*[\s\S]{0,200}?\.draftText/);
  assert.match(gatewaySource, /\.\.\.\(draftText \? \{ draftText \} : \{\}\)/);
});

test("T-RT5 newText 被 queued 不算失败：不触发 abort、不结算账本行", async () => {
  const harness = createEditTransactionHarness({ startMode: "queued" });
  const result = await forkEditRetryHandlers.editUserQuery(harness.host, harness.makeEnvelope());

  assert.equal(result?.disposition, "rewind", "排队是成功投递（I5 负责可见性），不是失败");
  assert.equal(result?.delivery, "queue", "ACK 必须如实带上投递态（I5），不能只有 success");
  assert.equal(harness.calls.sendInputs.length, 1);
  assert.equal(harness.calls.sendInputs[0].text, EDIT_NEW_TEXT);
  assert.deepEqual(
    harness.calls.cancels,
    [],
    "queued 走 abort 会把它刚排进队列的输入结算掉 = 静默丢输入",
  );
  assert.equal(harness.state.revert, REWIND_TARGET_MESSAGE_ID, "截断按用户意图保留");
});

// ── T-DA1 / T-DA2 投递态上抛与 UI 分流（Step 10-11 / I5）──────────────────────

test("T-DA1 queued 时 ACK 必须带 delivery 三值 + queueItemId（queued 不得表现为成功）", async () => {
  // ① 真起跑：startNow，且没有队列项可指。
  const started = createEditTransactionHarness({ startMode: "started" });
  const startedResult = await forkEditRetryHandlers.editUserQuery(
    started.host,
    started.makeEnvelope(),
  );
  assert.equal(startedResult?.disposition, "rewind");
  assert.equal(
    startedResult?.delivery,
    "startNow",
    "started_turn 的投递态必须是 startNow（不能一律写 queue 让 UI 每次都提示排队）",
  );
  assert.equal(startedResult?.queueItemId, undefined, "startNow 没有队列项，不许编一个 id");

  // ② 排队：ACK 如实说 queue，并指向投影里那条队列项（删除/撤回要点得中）。
  const queued = createEditTransactionHarness({ startMode: "queued" });
  const queuedResult = await forkEditRetryHandlers.editUserQuery(
    queued.host,
    queued.makeEnvelope(),
  );
  assert.equal(queuedResult?.disposition, "rewind", "排队仍是成功投递，不是失败（T-RT5）");
  assert.equal(
    queuedResult?.delivery,
    "queue",
    "这就是 I5 的核心：queued 过去只有 success，客户端无法区分「已起跑」与「排队」",
  );
  assert.equal(
    queuedResult?.queueItemId,
    "queue_cmd-rt-edit",
    "队列项 id 必须与 admission 权威 id 同源（= 投影 intent.queueItemId）",
  );
  assert.deepEqual(queued.calls.cancels, [], "排队不得触发 abort");

  // ③ guide：内联进当前轮，与 queue 必须可区分——三值不是两值。
  const guided = createEditTransactionHarness({ startMode: "queued", queuedDelivery: "guide" });
  const guidedResult = await forkEditRetryHandlers.editUserQuery(
    guided.host,
    guided.makeEnvelope(),
  );
  assert.equal(
    guidedResult?.delivery,
    "guide",
    "Core 说 guide 就必须报 guide：若在 ACK 层把 queued 一律写成 queue，客户端会把「模型已看到」误报成「排队中」",
  );
  assert.equal(guidedResult?.queueItemId, "queue_cmd-rt-edit", "guide 也是队列/待输入项，给 id");

  // ④ 契约层：三值都能过 result schema，且 queueItemId 可携带。
  for (const delivery of ["startNow", "queue", "guide"]) {
    const parsed = commandResultSchema.parse({
      delivery,
      disposition: "rewind",
      sessionId: SESSION_ID,
      type: "editUserQuery",
      ...(delivery === "startNow" ? {} : { queueItemId: "queue_cmd-rt-edit" }),
    });
    assert.equal(parsed.delivery, delivery);
  }
  // ACK 层同样能承载这些字段（客户端从 ack.result 读）。
  const ack = commandAckSchema.parse({
    commandId: "cmd-rt-edit",
    result: {
      delivery: "queue",
      disposition: "rewind",
      queueItemId: "queue_cmd-rt-edit",
      sessionId: SESSION_ID,
      type: "editUserQuery",
    },
    revisionAtDecision: 0,
    status: "accepted",
  });
  assert.equal(ack.result?.delivery, "queue");
});

test("T-DA1 来源：Core admission 回执自己带 delivery（steer 与 deferred 两条车道，不留给调用方复算）", async () => {
  const context = createContext();
  const runtime = context.runtime;

  // 无活跃轮 → deferred 入队车道。
  const deferred = await enqueueDeferredInput.call(runtime, {
    input: DEFERRED_TEXT,
    traceContext: TRACE_CONTEXT,
  });
  assert.equal(deferred.kind, "queued");
  assert.equal(deferred.delivery, "queue", "缺省落到 queue 车道（与事件里的 delivery 同一个值）");
  const guideDeferred = await enqueueDeferredInput.call(runtime, {
    delivery: "guide",
    input: DEFERRED_TEXT,
    traceContext: TRACE_CONTEXT,
  });
  assert.equal(guideDeferred.delivery, "guide", "guide 请求必须原样回执，不能被 ACK 层抹成 queue");

  // 有活跃轮 → steer 车道：request.delivery 缺省仍然是 queue。
  runtime.activeTurn = {
    kind: "user",
    pendingInputs: [],
    steerable: true,
    traceContext: TRACE_CONTEXT,
    turnId: TURN_KEPT,
  };
  const steered = await steerTurn.call(runtime, {
    input: DEFERRED_TEXT,
    traceContext: TRACE_CONTEXT,
  });
  assert.equal(steered.kind, "queued");
  assert.equal(steered.delivery, "queue", "steer 车道的缺省投递是 queue（不是 guide）");
  const guideSteered = await steerTurn.call(runtime, {
    delivery: "guide",
    input: DEFERRED_TEXT,
    traceContext: TRACE_CONTEXT,
  });
  assert.equal(guideSteered.delivery, "guide");
});

test("T-DA2 旧 CLI 不回 delivery：UI 按未知处理（不弹排队提示、沿用旧收敛）", () => {
  const legacyAck = {
    commandId: "cmd-rt-edit",
    result: { disposition: "rewind", sessionId: SESSION_ID, type: "editUserQuery" },
    revisionAtDecision: 0,
    status: "accepted",
  };
  // 契约：缺省 delivery 仍能解码（旧 CLI → 新客户端）。
  assert.equal(commandAckSchema.parse(legacyAck).result?.delivery, undefined);
  assert.equal(
    resolveEditDelivery(legacyAck),
    null,
    "缺字段只能读成「无投递事实」，不许反推 startNow（假成功）也不许反推 queue（对旧 CLI 每次都弹提示）",
  );
  assert.equal(shouldCollapseEditState(legacyAck), true, "无投递事实沿用旧行为：收敛编辑态");
  // 枚举外的值同样只能读成「未知」：这是「只认显式三值」的边界，不是 `?? null` 的透传。
  assert.equal(
    resolveEditDelivery({
      ...legacyAck,
      result: { ...legacyAck.result, delivery: "later" },
    }),
    null,
    "未知投递值不得当成事实带进 UI 分流（宽容解码会让新字段悄悄改变行为）",
  );
  // 旧宿主可能根本没有 ACK（void / true）：同样不许抛、不许改变收敛行为。
  assert.equal(resolveEditDelivery(undefined), null);
  assert.equal(shouldCollapseEditState(undefined), true);
  assert.equal(shouldCollapseEditState(true), true);

  // 失败没有被拒结果：即便带 delivery 也没有投递事实。
  const rejectedWithDelivery = {
    ...legacyAck,
    result: {
      delivery: "queue",
      disposition: "rewind",
      sessionId: SESSION_ID,
      type: "editUserQuery",
    },
    status: "rejected",
  };
  assert.equal(
    resolveEditDelivery(rejectedWithDelivery),
    null,
    "只有 accepted/duplicate 才谈投递态",
  );

  // UI 分流的唯一判据：queue 不收敛，其余（含未知）收敛。
  const withDelivery = (delivery) => ({
    ...legacyAck,
    result: { ...legacyAck.result, ...(delivery ? { delivery } : {}) },
  });
  assert.equal(shouldCollapseEditState(withDelivery("queue")), false, "queued 必须留着编辑态");
  assert.equal(shouldCollapseEditState(withDelivery("guide")), true, "guide 已内联进当前轮 = 成功");
  assert.equal(shouldCollapseEditState(withDelivery("startNow")), true);
});

test("T-DA2 UI 接线：SessionPane 只对 queue 提示、ConversationRowView 用同一判据决定是否收敛", () => {
  const paneSource = stripComments(readFileSync(join(uiV4Src, "SessionPane.tsx"), "utf8"));
  assert.match(
    paneSource,
    /if \(resolveEditDelivery\(ack\) === "queue"\) \{\s*\n\s*toast\(intl\.formatMessage\(\{ id: "chat\.edit\.queued" \}\)/,
    "queued 必须给用户一条「已排队、未立即发送」的提示（否则只有日志里看得见）",
  );
  const rowSource = stripComments(readFileSync(join(uiV4Src, "ConversationRowView.tsx"), "utf8"));
  assert.match(
    rowSource,
    /if \(shouldCollapseEditState\(result\)\) setEditing\(false\);/,
    "收敛编辑态必须过 I5 判据，不得再无条件 setEditing(false)",
  );
  assert.doesNotMatch(
    rowSource,
    /if \(result !== false\) \{\s*\n\s*setEditing\(false\);/,
    "旧的无条件收敛形态必须消失（它正是「queued 表现为成功」的现场）",
  );
});

// ── P2-2：toggle 的「已切车道但没内联」必须可观测（不许只在 core 打 warn）──

test("T-DA3（cr-func P2-2）toggle ACK：只有「没内联且有原因」才提示", () => {
  const ack = (result) => ({
    commandId: "cmd-dlv",
    status: "accepted",
    revisionAtDecision: 0,
    ...(result ? { result } : {}),
  });
  const result = (patch) => ({
    type: "setQueueItemDelivery",
    sessionId: SESSION_ID,
    delivery: "guide",
    inlined: false,
    ...patch,
  });
  assert.equal(
    resolveQueueItemDeliveryDegradedReason(ack(result({ degradedReason: "ledger_not_pending" }))),
    "ledger_not_pending",
    "fail-closed 的降级必须冒泡到 UI 判据",
  );
  // 已内联 → 不提示。
  assert.equal(resolveQueueItemDeliveryDegradedReason(ack(result({ inlined: true }))), null);
  // 请求 queue：`inlined` 本就该是 false，但没有 degradedReason——不许当降级，
  // 否则每次「恢复排队」都会弹一条无意义提示。
  assert.equal(
    resolveQueueItemDeliveryDegradedReason(ack({ ...result({}), delivery: "queue" })),
    null,
    "回 queue 不是降级",
  );
  // 旧 CLI：没有结果 / 结果类型不是它 → 未知，不提示。
  assert.equal(resolveQueueItemDeliveryDegradedReason(ack(undefined)), null);
  assert.equal(
    resolveQueueItemDeliveryDegradedReason(
      ack({ type: "editUserQuery", disposition: "rewind", sessionId: SESSION_ID }),
    ),
    null,
    "不得把别人的结果读成 toggle 的投递事实",
  );
  // 拒绝/失败另有出口；duplicate 仍是投递事实。
  assert.equal(
    resolveQueueItemDeliveryDegradedReason({
      commandId: "cmd-dlv",
      status: "rejected",
      result: result({ degradedReason: "reserved" }),
    }),
    null,
  );
  assert.equal(resolveQueueItemDeliveryDegradedReason(null), null);
  assert.equal(
    resolveQueueItemDeliveryDegradedReason({
      commandId: "cmd-dlv",
      status: "duplicate",
      result: result({ degradedReason: "reserved" }),
    }),
    "reserved",
  );
  // 契约锁步：ACK 结果必须能按共享 schema 解码（UI 走同一入口）。
  assert.equal(
    commandAckSchema.parse(ack(result({ degradedReason: "ledger_read_failed" }))).result?.inlined,
    false,
  );
});

test("T-DA3 UI 接线：onDegraded 必须 toast 一行提示（只落 logger = 静默成功）", () => {
  const paneSource = stripComments(readFileSync(join(uiV4Src, "SessionPane.tsx"), "utf8"));
  assert.match(
    paneSource,
    /onDegraded: \(queueItemId, degradedReason\) => \{[\s\S]{0,500}?toast\(intl\.formatMessage\(\{ id: "chat\.queue\.guideDegraded" \}\)/,
    "降级必须有用户可见的一行提示",
  );
  // P2-5：handleRetry 的前置必须与 handleEdit 同形（缺投影既不发送也不提示是旧形态）。
  // 变异：删掉这段前置（回到 `if (!sessionId) return;`），本条即红。
  assert.match(
    paneSource,
    /retry 跳过：缺少当前 session 投影[\s\S]{0,600}?chat\.retry\.notReady/,
    "handleRetry 缺当前投影时必须给用户一行反馈",
  );
  assert.doesNotMatch(
    paneSource,
    /const handleRetry = useCallback\(\s*\(target: ConversationRowTarget\) => \{\s*\/\/[^\n]*\n\s*if \(!sessionId\) return;/,
    "旧的「只判 sessionId 就静默 return」形态必须消失",
  );
});

// ── P2-5：edit/retry 的投递态判定共用同一份信封规则 ─────────────────────────

test("T-DA4（cr-func P2-5）edit 与 retry 的投递态判据逐条同答", () => {
  const ackFor = (type, { delivery = "queue", status = "accepted", withResult = true } = {}) => ({
    commandId: `cmd-${type}`,
    status,
    ...(withResult
      ? {
          result: {
            type,
            sessionId: SESSION_ID,
            ...(delivery === undefined ? {} : { delivery }),
          },
        }
      : {}),
  });
  // ① typeof object 段：旧宿主可能回 false / void / true。
  for (const [label, outcome] of [
    ["void", undefined],
    ["false", false],
    ["true", true],
    ["null", null],
  ]) {
    assert.equal(resolveEditDelivery(outcome), null, `edit: ${label}`);
    assert.equal(resolveRetryDelivery(outcome), null, `retry: ${label}`);
  }
  // ② status 段：只有 accepted / duplicate 才谈投递态。
  for (const status of ["rejected", "stale", "noop", "failed"]) {
    assert.equal(resolveEditDelivery(ackFor("editUserQuery", { status })), null, `edit ${status}`);
    assert.equal(resolveRetryDelivery(ackFor("retryTurn", { status })), null, `retry ${status}`);
  }
  assert.equal(resolveEditDelivery(ackFor("editUserQuery", { status: "duplicate" })), "queue");
  assert.equal(resolveRetryDelivery(ackFor("retryTurn", { status: "duplicate" })), "queue");
  // ③ result.type 段：两条入口不得互读对方的结果。
  assert.equal(resolveEditDelivery(ackFor("retryTurn")), null, "edit 不得读 retryTurn 结果");
  assert.equal(resolveRetryDelivery(ackFor("editUserQuery")), null, "retry 不得读 editUserQuery 结果");
  assert.equal(
    resolveRetryDelivery(ackFor("retryTurn", { withResult: false })),
    null,
    "没有 result 就没有投递事实",
  );
  // 正向同规则：三值都只认显式值（`later` 等未知值一律 null）。
  assert.equal(resolveEditDelivery(ackFor("editUserQuery", { delivery: "startNow" })), "startNow");
  assert.equal(resolveRetryDelivery(ackFor("retryTurn", { delivery: "guide" })), "guide");
  assert.equal(resolveEditDelivery(ackFor("editUserQuery", { delivery: "later" })), null);
  assert.equal(resolveRetryDelivery(ackFor("retryTurn", { delivery: "later" })), null);
});

// ── P2-3：stop 的暂停判定与 deriveQueueAutoDrain 同口径（读不到 ≠ 空）──

test("T-RW9（cr-func P2-3）stop：队列长度读不到时按非空处理，仍拦下后续项", async () => {
  const cases = [
    { expectWrite: true, extra: {}, label: "getQueueLength 能力缺席（读不到）" },
    { expectWrite: true, extra: { getQueueLength: () => 3 }, label: "队列非空" },
    { expectWrite: false, extra: { getQueueLength: () => 0 }, label: "队列明确为空" },
  ];
  for (const { expectWrite, extra, label } of cases) {
    const writes = [];
    const record = {
      activeAbortController: { abort: () => undefined },
      app: {
        sessionId: "ses_stop_p23",
        runtime: {
          stopActiveForegroundExecution: () => ({
            foregroundExecutionId: "exec-stop-1",
            kind: "stopped",
          }),
        },
        readTarget: async () => null,
        setQueueAutoDrain: async (value) => {
          writes.push(value);
        },
      },
    };
    const host = {
      ...extra,
      getRecord: (sessionId) => (sessionId === "ses_stop_p23" ? record : undefined),
      logger: { info: () => undefined, warn: () => undefined },
    };
    await sessionFlowHandlers.stop(host, {
      commandId: "cmd-stop-p23",
      sessionId: "ses_stop_p23",
      type: "stop",
      payload: {},
    });
    // 变异探测：把判定改回 `(… ?? 0) > 0`，第一行（读不到 → 必须写 false）即红；
    // 那条 fail-open 会让存活项被 auto-drain 直接放行，与 stop 语义相反。
    assert.deepEqual(writes, expectWrite ? [false] : [], label);
  }
});

// ── P1-5：retryTurn 与 edit 同一条 rewind→start 事务（delivery / draft / 提交后失败）──
/** retry 的最小宿主：target 解析、rewind 两态、start 三态（started/queued/throws）。 */
function createRetryHarness({
  rewindCommittedFailure = false,
  rewindOutcome = "active_chain",
  startMode = "started",
} = {}) {
  const calls = { cancels: [], rewinds: [], sendInputs: [], sendOptions: [] };
  const state = { revert: null };
  const editTarget = {
    attachments: undefined,
    intent: {
      admittedDelivery: "startNow",
      clientId: "ui",
      kind: "sendText",
      queueItemId: "queue-original-retry",
      requestedDelivery: "startNow",
      sourceCommandId: "cmd-original-retry",
      text: "原始待重试的消息",
    },
    transcriptMessageId: "msg-original-retry",
  };
  const runtime = {
    getActiveForegroundExecutionId: () => undefined,
    getSessionModelSelection: () => undefined,
    rewindConversationToMessage: async (params) => {
      calls.rewinds.push(params);
      if (rewindCommittedFailure) {
        state.revert = params.targetMessageId;
        throw new ConversationRewindCommittedError({
          cause: new Error("post-commit step failed"),
          rewindId: "rewind-retry-committed",
          targetMessageId: params.targetMessageId,
        });
      }
      if (rewindOutcome !== "active_chain") return { strategy: rewindOutcome };
      state.revert = params.targetMessageId;
      return { strategy: "active_chain" };
    },
  };
  const record = {
    app: {
      getMode: () => "build",
      getModel: () => "openai/gpt-5",
      readTarget: async () => null,
      runtime,
      sendInput: async (input, options) => {
        calls.sendInputs.push(input);
        calls.sendOptions.push(options);
        if (startMode === "throws") {
          throw Object.assign(new Error("model target unavailable"), {
            reasonCode: "fault.command.modelUnavailable",
          });
        }
        if (startMode === "queued") {
          return { delivery: "queue", kind: "queued", pendingInputId: "p-retry", queueLength: 1 };
        }
        return { completion: Promise.resolve(), kind: "started_turn", turnId: "turn-retry" };
      },
      sessionId: SESSION_ID,
    },
    persistence: "immediate",
    traceContext: TRACE_CONTEXT,
  };
  const host = {
    afterLegacyStateMutation: async () => undefined,
    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      calls.cancels.push({ queueItemId, reason, sessionId });
    },
    ensureModelReady: async () => undefined,
    getInputRoutingMode: () => null,
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { info: () => undefined, warn: () => undefined },
    resolveRowActionTarget: () => ({
      editTarget,
      messageId: "msg-original-retry",
      ok: true,
      row: { entityId: "ent-original", rowId: 7, turnId: "turn-original" },
    }),
  };
  const envelope = {
    baseRevision: 0,
    clientId: "ui",
    commandId: "cmd-retry-rt",
    issuedAt: Date.now(),
    payload: { target: { entityId: "ent-original", rowId: 7 } },
    sessionId: SESSION_ID,
    type: "retryTurn",
  };
  return { calls, envelope, host, state };
}

test("T-RT6 retryTurn 起跑成功：ACK 带 delivery 三值（契约新增 retryTurn 结果分支）", async () => {
  const harness = createRetryHarness({ startMode: "started" });
  const result = await forkEditRetryHandlers.retryTurn(harness.host, harness.envelope);
  assert.equal(result?.type, "retryTurn");
  assert.equal(result?.sessionId, SESSION_ID);
  assert.equal(result?.delivery, "startNow");
  // 契约：结果必须能过 schema（否则客户端解码失败，投递态等于没上抛）。
  const parsed = commandResultSchema.parse({ ...result, sessionId: SESSION_ID });
  assert.equal(parsed.delivery, "startNow");
  // 重发的是原轮 canonical 文本，不是任何 payload 字段。
  assert.equal(harness.calls.sendInputs[0].text, "原始待重试的消息");
});

test("T-RT6 retryTurn queued：ACK 明确说没起跑 + queueItemId 点得中", async () => {
  const harness = createRetryHarness({ startMode: "queued" });
  const result = await forkEditRetryHandlers.retryTurn(harness.host, harness.envelope);
  assert.equal(result?.delivery, "queue", "queued 不得再是静默成功");
  assert.equal(result?.queueItemId, "queue_cmd-retry-rt", "与 admission 权威 id 同源");

  const ack = commandAckSchema.parse({
    commandId: harness.envelope.commandId,
    result,
    revisionAtDecision: 0,
    status: "accepted",
  });
  assert.equal(resolveRetryDelivery(ack), "queue", "UI 判据能读到 retry 的投递态");
});

test("T-RT6 retryTurn 截断已提交后失败：draftText 带回原消息 + 「历史已回退」", async () => {
  const harness = createRetryHarness({ startMode: "throws" });
  await assert.rejects(
    () => forkEditRetryHandlers.retryTurn(harness.host, harness.envelope),
    (error) => {
      assert.ok(error instanceof V4EditCommittedFailureError, "retry 必须有与 edit 同形的失败出口");
      assert.equal(error.draftText, "原始待重试的消息", "原消息必须回 composer（目标行已随截断消失）");
      assert.match(error.message, /历史已回退到目标轮/);
      return true;
    },
  );
  assert.equal(harness.calls.cancels.length, 1, "本次命令自持的账本行必须结算");
  assert.equal(harness.state.revert, "msg-original-retry", "截断保持（不回滚 revert）");
});

test("T-RT6 retryTurn 原语报「已提交」：同样走 draftText 出口（不靠局部布尔）", async () => {
  const harness = createRetryHarness({ rewindCommittedFailure: true });
  await assert.rejects(
    () => forkEditRetryHandlers.retryTurn(harness.host, harness.envelope),
    (error) => {
      assert.ok(error instanceof V4EditCommittedFailureError);
      assert.equal(error.draftText, "原始待重试的消息");
      assert.match(error.message, /历史已回退到目标轮/);
      return true;
    },
  );
  assert.equal(harness.calls.sendInputs.length, 0, "rewind 失败不得继续起轮");
});

test("T-RT6 retryTurn rewind 前失败（未提交）：原样上行，不产生草稿", async () => {
  const harness = createRetryHarness({ rewindOutcome: "unavailable" });
  await assert.rejects(
    () => forkEditRetryHandlers.retryTurn(harness.host, harness.envelope),
    (error) => {
      assert.equal(error instanceof V4EditCommittedFailureError, false, "未提交的失败不是 I4 的已提交失败");
      assert.equal(error.draftText, undefined);
      assert.equal(harness.state.revert, null, "什么都没提交");
      return true;
    },
  );
  assert.equal(harness.calls.cancels.length, 0, "未提交时没有账本行需要按已提交语义结算");
});

// ── T-RW6 删空队列复位 autoDrain（Step 5/6 同一条铁律的残留）─────────────────

function createDeleteQueueItemHarness({
  queueLengthAfterDelete = 0,
  removeResult = true,
  withQueueLength = true,
  // 删除前/后的暂停位（投影事实）。缺省 false = 用户正处于暂停（这是「删空复位」唯一有意义的场景）。
  autoDrainBefore,
}) {
  const calls = { autoDrain: [], mutations: [], removed: [] };
  const record = {
    app: {
      removeQueueItem: async (queueItemId) => {
        calls.removed.push(queueItemId);
        return removeResult;
      },
      sessionId: SESSION_ID,
      setQueueAutoDrain: async (autoDrain) => {
        calls.autoDrain.push(autoDrain);
      },
    },
    persistence: "immediate",
    traceContext: TRACE_CONTEXT,
  };
  const host = {
    afterLegacyStateMutation: async (_record, reason) => {
      calls.mutations.push(reason);
    },
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { warn: () => undefined },
    ...(withQueueLength ? { getQueueLength: () => queueLengthAfterDelete } : {}),
    ...(withQueueLength ? { getQueueAutoDrain: () => autoDrainBefore ?? false } : {}),
  };
  const envelope = {
    clientId: "ui",
    commandId: "cmd-del-rt",
    issuedAt: Date.now(),
    payload: { queueItemId: "queue_cmd-old" },
    sessionId: SESSION_ID,
    type: "deleteQueueItem",
  };
  return { calls, envelope, host };
}

test("T-RW6 删空队列必须复位 autoDrain（否则下一轮结束后的新入队项永远 held）", async () => {
  const harness = createDeleteQueueItemHarness({ queueLengthAfterDelete: 0 });
  await queueHandlers.deleteQueueItem(harness.host, harness.envelope);

  assert.deepEqual(harness.calls.removed, ["queue_cmd-old"]);
  assert.deepEqual(harness.calls.autoDrain, [true], "只在删空时取权威路径 setQueueAutoDrain(true)");
  assert.deepEqual(
    harness.calls.mutations,
    ["queue_auto_drain_resumed"],
    "必须走 afterLegacyStateMutation：idle 暂停队列没有 active turn 替它启动队首",
  );

  // 残留位的真实后果：下一轮结束后（completed + queue>0）新入队项被 auto-drain 永久 held。
  const gate = (autoDrain) =>
    shouldAutoDrainV4QueueHead({
      autoDrain,
      dispatchState: "queued",
      sessionBusy: false,
      targetStatus: null,
    });
  assert.equal(gate(false), false, "autoDrain=false 的残留位会让新项永远不被放行（用户没按暂停）");
  assert.equal(gate(true), true, "复位后同一闸门放行 = 修复语义");
});

test("T-RW6 删到还剩 ≥1 项时不许复位（存活项会被 auto-drain 抢跑）", async () => {
  const harness = createDeleteQueueItemHarness({ queueLengthAfterDelete: 1 });
  await queueHandlers.deleteQueueItem(harness.host, harness.envelope);

  assert.deepEqual(harness.calls.autoDrain, [], "队列非空时复位 = 让存活项抢跑");
  assert.deepEqual(harness.calls.mutations, [], "没有复位就没有 resumed 广播");
});

test("T-RW6 读不到队列长度时按非空处理（fail-safe：宁可不复位）", async () => {
  const noCounter = createDeleteQueueItemHarness({ withQueueLength: false });
  await queueHandlers.deleteQueueItem(noCounter.host, noCounter.envelope);
  assert.deepEqual(noCounter.calls.autoDrain, [], "无法证明「空」时不得无条件放行");

  // 反证：未命中的删除是 noop，同样不得复位（否则并发 drain 会把暂停位提前清掉）。
  const miss = createDeleteQueueItemHarness({ removeResult: false });
  await assert.rejects(
    () => queueHandlers.deleteQueueItem(miss.host, miss.envelope),
    (error) => {
      assert.equal(error.reasonCode, "queue.itemMissing");
      return true;
    },
  );
  assert.deepEqual(miss.calls.autoDrain, []);
  assert.deepEqual(miss.calls.mutations, []);
});

// ── I1 执行权威取账本（Step 3 收口 / Step 13 补例） ──────────────────────────

// ── P2：暂停位的唯一派生规则 ─────────────────────────────────────────────────

/** 空/非空/显式请求/读不到 四类输入的真值表；这是四处补丁收敛成的唯一规则。 */
test("T-RW7 deriveQueueAutoDrain：暂停 = 队列非空 && 显式请求，空队列一律归一化为放行", () => {
  const derive = deriveQueueAutoDrain;
  // 空队列：无论现值/显式请求，都归一化为放行（消灭「paused + 0 项」残留位）。
  assert.equal(derive({ current: false, queueLength: 0 }), true, "删空/抽干后必须复位");
  assert.equal(derive({ current: false, queueLength: 0, requested: false }), true);
  assert.equal(derive({ current: true, queueLength: 0 }), true);
  // 非空：显式请求优先（用户暂停/继续都算数）。
  assert.equal(derive({ current: true, queueLength: 2, requested: false }), false, "用户暂停");
  assert.equal(derive({ current: false, queueLength: 2, requested: true }), true, "用户继续");
  // 非空 + 无请求（结构事件）：保持现值，不越权改用户的暂停位。
  assert.equal(derive({ current: false, queueLength: 2 }), false);
  assert.equal(derive({ current: true, queueLength: 2 }), true);
  // 读不到长度：只认显式请求；没有请求就保持现值（无法证明「空」，不许放行）。
  assert.equal(derive({ current: false, queueLength: undefined }), false, "读不到 ≠ 空");
  assert.equal(derive({ current: true, queueLength: undefined }), true);
  assert.equal(derive({ current: false, queueLength: undefined, requested: true }), true);
});

test("T-RW7 删空复位是幂等的：已放行的会话不重复写同值事件", async () => {
  const harness = createDeleteQueueItemHarness({
    autoDrainBefore: true,
    queueLengthAfterDelete: 0,
  });
  await queueHandlers.deleteQueueItem(harness.host, harness.envelope);
  assert.deepEqual(harness.calls.autoDrain, [], "现值已是放行 → 不得再写一条同值 QueueAutoDrainChanged");
  assert.deepEqual(harness.calls.mutations, [], "没有翻转就没有 resumed 广播");
});

/** setAutoDrain handler 的最小宿主（暂停位/长度都是可控事实）。 */
function createSetAutoDrainHarness({ autoDrainBefore, queueLength }) {
  const calls = { autoDrain: [], mutations: [], warnings: [] };
  const record = {
    app: {
      sessionId: SESSION_ID,
      setQueueAutoDrain: async (autoDrain) => {
        calls.autoDrain.push(autoDrain);
      },
    },
    persistence: "immediate",
    traceContext: TRACE_CONTEXT,
  };
  const host = {
    afterLegacyStateMutation: async (_record, reason) => {
      calls.mutations.push(reason);
    },
    getQueueAutoDrain: () => autoDrainBefore,
    getQueueLength: () => queueLength,
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    logger: { warn: (message) => calls.warnings.push(message) },
  };
  const envelope = (autoDrain) => ({
    clientId: "ui",
    commandId: `cmd-auto-${String(autoDrain)}`,
    issuedAt: Date.now(),
    payload: { autoDrain },
    sessionId: SESSION_ID,
    type: "setAutoDrain",
  });
  return { calls, envelope, host };
}

test("T-RW7 setAutoDrain 也走同一派生规则：空队列的「暂停」不落库，非空才生效", async () => {
  const empty = createSetAutoDrainHarness({ autoDrainBefore: true, queueLength: 0 });
  await queueHandlers.setAutoDrain(empty.host, empty.envelope(false));
  assert.deepEqual(empty.calls.autoDrain, [], "空队列 pause 无承载对象 → 归一化后与现值相同，不写");

  const busy = createSetAutoDrainHarness({ autoDrainBefore: true, queueLength: 2 });
  await queueHandlers.setAutoDrain(busy.host, busy.envelope(false));
  assert.deepEqual(busy.calls.autoDrain, [false], "非空队列的显式暂停必须落库");
  assert.deepEqual(busy.calls.mutations, []);

  const resume = createSetAutoDrainHarness({ autoDrainBefore: false, queueLength: 2 });
  await queueHandlers.setAutoDrain(resume.host, resume.envelope(true));
  assert.deepEqual(resume.calls.autoDrain, [true]);
  assert.deepEqual(
    resume.calls.mutations,
    ["queue_auto_drain_resumed"],
    "放行必须触发 resumed 广播（idle 暂停队列没有 active turn 替它启动队首）",
  );
});

test("T-RW7 bridge 读不到队列长度时不得回落 0（P2-1：回落 0 与「按非空处理」相反）", () => {
  const bridgeSource = stripComments(
    readFileSync(join(bootstrapSrc, "zcode-protocol", "v4-bridge.ts"), "utf8"),
  );
  // 变异探测：把 `getQueueLength` 的 gateway 回落改回 `?? 0`，本条即红。
  assert.doesNotMatch(
    bridgeSource,
    /getQueueLength:\s*\(sessionId\)\s*=>[^\n]*\?\?\s*0/u,
    "gateway 缺席时不许把「读不到」伪造成 0：删项会据此无条件复位 autoDrain",
  );
  assert.match(
    bridgeSource,
    /getQueueLength:\s*\(sessionId\)\s*=>\s*context\.v4Gateway\?\.getQueueLength\(sessionId\)/u,
    "长度必须如实回 undefined，由 handler 的 fail-safe 决定",
  );
  // 成对的暂停位读法同样是「读不到就如实回 undefined」。
  assert.match(
    bridgeSource,
    /getQueueAutoDrain:\s*\(sessionId\)\s*=>\s*context\.v4Gateway\?\.getQueueAutoDrain\(sessionId\)/u,
  );
  // v4-gateway **自己**也必须如实回 undefined（cr-func P2-3）：gateway 在场而 publisher
  // 缺席时 `?? 0` / `?? true` 会绕过上面那道接线，同样伪造「空 + 已放行」。
  // 变异：把任一 `?? 0` / `?? true` 加回这两个方法体，本条即红。
  // 只看方法体（`hasResidencyBlockingCommands` 的 `?? 0` 是有意的，不能误判）。
  const gatewaySource = stripComments(
    readFileSync(join(bootstrapSrc, "zcode-protocol-v4", "v4-gateway.ts"), "utf8"),
  );
  const lengthBody =
    gatewaySource.match(/getQueueLength\([^)]*\): number \| undefined \{([\s\S]*?)\n  \}/u)?.[1] ??
    "";
  const autoDrainBody =
    gatewaySource.match(/getQueueAutoDrain\([^)]*\): boolean \| undefined \{([\s\S]*?)\n  \}/u)?.[1] ??
    "";
  assert.notEqual(lengthBody, "", "getQueueLength 必须声明 number | undefined（读不到 = undefined）");
  assert.notEqual(autoDrainBody, "", "getQueueAutoDrain 必须声明 boolean | undefined");
  assert.doesNotMatch(lengthBody, /\?\?\s*0/u, "gateway 不许把 publisher 缺席伪造成空队列");
  assert.doesNotMatch(autoDrainBody, /\?\?\s*true/u, "gateway 不许把 publisher 缺席伪造成「已放行」");
});

test("T-RW7 当前位读不到时：结构事件不动暂停位，显式请求照常落地", async () => {  // 结构事件（delete）没有「当前位」事实：不写，也不假称已复位。
  const harness = createDeleteQueueItemHarness({ queueLengthAfterDelete: 0 });
  harness.host.getQueueAutoDrain = undefined;
  await queueHandlers.deleteQueueItem(harness.host, harness.envelope);
  assert.deepEqual(harness.calls.autoDrain, [], "没有当前位事实 → 不写（fail-safe）");

  // 显式请求不依赖旧值（用户意图本身是完整事实）。
  const explicit = createSetAutoDrainHarness({ autoDrainBefore: undefined, queueLength: 2 });
  await queueHandlers.setAutoDrain(explicit.host, explicit.envelope(false));
  assert.deepEqual(explicit.calls.autoDrain, [false], "显式暂停不需要当前位也能落库");
});

/** 投影里旧值：任何执行用例都不允许把它发出去。 */
const STALE_PROJECTION_TEXT = "投影里的旧文本（不得被执行）";
/** 账本里的执行文本：唯一合法的执行内容。 */
const LEDGER_AUTHORITY_TEXT = "账本里的执行文本（唯一权威）";
const STALE_PROJECTION_ATTACH = {
  bytes: 21,
  fileName: "projection-stale.txt",
  mime: "text/plain",
  ref: "C:\\tmp\\projection-stale.txt",
};
const LEDGER_AUTHORITY_ATTACH = {
  bytes: 17,
  fileName: "ledger-authoritative.txt",
  mime: "text/plain",
  ref: "C:\\tmp\\ledger-authoritative.txt",
};

test("T-IA1 提升轮的执行文本与附件只来自账本：投影项被改成旧值时也不得被执行", async () => {
  const context = createContext();
  await seedQueuedInput(context, {
    id: OLD_ID,
    ledgerAttachments: [LEDGER_AUTHORITY_ATTACH],
    ledgerText: LEDGER_AUTHORITY_TEXT,
    projectionAttachments: [STALE_PROJECTION_ATTACH],
    projectionText: STALE_PROJECTION_TEXT,
    targetTurnId: TURN_KEPT,
    text: LEDGER_AUTHORITY_TEXT,
  });
  // 先确认夹具真的分叉了：投影项上躺着旧文本 + 旧附件（否则本用例测的是同一个值）。
  const head = queueState(context).items[0];
  assert.equal(head.text, STALE_PROJECTION_TEXT);
  assert.equal(head.attachments?.[0]?.ref, STALE_PROJECTION_ATTACH.ref);

  const harness = promotionHarness(context, head);
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);

  assert.equal(harness.calls.sendInput, 1, "账本 pending 必须正常起轮");
  assert.equal(harness.captured.input.text, LEDGER_AUTHORITY_TEXT, "执行内容只能来自账本");
  assert.equal(
    harness.captured.options.intent.text,
    LEDGER_AUTHORITY_TEXT,
    "落库 intent.text 必须等于账本文本（否则冷恢复把它带回 edit target，旧文本再次可执行）",
  );
  assert.equal(
    harness.captured.input.attachments?.[0]?.path,
    LEDGER_AUTHORITY_ATTACH.ref,
    "执行附件必须来自账本（投影附件被发出去 = F1 的半个不变量复活）",
  );
  assert.equal(
    harness.captured.options.intent.attachmentRefs?.[0]?.ref,
    LEDGER_AUTHORITY_ATTACH.ref,
    "落库 intent.attachmentRefs 必须来自账本（它是编辑重发继承附件的唯一来源）",
  );

  // 反向不得发生：账本进入终态后，同一项不得再被执行——哪怕投影项还好端端躺在队列里。
  context.ledger.rows.get(OLD_ID).status = "discarded";
  context.ledger.rows.get(OLD_ID).statusReason = "rewound";
  const staleHead = queueState(context).items[0];
  assert.ok(staleHead, "反向前提：投影项仍在（I1 的硬失败不依赖投影是否已移除）");
  const second = promotionHarness(context, staleHead);
  await assert.rejects(
    () => queueHandlers.sendQueuedNow(second.host, second.envelope),
    (error) => {
      assert.equal(error.reasonCode, "fault.command.inputNotPending");
      return true;
    },
    "账本终态必须硬失败，不得回落投影文本起轮",
  );
  assert.equal(second.calls.sendInput, 0, "终态账本行不得起轮");
});

// ── I1 补充：goal 车道（cr-func P1-4）与 legacy 无 intent（P1-3） ──────────────

test("T-IA5 goal 分支的 objective 与落库 intent.text 取账本，displayText 仍取投影", async () => {
  const context = createContext();
  const LEDGER_GOAL_TEXT = "/goal 账本里的目标";
  const PROJECTION_GOAL_TEXT = "/goal 投影里的旧目标";
  await seedQueuedInput(context, {
    id: OLD_ID,
    kind: "sendGoalCommand",
    ledgerText: LEDGER_GOAL_TEXT,
    projectionText: PROJECTION_GOAL_TEXT,
    targetTurnId: TURN_KEPT,
    text: LEDGER_GOAL_TEXT,
  });
  const head = queueState(context).items[0];
  assert.equal(head.kind, "sendGoalCommand", "夹具前提：队列项是 goal 车道");
  assert.equal(head.text, PROJECTION_GOAL_TEXT, "夹具前提：投影文本与账本真的不同");

  const harness = promotionHarness(context, head);
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);

  // 变异探测：把 objective 解析改回 queueItem.text，本条即红。
  assert.equal(
    harness.captured.goalTarget?.objective,
    "账本里的目标",
    "goal 的 objective 必须解析自账本（与普通分支同一条 I1 论证：不修 text 冷恢复会带回旧值）",
  );
  assert.equal(
    harness.captured.goalTarget?.intent?.text,
    "账本里的目标",
    "落库 intent.text 必须等于账本解析出的 canonical objective",
  );
  assert.equal(
    harness.captured.goalTarget?.displayText,
    PROJECTION_GOAL_TEXT,
    "displayText 是纯展示，仍是用户看到的投影原文（不得被账本改写）",
  );
  assert.equal(harness.calls.sendInput, 0, "goal 分支不走普通起轮");
});

test("T-IA6 legacy「无 intent」账本行（真 sqlite）：仍可提升，不再造永久死项", async (t) => {
  // 生产形状：`TurnSteerQueued` 在 intent 缺失时只写 `{ text }`（events.ts），而 intent
  // 今天仍可能缺失（legacy session/send 只在带 modelSelection 时建 intent）。这条行过去
  // 被读成 corrupt/attachments_unreadable → 永久不可提升、auto-drain 停在这一项。
  // 这里用**真 store**（不是 stub）验证读法与 handler 的联合行为。
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  t.after(() => store.close());
  await store.createSession({
    id: SESSION_ID,
    projectID: "proj-legacy-e2e",
    slug: "legacy-e2e",
    directory: "D:/tmp/legacy-e2e",
    title: "legacy e2e",
    version: "1.0.20",
  });
  const LEGACY_ID = "queue_legacy_no_intent";
  const LEGACY_TEXT = "legacy 排队的原文本";
  await store.saveSessionInput({
    id: LEGACY_ID,
    sessionID: SESSION_ID,
    kind: "sendText",
    delivery: "queue",
    payload: { text: LEGACY_TEXT },
  });

  const authority = await store.getSessionInputForExecution({
    id: LEGACY_ID,
    sessionID: SESSION_ID,
  });
  assert.equal(authority.state, "pending", "legacy 形状必须可执行（mutation：读侧改回一律 corrupt 即红）");
  assert.deepEqual(authority.attachments, [], "账本从未记录附件 → 唯一可读答案是无附件");

  // 投影同事实：TurnSteerQueued 不带 intent → 队列项 attachments 也是 []。
  const context = createContext();
  await emitFact(context, SessionEventType.TurnSteerQueued, {
    input: LEGACY_TEXT,
    inputPreview: LEGACY_TEXT,
    inputSize: LEGACY_TEXT.length,
    pendingInputId: LEGACY_ID,
    queueLength: 1,
    targetTurnId: TURN_KEPT,
  });
  const head = queueState(context).items[0];
  assert.equal(head.attachments?.length ?? 0, 0, "投影与账本一致：都没有附件事实");

  const harness = promotionHarness(context, head, {
    authority: (input) => store.getSessionInputForExecution(input),
  });
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);
  assert.equal(harness.calls.sendInput, 1, "legacy 行必须能提升（而不是硬失败留下死项）");
  assert.equal(harness.captured.input.text, LEGACY_TEXT, "执行文本仍只来自账本");
  assert.equal(harness.captured.options.intent.text, LEGACY_TEXT);
});

// ── I3 单一解析入口（Step 2 收口 / Step 13 补例） ────────────────────────────

test("T-IA3 同一条 edit 命令：admission 解析与执行侧实际提交逐字一致", async () => {
  const harness = createEditTransactionHarness();
  const attachment = {
    bytes: 12,
    fileName: "edit-attach.txt",
    mime: "text/plain",
    ref: "C:\\tmp\\edit-attach.txt",
  };
  const baseEnvelope = harness.makeEnvelope();
  const envelope = {
    ...baseEnvelope,
    payload: { ...baseEnvelope.payload, attachments: [attachment] },
  };

  // admission 侧（v4-bridge.resolveInputCommandForAdmission 的等价调用）：只有继承源，
  // 没有模型选择事实——文本/附件/投递都必须已经由同一个函数定稿。
  const admissionSide = resolveCanonicalInput(harness.editTargetIntent, envelope.payload, envelope);
  assert.ok(admissionSide, "edit 命令必然解析出 canonical input");
  assert.equal(
    admissionSide.text,
    EDIT_NEW_TEXT,
    "edit 的权威文本是本次 payload 的 newText，不是被编辑轮的旧文本",
  );

  await forkEditRetryHandlers.editUserQuery(harness.host, envelope);

  const sentInput = harness.calls.sendInputs[0];
  const sentOptions = harness.calls.sendOptions[0];
  assert.equal(sentInput.text, admissionSide.text, "执行侧文本必须与 admission 解析逐字相同");
  assert.notEqual(sentInput.text, harness.editTargetIntent.text, "被编辑轮的旧文本不得被执行");
  assert.equal(sentOptions.intent.text, admissionSide.intent.text, "intent.text 同源同值");
  assert.deepEqual(
    sentOptions.intent.attachmentRefs,
    [...admissionSide.attachments],
    "执行侧附件必须是同一份 canonical 事实（不是投影/原轮的）",
  );
  assert.deepEqual(
    [sentInput.attachments?.[0]?.path],
    [attachment.ref],
    "附件真的随本轮提交（不是只在 intent 里留个引用）",
  );
  // 投递事实同源：schema 三值枚举里属于「立刻起跑」的那一个。
  assert.equal(
    sentOptions.intent.requestedDelivery,
    admissionSide.delivery.requested ?? "startNow",
  );
  assert.equal(sentOptions.intent.admittedDelivery, admissionSide.delivery.admitted ?? "startNow");
});
