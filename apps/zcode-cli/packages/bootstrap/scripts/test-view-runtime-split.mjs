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
 *      **Step 9 起它是首屏唯一的自动激活来源**——视图水位只物化外壳（不 resume），
 *      摘掉预激活就是「首屏永不自动激活」的死锁，而 D3 覆盖不到（F1/F2 锁形状与接缝）。
 *   G. **外壳 / 激活拆分**（Step 9）：视图水位只建 view-only 外壳（createRecord 不 resume），
 *      激活归 ACK 后的预激活与 send 类命令；外壳存在 ≠ runtime 就绪（D4/D5 + G1-G3）。
 *   H. **窗口化冷开的 shared_context 兼容**（Step 9）：那条 model-only 上下文消息几乎总在
 *      窗口之外，靠「窗口正文 find」会静默丢掉分享导入元数据；改为按 id 单条确认（H1/H2）。
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
const { loadPersistedConversationMaterialization } = await import(
  new URL("../src/zcode-protocol-v4/cold-event-merge.ts", import.meta.url).href
);
const { activateRuntime } = await import(
  new URL("../src/zcode-protocol/server-operations.ts", import.meta.url).href
);
const { commandTypeSchema } = await import("@zcode/shared/zcode-protocol-v4");

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 8/9 view/runtime split (IS3 + IS4)"
      : `TEST FAIL — Step 8/9 view/runtime split (exit code ${code})`,
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

function gatewayFixture({
  resumeRegistersRecord = true,
  shellPort = false,
  runtimeProbe = true,
} = {}) {
  const calls = { resume: 0, shell: 0, executed: [], errors: [] };
  let live = false;
  // Step 9 起「record 在册」与「runtime 在跑」是两个事实：view-only shell 只建 record。
  // 默认让二者同步（旧口径），需要暴露缝的用例用 setRuntimeActive 单独拧。
  let runtimeActive = null;
  let resumeBehaviour = () => "resumed";
  // 可控的「resume 悬在半空」——用来证明视图水位/ACK 没有等激活（等了的实现会挂在这里）。
  let resumeGate = null;
  const host = {
    sessionExists: () => live,
    ...(runtimeProbe
      ? { isSessionRuntimeActive: () => (runtimeActive === null ? live : runtimeActive) }
      : {}),
    emitWireFrame: () => {},
    executeCommand: async (envelope) => {
      calls.executed.push(envelope.type);
      return undefined;
    },
    ...(shellPort
      ? {
          // 生产宿主的形态：只建外壳（record 在册、runtime 没起），不 resume。
          materializeSessionShell: async () => {
            calls.shell += 1;
            live = true;
            runtimeActive = false;
            return { status: "materialized" };
          },
        }
      : {}),
    resumePersistedSession: async () => {
      calls.resume += 1;
      const outcome = resumeBehaviour();
      if (outcome === "throw") throw new Error("resume boom");
      if (resumeGate) await resumeGate.promise;
      if (resumeRegistersRecord) live = true;
      runtimeActive = true;
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
    setRuntimeActive: (value) => {
      runtimeActive = value;
    },
    setResumeBehaviour: (next) => {
      resumeBehaviour = next;
    },
    /** 让下一次 resume 停在半空，返回放行函数。 */
    holdResume: () => {
      let release;
      resumeGate = { promise: new Promise((resolve) => (release = resolve)) };
      return () => {
        // 已经在 await 的那个 promise 持有自己的引用，所以必须先放行再清门。
        resumeGate = null;
        release();
      };
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

test("D2: 旧宿主（无 shell 端口）首次订阅仍只激活一次；runtimeReady 在激活前为 false/null", async () => {
  // 没有 `materializeSessionShell` 的宿主（测试桩 / 旧宿主）退回 Step 8 的「先激活再建投影」：
  // 这条降级分支必须保持逐字不变，否则窗口化之外的宿主会一起断掉。
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
    assert.equal(calls.resume, 1, "降级分支的视图水化仍要等一次激活");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.resume, 1, "ACK 后预激活不得重复 resume");
  } finally {
    gateway.dispose();
  }
});

test("G1: 视图水位只物化外壳（不 resume），激活由 ACK 后的预激活接管（Step 9 的核心拆分）", async () => {
  const { host, calls, holdResume } = gatewayFixture({ shellPort: true });
  const gateway = new ConversationV4Gateway(host);
  const releaseResume = holdResume();
  try {
    // 关键断言的手法是让 resume **悬在半空**：视图水位若还在等激活，subscribe 就会挂住。
    const subscribing = gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const settled = await Promise.race([
      subscribing.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);
    assert.equal(settled, "resolved", "视图水位不得等激活：等了的实现会在这里超时");
    await subscribing;
    assert.equal(calls.shell, 1, "视图水位必须物化外壳");
    assert.equal(
      (await gateway.runtimeReady({ sessionId: SESSION_ID })).runtimeReady,
      false,
      "ACK 已发出而 resume 还没落定 → 首屏不算 runtime 就绪",
    );

    releaseResume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.resume, 1, "ACK 之后必须自动激活（否则首屏永不就绪 = 死锁）");
    const ready = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(ready.runtimeReady, true);
    assert.equal(typeof ready.runtimeReadyMs, "number");
  } finally {
    releaseResume();
    gateway.dispose();
  }
});

test("G2: 外壳已就绪后再订阅不重复激活（shell → 激活是单向升级）", async () => {
  const { host, calls } = gatewayFixture({ shellPort: true });
  const gateway = new ConversationV4Gateway(host);
  try {
    await gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.resume, 1);

    // 第二次订阅（新连接）：外壳已在、runtime 已在跑 → 两条水位都不该再动。
    await gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-2",
      clientMode: "desktop-continuous",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.resume, 1, "live 会话不得二次 resume（幽灵 runtime 前科）");
    assert.equal(calls.shell, 1, "外壳只物化一次");
  } finally {
    gateway.dispose();
  }
});

test("G3: 外壳物化失败（notFound）沿用 subscribe 的会话不可用分型，不激活", async () => {
  const { host, calls } = gatewayFixture({ shellPort: true });
  host.materializeSessionShell = async () => ({ status: "notFound" });
  const gateway = new ConversationV4Gateway(host);
  try {
    await assert.rejects(
      gateway.subscribe({
        topic: `conversation/${SESSION_ID}`,
        connectionId: "conn-1",
        clientMode: "desktop-continuous",
      }),
      /sessionNotFound|not persisted|fault\.subscribe/,
      "store 里也没有这条会话 → notFound（不是静默空历史）",
    );
    assert.equal(calls.resume, 0, "外壳都物化不出来时不得硬激活");
  } finally {
    gateway.dispose();
  }
});

test("D3: record 之外的两条事实——一次成功激活让 runtimeReady 为 true、视图已就绪让会话算存在", async () => {
  // Step 9 的 view-only shell 会「createRecord 但不 resume」，所以这两个判断都不能只看 record：
  //   - runtimeReady 要能读激活结论（否则 shell 一出现就误报「已就绪」）；
  //   - 「会话是否存在」要包含「视图已水化」（否则 shell 上的命令全被 sessionNotFound 拒掉）。
  // 本夹具刻意让 resume 成功但**不登记 record**、也**不给活性探针**：这样「就绪」只能来自
  // 激活结论集合本身（旧宿主 + 无 record 的最坏组合，D3 就是这条缝的锚点）。
  const { host, calls } = gatewayFixture({
    resumeRegistersRecord: false,
    runtimeProbe: false,
  });
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

test("D4: record 在册但 runtime 没跑（view-only shell）不得判成就绪——Step 9 的 blocking 前置", async () => {
  // 这是 Step 8 注释里那条「必须在接 shell 之前修掉」的缝：`isRuntimeReady` 过去以
  // 「record 在册 ⇒ live ⇒ 就绪」短路。接上 shell 之后 record 一定在册，而 runtime 没起，
  // 如果还短路就会：①conversation/runtimeReady 说谎；②send 类命令不去激活，直接撞上
  // 一个没有 runtime 的 record（幽灵 runtime 的入口）。
  const { host, calls, setLive, setRuntimeActive } = gatewayFixture();
  setLive(true); // record 已在册（shell 物化的结果）
  setRuntimeActive(false); // 但 app 没有 resume
  const gateway = new ConversationV4Gateway(host);
  try {
    const ready = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(ready.runtimeReady, false, "record 在册 ≠ runtime 就绪");
    assert.equal(ready.runtimeReadyMs, null, "没激活过就没有本体耗时（缺席 ≠ 0）");

    const rejected = await gateway.handleCommand(commandEnvelope("stop", {}));
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "runtimeNotReady", "view-only 先拒，让客户端重试");
    assert.equal(calls.resume, 0, "非 send 类不得顺手激活");

    // send 类命令是唯一激活入口：它必须把 shell 升到 runtime-ready。
    const ack = await gateway.handleCommand(commandEnvelope("sendText", { text: "继续" }));
    assert.equal(ack.status, "accepted", "send 类必须当场激活而不是被门拒");
    assert.equal(calls.resume, 1);
    const after = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(after.runtimeReady, true, "激活成功后结论必须落到集合上");
    assert.equal(typeof after.runtimeReadyMs, "number");
  } finally {
    gateway.dispose();
  }
});

test("D5: disposeSession 清掉激活结论——重建出的 shell 不能继承上一条 record 的就绪事实", async () => {
  const { host, calls, setLive, setRuntimeActive } = gatewayFixture();
  const gateway = new ConversationV4Gateway(host);
  try {
    await gateway.handleCommand(commandEnvelope("sendText", { text: "跑一轮" }));
    assert.equal(calls.resume, 1);
    assert.equal((await gateway.runtimeReady({ sessionId: SESSION_ID })).runtimeReady, true);

    // 会话被关掉 → 再以 view-only shell 的形态回来（record 在册、runtime 没起）。
    gateway.disposeSession(SESSION_ID);
    setLive(true);
    setRuntimeActive(false);
    const ready = await gateway.runtimeReady({ sessionId: SESSION_ID });
    assert.equal(ready.runtimeReady, false, "结论必须随会话销毁一起清，否则 shell 冒充就绪");
  } finally {
    gateway.dispose();
  }
});

// ── H: 窗口化冷开的 shared_context 兼容（Step 9）───────────────────────────

const SHARED_CONTEXT_MESSAGE = {
  info: {
    id: "m-shared-context",
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 1 },
    agent: "zcode-agent",
    source: "shared_context",
    visibility: "model-only",
    semantics: {
      origin: "import",
      kind: "shared_context",
      source: "conversation_share",
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
  },
  parts: [],
};

const TAIL_MESSAGE = {
  info: {
    id: "m-tail-user",
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 2 },
    agent: "a",
  },
  parts: [],
};

function sharedContextStore({ withSingleRead = true, readCalls = [] } = {}) {
  return {
    getSession: async () => ({ title: "分享的会话", revert: {} }),
    messages: async () => [SHARED_CONTEXT_MESSAGE, TAIL_MESSAGE],
    readTarget: async () => null,
    sessionEntries: async () => [
      {
        id: "entry-shared-context",
        sessionID: SESSION_ID,
        type: "v4/shared_context_import",
        time: { created: 1, updated: 1 },
        data: { contextId: "ctx-1", shareUrl: "https://share.example/x", status: "pending" },
      },
    ],
    ...(withSingleRead
      ? {
          messageWithParts: async ({ messageID }) => {
            readCalls.push(String(messageID));
            return messageID === SHARED_CONTEXT_MESSAGE.info.id ? SHARED_CONTEXT_MESSAGE : null;
          },
        }
      : {}),
  };
}

/** 只喂尾部一轮的窗口计划（Steps 6/7 的形状：正文不含那条 model-only 上下文消息）。 */
function tailWindowPlan(messages) {
  return {
    kind: "window",
    messages,
    ordinal: 1,
    rowIdBase: 10,
    turnCount: 1,
    rowCount: 2,
    limitBefore: TAIL_MESSAGE.info.id,
    branchTurnIds: ["turn-1"],
    activeMessageIds: [SHARED_CONTEXT_MESSAGE.info.id, TAIL_MESSAGE.info.id],
    windowMessageIds: [TAIL_MESSAGE.info.id],
    facts: { totalCount: 2, firstRowId: 10 },
    manifestAdjusted: false,
    messageIndexChecked: true,
    precedingTurnFirstMessageId: null,
  };
}

test("H1: 窗口正文里没有分享导入的上下文消息时，按 id 单条读补回元数据（不静默消失）", async () => {
  const readCalls = [];
  const result = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: SESSION_ID,
    store: sharedContextStore({ readCalls }),
    planColdWindow: async () => tailWindowPlan([TAIL_MESSAGE]),
  });
  assert.deepEqual(readCalls, [SHARED_CONTEXT_MESSAGE.info.id], "只读分支首条一次（O(1)）");
  assert.ok(result.sharedContextImport, "窗口化不得丢掉分享导入的展示元数据");
  assert.equal(result.sharedContextImport.contextId, "ctx-1");
  assert.equal(result.sharedContextImport.status, "pending");
  assert.equal(result.messages.length, 1, "正文仍然只有窗口那一轮");
});

test("H2: 那条消息本来就在窗口正文里时不发生额外单条读（正常会话不付这份成本）", async () => {
  const readCalls = [];
  const result = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: SESSION_ID,
    store: sharedContextStore({ readCalls }),
    planColdWindow: async () => tailWindowPlan([SHARED_CONTEXT_MESSAGE, TAIL_MESSAGE]),
  });
  assert.deepEqual(readCalls, [], "窗口内能找到就不该再读一次");
  assert.equal(result.sharedContextImport?.contextId, "ctx-1");
  assert.equal(result.messages.length, 2);
});

// ── I: 外壳 / 激活拆分与首屏降级（Step 9 的接线守卫）────────────────────────
//
// 这三个点都是「删掉一行就静默退化」的接缝：首屏显示默认模型、usage 用默认分母、
// record 缺席时退回空历史。行为用例需要完整的 bootstrap context（Step 13 的端到端），
// 这里只锁「那一行在不在、在不在正确的位置」。

const serverOperationsSource = readFileSync(
  new URL("../src/zcode-protocol/server-operations.ts", import.meta.url),
  "utf8",
);
const bridgeSource = readFileSync(
  new URL("../src/zcode-protocol/v4-bridge.ts", import.meta.url),
  "utf8",
);

test("I1: shell 只建 record 不 resume，activateRuntime 才 resume 并清 view-only 标记", () => {
  const shellAt = serverOperationsSource.indexOf("export async function materializeSessionShell(");
  const activateAt = serverOperationsSource.indexOf("export async function activateRuntime(");
  assert.ok(shellAt > 0 && activateAt > shellAt, "两个函数必须拆开且顺序稳定");
  const shellBody = serverOperationsSource.slice(shellAt, activateAt);
  assert.ok(
    !shellBody.includes("record.app.resume("),
    "外壳不得 resume（Step 9 的整个收益就在这条分界线上）",
  );
  assert.ok(
    shellBody.includes("record.runtimeViewOnlyShell = true;"),
    "外壳必须打 view-only 标记：漏了预激活会以为已 live（首屏永不自动激活）",
  );
  assert.ok(
    shellBody.includes("context.sessionShellFlights ??= new Map()") &&
      shellBody.includes("if (inFlight) return await inFlight;"),
    "外壳物化必须 per-session 单飞：视图水位与激活会并发进入同一会话（双 createRecord）",
  );
  // `materializeSessionRecord` 的第 4 个实参就是 resume。翻成 true 的后果是「外壳已经 resume，
  // 标记却还写着 view-only」→ 预激活再 resume 一次（双写账本），所以按位置钉住它。
  const resumeArg = shellBody.match(/\/\/ \*\*不 resume\*\*[\s\S]*?\n\s*(true|false),/);
  assert.equal(
    resumeArg?.[1],
    "false",
    "materializeSessionShell 必须以 resume:false 建 record（Step 9 的分界点就在这个实参上）",
  );
  assert.ok(
    shellBody.includes("readPersistedAssistantSelection("),
    "首屏 model/mode 只能来自窄查询（读 messages 等于把窗口化收益还回去）",
  );

  const activateBody = serverOperationsSource.slice(
    activateAt,
    serverOperationsSource.indexOf("export async function activateSessionForResume("),
  );
  assert.ok(
    activateBody.includes("if (record.runtimeViewOnlyShell !== true)"),
    "已 live 的会话不得二次 resume（幽灵 runtime 前科）",
  );
  assert.ok(
    activateBody.includes("record.app.resume("),
    "激活本体的唯一 resume 点在 activateRuntime",
  );
  assert.ok(
    activateBody.includes("record.runtimeViewOnlyShell = undefined;"),
    "激活成功后必须清标记，否则 runtime 已跑却被判成 view-only（命令会被门拒）",
  );
});

test("I2: 三处首屏降级都以 runtimeViewOnlyShell 为判据（漏一处就显示默认模型的假真值）", () => {
  const configSeedAt = bridgeSource.indexOf("getSessionConfigSeed: (sessionId) => {");
  const usageSeedAt = bridgeSource.indexOf(
    "getSessionUsageSeed: async (sessionId, persistedMessages) => {",
  );
  assert.ok(configSeedAt > 0 && usageSeedAt > configSeedAt, "两个种子钩子必须都存在");
  const configSeedBody = bridgeSource.slice(configSeedAt, usageSeedAt);
  assert.ok(
    configSeedBody.includes("record.runtimeViewOnlyShell === true") &&
      configSeedBody.includes("record.viewOnlyConfigSeed"),
    "view-only 首屏种子必须优先于 record 的默认模型",
  );
  assert.ok(
    configSeedBody.indexOf("record.viewOnlyConfigSeed") <
      configSeedBody.indexOf("record.app.runtime.getSessionModelSelection()"),
    "顺序不能反：先判 view-only，再去读 runtime 选择",
  );
  const usageSeedBody = bridgeSource.slice(
    usageSeedAt,
    bridgeSource.indexOf("// ── sessions-index hooks", usageSeedAt),
  );
  assert.ok(
    usageSeedBody.includes("record.runtimeViewOnlyShell === true") &&
      usageSeedBody.includes("return null"),
    "view-only 首屏不给 usage 种子（用默认模型算分母比「暂时没有」更误导）",
  );

  // loadPersistedEvents：record 缺席不再是闸门（旧实现直接 return 空事件 → 首屏空历史）。
  const loadAt = bridgeSource.indexOf(
    "loadPersistedEvents: async (sessionId, persistedMessages) => {",
  );
  assert.ok(loadAt > 0);
  const loadBody = bridgeSource.slice(
    loadAt,
    bridgeSource.indexOf("if (source.coldWindowFallback)", loadAt),
  );
  assert.ok(
    !loadBody.includes("zcode_protocol.v4.hydrate_runtime_missing"),
    "record 缺席不得提前返回空事件（store-only 变体必须照常产出 durable transcript）",
  );
  assert.ok(
    loadBody.includes("resolveConversationBackingRecord") &&
      loadBody.includes("zcode_protocol.v4.hydrate_store_only") &&
      loadBody.includes("const [liveEvents, sourceEventSeq] = record"),
    "record 只能降级为「没有内存事件」，不能降级为「没有历史」",
  );
});

test("I3: activateRuntime 只对 view-only shell resume 一次，成功后清标记（live 会话不二次 resume）", async () => {
  // 幽灵 runtime 的直接防护：`activateRuntime` 不是「无条件 resume」，而是「只把 shell 升级」。
  const resumes = [];
  const record = {
    app: {
      sessionId: "ses-activate",
      resume: async () => {
        resumes.push(1);
        return { modelSelection: null };
      },
    },
    runtimeViewOnlyShell: true,
    traceContext: { traceId: "trace-activate" },
  };
  const context = {
    sessions: new Map([["ses-activate", record]]),
    deps: {},
  };
  const shell = { record, created: true };

  await activateRuntime(context, shell, {});
  assert.equal(resumes.length, 1, "view-only shell 必须激活");
  assert.equal(
    record.runtimeViewOnlyShell,
    undefined,
    "成功后必须清标记（否则命令会被门永久拒掉）",
  );

  await activateRuntime(context, shell, {});
  assert.equal(resumes.length, 1, "live runtime 不得二次 resume（会双写账本、transcript 定格）");
});

test("I4: 同一条 record 的并发激活合并成一次（拆开后「外壳在、没 resume」的窗口是整个激活时长）", async () => {
  const resumes = [];
  const record = {
    app: {
      sessionId: "ses-activate-race",
      resume: async () => {
        resumes.push(1);
        return { modelSelection: null };
      },
    },
    runtimeViewOnlyShell: true,
    traceContext: { traceId: "trace-race" },
  };
  const context = { sessions: new Map([["ses-activate-race", record]]), deps: {} };
  const shell = { record, created: true };
  // 两个入口（V4 预激活 / send 命令，或 legacy session/resume）同时拿到同一条记录。
  await Promise.all([activateRuntime(context, shell, {}), activateRuntime(context, shell, {})]);
  assert.equal(resumes.length, 1, "并发激活必须共享同一次 resume");
  assert.equal(record.runtimeViewOnlyShell, undefined);
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
    "private hostRuntimeActive(",
    "viewReadySessions = new Set",
    "runtimeReadyFlights = new Map",
    "viewReadyFlights = new Map",
    // Step 9：激活结论集合。它是 `isRuntimeReady` 的唯一数据源，缺了这条守卫
    // 「record 在册 ⇒ 就绪」的短路会悄悄回来（D4 只在行为上抓）。
    "runtimeReadySessions = new Set",
    "isSessionRuntimeActive?(",
  ]) {
    assert.ok(gatewaySource.includes(needle), `缺少 ${needle}`);
  }
  assert.ok(
    !/this\.readyFlights\b/.test(gatewaySource),
    "旧的单表 readyFlights 不得残留（双水位必须真的拆开）",
  );

  // `isRuntimeReady` 的函数体不得直接读 record：结论只来自激活集合 + 宿主活性回填。
  const readyAt = gatewaySource.indexOf("private isRuntimeReady(");
  const nextMemberAt = gatewaySource.indexOf("private markViewReady(");
  assert.ok(readyAt > 0 && nextMemberAt > readyAt, "isRuntimeReady 必须是一段可检视的函数体");
  const readyBody = gatewaySource.slice(readyAt, nextMemberAt);
  assert.ok(readyBody.includes("runtimeReadySessions.has"), "isRuntimeReady 必须读激活结论集合");
  assert.ok(
    !readyBody.includes("hasHostRecord("),
    "isRuntimeReady 不得以「record 在册」短路（Step 9 的 blocking 前置）",
  );
});

test("E2: 宿主活性探针是「runtime 在跑」的唯一原始判定点（record 只回答在不在册）", () => {
  // 两个问题分开问：`hasHostRecord` → record；`hostRuntimeActive` → runtime。
  const hostRecordAt = gatewaySource.indexOf("private hasHostRecord(");
  const runtimeActiveAt = gatewaySource.indexOf("private hostRuntimeActive(");
  assert.ok(hostRecordAt > 0 && runtimeActiveAt > hostRecordAt);
  const runtimeActiveBody = gatewaySource.slice(
    runtimeActiveAt,
    gatewaySource.indexOf("private conversationState(", runtimeActiveAt),
  );
  assert.ok(
    runtimeActiveBody.includes("this.host.isSessionRuntimeActive"),
    "活性探针必须读宿主能力，不得退化成 record 判断",
  );
  assert.equal(
    gatewaySource.split("this.host.isSessionRuntimeActive").length - 1,
    1,
    "探针调用点只此一处（散落直判会得到两个不同的「live」）",
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

test("F2: 视图水位的接缝只有 ensureViewShell，且它不再等激活（降级分支必须显式写出来）", () => {
  const viewAt = gatewaySource.indexOf("private ensureViewReadyPublisher(");
  const shellAt = gatewaySource.indexOf("private async ensureViewShell(");
  assert.ok(viewAt > 0 && shellAt > viewAt, "两个函数必须都存在且顺序稳定");
  const viewBody = gatewaySource.slice(viewAt, shellAt);
  assert.ok(viewBody.includes("await this.ensureViewShell("), "视图水位只等外壳");
  assert.ok(
    !viewBody.includes("this.ensureRuntimeReady(") && !viewBody.includes("this.coldResume."),
    "视图水位不得自己接激活（Step 9 拆掉的就是这条依赖）",
  );
  // 降级分支（旧宿主没有 shell 端口）必须留在 ensureViewShell 里并**显式**可见：
  // 它读 `host.materializeSessionShell` 的有无，而不是把激活偷偷塞回读路径。
  const shellBody = gatewaySource.slice(
    shellAt,
    gatewaySource.indexOf("private ensureRuntimeReady(", shellAt),
  );
  assert.ok(
    shellBody.includes("this.host.materializeSessionShell") &&
      shellBody.includes("ensureShellMaterialized(") &&
      shellBody.includes("this.ensureRuntimeReady("),
    "ensureViewShell 必须是「有端口 → 只物化外壳 / 没端口 → 退回激活」两条显式分支",
  );
});
