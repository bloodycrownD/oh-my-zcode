// T-AP1：applyConversationDeltas（不可变）与 applyConversationDeltasMutable（可变 accumulator）
// 的等价性，以及 C1 的 `statePatchSchema` 键集合封闭不变量。
//
// 放 test/ 而不是 src/：src 会被 tsc emit 进 dist（packages/shared/tsconfig.json 的
// include 只有 "src"），测试是纯消费方不进产物——先例见 packages/services/test/。
// 只用相对路径导入（不用 `@/` 别名），`npx tsx --test` 可直接跑。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationDelta,
  applyConversationDeltas,
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
} from "../src/zcode-protocol-v4/apply.js";
import {
  conversationDeltaSchema,
  statePatchSchema,
  type ConversationDelta,
} from "../src/zcode-protocol-v4/delta.js";
import { conversationRowSchema, type ConversationRow } from "../src/zcode-protocol-v4/rows.js";
import { conversationSnapshotSchema } from "../src/zcode-protocol-v4/snapshot.js";
import type { ConversationSnapshot } from "../src/zcode-protocol-v4/snapshot.js";
import type { StreamablePath } from "../src/zcode-protocol-v4/core.js";

const BASE_TS = 1_700_000_000_000;
const SESSION_ID = "sess-apply-equivalence";

type RowKind =
  | "turnHeader"
  | "userInput"
  | "assistantText"
  | "reasoning"
  | "toolCall"
  | "subagent"
  | "timelineMarker";

const ROW_KINDS: readonly RowKind[] = [
  "turnHeader",
  "userInput",
  "assistantText",
  "reasoning",
  "toolCall",
  "subagent",
  "timelineMarker",
];

const ALL_STREAM_PATHS: readonly StreamablePath[] = [
  "text",
  "inputText",
  "output.text",
  "summaryText",
];

/**
 * conversationRowSchema 还有 artifact / hookInvocation 两种与流式无关的 kind；
 * 本测试只造上面七种，upsert 遇到其它 kind 时退回到随机 kind。
 */
function toRowKind(kind: string): RowKind | undefined {
  return (ROW_KINDS as readonly string[]).includes(kind) ? (kind as RowKind) : undefined;
}

// 每种 kind 真正可被 row.delta 追加的 path。走错 kind 的 path 必须是 no-op，
// 两条实现都要一致地 no-op，所以随机序列里两种都造。
const STREAM_PATHS_BY_KIND: Record<string, readonly StreamablePath[]> = {
  assistantText: ["text"],
  reasoning: ["text"],
  toolCall: ["inputText", "output.text"],
  subagent: ["summaryText"],
};

/** 可复现的伪随机数（mulberry32）：种子固定 → 失败可重放。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  assert.ok(item !== undefined, "pick 的候选集合不得为空");
  return item;
}

function buildRawRow(
  rowId: number,
  turnId: string,
  kind: RowKind,
  text: string,
): Record<string, unknown> {
  const base = { rowId, turnId, createdAt: BASE_TS + rowId, createdAtSeq: rowId };
  switch (kind) {
    case "turnHeader":
      return { ...base, kind, origin: "userInput", state: "running", startedAt: base.createdAt };
    case "userInput":
      return { ...base, kind, text: `query ${rowId}`, origin: "realUser" };
    case "assistantText":
      return { ...base, kind, text, state: "streaming" };
    case "reasoning":
      return { ...base, kind, text, state: "streaming" };
    case "toolCall":
      return {
        ...base,
        kind,
        toolCallId: `tc-${rowId}`,
        toolName: "bash",
        status: "running",
        inputText: text,
        output: { text },
      };
    case "subagent":
      return { ...base, kind, subagentType: "explore", status: "running", summaryText: text };
    case "timelineMarker":
      return { ...base, kind, marker: { type: "goalSet", objective: `objective ${rowId}` } };
  }
}

function makeRow(rowId: number, turnId: string, kind: RowKind, text = ""): ConversationRow {
  return conversationRowSchema.parse(buildRawRow(rowId, turnId, kind, text));
}

function buildControlState(phase: string, canStop: boolean): Record<string, unknown> {
  return {
    phase,
    sessionEnded: !canStop,
    canStop,
    stopState: canStop ? "stoppable" : "idle",
    stopTargetKind: "assistant",
    activeWorks: [],
    lastError: null,
    apiRetry: null,
  };
}

function buildAvailabilityState(): Record<string, unknown> {
  return Object.fromEntries(
    [
      "fork",
      "switchModelConfig",
      "setFollowupMode",
      "queueEdit",
      "sendQueuedNow",
      "pauseGoal",
      "resumeGoal",
      "ctxStatus",
      "ctxReduce",
      "ctxExpand",
      "ctxRecomp",
    ].map((key) => [key, { allowed: true }]),
  );
}

function buildSnapshot(options: { rows?: readonly ConversationRow[] } = {}): ConversationSnapshot {
  const rows = options.rows ? [...options.rows] : [];
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: SESSION_ID,
    logEpoch: "epoch-1",
    seq: 100,
    revision: 5,
    control: buildControlState("running", true),
    availability: buildAvailabilityState(),
    inputRouting: { mode: "startNow" },
    meta: { title: "等价性测试", titleSource: "default" },
    config: { provider: "test-provider", model: "test-model", thought: "off", followupMode: "queue" },
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
      window: rows,
      totalCount: rows.length,
      firstRowId: rows.length > 0 ? rows[0]!.rowId : null,
    },
  });
}

/** state.updated 的 patch 键池：覆盖 statePatchSchema 除 rows/seq/logEpoch 外的全部合法键。 */
const PATCH_BUILDERS: Record<string, (random: () => number, index: number) => unknown> = {
  revision: (random) => Math.floor(random() * 1_000),
  control: (random, index) => buildControlState(index % 2 === 0 ? "running" : "completedSuccess", false),
  sharedContextImport: (random, index) => ({ title: `导入 ${index}` }),
  availability: () => buildAvailabilityState(),
  inputRouting: (random, index) => ({
    mode: index % 2 === 0 ? "enqueue" : "startNow",
    reasonCode: `reason-${index}`,
  }),
  meta: (random, index) => ({ title: `标题 ${index}`, titleSource: "generated" }),
  config: (random, index) => ({
    provider: `provider-${index}`,
    model: `model-${index}`,
    thought: "low",
    followupMode: index % 2 === 0 ? "queue" : "guide",
  }),
  modelTransition: (random, index) => ({
    eventId: `mt-${index}`,
    origin: "registryFallback",
    from: { provider: "p-a", model: "m-a" },
    to: { provider: `p-${index}`, model: `m-${index}` },
  }),
  usage: (random, index) => ({
    contextWindow: { usedTokens: index, maxTokens: 200_000 },
    cumulative: {
      inputTokens: index,
      outputTokens: index * 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  }),
  queue: (random, index) => ({
    items: [],
    autoDrain: index % 2 === 0,
    pauseReason: index % 3 === 0 ? "stopped" : undefined,
  }),
  pendingInteractions: () => [],
  pendingCommands: (random, index) => [
    {
      commandId: `cmd-${index}`,
      clientId: "client-1",
      type: "send",
      state: index % 2 === 0 ? "accepted" : "executing",
      at: BASE_TS + index,
    },
  ],
  backgroundWorks: (random, index) => [
    {
      workId: `work-${index}`,
      kind: "bash",
      title: `后台任务 ${index}`,
      status: "running",
      startedAt: BASE_TS + index,
      anchorRowId: null,
    },
  ],
  subagents: (random, index) => ({
    revision: index,
    childSessionIds: [`child-${index}`],
    running: [],
    endedTotal: index,
  }),
  workflowRuns: (random, index) => ({ revision: index, runs: [] }),
  goal: (random, index) => ({
    targetId: `goal-${index}`,
    objective: "达成目标",
    summaryTitle: null,
    timeUsedSeconds: index,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 1,
    verifications: [],
    iterations: [],
  }),
  plan: (random, index) => ({
    items: [{ id: `step-${index}`, content: "写代码", status: "inProgress" }],
    updatedAt: BASE_TS + index,
  }),
  workspaceHookAdmission: (random, index) =>
    index % 4 === 0 ? null : { pendingCount: index, bundleDigest: `digest-${index}` },
};

/** 随机 patch：一次取 1~3 个键，制造「多条 patch 同帧」与键间独立性。 */
function buildPatch(random: () => number, index: number): Record<string, unknown> {
  const keys = Object.keys(PATCH_BUILDERS).sort(() => random() - 0.5);
  const size = 1 + Math.floor(random() * 3);
  const patch: Record<string, unknown> = {};
  for (const key of keys.slice(0, size)) {
    patch[key] = PATCH_BUILDERS[key]!(random, index);
  }
  return patch;
}

const LEGAL_PATCH_KEYS: ReadonlySet<string> = new Set(
  statePatchSchema.keyof().options as readonly string[],
);

test("G-3 守卫：PATCH_BUILDERS 键集合 == statePatchSchema 除 rows/seq/logEpoch 外的全部键", () => {
  const excluded = new Set(["rows", "seq", "logEpoch"]);
  const expected = [...LEGAL_PATCH_KEYS].filter((key) => !excluded.has(key)).sort();
  const actual = Object.keys(PATCH_BUILDERS).sort();
  // schema 新增状态键而没有补 builder 时，随机 patch 就永远盖不到它——这条守卫让
  // 遗漏在等价性测试里直接红出来，而不是静默缩窄覆盖面。
  assert.deepEqual(actual, expected, "PATCH_BUILDERS 与 statePatchSchema 键集合漂移");
});

/** 初始窗口固定带上四种可流式行，保证每轮随机序列都覆盖到全部 path。 */
function buildInitialRows(random: () => number): ConversationRow[] {
  const prefix: RowKind[] = ["turnHeader", "userInput", "assistantText", "toolCall"];
  const rows = prefix.map((kind, index) => makeRow(index + 1, "turn-0", kind));
  const extra = Math.floor(random() * 6);
  for (let index = 0; index < extra; index += 1) {
    rows.push(makeRow(rows.length + 1, `turn-${Math.floor(index / 3)}`, pick(random, ROW_KINDS)));
  }
  return rows;
}

function pickDeltaPath(random: () => number, targetKind: string | undefined): StreamablePath {
  const legal = targetKind ? STREAM_PATHS_BY_KIND[targetKind] : undefined;
  if (legal && legal.length > 0 && random() < 0.75) return pick(random, legal);
  return pick(random, ALL_STREAM_PATHS);
}

/**
 * 造一串随机 delta：七类 op 混合（五类行/状态 + workflowRun 两 op，G-3 补强）、
 * 乱序、可多条同帧。
 *
 * 「当前哪些 rowId 已在窗口里」用不可变 apply 当参照 oracle 推出来——它就是协议语义的
 * 规范实现（apply.ts 头部），拿它当生成器的观察窗比在测试里复抄一遍裁剪规则更可靠。
 */
function generateDeltaSequence(
  seed: number,
  count: number,
  base: ConversationSnapshot,
): ConversationDelta[] {
  const random = createRandom(seed);
  let shadow = base;
  let nextRowId = base.rows.window.reduce((max, row) => Math.max(max, row.rowId), 0) + 1;
  const deltas: ConversationDelta[] = [];

  for (let index = 0; index < count; index += 1) {
    const live = shadow.rows.window;
    const roll = random();
    let raw: Record<string, unknown>;

    if (live.length === 0 || roll < 0.28) {
      raw = {
        op: "row.appended",
        row: buildRawRow(nextRowId, `turn-${Math.floor(nextRowId / 4)}`, pick(random, ROW_KINDS), ""),
      };
      nextRowId += 1;
    } else if (roll < 0.45) {
      const target = random() < 0.8 ? pick(random, live) : undefined;
      raw = target
        ? {
            op: "row.upserted",
            row: buildRawRow(
              target.rowId,
              target.turnId,
              toRowKind(target.kind) ?? pick(random, ROW_KINDS),
              `upsert-${index}`,
            ),
          }
        : {
            // 未加载 rowId：协议语义是 no-op，两条实现都必须 no-op。
            op: "row.upserted",
            row: buildRawRow(nextRowId + 1_000, "turn-ghost", "assistantText", "ghost"),
          };
    } else if (roll < 0.72) {
      const target = random() < 0.15 ? undefined : pick(random, live);
      raw = {
        op: "row.delta",
        rowId: target ? target.rowId : nextRowId + 2_000,
        path: pickDeltaPath(random, target?.kind),
        append: `-${index}-`,
      };
    } else if (roll < 0.80) {
      raw = { op: "state.updated", patch: buildPatch(random, index) };
    } else if (roll < 0.88) {
      // workflowRun.updated（G-3 补强）：已知 run 出partial header（键级合并路径），
      // 未知 run 出完整 header（出生路径：runId + status + usage 缺一不可）。
      const known = shadow.workflowRuns!.runs;
      const target = known.length > 0 && random() < 0.6 ? pick(random, known) : undefined;
      if (target) {
        raw = {
          op: "workflowRun.updated",
          runId: target.runId,
          revision: shadow.workflowRuns!.revision + 1 + index,
          run: {
            status: pick(random, ["running", "completed", "errored", "stopped"] as const),
            usage: { spentTokens: index, nodesUsed: Math.floor(random() * 8) },
          },
        };
      } else {
        const runId = `run-${index}`;
        raw = {
          op: "workflowRun.updated",
          runId,
          revision: shadow.workflowRuns!.revision + 1 + index,
          run: {
            runId,
            status: "running",
            usage: { spentTokens: 0, nodesUsed: 0 },
          },
        };
      }
    } else if (roll < 0.92) {
      // workflowRun.removed：已知 runId 真删；偶尔打未知的（协议语义 = 容器 revision 跟上）。
      const known = shadow.workflowRuns!.runs;
      const target = known.length > 0 && random() < 0.7 ? pick(random, known) : undefined;
      raw = {
        op: "workflowRun.removed",
        runId: target ? target.runId : `run-ghost-${index}`,
        revision: shadow.workflowRuns!.revision + 1 + index,
      };
    } else {
      const anchor = pick(random, live);
      // anchor+1 / anchor / anchor-1 三种落点：命中该行、命中更早行、以及什么都不删。
      raw = { op: "row.removed", fromRowId: Math.max(0, anchor.rowId + 1 - Math.floor(random() * 3)) };
    }

    // 构造必须过协议 schema：apply 内部不做校验，合法性由本层兜住。
    const delta = conversationDeltaSchema.parse(raw);
    if (delta.op === "state.updated") {
      for (const key of Object.keys(delta.patch)) {
        assert.ok(
          LEGAL_PATCH_KEYS.has(key),
          `生成的 patch 含非法键 ${key}（statePatchSchema 键集合封闭）`,
        );
      }
    }
    deltas.push(delta);
    shadow = applyConversationDelta(shadow, delta);
  }

  return deltas;
}

/**
 * 等价性裁判：逐条施加（每步都比）+ 整批施加，两条路径都必须与不可变版深相等。
 */
function assertDeltasEquivalent(base: ConversationSnapshot, deltas: readonly ConversationDelta[]): void {
  const steps: ConversationSnapshot[] = [];
  let cursor = base;
  for (const delta of deltas) {
    cursor = applyConversationDelta(cursor, delta);
    steps.push(cursor);
  }

  assert.deepStrictEqual(
    applyConversationDeltas(base, deltas),
    cursor,
    "applyConversationDeltas 的批量入口必须与逐条施加一致",
  );

  const incremental = createMutableConversationSnapshotAccumulator(base);
  for (const [index, delta] of deltas.entries()) {
    applyConversationDeltasMutable(incremental, [delta]);
    assert.deepStrictEqual(
      incremental.snapshot,
      steps[index],
      `第 ${index + 1} 条 delta（${delta.op}）后不可变版与可变 accumulator 分叉`,
    );
  }

  const batched = createMutableConversationSnapshotAccumulator(base);
  applyConversationDeltasMutable(batched, deltas);
  assert.deepStrictEqual(
    batched.snapshot,
    cursor,
    "applyConversationDeltasMutable 的批量入口必须与不可变版深相等",
  );
}

test("T-AP1 随机序列：不可变 apply 与可变 accumulator 深相等", () => {
  const rounds = 50;
  const deltasPerRound = 20;
  for (let round = 0; round < rounds; round += 1) {
    const random = createRandom(round + 1);
    const base = buildSnapshot({ rows: buildInitialRows(random) });
    const deltas = generateDeltaSequence(round + 1, deltasPerRound, base);
    assertDeltasEquivalent(base, deltas);
  }
});

test("T-AP1 随机序列覆盖到全部五类 op", () => {
  const seen = new Set<string>();
  for (let round = 0; round < 50; round += 1) {
    const random = createRandom(round + 101);
    const base = buildSnapshot({ rows: buildInitialRows(random) });
    for (const delta of generateDeltaSequence(round + 101, 20, base)) seen.add(delta.op);
  }
  for (const op of ["row.appended", "row.upserted", "row.delta", "state.updated", "row.removed"]) {
    assert.ok(seen.has(op), `随机序列未覆盖 ${op}`);
  }
});

test("边界：removed 截断尾部后再 append", () => {
  const base = buildSnapshot({
    rows: [
      makeRow(1, "turn-0", "turnHeader"),
      makeRow(2, "turn-0", "userInput"),
      makeRow(3, "turn-0", "assistantText"),
      makeRow(4, "turn-0", "toolCall"),
    ],
  });
  const deltas = [
    conversationDeltaSchema.parse({ op: "row.removed", fromRowId: 3 }),
    conversationDeltaSchema.parse({ op: "row.appended", row: buildRawRow(9, "turn-1", "assistantText", "") }),
  ];
  assertDeltasEquivalent(base, deltas);

  const result = applyConversationDeltas(base, deltas);
  assert.deepStrictEqual(
    result.rows.window.map((row) => row.rowId),
    [1, 2, 9],
  );
  assert.equal(result.rows.totalCount, 3);
  assert.equal(result.rows.firstRowId, 1);
});

test("边界：removed 砍掉整条活跃分支后 firstRowId/totalCount 归零，再 append 重建锚点", () => {
  const base = buildSnapshot({
    rows: [makeRow(1, "turn-0", "userInput"), makeRow(2, "turn-0", "assistantText")],
  });
  const deltas = [
    conversationDeltaSchema.parse({ op: "row.removed", fromRowId: 1 }),
    conversationDeltaSchema.parse({ op: "row.appended", row: buildRawRow(7, "turn-1", "userInput", "") }),
  ];
  assertDeltasEquivalent(base, deltas);

  const afterRemove = applyConversationDeltas(base, [deltas[0]!]);
  assert.deepStrictEqual(afterRemove.rows.window, []);
  assert.equal(afterRemove.rows.totalCount, 0);
  assert.equal(afterRemove.rows.firstRowId, null);

  const result = applyConversationDeltas(base, deltas);
  assert.equal(result.rows.firstRowId, 7);
  assert.equal(result.rows.totalCount, 1);
});

test("边界：state.updated 多帧累计 + 键级整体替换（绝不深合并）", () => {
  const base = buildSnapshot({ rows: [makeRow(1, "turn-0", "assistantText")] });
  const deltas = [
    conversationDeltaSchema.parse({
      op: "state.updated",
      patch: { revision: 11, inputRouting: { mode: "enqueue", reasonCode: "queue-busy" } },
    }),
    conversationDeltaSchema.parse({ op: "state.updated", patch: { inputRouting: { mode: "startNow" } } }),
    conversationDeltaSchema.parse({
      op: "state.updated",
      patch: { queue: { items: [], autoDrain: false, pauseReason: "stopped" } },
    }),
  ];
  assertDeltasEquivalent(base, deltas);

  const result = applyConversationDeltas(base, deltas);
  // 第二帧只带 mode：整键替换后 reasonCode 必须消失（深合并会把它留下）。
  assert.deepStrictEqual(result.inputRouting, { mode: "startNow" });
  // 第一帧的 revision 不被后续不含该键的 patch 冲掉。
  assert.equal(result.revision, 11);
  assert.deepStrictEqual(result.queue, { items: [], autoDrain: false, pauseReason: "stopped" });
});

test("边界：同一 rowId 的连续 row.delta 按序拼接", () => {
  const base = buildSnapshot({
    rows: [
      makeRow(1, "turn-0", "assistantText", ""),
      makeRow(2, "turn-0", "reasoning", ""),
      makeRow(3, "turn-0", "toolCall", ""),
      makeRow(4, "turn-0", "subagent", ""),
    ],
  });
  const targets: Array<[number, StreamablePath, string]> = [
    [1, "text", "甲"],
    [1, "text", "乙"],
    [1, "text", "丙"],
    [2, "text", "思"],
    [3, "inputText", "ls -la"],
    [3, "inputText", " | wc -l"],
    [3, "output.text", "out-1"],
    [3, "output.text", "-out-2"],
    [4, "summaryText", "摘要"],
  ];
  const deltas = targets.map(([rowId, path, append]) =>
    conversationDeltaSchema.parse({ op: "row.delta", rowId, path, append }),
  );
  assertDeltasEquivalent(base, deltas);

  const result = applyConversationDeltas(base, deltas);
  const [assistant, reasoning, toolCall, subagent] = result.rows.window;
  assert.equal(assistant?.kind === "assistantText" ? assistant.text : undefined, "甲乙丙");
  assert.equal(reasoning?.kind === "reasoning" ? reasoning.text : undefined, "思");
  assert.equal(toolCall?.kind === "toolCall" ? toolCall.inputText : undefined, "ls -la | wc -l");
  assert.equal(
    toolCall?.kind === "toolCall" ? toolCall.output?.text : undefined,
    "out-1-out-2",
  );
  assert.equal(subagent?.kind === "subagent" ? subagent.summaryText : undefined, "摘要");
});

test("边界：命中未加载 rowId 的 upsert/delta 都是 no-op", () => {
  const base = buildSnapshot({ rows: [makeRow(1, "turn-0", "assistantText", "原文本")] });
  const deltas = [
    conversationDeltaSchema.parse({
      op: "row.upserted",
      row: buildRawRow(99, "turn-ghost", "assistantText", "幽灵"),
    }),
    conversationDeltaSchema.parse({ op: "row.delta", rowId: 99, path: "text", append: "追加" }),
  ];
  assertDeltasEquivalent(base, deltas);
  assert.deepStrictEqual(applyConversationDeltas(base, deltas), base);
});

test("隔离边界：createMutableConversationSnapshotAccumulator 不修改传入的已发布快照", () => {
  const base = buildSnapshot({
    rows: [
      makeRow(1, "turn-0", "turnHeader"),
      makeRow(2, "turn-0", "userInput"),
      makeRow(3, "turn-0", "assistantText", "abc"),
      makeRow(4, "turn-0", "toolCall", "x"),
    ],
  });
  const before = structuredClone(base);

  const accumulator = createMutableConversationSnapshotAccumulator(base);
  assert.notStrictEqual(accumulator.snapshot, base, "累加器必须持自己的 snapshot 外壳");
  assert.notStrictEqual(accumulator.snapshot.rows, base.rows, "rows 对象也必须另起");
  assert.notStrictEqual(
    accumulator.snapshot.rows.window,
    base.rows.window,
    "window 数组必须另起（否则会写穿已发布快照）",
  );
  assert.deepStrictEqual(base, before, "构造累加器后原快照必须逐字节不变");

  assert.deepStrictEqual(
    [...accumulator.rowIndexById.entries()].sort((a, b) => a[0] - b[0]),
    base.rows.window.map((row, index) => [row.rowId, index]),
    "初始 rowIndexById 必须与 window 下标一一对应",
  );

  const deltas = generateDeltaSequence(7, 24, base);
  applyConversationDeltasMutable(accumulator, deltas);
  assert.deepStrictEqual(
    base,
    before,
    "整批施加后传入的已发布快照仍必须逐字节不变",
  );
});

test("C1 不变量：statePatchSchema 键集合不含 rows / seq / logEpoch", () => {
  // 这三个键确实存在于 snapshot 顶层，所以「patch 不含它们」才是一条有约束力的断言。
  const snapshot = buildSnapshot();
  for (const forbidden of ["rows", "seq", "logEpoch"] as const) {
    assert.ok(forbidden in snapshot, `快照顶层本应存在 ${forbidden}`);
    assert.equal(
      LEGAL_PATCH_KEYS.has(forbidden),
      false,
      `statePatchSchema 的合法键集合不得包含 ${forbidden}`,
    );
    assert.equal(
      Object.hasOwn(statePatchSchema.shape, forbidden),
      false,
      `statePatchSchema.shape 不得声明 ${forbidden}`,
    );
  }

  // 纵深防御：即便线上帧真的夹带这三个键，parse 也会剥掉，Object.assign 永远看不到它们。
  const parsed = statePatchSchema.parse({
    revision: 3,
    rows: { window: [], totalCount: 1, firstRowId: null },
    seq: 9,
    logEpoch: "epoch-x",
  });
  assert.deepStrictEqual(Object.keys(parsed), ["revision"]);
  assert.equal("rows" in parsed, false);
  assert.equal("seq" in parsed, false);
  assert.equal("logEpoch" in parsed, false);
});

test("C1 不变量：state.updated 的 Object.assign 不会踩到 rows/seq/logEpoch", () => {
  const base = buildSnapshot({ rows: [makeRow(1, "turn-0", "assistantText", "abc")] });
  const patch = statePatchSchema.parse({
    revision: 12,
    rows: { window: [], totalCount: 0, firstRowId: null },
    seq: 999,
    logEpoch: "epoch-evil",
  });
  assert.deepStrictEqual(Object.keys(patch), ["revision"]);

  const accumulator = createMutableConversationSnapshotAccumulator(base);
  applyConversationDeltasMutable(accumulator, [{ op: "state.updated", patch }]);
  const immutable = applyConversationDeltas(base, [{ op: "state.updated", patch }]);

  assert.deepStrictEqual(accumulator.snapshot, immutable);
  assert.equal(accumulator.snapshot.rows.window.length, 1);
  assert.equal(accumulator.snapshot.seq, base.seq);
  assert.equal(accumulator.snapshot.logEpoch, base.logEpoch);
  assert.equal(accumulator.snapshot.revision, 12);
});
