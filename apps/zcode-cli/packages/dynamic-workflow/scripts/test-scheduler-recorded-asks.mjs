#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-DWF-1——scheduler 的 ask 行数一次建表（消 O(actor × 行)）。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P3 #14）
 * ============================================================================
 *
 * `registerActor` 原先每建一个 actor 就把**整张节点表**读一遍再按 (siteId, ordinal) 过滤——宽
 * fan-out 下是 O(actor × 行) 次解码，而且解的是每条 ask 的回答与每条 report item。修复由引擎的
 * resume 分支把它已经读好的 ask 行一次喂进 `seedRecordedAsks`，`registerActor` 只查表。
 *
 * 本用例钉两件事：
 *   1) **等价**：种表后的 recordedCount 与旧全表扫描口径逐 actor 相同（输出 diff 为空）；
 *   2) **不再读 journal**：registerActor 期间一次 listNodes 都不发（替身里 listNodes 直接抛错）。
 *
 * 运行：`npx tsx --test scripts/test-scheduler-recorded-asks.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { AskScheduler } = await import("../src/engine/scheduler.ts");

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
      row.kind === "ask" &&
      row.actorSiteId === ref.siteId &&
      row.actorOrdinal === ref.ordinal,
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
