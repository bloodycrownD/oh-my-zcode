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
  selectManifestTurnDirectory,
} = await import(new URL("../src/zcode-protocol-v4/session-row-manifest.ts", import.meta.url).href);
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
} = {}) {
  const calls = { manifestReads: [], indexReads: 0 };
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

test("E2: 迟到行（锚在历史轮的 goal verify）后移不撞号，且不改历史轮的 row_count", () => {
  const instance = publisher();
  ingestAll(instance, twoTurnEvents());
  const before = instance.getSnapshot().rows.window;
  const takenIds = new Set(before.map((row) => row.rowId));
  const firstTurnRowCount = instance.getTurnRowCounts().get("msg-user-1");

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

  const marker = instance.getSnapshot().rows.window.at(-1);
  assert.equal(marker.turnId, "msg-user-1");
  assert.equal(takenIds.has(marker.rowId), false, "迟到行不得复用已有 rowId");
  assert.equal(marker.rowId, Math.max(...takenIds) + 1);
  // 迟到行不属于该轮的连续块 → 不改变 manifest 的 row_count（历史事实不可被追加改写）。
  assert.equal(instance.getTurnRowCounts().get("msg-user-1"), firstTurnRowCount);
});

test("E3: clone/adopt（原子提交）搬运 turn 行序，否则 base 归零撞号", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  for (const event of twoTurnEvents()) projection.applyEvent(event);
  const beforeCount = projection.getSnapshot().rows.window.length;
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
    beforeCount + 1,
    "adopt 之后 base 必须接着前序 turn 的行数，不是从 1 重来",
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

// ── G: gateway 接线（读路径挂在 hydration 收口）──────────────────────────

const { TURN_MANIFEST_PROJECTION_SCHEMA_VERSION } = await import(
  new URL("../src/zcode-protocol-v4/turn-manifest-entry.ts", import.meta.url).href
);

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
