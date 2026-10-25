#!/usr/bin/env node
/**
 * MC 生效口径单函数（`src/app/magic-context/gate.ts`）的真值表与同源守卫。
 *
 * 背景：契约 8 的 `effective = features.magicContext && magicContext.enabled`
 * 此前在 bootstrap 内分叉——`runtime-config.ts` 两个都读，
 * `zcode-protocol/magic-context-memories.ts` 只读域值，于是总开关关掉后
 * 设置页仍能打开记忆库。本测试钉两件事：
 *
 *   1. 真值表：override / feature / domain 三者的组合，尤其「域缺席按 schema
 *      缺省开」与「override 优先于 feature」；
 *   2. 同源守卫：两个消费点都必须引用同一个函数，杜绝再次各写一遍。
 *
 * 运行：`pnpm --dir apps/zcode-cli/packages/bootstrap run test:magic-context-gate`
 * （tsx 直接加载 TS 源，不依赖 dist）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { resolveMagicContextEffectiveEnabled } = await import(
  new URL("../src/app/magic-context/gate.ts", import.meta.url).href
);

const cases = [
  // [说明, input, expected]
  ["两个开关都开 → 开", { featureFlag: true, domainEnabled: true }, true],
  ["域缺席 → 按 schema 缺省开", { featureFlag: true }, true],
  ["域显式 false → 关", { featureFlag: true, domainEnabled: false }, false],
  ["feature 关、域开 → 关（kill switch 优先）", { featureFlag: false, domainEnabled: true }, false],
  ["feature 关、域缺席 → 关", { featureFlag: false }, false],
  [
    "override false 覆盖 feature true",
    { featureFlag: true, overrideEnabled: false, domainEnabled: true },
    false,
  ],
  [
    "override true 覆盖 feature false",
    { featureFlag: false, overrideEnabled: true, domainEnabled: true },
    true,
  ],
  [
    "override true 但不能绕过域 false",
    { featureFlag: true, overrideEnabled: true, domainEnabled: false },
    false,
  ],
  [
    "override 缺席时跟 feature",
    { featureFlag: true, overrideEnabled: undefined, domainEnabled: true },
    true,
  ],
];

for (const [label, input, expected] of cases) {
  test(`真值表：${label}`, () => {
    assert.equal(resolveMagicContextEffectiveEnabled(input), expected);
  });
}

test("同源守卫：runtime-config 走 gate", () => {
  const source = readFileSync(new URL("../src/app/runtime-config.ts", import.meta.url), "utf8");
  assert.ok(
    source.includes("resolveMagicContextEffectiveEnabled("),
    "runtime-config.ts 必须调用 resolveMagicContextEffectiveEnabled",
  );
});

test("同源守卫：memories RPC 走 gate，且不再只读域值", () => {
  const source = readFileSync(
    new URL("../src/zcode-protocol/magic-context-memories.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes("resolveMagicContextEffectiveEnabled("),
    "magic-context-memories.ts 必须调用 resolveMagicContextEffectiveEnabled",
  );
  assert.ok(
    source.includes("ConfigKey.FeatureMagicContext"),
    "memories 的 effective 门必须同时读 feature kill switch",
  );
});
