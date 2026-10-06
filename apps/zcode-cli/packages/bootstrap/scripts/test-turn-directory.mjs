#!/usr/bin/env node
/**
 * Step 15 / T-TD2 —— `v4/conversation/turnDirectory` 服务端派生逻辑的自动化验证。
 *
 * ============================================================================
 * 这一步新出现的失效面
 * ============================================================================
 *
 * turn 目录是 turnNavigator 的**唯一**数据源（宽屏不再 loadAllOlder），因此它的
 * 派生逻辑一旦漂移，rail 会静默地少条目 / 顺序错乱 / 摘要张冠李戴，而正文一切正常：
 *
 *   A. **过滤**：物理 role=user 的行里还有 background/goal/mailbox/synthetic/workflow
 *      等系统来源；目录代表用户主动 query，只认投影明确裁决的 `origin === "realUser"`。
 *   B. **顺序**：目录按 `queryRowId` **升序**（rail 自上而下的时间序）。同族的
 *      `getPlans()` 是降序——照抄方向是这里最可能犯的错。
 *   C. **游标**：entries 是 query 粒度而非 product turn 粒度（同一 turn 的 steer query
 *      各自成条），所以游标落在 queryRowId 上，`beforeQueryRowId` 取**严格更小**的
 *      更早条目；`hasMore` 是「更早方向仍有条目」，不是「这页正好满 limit」。
 *   D. **三态摘要**：turn 内有 assistantText → "text"；否则 turnHeader.state==="running"
 *      → "running"；否则（含**无 header 兜底**）→ "empty"。文案不下发，非 text 态的
 *      assistantPreview 必须恒为空串，否则客户端无法本地化。
 *   E. **realUserQueryTotal**：从全量行现算的权威总数，**不受游标与 limit 影响**——
 *      客户端靠它判「够不够 hydrate 目录」，靠翻页探测 reduce 会误判。
 *   F. **摘要口径**：queryPreview / assistantPreview 必须与 renderer rail 逐字节一致
 *      （同一个 @zcode/shared previewText 的 220 字符 / 2 段）。
 *
 * 两种造数手段并存，缺一不可：
 *   - 「真实事件链」用真的 SessionEvent 灌 publisher，证明派生逻辑吃的是**权威投影
 *     的真实形状**，而不是本测试自造的巧合数据；
 *   - 「合成行」直接换掉投影快照的 rows.window，用来覆盖事件流里造不出来（或不该造）
 *     的形态：origin 家族全集、乱序窗口、同一 turn 多条 steer query、**无 header 兜底**。
 *
 * 运行方式：`npx tsx --test scripts/test-turn-directory.mjs`（**必须**走 tsx，而不是
 * 同目录 `test:magic-context-*` 那套 `node --test` + dist 重定向）。原因是 publisher 的
 * 传递依赖链会摸到 `@zcode/model-option-map`——它和 `@zcode/shared` 一样，`exports`
 * 直接指向 `src/*.ts`，没有 dist 可重定向，裸 node 加载不了。tsx 直接吃源码，顺带
 * 免掉「先 build bootstrap 再跑测试」这道前置。
 */

import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_MAX_PREVIEW_CHARS,
  DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  PROTOCOL_V4_LIMITS,
  buildPreviewText,
  turnDirectoryEntrySchema,
  v4ConversationTurnDirectoryParamsSchema,
  v4ConversationTurnDirectoryResultSchema,
} = await import("@zcode/shared/zcode-protocol-v4");
const { ConversationTopicPublisher } = await import(
  new URL("../src/zcode-protocol-v4/conversation-topic-publisher.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 15 turn directory derivation (T-TD2)"
      : `TEST FAIL — Step 15 turn directory derivation (exit code ${code})`,
  );
});

const SESSION_ID = "ses_td2";
const EPOCH = "epoch-td2";

// ── 造数工具 ────────────────────────────────────────────────────────────────

/** 一个空 publisher（无事件、无订阅）。 */
function publisher() {
  return new ConversationTopicPublisher(SESSION_ID, EPOCH, { now: () => 1_000 });
}

/**
 * 把合成行塞进投影快照的 rows.window。
 *
 * 这是刻意的白盒手段：`getTurnDirectory` 的数据源就是投影的全量行，而投影本身永远
 * 给每个 realUser query 配一条 turnHeader——「无 header 兜底」这条分支在事件流里
 * 不可达，只能这样造。产品投影的 snapshot 是内部可变对象（增量 reducer 就在改它），
 * 这里改的是测试进程内的实例，不触碰任何真实会话。
 */
function withRows(rows) {
  const instance = publisher();
  const snapshot = instance.getSnapshot();
  snapshot.rows.window = rows;
  snapshot.rows.totalCount = rows.length;
  snapshot.rows.firstRowId = rows.length > 0 ? rows[0].rowId : null;
  return instance;
}

let syntheticSeq = 0;

function row(overrides) {
  syntheticSeq += 1;
  return {
    rowId: syntheticSeq,
    turnId: `turn-${syntheticSeq}`,
    entityId: `entity-${syntheticSeq}`,
    productTurnId: `turn-${syntheticSeq}`,
    visibility: "visible",
    createdAt: 1_700_000_000_000 + syntheticSeq,
    createdAtSeq: syntheticSeq,
    ...overrides,
  };
}

function header(turnId, state, rowId) {
  return row({
    ...(rowId === undefined ? {} : { rowId }),
    turnId,
    productTurnId: turnId,
    kind: "turnHeader",
    origin: "userInput",
    state,
    startedAt: 1_700_000_000_000,
  });
}

function query(turnId, text, origin = "realUser", rowId) {
  return row({
    ...(rowId === undefined ? {} : { rowId }),
    turnId,
    productTurnId: turnId,
    kind: "userInput",
    text,
    origin,
  });
}

function assistantText(turnId, text, rowId) {
  return row({
    ...(rowId === undefined ? {} : { rowId }),
    turnId,
    productTurnId: turnId,
    kind: "assistantText",
    text,
    state: "complete",
  });
}

/** N 条互不相干的完整轮（header + query + assistantText），rowId 从 1 起连续。 */
function completedTurns(count, { queryText } = {}) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const turnId = `t${index + 1}`;
    rows.push(header(turnId, "completedSuccess", index * 10 + 1));
    rows.push(
      query(
        turnId,
        queryText ? queryText(index) : `query ${index + 1}`,
        "realUser",
        index * 10 + 2,
      ),
    );
    rows.push(assistantText(turnId, `answer ${index + 1}`, index * 10 + 3));
  }
  return rows;
}

// ── A: 真实事件链 ───────────────────────────────────────────────────────────

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

test("A1: 真实事件链灌出的目录只有 realUser query，assistant 摘要是真正文", () => {
  const instance = publisher();
  instance.ingest(
    sessionEvent("turn_started", 1, {
      turnNumber: 1,
      input: "  帮我看下   这个 bug  ",
      messageId: "msg-user-1",
    }),
  );
  instance.ingest(
    sessionEvent(
      "model_streaming",
      2,
      {
        kind: "text_start",
        assistantMessageId: "msg-assistant-1",
        partId: "part-1",
        delta: "",
        done: false,
      },
      "turn-1",
    ),
  );
  instance.ingest(
    sessionEvent(
      "model_streaming",
      3,
      { kind: "text_delta", delta: "第一段回答。\n\n第二段回答。", done: false },
      "turn-1",
    ),
  );
  instance.ingest(
    sessionEvent(
      "turn_complete",
      4,
      {
        response: "第一段回答。\n\n第二段回答。",
        tokenCount: 12,
        toolCallCount: 0,
        duration: 900,
        resultType: "success",
      },
      "turn-1",
    ),
  );
  // 第二轮来自 background：物理上也是一条 userInput 行，但目录不得收它。
  instance.ingest(
    sessionEvent("turn_started", 5, {
      turnNumber: 2,
      input: "[后台] 任务完成",
      messageId: "msg-bg-1",
      inputSource: "background_task",
    }),
  );
  instance.ingest(
    sessionEvent(
      "turn_complete",
      6,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 5, resultType: "success" },
      "turn-2",
    ),
  );

  const result = instance.getTurnDirectory({});
  assert.equal(result.realUserQueryTotal, 1, "background 来源的 query 不进目录");
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(entry.assistantPreviewKind, "text");
  // 摘要走共享口径：段内连续空白折叠为单空格、保留两段。
  assert.equal(entry.queryPreview, "帮我看下 这个 bug");
  assert.equal(entry.assistantPreview, "第一段回答。\n第二段回答。");
  assert.equal(typeof entry.queryRowId, "number");
  assert.equal(result.hasMore, false);
  assert.equal(result.atLogEpoch, EPOCH);
  assert.equal(result.atSeq, instance.getSnapshot().seq);
  assert.equal(result.atRevision, instance.getSnapshot().revision);
  // 只读三要素：连续两次调用逐字节一致（无状态、超时重发安全）。
  assert.deepEqual(instance.getTurnDirectory({}), result);
  assert.doesNotThrow(() => v4ConversationTurnDirectoryResultSchema.parse(result));
});

// ── B: query 过滤（origin 家族全集）──────────────────────────────────────────

test("B1: 只有 origin==='realUser' 的 userInput 成条，其余系统来源一律排除", () => {
  const rows = [];
  const origins = [
    "realUser",
    "backgroundResult",
    "goalContinuation",
    "mailbox",
    "synthetic",
    "workflowLaunch",
  ];
  origins.forEach((origin, index) => {
    const turnId = `t-${origin}`;
    rows.push(header(turnId, "completedSuccess", index * 10 + 1));
    rows.push(query(turnId, `text-${origin}`, origin, index * 10 + 2));
  });
  // 非 userInput 的行即便 text 长得像 query，也不得成条。
  rows.push(assistantText("t-assistant", "一段正文", 100));

  const result = withRows(rows).getTurnDirectory({});
  assert.deepEqual(
    result.entries.map((entry) => entry.queryPreview),
    ["text-realUser"],
  );
  assert.equal(result.realUserQueryTotal, 1);
});

// ── C: 升序 ────────────────────────────────────────────────────────────────

test("C1: entries 按 queryRowId 升序，与 getPlans 的降序方向无关", () => {
  const ascending = withRows(completedTurns(4)).getTurnDirectory({});
  assert.deepEqual(
    ascending.entries.map((entry) => entry.queryRowId),
    [2, 12, 22, 32],
  );

  // 窗口乱序（投影窗口的物理顺序不该、也不能决定目录方向）。
  const descending = withRows(completedTurns(4).toReversed()).getTurnDirectory({});
  assert.deepEqual(
    descending.entries.map((entry) => entry.queryRowId),
    [2, 12, 22, 32],
    "窗口倒序输入也必须升序输出",
  );
  assert.deepEqual(descending.entries, ascending.entries);
});

// ── D: 游标与 hasMore ───────────────────────────────────────────────────────

test("D1: beforeQueryRowId 只取严格更小的更早条目", () => {
  const instance = withRows(completedTurns(5));
  const all = instance.getTurnDirectory({});
  assert.deepEqual(
    all.entries.map((entry) => entry.queryRowId),
    [2, 12, 22, 32, 42],
  );

  // 严格小于：游标恰好等于某条 queryRowId 时，那一条**不在**结果里。
  const paged = instance.getTurnDirectory({ beforeQueryRowId: 32 });
  assert.deepEqual(
    paged.entries.map((entry) => entry.queryRowId),
    [2, 12, 22],
  );
  assert.equal(paged.hasMore, false, "已翻到顶：更早方向没有条目了");
  assert.equal(paged.realUserQueryTotal, 5, "总数不受游标影响");

  const middle = instance.getTurnDirectory({ beforeQueryRowId: 42 });
  assert.deepEqual(
    middle.entries.map((entry) => entry.queryRowId),
    [2, 12, 22, 32],
  );
  assert.equal(middle.hasMore, false);

  // 游标比最老一条还早 ⇒ 空页，且 hasMore 仍为 false（更早方向确实没有条目）。
  const beforeAll = instance.getTurnDirectory({ beforeQueryRowId: 2 });
  assert.deepEqual(beforeAll.entries, []);
  assert.equal(beforeAll.hasMore, false);
  assert.equal(beforeAll.realUserQueryTotal, 5);
});

test("D2: hasMore 判定的是「更早方向仍有条目」，不是「这页正好满 limit」", () => {
  const instance = withRows(completedTurns(5));
  // limit 截掉的是**最早**的一条，更早方向还剩它 ⇒ hasMore = true。
  const limited = instance.getTurnDirectory({ limit: 4 });
  assert.deepEqual(
    limited.entries.map((entry) => entry.queryRowId),
    [12, 22, 32, 42],
  );
  assert.equal(limited.hasMore, true);

  // 正好取尽（5 条 / limit 5）⇒ 更早方向没有条目 ⇒ hasMore = false。
  const exact = instance.getTurnDirectory({ limit: 5 });
  assert.equal(exact.entries.length, 5);
  assert.equal(exact.hasMore, false);

  // 翻页游标 + limit 的组合：每页都从「游标之前最近 limit 条」取。
  const page2 = instance.getTurnDirectory({ beforeQueryRowId: 32, limit: 2 });
  assert.deepEqual(
    page2.entries.map((entry) => entry.queryRowId),
    [12, 22],
    "游标 32 之前最近的两条是 22 与 12（升序输出）",
  );
  assert.equal(page2.hasMore, true);
  assert.equal(page2.realUserQueryTotal, 5);

  // 逐页往上游标翻，终点必须收敛且不重不漏。
  const walked = [];
  let cursor;
  for (;;) {
    const page = instance.getTurnDirectory(
      cursor === undefined ? {} : { beforeQueryRowId: cursor, limit: 2 },
    );
    walked.unshift(...page.entries.map((entry) => entry.queryRowId));
    if (!page.hasMore) break;
    cursor = page.entries[0].queryRowId;
  }
  assert.deepEqual(walked, [2, 12, 22, 32, 42], "逐页翻完必须恰好覆盖全部条目，不重不漏");
});

test("D3: limit 受 turnDirectoryMaxEntries 封顶，缺省取满上限", () => {
  const instance = withRows(completedTurns(3));
  const capped = instance.getTurnDirectory({
    limit: PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries * 10,
  });
  assert.equal(capped.entries.length, 3);
  assert.equal(capped.hasMore, false);
  // limit=0 / 负数不是合法入参（schema 已挡），但派生层仍不许返回空目录。
  assert.ok(instance.getTurnDirectory({ limit: 0 }).entries.length >= 1);
});

// ── E: realUserQueryTotal ───────────────────────────────────────────────────

test("E1: realUserQueryTotal 从全量行现算，不受游标与 limit 影响", () => {
  const rows = completedTurns(7);
  // 中途掺一条非 realUser query：它进不了 entries，但也不该被算进总数。
  rows.splice(4, 0, query("t-bg", "后台注入", "backgroundResult", 41));
  const instance = withRows(rows);

  assert.equal(instance.getTurnDirectory({}).realUserQueryTotal, 7);
  assert.equal(instance.getTurnDirectory({ limit: 2 }).realUserQueryTotal, 7);
  assert.equal(instance.getTurnDirectory({ beforeQueryRowId: 22 }).realUserQueryTotal, 7);
  assert.equal(instance.getTurnDirectory({ limit: 1, beforeQueryRowId: 62 }).realUserQueryTotal, 7);
});

// ── F: assistantPreviewKind 三态 ────────────────────────────────────────────

test("F1: 三态判定——text / running / empty（已完成）/ empty（无 header 兜底）", () => {
  const rows = [
    header("t-text", "completedSuccess", 1),
    query("t-text", "问题一", "realUser", 2),
    assistantText("t-text", "回答一第一段\n\n回答一第二段", 3),
    assistantText("t-text", "回答一第三段（第三段不应进 2 段上限）", 4),

    header("t-running", "running", 11),
    query("t-running", "问题二", "realUser", 12),
    // running 轮但已有 streaming 正文 ⇒ 仍是 "text"（assistantText 行优先于 header）。
    assistantText("t-running", "回复中（流式）", 13),

    header("t-running2", "running", 21),
    query("t-running2", "问题三", "realUser", 22),

    header("t-done", "completedInterrupted", 31),
    query("t-done", "问题四", "realUser", 32),

    // 无 header 兜底：只有 query 行，没有 turnHeader 也没有 assistantText。
    query("t-orphan", "问题五", "realUser", 41),
  ];
  const result = withRows(rows).getTurnDirectory({});
  assert.deepEqual(
    result.entries.map((entry) => [entry.queryRowId, entry.assistantPreviewKind]),
    [
      [2, "text"],
      [12, "text"],
      [22, "running"],
      [32, "empty"],
      [41, "empty"],
    ],
  );

  const byRowId = new Map(result.entries.map((entry) => [entry.queryRowId, entry]));
  assert.equal(byRowId.get(2).assistantPreview, "回答一第一段\n回答一第二段");
  assert.equal(byRowId.get(12).assistantPreview, "回复中（流式）", "text 态带 streaming 正文");
  // 非 text 态的 assistantPreview 恒为空串：i18n 文案不下发，客户端按枚举自己填。
  assert.equal(byRowId.get(22).assistantPreview, "");
  assert.equal(byRowId.get(32).assistantPreview, "");
  assert.equal(byRowId.get(41).assistantPreview, "", "无 header 兜底同样是 empty 且无摘要");
});

test("F2: 同一 turn 的多条 steer query 各自成条，共享 turn 级 assistant 摘要", () => {
  const instance = withRows([
    header("t-steer", "completedSuccess", 1),
    query("t-steer", "先做 A", "realUser", 2),
    assistantText("t-steer", "A 的回答", 3),
    // guide steer：第二条 query 落进**同一个** product turn，没有新 header。
    query("t-steer", "顺便做 B", "realUser", 4),
  ]);
  const result = instance.getTurnDirectory({});
  assert.equal(result.realUserQueryTotal, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.queryRowId),
    [2, 4],
    "目录粒度是 query，不是 product turn",
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.turnId),
    ["t-steer", "t-steer"],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.assistantPreview),
    ["A 的回答", "A 的回答"],
    "assistant 摘要是 turn 级的，不在服务端猜 guide 分段",
  );
});

// ── G: 摘要口径与 @zcode/shared 同源 ────────────────────────────────────────

test("G1: queryPreview / assistantPreview 与共享 buildPreviewText 逐字节一致", () => {
  const longQuery = `${"前导空白".repeat(30)}  \n\n  ${"x".repeat(400)}\n\n\n\n  尾段`;
  const longAnswer = `${"空白".repeat(20)}\n\n段落一\n\n段落二\n\n段落三`;
  const result = withRows([
    header("t-long", "completedSuccess", 1),
    query("t-long", longQuery, "realUser", 2),
    assistantText("t-long", longAnswer, 3),
  ]).getTurnDirectory({});

  const expectedQuery = buildPreviewText({
    texts: [longQuery],
    fallback: "",
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  });
  const expectedAnswer = buildPreviewText({
    texts: [longAnswer],
    fallback: "",
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  });
  assert.equal(result.entries[0].queryPreview, expectedQuery);
  assert.equal(result.entries[0].assistantPreview, expectedAnswer);
  assert.ok(expectedQuery.length <= DEFAULT_MAX_PREVIEW_CHARS, "摘要必须受 220 字符预算约束");
});

test("G2: 纯空白 query 的 fallback 是空串（服务端不下发占位文案）", () => {
  const result = withRows([
    header("t-blank", "completedSuccess", 1),
    query("t-blank", "   \n\n  \t ", "realUser", 2),
  ]).getTurnDirectory({});
  assert.equal(result.entries[0].queryPreview, "");
  assert.equal(result.entries[0].assistantPreviewKind, "empty");
});

// ── H: 空目录 ──────────────────────────────────────────────────────────────

test("H1: 没有 realUser query 的会话返回空目录但仍是合法 result", () => {
  const instance = withRows([header("t-only", "completedSuccess", 1)]);
  const result = instance.getTurnDirectory({});
  assert.deepEqual(result.entries, []);
  assert.equal(result.realUserQueryTotal, 0);
  assert.equal(result.hasMore, false);
  assert.doesNotThrow(() => v4ConversationTurnDirectoryResultSchema.parse(result));
});

test("H2: 全新会话（零行）同样返回合法空目录", () => {
  const result = publisher().getTurnDirectory({});
  assert.deepEqual(result.entries, []);
  assert.equal(result.realUserQueryTotal, 0);
  assert.equal(result.hasMore, false);
  assert.doesNotThrow(() => v4ConversationTurnDirectoryResultSchema.parse(result));
});

// ── I: schema 数值约束边界（D-1）────────────────────────────────────────────

test("I1: 负数 atSeq / queryRowId 被 schema 拒绝", () => {
  const baseEntry = { turnId: "t", queryRowId: 1, queryPreview: "", assistantPreview: "", assistantPreviewKind: "text" };
  assert.equal(turnDirectoryEntrySchema.safeParse({ ...baseEntry, queryRowId: -1 }).success, false);
  const baseResult = {
    entries: [],
    realUserQueryTotal: 0,
    atSeq: 0,
    atRevision: 0,
    atLogEpoch: "e",
    hasMore: false,
  };
  assert.equal(v4ConversationTurnDirectoryResultSchema.safeParse({ ...baseResult, atSeq: -1 }).success, false);
});

test("I2: limit 超 max 被 params schema 拒绝", () => {
  const base = { sessionId: "s" };
  const overMax = PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries + 1;
  assert.equal(v4ConversationTurnDirectoryParamsSchema.safeParse({ ...base, limit: overMax }).success, false);
  assert.equal(v4ConversationTurnDirectoryParamsSchema.safeParse({ ...base, limit: 0 }).success, false);
  assert.equal(v4ConversationTurnDirectoryParamsSchema.safeParse({ ...base, limit: -1 }).success, false);
  // 边界值：恰好等于 max 与 1 都合法。
  assert.equal(v4ConversationTurnDirectoryParamsSchema.safeParse({ ...base, limit: PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries }).success, true);
  assert.equal(v4ConversationTurnDirectoryParamsSchema.safeParse({ ...base, limit: 1 }).success, true);
});
