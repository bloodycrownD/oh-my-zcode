/**
 * 轨迹面板长文本 clamp 的溢出判定单测（spec trace-nm-borrow Step 4 / N-5 / T-N3）。
 *
 * 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入（tsx 下别名不可解析），
 * 只允许相对路径与裸包名导入（先例 modelTrajectoryToolJoin.test.ts:7-27）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  clampOverflowPx,
  DEFAULT_CLAMP_TOLERANCE_PX,
  isClampOverflow,
} from "../src/ModelTrajectoryClamp.js";

test("默认容差为 1px（吸收亚像素抖动）", () => {
  assert.equal(DEFAULT_CLAMP_TOLERANCE_PX, 1);
});

test("scrollHeight 等于 clientHeight 不溢出", () => {
  assert.equal(isClampOverflow({ scrollHeight: 100, clientHeight: 100 }), false);
});

test("溢出差值恰好等于容差不算溢出", () => {
  // 容差是「允许的误差」，差值必须严格大于容差才判定溢出。
  assert.equal(isClampOverflow({ scrollHeight: 101, clientHeight: 100 }), false);
});

test("溢出差值超出容差 1px 判定溢出", () => {
  assert.equal(isClampOverflow({ scrollHeight: 102, clientHeight: 100 }), true);
});

test("显式传入容差时按该容差判定", () => {
  // 容差 0：差 1px 即溢出。
  assert.equal(isClampOverflow({ scrollHeight: 101, clientHeight: 100, tolerance: 0 }), true);
  // 容差 5：差 5px 不溢出、差 6px 溢出。
  assert.equal(isClampOverflow({ scrollHeight: 105, clientHeight: 100, tolerance: 5 }), false);
  assert.equal(isClampOverflow({ scrollHeight: 106, clientHeight: 100, tolerance: 5 }), true);
});

test("容差为 0 时差值相等仍不溢出", () => {
  assert.equal(isClampOverflow({ scrollHeight: 100, clientHeight: 100, tolerance: 0 }), false);
});

test("clampOverflowPx 返回溢出像素数且不为负", () => {
  assert.equal(clampOverflowPx({ scrollHeight: 130, clientHeight: 100 }), 30);
  assert.equal(clampOverflowPx({ scrollHeight: 80, clientHeight: 100 }), 0);
});
