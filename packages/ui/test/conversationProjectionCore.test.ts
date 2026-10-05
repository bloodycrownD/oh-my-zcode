// conversationProjectionCore 的可测性用例：合并规范、accumulator 应用包装与
// copy-on-notify 发布（T-AP2 / T-AP3）。
// 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入，只能用相对路径或 `@zcode/*`。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationDeltas,
  conversationDeltaSchema,
  conversationRowSchema,
  conversationSnapshotSchema,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createConversationProjectionAccumulator,
  mergeOlderRows,
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
