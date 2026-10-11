// T-EVICT-1（upstream-v3.15.1-backport，spec §2.1 P4 #24）：B2 拒新规则扩展到 `seat.born`。
//
// 失效形态：溢出过（`truncated`）的 run 里，一条**认不出主人**的出生事件不该占位子。原判据只看
// `node-queued`，漏掉了"重发出生事实的缓存结算"（`node-settled { cached: true }`）——后者放进来
// 还会**卡死**：点名了 actor 的节点不是游离节点，而组是按已列 actor 建的，于是它哪一类受害者都
// 不是，永远淘汰不掉，resume 后的宽 fan-out 每一次派发都被拒。
//
// 放 test/ 而不是 src/：测试是纯消费方不进产物（先例见同目录 apply.test.ts）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  admitsNewEntry,
  seatWorkflowNode,
} from "../src/zcode-protocol-v4/workflow-runs-eviction.js";

const LIMITS = { maxActors: 4, maxNodes: 4, maxPhases: 8 };

type SeatRun = Parameters<typeof seatWorkflowNode>[0];
type SeatInput = Parameters<typeof seatWorkflowNode>[1];

/**
 * 只提供判据真正读到的字段（被拒分支在腾位之前就返回，其余字段不可达）；schema 面的完备性不由
 * 本用例承担，因此按结构窄化。
 */
function truncatedRun(overrides: Record<string, unknown> = {}): SeatRun {
  return {
    runId: "run-t-evict-1",
    truncated: true,
    actors: [],
    nodes: [],
    unlistedByPhase: {},
    ...overrides,
  } as unknown as SeatRun;
}

const SEAT: SeatInput = {
  eventType: "node-queued",
  ref: { siteId: "site-1", ordinal: 3 },
  actorRef: { siteId: "site-actor-unknown", ordinal: 0 },
  actor: null,
  born: true,
  advancesWaterMark: true,
};

test("T-EVICT-1 缓存结算的出生（node-settled, born）在溢出 run 里被 B2 拒，run 原样不动", () => {
  const run = truncatedRun();
  const seating = seatWorkflowNode(run, { ...SEAT, eventType: "node-settled" }, LIMITS);
  assert.equal(seating.admitNew, false);
  assert.equal(seating.activated, false);
  // 关键：被拒的出生一条位子都不占（修复前会走 withRoomForNode → 既占位子又淘汰不掉）。
  assert.equal(seating.run, run);
});

test("T-EVICT-1 node-queued 出生的拒新规则不回归", () => {
  const run = truncatedRun();
  const seating = seatWorkflowNode(run, { ...SEAT, eventType: "node-queued" }, LIMITS);
  assert.equal(seating.admitNew, false);
  assert.equal(seating.run, run);
});

test("T-EVICT-1 主人已在表上时不适用 B2（拒新只针对认不出主人的出生）", () => {
  const listed = { siteId: "site-actor-unknown", ordinal: 0, phaseName: "p" };
  const run = truncatedRun({ actors: [listed] });
  const seating = seatWorkflowNode(run, { ...SEAT, eventType: "node-queued" }, LIMITS);
  assert.equal(seating.admitNew, true);
  assert.equal(seating.activated, false);
});

test("T-EVICT-1 未溢出（truncated 缺席）时出生照常入座", () => {
  const run = truncatedRun({ truncated: undefined });
  const seating = seatWorkflowNode(run, { ...SEAT, eventType: "node-queued" }, LIMITS);
  assert.equal(seating.admitNew, true);
});

test("T-EVICT-1 重放事件（advancesWaterMark=false）既不腾位也不入座", () => {
  const run = truncatedRun();
  const seating = seatWorkflowNode(
    run,
    { ...SEAT, eventType: "node-settled", advancesWaterMark: false },
    LIMITS,
  );
  assert.equal(seating.admitNew, false);
  assert.equal(seating.activated, false);
  assert.equal(seating.run, run);
});

test("T-EVICT-1 admitsNewEntry 的两支判据", () => {
  const run = (truncated: boolean) => ({ truncated }) as unknown as SeatRun;
  assert.equal(admitsNewEntry(run(true), false), false);
  assert.equal(admitsNewEntry(run(true), true), true);
  assert.equal(admitsNewEntry(run(false), false), true);
  assert.equal(admitsNewEntry(run(false), true), true);
});
