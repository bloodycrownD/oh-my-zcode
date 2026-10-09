#!/usr/bin/env node
/**
 * Step 8/9 / T-E2 —— 缺陷①「编辑重发仍是旧消息」文本侧的 e2e 复现与常驻回归。
 *
 * ============================================================================
 * 这一步要锁死的失效形态（候选 b：running-turn 抢占缺口）
 * ============================================================================
 *
 * 用户报障：编辑旧消息重发后，旧 turn 照跑、编辑后的文本没有即时生效。
 *
 * 两个候选里 (b) 的机制：`editUserQuery` 的抢占**只看 Bootstrap 外层锁**：
 *
 *   fork-edit-retry.ts:144  `if (record.activeAbortController) { preemptActiveTurnAndWait(...) }`
 *
 * 而 bootstrap `activeAbortController` 只由 legacy `session/send`
 * （server-operations.ts:1951）与 goal 续跑（goal.ts:264）创建；
 * v4 `sendText` 起的 turn 与后台通知的 model-only turn 都不创建它——
 * 这类 turn 的 foreground authority 由 Core runtime command 独立持有
 * （runtime-command-queue.ts:421 `activeForegroundExecution`）。
 *
 * 于是编辑重发时：rewind 截断照做，但旧 turn 未被抢占，紧接的
 * `startPromptTurn` 撞上 Core busy admission（prompt-admission.ts:34-83：
 * busy + delivery=start_turn + 非 guide → `enqueueDeferredInput(delivery:"queue")`），
 * 新文本被退回 queue，`v4 prompt admitted` 不出现——用户看到「发的还是旧消息」。
 *
 * `session-flow.ts` 的 `waitForSessionIdle`（:403-414）判据本来就把
 * `runtime.getActiveForegroundExecutionId() !== undefined` 算进活跃，
 * 但抢占入口的判据没有对齐，这是 1e 的修复点。
 *
 * 本文件用**真实 handler**（`forkEditRetryHandlers.editUserQuery`）驱动一个
 * 仿真 Core admission 的最小宿主：
 *   - model-only turn：Core 持有 foreground execution、Bootstrap 无 controller；
 *   - legacy turn：Bootstrap controller 与 Core execution 同时在位（既有行为）；
 *   - idle：无任何活跃 turn（不得误抢占）。
 * `sendInput` 桩复刻 prompt-admission.ts 的 busy 门：仍有 foreground execution
 * 时返回 queued，空闲时才 started_turn。
 *
 * 运行方式：`npx tsx --test scripts/test-edit-retry.mjs`（与
 * test-edit-retry-model / test-turn-directory 同源：tsx 直接吃 src，
 * @zcode/contracts/@zcode/shared 分别走 dist 与 src exports）。
 */

import assert from "node:assert/strict";
import test from "node:test";

// fork-edit-retry ⇄ input-intent ⇄ executor ⇄ handlers/index 之间存在循环依赖；
// 与 test-edit-retry-model.mjs 相同：先以 executor 为入口初始化，再取 handler 导出。
await import(new URL("../src/zcode-protocol-v4/commands/executor.ts", import.meta.url).href);
const { forkEditRetryHandlers } = await import(
  new URL("../src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts", import.meta.url).href
);
const { hasActiveTurn } = await import(
  new URL("../src/zcode-protocol-v4/commands/handlers/session-flow.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 8/9 edit-resend running-turn preemption (T-E2)"
      : `TEST FAIL — Step 8/9 edit-resend running-turn preemption (exit code ${code})`,
  );
});

const SESSION_ID = "ses_te2";
const EPOCH = "epoch-te2";
/** 被编辑轮遗留的旧模型快照（edit 缺省 modelSelection 时沿用，不 pin）。 */
const SNAPSHOT_SELECTION = Object.freeze({
  providerId: "openai",
  modelId: "gpt-5",
  options: Object.freeze({ reasoningLevel: "medium" }),
});

/**
 * 构造一个可驱动的 v4 命令宿主/record。
 *
 * `activeTurnKind`:
 *   - "model-only"：Core 持有 foreground execution，Bootstrap 无 controller
 *     （v4 sendText 起的 turn / 后台通知 turn 的真实形态）；
 *   - "legacy"：Bootstrap controller 与 Core execution 同时在位（旧发送端）；
 *   - "idle"：无活跃 turn。
 */
function createEditHarness({ activeTurnKind }) {
  const calls = {
    admittedLogs: [],
    bootstrapController: undefined,
    rewinds: [],
    sendInputs: [],
    stopForegroundResults: [],
    stopForegroundOptions: [],
  };
  const state = {
    activeForegroundExecutionId:
      activeTurnKind === "idle" ? undefined : `exec-${activeTurnKind}-1`,
  };
  const runtime = {
    getActiveForegroundExecutionId: () => state.activeForegroundExecutionId,
    stopActiveForegroundExecution: (options) => {
      calls.stopForegroundOptions.push(options);
      if (state.activeForegroundExecutionId === undefined) {
        const result = { kind: "idle" };
        calls.stopForegroundResults.push(result);
        return result;
      }
      // 真实实现（runtime-command-queue.ts:446-472）abort 掉活跃 command，
      // authority 由 command 的 finally 释放；这里同步释放，等价于「抢占最终生效」。
      const foregroundExecutionId = state.activeForegroundExecutionId;
      state.activeForegroundExecutionId = undefined;
      // legacy 后台 turn 的 abortSignal 与 runtime command 相连，abort 传播到
      // background turn 的 finally 后释放 Bootstrap 外层锁
      // （server-operations.ts:2329-2334）。
      calls.bootstrapController?.abort(
        new Error("v4 editUserQuery preempts active turn"),
      );
      record.activeAbortController = undefined;
      const result = { foregroundExecutionId, kind: "stopped" };
      calls.stopForegroundResults.push(result);
      return result;
    },
    getSessionModelSelection: () => SNAPSHOT_SELECTION,
    rewindConversationToMessage: async (params) => {
      calls.rewinds.push(params);
      return { strategy: "active_chain" };
    },
    releaseForegroundPromotionLease: () => undefined,
  };
  const record = {
    app: {
      sessionId: SESSION_ID,
      getModel: () => "openai/gpt-5",
      runtime,
      readTarget: async () => null,
      updateTargetStatus: async () => null,
      sendInput: async (input, options) => {
        // 复刻 Core admission 的 busy 门（prompt-admission.ts:34-83）：
        // 仍有活跃 foreground execution 时，start_turn 且非 guide 的请求会被
        // enqueueDeferredInput(delivery:"queue") 退回队列，而不是启动新 turn。
        const busy = runtime.getActiveForegroundExecutionId() !== undefined;
        calls.sendInputs.push({
          admissionKind: busy ? "queued" : "started_turn",
          busyAtAdmission: busy ? runtime.getActiveForegroundExecutionId() : undefined,
          input,
          options,
        });
        if (busy) {
          return { delivery: "queue", kind: "queued" };
        }
        return {
          completion: Promise.resolve(),
          kind: "started_turn",
          turnId: "turn-edited",
        };
      },
    },
    traceContext: { traceId: "trace-te2", sessionId: SESSION_ID },
    persistence: "immediate",
  };
  if (activeTurnKind === "legacy") {
    const controller = new AbortController();
    record.activeAbortController = controller;
    calls.bootstrapController = controller;
  }
  const host = {
    getRecord: (sessionId) => (sessionId === SESSION_ID ? record : undefined),
    getInputRoutingMode: () => null,
    logger: {
      info: (message, fields) => {
        if (message === "v4 prompt admitted") {
          calls.admittedLogs.push(fields);
        }
      },
      warn: () => {},
    },
    resolveRowActionTarget: () => ({
      editTarget: {
        entityId: "ent-4",
        intent: {
          admittedDelivery: "startNow",
          clientId: "ui",
          kind: "sendText",
          modelSelection: SNAPSHOT_SELECTION,
          queueItemId: "queue-original",
          requestedDelivery: "startNow",
          sourceCommandId: "cmd-original",
          text: "original text",
        },
        productTurnId: "turn-1",
        transcriptMessageId: "msg-4",
      },
      messageId: "msg-4",
      ok: true,
      row: {
        entityId: "ent-4",
        kind: "userInput",
        productTurnId: "turn-1",
        rowId: 4,
        turnId: "turn-1",
        visibility: "visible",
      },
    }),
    afterLegacyStateMutation: async () => {},
  };
  const envelope = {
    clientId: "ui",
    commandId: "cmd-edit-te2",
    baseLogEpoch: EPOCH,
    baseRevision: 3,
    issuedAt: new Date(1_700_000_000_000),
    payload: {
      newText: "edited text (preempts old turn)",
      target: { entityId: "ent-4", rowId: 4 },
    },
    sessionId: SESSION_ID,
    type: "editUserQuery",
  };
  return { calls, envelope, host, record, runtime, state };
}

/** 等待 preemptActiveTurnAndWait 的 idle 轮询收敛（25ms 间隔、5s 超时）。 */
async function settleIdlePoll() {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

test("E1: model-only 活跃 turn（Core 持 foreground、Bootstrap 无 controller）→ 编辑重发必须抢占旧 turn 后准入", async () => {
  const { calls, envelope, host, runtime, state } = createEditHarness({
    activeTurnKind: "model-only",
  });
  const result = await forkEditRetryHandlers.editUserQuery(host, envelope);
  await settleIdlePoll();

  // 旧 turn 必须被抢占：Core foreground execution 被请求停止并真正释放。
  assert.equal(
    runtime.getActiveForegroundExecutionId(),
    undefined,
    "抢占后 Core foreground authority 必须已释放",
  );
  assert.deepEqual(
    calls.stopForegroundOptions,
    [{ preserveQueueAutoDrainOnCancel: false, reason: "v4 editUserQuery preempts active turn" }],
    "editUserQuery 必须请求停止 Core 活跃前台执行",
  );
  assert.deepEqual(
    calls.stopForegroundResults,
    [{ foregroundExecutionId: "exec-model-only-1", kind: "stopped" }],
    "model-only turn 的抢占必须真实生效（kind=stopped）",
  );
  assert.equal(
    state.activeForegroundExecutionId,
    undefined,
    "抢占必须在 admission 之前完成（waitForSessionIdle 语义）",
  );

  // admission 必须落在空闲位：不能再被 Core busy admission 退回 queue。
  assert.equal(calls.sendInputs.length, 1, "编辑重发只提交一次输入");
  assert.equal(
    calls.sendInputs[0].admissionKind,
    "started_turn",
    "旧 turn 未抢占时新文本会被 Core busy admission 退回 queue（delivery=queue）",
  );
  assert.equal(
    calls.sendInputs[0].busyAtAdmission,
    undefined,
    "admission 时旧 turn 必须已被抢占",
  );
  assert.equal(calls.admittedLogs.length, 1, "抢占生效时 v4 prompt admitted 必须出现");

  // rewind 与提交内容照旧：截断被编辑轮、重发编辑后的新文本。
  assert.equal(calls.rewinds.length, 1, "editUserQuery 必须提交一次 rewind");
  assert.equal(calls.rewinds[0].targetMessageId, "msg-4");
  assert.equal(calls.sendInputs[0].input.text, "edited text (preempts old turn)");
  assert.equal(result?.type, "editUserQuery");
  assert.equal(result?.disposition, "rewind");
});

test("E2: legacy 活跃 turn（Bootstrap controller + Core execution）→ 抢占行为不回退", async () => {
  const { calls, envelope, host } = createEditHarness({ activeTurnKind: "legacy" });
  const result = await forkEditRetryHandlers.editUserQuery(host, envelope);
  await settleIdlePoll();

  assert.equal(
    calls.bootstrapController?.signal.aborted,
    true,
    "legacy turn 必须同时被 Bootstrap controller abort",
  );
  assert.deepEqual(
    calls.stopForegroundResults,
    [{ foregroundExecutionId: "exec-legacy-1", kind: "stopped" }],
    "legacy turn 也必须请求并生效 Core 抢占",
  );
  assert.equal(calls.sendInputs[0].admissionKind, "started_turn", "admission 必须落在空闲位");
  assert.equal(calls.admittedLogs.length, 1, "v4 prompt admitted 必须出现");
  assert.equal(result?.disposition, "rewind");
});

test("E3: 空闲会话 → 不进入抢占路径，admission 正常启动", async () => {
  const { calls, envelope, host, record } = createEditHarness({ activeTurnKind: "idle" });
  const result = await forkEditRetryHandlers.editUserQuery(host, envelope);
  await settleIdlePoll();

  assert.equal(record.activeAbortController, undefined, "空闲会话不存在 Bootstrap controller");
  assert.deepEqual(
    calls.stopForegroundOptions,
    [],
    "空闲会话不得发起抢占（hasActiveTurn 为假时整条 preempt 路径都不该进）",
  );
  assert.deepEqual(
    calls.stopForegroundResults,
    [],
    "空闲会话不得请求停止 Core 前台执行",
  );
  assert.equal(
    calls.bootstrapController,
    undefined,
    "空闲会话不得 abort 任何 controller",
  );
  assert.equal(calls.sendInputs.length, 1);
  assert.equal(calls.sendInputs[0].admissionKind, "started_turn");
  assert.equal(calls.admittedLogs.length, 1);
  assert.equal(result?.disposition, "rewind");
});

test("E4: 抢占判据与 waitForSessionIdle 对齐（Core foreground 单独成立）", () => {
  const modelOnly = createEditHarness({ activeTurnKind: "model-only" });
  const legacy = createEditHarness({ activeTurnKind: "legacy" });
  const idle = createEditHarness({ activeTurnKind: "idle" });

  // 只有 Core 持有 foreground authority、Bootstrap 无 controller —— 也必须判活跃。
  assert.equal(hasActiveTurn(modelOnly.record), true, "model-only turn 必须判为活跃");
  assert.equal(hasActiveTurn(legacy.record), true, "Bootstrap controller turn 必须判为活跃");
  assert.equal(hasActiveTurn(idle.record), false, "两处 authority 都没有时必须判空闲");
});
