#!/usr/bin/env node
/**
 * fix-c17 —— **持久读取失败的回落**（升级不能把投影打空、也不能让 live 停摆）
 *
 * ============================================================================
 * 这一步修的是什么（一条真实读失败的后果链）
 * ============================================================================
 *
 *   `v4-gateway.ts` 的 `performHydration` 过去把「读失败」和「读到空」压成同一个结果
 *   （`{ events: [], synthesized: false, sourceEventSeq: 0 }`）。于是**一次**抛错就同时
 *   造成两件事：
 *
 *     ① `events: []` 流进 `publisher.rehydrate` → 用户眼前的历史**整段消失**。
 *        升级路径最狠：升级前的降级投影本来是可用（只是不全）的，被换掉是纯损失。
 *     ② `sourceEventSeq: 0` 把 raw 游标打回起点，而 live raw 序号已经在几百上千——
 *        之后每个 live 事件都卡在「等 seq=1」的 raw gap 上，投影永远停在空/残状态，
 *        直到用户重开会话。全程没有任何报错。
 *
 *   现在的口径：读失败 → **不 swap**、**不动游标**，并留一条可检索的失败；
 *   自愈交给「不登记 `hydratedSessions`」这条既有路径（下一次读/翻页退回冷路径重读）。
 *
 * ============================================================================
 * 为什么单独一个文件（不改既有回归网的口径）
 * ============================================================================
 *
 *   `test:cold-open-window`（9）与 `test:view-runtime-split`（43）是 Step 13 建的口径基准，
 *   risk16 / K2 的断言不许动。本文件的夹具是**最轻的一层**：真 `ConversationV4Gateway` +
 *   真投影，宿主胶水是桩（与 `test-view-runtime-split` 的 `gatewayFixture` 同形，多记
 *   出站帧与 onError 的 context），因此只承载「失败回落」这一条主线。
 *
 * 运行：`npx tsx --test scripts/test-hydrate-load-failure.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { ConversationV4Gateway } = await import(
  new URL("../src/zcode-protocol-v4/v4-gateway.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — fix-c17 hydrate load failure (keep projection + keep raw cursor)"
      : `TEST FAIL — fix-c17 hydrate load failure (exit code ${code})`,
  );
});

const SESSION_ID = "ses_hydrate_load_failure";

/** 与生产同形的事件壳（sequenceNumber 是 runtime raw seq）。 */
function sessionEvent(type, sequenceNumber, payload, turnId) {
  return {
    id: `evt-${sequenceNumber}`,
    sessionId: SESSION_ID,
    ...(turnId === undefined ? {} : { turnId }),
    type,
    timestamp: new Date(1_700_000_000_000 + sequenceNumber),
    traceId: `trace-${sequenceNumber}`,
    sequenceNumber,
    payload,
  };
}

/** 一轮完整成功轮（与生产同序；turnId 必须是 `turn-<n>`）。每轮产生 user + assistant 两行。 */
function completedTurn({ turnNumber, seq }) {
  const turnId = `turn-${turnNumber}`;
  return [
    sessionEvent("turn_started", seq, {
      turnNumber,
      input: `问 ${turnNumber}`,
      messageId: `msg-user-${turnNumber}`,
    }),
    sessionEvent(
      "model_streaming",
      seq + 1,
      {
        kind: "text_start",
        assistantMessageId: `msg-a-${turnNumber}`,
        partId: `part-${seq}`,
        delta: "",
        done: false,
      },
      turnId,
    ),
    sessionEvent(
      "model_streaming",
      seq + 2,
      { kind: "text_delta", delta: "答", done: false },
      turnId,
    ),
    sessionEvent(
      "turn_complete",
      seq + 3,
      { response: "答", tokenCount: 4, toolCallCount: 0, duration: 100, resultType: "success" },
      turnId,
    ),
  ];
}

/**
 * 宿主胶水（与 `test-view-runtime-split` 的 `gatewayFixture({shellPort:true})` 同形）：
 * 外壳只建 record（runtime 没起），激活走 resume。`loadPersistedEvents` 由各用例接管。
 */
function gatewayFixture() {
  const calls = { errors: [], load: 0, logs: [], resume: 0, shell: 0, wires: [] };
  let live = false;
  let runtimeActive = null;
  const host = {
    sessionExists: () => live,
    isSessionRuntimeActive: () => (runtimeActive === null ? live : runtimeActive),
    emitWireFrame: (wire) => calls.wires.push(wire),
    executeCommand: async () => undefined,
    materializeSessionShell: async () => {
      calls.shell += 1;
      live = true;
      runtimeActive = false;
      return { status: "materialized" };
    },
    resumePersistedSession: async () => {
      calls.resume += 1;
      live = true;
      runtimeActive = true;
      return { status: "resumed", persistedMessages: [] };
    },
    loadPersistedEvents: async () => ({
      events: [],
      synthesized: false,
      sourceEventSeq: 0,
    }),
    // context 是失败回落的结论载体（sessionId / keptProjection / keptRows / rawSourceEventSeq）。
    onError: (scope, error, context) =>
      calls.errors.push({
        context: context ?? {},
        message: String(error?.message ?? error),
        scope,
      }),
    onDebug: (line) => calls.logs.push(line),
  };
  return { calls, host };
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function subscribe(gateway, connectionId) {
  return gateway.subscribe({
    topic: `conversation/${SESSION_ID}`,
    connectionId,
    clientMode: "desktop-continuous",
  });
}

function totalCountOf(dispatch) {
  return dispatch.initialFrame.payload.snapshot.rows.totalCount;
}

/**
 * 首屏夹具：两轮正文（`sourceEventSeq` 报到 8）+ view-only 降级口径 → 记「欠一次升级」。
 * 之后的每次读都抛错（持久故障），用于证明「下一次水化会重试」而不是把空投影钉住。
 */
function failAfterFirstScreen(calls) {
  const firstScreen = [
    ...completedTurn({ turnNumber: 1, seq: 1 }),
    ...completedTurn({ turnNumber: 2, seq: 5 }),
  ];
  return async (_sessionId, _messages, loadOptions) => {
    calls.load += 1;
    if (calls.load === 1) {
      return {
        branchGeneration: 0,
        events: firstScreen,
        sourceEventSeq: 8,
        synthesized: true,
        viewOnlyHydration: true,
      };
    }
    throw new Error(
      `store offline (read #${calls.load}${loadOptions?.fullMaterialization ? ", full" : ""})`,
    );
  };
}

test("F1: 升级的全量读抛错——不 swap 投影、不丢行、下一次水化重试", async () => {
  const { host, calls } = gatewayFixture();
  host.loadPersistedEvents = failAfterFirstScreen(calls);
  const gateway = new ConversationV4Gateway(host);
  try {
    const first = await subscribe(gateway, "conn-f1a");
    assert.equal(
      totalCountOf(first),
      6,
      "夹具：首屏两轮 = 6 行（每轮 turnHeader/userInput/assistantText）",
    );

    // ACK 之后的后台预激活 → 激活成功排一次全量升级；升级的读抛错。
    await waitFor(() => calls.load >= 2, "激活成功后必须尝试一次全量升级");
    await waitFor(
      () => calls.logs.some((line) => line.includes("v4 projection upgrade skipped")),
      "升级路径必须收口（失败也不能挂着）",
    );

    const failure = calls.errors.find((entry) => entry.scope === "v4.hydrate.loadFailed");
    assert.ok(failure, "读失败必须留一条可检索的失败（scope=v4.hydrate.loadFailed）");
    assert.equal(failure.context.sessionId, SESSION_ID, "失败日志必须带 sessionId");
    assert.match(failure.message, /store offline/, "失败日志必须带原因");
    assert.equal(failure.context.keptProjection, true, "有旧投影时必须明说「保住了」");
    assert.equal(failure.context.keptRows, 6, "日志里的保留行数 = 失败前的可见行数");
    assert.equal(failure.context.forceRebuild, true, "升级是 forceRebuild");
    assert.equal(failure.context.fullMaterialization, true, "升级是全量读口径");
    assert.equal(failure.context.rawSourceEventSeq, 8, "raw 游标必须原样保留（归零 = gap 死锁）");
    assert.equal(failure.context.phase, "loadPersistedEvents", "失败日志必须带阶段");

    // 失败不能被写成一次「很快的升级」：Step 14 的量化只读这条 debug 行。
    assert.ok(
      !calls.logs.some((line) => line.includes("v4 projection upgrade applied")),
      "读失败的升级不得声称 applied",
    );

    // 自愈：不登记 hydratedSessions → 下一次读/订阅退回冷路径重读一次（再失败也不丢行）。
    const second = await subscribe(gateway, "conn-f1b");
    assert.equal(totalCountOf(second), 6, "一次升级读失败绝不能让可见行数变少");
    assert.ok(calls.load >= 3, `读失败之后的下一次水化必须重试，实际 load=${calls.load}`);
    // ACK 的分段：失败的读也要留下 mergeMs（本次水化确实跑了 load 段），但**不得**写
    // rehydrateMs——没有发生重建，写 0 会被读成「一次极快的重建」。
    assert.equal(
      typeof second.ack.openPhases.mergeMs,
      "number",
      "失败的读必须留下 mergeMs（read 段真的跑了）",
    );
    assert.ok(
      !("rehydrateMs" in second.ack.openPhases),
      "读失败没有 rehydrate，openPhases 里不得出现 rehydrateMs",
    );
  } finally {
    gateway.dispose();
  }
});

test("F2: 升级读失败不回退 raw 游标——之后的 live 事件必须继续前进", async () => {
  const { host, calls } = gatewayFixture();
  host.loadPersistedEvents = failAfterFirstScreen(calls);
  const gateway = new ConversationV4Gateway(host);
  try {
    const first = await subscribe(gateway, "conn-f2a");
    assert.equal(totalCountOf(first), 6, "夹具：首屏两轮 = 6 行");
    await waitFor(
      () => calls.logs.some((line) => line.includes("v4 projection upgrade skipped")),
      "升级读失败必须收口",
    );

    // 上一轮收口在 raw 8；这一轮从 9 连续续上（生产里就是 runtime 的下一个事件）。
    for (const event of completedTurn({ turnNumber: 3, seq: 9 })) {
      gateway.ingest(SESSION_ID, event);
    }

    // 客户端视角：流式增量必须真的下发（游标被归零时这些事件会卡在「等 seq=1」的 gap 上）。
    await waitFor(
      () =>
        calls.wires.some((wire) => {
          const payload = wire?.frame?.payload;
          if (payload?.kind !== "deltas") return false;
          return (payload.deltas ?? []).some(
            (delta) =>
              delta.op === "row.upserted" &&
              typeof delta.row?.rowId === "number" &&
              delta.row.rowId > 6,
          );
        }),
      "升级读失败之后 live 事件仍必须推进投影并下发增量",
    );

    // 投影侧的同一事实：下一次失败的回落日志里 keptRows 必须已经包含这一轮。
    const before = calls.errors.filter((entry) => entry.scope === "v4.hydrate.loadFailed").length;
    await subscribe(gateway, "conn-f2b");
    await waitFor(
      () => calls.errors.filter((entry) => entry.scope === "v4.hydrate.loadFailed").length > before,
      "重订必须再尝试一次读（并再次失败）",
    );
    const latest = calls.errors.filter((entry) => entry.scope === "v4.hydrate.loadFailed").at(-1);
    assert.equal(latest.context.keptRows, 9, "live 那一轮必须落在被保留的投影里（6 + 3 行）");
  } finally {
    gateway.dispose();
  }
});

test("F3: 首屏读失败且没有旧投影——给可用空投影、日志标明无可保留，随后的 live 行不得再被清掉", async () => {
  const { host, calls } = gatewayFixture();
  const liveTurn = completedTurn({ turnNumber: 1, seq: 1 });
  host.loadPersistedEvents = async () => {
    calls.load += 1;
    throw new Error(`cold read failed (read #${calls.load})`);
  };
  const gateway = new ConversationV4Gateway(host);
  try {
    const first = await subscribe(gateway, "conn-f3a");
    assert.equal(totalCountOf(first), 0, "真冷 + 读失败：空投影是唯一诚实的结果");
    const failure = calls.errors.find((entry) => entry.scope === "v4.hydrate.loadFailed");
    assert.ok(failure, "真冷的读失败同样必须留痕");
    assert.equal(
      failure.context.keptProjection,
      false,
      "没有旧投影时必须写明 keptProjection=false",
    );
    assert.equal(failure.context.forceRebuild, false, "首屏不是升级");

    // 空投影仍必须可被 live 事件喂养（失败回落不得把会话变成死路）。
    for (const event of liveTurn) gateway.ingest(SESSION_ID, event);
    await waitFor(
      () =>
        calls.wires.some((wire) => {
          const payload = wire?.frame?.payload;
          if (payload?.kind !== "deltas") return false;
          return (payload.deltas ?? []).some(
            (delta) => delta.op === "row.upserted" && typeof delta.row?.rowId === "number",
          );
        }),
      "真冷失败后的空投影必须能被 live 事件填充",
    );

    // 第二次读也失败：这一轮 live 行**不得**被清掉（修复前这里会回到 0 行）。
    const second = await subscribe(gateway, "conn-f3b");
    assert.equal(
      totalCountOf(second),
      3,
      "一次读失败不能让 live 行消失（turnHeader + user + assistant）",
    );
  } finally {
    gateway.dispose();
  }
});

test("F4: 真冷「成功读到空」不得走失败分支（不得多读一次 / 不得记失败）", async () => {
  const { host, calls } = gatewayFixture();
  host.loadPersistedEvents = async () => {
    calls.load += 1;
    // 权威的空：确实没有任何持久事实。它与「读失败」同形，但语义相反。
    return { events: [], synthesized: false, sourceEventSeq: 0 };
  };
  const gateway = new ConversationV4Gateway(host);
  try {
    const first = await subscribe(gateway, "conn-f4a");
    assert.equal(totalCountOf(first), 0, "空会话就是 0 行");
    // 成功后水位在册：重订必须是纯早退（不重读），失败分支若误判会在这里重读。
    const second = await subscribe(gateway, "conn-f4b");
    assert.equal(totalCountOf(second), 0, "空会话重订仍是 0 行");
    assert.equal(calls.load, 1, "成功读到空 = 已水化，重订不得再读（误判成失败会重读）");
    assert.equal(
      calls.errors.filter((entry) => entry.scope === "v4.hydrate.loadFailed").length,
      0,
      "成功读到空不得记成读失败",
    );
  } finally {
    gateway.dispose();
  }
});
