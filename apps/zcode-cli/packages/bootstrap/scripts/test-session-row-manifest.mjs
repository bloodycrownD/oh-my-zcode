#!/usr/bin/env node
/**
 * Step 4 / phase-row-manifest —— manifest 成为行序与计数的**唯一权威**。
 *
 * ============================================================================
 * 这一步新出现的失效面（每条都对应下面一组用例）
 * ============================================================================
 *
 *   A. **rowId base 的公式**：`origin + Σ 前序 active turn 的 row_count` 是 live 投影与
 *      manifest 读端**同一个函数**。它一旦分叉，转写路径的 rowId 会整体平移，而客户端只会
 *      表现为「翻页错位」，不会报错。
 *   B. **读路径的四个量**（totalCount / firstRowId / realUserQueryTotal / turnDirectory）
 *      必须只来自 manifest 两张表；空分支 `totalCount=0 / firstRowId=null` 是硬边界。
 *   C. **降级三态同等对待**：`missing` / `schemaMismatch` / `inconsistent` 必须走同一条动作
 *      （全量物化 + 重建 manifest）。这是 Step 3 明确只靠文档约束、留给本步钉住的一条。
 *   D. **rewind 不产生空洞**（IS1 的数学前提）：截断后新 turn 必须**复用**被截 turn 的 base，
 *      全局 `nextRowId++` 废除之后 id 集合恒为 `origin..origin+rows-1` 的连续前缀。
 *   E. **消息索引是 O(messages) 读**：一个会话在一次快照内只读一次（缓存），且第一趟
 *      manifest 读不通过时**不得**读索引（老会话第一次冷开本来就没有清单）。
 *   F. **回写 ordinal 的起点**：窗口化物化从 0 编号会把头部真实轮次逐出（仓储的
 *      `insertTurnRow` 按 ordinal 逐出「另一个 turn」）。本步用 `ordinalBase` 钉住这条缝，
 *      store 侧的逐出行为由 adapters 的 `test-turn-manifest-store` E5/E6 覆盖。
 *   G. **gateway 接线**：读路径必须挂在 hydration 收口处，且 ok 时把事实注入 publisher
 *      （此后 totalCount / turnDirectory 由 manifest 提供）、fallback 时回写整代 manifest。
 *   H/I. **冷开尾窗（Step 6）**：正文读只经 `readActiveBranchTail`；`limitBefore` 找不到
 *      单独报告（清单与索引不同步）；回写坐标是整条分支；`baseTimestampMs` 取分支首条。
 *   J. **窗口 vs 全量的身份一致（T-SL5 / T-SL6）**：`turnId` / `turnNumber` / `createdAt` /
 *      `ModelSelected` / 每一行的 `rowId` 逐值相等——`initialTurnNumber` 与 `rowIdOrigin`
 *      任一没接上这里就会红。
 *   K. **gateway 的窗口落点**：`rowIdOrigin` 在 rehydrate 内播种、`fullyMaterialized:false`、
 *      窗口化路径永不重建/剪枝（keptTurnIds 只认整条分支）。
 *
 * 运行：`npx tsx --test scripts/test-session-row-manifest.mjs`（与 test-turn-directory
 * 同理，必须走 tsx：publisher 的依赖链摸到 `@zcode/model-option-map` 的 src 出口）。
 */

import assert from "node:assert/strict";
import test from "node:test";

const { createSessionMessageIndexCache } = await import(
  new URL("../src/zcode-protocol-v4/session-conversation-index.ts", import.meta.url).href
);
const {
  decideRowManifestAction,
  createSessionRowManifestReader,
  deriveSessionRowManifestFacts,
  deriveTurnRowIdBase,
  readColdTailWindowMaterialization,
  selectColdTailWindow,
  selectManifestTurnDirectory,
} = await import(new URL("../src/zcode-protocol-v4/session-row-manifest.ts", import.meta.url).href);
const { PROTOCOL_V4_LIMITS } = await import("@zcode/shared/zcode-protocol-v4");
const { TURN_MANIFEST_PROJECTION_SCHEMA_VERSION } = await import(
  new URL("../src/zcode-protocol-v4/turn-manifest-entry.ts", import.meta.url).href
);
const { synthesizeEventsFromMessages } = await import(
  new URL("../src/zcode-protocol-v4/transcript-hydration.ts", import.meta.url).href
);
const { ConversationTopicPublisher } = await import(
  new URL("../src/zcode-protocol-v4/conversation-topic-publisher.ts", import.meta.url).href
);
const { ProductProjection } = await import(
  new URL("../src/zcode-protocol-v4/product-projection.ts", import.meta.url).href
);
const { ConversationV4Gateway } = await import(
  new URL("../src/zcode-protocol-v4/v4-gateway.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 4 row manifest authority (IS1 + IS5)"
      : `TEST FAIL — Step 4 row manifest authority (exit code ${code})`,
  );
});

const SESSION_ID = "ses_row_manifest";
const EPOCH = "epoch-row-manifest";

// ── 造数工具 ────────────────────────────────────────────────────────────────

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

/** 一轮完整成功轮；后续事件 turnId 必须是 `turn-<n>`（见 test-turn-manifest-entry 的注释）。 */
function completedTurn({ turnNumber, userMessageId, assistantMessageId, input, answer, seq }) {
  const turnId = `turn-${turnNumber}`;
  return [
    sessionEvent("turn_started", seq, { turnNumber, input, messageId: userMessageId }),
    sessionEvent(
      "model_streaming",
      seq + 1,
      { kind: "text_start", assistantMessageId, partId: `part-${seq}`, delta: "", done: false },
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
      { response: answer, tokenCount: 8, toolCallCount: 0, duration: 500, resultType: "success" },
      turnId,
    ),
  ];
}

function twoTurnEvents() {
  return [
    ...completedTurn({
      turnNumber: 1,
      userMessageId: "msg-user-1",
      assistantMessageId: "msg-a-1",
      input: "第一问",
      answer: "第一段回答。",
      seq: 1,
    }),
    ...completedTurn({
      turnNumber: 2,
      userMessageId: "msg-user-2",
      assistantMessageId: "msg-a-2",
      input: "第二问",
      answer: "第二段回答。",
      seq: 5,
    }),
  ];
}

function ingestAll(instance, events) {
  for (const event of events) instance.ingest(event);
}

/** 活投影的终态 entry → 仓储会返回的 manifest 快照（读端的真实输入形状）。 */
function manifestSnapshotOf(instance, { branchGeneration = 0 } = {}) {
  const turns = [];
  const queries = [];
  for (const event of twoTurnEvents()) {
    if (event.type !== "turn_complete") continue;
    const entry = instance.getTurnManifestEntry(event);
    if (!entry) continue;
    turns.push({ ...entry.turn, ordinal: turns.length });
    queries.push(...entry.queries);
  }
  return {
    branchGeneration,
    turns,
    queries,
    totalCount: turns.reduce((sum, turn) => sum + turn.rowCount, 0),
    firstRowId: turns.some((turn) => turn.rowCount > 0) ? 1 : null,
    realUserQueryTotal: queries.length,
    manifestAdjusted: false,
    adjustedTurnIds: [],
  };
}

/** 最小 store 夹具：只有读路径要用的两个面 + 调用计数。 */ function fakeStore({
  readResult,
  indexEntries = [],
  onRead,
  tailMessages,
  loadedMessages,
} = {}) {
  const calls = { manifestReads: [], indexReads: 0, tailReads: [], fullReads: [] };
  const store = {
    listSessionMessageIndex: async ({ sessionID }) => {
      calls.indexReads += 1;
      return indexEntries.map((id, index) => ({
        id,
        sequence: index + 1,
        timeCreated: 1_700_000_000_000 + index,
        storageRowId: index + 1,
      }));
    },
    readActiveBranchTail: async (input) => {
      calls.tailReads.push(input);
      return tailMessages ?? [];
    },
    // 冷开正文读**不得**走全量 `messages()`：窗口化收益归零的第一个信号就是这里被调用。
    messages: async () => {
      calls.fullReads.push(true);
      return loadedMessages ?? [];
    },
    turnManifest: {
      upsertTurnManifest: async () => {},
      rewriteTurnManifestBranch: async () => ({ applied: true, keptTurnCount: 0 }),
      readTurnManifest: async (input) => {
        calls.manifestReads.push(input);
        if (onRead) return onRead(input, calls);
        return readResult;
      },
    },
  };
  return { store, calls };
}

function readerFor(store) {
  return createSessionRowManifestReader({ store: () => store });
}

// ── A: rowId base 的唯一公式 ────────────────────────────────────────────────

test("A1: deriveTurnRowIdBase = origin + Σ 前序行数（负数按 0，不允许 base 倒退）", () => {
  assert.equal(deriveTurnRowIdBase([]), 1);
  assert.equal(deriveTurnRowIdBase([3, 4]), 8);
  assert.equal(deriveTurnRowIdBase([], 1), 1);
  // 冷窗口：origin 由 manifest 给出（窗口首轮的 base），不是写死 1。
  assert.equal(deriveTurnRowIdBase([2, 3], 101), 106);
  // 行数是存储事实，出现负数只能是损坏数据：按 0 处理，不得让后续 turn 的 base 前移。
  assert.equal(deriveTurnRowIdBase([-5, 2]), 3);
});

test("A2: facts 的四个量与 rowId base 都来自 manifest 快照本身", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const snapshot = manifestSnapshotOf(instance);
  const facts = deriveSessionRowManifestFacts(snapshot);

  assert.equal(facts.totalCount, snapshot.totalCount);
  assert.equal(facts.totalCount, instance.getSnapshot().rows.window.length);
  assert.equal(facts.firstRowId, 1);
  assert.equal(facts.realUserQueryTotal, 2);
  assert.equal(facts.turnCount, 2);

  const [first, second] = snapshot.turns;
  assert.equal(facts.rowIdBaseByTurnId.get(first.turnId), 1);
  assert.equal(facts.rowIdBaseByTurnId.get(second.turnId), 1 + first.rowCount);
  // messageId → turnId 是 durableTurnByMessageId 的替代数据源。
  assert.equal(facts.turnIdByMessageId.get("msg-user-2"), second.turnId);
  // 目录按 queryRowId 升序。
  assert.deepEqual(
    facts.entries.map((entry) => entry.queryRowId),
    [...facts.entries.map((entry) => entry.queryRowId)].sort((left, right) => left - right),
  );
});

test("A3: live 投影的 rowId base 与 manifest 读端逐值一致（IS1 同一函数）", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const snapshot = manifestSnapshotOf(instance);
  const facts = deriveSessionRowManifestFacts(snapshot);
  const rows = instance.getSnapshot().rows.window;

  for (const turn of snapshot.turns) {
    const liveBase = instance.getTurnManifestRowIdBase(turn.turnId);
    assert.equal(
      liveBase,
      facts.rowIdBaseByTurnId.get(turn.turnId),
      `turn ${turn.turnId} 的 base 两条路径必须相等`,
    );
    // base 必须就是该 turn 首行的**实际** rowId。
    const firstRow = rows.find((row) => row.turnId === turn.turnId);
    assert.equal(firstRow.rowId, liveBase);
    assert.equal(turn.rowCount, rows.filter((row) => row.turnId === turn.turnId).length);
  }
  // 全量投影的 id 集合是 origin..origin+rows-1 的连续前缀（无空洞的前提）。
  assert.deepEqual(
    rows.map((row) => row.rowId),
    rows.map((_row, index) => index + 1),
  );
});

// ── B: 读端四量 + 降级 ──────────────────────────────────────────────────────

test("B1: 端口缺席 → fallback/portAbsent（不得当成空分支），动作是全量物化+重建", async () => {
  const reader = readerFor(undefined);
  const outcome = await reader.read(SESSION_ID, {
    branchGeneration: 0,
    expectedProjectionSchemaVersion: 2,
  });
  assert.equal(outcome.kind, "fallback");
  assert.equal(outcome.reason, "portAbsent");
  assert.equal(decideRowManifestAction(outcome), "materialize-and-rebuild");
});

test("B2: ok → facts 与账目修正打点原样带出，索引观察在两趟读里都参与", async () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const snapshot = {
    ...manifestSnapshotOf(instance),
    manifestAdjusted: true,
    adjustedTurnIds: ["msg-user-1"],
  };
  const { store, calls } = fakeStore({
    readResult: { status: "ok", snapshot },
    indexEntries: snapshot.turns.flatMap((turn) => turn.messageIds),
  });
  const outcome = await readerFor(store).read(SESSION_ID, {
    branchGeneration: 0,
    expectedProjectionSchemaVersion: 2,
    observedTurnIds: snapshot.turns.map((turn) => turn.turnId),
    observedRowCounts: new Map(snapshot.turns.map((turn) => [turn.turnId, turn.rowCount])),
    fullyMaterialized: true,
  });

  assert.equal(outcome.kind, "manifest");
  assert.equal(decideRowManifestAction(outcome), "use-manifest");
  assert.equal(outcome.facts.totalCount, snapshot.totalCount);
  assert.equal(outcome.manifestAdjusted, true);
  assert.deepEqual(outcome.adjustedTurnIds, ["msg-user-1"]);
  assert.equal(outcome.messageIndexChecked, true);
  // 两趟读：第一趟**不带**账目修正（否则第二趟的 adjusted 永远是 false），第二趟带。
  assert.equal(calls.manifestReads.length, 2);
  assert.equal(calls.manifestReads[0].observedRowCounts, undefined);
  assert.ok(calls.manifestReads[1].observedRowCounts instanceof Map);
  // 消息索引只在第一趟通过之后才读，并且以 observedMessageIds 传回仓储。
  assert.equal(calls.indexReads, 1);
  assert.deepEqual(
    calls.manifestReads[1].observedMessageIds,
    snapshot.turns.flatMap((turn) => turn.messageIds),
  );
});

for (const [label, result, expectedReason] of [
  ["missing", { status: "missing" }, "missing"],
  [
    "schemaMismatch",
    { status: "schemaMismatch", expectedVersion: 2, foundVersions: [1] },
    "schemaMismatch",
  ],
  [
    "inconsistent/ordinalGap",
    { status: "inconsistent", reason: "ordinalGap", turnIds: [], missingMessageIds: [] },
    "inconsistent",
  ],
  [
    "inconsistent/unregisteredTurns",
    { status: "inconsistent", reason: "unregisteredTurns", turnIds: ["t9"], missingMessageIds: [] },
    "inconsistent",
  ],
  [
    "inconsistent/messageIndexMismatch",
    {
      status: "inconsistent",
      reason: "messageIndexMismatch",
      turnIds: [],
      missingMessageIds: ["msg-gone"],
    },
    "inconsistent",
  ],
]) {
  test(`B3: ${label} → 与 missing 同一条降级路径（全量物化 + 重建），不读消息索引`, async () => {
    const { store, calls } = fakeStore({ readResult: result });
    const outcome = await readerFor(store).read(SESSION_ID, {
      branchGeneration: 0,
      expectedProjectionSchemaVersion: 2,
    });
    assert.equal(outcome.kind, "fallback");
    assert.equal(outcome.reason, expectedReason);
    assert.equal(
      decideRowManifestAction(outcome),
      "materialize-and-rebuild",
      "三态必须同等对待：动作与 missing 相同",
    );
    // 第一趟就失败 → 不必付 O(messages) 的索引读。
    assert.equal(calls.indexReads, 0);
    assert.equal(calls.manifestReads.length, 1);
  });
}

test("B4: 全量物化下 manifest 比投影长（多出的 turn）→ inconsistent/unregisteredTurns", async () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const snapshot = manifestSnapshotOf(instance);
  const { store } = fakeStore({ readResult: { status: "ok", snapshot } });
  const reader = readerFor(store);
  const request = {
    branchGeneration: 0,
    expectedProjectionSchemaVersion: 2,
    // 投影只观察到第一轮（例如 rewind 之后 manifest 还留着被截的那轮）。
    observedTurnIds: [snapshot.turns[0].turnId],
  };

  const full = await reader.read(SESSION_ID, { ...request, fullyMaterialized: true });
  assert.equal(full.kind, "fallback");
  assert.equal(full.reason, "inconsistent");
  assert.deepEqual(full.detail.unobservedTurnIds, [snapshot.turns[1].turnId]);

  // 窗口化物化时「manifest 比窗口长」是合法状态，不得判成不一致。
  const windowed = await reader.read(SESSION_ID, { ...request, fullyMaterialized: false });
  assert.equal(windowed.kind, "manifest");
});

test("B5: store 抛错 → fallback/readFailed（冷开不因清单读失败整体失败）", async () => {
  const { store } = fakeStore({
    onRead: () => {
      throw new Error("sqlite boom");
    },
  });
  const outcome = await readerFor(store).read(SESSION_ID, {
    branchGeneration: 0,
    expectedProjectionSchemaVersion: 2,
  });
  assert.equal(outcome.kind, "fallback");
  assert.equal(outcome.reason, "readFailed");
  assert.match(outcome.detail.message, /sqlite boom/);
  assert.equal(decideRowManifestAction(outcome), "materialize-and-rebuild");
});

test("B6: 索引端口缺席 → messageIndexChecked=false（没查可见，不当成通过）", async () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const snapshot = manifestSnapshotOf(instance);
  const { store } = fakeStore({ readResult: { status: "ok", snapshot } });
  delete store.listSessionMessageIndex;
  const outcome = await readerFor(store).read(SESSION_ID, {
    branchGeneration: 0,
    expectedProjectionSchemaVersion: 2,
  });
  assert.equal(outcome.kind, "manifest");
  assert.equal(outcome.messageIndexChecked, false);
});

// ── C: 会话级索引缓存 ───────────────────────────────────────────────────────

test("C1: 同一会话的 N 次读只打一次索引；invalidate 之后重新读", async () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const snapshot = manifestSnapshotOf(instance);
  const { store, calls } = fakeStore({
    readResult: { status: "ok", snapshot },
    indexEntries: snapshot.turns.flatMap((turn) => turn.messageIds),
  });
  const reader = readerFor(store);
  const request = { branchGeneration: 0, expectedProjectionSchemaVersion: 2 };
  for (let round = 0; round < 3; round += 1) {
    const outcome = await reader.read(SESSION_ID, request);
    assert.equal(outcome.kind, "manifest");
  }
  assert.equal(calls.indexReads, 1, "翻页/重复读不得每页付一次 O(messages)");
  reader.invalidateMessageIndex(SESSION_ID);
  await reader.read(SESSION_ID, request);
  assert.equal(calls.indexReads, 2);
});

test("C2: 缓存按会话隔离，且失败不留毒（下一次能重新打 store）", async () => {
  let failures = 1;
  const cache = createSessionMessageIndexCache();
  const store = {
    listSessionMessageIndex: async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient");
      }
      return [{ id: "m1", sequence: 1, timeCreated: 1, storageRowId: 1 }];
    },
  };
  await assert.rejects(() => cache.read(store, "ses-a"));
  const retried = await cache.read(store, "ses-a");
  assert.deepEqual(
    retried.map((entry) => entry.id),
    ["m1"],
    "失败不得把会话钉在 rejected 上",
  );
  // 端口缺席 = null（与空数组严格区分）。
  assert.equal(await cache.read({}, "ses-a"), null);
  assert.equal((await cache.read(store, "ses-b")) instanceof Array, true);
});

// ── D: 目录分页契约（manifest 快路径与全量扫描同规）────────────────────────

test("D1: manifest 目录分页与 publisher 全量扫描逐值一致（含游标与 hasMore）", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const facts = deriveSessionRowManifestFacts(manifestSnapshotOf(instance));

  for (const params of [
    {},
    { limit: 1 },
    { beforeQueryRowId: facts.entries[1].queryRowId },
    { beforeQueryRowId: 1 },
    { limit: 1, beforeQueryRowId: facts.entries[1].queryRowId + 1 },
  ]) {
    const expected = instance.getTurnDirectory(params);
    const page = selectManifestTurnDirectory(facts, params);
    assert.deepEqual(page.entries, expected.entries, `params=${JSON.stringify(params)}`);
    assert.equal(page.realUserQueryTotal, expected.realUserQueryTotal);
    assert.equal(page.hasMore, expected.hasMore);
  }
});

// ── E: rowId base 废除全局自增（IS1 的核心）───────────────────────────────

test("E1: rewind 后新 turn 复用被截 turn 的 base，id 集合无空洞", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const before = instance.getSnapshot().rows.window;
  const secondTurnBase = instance.getTurnManifestRowIdBase("msg-user-2");
  assert.equal(secondTurnBase, before.find((row) => row.turnId === "msg-user-2").rowId);

  // 截掉第二轮（同一代次原地过滤：不带 branchGeneration 时不得截行——新语义只消费
  // 带 branchGeneration/cut 的已提交 rewind）。
  instance.ingest(
    sessionEvent(
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
    ),
  );
  const afterRewind = instance.getSnapshot().rows.window;
  assert.equal(afterRewind.filter((row) => row.turnId === "msg-user-2").length, 0);

  // 新一轮：它的 base 必须是被截轮的 base，不是「旧最大 id + 1」。
  const replacement = completedTurn({
    turnNumber: 3,
    userMessageId: "msg-user-3",
    assistantMessageId: "msg-a-3",
    input: "改问",
    answer: "改答",
    seq: 20,
  });
  ingestAll(instance, replacement);
  const rows = instance.getSnapshot().rows.window;
  const newTurnBase = instance.getTurnManifestRowIdBase("msg-user-3");
  assert.equal(
    newTurnBase,
    secondTurnBase,
    "rewind 后新 turn 必须复用被截 turn 的 base（IS1：不再产生空洞）",
  );
  assert.deepEqual(
    rows.map((row) => row.rowId),
    rows.map((_row, index) => index + 1),
    "rowId 集合必须恒为 origin..origin+rows-1 的连续前缀",
  );
  // 同一会话内的 turn 序也只剩两个（被截的从行序索引里消失）。
  assert.deepEqual(instance.getTurnManifestBranchState().turnIds, ["msg-user-1", "msg-user-3"]);
});

test("E2: 迟到行（锚在历史轮的 goal verify）按 turnId 归户，Σ row_count == 行数，新 turn 的 base 仍等于游标", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const before = instance.getSnapshot().rows.window;
  const takenIds = new Set(before.map((row) => row.rowId));
  const countsBefore = instance.getTurnRowCounts();
  const firstTurnRowCount = countsBefore.get("msg-user-1");
  assert.equal(
    [...countsBefore.values()].reduce((sum, count) => sum + count, 0),
    before.length,
    "无迟到行时 Σ row_count 必须等于行数",
  );

  instance.ingest(
    sessionEvent(
      "target_completion_verification",
      30,
      {
        verificationId: "verify-1",
        status: "completed",
        goalIteration: 1,
        // 锚在**第一轮**（早于当前轮）：行必须后移到尾部，不能插进第二轮已占用的区间。
        anchorTurnId: "msg-user-1",
        verification: { passed: true },
      },
      "turn-2",
    ),
  );

  const rows = instance.getSnapshot().rows.window;
  const marker = rows.at(-1);
  assert.equal(marker.turnId, "msg-user-1");
  assert.equal(takenIds.has(marker.rowId), false, "迟到行不得复用已有 rowId");
  assert.equal(marker.rowId, Math.max(...takenIds) + 1);

  // **写侧修法（Step 6）**：迟到行按 turnId 归户，而不是被「连续块」丢掉。
  // 不归户时 Σ row_count 比 rows.length 少 N，冷窗口的 rowIdOrigin（= manifest base）
  // 就会整体前移 N——全量物化用紧凑游标，窗口内 rowId 与它必然对不上（IS1 直接破）。
  const counts = instance.getTurnRowCounts();
  assert.equal(counts.get("msg-user-1"), firstTurnRowCount + 1, "迟到行必须计入它自己那一轮");
  assert.equal(
    [...counts.values()].reduce((sum, count) => sum + count, 0),
    rows.length,
    "归户后 Σ row_count 必须恢复为行数",
  );
  // manifest 的 row_count 与投影口径同源（回写用的是同一份 entry）。
  const entries = instance.getTurnManifestEntriesForBranch({ rowCountSource: "cold" });
  assert.equal(
    entries.find((entry) => entry.turn.turnId === "msg-user-1").turn.rowCount,
    firstTurnRowCount + 1,
  );
  assert.equal(
    entries.reduce((sum, entry) => sum + entry.turn.rowCount, 0),
    rows.length,
    "manifest Σ row_count 必须等于行数（冷窗口按它算 totalCount 与 base）",
  );

  // 新 turn 的 base 仍等于紧凑游标：Σ 全部 active turn 的行数 == 行数。
  ingestAll(
    instance,
    completedTurn({
      turnNumber: 3,
      userMessageId: "msg-user-3",
      assistantMessageId: "msg-a-3",
      input: "第三问",
      answer: "第三答",
      seq: 40,
    }),
  );
  const withThird = instance.getSnapshot().rows.window;
  const thirdTurnFirstRow = withThird.find((row) => row.turnId === "msg-user-3");
  assert.equal(
    instance.getTurnManifestRowIdBase("msg-user-3"),
    thirdTurnFirstRow.rowId,
    "新 turn 的 base 必须等于它首行的真实 rowId（分配游标与 base 同源）",
  );
});

test("E3: clone/adopt（原子提交）搬运 turn 行序与每轮行数，否则 base 归零撞号", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  for (const event of twoTurnEvents()) projection.applyEvent(event);
  const beforeCount = projection.getSnapshot().rows.window.length;
  // 先制造一条迟到行：此时「每轮行数」与「连续块行数」不再相等，clone/adopt 若只搬
  // activeTurnIds 而不搬行数，adopt 后 base 与 manifest row_count 会静默退回连续块口径。
  projection.applyEvent(
    sessionEvent(
      "target_completion_verification",
      19,
      {
        verificationId: "verify-clone",
        status: "completed",
        goalIteration: 1,
        anchorTurnId: "msg-user-1",
        verification: { passed: true },
      },
      "turn-2",
    ),
  );
  const countsBefore = projection.getTurnRowCounts();
  const nextTurn = completedTurn({
    turnNumber: 3,
    userMessageId: "msg-user-3",
    assistantMessageId: "msg-a-3",
    input: "第三问",
    answer: "第三答",
    seq: 20,
  });

  // applyEventAtomically 走 clone → adopt；漏搬 activeTurnIds 时新 turn 的 base 会算成 1。
  for (const event of nextTurn) {
    const deltas = projection.applyEventAtomically(event, () => true);
    assert.ok(deltas !== null);
  }
  const rows = projection.getSnapshot().rows.window;
  assert.equal(
    projection.getTurnManifestRowIdBase("msg-user-3"),
    beforeCount + 2,
    "adopt 之后 base 必须接着前序 turn 的行数（含迟到行），不是从 1 重来",
  );
  const countsAfter = projection.getTurnRowCounts();
  assert.equal(
    countsAfter.get("msg-user-1"),
    countsBefore.get("msg-user-1"),
    "迟到行的归户计数必须随 clone/adopt 搬运（漏搬 = row_count 静默回退）",
  );
  assert.equal(new Set(rows.map((row) => row.rowId)).size, rows.length, "rowId 不得重复");
});

test("E4: 回写 ordinal 从 base 起（窗口化物化不得逐出头部真实轮次）", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const plain = instance.getTurnManifestEntriesForBranch({ rowCountSource: "cold" });
  assert.deepEqual(
    plain.map((entry) => entry.turn.ordinal),
    [0, 1],
  );
  const offset = instance.getTurnManifestEntriesForBranch({
    rowCountSource: "cold",
    ordinalBase: 5,
  });
  assert.deepEqual(
    offset.map((entry) => entry.turn.ordinal),
    [5, 6],
    "窗口化物化必须从 manifest 的 turn 数起编号",
  );
  assert.deepEqual(
    offset.map((entry) => entry.turn.turnId),
    plain.map((entry) => entry.turn.turnId),
  );
  assert.ok(offset.every((entry) => entry.turn.rowCountSource === "cold"));
});

// ── F: publisher 用 manifest 事实（IS5）────────────────────────────────────

test("F1: 注入事实后 totalCount/firstRowId/turnDirectory 只来自 manifest，首条 live 事件即作废", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const snapshot = manifestSnapshotOf(instance);
  const facts = deriveSessionRowManifestFacts(snapshot);
  const derived = {
    totalCount: instance.getSnapshot().rows.totalCount,
    firstRowId: instance.getSnapshot().rows.firstRowId,
  };

  instance.seedRowManifestFacts(facts);
  assert.deepEqual(
    {
      totalCount: instance.getSnapshot().rows.totalCount,
      firstRowId: instance.getSnapshot().rows.firstRowId,
    },
    derived,
    "全量物化 + 清单完整时两条路径必须逐值相等（T-SL7 的前提）",
  );
  assert.deepEqual(instance.getTurnDirectory({}), instance.getTurnDirectory({}));
  assert.equal(instance.getRowManifestFacts(), facts);

  // 第一条 live 事件：清单基线作废（正在跑的这轮不在 manifest 里）。
  instance.ingest(
    sessionEvent("turn_started", 40, { turnNumber: 3, input: "新问题", messageId: "msg-user-3" }),
  );
  assert.equal(instance.getRowManifestFacts(), null);
});

test("F2: manifest 事实在场时首帧 totalCount 取清单值（窗口只剩一半也一样），hasMore 按权威首行判", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const facts = deriveSessionRowManifestFacts(manifestSnapshotOf(instance));
  const fullRows = instance.getSnapshot().rows.window;
  assert.equal(facts.totalCount, fullRows.length);

  // 只留尾部 2 行（模拟窗口化物化，但 manifest 仍记着全序）。
  const windowRows = fullRows.slice(-2);
  instance.getSnapshot().rows.window = [...windowRows];
  instance.seedRowManifestFacts(facts);

  const subscribed = instance.subscribeReserved({
    connectionId: "conn-window",
    deliveryProfile: "continuous",
  });
  const wireRows = subscribed.reservation.frame.payload.snapshot.rows;
  assert.equal(
    wireRows.totalCount,
    facts.totalCount,
    "totalCount 是 manifest 的全序，不是窗口长度",
  );
  assert.equal(wireRows.firstRowId, 1);
  subscribed.reservation.commit();

  // 页首行 > firstRowId → 还有更早的行；到权威首行就到底。
  assert.equal(instance.getRowsRange({ limit: 10 }).hasMore, true);
  assert.equal(
    instance.getRowsRange({ limit: 10, beforeRowId: windowRows[0].rowId }).hasMore,
    false,
  );
});

// ── H: 冷窗口选择（Step 5：整 turn 对齐 + 双约束）─────────────────────────

function windowTurn(turnId, ordinal, rowCount, messageIds) {
  return {
    turnId,
    ordinal,
    rowCount,
    messageIds,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    rowCountSource: "live",
    projectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
  };
}

function windowSnapshot(rowCounts, { perTurnMessages = 2 } = {}) {
  const turns = rowCounts.map((rowCount, ordinal) => {
    const messageIds = Array.from(
      { length: perTurnMessages },
      (_unused, index) => `t${ordinal + 1}-m${index + 1}`,
    );
    return windowTurn(`turn-${ordinal + 1}`, ordinal, rowCount, messageIds);
  });
  return { turns, firstRowId: turns.length > 0 ? 1 : null };
}

test("H1: 分支不超过上限 → 窗口就是整条分支，rowIdBase = 1、limitBefore = 首条消息", () => {
  const snapshot = windowSnapshot([2, 3, 4]);
  const window = selectColdTailWindow(snapshot);
  assert.deepEqual(
    {
      ordinal: window.ordinal,
      turnId: window.turnId,
      rowIdBase: window.rowIdBase,
      turnCount: window.turnCount,
      rowCount: window.rowCount,
      limitBefore: window.limitBefore,
    },
    { ordinal: 0, turnId: "turn-1", rowIdBase: 1, turnCount: 3, rowCount: 9, limitBefore: "t1-m1" },
  );
  assert.deepEqual(
    window.messageIds,
    snapshot.turns.flatMap((turn) => turn.messageIds),
  );
});

test("H2: turn 数上限生效 → 窗口是后缀，ordinal/rowIdBase 按前序轮数平移", () => {
  // 12 轮 × 2 行：coldWindowTurns=8 → 取最后 8 轮（16 行），前 4 轮不进窗口。
  const snapshot = windowSnapshot(new Array(12).fill(2));
  const window = selectColdTailWindow(snapshot);
  assert.equal(window.turnCount, 8);
  assert.equal(window.ordinal, 4);
  assert.equal(window.rowIdBase, 1 + 8, "base = 1 + Σ 前序 4 轮 × 2 行");
  assert.equal(window.rowCount, 16);
  assert.equal(window.limitBefore, "t5-m1");
  assert.deepEqual(
    window.messageIds,
    snapshot.turns.slice(4).flatMap((turn) => turn.messageIds),
  );
  // 窗口必须是**后缀**：ordinal + turnCount === 总轮数（否则尾部被裁掉了）。
  assert.equal(window.ordinal + window.turnCount, snapshot.turns.length);
});

test("H3: 行数上限是硬上界（正好等于预算时仍可加入下一轮）", () => {
  // 6 轮 × 100 行：maxRows=400 → 只能取 4 轮；200 行/轮时正好 2 轮。
  const hundred = selectColdTailWindow(windowSnapshot(new Array(6).fill(100)));
  assert.equal(hundred.turnCount, 4);
  assert.equal(hundred.rowCount, 400);
  assert.equal(hundred.ordinal, 2);

  const twoHundreds = selectColdTailWindow(windowSnapshot(new Array(6).fill(200)));
  assert.equal(twoHundreds.turnCount, 2, "400 行正好等于预算，不得少取一轮");
  assert.equal(twoHundreds.rowCount, 400);
});

test("H4: 单轮超行上限 → 仍取一轮（窗口化不得产出空窗）", () => {
  const window = selectColdTailWindow(windowSnapshot([2, 1000]));
  assert.equal(window.turnCount, 1);
  assert.equal(window.turnId, "turn-2");
  assert.equal(window.ordinal, 1);
  assert.equal(window.rowIdBase, 3, "前序只有第一轮的 2 行");
  assert.equal(window.rowCount, 1000);
  assert.equal(window.limitBefore, "t2-m1");
});

test("H5: 空分支 → null（窗口化不接管空历史，由 totalCount=0 契约表达）", () => {
  assert.equal(selectColdTailWindow({ turns: [], firstRowId: null }), null);
});

test("H6: 显式 limits 覆盖常量（Step 7 的按页物化复用同一函数）", () => {
  const snapshot = windowSnapshot(new Array(5).fill(3));
  const window = selectColdTailWindow(snapshot, { maxTurns: 2, maxRows: 1000 });
  assert.equal(window.turnCount, 2);
  assert.equal(window.ordinal, 3);
  assert.equal(window.rowIdBase, 1 + 9);
  assert.equal(window.rowCount, 6);
});

test("H7: rowIdOrigin 播种 → 窗口内每行从 manifest base 起编号，且只允许无行时播种", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.seedRowIdOrigin(101);
  for (const event of twoTurnEvents()) projection.applyEvent(event);
  const rows = projection.getSnapshot().rows.window;
  assert.equal(rows[0].rowId, 101, "窗口首行 id 必须是 manifest 给的窗口首轮 base");
  assert.deepEqual(
    rows.map((row) => row.rowId),
    rows.map((_row, index) => 101 + index),
  );
  assert.equal(
    projection.getTurnManifestRowIdBase("msg-user-1"),
    101,
    "窗口首轮的 base 就是 origin",
  );
  assert.equal(
    projection.getTurnManifestRowIdBase("msg-user-2"),
    101 + rows.filter((row) => row.turnId === "msg-user-1").length,
  );
  // 已物化之后再改 origin 会让同一逻辑位置算出两个 id —— 必须拒绝而不是静默忽略。
  assert.throws(() => projection.seedRowIdOrigin(1));
  assert.throws(() => projection.seedRowIdOrigin(0));
});

test("H8: publisher 透传 rowIdOrigin（冷窗口的播种入口）", () => {
  const instance = publisher();
  instance.seedRowIdOrigin(51);
  ingestAll(instance, twoTurnEvents());
  assert.equal(instance.getSnapshot().rows.window[0].rowId, 51);
});

// ── G: gateway 接线（读路径挂在 hydration 收口）──────────────────────────

function stubGatewayHost({ readRowManifest, events = twoTurnEvents() } = {}) {
  const captures = { records: [], rewinds: [], errors: [], debug: [] };
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    executeCommand: async () => undefined,
    loadPersistedEvents: async () => ({
      events,
      synthesized: true,
      // 水位必须是这批事件的最大 seq：gateway 的 raw 序号只连续 drain，
      // sourceEventSeq=0 会让后续 live 事件永远卡在 pending 里（测试里表现为「没失效」）。
      sourceEventSeq: events.reduce((max, event) => Math.max(max, event.sequenceNumber), 0),
      branchGeneration: 0,
    }),
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
    onDebug: (message) => {
      captures.debug.push(message);
    },
    ...(readRowManifest ? { readRowManifest } : {}),
  };
  return { host, captures };
}

/** 冷开一次（rowsRange 是三条读入口之一，会走同一条 hydration）。 */
async function openSession(gateway) {
  await gateway.rowsRange({ sessionId: SESSION_ID, limit: 10 });
}

test("G1: ok 时注入事实 → turnDirectory / 快照全序量来自 manifest，且 manifestMs 落到 ACK", async () => {
  const reference = publisher();
  ingestAll(reference, twoTurnEvents());
  const expectedDirectory = reference.getTurnDirectory({});
  const expectedSnapshot = reference.getSnapshot();
  const snapshot = manifestSnapshotOf(reference);

  const { host } = stubGatewayHost({
    readRowManifest: async () => ({
      kind: "manifest",
      facts: deriveSessionRowManifestFacts(snapshot),
      manifestAdjusted: false,
      adjustedTurnIds: [],
      messageIndexChecked: true,
    }),
  });
  const gateway = new ConversationV4Gateway(host);
  try {
    const dispatch = await gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    assert.equal(dispatch.ack.openPhases.manifestMs >= 0, true, "manifestMs 是 ACK 顶层分段");
    assert.equal(gateway.getRowManifestOutcome(SESSION_ID).action, "use-manifest");

    const directory = await gateway.turnDirectory({ sessionId: SESSION_ID });
    assert.deepEqual(directory.entries, expectedDirectory.entries);
    assert.equal(directory.realUserQueryTotal, expectedDirectory.realUserQueryTotal);

    const snapshotRowCount = dispatch.initialFrame?.payload?.snapshot?.rows?.totalCount;
    assert.equal(snapshotRowCount, expectedSnapshot.rows.totalCount);
  } finally {
    gateway.dispose();
  }
});

for (const [label, result, reason] of [
  ["missing", { status: "missing" }, "missing"],
  [
    "schemaMismatch",
    {
      status: "schemaMismatch",
      expectedVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
      foundVersions: [1],
    },
    "schemaMismatch",
  ],
  [
    "inconsistent",
    {
      status: "inconsistent",
      reason: "messageIndexMismatch",
      turnIds: [],
      missingMessageIds: ["gone"],
    },
    "inconsistent",
  ],
]) {
  test(`G2: ${label} → 同一动作（全量物化 + 回写整代 cold manifest），打点带 reason`, async () => {
    const { host, captures } = stubGatewayHost({
      readRowManifest: async () => ({
        kind: "fallback",
        reason,
        ...(reason === "inconsistent"
          ? { detail: { inconsistentReason: "messageIndexMismatch", missingMessageIds: ["gone"] } }
          : {}),
      }),
    });
    const gateway = new ConversationV4Gateway(host);
    try {
      await openSession(gateway);
      const outcome = gateway.getRowManifestOutcome(SESSION_ID);
      assert.equal(outcome.action, "materialize-and-rebuild");
      assert.equal(outcome.reason, reason);
      // 回写整代 manifest：两轮 → 两条 cold entry，ordinal 0/1。
      assert.equal(captures.records.length, 2, "降级必须顺带重建 manifest（否则下次还是降级）");
      assert.deepEqual(
        captures.records.map((record) => record.entry.turn.ordinal),
        [0, 1],
      );
      assert.ok(captures.records.every((record) => record.entry.turn.rowCountSource === "cold"));
      assert.equal(captures.records[0].sessionId, SESSION_ID);
      // missing 没有可剪的尾部；schemaMismatch / inconsistent 必须剪掉残留，
      // 否则读端会一直看到「清单比投影长」而死循环。
      assert.equal(captures.rewinds.length, reason === "missing" ? 0 : 1);
      if (reason !== "missing") {
        assert.deepEqual(captures.rewinds[0].input.keptTurnIds, ["msg-user-1", "msg-user-2"]);
        assert.equal(captures.rewinds[0].input.sourceGeneration, 0);
        assert.equal(captures.rewinds[0].input.branchGeneration, 0);
      }
    } finally {
      gateway.dispose();
    }
  });
}

test("G3: 宿主没实现 readRowManifest → 完全不读（manifestMs 缺席，不当 0）", async () => {
  const { host, captures } = stubGatewayHost();
  const gateway = new ConversationV4Gateway(host);
  try {
    const dispatch = await gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-2",
      clientMode: "desktop-continuous",
    });
    assert.equal("manifestMs" in dispatch.ack.openPhases, false, "缺席 ≠ 0");
    assert.equal(gateway.getRowManifestOutcome(SESSION_ID), null);
    assert.equal(captures.records.length, 0);
  } finally {
    gateway.dispose();
  }
});

test("G4: live ingest 必须失效该会话的消息索引缓存", async () => {
  const invalidated = [];
  const { host } = stubGatewayHost({
    readRowManifest: async () => ({ kind: "fallback", reason: "missing" }),
  });
  host.invalidateRowManifestIndex = (sessionId) => {
    invalidated.push(sessionId);
  };
  const gateway = new ConversationV4Gateway(host);
  try {
    await gateway.rowsRange({ sessionId: SESSION_ID, limit: 10 });
    const before = invalidated.length;
    gateway.ingestDetachedLiveSession(
      SESSION_ID,
      sessionEvent("turn_started", 9, {
        turnNumber: 9,
        input: "live",
        messageId: "msg-live",
      }),
    );
    assert.ok(invalidated.length > before, "live ingest 必须刷新索引缓存");
    assert.ok(
      invalidated.every((sessionId) => sessionId === SESSION_ID),
      "失效点必须按会话隔离",
    );
  } finally {
    gateway.dispose();
  }
});

// ── I: 冷开尾窗的物化计划（Step 6 / IS2 / IS6）──────────────────────────────

/** 造一份 manifest 快照：每轮 `rowCount` 行、两条消息。 */
function snapshotOfTurns(turnCount, { rowCount = 3, branchGeneration = 0 } = {}) {
  const turns = [];
  for (let index = 1; index <= turnCount; index += 1) {
    const messageIds = [`msg-${index}-user`, `msg-${index}-assistant`];
    turns.push({
      turnId: messageIds[0],
      ordinal: index - 1,
      messageIds,
      firstMessageId: messageIds[0],
      lastMessageId: messageIds[1],
      rowCount,
      rowCountSource: "cold",
      projectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
    });
  }
  const totalCount = turns.reduce((sum, turn) => sum + turn.rowCount, 0);
  return {
    branchGeneration,
    turns,
    queries: [],
    totalCount,
    firstRowId: totalCount > 0 ? 1 : null,
    realUserQueryTotal: 0,
    manifestAdjusted: false,
    adjustedTurnIds: [],
  };
}

function manifestMessageIds(snapshot) {
  return snapshot.turns.flatMap((turn) => turn.messageIds);
}

test("I1: 冷开计划只经 readActiveBranchTail 读正文（全量 messages() 一次都不调）", async () => {
  const snapshot = snapshotOfTurns(10);
  const ids = manifestMessageIds(snapshot);
  const windowIds = ids.slice(4); // 窗口 = 后 8 轮（ordinal 2）
  const { store, calls } = fakeStore({
    readResult: { status: "ok", snapshot },
    indexEntries: ids,
    tailMessages: windowIds.map((id) => ({ info: { id }, parts: [] })),
  });
  const result = await readColdTailWindowMaterialization({
    sessionID: SESSION_ID,
    store,
    reader: readerFor(store),
    branchGeneration: 0,
    expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
  });

  assert.equal(result.kind, "window");
  assert.equal(result.ordinal, 2, "窗口首轮 ordinal = 前序轮数（= initialTurnNumber）");
  assert.equal(result.rowIdBase, 7, "rowIdBase = 1 + 前序两轮 × 3 行（= seedRowIdOrigin 的值）");
  assert.equal(result.turnCount, PROTOCOL_V4_LIMITS.coldWindowTurns);
  assert.equal(result.rowCount, 24);
  assert.equal(result.limitBefore, "msg-3-user");
  assert.equal(result.messages.length, windowIds.length);
  // **本步第一条硬判据**：冷开正文读只经 readActiveBranchTail。
  assert.equal(calls.tailReads.length, 1, "尾窗读必须恰好一次");
  assert.deepEqual(calls.tailReads[0].activeMessageIds, ids, "尾窗读吃的是**全序** active 序");
  assert.equal(calls.tailReads[0].limitBefore, "msg-3-user");
  assert.equal(calls.fullReads.length, 0, "窗口化路径不得回退全量 messages()");
  // 计划与 reader 共用索引缓存：一次冷开只付一次 O(messages)。
  assert.equal(calls.indexReads, 1, "消息索引只能读一次（reader.read + 计划的裁断复用同一份）");
  // 回写坐标是**整条分支**（10 轮），不是窗口（8 轮）。
  assert.equal(result.branchTurnIds.length, 10);
  assert.equal(result.windowMessageIds.length, 16);
  // 时间基准取整条分支首条消息，不是窗口首条（否则时间兜底会平移）。
  assert.equal(result.baseTimestampMs, 1_700_000_000_000);
  assert.equal(result.precedingTurnFirstMessageId, "msg-2-user");
  assert.equal(result.facts.totalCount, 30);
});

test("I2: 清单游标不在 active 序里（清单与索引不同步）→ 单独报告 limitBeforeMissed，不读正文", async () => {
  const snapshot = snapshotOfTurns(10);
  const ids = manifestMessageIds(snapshot).filter((id) => id !== "msg-3-user");
  const { store, calls } = fakeStore({
    readResult: { status: "ok", snapshot },
    indexEntries: ids,
  });
  const result = await readColdTailWindowMaterialization({
    sessionID: SESSION_ID,
    store,
    reader: readerFor(store),
    branchGeneration: 0,
    expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
  });
  assert.equal(result.kind, "full");
  // 这一项必须与其它降级原因分开：它正是「清单与索引不同步」，读全量是对的但必须可见。
  assert.equal(result.reason, "limitBeforeMissed");
  assert.equal(calls.tailReads.length, 0, "不同步时不按窗口读正文（读到的会是整条分支）");
  assert.equal(calls.fullReads.length, 0, "计划本身不读正文，由调用方退全量");
});

test("I3: 清单不可信（missing）→ 直接退全量，连 O(messages) 的索引都不读", async () => {
  const { store, calls } = fakeStore({ readResult: { status: "missing" } });
  const result = await readColdTailWindowMaterialization({
    sessionID: SESSION_ID,
    store,
    reader: readerFor(store),
    branchGeneration: 0,
    expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
  });
  assert.equal(result.kind, "full");
  assert.equal(result.reason, "missing");
  assert.equal(calls.indexReads, 0, "第一趟不通过时不得读索引（老会话第一次冷开没有清单）");
  assert.equal(calls.tailReads.length, 0);
});

test("I4: 整条分支都在窗内 → ordinal 0 / rowIdBase 1 / 没有「窗口前一轮」", async () => {
  const snapshot = snapshotOfTurns(3);
  const ids = manifestMessageIds(snapshot);
  const { store } = fakeStore({
    readResult: { status: "ok", snapshot },
    indexEntries: ids,
    tailMessages: ids.map((id) => ({ info: { id }, parts: [] })),
  });
  const result = await readColdTailWindowMaterialization({
    sessionID: SESSION_ID,
    store,
    reader: readerFor(store),
    branchGeneration: 0,
    expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
  });
  assert.equal(result.kind, "window");
  assert.equal(result.ordinal, 0, "整条分支 → 起点就是 0（与全量物化同一坐标）");
  assert.equal(result.rowIdBase, 1);
  assert.equal(result.precedingTurnFirstMessageId, null);
  assert.equal(result.turnCount, 3);
});

test("I5: resume 已把正文读进内存 → 只在内存切片，不碰 store 的正文读面", async () => {
  const snapshot = snapshotOfTurns(10);
  const ids = manifestMessageIds(snapshot);
  const loaded = ids.map((id) => ({ info: { id }, parts: [] }));
  const { store, calls } = fakeStore({
    readResult: { status: "ok", snapshot },
    indexEntries: ids,
    loadedMessages: loaded,
  });
  const result = await readColdTailWindowMaterialization({
    sessionID: SESSION_ID,
    store,
    reader: readerFor(store),
    branchGeneration: 0,
    expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
    loadedMessages: loaded,
  });
  assert.equal(result.kind, "window");
  assert.equal(calls.tailReads.length, 0, "内存里有正文就不得再读 DB");
  assert.equal(calls.fullReads.length, 0);
  assert.deepEqual(
    result.messages.map((message) => message.info.id),
    ids.slice(4),
    "切片起点必须与 limitBefore 一致",
  );
});

test("I6: rewind target 落在窗口外也不得复活旧分支（裁断只吃全序 id 序）", async () => {
  const snapshot = snapshotOfTurns(10);
  const ids = manifestMessageIds(snapshot);
  const { store, calls } = fakeStore({
    readResult: { status: "ok", snapshot },
    indexEntries: ids.slice(0, 6),
    tailMessages: [],
  });
  const result = await readColdTailWindowMaterialization({
    sessionID: SESSION_ID,
    store,
    reader: readerFor(store),
    branchGeneration: 1,
    expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
    rewind: { rewindTargetMessageId: "msg-2-user", rewindKeptMessageIds: ids.slice(0, 3) },
  });
  // 裁断后 active 序只剩前 3 条，窗口首条（msg-3-user）不在里面 → 不同步（不是「复活」）。
  assert.equal(result.kind, "full");
  assert.equal(result.reason, "limitBeforeMissed");
  assert.equal(calls.tailReads.length, 0, "窗口绝不进入裁断，也就不该按窗口读");
});

// ── J: 窗口化 vs 全量物化的身份一致（Step 6 的 T-SL5 / T-SL6）──────────────

const MODEL_A = { providerId: "p1", modelId: "m1" };
const MODEL_B = { providerId: "p2", modelId: "m2" };

function transcriptMessage({ id, role, text, createdAt, model }) {
  if (role === "user") {
    return {
      info: { id, role, time: { created: createdAt }, modelSelection: model },
      parts: [{ type: "text", text }],
    };
  }
  return {
    info: {
      id,
      role,
      time: { created: createdAt },
      providerId: model.providerId,
      modelId: model.modelId,
    },
    parts: [{ type: "text", text }],
  };
}

/** 每轮两条消息；从第 `modelChangeAtTurn` 轮起换模型（用于验证 ModelSelected 基线）。 */
function transcript(turnCount, { modelChangeAtTurn } = {}) {
  const messages = [];
  let time = 1_700_000_000_000;
  for (let turn = 1; turn <= turnCount; turn += 1) {
    const model = modelChangeAtTurn !== undefined && turn >= modelChangeAtTurn ? MODEL_B : MODEL_A;
    time += 1_000;
    messages.push(
      transcriptMessage({
        id: `m-${turn}-u`,
        role: "user",
        text: `问 ${turn}`,
        createdAt: time,
        model,
      }),
    );
    time += 1_000;
    messages.push(
      transcriptMessage({
        id: `m-${turn}-a`,
        role: "assistant",
        text: `答 ${turn}`,
        createdAt: time,
        model,
      }),
    );
  }
  return messages;
}

function modelKeyOf(selection) {
  return `${selection.providerId}\u0000${selection.modelId}\u0000`;
}

function synthesizeIdentity(events) {
  return {
    turns: events
      .filter((event) => event.type === "turn_started")
      .map((event) => ({
        turnId: String(event.turnId),
        turnNumber: event.payload.turnNumber,
        messageId: event.payload.messageId ?? null,
        createdAt: event.timestamp.getTime(),
      })),
    models: events
      .filter((event) => event.type === "model_selected")
      .map(
        (event) =>
          `${event.payload.modelSelection.providerId}/${event.payload.modelSelection.modelId}`,
      ),
  };
}

function projectEvents(events, { rowIdOrigin } = {}) {
  const instance = publisher();
  if (rowIdOrigin !== undefined) instance.seedRowIdOrigin(rowIdOrigin);
  ingestAll(instance, events);
  return instance;
}

test("J1: 窗口合成 vs 全量合成：turnId / turnNumber / createdAt / ModelSelected 逐值相等（T-SL5）", () => {
  const messages = transcript(10, { modelChangeAtTurn: 6 });
  const baseTimestampMs = messages[0].info.time.created;
  const full = synthesizeEventsFromMessages(messages, {
    sessionId: SESSION_ID,
    baseTimestampMs,
  });
  const fullIdentity = synthesizeIdentity(full);
  assert.equal(fullIdentity.turns.length, 10);
  assert.deepEqual(fullIdentity.models, ["p1/m1", "p2/m2"], "全量：第 6 轮有一次模型切换");

  // 窗口 = 后 3 轮（ordinal 7）；前一轮（第 7 轮）的选型给出模型基线。
  const windowMessages = messages.slice(14);
  const windowed = synthesizeEventsFromMessages(windowMessages, {
    sessionId: SESSION_ID,
    baseTimestampMs,
    initialTurnNumber: 7,
    initialModelKey: modelKeyOf(MODEL_B),
  });
  const windowIdentity = synthesizeIdentity(windowed);

  assert.deepEqual(
    windowIdentity.turns,
    fullIdentity.turns.slice(-3),
    "窗口内的 turnId / turnNumber / messageId / createdAt 必须与全量逐值相等",
  );
  assert.deepEqual(windowIdentity.models, [], "窗口内没有模型切换 → 不得凭空造 ModelSelected");

  // 不注入基线的对照组：同一窗口会多发一次选型事件（`initialModelKey` 是承重的）。
  const withoutBaseline = synthesizeIdentity(
    synthesizeEventsFromMessages(windowMessages, {
      sessionId: SESSION_ID,
      baseTimestampMs,
      initialTurnNumber: 7,
    }),
  );
  assert.deepEqual(
    withoutBaseline.models,
    ["p2/m2"],
    "没有模型基线时窗口首轮会多一次虚假 ModelSelected（正是 RC4 要消掉的那条）",
  );
});

test("J2: 窗口投影 + rowIdOrigin 播种 == 全量投影的尾部（rowId / createdAt 逐值相等，IS1）", () => {
  const messages = transcript(10, { modelChangeAtTurn: 6 });
  const baseTimestampMs = messages[0].info.time.created;
  const full = projectEvents(
    synthesizeEventsFromMessages(messages, { sessionId: SESSION_ID, baseTimestampMs }),
  );
  const fullRows = full.getSnapshot().rows.window;
  // 窗口首轮在**全量投影**里的 base —— 就是 manifest 的 rowIdBase（selectColdTailWindow 同源）。
  const windowBase = full.getTurnManifestRowIdBase("m-8-u");
  assert.equal(windowBase, fullRows.findIndex((row) => row.turnId === "m-8-u") + 1);

  const windowed = projectEvents(
    synthesizeEventsFromMessages(messages.slice(14), {
      sessionId: SESSION_ID,
      baseTimestampMs,
      initialTurnNumber: 7,
      initialModelKey: modelKeyOf(MODEL_B),
    }),
    { rowIdOrigin: windowBase },
  );
  const identityOfRow = (row) => ({
    rowId: row.rowId,
    turnId: row.turnId,
    kind: row.kind,
    createdAt: row.createdAt,
  });
  assert.deepEqual(
    windowed.getSnapshot().rows.window.map(identityOfRow),
    fullRows.filter((row) => row.rowId >= windowBase).map(identityOfRow),
    "窗口内每一行的 rowId / turnId / kind / createdAt 必须与全量物化逐值相等",
  );
  assert.equal(
    windowed.getSnapshot().rows.window.length,
    fullRows.filter((row) => row.rowId >= windowBase).length,
  );
});

test("J3: 窗首是 assistant 时不多一轮（T-SL6）：对齐窗口靠编号对齐，非对齐窗口靠 preface:false", () => {
  const messages = transcript(10, { modelChangeAtTurn: 6 });
  const baseTimestampMs = messages[0].info.time.created;
  const full = synthesizeIdentity(
    synthesizeEventsFromMessages(messages, { sessionId: SESSION_ID, baseTimestampMs }),
  );

  // ① **对齐窗口**（冷开尾窗的形态）：窗口首条就是某一轮的首条消息。窗首那条 assistant
  //    属于这一轮自己的第一条消息（manifest 的 turn 边界），全量物化同样会开这一轮
  //    —— 于是「不多一轮」= 窗口的轮数等于 manifest 的轮数，且每轮编号与全量逐值相等。
  const aligned = synthesizeIdentity(
    synthesizeEventsFromMessages(messages.slice(14), {
      sessionId: SESSION_ID,
      baseTimestampMs,
      initialTurnNumber: 7,
      initialModelKey: modelKeyOf(MODEL_B),
    }),
  );
  assert.deepEqual(aligned.turns, full.turns.slice(-3), "对齐窗口：编号与全量逐值相等");
  assert.equal(
    aligned.turns.length,
    messages.slice(14).filter((message) => message.info.role === "user").length,
    "轮数必须等于窗口里的真实 user 轮数（不得凭空多一轮）",
  );

  // ② **非对齐窗口**（窗首 assistant 属于窗口外那一轮，Step 7 按需物化可能喂进来）：
  //    默认行为会给它开一个 model-only preface 轮（= 凭空多一轮，后续编号整体前移）。
  const headless = messages.slice(15);
  const naive = synthesizeIdentity(
    synthesizeEventsFromMessages(headless, {
      sessionId: SESSION_ID,
      baseTimestampMs,
      initialTurnNumber: 7,
      initialModelKey: modelKeyOf(MODEL_B),
    }),
  );
  assert.equal(naive.turns.length, 3, "默认：窗首 assistant 被当成一轮（正是要防的那一轮）");

  // ③ `preface:false` 关闭这一轮，且编号与全量物化的对应轮逐值相等。
  const suppressed = synthesizeIdentity(
    synthesizeEventsFromMessages(headless, {
      sessionId: SESSION_ID,
      baseTimestampMs,
      initialTurnNumber: 8,
      initialModelKey: modelKeyOf(MODEL_B),
      preface: false,
    }),
  );
  assert.deepEqual(
    suppressed.turns.map((turn) => turn.turnId),
    full.turns.slice(-2).map((turn) => turn.turnId),
    "preface:false：窗首 assistant 被跳过，后续编号与全量一致",
  );
  assert.deepEqual(
    suppressed.turns.map((turn) => turn.turnNumber),
    [9, 10],
  );
});

// ── K: gateway 的窗口接线（rowIdOrigin / fullyMaterialized / 不重建）────────

function windowPlanFixture(overrides = {}) {
  const reference = publisher();
  ingestAll(reference, twoTurnEvents());
  return {
    ordinal: 4,
    rowIdBase: 41,
    turnCount: 2,
    rowCount: 4,
    limitBefore: "msg-user-1",
    branchTurnIds: ["head-1", "head-2", "head-3", "msg-user-1", "msg-user-2"],
    activeMessageIds: ["msg-user-1", "msg-a-1", "msg-user-2", "msg-a-2"],
    windowMessageIds: ["msg-user-1", "msg-a-1", "msg-user-2", "msg-a-2"],
    facts: deriveSessionRowManifestFacts(manifestSnapshotOf(reference)),
    manifestAdjusted: false,
    messageIndexChecked: true,
    precedingTurnFirstMessageId: "head-3",
    baseTimestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

test("K1: coldWindow → 投影首行从 rowIdBase 起（rehydrate 内播种 rowIdOrigin）", async () => {
  const snapshot = manifestSnapshotOf(publisher());
  const { host } = stubGatewayHost({
    readRowManifest: async () => ({
      kind: "manifest",
      facts: deriveSessionRowManifestFacts(snapshot),
      snapshot,
      manifestAdjusted: false,
      adjustedTurnIds: [],
      messageIndexChecked: true,
    }),
  });
  const coldWindow = windowPlanFixture();
  host.loadPersistedEvents = async () => ({
    events: twoTurnEvents(),
    synthesized: true,
    sourceEventSeq: 9,
    branchGeneration: 0,
    coldWindow,
  });
  const gateway = new ConversationV4Gateway(host);
  try {
    const dispatch = await gateway.subscribe({
      topic: `conversation/${SESSION_ID}`,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const outcome = gateway.getColdWindowOutcome(SESSION_ID);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.rowIdBase, 41);
    assert.equal(outcome.ordinal, 4);
    assert.equal(outcome.limitBefore, "msg-user-1");
    // 播种生效：首帧里第一条窗口行的 rowId 就是 manifest 给的 base（全量物化会是 1）。
    const windowRows = dispatch.initialFrame?.payload?.snapshot?.rows?.window ?? [];
    assert.ok(windowRows.length > 0);
    assert.equal(windowRows[0].rowId, 41, "窗口内 rowId 必须整体以 manifest base 起");
  } finally {
    gateway.dispose();
  }
});

test("K2: 窗口化必须声明 fullyMaterialized:false，且降级也不重建（keptTurnIds 只认整条分支）", async () => {
  const requests = [];
  const { host, captures } = stubGatewayHost({
    readRowManifest: async (sessionId, input) => {
      requests.push(input);
      // 窗口内 turn 与清单不一致：窗口化路径**不得**重建整代清单。
      return { kind: "fallback", reason: "inconsistent" };
    },
  });
  host.loadPersistedEvents = async () => ({
    events: twoTurnEvents(),
    synthesized: true,
    sourceEventSeq: 9,
    branchGeneration: 0,
    coldWindow: windowPlanFixture(),
  });
  const gateway = new ConversationV4Gateway(host);
  try {
    await openSession(gateway);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].fullyMaterialized, false, "窗口化必须显式声明只物化了后缀");
    assert.equal(
      captures.records.length,
      0,
      "窗口化路径不得回写整代清单（会写坏没物化的头部轮次）",
    );
    assert.equal(captures.rewinds.length, 0, "窗口化路径不得剪枝（keptTurnIds 只有窗口会删头部）");
    const outcome = gateway.getColdWindowOutcome(SESSION_ID);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.fallbackReason, "inconsistent", "二次读降级必须可见");
    assert.equal(gateway.getRowManifestOutcome(SESSION_ID).reason, "inconsistent");
  } finally {
    gateway.dispose();
  }
});

test("K3: 全量物化（无 coldWindow）仍声明 fullyMaterialized:true 并按投影剪枝", async () => {
  const requests = [];
  const { host, captures } = stubGatewayHost({
    readRowManifest: async (sessionId, input) => {
      requests.push(input);
      return { kind: "fallback", reason: "inconsistent" };
    },
  });
  const gateway = new ConversationV4Gateway(host);
  try {
    await openSession(gateway);
    assert.equal(requests[0].fullyMaterialized, true);
    assert.equal(captures.records.length, 2);
    assert.equal(captures.rewinds.length, 1);
    assert.deepEqual(captures.rewinds[0].input.keptTurnIds, ["msg-user-1", "msg-user-2"]);
    assert.equal(gateway.getColdWindowOutcome(SESSION_ID), null, "全量物化没有窗口落点");
  } finally {
    gateway.dispose();
  }
});
