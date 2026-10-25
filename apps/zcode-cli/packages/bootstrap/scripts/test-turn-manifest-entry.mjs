#!/usr/bin/env node
/**
 * Step 2 / phase-row-manifest —— 终态行清单（manifest entry）派生与分支代次的自动化验证。
 *
 * ============================================================================
 * 这一步新出现的失效面
 * ============================================================================
 * manifest entry 是「冷开快路径」的全部输入，它错的方式都很安静：
 *
 *   A. **目录口径**：只有 `origin === "realUser"` 的 userInput 成条；摘要必须与
 *      `getTurnDirectory` **逐字节**一致（两条路径各算一份 preview 就一定漂移，T-SL7 必红）。
 *   B. **row_count**：等于该 turn 在活投影里的行数；所有 turn 的 row_count 之和必须等于
 *      投影的 totalCount（否则「显示窗口之外的行」被静默吞掉，翻页会缺段）。
 *   C. **空 turn**：行已被 rewind 截掉的迟到终态不得写 entry（row_count=0 的 turn 会凭空
 *      产生一个 turn 位置）。
 *   D. **代次**：rewind 推进 `branchGeneration`（与 `SessionRevert.branchGeneration` 同源），
 *      种子只升不降；manifest 按代次键控，代次错了整份全序就键到别的分支上。
 *   E. **两个终态点**：`turn_complete` 与 `turn_error` 都必须产出 entry（只挂一处会让
 *      出错结束的轮次永远缺席 manifest）。
 *
 * 运行方式：`npx tsx --test scripts/test-turn-manifest-entry.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { ConversationTopicPublisher } = await import(
  new URL("../src/zcode-protocol-v4/conversation-topic-publisher.ts", import.meta.url).href
);
const { ConversationV4Gateway } = await import(
  new URL("../src/zcode-protocol-v4/v4-gateway.ts", import.meta.url).href
);
const { TURN_MANIFEST_PROJECTION_SCHEMA_VERSION, buildTurnManifestEntry } = await import(
  new URL("../src/zcode-protocol-v4/turn-manifest-entry.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 2 turn manifest entry derivation"
      : `TEST FAIL — Step 2 turn manifest entry derivation (exit code ${code})`,
  );
});

const SESSION_ID = "ses_manifest_entry";
const EPOCH = "epoch-manifest-entry";

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

/**
 * 一轮完整成功轮：turn_started → text_start → text_delta → turn_complete。
 *
 * `turnNumber` 必须与后续事件的 `turnId = turn-<n>` 同源：projection 用
 * `turn-${payload.turnNumber}` 推出 TurnStarted 的 runtime turn id，再把后续事件映射到
 * 该轮；两者不一致时后续事件会落成**另一个** product turn（本测试早期版本正是栽在这）。
 */
function completedTurn({ turnNumber, userMessageId, assistantMessageId, input, answer, seq }) {
  const turnId = `turn-${turnNumber}`;
  return [
    sessionEvent("turn_started", seq, {
      turnNumber,
      input,
      messageId: userMessageId,
    }),
    sessionEvent(
      "model_streaming",
      seq + 1,
      {
        kind: "text_start",
        assistantMessageId,
        partId: `part-${seq}`,
        delta: "",
        done: false,
      },
      turnId,
    ),
    sessionEvent(
      "model_streaming",
      seq + 2,
      { kind: "text_delta", delta: answer, done: false },
      turnId,
    ),
    sessionEvent(
      "turn_complete",
      seq + 3,
      {
        response: answer,
        tokenCount: 8,
        toolCallCount: 0,
        duration: 500,
        resultType: "success",
      },
      turnId,
    ),
  ];
}

function ingestAll(instance, events) {
  for (const event of events) instance.ingest(event);
}

function feedTwoTurns(instance) {
  const first = completedTurn({
    turnNumber: 1,
    userMessageId: "msg-user-1",
    assistantMessageId: "msg-a-1",
    input: "  帮我看下   这个 bug  ",
    answer: "第一段回答。\n\n第二段回答。",
    seq: 1,
  });
  const second = completedTurn({
    turnNumber: 2,
    userMessageId: "msg-user-2",
    assistantMessageId: "msg-a-2",
    input: "第二个问题",
    answer: "答案二",
    seq: 5,
  });
  ingestAll(instance, [...first, ...second]);
  return { firstComplete: first.at(-1), secondComplete: second.at(-1) };
}

// ── A: 真实事件链 → entry ───────────────────────────────────────────────────

test("A1: 终态 entry 的 row_count 与投影行事实一致，序号与 messageId 正确", () => {
  const instance = publisher();
  const { firstComplete, secondComplete } = feedTwoTurns(instance);
  const rows = instance.getSnapshot().rows.window;

  const first = instance.getTurnManifestEntry(firstComplete);
  const second = instance.getTurnManifestEntry(secondComplete);
  assert.ok(first && second);

  assert.equal(first.turn.turnId, "msg-user-1");
  assert.equal(first.turn.ordinal, 0);
  assert.equal(second.turn.turnId, "msg-user-2");
  assert.equal(second.turn.ordinal, 1, "ordinal 是 active 分支内的 turn 位置");

  const rowCountOf = (turnId) => rows.filter((row) => row.turnId === turnId).length;
  assert.equal(first.turn.rowCount, rowCountOf("msg-user-1"));
  assert.equal(second.turn.rowCount, rowCountOf("msg-user-2"));
  assert.ok(first.turn.rowCount > 0 && second.turn.rowCount > 0);

  assert.equal(
    first.turn.rowCount + second.turn.rowCount,
    instance.getSnapshot().rows.totalCount,
    "所有 turn 的 row_count 之和必须等于投影 totalCount（否则有行不属于任何 turn）",
  );

  assert.deepEqual(first.turn.messageIds, ["msg-user-1", "msg-a-1"]);
  assert.equal(first.turn.firstMessageId, "msg-user-1");
  assert.equal(first.turn.lastMessageId, "msg-a-1");
  assert.equal(first.turn.rowCountSource, "live");
  assert.equal(first.turn.projectionSchemaVersion, TURN_MANIFEST_PROJECTION_SCHEMA_VERSION);
  assert.equal(first.projectionSchemaVersion, TURN_MANIFEST_PROJECTION_SCHEMA_VERSION);
  assert.equal(first.branchGeneration, 0);
});

test("A2: 每条 query 的 preview / queryRowId / kind 与 getTurnDirectory 逐值一致", () => {
  const instance = publisher();
  const { firstComplete, secondComplete } = feedTwoTurns(instance);
  const directory = instance.getTurnDirectory({});
  const entries = [
    ...instance.getTurnManifestEntry(firstComplete).queries,
    ...instance.getTurnManifestEntry(secondComplete).queries,
  ];

  assert.equal(entries.length, directory.entries.length);
  assert.deepEqual(
    entries.map((item) => [
      item.turnId,
      item.queryRowId,
      item.queryPreview,
      item.assistantPreview,
      item.assistantPreviewKind,
    ]),
    directory.entries.map((item) => [
      item.turnId,
      item.queryRowId,
      item.queryPreview,
      item.assistantPreview,
      item.assistantPreviewKind,
    ]),
    "manifest 快路径与全量物化的目录必须逐字节同源",
  );
  assert.equal(entries[0].queryPreview, "帮我看下 这个 bug");
  // 摘要是 buildPreviewText 的口径：两段之间折叠成单个换行（不是原始 \n\n）。
  assert.equal(entries[0].assistantPreview, "第一段回答。\n第二段回答。");
  assert.equal(entries[0].queryMessageId, "msg-user-1");
  assert.equal(entries[0].queryOrdinalInTurn, 0);
});

test("A3: 同一 turn 的 steer query 各自成条，共享 turn 级 assistant 摘要与分段行数", () => {
  const instance = publisher();
  const rows = [
    {
      rowId: 1,
      turnId: "t-steer",
      entityId: "e1",
      productTurnId: "t-steer",
      visibility: "visible",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    },
    {
      rowId: 2,
      turnId: "t-steer",
      entityId: "e2",
      productTurnId: "t-steer",
      visibility: "visible",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "userInput",
      text: "先做 A",
      origin: "realUser",
    },
    {
      rowId: 3,
      turnId: "t-steer",
      entityId: "e3",
      productTurnId: "t-steer",
      visibility: "visible",
      createdAt: 3,
      createdAtSeq: 3,
      kind: "assistantText",
      text: "A 的回答",
      state: "complete",
    },
    {
      rowId: 4,
      turnId: "t-steer",
      entityId: "e4",
      productTurnId: "t-steer",
      visibility: "visible",
      createdAt: 4,
      createdAtSeq: 4,
      kind: "userInput",
      text: "顺便做 B",
      origin: "realUser",
    },
    {
      rowId: 5,
      turnId: "t-other",
      entityId: "e5",
      productTurnId: "t-other",
      visibility: "visible",
      createdAt: 5,
      createdAtSeq: 5,
      kind: "userInput",
      text: "别的 turn",
      origin: "realUser",
    },
  ];
  const entry = buildTurnManifestEntry({
    turnId: "t-steer",
    ordinal: 0,
    rows,
    messageIdForRow: (rowId) => (rowId === 2 ? "msg-a" : rowId === 4 ? "msg-b" : undefined),
    rowCountSource: "live",
    branchGeneration: 3,
  });
  assert.ok(entry);
  assert.equal(entry.turn.rowCount, 4, "只算本 turn 的行，不吞邻 turn");
  assert.deepEqual(
    entry.queries.map((item) => [item.queryOrdinalInTurn, item.queryRowId, item.rowCount]),
    [
      [0, 2, 2], // query(2) + assistantText(3)；到下一个 query 行前为止
      [1, 4, 1], // query(4) 到 turn 末尾
    ],
  );
  assert.deepEqual(
    entry.queries.map((item) => item.assistantPreview),
    ["A 的回答", "A 的回答"],
    "assistant 摘要是 turn 级的",
  );
  assert.equal(entry.queries[0].queryMessageId, "msg-a");
  assert.equal(entry.queries[1].queryMessageId, "msg-b");
  assert.equal(entry.branchGeneration, 3);
});

test("A4: 非 realUser 的 userInput 不进目录，但仍计入 row_count", () => {
  const rows = [
    {
      rowId: 1,
      turnId: "t-bg",
      entityId: "e1",
      productTurnId: "t-bg",
      visibility: "visible",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "running",
      startedAt: 1,
    },
    {
      rowId: 2,
      turnId: "t-bg",
      entityId: "e2",
      productTurnId: "t-bg",
      visibility: "visible",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "userInput",
      text: "[后台] 任务完成",
      origin: "backgroundResult",
    },
  ];
  const entry = buildTurnManifestEntry({
    turnId: "t-bg",
    ordinal: 0,
    rows,
    messageIdForRow: () => undefined,
    rowCountSource: "cold",
    branchGeneration: 0,
  });
  assert.ok(entry);
  assert.deepEqual(entry.queries, []);
  assert.equal(entry.turn.rowCount, 2);
  assert.deepEqual(entry.turn.messageIds, []);
  assert.equal(entry.turn.rowCountSource, "cold");
});

test("A5: 空行（行已被 rewind 截掉的迟到终态）返回 null，不写 row_count=0 的 turn", () => {
  assert.equal(
    buildTurnManifestEntry({
      turnId: "t-gone",
      ordinal: 0,
      rows: [],
      messageIdForRow: () => undefined,
      rowCountSource: "live",
      branchGeneration: 0,
    }),
    null,
  );
});

// ── B: 两个终态点 ───────────────────────────────────────────────────────────

test("B1: turn_error 同样产出 entry（失败轮不得从 manifest 缺席）", () => {
  const instance = publisher();
  const started = sessionEvent("turn_started", 1, {
    turnNumber: 1,
    input: "会失败的请求",
    messageId: "msg-user-err",
  });
  const failed = sessionEvent(
    "turn_error",
    2,
    { error: { type: "provider_error", message: "boom" } },
    "turn-1",
  );
  ingestAll(instance, [started, failed]);

  const entry = instance.getTurnManifestEntry(failed);
  assert.ok(entry, "turn_error 必须产出 entry");
  assert.equal(entry.turn.turnId, "msg-user-err");
  assert.equal(entry.turn.ordinal, 0);
  assert.equal(entry.queries.length, 1);
  assert.equal(entry.queries[0].queryMessageId, "msg-user-err");
  assert.equal(entry.queries[0].assistantPreviewKind, "empty");
  assert.equal(entry.queries[0].assistantPreview, "");
});

test("B2: 非终态事件不产出 entry", () => {
  const instance = publisher();
  const events = completedTurn({
    turnNumber: 1,
    userMessageId: "msg-user-1",
    assistantMessageId: "msg-a-1",
    input: "问题",
    answer: "回答",
    seq: 1,
  });
  ingestAll(instance, events);
  assert.equal(instance.getTurnManifestEntry(events[0]), null, "turn_started 不是终态");
  assert.equal(instance.getTurnManifestEntry(events[1]), null, "model_streaming 不是终态");
});

// ── C: 代次 ─────────────────────────────────────────────────────────────────

test("C1: rewind 推进常驻代次，被截 turn 从分支状态消失", () => {
  const instance = publisher();
  const { firstComplete } = feedTwoTurns(instance);
  assert.deepEqual(instance.getTurnManifestBranchState(), {
    branchGeneration: 0,
    turnIds: ["msg-user-1", "msg-user-2"],
  });

  const rewind = sessionEvent(
    "rewind_triggered",
    9,
    {
      rewindId: "rewind-1",
      scope: "conversation",
      targetMessageId: "msg-user-2",
      branchCutAfterMessageId: "msg-a-1",
      branchGeneration: 1,
      reason: "edit_query",
    },
    "msg-user-2",
  );
  instance.ingest(rewind);

  assert.deepEqual(instance.getTurnManifestBranchState(), {
    branchGeneration: 1,
    turnIds: ["msg-user-1"],
  });
  // 保留前缀的 entry 现在属于新代次。
  const entry = instance.getTurnManifestEntry(firstComplete);
  assert.equal(entry.branchGeneration, 1);
  assert.equal(entry.turn.ordinal, 0);
  // 被截 turn 的终态再迟到也不得产出 entry（行已经不存在了）。
  assert.equal(
    instance.getTurnManifestEntry(
      sessionEvent(
        "turn_complete",
        10,
        { response: "", tokenCount: 0, toolCallCount: 0, duration: 1, resultType: "success" },
        "msg-user-2",
      ),
    ),
    null,
  );
});

test("C2: 代次种子只升不降（cold hydration 的幂等种入）", () => {
  const instance = publisher();
  instance.seedBranchGeneration(3);
  assert.equal(instance.getTurnManifestBranchState().branchGeneration, 3);
  instance.seedBranchGeneration(1);
  assert.equal(instance.getTurnManifestBranchState().branchGeneration, 3, "不得被旧种子回退");
  instance.seedBranchGeneration(-1);
  instance.seedBranchGeneration(1.5);
  assert.equal(instance.getTurnManifestBranchState().branchGeneration, 3, "非法值忽略");
  instance.seedBranchGeneration(4);
  assert.equal(instance.getTurnManifestBranchState().branchGeneration, 4);
});

test("C3: 同代次内的普通事件不改变分支状态", () => {
  const instance = publisher();
  feedTwoTurns(instance);
  const before = instance.getTurnManifestBranchState();
  const followUp = sessionEvent("turn_started", 20, {
    turnNumber: 3,
    input: "第三问",
    messageId: "msg-user-3",
  });
  instance.ingest(followUp);
  assert.deepEqual(instance.getTurnManifestBranchState(), {
    branchGeneration: before.branchGeneration,
    turnIds: [...before.turnIds, "msg-user-3"],
  });
});

// ── D: gateway 接线（终态两处 + rewind 一处）────────────────────────────────

/** 最小 host：只提供 gateway 构造与 ingest 必需的成员。 */
function stubGatewayHost(captures) {
  return {
    sessionExists: () => true,
    emitWireFrame: () => {},
    executeCommand: async () => undefined,
    recordTurnManifest: (sessionId, entry) => {
      captures.records.push({ sessionId, entry });
    },
    rewriteTurnManifestBranch: (sessionId, input) => {
      captures.rewinds.push({ sessionId, input });
    },
    onError: (scope, error) => {
      captures.errors.push({
        scope,
        message: error instanceof Error ? error.message : String(error),
      });
    },
    onDebug: () => {},
  };
}

test("D1: ingest 的两个终态点都走 recordTurnManifest，rewind 走 branch rewrite", async () => {
  const captures = { records: [], rewinds: [], errors: [] };
  const gateway = new ConversationV4Gateway(stubGatewayHost(captures));
  try {
    const events = [
      ...completedTurn({
        turnNumber: 1,
        userMessageId: "msg-user-1",
        assistantMessageId: "msg-a-1",
        input: "问题一",
        answer: "回答一",
        seq: 1,
      }),
      sessionEvent("turn_started", 5, { turnNumber: 2, input: "问题二", messageId: "msg-user-2" }),
      sessionEvent(
        "turn_error",
        6,
        { error: { type: "provider_error", message: "boom" } },
        "turn-2",
      ),
      sessionEvent(
        "rewind_triggered",
        7,
        {
          rewindId: "rewind-1",
          scope: "conversation",
          targetMessageId: "msg-user-2",
          branchCutAfterMessageId: "msg-a-1",
          branchGeneration: 1,
          reason: "edit_query",
        },
        "turn-2",
      ),
    ];
    for (const event of events) gateway.ingest(SESSION_ID, event);
    // 写入在 gateway 内是 detached 的；等一轮微任务，避免依赖同步执行顺序。
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(captures.errors, []);
    assert.deepEqual(
      captures.records.map(({ sessionId, entry }) => [
        sessionId,
        entry.turn.turnId,
        entry.branchGeneration,
      ]),
      [
        [SESSION_ID, "msg-user-1", 0],
        [SESSION_ID, "msg-user-2", 0],
      ],
      "turn_complete 与 turn_error 都必须落 manifest",
    );
    assert.equal(
      captures.records[0].entry.projectionSchemaVersion,
      TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
    );
    assert.deepEqual(
      captures.rewinds.map(({ sessionId, input }) => [
        sessionId,
        input.sourceGeneration,
        input.branchGeneration,
        input.keptTurnIds,
      ]),
      [[SESSION_ID, 0, 1, ["msg-user-1"]]],
      "rewind 只把保留前缀搬到新代次",
    );
  } finally {
    gateway.dispose();
  }
});

test("D2: 没有 recordTurnManifest 能力的 host 不报错（旧宿主降级）", async () => {
  const captures = { records: [], rewinds: [], errors: [] };
  const host = stubGatewayHost(captures);
  delete host.recordTurnManifest;
  delete host.rewriteTurnManifestBranch;
  const gateway = new ConversationV4Gateway(host);
  try {
    for (const event of completedTurn({
      turnNumber: 1,
      userMessageId: "msg-user-1",
      assistantMessageId: "msg-a-1",
      input: "问题",
      answer: "回答",
      seq: 1,
    })) {
      gateway.ingest(SESSION_ID, event);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(captures.errors, [], "能力缺席只跳过 manifest，不得报错");
    assert.deepEqual(captures.records, []);
  } finally {
    gateway.dispose();
  }
});
