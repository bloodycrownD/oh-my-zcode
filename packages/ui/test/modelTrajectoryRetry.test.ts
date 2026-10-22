/**
 * 轨迹面板自动重试判定单测（spec trace-3fix-v119 P1-2 / P2-3 / P2-4）。
 *
 * 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入（tsx 下别名不可解析），
 * 只允许相对路径与裸包名导入（先例 modelTrajectoryClamp.test.ts:7-14）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  decideTrajectoryRetry,
  type TrajectoryRetryDecision,
  type TrajectoryRetryInput,
} from "../src/ModelTrajectoryRetry.js";

const LIMIT = 3;

/** 用显式接口构造入参，保证入参/返回结构在测试侧也被类型检查覆盖。 */
function decide(input: TrajectoryRetryInput): TrajectoryRetryDecision {
  return decideTrajectoryRetry(input);
}

test("success：重置预算、不重试、不落终态", () => {
  assert.deepEqual(decide({ kind: "success", retryCount: 0, limit: LIMIT }), {
    resetBudget: true,
    retry: false,
    terminal: false,
  });
});

test("success：即使预算已耗尽也仍然重置预算并正常返回", () => {
  // 读到记录是唯一能证明「链路恢复」的信号，必须无条件清零预算，
  // 否则一次成功之后后续失败仍会直接落终态。
  assert.deepEqual(decide({ kind: "success", retryCount: LIMIT, limit: LIMIT }), {
    resetBudget: true,
    retry: false,
    terminal: false,
  });
});

test("error：预算未耗尽时排一次退避重试，不落终态", () => {
  assert.deepEqual(decide({ kind: "error", retryCount: 0, limit: LIMIT }), {
    resetBudget: false,
    retry: true,
    terminal: false,
  });
});

test("empty：预算未耗尽时排一次退避重试，不落终态", () => {
  // 空读（records:[]）与 error 同等对待——换模型后的读取窗口就是这样表现的。
  assert.deepEqual(decide({ kind: "empty", retryCount: 0, limit: LIMIT }), {
    resetBudget: false,
    retry: true,
    terminal: false,
  });
});

test("连续 empty：不重置预算，持续消耗预算直至耗尽", () => {
  const decisions = [0, 1, 2].map((retryCount) =>
    decide({ kind: "empty", retryCount, limit: LIMIT }),
  );
  for (const decision of decisions) {
    assert.equal(decision.resetBudget, false);
    assert.equal(decision.retry, true);
    assert.equal(decision.terminal, false);
  }
});

test("第 limit+1 次空读落 empty 终态（预算耗尽）", () => {
  // limit=3 时：第 1/2/3 次空读各自排一次重试，第 4 次（retryCount==limit）落终态。
  assert.deepEqual(decide({ kind: "empty", retryCount: LIMIT, limit: LIMIT }), {
    resetBudget: false,
    retry: false,
    terminal: true,
  });
});

test("预算耗尽时 error 落终态且不再重试", () => {
  assert.deepEqual(decide({ kind: "error", retryCount: LIMIT, limit: LIMIT }), {
    resetBudget: false,
    retry: false,
    terminal: true,
  });
});

test("边界：retryCount == limit - 1 仍可重试一次", () => {
  assert.deepEqual(decide({ kind: "error", retryCount: LIMIT - 1, limit: LIMIT }), {
    resetBudget: false,
    retry: true,
    terminal: false,
  });
});

test("边界：limit 为 0 时第一次失败即落终态", () => {
  assert.deepEqual(decide({ kind: "empty", retryCount: 0, limit: 0 }), {
    resetBudget: false,
    retry: false,
    terminal: true,
  });
});
