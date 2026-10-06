/**
 * renderUnits 缓存护栏的单测（cr-fix-spec full/C-2 与 full/C-5 验收）。
 *
 * 覆盖三件事：
 * 1. C-2：同一 turnId 在多 phase / isLastTurn 组合反复注入后，单轮内层分区数
 *    不超过 MAX_PARTITIONS_PER_TURN（keepByPhase/unitByKey 走 setBoundedPartition
 *    的 LRU 上界；phase 换代本身会整表清空，此断言钉住的是「任何路径都撑不爆」）；
 * 2. C-5(2)：空 rows 的 build 只跳过清理循环并归零锚点，不清空 scopeKey 下既有
 *    条目（分享侧受闸口径喂空数组时不得抹掉 Timeline 侧的真实缓存）；
 * 3. C-5(3)：scopeKey/sessionPhase 与缓存内不一致时 DEV 告警恰一次（latch）。
 *
 * 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入，只能用相对路径或 `@zcode/*`
 * （tsx 下别名不可解析）。**不要在本文件引入 `@/`。**
 */
import assert from "node:assert/strict";
import test from "node:test";
import { conversationRowSchema, type ConversationRow, type SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  createConversationTurnRenderUnitsCache,
  MAX_PARTITIONS_PER_TURN,
} from "../src/v4/conversationTurnRenderUnits.js";

const BASE_TS = 1_700_000_000_000;

function turnHeader(rowId: number, turnId: string): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "completedSuccess",
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

function textRow(rowId: number, turnId: string, text: string): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    createdAt: BASE_TS + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state: "complete",
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

function mutation(entries: readonly [number, string][]): ReadonlyMap<number, string> {
  return new Map(entries);
}

const PHASES: SessionPhase[] = ["running", "completedSuccess", "error", "draft"];

test("C-2：同一 turnId 多 phase 反复注入后分区数 ≤ MAX_PARTITIONS_PER_TURN", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const rows = visibleTurn(1, "turn-a");

  // 同一 scopeKey 下轮换 phase（每次换代合法清表）+ isLastTurn 恒真，注入远超上限的
  // 次数；无论清表路径还是 LRU 路径，单轮分区数都必须被 MAX_PARTITIONS_PER_TURN 封顶。
  for (let i = 0; i < PHASES.length * 4; i += 1) {
    cache.build(rows, { scopeKey: "sess-c2", sessionPhase: PHASES[i % PHASES.length]! }, mutation([]));
  }
  assert.ok(
    cache.__partitionCountForTest("turn-a") <= MAX_PARTITIONS_PER_TURN,
    `分区数 ${cache.__partitionCountForTest("turn-a")} 超过上界 ${MAX_PARTITIONS_PER_TURN}`,
  );
  assert.ok(cache.size() <= MAX_PARTITIONS_PER_TURN);
});

test("C-5：空 rows 的 build 不清空 scopeKey 下既有条目（锚点归零、缓存保留）", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const options = { scopeKey: "sess-c5", sessionPhase: "running" as SessionPhase };
  const rows = [...visibleTurn(1, "turn-a"), ...visibleTurn(4, "turn-b")];

  const first = cache.build(rows, options, mutation([]));
  assert.equal(cache.size(), 2);

  // 分享侧受闸口径：timelineSnapshot 为 null 时喂空数组（同 scope/phase）。
  const emptyFrame = cache.build([], options, mutation([]));
  assert.deepEqual(emptyFrame, []);
  assert.equal(cache.size(), 2, "空 rows 是「本帧无窗口可依据」，不得清空既有条目");

  // 缓存确实保留：后续帧（空 mutation，锚点已归零）必须复用同一批 unit 对象。
  const rebuilt = cache.build(rows, options, mutation([]));
  assert.deepEqual(
    rebuilt.map((unit) => unit.turnId),
    first.map((unit) => unit.turnId),
  );
  for (let i = 0; i < first.length; i += 1) {
    assert.equal(rebuilt[i], first[i], `第 ${i} 个 unit 必须复用缓存对象引用`);
  }
});

test("C-5：scopeKey/sessionPhase 与缓存内不一致时 DEV 告警恰一次", () => {
  const cache = createConversationTurnRenderUnitsCache();
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    cache.build(visibleTurn(1, "turn-a"), { scopeKey: "sess-a", sessionPhase: "running" }, mutation([]));
    assert.equal(warnings.length, 0, "首帧建表不算冲突");

    cache.build(visibleTurn(10, "turn-z"), { scopeKey: "sess-b", sessionPhase: "running" }, mutation([]));
    assert.equal(warnings.length, 1, "缓存非空时换 scopeKey 必须告警一次");

    cache.build(visibleTurn(20, "turn-y"), { scopeKey: "sess-c", sessionPhase: "running" }, mutation([]));
    assert.equal(warnings.length, 1, "告警 latch：同一代内只报一次");
  } finally {
    console.warn = originalWarn;
  }
});
