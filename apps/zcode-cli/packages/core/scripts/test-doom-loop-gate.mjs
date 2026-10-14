#!/usr/bin/env node
/**
 * Doom loop 门（opencode 式）纯函数防线（2026-10-14 用户拍板：streak=3 直接弹卡）。
 *
 * 覆盖：streak 计数与签名重置 / 阈值与三种模式（ask|deny|off）/ 会话级豁免 /
 * denied result 的停轮标记 / ask decision 改写 / sessionUpdates 豁免登记。
 * permission-flow 的链路集成（确认窗/broker/hook-race）由既有权限测试面覆盖，
 * 此处只钉 gate 纯函数契约。
 *
 * 运行方式：`npx tsx --test scripts/test-doom-loop-gate.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DOOM_LOOP_THRESHOLD,
  applyDoomLoopSessionUpdates,
  buildDoomLoopAskDecision,
  buildDoomLoopDeniedResult,
  createDoomLoopGateState,
  evaluateDoomLoopGate,
  recordDoomLoopStreak,
  withDoomLoopTurnStop,
} from "../src/tool/executor/doom-loop-gate.js";

const toolCall = { id: "call-1", name: "Read", input: { path: "a.ts" } };

function threeIdenticalCalls(state, input = { path: "a.ts" }) {
  let last;
  for (let i = 0; i < 3; i += 1) last = recordDoomLoopStreak(state, "Read", input);
  return last;
}

test("streak：同工具+同输入连续计数，第 3 次达阈值触发门", async () => {
  const state = createDoomLoopGateState();
  assert.equal(recordDoomLoopStreak(state, "Read", { path: "a.ts" }).count, 1);
  assert.equal(recordDoomLoopStreak(state, "Read", { path: "a.ts" }).count, 2);
  const third = recordDoomLoopStreak(state, "Read", { path: "a.ts" });
  assert.equal(third.count, 3);
  assert.equal(DOOM_LOOP_THRESHOLD, 3);
  assert.equal(evaluateDoomLoopGate(state, "ask", "Read", third.count), "ask");
});

test("签名键序无关：input 键顺序不同仍视为同一调用", async () => {
  const state = createDoomLoopGateState();
  recordDoomLoopStreak(state, "Read", { path: "a.ts", offset: 1 });
  recordDoomLoopStreak(state, "Read", { offset: 1, path: "a.ts" });
  const third = recordDoomLoopStreak(state, "Read", { path: "a.ts", offset: 1 });
  assert.equal(third.count, 3, "键序不同不影响签名");
});

test("异签名重置：不同输入/工具打断 streak", async () => {
  const state = createDoomLoopGateState();
  recordDoomLoopStreak(state, "Read", { path: "a.ts" });
  recordDoomLoopStreak(state, "Read", { path: "a.ts" });
  recordDoomLoopStreak(state, "Read", { path: "b.ts" });
  const last = recordDoomLoopStreak(state, "Read", { path: "a.ts" });
  assert.equal(last.count, 1, "b.ts 打断后 a.ts 的连续计数作废，从 1 重新数");
  assert.equal(evaluateDoomLoopGate(state, "ask", "Read", last.count), "pass");
});

test("off 模式与豁免工具：始终放行", async () => {
  const state = createDoomLoopGateState();
  const third = threeIdenticalCalls(state);
  assert.equal(evaluateDoomLoopGate(state, "off", "Read", third.count), "pass");
  state.exemptTools.add("Read");
  assert.equal(evaluateDoomLoopGate(state, "ask", "Read", third.count), "pass");
});

test("deny 模式：第 3 次直接 deny（不弹卡）", async () => {
  const state = createDoomLoopGateState();
  const third = threeIdenticalCalls(state);
  assert.equal(evaluateDoomLoopGate(state, "deny", "Read", third.count), "deny");
});

test("denied result：错误结果带 doom_loop 停轮标记与模型可见文案", async () => {
  const result = buildDoomLoopDeniedResult(toolCall, "Read", 3, "reason-x");
  assert.equal(result.success, false);
  assert.equal(result.turnControl?.reason, "doom_loop");
  assert.equal(result.turnControl?.stopTurnAfterResult, true);
  assert.match(String(result.modelContent), /doom loop detection/);
  assert.match(String(result.modelContent), /3 times in a row/);
});

test("ask decision：改写为 doom_loop ask（reason 人类可读）", async () => {
  const decision = buildDoomLoopAskDecision("Read", 3, "code");
  assert.equal(decision.decision, "ask");
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, "doom_loop");
  assert.match(decision.reason, /Read has been called 3 times/);
});

test("withDoomLoopTurnStop：error 补停轮，success 不动", async () => {
  const errorResult = { success: false, toolCallId: "c", toolName: "Read" };
  const wrapped = withDoomLoopTurnStop(errorResult);
  assert.equal(wrapped.turnControl?.reason, "doom_loop");
  const okResult = { success: true, toolCallId: "c", toolName: "Read" };
  assert.equal(withDoomLoopTurnStop(okResult).turnControl, undefined);
});

test("sessionUpdates：doom_loop allow 更新登记会话豁免", async () => {
  const state = createDoomLoopGateState();
  applyDoomLoopSessionUpdates(state, "Read", [
    { ruleId: "doom_loop", decision: "allow" },
  ]);
  assert.equal(state.exemptTools.has("Read"), true);
  const state2 = createDoomLoopGateState();
  applyDoomLoopSessionUpdates(state2, "Read", [
    { ruleId: "other_rule", decision: "allow" },
  ]);
  assert.equal(state2.exemptTools.has("Read"), false, "非 doom_loop 更新不豁免");
  const state3 = createDoomLoopGateState();
  applyDoomLoopSessionUpdates(state3, "Read", undefined);
  assert.equal(state3.exemptTools.size, 0);
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — doom loop gate（streak/阈值/模式/豁免/停轮）"
      : `TEST FAIL — doom loop gate (exit code ${code})`,
  );
});
