#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-DWF-1——scheduler 的 ask 行数一次建表（消 O(actor × 行)）。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P3 #14 / cr-fix-spec b/G-1 验收）
 * ============================================================================
 *
 * `registerActor` 原先每建一个 actor 就把**整张节点表**读一遍再按 (siteId, ordinal) 过滤——宽
 * fan-out 下是 O(actor × 行) 次解码，而且解的是每条 ask 的回答与每条 report item。修复由引擎的
 * resume 分支把它已经读好的 ask 行一次喂进 `seedRecordedAsks`，`registerActor` 只查表。
 *
 * 本用例钉三件事：
 *   1) **等价**：种表后的 recordedCount 与旧全表扫描口径逐 actor 相同（输出 diff 为空）；
 *   2) **不再读 journal**：registerActor 期间一次 listNodes 都不发（替身里 listNodes 直接抛错）；
 *   3) **engine 接线**（b/G-1 补）：resume 的 ask 行数表**来自窄读**（workRows 不带结果），且
 *      删掉 engine.ts 的 `seedRecordedAsks(workRows)` 接线后下面「fresh ask 被 hold 在既有 ask
 *      之后」的断言必须红——先把 fresh ask 与既有 ask 放进同一个同步片，seed 缺席时 fresh 会
 *      抢走 actorSeq 0，既有 ask 的 replay 命中被孤儿化、永不释放。
 *
 * 运行：`npx tsx --test scripts/test-scheduler-recorded-asks.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { AskScheduler } = await import("../src/engine/scheduler.ts");
const { WorkflowEngine } = await import("../src/engine/engine.ts");
const { InMemoryJournalStore } = await import("../src/engine/journal-memory.ts");

const ACTOR_COUNT = 40;
const ASKS_PER_ACTOR = 5;

/** journal 替身：任何 listNodes 调用都是回归——修复后 registerActor 不该再读节点表。 */
function createHost() {
  const reads = [];
  return {
    host: {
      runId: "run-t-dwf-1",
      driver: {
        journal: {
          listNodes(runId, opts) {
            reads.push({ runId, opts });
            throw new Error("registerActor 不得再全表读节点");
          },
        },
      },
    },
    reads,
  };
}

/** 本 run 已落库的 ask 行：40 个 actor × 5 条，另有噪声行（别的 kind / 缺主人）。 */
function recordedAskRows() {
  const rows = [];
  for (let actor = 0; actor < ACTOR_COUNT; actor += 1) {
    for (let ask = 0; ask < ASKS_PER_ACTOR; ask += 1) {
      rows.push({
        siteId: `site-actor-${actor}`,
        ordinal: ask,
        kind: "ask",
        actorSiteId: `site-actor-${actor}`,
        actorOrdinal: actor,
        result: { big: "x".repeat(1024) },
      });
    }
  }
  rows.push({ siteId: "site-report", ordinal: 0, kind: "report", result: {} });
  rows.push({ siteId: "site-ask", ordinal: 99, kind: "ask", result: {} });
  return rows;
}

/** 旧口径：全表读 + 按 (siteId, ordinal) 过滤计数。 */
function legacyRecordedCount(rows, ref) {
  return rows.filter(
    (row) =>
      row.kind === "ask" && row.actorSiteId === ref.siteId && row.actorOrdinal === ref.ordinal,
  ).length;
}

test("T-DWF-1 seedRecordedAsks 的 recordedCount 与旧全表扫描逐 actor 相同，且不读 journal", () => {
  const rows = recordedAskRows();
  const { host, reads } = createHost();
  const scheduler = new AskScheduler(host);
  scheduler.seedRecordedAsks(rows);

  const diffs = [];
  for (let actor = 0; actor < ACTOR_COUNT; actor += 1) {
    const ref = { siteId: `site-actor-${actor}`, ordinal: actor };
    const registered = scheduler.registerActor(ref, `actor-${actor}`, `agent-${actor}`, {});
    const expected = legacyRecordedCount(rows, ref);
    if (registered.recordedCount !== expected) {
      diffs.push({ actor, actual: registered.recordedCount, expected });
    }
    assert.equal(scheduler.hasActor(`actor-${actor}`), true);
  }
  assert.deepEqual(diffs, [], "recordedCount 必须与旧全表扫描口径完全一致");
  assert.deepEqual(reads, [], "registerActor 期间不得发生任何节点表读");
});

test("T-DWF-1 全新 run（未种表）每个 actor 的 recordedCount 都是 0", () => {
  const { host, reads } = createHost();
  const scheduler = new AskScheduler(host);
  scheduler.seedRecordedAsks([]);
  const actor = scheduler.registerActor(
    { siteId: "site-fresh", ordinal: 0 },
    "actor-fresh",
    undefined,
    {},
  );
  assert.equal(actor.recordedCount, 0);
  assert.deepEqual(reads, []);
});

test("T-DWF-1 种表只认有主人的 ask 行（其它 kind / 缺主人一律不计）", () => {
  const { host } = createHost();
  const scheduler = new AskScheduler(host);
  scheduler.seedRecordedAsks([
    { kind: "report", actorSiteId: "site-a", actorOrdinal: 1, siteId: "site-a", ordinal: 0 },
    { kind: "ask", siteId: "site-a", ordinal: 1 },
    { kind: "ask", actorSiteId: "site-a", actorOrdinal: 1, siteId: "site-a", ordinal: 2 },
    { kind: "ask", actorSiteId: "site-a", actorOrdinal: 1, siteId: "site-a", ordinal: 3 },
  ]);
  assert.equal(
    scheduler.registerActor({ siteId: "site-a", ordinal: 1 }, "actor-a", undefined, {})
      .recordedCount,
    2,
  );
  assert.equal(
    scheduler.registerActor({ siteId: "site-b", ordinal: 1 }, "actor-b", undefined, {})
      .recordedCount,
    0,
  );
});

// ————————————————————————————————————————————————————————————————
// b/G-1 补：engine.ts 的 resume 接线（此前只测了 seedRecordedAsks 本身，删接线测试仍绿）
// ————————————————————————————————————————————————————————————————

const ENGINE_RUN = "run-t-dwf-1-engine";

/** 排空微任务队列，让引擎内部的异步派发（惰性建会话）推进到位。 */
async function flush(rounds = 16) {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

/** 最小 driver：够跑 untyped ask 的完整生命周期；只记录 startAsk，不碰会话 / 磁盘。 */
function createDriver(journal) {
  const startAsks = [];
  return {
    startAsks,
    journal,
    createActorSession: async (actor) => ({ id: `session:${actor.siteId}@${actor.ordinal}` }),
    startAsk: (session, instance) => {
      startAsks.push({ session, instance });
    },
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async () => undefined,
    emit: () => {},
  };
}

function engineOn(journal) {
  const driver = createDriver(journal);
  const engine = new WorkflowEngine({
    runId: ENGINE_RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: new Map([
      ["ask#1", { typed: false }],
      ["ask#2", { typed: false }],
    ]),
    validate: () => [],
  });
  return { driver, engine };
}

/** 记下每一次 listNodes 的 opts（resume 的读形状是契约：只准窄读）。 */
function spyListNodes(journal) {
  const reads = [];
  const original = journal.listNodes.bind(journal);
  journal.listNodes = (runId, opts) => {
    reads.push(opts);
    return original(runId, opts);
  };
  return reads;
}

/** 记下每一次 listEvents 的 opts（结算次序恢复的读形状是契约：只读结算类型 + 不带 item）。 */
function spyListEvents(journal) {
  const reads = [];
  const original = journal.listEvents.bind(journal);
  journal.listEvents = (runId, opts) => {
    reads.push(opts);
    return original(runId, opts);
  };
  return reads;
}

test("T-DWF-1 engine resume：ask 行数表来自窄读，fresh ask 被 hold 在既有 ask 之后", async () => {
  const journal = new InMemoryJournalStore();
  // 第一世：一个 actor 答一问，然后停下（journal 留下 ask#1@1 completed + 结算事件）。
  const first = engineOn(journal);
  const actor = first.engine.createActor("actor#1");
  const asked = first.engine.ask("ask#1", actor, "one");
  await flush();
  first.engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "r1");
  assert.equal(await asked, "r1");
  first.engine.stop("user");
  await first.engine.settled;

  // 第二世：resume。构造期的节点读就是接线本身的证据。
  const reads = spyListNodes(journal);
  const eventReads = spyListEvents(journal);
  const second = engineOn(journal);
  assert.deepEqual(
    reads,
    [
      { kinds: ["ask", "world-read", "world-run"], withResult: false },
      { kinds: ["artifact"], withResult: true },
    ],
    "resume 必须只做两次窄读：工作行不带结果（ask 行数表的来源）+ 产物行带结果",
  );
  // 结算次序恢复（recoverSettleOrder）的读形状：只读三种结算事件，且 report item 一条都不带
  // （全量读会把 65,536 条 report 的 item 解进内存）。改回 `listEvents(runId)` 这条断言即红。
  const SETTLE_TYPES = ["node-settled", "artifact-published", "artifact-failed"];
  assert.deepEqual(
    eventReads,
    [{ types: SETTLE_TYPES, reportItems: { limit: 0 } }],
    "结算次序恢复必须只读三种结算事件、且不读 report item",
  );
  // 非空且等价：窄读 == 全量读按结算类型过滤。少列一种事件类型时这里的 diff 非空。
  const settleTypes = new Set(SETTLE_TYPES);
  const narrowed = journal.listEvents(ENGINE_RUN, {
    types: SETTLE_TYPES,
    reportItems: { limit: 0 },
  });
  const expectedSettle = journal
    .listEvents(ENGINE_RUN, { types: "all", reportItems: "all" })
    .filter((stored) => settleTypes.has(stored.event.type));
  assert.ok(expectedSettle.length > 0, "前置：第一世必须已写入结算事件，本断言才非空");
  assert.deepEqual(narrowed, expectedSettle, "结算次序的窄读必须与全量读按结算类型过滤逐字等价");

  // 同一个同步片里先发**全新** ask、再重放既有 ask：fresh 必须被 hold 在既有 ask 之后。
  // 判据就是 resume 种下的 recordedCount——seed 接线被删时它是 0，fresh 立即抢走 actorSeq 0，
  // 既有 ask 的 pendingRecorded 序号被孤儿化，命中永不释放。
  const again = second.engine.createActor("actor#1");
  const fresh = second.engine.ask("ask#2", again, "two");
  const hit = second.engine.ask("ask#1", again, "one");
  const hitState = await Promise.race([hit.then(() => "resolved"), flush().then(() => "pending")]);
  assert.equal(
    hitState,
    "resolved",
    "既有 ask 的 replay 命中必须被释放（seedRecordedAsks 接线缺席时它永远不释放）",
  );
  assert.equal(await hit, "r1");

  await flush();
  assert.equal(second.driver.startAsks.length, 1, "第二世只派发 fresh ask 一条");
  assert.equal(
    `${second.driver.startAsks[0].instance.siteId}@${second.driver.startAsks[0].instance.ordinal}`,
    "ask#2@1",
  );
  // fresh 的 actorSeq 必须接在既有 ask（seq 0）之后——hold 规则真的生效了。
  assert.equal(
    journal.getNode(ENGINE_RUN, "ask#2", 1).actorSeq,
    1,
    "fresh ask 的 actorSeq 必须排在既有 ask 之后",
  );

  // 收尾：结算 fresh ask、停掉第二世，不留悬挂 promise。
  second.engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "r2");
  assert.equal(await fresh, "r2");
  second.engine.stop("user");
  await second.engine.settled;
});

test("T-DWF-1 engine resume：countNodes 缺席时 report 计数退回元数据窄读，不回落全量带结果读", async () => {
  const journal = new InMemoryJournalStore();
  const first = engineOn(journal);
  first.engine.report("report#1", { index: 1 });
  first.engine.report("report#1", { index: 2 });
  first.engine.stop("user");
  await first.engine.settled;

  // 窄替身：只实现 listNodes（countNodes 缺席，照 FORK 的可选端口成员约定走退回路径）。
  journal.countNodes = undefined;
  const reads = spyListNodes(journal);
  const second = engineOn(journal);

  assert.deepEqual(
    reads.find((opts) => opts.kinds.includes("report")),
    { kinds: ["report"], withResult: false },
    "countNodes 缺席时必须退回元数据窄读（withResult:false），不得回落全量带结果读",
  );
  assert.ok(
    reads.every((opts) => Array.isArray(opts.kinds)),
    "resume 不得出现无 kinds 的全表读",
  );
  assert.ok(
    reads.every((opts) => opts.withResult !== true || !opts.kinds.includes("report")),
    "report 行一条都不能带结果读",
  );

  second.engine.stop("user");
  await second.engine.settled;
});
