#!/usr/bin/env node
/**
 * Step 8 / phase-view-runtime-split —— 双水位 + 激活触发点 + 三态（IS3 / IS4）
 *
 * ============================================================================
 * 这一步新出现的失效面（每条都对应下面一组用例）
 * ============================================================================
 *
 *   A. **live 之后清单还是不是权威**（Step 7 遗留的口径问题，本步定稿）：manifest 基线
 *      在「投影行集合发生变化」时作废，而不是「任何 ingest 即作废」。口径错了会两头出问题：
 *      放宽过头的形态是「正在跑的那轮不算进 totalCount」；收紧过头的形态是「激活那一下
 *      （行一行没变）就把窗口化翻页打死」。`rowSetSignature` 是这条判定唯一的实现。
 *   B. **命令对 runtime 的依赖分档**（IS3）：`trigger-activation`（send 类，唯一激活触发器）
 *      / `require-runtime`（未就绪回可重试的 `runtimeNotReady`）/ `record-free`（幂等收口）。
 *      分档表漏一个命令的后果是一整类命令在 view-only 会话上点不动，或者反过来被误拒。
 *   C. **命令闸门的三种动作**（T-SL10）：未就绪的非 send 类必须 `rejected + runtimeNotReady`
 *      （不是 `failed`、也不是 `sessionNotFound`）；send 类必须触发激活并成功；queryCommands
 *      只加入已在飞的水位（不创建、不拒）；`sessionId === null` 的 createSession 不受门限。
 *   D. **失败不驻留**（runtime 水位）：一次瞬时 resume 失败不能让会话永久钉在「激活失败」，
 *      下一次发送必须能重新尝试；`runtimeReadyMs` 只在成功时写入（缺席 ≠ 0）。
 *   E. **IS4 三态 + 唯一原始判定点**：`host.sessionExists` 只能出现在 `hasHostRecord`，
 *      其余语义（live / viewOnly / absent / runtime 就绪）各走自己的函数——散落直判会把
 *      「record 在册」当成「runtime 跑起来了」（幽灵 runtime 前科）。
 *   F. **ACK 后后台预激活**（IS3 的激活触发点）：调用点必须在帧编码之后、且只此一处。
 *      阶段 8 里视图水位内部仍等激活，所以它今天是 no-op 的冗余路径——但它必须存在，
 *      Step 9 的 store-only 视图靠它接管自动激活（源码守卫锁住位置）。
 *
 * 运行：`npx tsx --test scripts/test-view-runtime-split.mjs`（必须走 tsx：gateway 的依赖
 * 链摸到 `@zcode/model-option-map` 的 src 出口）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { ConversationV4Gateway, commandRuntimeGate } = await import(
  new URL("../src/zcode-protocol-v4/v4-gateway.ts", import.meta.url).href
);
const { ConversationTopicPublisher } = await import(
  new URL("../src/zcode-protocol-v4/conversation-topic-publisher.ts", import.meta.url).href
);
const { commandTypeSchema } = await import("@zcode/shared/zcode-protocol-v4");

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 8 view/runtime split (IS3 + IS4)"
      : `TEST FAIL — Step 8 view/runtime split (exit code ${code})`,
  );
});

const SESSION_ID = "ses_view_runtime_split";
const EPOCH = "epoch-view-runtime-split";

// ── A: live 之后的清单权威（publisher 级，不需要 gateway）────────────────────

function publisher() {
  return new ConversationTopicPublisher(SESSION_ID, EPOCH, { now: () => 1_000 });
}

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

/** 一轮完整成功轮（与生产同序；turnId 必须是 `turn-<n>`）。 */
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

function twoTurnEvents() {
  return [...completedTurn({ turnNumber: 1, seq: 1 }), ...completedTurn({ turnNumber: 2, seq: 5 })];
}

function ingestAll(instance, events) {
  for (const event of events) instance.ingest(event);
}

/** facts 只对 totalCount / firstRowId 承重（本组断言只读这两个量）。 */
function manifestFacts({ totalCount, firstRowId = 1 }) {
  return {
    branchGeneration: 0,
    totalCount,
    firstRowId,
    realUserQueryTotal: 0,
    entries: [],
    rowIdBaseByTurnId: new Map(),
    turnIdByMessageId: new Map(),
    turnCount: 0,
    turns: [],
  };
}

/** 下发口径的 totalCount（manifest 权威只在打帧边界生效，原始投影永远是现算值）。 */
function wireTotalCount(instance, connectionId) {
  const subscribed = instance.subscribeReserved({
    connectionId,
    deliveryProfile: "continuous",
  });
  const totalCount = subscribed.reservation.frame.payload.snapshot.rows.totalCount;
  subscribed.reservation.commit();
  return totalCount;
}

test("A1: 不增删行的 live 事件（激活 / 标题）不作废清单基线（Step 8 定稿口径）", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const projectedRows = instance.getSnapshot().rows.window.length;
  // 刻意让清单比投影多 10 行：只要基线还在，下发口径的 totalCount 就必须是清单值（IS5）。
  const facts = manifestFacts({ totalCount: projectedRows + 10 });
  instance.seedRowManifestFacts(facts);
  assert.equal(wireTotalCount(instance, "conn-facts-1"), projectedRows + 10);

  // 激活期真实会发生的事件：会话 resume + 标题回填。两者都不产生/删除行。
  instance.ingest(
    sessionEvent("session_resumed", 100, {
      directory: "/tmp/ws",
      interruptedToolCount: 0,
      messageCount: 4,
      partCount: 4,
      recoveredSteerInputCount: 0,
      resumedTodoCount: 0,
    }),
  );
  assert.equal(
    instance.getRowManifestFacts(),
    facts,
    "SessionResumed 不增删行 → 基线必须保留（否则激活那一刻窗口化翻页就死了）",
  );
  instance.ingest(
    sessionEvent("session_title_updated", 101, {
      title: "新标题",
      previousTitle: "旧标题",
      source: "generated",
    }),
  );
  assert.equal(instance.getRowManifestFacts(), facts, "标题更新不增删行 → 基线必须保留");
  assert.equal(
    wireTotalCount(instance, "conn-facts-2"),
    projectedRows + 10,
    "基线在场时 totalCount 仍只来自清单",
  );
});

test("A2: 增删行的 live 事件仍必须作废基线（正在跑的那轮不在清单里）", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const projectedRows = instance.getSnapshot().rows.window.length;
  const facts = manifestFacts({ totalCount: projectedRows });
  instance.seedRowManifestFacts(facts);
  assert.equal(instance.getRowManifestFacts(), facts);

  // 新一轮的 user 行落进投影 → 投影比清单多行 → 基线必须作废。
  instance.ingest(
    sessionEvent("turn_started", 100, {
      turnNumber: 3,
      input: "新问题",
      messageId: "msg-user-3",
    }),
  );
  assert.equal(instance.getRowManifestFacts(), null, "行集合变了 → 清单不再权威");
  assert.ok(
    instance.getSnapshot().rows.window.length > projectedRows,
    "投影确实多出了行（这一轮不在清单里）",
  );
  assert.equal(
    wireTotalCount(instance, "conn-facts-3"),
    instance.getSnapshot().rows.window.length,
    "基线作废后 totalCount 回退到投影现算（正在跑的那轮被算进来）",
  );
});

test("A3: rowSetSignature 抓得住同长度的整体替换（首行 / 末行变化）", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const rows = instance.getSnapshot().rows.window;
  const baseline = instance.getRowSetSignature();
  assert.equal(baseline.split(":")[0], String(rows.length), "签名的第一段必须是行数");

  // 行数不变、只有首行变（模拟换分支后整体平移）：只看行数的实现会漏掉这一种。
  instance.getSnapshot().rows.window = rows.map((row, index) =>
    index === 0 ? { ...row, rowId: row.rowId + 1_000 } : row,
  );
  assert.notEqual(instance.getRowSetSignature(), baseline, "首行变化必须改变签名");

  // 行数不变、只有末行变（同长度但末尾换了内容）。
  instance.getSnapshot().rows.window = rows.map((row, index) =>
    index === rows.length - 1 ? { ...row, rowId: row.rowId + 2_000 } : row,
  );
  assert.notEqual(instance.getRowSetSignature(), baseline, "末行变化必须改变签名");
});

// ── B: 命令分档（IS3 的唯一分类实现）────────────────────────────────────────

const EXPECTED_TRIGGERS = [
  "createSelectionSideSession",
  "editUserQuery",
  "forkAssistant",
  "resumeGoal",
  "resumeWorkflowRun",
  "retryTurn",
  "sendGoalCommand",
  "sendQueuedNow",
  "sendText",
  "startSavedWorkflow",
];

const EXPECTED_RECORD_FREE = [
  "discardSharedContext",
  "resolveInteraction",
  "snoozeInteractionAutoResolution",
];

// 默认档 **必须显式列全**：只断言「三类之和 = 全集」的话，新增一个协议命令会静默落进
// require-runtime，而它可能本该是 send 类——那正是「点了就跑的命令在 view-only 上点不动」
// 的形态。列全之后，协议加命令必须回来改这张表（= 一次显式归位）。
const EXPECTED_REQUIRE_RUNTIME = [
  "amendWorkflowRunSettings",
  "applyFileRewind",
  "cancelBackgroundWork",
  "createSession",
  "ctxExpand",
  "ctxRecomp",
  "ctxReduce",
  "ctxStatus",
  "deleteQueueItem",
  "deleteSession",
  "editQueueItem",
  "pauseGoal",
  "renameSession",
  "reorderQueueItem",
  "requestWorkspaceHookReview",
  "respondWorkspaceHookReview",
  "revokeWorkspaceHookTrust",
  "setAssistantFeedback",
  "setAutoDrain",
  "setFollowupMode",
  "setQueueItemDelivery",
  "stop",
  "switchCollaborationMode",
  "switchModelConfig",
  "toggleWorkspaceHookReviewItem",
];

test("B1: 三类分档覆盖协议全集，三张名单逐项一致（新增命令必须显式归位）", () => {
  const allTypes = [...commandTypeSchema.options].sort();
  const byGate = { "trigger-activation": [], "record-free": [], "require-runtime": [] };
  for (const type of allTypes) byGate[commandRuntimeGate(type)].push(type);

  assert.deepEqual(byGate["trigger-activation"], EXPECTED_TRIGGERS, "send 类清单（激活触发器）");
  assert.deepEqual(byGate["record-free"], EXPECTED_RECORD_FREE, "不依赖 record 的幂等命令");
  assert.deepEqual(
    byGate["require-runtime"],
    EXPECTED_REQUIRE_RUNTIME,
    "默认档清单（协议新增命令时必须来归位）",
  );

  // 反向：每张名单里的名字都得是真实命令（防止改名后留下幽灵条目）。
  for (const type of [...EXPECTED_TRIGGERS, ...EXPECTED_RECORD_FREE, ...EXPECTED_REQUIRE_RUNTIME]) {
    assert.ok(allTypes.includes(type), `${type} 必须是真实命令类型`);
  }
});

test("B2: 需要 record 的普通命令一律 require-runtime（不误升级成激活触发器）", () => {
  for (const type of [
    "stop",
    "applyFileRewind",
    "setAssistantFeedback",
    "switchModelConfig",
    "pauseGoal",
    "deleteQueueItem",
    "deleteSession",
    "ctxStatus",
    "respondWorkspaceHookReview",
    "amendWorkflowRunSettings",
  ]) {
    assert.equal(commandRuntimeGate(type), "require-runtime", `${type} 不该是激活触发器`);
  }
});

// ── C/D: 命令闸门与 runtime 水位（gateway 级）───────────────────────────────

function gatewayFixture({ resumeRegistersRecord = true } = {}) {
  const calls = { resume: 0, executed: [], errors: [] };
  let live = false;
  let resumeBehaviour = () => "resumed";
  const host = {
    sessionExists: () => live,
    emitWireFrame: () => {},
    executeCommand: async (envelope) => {
      calls.executed.push(envelope.type);
      return undefined;
    },
    resumePersistedSession: async () => {
      calls.resume += 1;
      const outcome = resumeBehaviour();
      if (outcome === "throw") throw new Error("resume boom");
      if (resumeRegistersRecord) live = true;
      return { status: "resumed", persistedMessages: [] };
    },
    loadPersistedEvents: async () => ({
      events: [],
      synthesized: true,
      sourceEventSeq: 0,
      branchGeneration: 0,
    }),
    onError: (scope, error) => {
      calls.errors.push({ scope, message: String(error?.message ?? error) });
    },
    onDebug: () => {},
  };
  return {
    host,
    calls,
    setLive: (value) => {
      live = value;
    },
    setResumeBehaviour: (next) => {
      resumeBehaviour = next;
    },
  };
}

function commandEnvelope(type, payload, options = {}) {
  return {
    commandId: options.commandId ?? `cmd-${type}`,
    clientId: "client-test",
    sessionId: options.sessionId === undefined ? SESSION_ID : options.sessionId,
    ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
    ...(options.baseLogEpoch === undefined ? {} : { baseLogEpoch: options.baseLogEpoch }),
    type,
    payload,
    issuedAt: 1_700_000_000_000,
  };
}

test("C1: runtime 未就绪时非 send 类回 rejected + runtimeNotReady（可重试，不是 failed）", async () => {
  const { host, calls } = gatewayFixture();
  const gateway = new ConversationV4Gateway(host);
  try {
    const ack = await gateway.handleCommand(commandEnvelope("stop", {}));
    assert.equal(ack.status, "rejected");
    assert.equal(ack.reasonCode, "runtimeNotReady");
    assert.equal(calls.resume, 0, "非 send 类不得顺手触发激活（那不是它的职责）");
    assert.deepEqual(calls.executed, [], "被门拒掉的命令不得进 handler");
  } finally {
    gateway.dispose();
  }
});

test("C2: send 类命令是激活触发器（不回拒，先激活再执行）", async () => {
  const { host, calls } = gatewayFixture();
  const gateway = new ConversationV4Gateway(host);
  try {
    const ack = await gateway.handleCommand(commandEnvelope("sendText", { text: "继续" }));
    assert.equal(ack.status, "accepted", "send 类不得被 runtimeNotReady 拒（那是唯一激活入口）");
    assert.equal(calls.resume, 1, "send 类必须当场启动激活");
    assert.deepEqual(calls.executed, ["sendText"], "激活后命令必须真正执行");
  } finally {
    gateway.dispose();
  }
});

test("C3: queryCommands 只加入水位、不创建也不拒（view-only 上必须照常可用）", async () => {
  const { host, calls } = gatewayFixture();
  const gateway = new ConversationV4Gateway(host);
  try {
    const result = await gateway.queryCommands({
      commands: [{ sessionId: SESSION_ID, commandId: "never-seen" }],
    });
    assert.equal(result.results[0].result, "unknown");
    assert.equal(calls.resume, 0, "查询不是激活触发器");
  } finally {
    gateway.dispose();
  }
});

test("C4: record-free 命令过闸门（不判 runtimeNotReady），record 缺席由 inbox 按自己的口径拒", async () => {
  const { host, calls } = gatewayFixture();
  const gateway = new ConversationV4Gateway(host);
  try {
    const ack = await gateway.handleCommand(
      commandEnvelope("resolveInteraction", {
        interactionId: "interaction-1",
        answer: { optionId: "allow" },
      }),
    );
    // 关键区分：这条会话在本进程里既没 record 也没投影，但它不需要 runtime，
    // 所以拒绝只能来自 inbox 的「会话不存在」，不能是闸门的「runtime 未就绪」。
    assert.notEqual(ack.reasonCode, "runtimeNotReady", "record-free 命令不得被 runtime 闸门拦下");
    assert.equal(ack.reasonCode, "proto.sessionNotFound");
    assert.equal(calls.resume, 0, "幂等收口不激活 runtime");
  } finally {
    gateway.dispose();
  }
});

test("C5: sessionId 为 null 的 createSession 不受 runtime 门限（否则没有会话能出生）", async () => {
  const { host, calls } = gatewayFixture();
  const gateway = new ConversationV4Gateway(host);
  try {
    const ack = await gateway.handleCommand(
      commandEnvelope("createSession", { workspaceId: "ws-1" }, { sessionId: null }),
    );
    assert.equal(ack.status, "accepted");
    assert.equal(calls.resume, 0, "新建会话自己就是 runtime，不得先要一个");
    assert.deepEqual(calls.executed, ["createSession"]);
  } finally {
    gateway.dispose();
  }
});

test("C6: live 会话的非 send 命令直接放行（不额外激活）", async () => {
  const { host, calls, setLive } = gatewayFixture();
  setLive(true);
  const gateway = new ConversationV4Gateway(host);
  try {
    const ack = await gateway.handleCommand(commandEnvelope("stop", {}));
    assert.equal(ack.status, "accepted");
    assert.equal(calls.resume, 0);
    assert.deepEqual(calls.executed, ["stop"]);
  } finally {
    gateway.dispose();
  }
});

test("D1: 激活失败不驻留——下一次发送能重新激活，且 runtimeReadyMs 只在成功时写入", async () => {
  const { host, calls, setResumeBehaviour } = gatewayFixture();
  setResumeBehaviour(() => "throw");
  const gateway = new ConversationV4Gateway(host);
  try {
    await assert.rejects(
      gateway.subscribe({
        topic: `conversation/${SESSION_ID}`,
        connectionId: "conn-1",
        clientMode: "desktop-continuous",
      }),
      /resume boom|resumeFailed/,
      "视图水位内部仍要等激活（阶段 8），激活失败必须上抛而不是静默降级",
    );
    assert.equal(calls.resume, 1);
    const failed = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(failed.runtimeReady, false);
    assert.equal(failed.runtimeReadyMs, null, "失败不写耗时（缺席 ≠ 0）");

    // 失败的那条水位必须已经释放：再发一条 send 类命令要能重新尝试激活并成功。
    setResumeBehaviour(() => "resumed");
    const ack = await gateway.handleCommand(commandEnvelope("sendText", { text: "重试" }));
    assert.equal(ack.status, "accepted");
    assert.equal(calls.resume, 2, "失败不驻留：第二次必须重新发起激活");
    const ready = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(ready.runtimeReady, true);
    assert.equal(typeof ready.runtimeReadyMs, "number", "成功激活后必须留下本体耗时");
  } finally {
    gateway.dispose();
  }
});

test("D2: 首次订阅只激活一次；runtimeReady 查询在激活前为 false/null", async () => {
  const { host, calls } = gatewayFixture();
  const gateway = new ConversationV4Gateway(host);
  try {
    const before = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(before.runtimeReady, false);
    assert.equal(before.runtimeReadyMs, null);

    await gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    assert.equal(calls.resume, 1, "订阅期间的视图水化只激活一次");
    // 让 ACK 后的后台预激活（microtask）跑完：它必须复用同一条水位，不得二次 resume。
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.resume, 1, "ACK 后预激活不得重复 resume");
  } finally {
    gateway.dispose();
  }
});

test("D3: record 之外的两条事实——一次成功激活让 runtimeReady 为 true、视图已就绪让会话算存在", async () => {
  // Step 9 的 view-only shell 会「createRecord 但不 resume」，所以这两个判断都不能只看 record：
  //   - runtimeReady 要能读激活结论（否则 shell 一出现就误报「已就绪」）；
  //   - 「会话是否存在」要包含「视图已水化」（否则 shell 上的命令全被 sessionNotFound 拒掉）。
  // 本夹具刻意让 resume 成功但不登记 record，把这两条缝单独暴露出来。
  const { host, calls } = gatewayFixture({ resumeRegistersRecord: false });
  const gateway = new ConversationV4Gateway(host);
  try {
    await gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    assert.equal(calls.resume, 1);
    assert.equal(host.sessionExists(), false, "夹具：record 始终不在册（模拟 view-only shell）");

    const ready = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(ready.runtimeReady, true, "一次成功激活本身就是就绪事实，不依赖 record");
    assert.equal(typeof ready.runtimeReadyMs, "number");

    const ack = await gateway.handleCommand(commandEnvelope("stop", {}));
    assert.equal(
      ack.status,
      "accepted",
      "视图已水化的会话必须算「存在」：getRevision 走三态而不是 record 直判",
    );
    assert.deepEqual(calls.executed, ["stop"]);
  } finally {
    gateway.dispose();
  }
});

// ── E/F: 源码守卫（IS4 唯一判定点 + IS3 激活触发点位置）─────────────────────

const gatewaySource = readFileSync(
  new URL("../src/zcode-protocol-v4/v4-gateway.ts", import.meta.url),
  "utf8",
);

test("E1: host.sessionExists 只有 hasHostRecord 一个调用点（IS4/T-SL12）", () => {
  const occurrences = gatewaySource.match(/this\.host\.sessionExists/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    "散落的 sessionExists 直判会把「record 在册」当成「runtime 跑起来了」",
  );
  const hasHostRecordAt = gatewaySource.indexOf("private hasHostRecord(");
  const callAt = gatewaySource.indexOf("this.host.sessionExists");
  assert.ok(hasHostRecordAt > 0 && callAt > hasHostRecordAt, "唯一的调用点必须在 hasHostRecord 里");

  // 三态与水位判定必须各走自己的函数（组合断言，单个函数改名这里也会红）。
  for (const needle of [
    "private conversationState(",
    "private conversationViewState(",
    "private isRuntimeReady(",
    "viewReadySessions = new Set",
    "runtimeReadyFlights = new Map",
    "viewReadyFlights = new Map",
  ]) {
    assert.ok(gatewaySource.includes(needle), `缺少 ${needle}`);
  }
  assert.ok(
    !/this\.readyFlights\b/.test(gatewaySource),
    "旧的单表 readyFlights 不得残留（双水位必须真的拆开）",
  );
});

test("F1: 后台预激活的调用点在帧编码之后（IS3 激活触发点）", () => {
  const callAt = gatewaySource.indexOf("this.prewarmRuntimeAfterViewAck(");
  assert.ok(callAt > 0, "ACK 后的后台预激活调用点必须存在（Step 9 靠它接管自动激活）");
  assert.equal(
    gatewaySource.split("this.prewarmRuntimeAfterViewAck(").length - 1,
    1,
    "调用点只此一处：每处都加会被后面的读入口重复触发",
  );
  const encodeAt = gatewaySource.indexOf("const result = publisher.subscribeReserved({");
  const flushSetAt = gatewaySource.indexOf("this.flushStates.set(routeKey, {");
  assert.ok(encodeAt > 0 && flushSetAt > 0);
  assert.ok(
    callAt > encodeAt && callAt > flushSetAt,
    "预激活必须在帧编码（subscribeReserved）之后，否则激活耗时会串进 viewReadyMs",
  );
});
