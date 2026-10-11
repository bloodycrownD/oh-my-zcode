#!/usr/bin/env node
/**
 * MF-1(a-lease)（bugfix-batch-20261011，fix 节点）——`acquireForegroundPromotionLease`
 * 的 `idle-only` 五条件门直证。
 *
 * 为什么补这个测试（CR round 1 MF-1）：spec Step 3 规定 T-S1 后半「turn 完成后
 * idle-only promotion lease 即可获取」是 **blocking** 断言，但交付只在测试注释里
 * 推理——core `runtime-command-queue.ts` 的五条件门本批未改动，且全仓此前**零单测
 * 直接覆盖它**。桌面排队消息「不被 settle 拖住」的机制落点就是这道门：
 * `auto-drain` 唤醒时若任一条件在场就 refuse（busy），只有五个条件全空才
 * acquire。因此这里用最小假 runtime（门只读六个自有字段，不触达 runtime 其余面）
 * 把五条件逐一钉死，与「settle 拖长条件存活期」的失败模式形成对照。
 *
 * 覆盖：
 *   - idle-only：五条件**逐一** occupied → `{ kind: "busy" }`（refuse）；
 *   - idle-only：五条件全空 → `{ kind: "acquired" }`，且 lease 真落到 runtime 上；
 *   - 执行期互斥：已有 lease 时同 leaseId 重入 = acquired（幂等）、异 leaseId =
 *     conflict，且**不覆盖**在持 lease 的 promotedInputId；
 *   - `after-current` 模式无视五条件（drain 中/执行中仍可 acquire）——证明两模式
 *     的分界真实存在，idle-only 的严格性是显式选择而非巧合。
 *
 * 运行方式：`npx tsx --test scripts/test-promotion-lease.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码，与同目录 ctx-tool-descriptions /
 *  subagent-sync-dispatch 测试同范式；core 是逐脚本约定，已挂
 *  `test:promotion-lease` script）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { acquireForegroundPromotionLease } from "../src/runtime/methods/runtime-command-queue.js";

/**
 * 五条件门只读这六个字段（runtime-command-queue.ts 的 idle-only 判据块）。
 * `activeForegroundExecution` / `activeTurn` / `activeTurnStartReservation` 只被
 * 做 `!== undefined` 判断，哨兵对象取任何形状都不影响结论。
 */
function makeRuntime(overrides = {}) {
  return {
    foregroundPromotionLease: undefined,
    activeForegroundExecution: undefined,
    runtimeCommandDrainActive: false,
    runtimeCommandQueue: { hasPending: () => false },
    activeTurn: undefined,
    activeTurnStartReservation: undefined,
    ...overrides,
  };
}

const acquire = (runtime, options) => acquireForegroundPromotionLease.call(runtime, options);

const baseOptions = {
  leaseId: "lease-1",
  mode: "idle-only",
  promotedInputId: "input-1",
};

test("idle-only: every one of the five conditions alone refuses the lease", () => {
  const occupied = {
    activeForegroundExecution: { foregroundExecutionId: "fgx-1" },
    runtimeCommandDrainActive: true,
    "queue.hasPending()": true,
    activeTurn: { turnId: "turn-1" },
    activeTurnStartReservation: { turnId: "turn-1" },
  };
  for (const [condition, value] of Object.entries(occupied)) {
    // queue 条件改的是假队列的返回值，其余直接置字段。
    const queue = condition === "queue.hasPending()" ? { hasPending: () => true } : undefined;
    const runtime = makeRuntime(queue ? { runtimeCommandQueue: queue } : { [condition]: value });
    const result = acquire(runtime, baseOptions);
    assert.deepEqual(
      result,
      { kind: "busy" },
      `condition "${condition}" alone must refuse an idle-only lease`,
    );
    assert.equal(
      runtime.foregroundPromotionLease,
      undefined,
      `a refused lease ("${condition}") must not be recorded on the runtime`,
    );
  }
});

test("idle-only: all five conditions clear -> acquired and the lease is recorded", () => {
  const runtime = makeRuntime();
  const result = acquire(runtime, baseOptions);
  assert.deepEqual(result, { kind: "acquired", leaseId: "lease-1" });
  assert.deepEqual(runtime.foregroundPromotionLease, {
    leaseId: "lease-1",
    promotedInputId: "input-1",
  });
});

test("idle-only: a held lease is re-entrant for the same leaseId and conflicts otherwise", () => {
  const runtime = makeRuntime();
  assert.deepEqual(acquire(runtime, baseOptions), { kind: "acquired", leaseId: "lease-1" });

  // 同 leaseId 重入 = 幂等 acquired（调用方重试/重复触发不半途错杀）。
  assert.deepEqual(acquire(runtime, { ...baseOptions }), {
    kind: "acquired",
    leaseId: "lease-1",
  });

  // 异 leaseId = conflict，且在持 lease 不被覆盖。
  const conflict = acquire(runtime, { ...baseOptions, leaseId: "lease-2" });
  assert.deepEqual(conflict, { kind: "conflict", leaseId: "lease-1" });
  assert.deepEqual(runtime.foregroundPromotionLease, {
    leaseId: "lease-1",
    promotedInputId: "input-1",
  });
});

test("after-current: ignores the idle-only conditions (mode boundary is explicit)", () => {
  // 「当前轮进行中也能拿 lease」是 after-current 的设计语义；idle-only 的严格性
  // 因此必须被证明是模式判定，而不是无意间对所有模式生效。
  const runtime = makeRuntime({
    activeForegroundExecution: { foregroundExecutionId: "fgx-1" },
    runtimeCommandDrainActive: true,
    runtimeCommandQueue: { hasPending: () => true },
  });
  const result = acquire(runtime, { ...baseOptions, mode: "after-current" });
  assert.deepEqual(result, { kind: "acquired", leaseId: "lease-1" });
});
