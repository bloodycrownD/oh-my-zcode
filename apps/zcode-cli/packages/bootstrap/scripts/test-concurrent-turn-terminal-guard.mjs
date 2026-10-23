#!/usr/bin/env node
/**
 * 并发轮终态护栏（幽灵消息事故 B 线，2026-10-23）——product-projection 的
 * TurnComplete/TurnError 归属分流。
 *
 * 事故背景（全部落库实证）：用户排队的消息经 sendQueuedNow/自动 drain 提升为
 * 后台轮，与前台轮并发运行。旧投影对终态事件不做归属判定：后台轮失败会把
 * `closeStreamingRows`/`phase:"error"`/`heldQueue(error)` 全部作用于会话全局，
 * 连带判死前台轮；后台轮先完成则会清空 currentTurnId，前台轮后续事件行失去归属。
 *
 * 护栏语义（`eventTargetsCurrentTurn`）：
 *   - 事件自带 turnId 且 ≠ currentTurnId（并发轮）→ 只把自己的 turnHeader 落终态；
 *   - 事件缺 turnId → 按旧语义视为当前轮（单轮路径行为不变）。
 *
 * 运行方式：`npx tsx --test scripts/test-concurrent-turn-terminal-guard.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { SessionEventType } = await import("@zcode/contracts");
const { ProductProjection } = await import(
  new URL("../src/zcode-protocol-v4/product-projection.ts", import.meta.url).href
);

const SESSION_ID = "ses_concurrent_turn_guard";
const EPOCH = "epoch-ctg";
const FG_TURN = "turn-fg";
const BG_TURN = "turn-bg";

let eventSeq = 0;
function event(type, payload, turnId) {
  eventSeq += 1;
  return {
    id: `evt-ctg-${eventSeq}`,
    sessionId: SESSION_ID,
    turnId,
    type,
    timestamp: new Date(),
    traceId: "trace-ctg",
    sequenceNumber: eventSeq,
    payload,
  };
}

function turnStarted(turnId, text) {
  return event(SessionEventType.TurnStarted, { input: text, messageId: `msg_${turnId}` }, turnId);
}

function turnError(turnId) {
  return event(
    SessionEventType.TurnError,
    { error: { type: "provider_error", message: "AI SDK stream failed" } },
    turnId,
  );
}

function headerOf(projection, turnId) {
  // productTurnId = TurnStarted 载荷的 messageId（canonicalizer 用用户消息 id 做产品轮 id）。
  const productTurnId = `msg_${turnId}`;
  const row = projection
    .getSnapshot()
    .rows.window.find((r) => r.kind === "turnHeader" && r.turnId === productTurnId);
  assert.ok(row, `turnHeader(${productTurnId}) 必须存在`);
  return row;
}

test("B1: 后台轮失败只落自己的 failed header，不判死前台轮与会话全局态", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted(FG_TURN, "前台轮（探索/写规格）"));
  const phaseBefore = projection.getSnapshot().control.phase;
  projection.applyEvent(turnStarted(BG_TURN, "队列提升的后台轮"));

  // 后台轮（非 currentTurn）失败：
  projection.applyEvent(turnError(FG_TURN));

  const snapshot = projection.getSnapshot();
  assert.equal(
    headerOf(projection, FG_TURN).state,
    "failed",
    "失败轮自己的 header 必须可见地落 failed",
  );
  assert.equal(
    snapshot.control.phase,
    phaseBefore,
    "非当前轮的失败不得迁移会话 phase（旧代码会全局翻 error）",
  );
  assert.equal(snapshot.control.lastError, null, "非当前轮失败不得写全局 lastError");
  assert.notEqual(snapshot.control.phase, "error");
});

test("B2: 当前轮失败仍走完整错误路径（护栏不改变单轮语义）", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted(FG_TURN, "前台轮"));
  projection.applyEvent(turnError(FG_TURN));

  const snapshot = projection.getSnapshot();
  assert.equal(headerOf(projection, FG_TURN).state, "failed");
  assert.equal(snapshot.control.phase, "error", "当前轮失败必须全局可见");
  assert.ok(snapshot.control.lastError, "当前轮失败必须写 lastError");
});

test("B3: 缺 turnId 的终态事件按旧语义视为当前轮（回归保护）", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted(FG_TURN, "前台轮"));
  const noIdError = turnError(FG_TURN);
  delete noIdError.turnId;
  projection.applyEvent(noIdError);

  const snapshot = projection.getSnapshot();
  assert.equal(snapshot.control.phase, "error", "缺 turnId 事件保持旧行为：完整错误路径");
});

test("B4: 后台轮先完成只落自己的 header 终态，不清空当前轮归属", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted(FG_TURN, "前台轮"));
  projection.applyEvent(turnStarted(BG_TURN, "后台轮"));
  // 后台轮成功收口（非 currentTurn）：
  projection.applyEvent(
    event(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, resultType: "success" },
      BG_TURN,
    ),
  );

  assert.equal(
    headerOf(projection, BG_TURN).state,
    "completedSuccess",
    "后台轮自己的 header 必须落成功终态",
  );
  // 前台轮 header 仍是 running —— 没有被连带收口。
  assert.equal(headerOf(projection, FG_TURN).state, "running", "前台轮不得被连带收口");
});
