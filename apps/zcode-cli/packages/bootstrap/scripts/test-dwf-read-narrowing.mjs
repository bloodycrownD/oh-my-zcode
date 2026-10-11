#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-DWF-2 / T-DWF-3——DWF 读放大收窄的端口侧下推。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P3 #15 / #16）
 * ============================================================================
 *
 * 两个读面原先都把整张节点表（含每条 report item 的正文）读进内存再自己切片：
 *   T-DWF-2 observation：结算那一刻要解码 GiB 量级的 item 才能填通知里几十条 report；
 *   T-DWF-3 冷回放：一个报了 65,536 条的 run 在会话打开时要把约 2 GiB item 解码进内存，
 *           而 reducer 只会为前 64 条生成预览。
 * 修复把界下推到存储层：条数 + 字节界（256 / 8MiB）与 `count(*)` 走端口方法，冷回放读事件带
 * `reportItems.limit`。本用例用**窄替身 journal**断言「下推的 opts 真的到了端口」——不读全量。
 *
 * 运行：`npx tsx --test scripts/test-dwf-read-narrowing.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { snapshotOf } = await import("../src/app/dynamic-workflow-run-observation.ts");
const { COLD_REPLAY_EVENT_READ, replayRunProgress } =
  await import("../src/app/dynamic-workflow-run-replay.ts");
const { DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS, DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES } =
  await import("@zcode/contracts");
const { WORKFLOW_RUNS_LIMITS } = await import("@zcode/shared/zcode-protocol-v4");

const RUN_ID = "run-t-dwf-1";
const TOTAL_REPORTS = 900;

/** 只实现被测路径真正用的方法；任何未预料的方法调用直接抛错，避免"替身悄悄兜底"。 */
function createJournal({ withCountTaggedReports = true } = {}) {
  const listNodeCalls = [];
  const countNodeCalls = [];
  const countedTaggedReports = [];
  const journal = {
    getRun(runId) {
      return runId === RUN_ID ? { runId: RUN_ID, status: "completed", caps: {} } : undefined;
    },
    listEvents() {
      return [];
    },
    // 用户面产物：一条预置看板（chart），才会走 tagItemCounts 的计数路径。
    listArtifactRows(runId) {
      assert.equal(runId, RUN_ID);
      return [
        {
          status: "completed",
          artifactId: "artifact-a",
          result: { id: "artifact-a", kind: "chart", version: 1, title: "看板" },
        },
      ];
    },
    listNodes(runId, opts) {
      listNodeCalls.push(opts);
      assert.ok(opts, "listNodes 必须带 opts：无 opts 即全量读，正是被修掉的那条路径");
      // 模拟"存储层已下推条数界"的返回：最多 limit 条。
      const limit = Math.min(opts.limit ?? TOTAL_REPORTS, TOTAL_REPORTS);
      return Array.from({ length: limit }, (_, index) => ({
        siteId: "site-report",
        ordinal: index,
        kind: "report",
        artifactId: index % 2 === 0 ? "artifact-a" : "artifact-b",
        result: { index },
      }));
    },
    countNodes(runId, kind) {
      countNodeCalls.push({ runId, kind });
      return TOTAL_REPORTS;
    },
  };
  if (withCountTaggedReports) {
    journal.countTaggedReports = (runId) => {
      countedTaggedReports.push(runId);
      return new Map([
        ["artifact-a", 3],
        ["artifact-b", 2],
      ]);
    };
  }
  return { journal, listNodeCalls, countNodeCalls, countedTaggedReports };
}

test("T-DWF-2 快照的 report 读是「前 256 条 + 8MiB + count(*)」，没有全量节点读", () => {
  const { journal, listNodeCalls, countNodeCalls, countedTaggedReports } = createJournal();
  const snapshot = snapshotOf(RUN_ID, new Map(), journal);

  assert.ok(snapshot, "有 journal 行时必须给出快照");
  assert.equal(snapshot.status, "completed");

  const reportRead = listNodeCalls.find(
    (opts) => opts.kinds?.includes("report") && opts.withResult,
  );
  assert.ok(reportRead, "report 读必须下推到端口");
  assert.equal(reportRead.limit, DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS);
  assert.equal(reportRead.limit, 256);
  assert.equal(reportRead.maxResultBytes, DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES);
  assert.equal(reportRead.maxResultBytes, 8 * 1024 * 1024);

  // 真总数走 count(*)：通知说"900 条里的前 256 条"，而不是把 900 条都读回来。
  assert.deepEqual(countNodeCalls, [{ runId: RUN_ID, kind: "report" }]);
  assert.equal(snapshot.reportCount, TOTAL_REPORTS);
  assert.equal(snapshot.reports.length, DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS);

  // artifacts 的标签计数走 countTaggedReports（零行读）。
  assert.deepEqual(countedTaggedReports, [RUN_ID]);
  assert.equal(
    listNodeCalls.some((opts) => opts.withResult === false),
    false,
    "有 countTaggedReports 时不该再退回读 report 行",
  );
});

test("T-DWF-2 countTaggedReports 缺席时退回 withResult:false 窄读（仍不读 item 正文）", () => {
  const { journal, listNodeCalls } = createJournal({ withCountTaggedReports: false });
  const snapshot = snapshotOf(RUN_ID, new Map(), journal);
  assert.ok(snapshot);
  const metadataRead = listNodeCalls.find((opts) => opts.withResult === false);
  assert.ok(metadataRead, "退回路径必须是元数据窄读");
  assert.deepEqual(metadataRead.kinds, ["report"]);
  assert.equal("limit" in metadataRead, false);
  // 没有任何一次"无 kinds 无 withResult"的全量读。
  assert.equal(
    listNodeCalls.every((opts) => opts.kinds !== undefined),
    true,
  );
});

test("T-DWF-3 冷回放读事件带 reportItems 限 64（下推到存储层，不是读完再切片）", () => {
  assert.equal(WORKFLOW_RUNS_LIMITS.maxReports, 64);
  assert.deepEqual(COLD_REPLAY_EVENT_READ, { types: "all", reportItems: { limit: 64 } });

  const listEventsCalls = [];
  const journal = {
    listEvents(runId, opts) {
      listEventsCalls.push({ runId, opts });
      // 模拟存储层已按 reportItems.limit 剥离：前 64 条 report 带 item，其余只留元数据。
      const stored = [{ sequence: 1, event: { type: "run-launched", inputId: "input-1" } }];
      for (let index = 0; index < 200; index += 1) {
        stored.push({
          sequence: index + 2,
          event: {
            type: "node-settled",
            kind: "report",
            instance: { siteId: "site-report", ordinal: index },
            ...(index < WORKFLOW_RUNS_LIMITS.maxReports ? { item: { index } } : {}),
          },
        });
      }
      return stored;
    },
  };

  const payloads = replayRunProgress(
    { runId: RUN_ID, toolCallId: undefined, status: "completed" },
    journal,
    4,
  );

  assert.equal(listEventsCalls.length, 1);
  assert.equal(listEventsCalls[0].runId, RUN_ID);
  assert.deepEqual(listEventsCalls[0].opts, { types: "all", reportItems: { limit: 64 } });

  // 回放出的 report 载荷只有前 64 条带 item（与 reducer 会为之生成预览的条数同界）。
  const withItem = payloads.filter(
    (payload) => payload.eventType === "node-settled" && payload.payload?.item !== undefined,
  );
  assert.equal(withItem.length, WORKFLOW_RUNS_LIMITS.maxReports);
  // 尾部结算按 journal 行铸造（终态 run 的最后一条永远是 run-settled）。
  assert.equal(payloads.at(-1).eventType, "run-settled");
});
