// conversationProjectionCore 的可测性用例：合并规范、accumulator 应用包装与
// copy-on-notify 发布（T-AP2 / T-AP3）、renderUnits 增量重建等价性（T-AP4）。
// 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入，只能用相对路径或 `@zcode/*`。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationDeltas,
  conversationDeltaSchema,
  conversationRowSchema,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  createConversationProjectionAccumulator,
  createConversationTurnRenderUnitsCache,
  createTrailingDebouncer,
  mergeOlderRows,
  nextTurnNavigatorDirectoryRevision,
  shouldInvalidateTurnNavigatorDirectory,
  TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS,
  type ConversationTurnRenderUnit,
  type TrailingDebounceTimers,
} from "../src/v4/conversationProjectionCore.js";

/** 最小 userInput 行：mergeOlderRows 只读 rowId/turnId，构造足够即可。 */
function row(rowId: number, turnId = `turn-${rowId}`): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "userInput",
    text: `row-${rowId}`,
    origin: "realUser",
  } as ConversationRow;
}

const ids = (rows: readonly ConversationRow[]): number[] => rows.map((item) => item.rowId);

test("只并入窗口首行之前的行并按 rowId 升序前插", () => {
  const merged = mergeOlderRows([row(10), row(11)], [row(8), row(9)]);
  assert.deepEqual(ids(merged ?? []), [8, 9, 10, 11]);
});

test("窗口内已存在的行不会被 fetched 重复引入", () => {
  // fetched 混入已在窗口内的 10 与窗口之后的 12：都不得进入结果。
  const merged = mergeOlderRows([row(10), row(11)], [row(9), row(10), row(12)]);
  assert.deepEqual(ids(merged ?? []), [9, 10, 11]);
});

test("无可并入行时返回 null，调用方据此不换 window 引用", () => {
  assert.equal(mergeOlderRows([row(10), row(11)], []), null);
  assert.equal(mergeOlderRows([row(10), row(11)], [row(10), row(11), row(12)]), null);
});

test("空窗口时 fetched 全部算更早行（firstRowId 退化为正无穷）", () => {
  assert.deepEqual(ids(mergeOlderRows([], [row(1), row(2)]) ?? []), [1, 2]);
  assert.equal(mergeOlderRows([], []), null);
});

test("合并结果保留 fetched 原始相对顺序与窗口原有行序", () => {
  const older = [row(3, "turn-b"), row(1, "turn-a")];
  const window = [row(5, "turn-c"), row(6, "turn-d")];
  const merged = mergeOlderRows(window, older);
  assert.deepEqual(ids(merged ?? []), [3, 1, 5, 6]);
  // 原窗口数组不被就地修改。
  assert.deepEqual(ids(window), [5, 6]);
});

// ---------------------------------------------------------------------------
// accumulator 应用包装 + copy-on-notify 发布（T-AP2 / T-AP3）
// ---------------------------------------------------------------------------

const BASE_TS = 1_700_000_000_000;

/** 可被 row.delta 追加 text 的流式行（行内容错乱必须看得见，所以用带文本的 kind）。 */
function streamRow(rowId: number, turnId: string, text = ""): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state: "streaming",
  });
}

/**
 * 组一份结构完整的快照。firstRowId 与 totalCount 单列，因为它们正是「前插补拉 /
 * 分页锚点」依赖的两个字段——发布路径一旦漏带，hasOlderRows 就会误判。
 */
function buildSnapshot(
  rows: readonly ConversationRow[],
  options: { seq?: number; firstRowId?: number | null; totalCount?: number } = {},
): ConversationSnapshot {
  const first = options.firstRowId === undefined ? (rows[0]?.rowId ?? null) : options.firstRowId;
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: "sess-projection-core",
    logEpoch: "epoch-1",
    seq: options.seq ?? 100,
    revision: 5,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
      ctxStatus: { allowed: true },
      ctxReduce: { allowed: true },
      ctxExpand: { allowed: true },
      ctxRecomp: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "core 测试", titleSource: "default" },
    config: {
      provider: "test-provider",
      model: "test-model",
      thought: "off",
      followupMode: "queue",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    workflowRuns: { revision: 0, runs: [] },
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window: [...rows],
      totalCount: options.totalCount ?? rows.length,
      firstRowId: first,
    },
  });
}

const delta = (raw: Record<string, unknown>): ConversationDelta => conversationDeltaSchema.parse(raw);

/** 行文本按 rowId 建索引：错位断言要能直接指出「文本跑到了哪一行」。 */
const textsByRowId = (rows: readonly ConversationRow[]): Map<number, string> =>
  new Map(
    rows.map((item) => [
      item.rowId,
      item.kind === "assistantText" || item.kind === "reasoning" ? item.text : "",
    ]),
  );

test("T-AP2 mergeOlderRows 后 rebuild：后续 row.delta 写入正确位置", () => {
  const base = buildSnapshot(
    [streamRow(10, "turn-c", "c"), streamRow(11, "turn-d", "d"), streamRow(12, "turn-e", "e")],
    // 首行 rowId 10 ≠ firstRowId 1：模拟「还有更早历史」的冷快照尾窗。
    { firstRowId: 1, totalCount: 40 },
  );
  const accumulator = createConversationProjectionAccumulator(base);
  const published = accumulator.publish();

  // store 的 loadOlder / loadAllOlder 收口：mergeOlderRows 换掉 window 数组 → 必须 rebuild。
  const window = mergeOlderRows(published.rows.window, [streamRow(8, "turn-a", "a"), streamRow(9, "turn-b", "b")]);
  assert.ok(window, "前插补拉必须产出新窗口");
  const merged = { ...published, rows: { ...published.rows, window } };

  const rebuilt = createConversationProjectionAccumulator(merged);
  const deltas = [
    delta({ op: "row.delta", rowId: 9, path: "text", append: "乙" }),
    delta({ op: "row.delta", rowId: 11, path: "text", append: "丁" }),
    delta({ op: "row.delta", rowId: 12, path: "text", append: "戊" }),
    delta({ op: "row.appended", row: streamRow(13, "turn-f", "f") }),
  ];
  const next = rebuilt.applyDeltas(deltas, 101);

  // 不可变实现当裁判：包装必须与 applyConversationDeltas 逐字节等价。
  assert.deepStrictEqual(next, { ...applyConversationDeltas(merged, deltas), seq: 101 });

  // 钉死「不静默错乱」：每段追加必须落在自己那一行，前插后下标整体位移也不能错位。
  assert.deepStrictEqual(
    [...textsByRowId(next.rows.window).entries()],
    [
      [8, "a"],
      [9, "b乙"],
      [10, "c"],
      [11, "d丁"],
      [12, "e戊"],
      [13, "f"],
    ],
  );

  // 反证：漏掉 rebuild（拿 rebuild 之前的累加器直接施加）就会命中「行不存在 → no-op」，
  // 文本永远不出现——正是那种不报错、只慢慢错位的失败。
  const stale = createConversationProjectionAccumulator(base);
  const staleNext = stale.applyDeltas(deltas, 101);
  assert.equal(textsByRowId(staleNext.rows.window).get(9), undefined);
  assert.equal(textsByRowId(staleNext.rows.window).get(11), "d丁");
});

test("T-AP2 rebuild 之后 firstRowId / totalCount 随发布外壳带出", () => {
  const base = buildSnapshot([streamRow(10, "turn-c", "c")], { firstRowId: 1, totalCount: 40 });
  const accumulator = createConversationProjectionAccumulator(base);
  const published = accumulator.publish();
  assert.equal(published.rows.firstRowId, 1, "hasOlderRows 依赖 firstRowId，发布不能丢");
  assert.equal(published.rows.totalCount, 40, "滚动条估计与 debug 日志依赖 totalCount");

  // append 之后 firstRowId 由 apply 侧维护（`??=`），totalCount +1，两值都得跟着发布出去。
  const next = accumulator.applyDeltas(
    [delta({ op: "row.appended", row: streamRow(11, "turn-c", "d") })],
    101,
  );
  assert.equal(next.rows.firstRowId, 1);
  assert.equal(next.rows.totalCount, 41);
  assert.equal(next.rows.window.length, 2);
});

test("T-AP2 rebuild 之后 row.removed 裁剪仍重建索引并把锚点归零", () => {
  const base = buildSnapshot(
    [streamRow(1, "turn-0", "a"), streamRow(2, "turn-0", "b"), streamRow(3, "turn-0", "c")],
    { firstRowId: 1, totalCount: 3 },
  );
  const accumulator = createConversationProjectionAccumulator(base);
  accumulator.publish();
  // 裁掉整条活跃分支：firstRowId → null、totalCount → 0、window 清空。
  const next = accumulator.applyDeltas([delta({ op: "row.removed", fromRowId: 1 })], 101);
  assert.deepStrictEqual(next.rows.window, []);
  assert.equal(next.rows.firstRowId, null);
  assert.equal(next.rows.totalCount, 0);

  // 索引被裁剪重建后，append + row.delta 仍要命中正确行。
  const tail = accumulator.applyDeltas(
    [
      delta({ op: "row.appended", row: streamRow(7, "turn-1", "x") }),
      delta({ op: "row.delta", rowId: 7, path: "text", append: "y" }),
    ],
    102,
  );
  assert.equal(textsByRowId(tail.rows.window).get(7), "xy");
  assert.equal(tail.rows.firstRowId, 7);
});

test("T-AP3 copy-on-notify：window / rows / snapshot 三层引用全换", () => {
  const base = buildSnapshot([streamRow(1, "turn-0", "甲"), streamRow(2, "turn-0", "乙")]);
  const accumulator = createConversationProjectionAccumulator(base);
  const p0 = accumulator.publish();
  const p1 = accumulator.applyDeltas([delta({ op: "row.delta", rowId: 1, path: "text", append: "A" })], 101);
  const p2 = accumulator.applyDeltas(
    [
      delta({ op: "row.delta", rowId: 1, path: "text", append: "B" }),
      delta({ op: "row.appended", row: streamRow(3, "turn-0", "丙") }),
    ],
    102,
  );

  // 三层各自换新：少换一层，下游对应的那类 memo / effect 就静默不更新。
  assert.notStrictEqual(p1, p0, "snapshot 外壳必须换（[snapshot] effect 依赖）");
  assert.notStrictEqual(p1.rows, p0.rows, "rows 对象必须换");
  assert.notStrictEqual(p1.rows.window, p0.rows.window, "window 数组必须换（[rows.window] memo 依赖）");
  assert.notStrictEqual(p2, p1);
  assert.notStrictEqual(p2.rows, p1.rows);
  assert.notStrictEqual(p2.rows.window, p1.rows.window);

  // 通知之间引用稳定：已发布的外壳不被后续帧的原地变更写穿（accumulator 本体不外泄）。
  assert.equal(textsByRowId(p0.rows.window).get(1), "甲");
  assert.equal(textsByRowId(p1.rows.window).get(1), "甲A");
  assert.deepStrictEqual(p0.rows.window.length, 2, "p0 的窗口长度不得被 p1/p2 的 append 改写");
  assert.deepStrictEqual(p1.rows.window.length, 2, "p1 的窗口长度不得被 p2 的 append 改写");
  assert.deepStrictEqual(p2.rows.window.length, 3);

  // seq 由应用包装显式推进到帧右端点。
  assert.equal(p0.seq, 100);
  assert.equal(p1.seq, 101);
  assert.equal(p2.seq, 102);

  // 内容仍与不可变实现逐字节等价。
  const step1 = [delta({ op: "row.delta", rowId: 1, path: "text", append: "A" })];
  const step2 = [
    delta({ op: "row.delta", rowId: 1, path: "text", append: "B" }),
    delta({ op: "row.appended", row: streamRow(3, "turn-0", "丙") }),
  ];
  assert.deepStrictEqual(p1, { ...applyConversationDeltas(base, step1), seq: 101 });
  assert.deepStrictEqual(p2, { ...applyConversationDeltas(applyConversationDeltas(base, step1), step2), seq: 102 });
});

test("T-AP3 纯 state.updated 帧只换 snapshot 外壳：window / rows 引用保持不变", () => {
  const base = buildSnapshot([streamRow(1, "turn-0", "甲"), streamRow(2, "turn-0", "乙")]);
  const accumulator = createConversationProjectionAccumulator(base);
  const p0 = accumulator.publish();
  const p1 = accumulator.applyDeltas(
    [delta({ op: "state.updated", patch: { revision: 6 } })],
    101,
  );

  // 只换 snapshot 外壳（[snapshot] effect 依赖）；下面两层是本轮收窄掉的：
  // 内容逐行相同的帧每帧换引用，等于让长会话里那批 [rows.window] memo 白失效。
  assert.notStrictEqual(p1, p0, "snapshot 外壳仍必须换");
  assert.strictEqual(p1.rows, p0.rows, "纯 state.updated 帧的 rows 容器必须复用");
  assert.strictEqual(p1.rows.window, p0.rows.window, "纯 state.updated 帧的 window 数组必须复用");
  // 复用不得牺牲内容正确性：水位与 revision 仍按本帧推进。
  assert.equal(p1.seq, 101);
  assert.equal(p1.revision, 6);
  assert.deepStrictEqual(ids(p1.rows.window), [1, 2]);
  // 复用窗口引用的帧之后，一旦有行变更必须立刻换新（不能被复用钉住）。
  const p2 = accumulator.applyDeltas(
    [delta({ op: "row.delta", rowId: 1, path: "text", append: "A" })],
    102,
  );
  assert.notStrictEqual(p2.rows, p1.rows);
  assert.notStrictEqual(p2.rows.window, p1.rows.window);
  assert.equal(textsByRowId(p2.rows.window).get(1), "甲A");
});

test("T-AP3 无行变更帧的 rows 复用必须逐字段等价：窗口外的 row.removed 不动任何标量", () => {
  // fromRowId 落在窗口末行之后 → 一行都没裁掉（变更集为空），apply 也不会改
  // totalCount（removed 按实际裁掉的行数算）。此时 window 与 rows 都可整份复用。
  const base = buildSnapshot(
    [streamRow(10, "turn-c", "c"), streamRow(11, "turn-d", "d")],
    { totalCount: 40 },
  );
  const accumulator = createConversationProjectionAccumulator(base);
  const p0 = accumulator.publish();
  const p1 = accumulator.applyDeltas([delta({ op: "row.removed", fromRowId: 99 })], 101);

  assert.strictEqual(p1.rows, p0.rows, "三个标量都没变，rows 容器可复用");
  assert.strictEqual(p1.rows.window, p0.rows.window, "窗口内容未变，window 引用可复用");
  assert.equal(p1.rows.totalCount, 40);
  assert.deepStrictEqual(ids(p1.rows.window), [10, 11]);
});

test("T-AP3 变更集为空但 rows 标量变了时必须换 rows 容器", () => {
  // 空窗口 + firstRowId 非 null 的冷恢复态：fromRowId 命中 firstRowId 意味着
  // 「整条活动分支被裁掉」，apply 把 totalCount 归零、firstRowId 清空——
  // 但窗口里一行都没有，变更集必然为空。直接复用 rows 会让 hasOlderRows 读到旧值。
  const base = buildSnapshot([], { firstRowId: 1, totalCount: 5 });
  const accumulator = createConversationProjectionAccumulator(base);
  const p0 = accumulator.publish();
  const p1 = accumulator.applyDeltas([delta({ op: "row.removed", fromRowId: 1 })], 101);

  assert.equal(accumulator.lastMutation()?.turnIdByRowId.size, 0, "前置条件：变更集为空");
  assert.notStrictEqual(p1.rows, p0.rows, "标量变了，rows 容器必须换");
  assert.equal(p1.rows.totalCount, 0);
  assert.equal(p1.rows.firstRowId, null);
});

test("T-AP3 publish() 是纯只读：连取两次拿不到会变的外壳", () => {
  const base = buildSnapshot([streamRow(1, "turn-0", "甲")]);
  const accumulator = createConversationProjectionAccumulator(base);
  const first = accumulator.publish();
  const second = accumulator.publish();
  assert.deepStrictEqual(first, second, "内容相同");
  assert.notStrictEqual(first, second, "但每次 publish 都是新外壳");
  assert.notStrictEqual(first.rows, second.rows);
  assert.notStrictEqual(first.rows.window, second.rows.window);
  assert.deepStrictEqual(base, buildSnapshot([streamRow(1, "turn-0", "甲")]), "基线快照不被改写");
});

// ---------------------------------------------------------------------------
// renderUnits 增量重建 ≡ 全量重建（T-AP4）
// ---------------------------------------------------------------------------

function turnHeader(
  rowId: number,
  turnId: string,
  state: "running" | "completedSuccess" | "completedInterrupted" | "failed" = "completedSuccess",
  executionKind: "agent" | "controlOnly" = "agent",
): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    executionKind,
    state,
    startedAt: BASE_TS + rowId,
    activeMs: 1_200,
  });
}

function userRow(rowId: number, turnId: string, text: string): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    text,
    origin: "realUser",
  });
}

function textRow(
  rowId: number,
  turnId: string,
  text: string,
  state: "streaming" | "complete" = "complete",
): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state,
  });
}

function toolRow(
  rowId: number,
  turnId: string,
  status: "running" | "success" = "success",
): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Bash",
    status,
    inputText: "ls",
  });
}

/** 一个普通可渲染轮：header + 用户输入 + 助手正文。 */
function visibleTurn(baseRowId: number, turnId: string): ConversationRow[] {
  return [
    turnHeader(baseRowId, turnId),
    userRow(baseRowId + 1, turnId, `问 ${turnId}`),
    textRow(baseRowId + 2, turnId, `答 ${turnId}`),
  ];
}

/** store 视角的 lastMutation：变更行 rowId → turnId。 */
function mutation(entries: readonly [number, string][]): ReadonlyMap<number, string> {
  return new Map(entries);
}

/** 增量结果必须与全量结果逐字段一致（含 workSegments / flowItems 内部结构）。 */
function assertIncrementalEqualsFull(
  actual: readonly ConversationTurnRenderUnit[],
  rows: readonly ConversationRow[],
  options: { sessionPhase?: SessionPhase; scopeKey?: string },
): void {
  assert.deepStrictEqual(
    actual,
    buildConversationTurnRenderUnits(rows, options),
    "增量重建结果必须与全量重建逐字段一致",
  );
}

test("T-AP4 场景一：追加新 turn 致 isLastTurn 翻转（增量 ≡ 全量）", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const options = { sessionPhase: "running" as SessionPhase, scopeKey: "sess-ap4" };
  const before = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b")];

  const first = cache.build(before, options, mutation([[3, "turn-b"]]));
  assertIncrementalEqualsFull(first, before, options);
  assert.deepStrictEqual(
    first.map((unit) => unit.isLastTurn),
    [false, true],
  );

  // 追加第三轮：新轮是 dirty，旧末轮 turn-b 只因 isLastTurn 翻转而必须重算。
  const after = [...before, ...visibleTurn(7, "turn-c")];
  const second = cache.build(after, options, mutation([[7, "turn-c"], [8, "turn-c"], [9, "turn-c"]]));
  assertIncrementalEqualsFull(second, after, options);
  assert.deepStrictEqual(
    second.map((unit) => unit.isLastTurn),
    [false, false, true],
    "旧末轮的 isLastTurn 必须由 true 翻成 false",
  );
  // turn-a 完全没被触及，必须复用上一帧的 unit 对象（这才是增量的收益本身）。
  assert.strictEqual(second[0], first[0], "未变更的轮必须复用缓存输出对象");
  assert.notStrictEqual(second[1], first[1], "isLastTurn 翻转的轮必须重算");
});

test("T-AP4 场景二：末位 turn 被过滤，前一末轮接过 isLastTurn（增量 ≡ 全量）", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const options = { sessionPhase: "running" as SessionPhase, scopeKey: "sess-ap4" };
  // turn-a 可渲染；turn-b 只是一个 controlOnly header，没有可见行、非 running → 被过滤。
  const before = [...visibleTurn(1, "turn-a"), turnHeader(4, "turn-b", "completedSuccess", "controlOnly")];
  const first = cache.build(before, options, mutation([[4, "turn-b"]]));
  assertIncrementalEqualsFull(first, before, options);
  assert.deepStrictEqual(
    first.map((unit) => unit.turnId),
    ["turn-a"],
  );
  assert.deepStrictEqual(
    first.map((unit) => unit.isLastTurn),
    [true],
    "被过滤的末轮不占末位，turn-a 就是末轮",
  );

  // turn-b 拿到可见行：保留集从 1 变 2，turn-a 的 isLastTurn 必须由 true 翻成 false。
  // lastMutation 只点了 turn-b，turn-a 靠「上一帧最后一个 unit 的 turnId」这条锚点失效——
  // 少写这条锚点，这里就会命中 turn-a 的旧条目、末位展开态错一帧。
  const after = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b")];
  const second = cache.build(after, options, mutation([[5, "turn-b"], [6, "turn-b"]]));
  assertIncrementalEqualsFull(second, after, options);
  assert.deepStrictEqual(
    second.map((unit) => unit.turnId),
    ["turn-a", "turn-b"],
  );
  assert.deepStrictEqual(
    second.map((unit) => unit.isLastTurn),
    [false, true],
  );
  assert.notStrictEqual(second[0], first[0], "末位翻转的轮必须重算");
});

test("T-AP4 场景二补：末位仍被过滤时，前一末轮的条目按 isLastTurn 段命中复用", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const options = { sessionPhase: "running" as SessionPhase, scopeKey: "sess-ap4" };
  const before = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b")];
  const first = cache.build(before, options, mutation([[6, "turn-b"]]));
  // 新末轮 turn-c 被过滤：turn-b 的「保留集末位」仍是 true。
  const after = [...before, turnHeader(7, "turn-c", "completedSuccess", "controlOnly")];
  const second = cache.build(after, options, mutation([[7, "turn-c"]]));
  assertIncrementalEqualsFull(second, after, options);
  assert.strictEqual(second[0], first[0], "更早的轮不受末位过滤影响，复用缓存条目");
});

test("T-AP4 每次调用都返回新数组，未变更且非末位的轮复用同一个 unit 对象", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const options = { sessionPhase: "running" as SessionPhase, scopeKey: "sess-ap4" };
  const rows = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b")];
  const first = cache.build(rows, options, mutation([]));
  const second = cache.build(rows, options, mutation([]));
  assert.notStrictEqual(second, first, "输出数组必须每次换新（下游 memo 依赖引用变化）");
  assert.strictEqual(second[0], first[0], "非末位且未变更的轮必须复用");
  // 末位轮每帧都在失效锚点里（isLastTurn 可能翻转），不复用是设计如此。
  assert.notStrictEqual(second[1], first[1]);
});

test("T-AP4 场景三：sessionPhase 迁移改写 running 判定与展开态（增量 ≡ 全量）", () => {
  const cache = createConversationTurnRenderUnitsCache();
  // 冷恢复尾窗：只有 userInput + 一个 running toolCall，没有 turnHeader。
  const rows = [userRow(1, "turn-a", "问"), toolRow(2, "turn-a", "running")];
  const runningOptions = { sessionPhase: "running" as SessionPhase, scopeKey: "sess-ap4" };
  const first = cache.build(rows, runningOptions, mutation([[2, "turn-a"]]));
  assertIncrementalEqualsFull(first, rows, runningOptions);
  assert.equal(first[0]?.isRunning, true);

  // 同一份行，phase 迁移到 error：resolveTurnRunning 的终态分支必须接管，
  // 否则缺 header 的冷恢复尾窗会把已终态会话重新推成 running。
  const errorOptions = { sessionPhase: "error" as SessionPhase, scopeKey: "sess-ap4" };
  const second = cache.build(rows, errorOptions, mutation([]));
  assertIncrementalEqualsFull(second, rows, errorOptions);
  assert.equal(second[0]?.isRunning, false);
  assert.notStrictEqual(second[0], first[0], "phase 迁移必须让该轮重算，不能命中旧缓存条目");
});

test("T-AP4 无 lastMutation 时退化为全量重建，且不会把旧条目当成命中", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const options = { scopeKey: "sess-ap4" };
  const rows = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b")];
  const first = cache.build(rows, options, undefined);
  // 内容相同但换了 turnId：若无 lastMutation 仍复用缓存，就会拿到上一帧的 unit。
  const rewritten = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b-renamed")];
  const second = cache.build(rewritten, options, undefined);
  assertIncrementalEqualsFull(second, rewritten, options);
  assert.deepStrictEqual(
    second.map((unit) => unit.turnId),
    ["turn-a", "turn-b-renamed"],
  );
  assert.notStrictEqual(second[1], first[1]);
});

test("T-AP4 scopeKey 切换清空缓存：不同会话的同名 turnId 不会串号", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const rowsA = visibleTurn(1, "turn-shared");
  const rowsB = [...visibleTurn(1, "turn-shared"), ...visibleTurn(4, "turn-other")];
  const first = cache.build(rowsA, { scopeKey: "sess-a" }, mutation([]));
  assert.equal(cache.size(), 1);
  // 第二个会话同名 turnId，但行内容不同：若缓存没按 scopeKey 清空就会命中上一家的条目。
  const second = cache.build(rowsB, { scopeKey: "sess-b" }, mutation([]));
  assert.equal(second.length, 2);
  assert.deepStrictEqual(second.map((unit) => unit.turnId), ["turn-shared", "turn-other"]);
  assert.notStrictEqual(second[0], first[0]);
  assert.equal(cache.size(), 2);
});

test("T-AP4 已裁剪出窗口的轮不会留在缓存里（缓存有界）", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const options = { scopeKey: "sess-ap4" };
  const rows = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b"), ...visibleTurn(7, "turn-c")];
  cache.build(rows, options, mutation([]));
  assert.equal(cache.size(), 3);
  // row.removed 裁掉 turn-c：缓存必须跟着收缩，否则长会话里缓存无上界增长。
  const trimmed = rows.slice(0, 6);
  cache.build(trimmed, options, mutation([[6, "turn-c"], [7, "turn-c"], [8, "turn-c"]]));
  assert.equal(cache.size(), 2);
});

test("T-AP4 随机 delta 序列下增量 ≡ 全量（含 upsert / row.delta / 裁剪 / 追加）", () => {
  // 固定种子的伪随机：等价性必须在「失效集推导正确」这件事上被反复锤，
  // 而不是只靠三个手工场景。
  let seed = 20261005;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const phases: SessionPhase[] = ["running", "prewarming", "error", "completedInterrupted"];
  const cache = createConversationTurnRenderUnitsCache();
  const options = { sessionPhase: phases[0]!, scopeKey: "sess-fuzz" };

  let rows: ConversationRow[] = [
    ...visibleTurn(1, "turn-0"),
    ...visibleTurn(4, "turn-1"),
    ...visibleTurn(7, "turn-2"),
  ];
  let nextRowId = 10;
  cache.build(rows, options, mutation([]));

  for (let step = 0; step < 60; step += 1) {
    const roll = random();
    const changed: [number, string][] = [];
    if (roll < 0.4) {
      const turnId = `turn-${nextRowId}`;
      const added = [
        turnHeader(nextRowId, turnId, "running"),
        userRow(nextRowId + 1, turnId, `问 ${turnId}`),
        textRow(nextRowId + 2, turnId, `答 ${turnId}`, "streaming"),
      ];
      rows = [...rows, ...added];
      for (const row of added) changed.push([row.rowId, turnId]);
      nextRowId += 3;
    } else if (roll < 0.7) {
      // 对某个 assistantText 行做流式追加：只有该行所属的轮该失效。
      const target = rows.find((row) => row.kind === "assistantText");
      if (target) {
        rows = rows.map((row) =>
          row.rowId === target.rowId && row.kind === "assistantText"
            ? textRow(row.rowId, row.turnId, `${row.text}+`, "streaming")
            : row,
        );
        changed.push([target.rowId, target.turnId]);
      }
    } else if (roll < 0.85) {
      // 裁掉末尾若干行（模拟 row.removed 截断）：被裁行所属的轮也要失效。
      const dropCount = 1 + Math.floor(random() * 3);
      const fromRowId = rows[Math.max(0, rows.length - dropCount)]?.rowId ?? 0;
      const cut = rows.filter((row) => row.rowId < fromRowId);
      for (const row of rows) {
        if (row.rowId >= fromRowId) changed.push([row.rowId, row.turnId]);
      }
      rows = cut;
    } else {
      // phase 迁移：整表按新缓存键重算。
      options.sessionPhase = phases[Math.floor(random() * phases.length)]!;
    }
    const actual = cache.build(rows, options, mutation(changed));
    assertIncrementalEqualsFull(actual, rows, options);
  }
});

// ---------------------------------------------------------------------------
// turn 目录失效代际 + 250ms trailing 重查去抖（T-TD3）
// ---------------------------------------------------------------------------

function frame(deltas: readonly ConversationDelta[]): ConversationTopicFrame {
  return conversationTopicFrameSchema.parse({
    topic: "conversation/sess-projection-core",
    subscriptionId: "sub-td3",
    fromSeq: 100,
    toSeq: 101,
    sentAt: BASE_TS,
    payload: { kind: "deltas", deltas: [...deltas] },
  });
}

function snapshotFrame(): ConversationTopicFrame {
  return conversationTopicFrameSchema.parse({
    topic: "conversation/sess-projection-core",
    subscriptionId: "sub-td3",
    fromSeq: 0,
    toSeq: 100,
    sentAt: BASE_TS,
    payload: { kind: "snapshot", snapshot: buildSnapshot([streamRow(10, "turn-a", "a")]) },
  });
}

/** realUser userInput：目录粒度是用户可见 query，只有它命中才让目录失效。 */
function realUserQueryRow(rowId: number): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId: "turn-b",
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    text: `q-${rowId}`,
    origin: "realUser",
  });
}

/** 非 realUser 的系统上下文行：进得了 projection，但不该出现在 rail 上。 */
function systemContextRow(rowId: number): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId: "turn-b",
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    text: `sys-${rowId}`,
    origin: "goalContinuation",
  });
}

/** 假时钟：不真睡 250ms，只把已排期的回调按后进先出放出来。 */
function fakeClock(): {
  timers: TrailingDebounceTimers;
  runPending: () => void;
  pending: () => number;
} {
  let nextHandle = 1;
  const scheduled = new Map<number, () => void>();
  return {
    timers: {
      setTimeout(handler) {
        const handle = nextHandle++;
        scheduled.set(handle, handler);
        return handle;
      },
      clearTimeout(handle) {
        scheduled.delete(handle as number);
      },
    },
    pending: () => scheduled.size,
    runPending() {
      for (const [handle, handler] of [...scheduled].reverse()) {
        scheduled.delete(handle);
        handler();
      }
    },
  };
}

test("T-TD3 三类失效帧各一例：append / upsert / removed 都让目录代际自增", () => {
  const cases: ReadonlyArray<[string, ConversationTopicFrame]> = [
    ["append", frame([delta({ op: "row.appended", row: realUserQueryRow(20) })])],
    ["upsert", frame([delta({ op: "row.upserted", row: realUserQueryRow(21) })])],
    ["removed", frame([delta({ op: "row.removed", fromRowId: 12 })])],
  ];
  for (const [label, target] of cases) {
    assert.equal(shouldInvalidateTurnNavigatorDirectory(target), true, label);
    assert.equal(nextTurnNavigatorDirectoryRevision(7, target), 8, label);
  }
});

test("T-TD3 snapshot 整体替换同样让目录代际自增", () => {
  const target = snapshotFrame();
  assert.equal(shouldInvalidateTurnNavigatorDirectory(target), true);
  assert.equal(nextTurnNavigatorDirectoryRevision(7, target), 8);
});

test("T-TD3 与目录无关的帧不触发失效：非 realUser 输入与 assistantText 流式", () => {
  const systemContext = frame([delta({ op: "row.appended", row: systemContextRow(22) })]);
  const streaming = frame([delta({ op: "row.delta", rowId: 10, path: "text", append: "更多" })]);
  for (const target of [systemContext, streaming]) {
    assert.equal(shouldInvalidateTurnNavigatorDirectory(target), false);
    assert.equal(nextTurnNavigatorDirectoryRevision(7, target), 7);
  }
});

test("T-TD3 同一帧内多类失效只自增一次（代际是闸门，不是计数器）", () => {
  const target = frame([
    delta({ op: "row.appended", row: realUserQueryRow(20) }),
    delta({ op: "row.upserted", row: realUserQueryRow(21) }),
    delta({ op: "row.removed", fromRowId: 12 }),
  ]);
  assert.equal(nextTurnNavigatorDirectoryRevision(7, target), 8);
});

test("T-TD3 重查去抖写死 250ms trailing", () => {
  assert.equal(TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS, 250);
});

test("T-TD3 revision 连续变更的多次重查被合并为一次查询", () => {
  const clock = fakeClock();
  let queryCount = 0;
  const debouncer = createTrailingDebouncer(
    TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS,
    () => {
      queryCount += 1;
    },
    clock.timers,
  );

  // 三类失效帧各来一次（与上面同款），每次都排一次重查。
  const invalidating = [
    frame([delta({ op: "row.appended", row: realUserQueryRow(20) })]),
    frame([delta({ op: "row.upserted", row: realUserQueryRow(21) })]),
    frame([delta({ op: "row.removed", fromRowId: 12 })]),
  ];
  let revision = 0;
  for (const target of invalidating) {
    const before = revision;
    revision = nextTurnNavigatorDirectoryRevision(revision, target);
    assert.equal(revision, before + 1);
    debouncer.schedule();
  }

  // 三次 schedule 只留一个排期：服务端每次目录查询都是 O(总行数) 的现算。
  assert.equal(revision, 3);
  assert.equal(clock.pending(), 1);
  assert.equal(queryCount, 0);

  clock.runPending();
  assert.equal(queryCount, 1);
  assert.equal(clock.pending(), 0);
  assert.equal(debouncer.pending, false);
});

test("T-TD3 去抖 cancel 能掐掉未执行的重查（store close 时必须清得掉）", () => {
  const clock = fakeClock();
  let queryCount = 0;
  const debouncer = createTrailingDebouncer(
    TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS,
    () => {
      queryCount += 1;
    },
    clock.timers,
  );
  debouncer.schedule();
  assert.equal(debouncer.pending, true);
  debouncer.cancel();
  assert.equal(debouncer.pending, false);
  clock.runPending();
  assert.equal(queryCount, 0);
});
