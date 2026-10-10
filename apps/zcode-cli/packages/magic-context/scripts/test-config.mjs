#!/usr/bin/env node
/**
 * Step 16 acceptance tests — E-group config port (reduced zod schema,
 * ConfigSnapshot semantics, push config bridge).
 *
 * Runs on `node:test` (no vitest/jest), importing the compiled `dist/` — run
 * `pnpm build` first. Requires Node >= 24 (the package targets `node:sqlite`
 * and ESM).
 *
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createConfigBridge } from "../dist/host/config-bridge.js";
import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  EXCLUDED_CONFIG_KEYS,
  MagicContextConfigSchema,
} from "../dist/host/config/schema.js";
import { computeConfigDigest, diffConfigKeys } from "../dist/host/config/snapshot.js";
import { resolveLanguageName } from "../dist/host/config/language.js";

/** Minimal stand-in for ZCode's `ConfigPort.observe` projection (Step 23 wires the real one). */
function createMockSource(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    read: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Test-side write, exactly what a ConfigPort change notification would do. */
    write(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

let passed = 0;
let failed = 0;

/** `node:test`'s wrapper, so the closing banner counts real outcomes, not exit codes. */
const it = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
      passed += 1;
    } catch (error) {
      failed += 1;
      throw error;
    }
  });

// Printed from the exit hook so the banner lands *after* the per-test lines.
process.on("exit", () => {
  const total = passed + failed;
  console.log("");
  if (failed === 0) {
    console.log(`TEST PASS — ${total}/${total} E-group config tests (schema / snapshot / bridge)`);
  } else {
    console.log(`TEST FAIL — ${failed}/${total} E-group config tests failed`);
  }
});

it("empty object parses to the full documented default set", () => {
  const parsed = MagicContextConfigSchema.parse({});
  assert.deepEqual(parsed, DEFAULT_MAGIC_CONTEXT_CONFIG);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.execute_threshold_percentage, 65);
  assert.equal(parsed.history_budget_percentage, 0.15);
  assert.equal(parsed.cache_ttl, "5m");
  assert.equal(parsed.smart_drops, false);
  assert.equal(parsed.fail_closed_blocking, true);
  assert.equal(parsed.historian.two_pass, false);
  assert.deepEqual(parsed.historian.fallback_models, []);
  assert.deepEqual(parsed.historian.disallowed_tools, []);
  assert.equal(parsed.historian.model, undefined);
  assert.equal(parsed.language, undefined);
  assert.equal(parsed.protected_tokens, undefined);
  assert.equal(parsed.execute_threshold_tokens, undefined);
});

it("the default set's top-level key set matches the schema exactly", () => {
  // MF-21：原来的断言是 `parse({}) deepEqual DEFAULT_MAGIC_CONTEXT_CONFIG`，而后者
  // 本身就**是** `parse({})` 的结果——恒真，加键减键都不会红。这里的断言反过来钉住
  // 「哪些键有默认值」：给 schema 加一个带 `.default()` 的新键而不更新下面这张名单，
  // 测试立刻失败，逼作者确认默认值；把某个键的 `.default()` 去掉同样失败。
  const parsed = MagicContextConfigSchema.parse({});
  const DEFAULTED_TOP_LEVEL_KEYS = [
    "cache_ttl",
    "enabled",
    "execute_threshold_percentage",
    "fail_closed_blocking",
    "historian",
    "history_budget_percentage",
    "smart_drops",
  ];
  // 有 .default() 的键：parse({}) 之后一定在结果里。
  assert.deepEqual(Object.keys(parsed).sort(), DEFAULTED_TOP_LEVEL_KEYS);
  // 反向：这三个是刻意 optional 且**无**默认值，缺席才是对的（per-model 覆盖
  // 与「跟随对话语言」都靠缺席表达）。写成在集合里就红。
  for (const optionalWithoutDefault of [
    "execute_threshold_tokens",
    "language",
    "protected_tokens",
  ]) {
    assert.equal(
      optionalWithoutDefault in parsed,
      false,
      `${optionalWithoutDefault} 无默认值，不应出现在默认域里`,
    );
  }
  // 排除名单里的键既不在 schema 也不在默认域。
  for (const excluded of EXCLUDED_CONFIG_KEYS) {
    assert.equal(excluded in parsed, false);
  }
});

it("whitelist field validators hold (threshold bounds, per-model object, tokens)", () => {
  // out of range both ways
  assert.equal(
    MagicContextConfigSchema.safeParse({ execute_threshold_percentage: 19 }).success,
    false,
  );
  assert.equal(
    MagicContextConfigSchema.safeParse({ execute_threshold_percentage: 91 }).success,
    false,
  );
  // accepted shapes
  assert.equal(
    MagicContextConfigSchema.safeParse({ execute_threshold_percentage: 90 }).success,
    true,
  );
  assert.equal(
    MagicContextConfigSchema.safeParse({
      execute_threshold_percentage: { default: 40, "zcode/glm": 55 },
    }).success,
    true,
  );
  assert.equal(
    MagicContextConfigSchema.safeParse({
      execute_threshold_percentage: { default: 40, "zcode/glm": 95 },
    }).success,
    false,
  );
  // absolute token thresholds
  assert.equal(
    MagicContextConfigSchema.safeParse({ execute_threshold_tokens: { default: 4999 } }).success,
    false,
  );
  assert.equal(
    MagicContextConfigSchema.safeParse({ execute_threshold_tokens: { default: 20_000 } }).success,
    true,
  );
  // protected_tokens floor is the source constant 4000
  assert.equal(MagicContextConfigSchema.safeParse({ protected_tokens: 3999 }).success, false);
  assert.equal(MagicContextConfigSchema.safeParse({ protected_tokens: 4000 }).success, true);
  // history budget bounds
  assert.equal(
    MagicContextConfigSchema.safeParse({ history_budget_percentage: 0.04 }).success,
    false,
  );
  assert.equal(
    MagicContextConfigSchema.safeParse({ history_budget_percentage: 0.51 }).success,
    false,
  );
  // cache_ttl accepts both the scalar and the per-model object form
  assert.equal(MagicContextConfigSchema.parse({ cache_ttl: "never" }).cache_ttl, "never");
  assert.deepEqual(
    MagicContextConfigSchema.parse({ cache_ttl: { default: "5m", "zcode/*": "1h" } }).cache_ttl,
    {
      default: "5m",
      "zcode/*": "1h",
    },
  );
  // historian metadata validators
  assert.equal(
    MagicContextConfigSchema.safeParse({ historian: { temperature: 2.5 } }).success,
    false,
  );
  assert.equal(MagicContextConfigSchema.safeParse({ historian: { color: "red" } }).success, false);
  assert.equal(MagicContextConfigSchema.safeParse({ historian: { model: "  " } }).success, false);
  assert.equal(
    MagicContextConfigSchema.parse({ historian: { model: " zcode/glm-4.6 " } }).historian.model,
    "zcode/glm-4.6",
  );
});

it("language accepts a 2-letter ISO 639-1 code and rejects anything else", () => {
  assert.equal(MagicContextConfigSchema.parse({ language: " TR " }).language, "tr");
  assert.equal(resolveLanguageName("tr").startsWith("Turkish"), true);
  assert.equal(MagicContextConfigSchema.safeParse({ language: "tur" }).success, false);
  assert.equal(MagicContextConfigSchema.safeParse({ language: "zz" }).success, false);
  assert.equal(MagicContextConfigSchema.safeParse({ language: "1a" }).success, false);
  const bad = MagicContextConfigSchema.safeParse({ language: "tur" });
  assert.equal(bad.success, false);
  assert.match(bad.error.issues[0].message, /2-letter ISO 639-1/);
});

it("excluded keys never reach `effective` (compaction in particular)", () => {
  const parsed = MagicContextConfigSchema.parse({
    enabled: true,
    compaction: { enabled: false },
    dreamer: { tasks: {} },
    mural: { enabled: true },
    profiles: { work: { historian: {} } },
  });
  for (const key of EXCLUDED_CONFIG_KEYS) {
    assert.equal(key in parsed, false, `${key} must not be an effective key`);
  }
  assert.equal("compaction" in parsed, false);
  assert.equal("dreamer" in parsed, false);
  assert.equal("mural" in parsed, false);
  assert.equal("profiles" in parsed, false);
  // the excluded subtrees leave no trace at all
  assert.deepEqual(parsed, DEFAULT_MAGIC_CONTEXT_CONFIG);
});

it('historian.model is three-state: missing/inherit run, "" is an explicit off', () => {
  // FORK（impl-historian-inherit）：字段缺失 = 缺省「继承会话模型」，与显式写
  // "inherit" 等价；空串 = 显式关闭分舱折叠，是本 fork 放行的有含义哨兵
  // （上游 z.string().trim().min(1) 一律拒绝空串）。
  const missing = MagicContextConfigSchema.parse({ enabled: true });
  assert.equal(missing.historian.model, undefined);
  assert.equal(
    MagicContextConfigSchema.parse({ historian: { model: "inherit" } }).historian.model,
    "inherit",
  );
  assert.equal(MagicContextConfigSchema.parse({ historian: { model: "" } }).historian.model, "");
  // 显式模型仍是上游语义（trim 后非空）。
  assert.equal(
    MagicContextConfigSchema.parse({ historian: { model: " zcode/glm-4.6 " } }).historian.model,
    "zcode/glm-4.6",
  );
  // 纯空白没有被放行：它不代表「显式关闭」这个决定。
  assert.equal(MagicContextConfigSchema.safeParse({ historian: { model: "  " } }).success, false);
});

it("digest is stable across key order and across repeated computation", () => {
  const a = MagicContextConfigSchema.parse({ enabled: true, cache_ttl: "1h" });
  const b = MagicContextConfigSchema.parse({ cache_ttl: "1h", enabled: true });
  assert.equal(computeConfigDigest(a), computeConfigDigest(b));
  assert.equal(
    computeConfigDigest(a),
    computeConfigDigest(MagicContextConfigSchema.parse({ cache_ttl: "1h", enabled: true })),
  );
  const c = MagicContextConfigSchema.parse({ enabled: true, cache_ttl: "5m" });
  assert.notEqual(computeConfigDigest(a), computeConfigDigest(c));
  assert.match(computeConfigDigest(a), /^[0-9a-f]{64}$/);
});

it("diffConfigKeys reports dotted paths, sorted, ignoring key order", () => {
  const prev = MagicContextConfigSchema.parse({ cache_ttl: "5m", enabled: true });
  const next = MagicContextConfigSchema.parse({
    enabled: false,
    cache_ttl: "5m",
    historian: { model: "zcode/glm-4.6" },
  });
  assert.deepEqual(diffConfigKeys(prev, next), ["enabled", "historian.model"]);
  assert.deepEqual(
    diffConfigKeys(prev, MagicContextConfigSchema.parse({ cache_ttl: "5m", enabled: true })),
    [],
  );
});

it("bridge adopts a push notification: generation+1, new effective, correct changedKeys", () => {
  const source = createMockSource({ enabled: true, cache_ttl: "5m" });
  let clock = 1_000;
  const bridge = createConfigBridge(source, { now: () => (clock += 10) });

  const first = bridge.getSnapshot();
  assert.equal(first.generation, 1);
  assert.equal(first.effective.cache_ttl, "5m");
  assert.equal(first.digest, computeConfigDigest(first.effective));
  assert.equal(bridge.getReloadFailure(), undefined);
  assert.deepEqual(bridge.getChangedKeys(), []);
  assert.equal(source.listenerCount(), 1);

  const events = [];
  const off = bridge.onChange((event) => events.push(event));

  // a write that does not change anything must not bump the generation
  source.write({ enabled: true, cache_ttl: "5m" });
  assert.equal(bridge.getSnapshot().generation, 1);
  assert.equal(events.length, 0);

  // this is the "next turn reads the new value" contract: no restart, no poll
  source.write({ enabled: false, cache_ttl: "1h", smart_drops: true });
  const second = bridge.getSnapshot();
  assert.equal(second.generation, 2);
  assert.equal(second.effective.enabled, false);
  assert.equal(second.effective.cache_ttl, "1h");
  assert.equal(second.effective.smart_drops, true);
  assert.notEqual(second.digest, first.digest);
  assert.ok(second.adoptedAt > first.adoptedAt);
  assert.deepEqual(bridge.getChangedKeys(), ["cache_ttl", "enabled", "smart_drops"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].snapshot.generation, 2);
  assert.deepEqual([...events[0].changedKeys], ["cache_ttl", "enabled", "smart_drops"]);

  off();
  source.write({ enabled: true });
  assert.equal(events.length, 1, "unsubscribed listener must stop receiving");
  bridge.dispose();
  assert.equal(source.listenerCount(), 0);
});

it("bridge keeps the last-known-good snapshot when a reload does not validate", () => {
  const source = createMockSource({ enabled: true, cache_ttl: "5m" });
  let clock = 2_000;
  const failures = [];
  const bridge = createConfigBridge(source, {
    now: () => (clock += 10),
    onReloadFailure: (failure) => failures.push(failure),
  });

  const good = bridge.getSnapshot();
  assert.equal(good.generation, 1);

  source.write({ execute_threshold_percentage: 999 });
  const afterBad = bridge.getSnapshot();
  assert.equal(afterBad.generation, 1, "a bad write must not bump the generation");
  assert.equal(afterBad.digest, good.digest);
  assert.deepEqual(afterBad.effective, good.effective, "last-known-good stays in force");
  const failure = bridge.getReloadFailure();
  assert.ok(failure);
  assert.equal(failure.at, 2_020);
  assert.match(failure.error, /execute_threshold_percentage/);
  assert.equal(failures.length, 1);

  // still broken: reported again, still no adoption
  source.write({ language: "turkish" });
  assert.equal(bridge.getSnapshot().generation, 1);
  assert.equal(failures.length, 2);
  assert.match(bridge.getReloadFailure().error, /language/);

  // recovery clears the failure and adopts
  source.write({ enabled: true, cache_ttl: "30m" });
  assert.equal(bridge.getSnapshot().generation, 2);
  assert.equal(bridge.getSnapshot().effective.cache_ttl, "30m");
  assert.equal(bridge.getReloadFailure(), undefined);

  // an entirely absent domain is legal: it is the default config
  source.write(undefined);
  assert.equal(bridge.getSnapshot().generation, 3);
  assert.deepEqual(bridge.getSnapshot().effective, DEFAULT_MAGIC_CONTEXT_CONFIG);
  assert.equal(bridge.getReloadFailure(), undefined);
});
